/**
 * Plugin marketplace admin routes.
 *
 * Two sub-routers:
 * 1. **Platform admin** (catalog CRUD) — mounted at /api/v1/platform/plugins/catalog
 *    Manage the global plugin catalog. Requires platform_admin role.
 *
 * 2. **Workspace admin** (installations) — mounted at /api/v1/admin/plugins/marketplace
 *    Browse available plugins, install/uninstall per workspace. Requires admin role + org.
 */

import { Effect } from "effect";
import { createRoute, z } from "@hono/zod-openapi";
import { runEffect } from "@atlas/api/lib/effect/hono";
import { RequestContext } from "@atlas/api/lib/effect/services";
import { createLogger } from "@atlas/api/lib/logger";
import { hasInternalDB, internalQuery, queryEffect } from "@atlas/api/lib/db/internal";
import { logAdminAction, ADMIN_ACTIONS } from "@atlas/api/lib/audit";
import {
  maskSecretFields,
  parseConfigSchema,
  restoreMaskedSecrets,
  encryptSecretFields,
  decryptSecretFields,
} from "@atlas/api/lib/plugins/secrets";
import { errorMessage } from "@atlas/api/lib/audit/error-scrub";
import { PLAN_TIERS, type PlanTier } from "@useatlas/types";
import {
  ErrorSchema,
  AuthErrorSchema,
  createIdParamSchema,
} from "./shared-schemas";
import { createAdminRouter, createPlatformRouter, requireOrgContext } from "./admin-router";

const log = createLogger("admin-marketplace");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PLUGIN_TYPES = ["datasource", "context", "interaction", "action", "sandbox"] as const;
type PluginType = (typeof PLUGIN_TYPES)[number];

/**
 * Plan tier ordering for eligibility checks.
 * A workspace with tier N can install plugins with min_plan <= N.
 * Typed as Record<PlanTier, number> so adding a tier to @useatlas/types
 * produces a compile error here until the rank is assigned.
 */
const PLAN_RANK: Record<PlanTier, number> = {
  free: 0,
  trial: 1,
  starter: 1,
  pro: 2,
  business: 3,
};

function isPlanEligible(workspacePlan: string, requiredPlan: string): boolean {
  const requiredRank = PLAN_RANK[requiredPlan as PlanTier];
  if (requiredRank === undefined) {
    log.warn({ requiredPlan }, "Unknown required plan tier — denying access");
    return false;
  }
  return (PLAN_RANK[workspacePlan as PlanTier] ?? 0) >= requiredRank;
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const CatalogEntrySchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  description: z.string().nullable(),
  type: z.enum(PLUGIN_TYPES),
  npmPackage: z.string().nullable(),
  iconUrl: z.string().nullable(),
  configSchema: z.unknown().nullable(),
  minPlan: z.string(),
  enabled: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const CreateCatalogBodySchema = z.object({
  name: z.string().min(1).max(200),
  slug: z.string().min(1).max(100).regex(/^[a-z0-9-]+$/, "Slug must be lowercase alphanumeric with hyphens"),
  description: z.string().max(2000).optional(),
  type: z.enum(PLUGIN_TYPES),
  npmPackage: z.string().max(200).optional(),
  iconUrl: z.string().url().max(500).optional(),
  configSchema: z.unknown().optional(),
  minPlan: z.enum(PLAN_TIERS).default("starter"),
  enabled: z.boolean().default(true),
});

const UpdateCatalogBodySchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  type: z.enum(PLUGIN_TYPES).optional(),
  npmPackage: z.string().max(200).optional(),
  iconUrl: z.string().url().max(500).optional(),
  configSchema: z.unknown().optional(),
  minPlan: z.enum(PLAN_TIERS).optional(),
  enabled: z.boolean().optional(),
});

const WorkspacePluginSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  catalogId: z.string(),
  config: z.unknown(),
  enabled: z.boolean(),
  installedAt: z.string(),
  installedBy: z.string().nullable(),
  // Joined catalog fields
  name: z.string().optional(),
  slug: z.string().optional(),
  type: z.string().optional(),
  description: z.string().nullable().optional(),
});

const InstallBodySchema = z.object({
  catalogId: z.string().min(1).max(128),
  config: z.record(z.string(), z.unknown()).optional(),
});

const UpdateConfigBodySchema = z.object({
  config: z.record(z.string(), z.unknown()),
});

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

interface CatalogRow extends Record<string, unknown> {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  type: string;
  npm_package: string | null;
  icon_url: string | null;
  config_schema: unknown;
  min_plan: string;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

interface WorkspacePluginRow extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  catalog_id: string;
  config: unknown;
  enabled: boolean;
  installed_at: string;
  installed_by: string | null;
  // Joined fields
  name?: string;
  slug?: string;
  type?: string;
  description?: string | null;
}

function catalogRowToJson(row: CatalogRow) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    type: row.type as PluginType,
    npmPackage: row.npm_package,
    iconUrl: row.icon_url,
    configSchema: row.config_schema,
    minPlan: row.min_plan,
    enabled: row.enabled,
    createdAt: typeof row.created_at === "object" ? (row.created_at as Date).toISOString() : String(row.created_at),
    updatedAt: typeof row.updated_at === "object" ? (row.updated_at as Date).toISOString() : String(row.updated_at),
  };
}

function installRowToJson(row: WorkspacePluginRow) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    catalogId: row.catalog_id,
    config: row.config,
    enabled: row.enabled,
    installedAt: typeof row.installed_at === "object" ? (row.installed_at as Date).toISOString() : String(row.installed_at),
    installedBy: row.installed_by,
    name: row.name,
    slug: row.slug,
    type: row.type,
    description: row.description,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// PLATFORM ADMIN — Catalog CRUD
// ═══════════════════════════════════════════════════════════════════════════

const listCatalogRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Platform — Plugin Catalog"],
  summary: "List all plugin catalog entries",
  responses: {
    200: {
      description: "Catalog entries",
      content: {
        "application/json": {
          schema: z.object({
            entries: z.array(CatalogEntrySchema),
            total: z.number(),
          }),
        },
      },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "No internal database", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const createCatalogRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Platform — Plugin Catalog"],
  summary: "Add a plugin to the catalog",
  request: {
    body: { content: { "application/json": { schema: CreateCatalogBodySchema } } },
  },
  responses: {
    201: {
      description: "Plugin added to catalog",
      content: { "application/json": { schema: CatalogEntrySchema } },
    },
    400: { description: "Validation error", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "No internal database", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "Slug already exists", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const updateCatalogRoute = createRoute({
  method: "put",
  path: "/{id}",
  tags: ["Platform — Plugin Catalog"],
  summary: "Update a catalog entry",
  request: {
    params: createIdParamSchema("catalog-entry-id"),
    body: { content: { "application/json": { schema: UpdateCatalogBodySchema } } },
  },
  responses: {
    200: {
      description: "Catalog entry updated",
      content: { "application/json": { schema: CatalogEntrySchema } },
    },
    400: { description: "Validation error", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const deleteCatalogRoute = createRoute({
  method: "delete",
  path: "/{id}",
  tags: ["Platform — Plugin Catalog"],
  summary: "Remove a plugin from the catalog",
  description: "Cascades to workspace installations — all workspaces with this plugin installed lose it.",
  request: {
    params: createIdParamSchema("catalog-entry-id"),
  },
  responses: {
    200: {
      description: "Plugin removed from catalog",
      content: { "application/json": { schema: z.object({ deleted: z.boolean() }) } },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// ---------------------------------------------------------------------------
// Platform router
// ---------------------------------------------------------------------------

const platformCatalog = createPlatformRouter();

platformCatalog.openapi(listCatalogRoute, async (c) => {
  return runEffect(
    c,
    Effect.gen(function* () {
      const { requestId } = yield* RequestContext;
      if (!hasInternalDB()) {
        return c.json({ error: "not_available", message: "No internal database configured.", requestId }, 404);
      }
      const rows = yield* queryEffect<CatalogRow>("SELECT * FROM plugin_catalog ORDER BY created_at DESC");
      return c.json({ entries: rows.map(catalogRowToJson), total: rows.length }, 200);
    }),
    { label: "list plugin catalog" },
  );
});

platformCatalog.openapi(createCatalogRoute, async (c) => {
  return runEffect(
    c,
    Effect.gen(function* () {
      const { requestId } = yield* RequestContext;
      if (!hasInternalDB()) {
        return c.json({ error: "not_available", message: "No internal database configured.", requestId }, 404);
      }

      const body = c.req.valid("json");
      const id = crypto.randomUUID();

      // Check slug uniqueness
      const existing = yield* queryEffect<{ id: string }>("SELECT id FROM plugin_catalog WHERE slug = $1", [body.slug]);
      if (existing.length > 0) {
        return c.json({ error: "conflict", message: `A catalog entry with slug "${body.slug}" already exists.`, requestId }, 409);
      }

      const rows = yield* queryEffect<CatalogRow>(
        `INSERT INTO plugin_catalog (id, name, slug, description, type, npm_package, icon_url, config_schema, min_plan, enabled)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING *`,
        [
          id,
          body.name,
          body.slug,
          body.description ?? null,
          body.type,
          body.npmPackage ?? null,
          body.iconUrl ?? null,
          body.configSchema ? JSON.stringify(body.configSchema) : null,
          body.minPlan,
          body.enabled,
        ],
      ).pipe(Effect.tapError((err) => Effect.sync(() => {
        logAdminAction({
          actionType: ADMIN_ACTIONS.plugin.catalogCreate,
          targetType: "plugin",
          targetId: id,
          scope: "platform",
          status: "failure",
          metadata: {
            pluginId: id,
            pluginSlug: body.slug,
            error: err instanceof Error ? err.message : String(err),
          },
        });
      })));
      if (rows.length === 0) {
        return c.json({ error: "internal_error", message: "Failed to create catalog entry — no row returned.", requestId }, 500);
      }
      logAdminAction({
        actionType: ADMIN_ACTIONS.plugin.catalogCreate,
        targetType: "plugin",
        targetId: id,
        scope: "platform",
        metadata: { pluginId: id, pluginSlug: body.slug },
      });
      log.info({ catalogId: id, slug: body.slug }, "Plugin added to catalog");
      return c.json(catalogRowToJson(rows[0]!), 201);
    }),
    { label: "create catalog entry" },
  );
});

platformCatalog.openapi(updateCatalogRoute, async (c) => {
  return runEffect(
    c,
    Effect.gen(function* () {
      const { requestId } = yield* RequestContext;
      if (!hasInternalDB()) {
        return c.json({ error: "not_available", message: "No internal database configured.", requestId }, 404);
      }

      const { id } = c.req.valid("param");
      const body = c.req.valid("json");

      // Build dynamic SET clause
      const setClauses: string[] = [];
      const params: unknown[] = [];
      let paramIdx = 1;

      if (body.name !== undefined) { setClauses.push(`name = $${paramIdx++}`); params.push(body.name); }
      if (body.description !== undefined) { setClauses.push(`description = $${paramIdx++}`); params.push(body.description); }
      if (body.type !== undefined) { setClauses.push(`type = $${paramIdx++}`); params.push(body.type); }
      if (body.npmPackage !== undefined) { setClauses.push(`npm_package = $${paramIdx++}`); params.push(body.npmPackage); }
      if (body.iconUrl !== undefined) { setClauses.push(`icon_url = $${paramIdx++}`); params.push(body.iconUrl); }
      if (body.configSchema !== undefined) { setClauses.push(`config_schema = $${paramIdx++}`); params.push(JSON.stringify(body.configSchema)); }
      if (body.minPlan !== undefined) { setClauses.push(`min_plan = $${paramIdx++}`); params.push(body.minPlan); }
      if (body.enabled !== undefined) { setClauses.push(`enabled = $${paramIdx++}`); params.push(body.enabled); }

      if (setClauses.length === 0) {
        return c.json({ error: "bad_request", message: "No fields to update.", requestId }, 400);
      }

      setClauses.push(`updated_at = now()`);
      params.push(id);

      // Keys only — see ADMIN_ACTIONS.plugin JSDoc. configSchema may hint at
      // secret shapes and `enabled: false` carries forensic signal that the
      // key name alone conveys.
      const keysChanged = Object.keys(body).toSorted();

      // Pre-fetch slug so the failure-path audit row carries it even when
      // the UPDATE throws. Lookup failure degrades to `priorLookupFailed`
      // rather than 500ing with no audit — same rationale as catalog delete.
      let priorLookup: { slug: string | null; failed: boolean };
      try {
        const priorRows = yield* queryEffect<{ slug: string }>(
          "SELECT slug FROM plugin_catalog WHERE id = $1",
          [id],
        );
        priorLookup = { slug: priorRows[0]?.slug ?? null, failed: false };
      } catch (err) {
        log.warn(
          { err: err instanceof Error ? err.message : String(err), catalogId: id },
          "catalog update pre-lookup failed; failure audit will lack slug",
        );
        priorLookup = { slug: null, failed: true };
      }

      const rows = yield* queryEffect<CatalogRow>(
        `UPDATE plugin_catalog SET ${setClauses.join(", ")} WHERE id = $${paramIdx} RETURNING *`,
        params,
      ).pipe(Effect.tapError((err) => Effect.sync(() => {
        logAdminAction({
          actionType: ADMIN_ACTIONS.plugin.catalogUpdate,
          targetType: "plugin",
          targetId: id,
          scope: "platform",
          status: "failure",
          metadata: {
            pluginId: id,
            ...(priorLookup.slug !== null && { pluginSlug: priorLookup.slug }),
            ...(priorLookup.failed && { priorLookupFailed: true }),
            keysChanged,
            error: err instanceof Error ? err.message : String(err),
          },
        });
      })));

      if (rows.length === 0) {
        return c.json({ error: "not_found", message: `Catalog entry "${id}" not found.`, requestId }, 404);
      }

      const updatedRow = rows[0]!;
      logAdminAction({
        actionType: ADMIN_ACTIONS.plugin.catalogUpdate,
        targetType: "plugin",
        targetId: id,
        scope: "platform",
        metadata: { pluginId: id, pluginSlug: updatedRow.slug, keysChanged },
      });
      log.info({ catalogId: id }, "Catalog entry updated");
      return c.json(catalogRowToJson(updatedRow), 200);
    }),
    { label: "update catalog entry" },
  );
});

platformCatalog.openapi(deleteCatalogRoute, async (c) => {
  return runEffect(
    c,
    Effect.gen(function* () {
      const { requestId } = yield* RequestContext;
      if (!hasInternalDB()) {
        return c.json({ error: "not_available", message: "No internal database configured.", requestId }, 404);
      }

      const { id } = c.req.valid("param");

      // Fetch slug and count installations BEFORE the cascade fires. Pre-lookup
      // failures must not short-circuit the audit — if a pool error throws
      // here and we rethrow, the request 500s with zero audit rows, letting
      // an attacker flood transient errors to hide attempted deletes. Degrade
      // to a sentinel (priorLookupFailed) and let the DELETE proceed; the
      // failure audit on the DELETE path then carries the degraded metadata.
      let priorLookup: { slug: string | null; notFound: boolean; failed: boolean };
      try {
        const priorRows = yield* queryEffect<{ slug: string }>(
          "SELECT slug FROM plugin_catalog WHERE id = $1",
          [id],
        );
        priorLookup = {
          slug: priorRows[0]?.slug ?? null,
          notFound: priorRows.length === 0,
          failed: false,
        };
      } catch (err) {
        log.warn(
          { err: err instanceof Error ? err.message : String(err), catalogId: id },
          "catalog delete pre-lookup failed; audit row will lack slug",
        );
        priorLookup = { slug: null, notFound: false, failed: true };
      }
      if (priorLookup.notFound) {
        return c.json({ error: "not_found", message: `Catalog entry "${id}" not found.`, requestId }, 404);
      }
      const pluginSlug = priorLookup.slug;

      let installCountLookup: { count: number; failed: boolean };
      try {
        const installCountRows = yield* queryEffect<{ count: string | number }>(
          "SELECT COUNT(*)::int AS count FROM workspace_plugins WHERE catalog_id = $1",
          [id],
        );
        installCountLookup = { count: Number(installCountRows[0]?.count ?? 0), failed: false };
      } catch (err) {
        log.warn(
          { err: err instanceof Error ? err.message : String(err), catalogId: id },
          "catalog delete install-count lookup failed; audit row will lack affectedOrgCount",
        );
        installCountLookup = { count: 0, failed: true };
      }
      const affectedOrgCount = installCountLookup.count;
      const priorLookupFailed = priorLookup.failed || installCountLookup.failed;

      const auditMetadataBase = {
        pluginId: id,
        ...(pluginSlug !== null && { pluginSlug }),
        affectedOrgCount,
        ...(priorLookupFailed && { priorLookupFailed: true }),
      };

      const rows = yield* queryEffect<{ id: string }>(
        "DELETE FROM plugin_catalog WHERE id = $1 RETURNING id",
        [id],
      ).pipe(Effect.tapError((err) => Effect.sync(() => {
        logAdminAction({
          actionType: ADMIN_ACTIONS.plugin.catalogDelete,
          targetType: "plugin",
          targetId: id,
          scope: "platform",
          status: "failure",
          metadata: {
            ...auditMetadataBase,
            error: err instanceof Error ? err.message : String(err),
          },
        });
      })));

      if (rows.length === 0) {
        return c.json({ error: "not_found", message: `Catalog entry "${id}" not found.`, requestId }, 404);
      }

      logAdminAction({
        actionType: ADMIN_ACTIONS.plugin.catalogDelete,
        targetType: "plugin",
        targetId: id,
        scope: "platform",
        metadata: auditMetadataBase,
      });
      // Cascade event fires only when workspaces actually lost the plugin —
      // separate from catalog_delete so forensic queries can distinguish a
      // cleanup delete from a mass uninstall.
      if (affectedOrgCount > 0) {
        logAdminAction({
          actionType: ADMIN_ACTIONS.plugin.catalogCascadeUninstall,
          targetType: "plugin",
          targetId: id,
          scope: "platform",
          metadata: auditMetadataBase,
        });
      }
      log.info({ catalogId: id, affectedOrgCount, priorLookupFailed }, "Catalog entry deleted (cascaded to workspace installations)");
      return c.json({ deleted: true }, 200);
    }),
    { label: "delete catalog entry" },
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// WORKSPACE ADMIN — Installations
// ═══════════════════════════════════════════════════════════════════════════

const listAvailableRoute = createRoute({
  method: "get",
  path: "/available",
  tags: ["Admin — Plugin Marketplace"],
  summary: "List plugins available to this workspace",
  description: "Returns enabled catalog entries filtered by the workspace's plan tier, with installation status.",
  responses: {
    200: {
      description: "Available plugins",
      content: {
        "application/json": {
          schema: z.object({
            plugins: z.array(CatalogEntrySchema.extend({
              installed: z.boolean(),
              installationId: z.string().nullable(),
              installedConfig: z.unknown().nullable(),
            })),
            total: z.number(),
          }),
        },
      },
    },
    400: { description: "No active organization", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const installRoute = createRoute({
  method: "post",
  path: "/install",
  tags: ["Admin — Plugin Marketplace"],
  summary: "Install a plugin into this workspace",
  request: {
    body: { content: { "application/json": { schema: InstallBodySchema } } },
  },
  responses: {
    201: {
      description: "Plugin installed",
      content: { "application/json": { schema: WorkspacePluginSchema } },
    },
    400: { description: "Validation error or plan ineligible", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Catalog entry not found", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "Already installed", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const uninstallRoute = createRoute({
  method: "delete",
  path: "/{id}",
  tags: ["Admin — Plugin Marketplace"],
  summary: "Uninstall a plugin from this workspace",
  request: {
    params: createIdParamSchema("installation-id"),
  },
  responses: {
    200: {
      description: "Plugin uninstalled",
      content: { "application/json": { schema: z.object({ deleted: z.boolean() }) } },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Installation not found", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const updateConfigRoute = createRoute({
  method: "put",
  path: "/{id}/config",
  tags: ["Admin — Plugin Marketplace"],
  summary: "Update installed plugin config",
  request: {
    params: createIdParamSchema("installation-id"),
    body: { content: { "application/json": { schema: UpdateConfigBodySchema } } },
  },
  responses: {
    200: {
      description: "Config updated",
      content: { "application/json": { schema: WorkspacePluginSchema } },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Installation not found", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// ---------------------------------------------------------------------------
// Workspace router
// ---------------------------------------------------------------------------

const workspaceMarketplace = createAdminRouter();
workspaceMarketplace.use(requireOrgContext());

/** Get the plan tier for a workspace. Throws on DB errors (surfaces as 500 via runEffect). */
async function getWorkspacePlan(orgId: string): Promise<string> {
  const rows = await internalQuery<{ plan_tier: string; [key: string]: unknown }>(
    "SELECT plan_tier FROM organization WHERE id = $1",
    [orgId],
  );
  return rows[0]?.plan_tier ?? "starter";
}

// GET /available — catalog entries available to this workspace
workspaceMarketplace.openapi(listAvailableRoute, async (c) => {
  return runEffect(
    c,
    Effect.gen(function* () {
      yield* RequestContext;
      const { orgId } = c.var.orgContext;

      // Independent queries — run in parallel
      const [plan, catalog, installations] = yield* Effect.promise(() =>
        Promise.all([
          getWorkspacePlan(orgId),
          internalQuery<CatalogRow>("SELECT * FROM plugin_catalog WHERE enabled = true ORDER BY name ASC"),
          internalQuery<{ catalog_id: string; id: string; config: unknown }>(
            "SELECT catalog_id, id, config FROM workspace_plugins WHERE workspace_id = $1",
            [orgId],
          ),
        ]),
      );
      const installedMap = new Map(installations.map((i) => [i.catalog_id, { id: i.id, config: i.config }]));

      // Filter by plan eligibility, masking any installedConfig field marked
      // `secret: true` in the catalog's config_schema. A workspace admin
      // would otherwise GET /available and read every live credential
      // (#1817); the UI round-trips the placeholder on save via the write
      // path's restoreMaskedSecrets() guard. A catalog row with a malformed
      // config_schema (DB drift, migration typo) falls through parseConfigSchema
      // as `state: "corrupt"` — maskSecretFields then fail-closes by masking
      // every string value and we log so operators see the drift.
      const available = catalog
        .filter((entry) => isPlanEligible(plan, entry.min_plan))
        .map((entry) => {
          const inst = installedMap.get(entry.id);
          const schema = parseConfigSchema(entry.config_schema);
          if (schema.state === "corrupt" && inst) {
            log.warn(
              { pluginId: entry.id, slug: entry.slug, reason: schema.reason },
              "plugin_catalog.config_schema unreadable — masking all string values in installedConfig defensively",
            );
          }
          return {
            ...catalogRowToJson(entry),
            installed: !!inst,
            installationId: inst?.id ?? null,
            installedConfig: inst ? maskSecretFields(inst.config, schema) : null,
          };
        });

      return c.json({ plugins: available, total: available.length }, 200);
    }),
    { label: "list available plugins" },
  );
});

// POST /install — install a plugin into this workspace
workspaceMarketplace.openapi(installRoute, async (c) => {
  return runEffect(
    c,
    Effect.gen(function* () {
      const { requestId } = yield* RequestContext;
      const { orgId } = c.var.orgContext;
      const body = c.req.valid("json");

      // Fetch catalog entry. A lookup failure at this point means we cannot
      // know the slug, but we still want an audit row — a compromised admin
      // could otherwise flood transient errors to probe for catalog IDs.
      const catalogRows = yield* queryEffect<CatalogRow>(
        "SELECT * FROM plugin_catalog WHERE id = $1 AND enabled = true",
        [body.catalogId],
      ).pipe(Effect.tapError((err) => Effect.sync(() => {
        logAdminAction({
          actionType: ADMIN_ACTIONS.plugin.install,
          targetType: "plugin",
          targetId: body.catalogId,
          scope: "workspace",
          status: "failure",
          metadata: {
            pluginId: body.catalogId,
            orgId,
            priorLookupFailed: true,
            error: err instanceof Error ? err.message : String(err),
          },
        });
      })));
      if (catalogRows.length === 0) {
        return c.json({ error: "not_found", message: `Catalog entry "${body.catalogId}" not found or disabled.`, requestId }, 404);
      }
      const catalogEntry = catalogRows[0]!;

      // Plan check + existing check are independent — run in parallel
      const [plan, existing] = yield* Effect.promise(() =>
        Promise.all([
          getWorkspacePlan(orgId),
          internalQuery<{ id: string; [key: string]: unknown }>(
            "SELECT id FROM workspace_plugins WHERE workspace_id = $1 AND catalog_id = $2",
            [orgId, body.catalogId],
          ),
        ]),
      );

      if (!isPlanEligible(plan, catalogEntry.min_plan)) {
        return c.json({
          error: "plan_ineligible",
          message: `This plugin requires the "${catalogEntry.min_plan}" plan. Your workspace is on the "${plan}" plan.`,
          requestId,
        }, 400);
      }

      if (existing.length > 0) {
        return c.json({ error: "conflict", message: "Plugin is already installed in this workspace.", requestId }, 409);
      }

      // Get user ID from auth
      const authResult = c.get("authResult");
      const userId = authResult?.user?.id ?? null;

      // F-42: encrypt any `secret: true` field from the initial install
      // payload before it hits the JSONB column. Catalog schema drives
      // which fields count as secret; a corrupt schema fail-closes by
      // encrypting every non-empty string (same policy as maskSecretFields).
      // A throw from `encryptSecret` (GCM crash, key derivation failure)
      // surfaces as 500 with a failure audit so the admin sees the error
      // and compliance reviewers have a row for the attempted install —
      // otherwise the generic Effect 500 mapper would swallow the context.
      const installSchema = parseConfigSchema(catalogEntry.config_schema);
      if (installSchema.state === "corrupt") {
        log.warn(
          { pluginId: body.catalogId, slug: catalogEntry.slug, reason: installSchema.reason },
          "plugin_catalog.config_schema unreadable on install — encrypting every string value defensively",
        );
      }
      const id = crypto.randomUUID();
      let encryptedConfig: Record<string, unknown>;
      try {
        encryptedConfig = encryptSecretFields(body.config ?? {}, installSchema);
      } catch (err) {
        logAdminAction({
          actionType: ADMIN_ACTIONS.plugin.install,
          targetType: "plugin",
          targetId: id,
          scope: "workspace",
          status: "failure",
          metadata: {
            pluginId: body.catalogId,
            pluginSlug: catalogEntry.slug,
            orgId,
            encryptFailure: true,
            error: errorMessage(err),
          },
        });
        log.error(
          {
            pluginId: body.catalogId,
            orgId,
            err: err instanceof Error ? err : new Error(String(err)),
            scrubbed: errorMessage(err),
            requestId,
          },
          "Failed to encrypt plugin config on install",
        );
        return c.json({
          error: "internal_error",
          message: "Failed to install plugin — encryption step failed.",
          requestId,
        }, 500);
      }
      const rows = yield* queryEffect<WorkspacePluginRow>(
        `INSERT INTO workspace_plugins (id, workspace_id, catalog_id, config, installed_by)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *, (SELECT name FROM plugin_catalog WHERE id = $3) AS name,
                     (SELECT slug FROM plugin_catalog WHERE id = $3) AS slug,
                     (SELECT type FROM plugin_catalog WHERE id = $3) AS type,
                     (SELECT description FROM plugin_catalog WHERE id = $3) AS description`,
        [id, orgId, body.catalogId, JSON.stringify(encryptedConfig), userId],
      ).pipe(Effect.tapError((err) => Effect.sync(() => {
        logAdminAction({
          actionType: ADMIN_ACTIONS.plugin.install,
          targetType: "plugin",
          targetId: id,
          scope: "workspace",
          status: "failure",
          metadata: {
            pluginId: body.catalogId,
            pluginSlug: catalogEntry.slug,
            orgId,
            error: err instanceof Error ? err.message : String(err),
          },
        });
      })));

      if (rows.length === 0) {
        return c.json({ error: "internal_error", message: "Failed to install plugin — no row returned.", requestId }, 500);
      }
      logAdminAction({
        actionType: ADMIN_ACTIONS.plugin.install,
        targetType: "plugin",
        targetId: id,
        scope: "workspace",
        metadata: {
          pluginId: body.catalogId,
          pluginSlug: catalogEntry.slug,
          orgId,
        },
      });
      log.info({ orgId, catalogId: body.catalogId, installationId: id }, "Plugin installed in workspace");
      // F-42: the RETURNING clause echoes back the encrypted `config` blob.
      // Mask before returning — consistent with GET /available behavior and
      // prevents a round-tripping UI from re-submitting raw ciphertext.
      const installResponse = installRowToJson(rows[0]!);
      installResponse.config = maskSecretFields(installResponse.config, installSchema);
      return c.json(installResponse, 201);
    }),
    { label: "install plugin" },
  );
});

// DELETE /:id — uninstall a plugin
workspaceMarketplace.openapi(uninstallRoute, async (c) => {
  return runEffect(
    c,
    Effect.gen(function* () {
      const { requestId } = yield* RequestContext;
      const { orgId } = c.var.orgContext;
      const { id } = c.req.valid("param");

      // DELETE ... RETURNING exposes catalog_id from the deleted row tuple,
      // which we scalar-lookup against plugin_catalog (untouched by this
      // statement) to capture slug alongside the uninstall. The subselect
      // can still return NULL if the catalog row was already gone (e.g. a
      // catalog_delete cascade raced with this request).
      const rows = yield* queryEffect<{ id: string; catalog_id: string; slug: string | null }>(
        `DELETE FROM workspace_plugins WHERE id = $1 AND workspace_id = $2
         RETURNING id, catalog_id, (SELECT slug FROM plugin_catalog WHERE id = workspace_plugins.catalog_id) AS slug`,
        [id, orgId],
      ).pipe(Effect.tapError((err) => Effect.sync(() => {
        logAdminAction({
          actionType: ADMIN_ACTIONS.plugin.uninstall,
          targetType: "plugin",
          targetId: id,
          scope: "workspace",
          status: "failure",
          metadata: {
            pluginId: id,
            orgId,
            error: err instanceof Error ? err.message : String(err),
          },
        });
      })));

      if (rows.length === 0) {
        return c.json({ error: "not_found", message: `Installation "${id}" not found in this workspace.`, requestId }, 404);
      }

      const deleted = rows[0]!;
      logAdminAction({
        actionType: ADMIN_ACTIONS.plugin.uninstall,
        targetType: "plugin",
        targetId: id,
        scope: "workspace",
        metadata: {
          pluginId: deleted.catalog_id,
          // `!= null` covers both SQL NULL (from the subselect missing the
          // catalog row) and an absent column (defense in depth against
          // driver-shape drift). Aligned with the config_update guard below.
          ...(deleted.slug != null && { pluginSlug: deleted.slug }),
          orgId,
        },
      });
      log.info({ orgId, installationId: id }, "Plugin uninstalled from workspace");
      return c.json({ deleted: true }, 200);
    }),
    { label: "uninstall plugin" },
  );
});

// PUT /:id/config — update plugin config
workspaceMarketplace.openapi(updateConfigRoute, async (c) => {
  return runEffect(
    c,
    Effect.gen(function* () {
      const { requestId } = yield* RequestContext;
      const { orgId } = c.var.orgContext;
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");

      // Keys only — see ADMIN_ACTIONS.plugin JSDoc.
      const keysChanged = Object.keys(body.config).toSorted();

      // Pre-fetch current config + catalog schema so we can swap any
      // MASKED_PLACEHOLDER echoed back by the admin UI for the original
      // persisted value — and preserve any secret field the UI omitted
      // entirely (dirty-field saves from forms that only send changed
      // inputs). Without this step, a UI that rendered the masked GET
      // /available response would silently wipe live secrets the first
      // time an admin saved any other field.
      //
      // Pre-SELECT failures emit their own failure audit: the admin triggered
      // a config update attempt and it failed; an auditor investigating a
      // credential rotation gap needs to see the attempt row even when the
      // DB was down before the UPDATE ran.
      const existing = yield* queryEffect<{ config: unknown; config_schema: unknown }>(
        `SELECT wp.config, pc.config_schema
         FROM workspace_plugins wp
         LEFT JOIN plugin_catalog pc ON pc.id = wp.catalog_id
         WHERE wp.id = $1 AND wp.workspace_id = $2`,
        [id, orgId],
      ).pipe(Effect.tapError((err) => Effect.sync(() => {
        logAdminAction({
          actionType: ADMIN_ACTIONS.plugin.configUpdate,
          targetType: "plugin",
          targetId: id,
          scope: "workspace",
          status: "failure",
          metadata: {
            pluginId: id,
            orgId,
            keysChanged,
            priorLookupFailed: true,
            error: err instanceof Error ? err.message : String(err),
          },
        });
      })));
      if (existing.length === 0) {
        return c.json({ error: "not_found", message: `Installation "${id}" not found in this workspace.`, requestId }, 404);
      }
      const originalConfigRaw = (existing[0]!.config ?? {}) as Record<string, unknown>;
      const schema = parseConfigSchema(existing[0]!.config_schema);
      if (schema.state === "corrupt") {
        log.warn(
          { installationId: id, orgId, reason: schema.reason },
          "plugin_catalog.config_schema unreadable on PUT — restoring every stored key to prevent secret loss",
        );
      }
      // F-42: the stored JSONB carries `secret: true` fields encrypted.
      // Decrypt before restoreMaskedSecrets so placeholder-restored values
      // are plaintext — the re-encrypt step below then refreshes the IV
      // for every preserved secret (idempotent on ciphertext would keep
      // the old IV; decrypt-then-reencrypt is the safer default). A
      // decryption failure is surfaced as 500 with a failure audit — the
      // alternative is a silent secret wipe on the PUT.
      let originalConfig: Record<string, unknown>;
      try {
        originalConfig = decryptSecretFields(originalConfigRaw, schema);
      } catch (err) {
        logAdminAction({
          actionType: ADMIN_ACTIONS.plugin.configUpdate,
          targetType: "plugin",
          targetId: id,
          scope: "workspace",
          status: "failure",
          metadata: {
            pluginId: id,
            orgId,
            keysChanged,
            decryptFailure: true,
            error: errorMessage(err),
          },
        });
        log.error(
          {
            installationId: id,
            orgId,
            requestId,
            err: err instanceof Error ? err : new Error(String(err)),
            scrubbed: errorMessage(err),
          },
          "Failed to decrypt plugin config secrets on save-read",
        );
        return c.json({
          error: "internal_error",
          message: "Failed to read current plugin configuration — encrypted secret could not be decrypted.",
          requestId,
        }, 500);
      }
      const sanitizedConfig = restoreMaskedSecrets(body.config, originalConfig, schema);
      const encryptedForPersist = encryptSecretFields(sanitizedConfig, schema);

      const rows = yield* queryEffect<WorkspacePluginRow>(
        `UPDATE workspace_plugins SET config = $1
         WHERE id = $2 AND workspace_id = $3
         RETURNING *, (SELECT name FROM plugin_catalog WHERE id = workspace_plugins.catalog_id) AS name,
                     (SELECT slug FROM plugin_catalog WHERE id = workspace_plugins.catalog_id) AS slug,
                     (SELECT type FROM plugin_catalog WHERE id = workspace_plugins.catalog_id) AS type,
                     (SELECT description FROM plugin_catalog WHERE id = workspace_plugins.catalog_id) AS description`,
        [JSON.stringify(encryptedForPersist), id, orgId],
      ).pipe(Effect.tapError((err) => Effect.sync(() => {
        logAdminAction({
          actionType: ADMIN_ACTIONS.plugin.configUpdate,
          targetType: "plugin",
          targetId: id,
          scope: "workspace",
          status: "failure",
          metadata: {
            pluginId: id,
            orgId,
            keysChanged,
            error: err instanceof Error ? err.message : String(err),
          },
        });
      })));

      if (rows.length === 0) {
        return c.json({ error: "not_found", message: `Installation "${id}" not found in this workspace.`, requestId }, 404);
      }

      const updated = rows[0]!;
      logAdminAction({
        actionType: ADMIN_ACTIONS.plugin.configUpdate,
        targetType: "plugin",
        targetId: id,
        scope: "workspace",
        metadata: {
          pluginId: updated.catalog_id,
          // See uninstall-path note — `!= null` covers both SQL NULL and
          // absent-column shapes. The `pg` driver returns SQL NULL as JS
          // null, not undefined, so `!== undefined` would have leaked null.
          ...(updated.slug != null && { pluginSlug: updated.slug }),
          orgId,
          keysChanged,
        },
      });
      log.info({ orgId, installationId: id }, "Plugin config updated");
      // F-42: the RETURNING clause gives back the freshly-encrypted blob.
      // Mask the response so the UI never has to know about ciphertext — it
      // just sees placeholders like it did on GET /available.
      const updatedResponse = installRowToJson(updated);
      updatedResponse.config = maskSecretFields(updatedResponse.config, schema);
      return c.json(updatedResponse, 200);
    }),
    { label: "update plugin config" },
  );
});

export { platformCatalog, workspaceMarketplace };
