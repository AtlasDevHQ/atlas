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
import { RequestContext, MarketplaceVeneer } from "@atlas/api/lib/effect/services";
import { createLogger } from "@atlas/api/lib/logger";
import { hasInternalDB, internalQuery, queryEffect } from "@atlas/api/lib/db/internal";
import { logAdminAction, ADMIN_ACTIONS } from "@atlas/api/lib/audit";
import {
  maskSecretFields,
  parseConfigSchema,
  encryptSecretFields,
  checkStrictPluginSecrets,
} from "@atlas/api/lib/plugins/secrets";
import {
  applyConfigEdit,
  decryptStoredConfig,
  InstalledConfigDecryptError,
} from "@atlas/api/lib/integrations/installed-connection";
import { errorMessage } from "@atlas/api/lib/audit/error-scrub";
import { tearDownWorkspaceInstall } from "@atlas/api/lib/plugins/teardown";
import type { CatalogInstallModel } from "@useatlas/types";
import { MIN_PLAN_TIERS, type PlanTier } from "@useatlas/types";
import {
  isPlanEligible as planRankEligible,
  parsePlanTier,
} from "@atlas/api/lib/integrations/install/plan-rank";
import { isRoutingIdUniqueViolation } from "@atlas/api/lib/integrations/install/routing-id-conflict";
import {
  assertSaasEncryptionKeyset,
  deriveSecretLabel,
  persistInstallRecord,
  EncryptionKeysetUnavailableError,
  MARKETPLACE_INSTALL_READBACK_SQL,
} from "@atlas/api/lib/integrations/install/persist-form-install";
import type { WorkspaceId } from "@useatlas/types";
import {
  buildCatalogCreateSql,
  buildCatalogUpdateSql,
} from "@atlas/api/lib/integrations/catalog-crud";
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
 * The generic marketplace install/uninstall path only serves `form`-model
 * plugins (config persisted directly to `workspace_plugins.config`). OAuth,
 * static-bot, and oauth-datasource plugins have dedicated credential stores +
 * install/disconnect handlers — see the gate in the install route (#3681).
 */
const MARKETPLACE_INSTALL_MODEL: CatalogInstallModel = "form";
function isFormInstallModel(value: unknown): value is "form" {
  return value === MARKETPLACE_INSTALL_MODEL;
}

/**
 * Whether the workspace's tier admits installing a plugin requiring
 * `requiredPlan`. Narrows the catalog string at this trust boundary
 * via {@link parsePlanTier}; logs at warn on unknown values so
 * catalog drift surfaces. `workspacePlan` arrives pre-narrowed from
 * {@link getWorkspacePlan}.
 */
function isPlanEligible(
  workspacePlan: PlanTier | null,
  requiredPlan: string,
): boolean {
  const requiredTier = parsePlanTier(requiredPlan);
  if (requiredTier === null) {
    log.warn({ requiredPlan }, "Unknown required plan tier — denying access");
    return false;
  }
  return planRankEligible(workspacePlan, requiredTier);
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
  minPlan: z.enum(MIN_PLAN_TIERS).default("starter"),
  enabled: z.boolean().default(true),
});

const UpdateCatalogBodySchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  type: z.enum(PLUGIN_TYPES).optional(),
  npmPackage: z.string().max(200).optional(),
  iconUrl: z.string().url().max(500).optional(),
  configSchema: z.unknown().optional(),
  minPlan: z.enum(MIN_PLAN_TIERS).optional(),
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
  // 0092 / #2739 — three-pillar taxonomy, NOT NULL in the DB. Typed here
  // because the install route narrows it (`chat`/`action` only) before
  // handing the persist to the form-install spine (#4186). Declared
  // optional+nullable ON PURPOSE: this is an unvalidated `SELECT *` cast,
  // so the type must not promise more than the driver does — the install
  // route's narrow fails closed on any missing/unexpected value rather
  // than trusting the type (a drifted row is refused, never coerced).
  pillar?: string | null;
  // #3301 — false rows are hidden from the marketplace on SaaS deploys
  // (e.g. DuckDB, which is file-path based and not multi-tenant safe).
  // `NOT NULL DEFAULT true` in the DB; the filter still treats only an
  // explicit `false` as ineligible (`!== false`) since this is an unvalidated
  // `SELECT *` cast — a stale/pre-column row defaults to visible.
  saas_eligible: boolean;
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

      // Operator-curated-only gate (#4174/#4099) lives inside the builder,
      // next to the SQL (catalog-crud.ts).
      const create = buildCatalogCreateSql(id, body);
      const rows = yield* queryEffect<CatalogRow>(create.sql, create.params).pipe(Effect.tapError((err) => Effect.sync(() => {
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

      const update = buildCatalogUpdateSql(id, body);
      if (update === null) {
        return c.json({ error: "bad_request", message: "No fields to update.", requestId }, 400);
      }

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

      // Operator-curated-only gate (#4174/#4099) lives inside the builder,
      // next to the SQL (catalog-crud.ts).
      const rows = yield* queryEffect<CatalogRow>(update.sql, update.params).pipe(Effect.tapError((err) => Effect.sync(() => {
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

      // #3681 — tear down the per-workspace state the `plugin_catalog` FK
      // cascade does NOT reach, for EVERY affected workspace, BEFORE the
      // cascade fires. The cascade removes `workspace_plugins` +
      // `integration_credentials` (both FK `plugin_catalog`), but it is blind
      // to: `scheduled_tasks` (soft FK, migration 0044 — the scheduler keeps
      // firing them post-delete), the dedicated credential tables
      // (`slack_installations` / `discord_installations` / `twenty_integrations`,
      // which key on team/workspace not catalog), the per-workspace
      // `onUninstall` hook (external webhook / OAuth grant revocation), and the
      // `LazyPluginLoader` cache (socket-holding plugin instances). The shared
      // teardown runs WHILE the install rows + credentials still exist (the
      // cascade below removes them, and the hook needs them to authenticate).
      //
      // Best-effort and non-atomic by design: a per-workspace teardown failure
      // is logged + counted and the cascade still proceeds — an orphaned task
      // is skipped by the execution-time guard and swept by the reconcile
      // fiber, whereas a catalog row left half-deleted is not recoverable.
      let teardownSummary = {
        workspaces: 0,
        hookFailures: 0,
        credentialFailures: 0,
        scheduledTasksDeleted: 0,
      };
      if (affectedOrgCount > 0) {
        teardownSummary = yield* Effect.promise(async () => {
          const summary = { workspaces: 0, hookFailures: 0, credentialFailures: 0, scheduledTasksDeleted: 0 };
          try {
            const affected = await internalQuery<{ workspace_id: string; team_id: string | null }>(
              "SELECT workspace_id, config->>'team_id' AS team_id FROM workspace_plugins WHERE catalog_id = $1",
              [id],
            );
            for (const ws of affected) {
              const result = await tearDownWorkspaceInstall({
                workspaceId: ws.workspace_id,
                catalogId: id,
                // `pluginSlug` is null only when the pre-lookup degraded; the
                // credential switch then no-ops but the hook + scheduled_tasks
                // + loader evict still run keyed on catalog id.
                catalogSlug: pluginSlug ?? "",
                teamId: ws.team_id,
              });
              summary.workspaces += 1;
              summary.hookFailures += result.hookFailures.length;
              if (result.credentialError !== undefined) summary.credentialFailures += 1;
              summary.scheduledTasksDeleted += result.scheduledTasksDeleted;
            }
          } catch (err) {
            log.error(
              { catalogId: id, err: err instanceof Error ? err : new Error(String(err)) },
              "Catalog delete: per-workspace teardown enumeration failed — proceeding with cascade; some workspace state may be orphaned",
            );
          }
          return summary;
        });
      }

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
          metadata: {
            ...auditMetadataBase,
            // #3681 — per-workspace teardown coverage so an operator can see
            // how many workspaces were torn down vs orphaned by a partial run.
            teardownWorkspaces: teardownSummary.workspaces,
            scheduledTasksDeleted: teardownSummary.scheduledTasksDeleted,
            ...(teardownSummary.hookFailures > 0 && { teardownHookFailures: teardownSummary.hookFailures }),
            ...(teardownSummary.credentialFailures > 0 && { teardownCredentialFailures: teardownSummary.credentialFailures }),
          },
        });
      }
      log.info(
        {
          catalogId: id,
          affectedOrgCount,
          priorLookupFailed,
          teardownWorkspaces: teardownSummary.workspaces,
          scheduledTasksDeleted: teardownSummary.scheduledTasksDeleted,
          teardownHookFailures: teardownSummary.hookFailures,
          teardownCredentialFailures: teardownSummary.credentialFailures,
        },
        "Catalog entry deleted (per-workspace teardown + cascade to workspace installations)",
      );
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
  description:
    "Returns enabled catalog entries filtered by the workspace's plan tier, with installation status. On SaaS deploys (`ATLAS_DEPLOY_MODE=saas`), entries flagged `saas_eligible = false` (e.g. DuckDB) are excluded.",
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
    400: { description: "Validation error, plan ineligible, or not available on this deploy mode (SaaS-ineligible datasource)", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Catalog entry not found", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "Already installed", content: { "application/json": { schema: ErrorSchema } } },
    422: { description: "Strict-mode plugin secrets check rejected the install (catalog schema corrupt or per-key secret/passthrough drift)", content: { "application/json": { schema: ErrorSchema } } },
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
      content: {
        "application/json": {
          schema: z.object({
            deleted: z.boolean(),
            // #1987 — count of plugin-owned scheduled_tasks rows removed.
            // 0 when the plugin had no tasks; absent only on legacy clients.
            scheduledTasksDeleted: z.number().int().nonnegative().optional(),
          }),
        },
      },
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
    409: { description: "A routing identifier in the config (static-bot chat_id / guild_id / tenant_id / phone_number_id / gchat workspace_id) is already connected to a different workspace (#3167)", content: { "application/json": { schema: ErrorSchema } } },
    422: { description: "Strict-mode plugin secrets check rejected the write (catalog schema corrupt or per-key secret/passthrough drift)", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// ---------------------------------------------------------------------------
// Workspace router
// ---------------------------------------------------------------------------

const workspaceMarketplace = createAdminRouter();
workspaceMarketplace.use(requireOrgContext());

/**
 * Get the workspace's plan tier, narrowed via {@link parsePlanTier}
 * at the SQL boundary (#2715). Returns `null` for missing /
 * unrecognized values; the downstream eligibility check fails closed
 * on `null` for any non-`free` `min_plan`.
 *
 * Throws on DB errors (surfaces as 500 via runEffect).
 */
async function getWorkspacePlan(orgId: string): Promise<PlanTier | null> {
  const rows = await internalQuery<{ plan_tier: string; [key: string]: unknown }>(
    "SELECT plan_tier FROM organization WHERE id = $1",
    [orgId],
  );
  // Pre-#2715 the row default was `"starter"`. Preserve that here so
  // workspaces with no row continue to admit `starter`-or-lower rows
  // — the database default still seeds new orgs to `"starter"`.
  return parsePlanTier(rows[0]?.plan_tier ?? "starter");
}

// GET /available — catalog entries available to this workspace
workspaceMarketplace.openapi(listAvailableRoute, async (c) => {
  return runEffect(
    c,
    Effect.gen(function* () {
      yield* RequestContext;
      const { orgId } = c.var.orgContext;
      // #4001 — the SaaS plan-gated veneer moved to @atlas/ee behind the
      // MarketplaceVeneer Tag. `isSaasIneligible` is the EE-resolved
      // `deployMode === "saas" && saas_eligible === false` gate; the Noop
      // default (self-hosted / non-EE) answers `false` for every row, so the
      // full catalog lists — unchanged self-hosted behavior.
      const veneer = yield* MarketplaceVeneer;

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

      // #3301 / #4001 — on SaaS deploys, hide catalog rows flagged
      // `saas_eligible = false` (DuckDB is file-path based and not multi-tenant
      // safe). The decision lives in @atlas/ee (resolved, not raw-env, deploy
      // mode — see MarketplaceVeneerLive); self-hosted is unaffected — the Noop
      // veneer reports every row eligible, so each datasource type stays
      // visible. The install path enforces the same gate (see POST /install).

      // Filter by plan eligibility, masking any installedConfig field marked
      // `secret: true` in the catalog's config_schema. A workspace admin
      // would otherwise GET /available and read every live credential
      // (#1817); the UI round-trips the placeholder on save via the write
      // path's `applyConfigEdit` restore step. A catalog row with a malformed
      // config_schema (DB drift, migration typo) falls through parseConfigSchema
      // as `state: "corrupt"` — maskSecretFields then fail-closes by masking
      // every string value and we log so operators see the drift.
      const available = catalog
        .filter((entry) => isPlanEligible(plan, entry.min_plan))
        .filter((entry) => !veneer.isSaasIneligible(entry))
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
      // #4001 — SaaS-eligibility gate resolved through the EE veneer Tag (Noop
      // on self-hosted answers `false`, so every row stays installable).
      const veneer = yield* MarketplaceVeneer;

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

      // #3681 — gate by `install_model`. The generic marketplace install path
      // persists `workspace_plugins.config` directly; that is the install
      // shape for `form` plugins only (Email, Webhook, Obsidian, …). OAuth,
      // static-bot, and oauth-datasource plugins carry a DEDICATED credential
      // store (`integration_credentials` / `slack_installations` /
      // `twenty_integrations` / a datasource pool) that only their own
      // install + disconnect handlers (`WorkspaceInstaller`, the OAuth
      // callback routes, `/admin/connections`) populate and tear down. Letting
      // them be installed here would create a half-credentialed row whose
      // dedicated store the marketplace `DELETE` then can't fully reach —
      // exactly the orphan class #3681 fixes. Refuse server-side and point the
      // admin at the dedicated connect flow.
      const installModel = (catalogEntry as { install_model?: string }).install_model;
      if (!isFormInstallModel(installModel)) {
        logAdminAction({
          actionType: ADMIN_ACTIONS.plugin.install,
          targetType: "plugin",
          targetId: body.catalogId,
          scope: "workspace",
          status: "failure",
          metadata: {
            pluginId: body.catalogId,
            pluginSlug: catalogEntry.slug,
            orgId,
            installModelRejected: installModel ?? "unknown",
          },
        });
        return c.json({
          error: "install_model_unsupported",
          message: `"${catalogEntry.slug}" uses the "${installModel ?? "unknown"}" install model and cannot be installed through the marketplace — use its dedicated connect flow under Admin → Integrations or Admin → Connections.`,
          requestId,
        }, 400);
      }

      // #4186 — same routing decision, second axis: the marketplace persists
      // through the form-install spine, whose singleton upsert serves ONLY the
      // chat/action pillars (the `workspace_plugins_singleton` partial unique
      // index). `form`-model rows on other pillars are differently shaped
      // installs — datasource rows are multi-instance drafts owned by the
      // ADR-0013 bridge under /admin/connections, knowledge rows are ingested
      // via their own admin flow — so refuse them here exactly like the
      // install-model gate above. Fail-closed: an unexpected/missing pillar
      // (drifted row) is refused, never coerced to 'action'.
      const catalogPillar =
        catalogEntry.pillar === "chat" || catalogEntry.pillar === "action"
          ? catalogEntry.pillar
          : null;
      if (catalogPillar === null) {
        logAdminAction({
          actionType: ADMIN_ACTIONS.plugin.install,
          targetType: "plugin",
          targetId: body.catalogId,
          scope: "workspace",
          status: "failure",
          metadata: {
            pluginId: body.catalogId,
            pluginSlug: catalogEntry.slug,
            orgId,
            pillarRejected: catalogEntry.pillar ?? "unknown",
          },
        });
        return c.json({
          error: "pillar_unsupported",
          message: `"${catalogEntry.slug}" is a ${catalogEntry.pillar ?? "unknown"}-pillar plugin and cannot be installed through the marketplace — use its dedicated flow (datasources connect under Admin → Connections).`,
          requestId,
        }, 400);
      }

      // #3301 / #4001 defense-in-depth — the /available listing hides
      // `saas_eligible = false` rows on SaaS, but the install path must also
      // refuse them server-side: a workspace admin who already knows the
      // catalog id could otherwise POST it directly and bypass the hidden
      // card. DuckDB is file-path based and not multi-tenant safe. Mirrors the
      // keyset gate in `lib/integrations/install/github-pat-form-handler.ts`.
      // Same EE-resolved veneer decision as the listing filter (Noop → never
      // gated).
      if (veneer.isSaasIneligible(catalogEntry)) {
        logAdminAction({
          actionType: ADMIN_ACTIONS.plugin.install,
          targetType: "plugin",
          targetId: body.catalogId,
          scope: "workspace",
          status: "failure",
          metadata: {
            pluginId: body.catalogId,
            pluginSlug: catalogEntry.slug,
            orgId,
            saasIneligible: true,
          },
        });
        return c.json({
          error: "saas_ineligible",
          message: `"${catalogEntry.slug}" is not available on Atlas Cloud — it can only be configured on a self-hosted deploy.`,
          requestId,
        }, 400);
      }

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
          message: `This plugin requires the "${catalogEntry.min_plan}" plan. Your workspace is on the "${plan ?? "free"}" plan.`,
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

      // F-42 strict-mode (#1835): reject installs the encryptor can't
      // soundly process. Mirrors the platform admin-plugins.ts gate.
      const installStrictRejection = checkStrictPluginSecrets(installSchema);
      if (installStrictRejection !== null) {
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
            strictModeRejection: installStrictRejection.state,
            ...(installStrictRejection.state === "passthrough_with_secret" ? { conflictKey: installStrictRejection.key } : {}),
          },
        });
        return c.json({
          error: "strict_plugin_secrets",
          message: installStrictRejection.state === "corrupt"
            ? `Plugin catalog schema is unreadable (${installStrictRejection.reason}); fix the catalog row before installing.`
            : `Catalog schema for "${installStrictRejection.key}" disagrees on secret vs non-secret; resolve the schema before installing.`,
          requestId,
        }, 422);
      }
      // #4186 — spine step 1: the SaaS fail-closed keyset gate.
      // `encryptSecretFields` degrades to plaintext passthrough when no
      // keyset is configured (dev convenience); on SaaS that would persist
      // the customer's credential in the clear. Same per-call refusal every
      // form-install handler runs via `persistFormInstall`. Sync throw, so a
      // plain try/catch keeps the audit + response shaping here in the route.
      try {
        assertSaasEncryptionKeyset(log, orgId as WorkspaceId, deriveSecretLabel(installSchema));
      } catch (err) {
        // Only the gate's own refusal is shaped here; anything else (e.g.
        // a malformed-keyset parse error out of getEncryptionKeyset)
        // rethrows to runEffect's generic 500 mapper rather than being
        // mislabeled "keyset unavailable" with its raw message echoed.
        if (!(err instanceof EncryptionKeysetUnavailableError)) throw err;
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
            keysetUnavailable: true,
          },
        });
        return c.json({
          error: "encryption_unavailable",
          message: err.message,
          requestId,
        }, 500);
      }
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
      // #4186 — spine steps 3+4: the canonical post-0092 singleton upsert
      // (explicit `install_id` + `pillar`, partial-index conflict target,
      // returned-id invariant) + the unconditional lazy-loader evict, via
      // `persistInstallRecord` — the same tested artifact the form-install
      // spine and OAuth install handlers persist through. The pre-#4186
      // hand-rolled INSERT
      // here omitted `install_id`/`pillar` (both NOT NULL since 0092; the
      // filler trigger that papered over the omission was dropped by 0096,
      // so every marketplace install 23502'd against the live schema) and
      // skipped the evict, so a re-install would keep serving a stale
      // cached PluginLike. Entered at `persistInstallRecord` rather than
      // `persistFormInstall` because platform-admin-CRUD catalog rows carry
      // a bare-UUID id, not the seeder's `catalog:<slug>` (so the slug-
      // derived FK would miss); encryption ran above with the route's own
      // F-42 audit shaping. On a conflict (TOCTOU race past the 409 check)
      // the upsert returns the EXISTING row's id, which is what we audit
      // and respond with.
      const persistedId = yield* Effect.tryPromise({
        try: () =>
          persistInstallRecord({
            workspaceId: orgId as WorkspaceId,
            catalogId: body.catalogId,
            displayName: catalogEntry.name,
            log,
            config: encryptedConfig,
            newId: () => id,
            pillar: catalogPillar,
            installedBy: userId,
          }),
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      }).pipe(Effect.tapError((err) => Effect.sync(() => {
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

      // The state change is complete here (row persisted, cache evicted) —
      // audit success NOW, before the response read-back, so a read-back
      // failure can never leave a completed credential write unaudited
      // (#4186 review).
      logAdminAction({
        actionType: ADMIN_ACTIONS.plugin.install,
        targetType: "plugin",
        targetId: persistedId,
        scope: "workspace",
        metadata: {
          pluginId: body.catalogId,
          pluginSlug: catalogEntry.slug,
          orgId,
        },
      });
      log.info({ orgId, catalogId: body.catalogId, installationId: persistedId }, "Plugin installed in workspace");

      // Fetch the persisted row + joined catalog fields for the response —
      // the spine's upsert only RETURNs the id. Failures past this point
      // are response-shaping failures of a SUCCEEDED install: log them as
      // such so the operator doesn't misread the 500 as "nothing happened".
      const rows = yield* queryEffect<WorkspacePluginRow>(
        MARKETPLACE_INSTALL_READBACK_SQL,
        [persistedId, orgId],
      ).pipe(Effect.tapError((err) => Effect.sync(() => {
        log.error(
          {
            orgId,
            catalogId: body.catalogId,
            installationId: persistedId,
            err: err instanceof Error ? err.message : String(err),
            requestId,
          },
          "Plugin install persisted but the response read-back failed — install is live despite the 500",
        );
      })));

      if (rows.length === 0) {
        log.error(
          { orgId, catalogId: body.catalogId, installationId: persistedId, requestId },
          "Plugin install persisted but the read-back found no row — removed concurrently (uninstall or catalog delete)?",
        );
        return c.json({
          error: "internal_error",
          message: "The plugin was installed, but confirming it failed — it may have been removed concurrently. Refresh the installed-plugins list to verify before retrying.",
          requestId,
        }, 500);
      }
      // F-42: the row fetch echoes back the encrypted `config` blob.
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

      // #3188 / #3681 / #4353 — the ONE shared teardown, by installation id.
      // MUST run before the DELETE below: every step needs the install row
      // (and the credentials inside its config) to still exist — the
      // `onUninstall` hook so the plugin can authenticate to revoke external
      // webhook subscriptions / OAuth grants, and the identity resolution so
      // the dedicated credential switch knows the slug + team_id.
      //
      // This route previously called a hook-ONLY shim here and re-derived the
      // scheduled-task + dedicated-credential steps by hand further down, with
      // a divergent failure posture (a scheduled-task failure short-circuited
      // to a 200 BEFORE credential teardown ran — orphaning the credential).
      // `tearDownWorkspaceInstall` now owns all three steps for every entry
      // point; it never throws (the catch wrapper is defense-in-depth so even
      // a defect can't abort the uninstall) and returns a summary for audit.
      //
      // Best-effort and non-atomic by design: if the row DELETE below fails
      // after teardown ran, the external webhooks are already revoked —
      // acceptable, since a re-install re-registers them.
      const teardown = yield* Effect.promise(async () => {
        try {
          return await tearDownWorkspaceInstall({
            workspaceId: orgId,
            installationId: id,
          });
        } catch (err) {
          log.warn(
            {
              orgId,
              installationId: id,
              err: err instanceof Error ? err.message : String(err),
            },
            "Plugin teardown invocation failed — external subscriptions, credentials and scheduled tasks may be orphaned; uninstall proceeds",
          );
          return null;
        }
      });

      // DELETE ... RETURNING exposes catalog_id from the deleted row tuple,
      // which we scalar-lookup against plugin_catalog (untouched by this
      // statement) to capture slug alongside the uninstall. The subselect
      // can still return NULL if the catalog row was already gone (e.g. a
      // catalog_delete cascade raced with this request). `team_id` is no
      // longer returned here (#4353): the credential switch now reads it from
      // the teardown's own pre-DELETE install-row lookup, where the row is
      // guaranteed to still exist.
      const rows = yield* queryEffect<{ id: string; catalog_id: string; slug: string | null }>(
        `DELETE FROM workspace_plugins WHERE id = $1 AND workspace_id = $2
         RETURNING id, catalog_id, (SELECT slug FROM plugin_catalog WHERE id = workspace_plugins.catalog_id) AS slug`,
        [id, orgId],
      ).pipe(Effect.tapError((err) => Effect.sync(() => {
        // The DELETE rejected before RETURNING resolved, so we don't have
        // the catalog id here. The audit row carries `installationId` (which
        // is also `targetId`) so a forensic query by installation still
        // joins; cross-referencing to a catalog requires looking up
        // workspace_plugins separately. Compare to the success-path audit
        // below, which carries both `installationId` and `pluginId`.
        logAdminAction({
          actionType: ADMIN_ACTIONS.plugin.uninstall,
          targetType: "plugin",
          targetId: id,
          scope: "workspace",
          status: "failure",
          metadata: {
            installationId: id,
            orgId,
            error: err instanceof Error ? err.message : String(err),
          },
        });
      })));

      if (rows.length === 0) {
        return c.json({ error: "not_found", message: `Installation "${id}" not found in this workspace.`, requestId }, 404);
      }

      const deleted = rows[0]!;

      // #4353 — teardown ran NOTHING (its install-row lookup threw, or the
      // call itself defected). The row DELETE above still committed, so the
      // hook, the dedicated credential store and `scheduled_tasks` are ALL
      // unresolved for a row that no longer exists — the worst orphan shape
      // this route can produce, and the one case where an encrypted credential
      // can outlive its install record here. It is a narrow window (the lookup
      // and the DELETE hit the same internal DB, so a lookup failure usually
      // means the DELETE 500s too), but it must never be silent: the failure
      // audit + log.error below are the only operator surface, since the HTTP
      // response is a normal 200. We deliberately do NOT re-derive the teardown
      // from the DELETE's RETURNING tuple — that is exactly the divergent
      // second path this issue removed, and post-DELETE the hook could no
      // longer authenticate anyway.
      const teardownIdentityError = teardown === null
        ? "teardown call failed"
        : teardown.identityError;
      if (teardownIdentityError !== undefined || teardown?.identityResolved === false) {
        const error = teardownIdentityError ?? "install row not resolved";
        logAdminAction({
          actionType: ADMIN_ACTIONS.plugin.uninstall,
          targetType: "plugin",
          targetId: id,
          scope: "workspace",
          status: "failure",
          metadata: {
            installationId: id,
            pluginId: deleted.catalog_id,
            ...(deleted.slug != null && { pluginSlug: deleted.slug }),
            orgId,
            teardownFailed: true,
            error,
          },
        });
        log.error(
          { orgId, installationId: id, pluginId: deleted.catalog_id, err: new Error(error) },
          "Plugin uninstalled but NO teardown ran — the onUninstall hook, dedicated credential store and scheduled tasks may all be orphaned; purge manually",
        );
      }

      // #1987 — plugin-owned scheduled tasks are cleaned up by the shared
      // teardown above (step 3), so the scheduler doesn't keep firing them
      // after uninstall. Scoped there by (plugin_id, org_id) so we never
      // cross workspaces. What remains here is the audit surface.
      //
      // Cleanup contract (uninstall — see
      // apps/docs/content/shared/plugins/authoring-guide.mdx#uninstall-contract):
      //   • scheduled_tasks tagged with this plugin's catalog_id are deleted
      //     by `tearDownWorkspaceInstall`. scheduled_task_runs cascade via
      //     FK on task_id.
      //   • plugin_<table> rows from the schema-migrate path are RETAINED.
      //     Reinstalling the plugin should pick up where it left off (cached
      //     digest history, cursor state, etc.). Operators who need a
      //     hard-reset use the workspace purge path, not uninstall.
      //   • Plugin hook subscriptions (beforeQuery, onRequest, …) live in
      //     the in-process registry only and are not workspace-scoped at
      //     dispatch time — uninstall does NOT detach them. They become
      //     inert for this workspace because workspace_plugins lookups now
      //     return zero rows for the plugin. Process-level teardown runs
      //     only at server shutdown (see PluginRegistry.teardownAll). No DB
      //     rows to clean.
      //   • Webhook subscriptions registered with external platforms (Slack,
      //     GitHub, Stripe, …) are invisible to Atlas — the per-workspace
      //     `onUninstall(workspaceId)` SDK hook (#3188, invoked above BEFORE
      //     the DELETE so credentials still exist) is the seam a plugin
      //     implements to revoke them. The invocation is best-effort: a
      //     throwing hook is logged and the uninstall proceeds, so a plugin
      //     that doesn't implement the hook (or whose revocation fails)
      //     still leaves the external subscription delivering events to a
      //     workspace that no longer has the plugin installed. Documented in
      //     the uninstall contract (apps/docs/.../authoring-guide.mdx#uninstall-contract).
      //
      // Failure mode: teardown and the row DELETE are deliberately NOT atomic.
      // If the shared teardown's scheduled-task step rejected, we log a failure
      // audit with `cleanupFailed=true` plus a structured log.error (so a
      // stdout-scraping setup catches the orphan even if the audit-log row
      // drops on internal-DB circuit-open) and still return 200 — the uninstall
      // semantically succeeded from the user's perspective. The orphan tasks
      // remain in `scheduled_tasks` and the scheduler will keep firing them
      // until cleaned manually
      // (`DELETE FROM scheduled_tasks WHERE plugin_id = $catalog AND org_id = $org`).
      // We chose best-effort cleanup over a multi-statement transaction
      // because making the cleanup load-bearing would block uninstall on
      // internal-DB hiccups and surface partial-failure to admins as a 500.
      // Audit + log is the per-request operator surface. Accumulation across
      // requests is caught by the `orphan_task_reconcile` scheduler fiber
      // (#2944, lib/scheduler/orphan-task-reconcile.ts): it counts orphaned
      // plugin tasks every tick, rides the count on an OTel span, and warns
      // when > 0 — and, when ATLAS_ORPHAN_TASK_RECONCILE=true, sweeps them
      // using this same (plugin_id, org_id) predicate.
      //
      // #4353 — unlike the pre-fold route, a scheduled-task failure no longer
      // short-circuits the response: credential teardown already ran inside
      // `tearDownWorkspaceInstall` regardless, so it can't be skipped here.
      const scheduledTasksDeleted = teardown?.scheduledTasksDeleted ?? 0;
      if (teardown?.scheduledTasksError !== undefined) {
        logAdminAction({
          actionType: ADMIN_ACTIONS.plugin.uninstall,
          targetType: "plugin",
          targetId: id,
          scope: "workspace",
          status: "failure",
          metadata: {
            installationId: id,
            pluginId: deleted.catalog_id,
            ...(deleted.slug != null && { pluginSlug: deleted.slug }),
            orgId,
            cleanupFailed: true,
            error: teardown.scheduledTasksError,
          },
        });
        log.error(
          {
            orgId,
            installationId: id,
            pluginId: deleted.catalog_id,
            err: new Error(teardown.scheduledTasksError),
          },
          "Plugin uninstalled but scheduled-task cleanup failed — orphan tasks may continue firing until purged manually",
        );
      }

      // #3681 — dedicated credential teardown, symmetric with
      // `WorkspaceInstaller.uninstall`, now performed by the shared teardown
      // above (step 2). The `workspace_plugins` DELETE does NOT cascade
      // `integration_credentials` (that FK is on `plugin_catalog`, not
      // `workspace_plugins`) and never touches the `slack_installations` /
      // `discord_installations` / `twenty_integrations` tables. Without it, a
      // credential-bearing row removed here orphaned its dedicated credential.
      // The install route now gates non-`form` models out, so for a normally-
      // installed plugin this is a no-op; it remains as defense-in-depth for
      // any pre-gate / dedicated-flow row that reaches this path. Best-effort
      // (matches the scheduled-task posture): a transient store hiccup must not
      // surface as a 500 — log + failure-audit instead.
      if (teardown?.credentialError !== undefined) {
        logAdminAction({
          actionType: ADMIN_ACTIONS.plugin.uninstall,
          targetType: "plugin",
          targetId: id,
          scope: "workspace",
          status: "failure",
          metadata: {
            installationId: id,
            pluginId: deleted.catalog_id,
            ...(deleted.slug != null && { pluginSlug: deleted.slug }),
            orgId,
            credentialTeardownFailed: true,
            error: teardown.credentialError,
          },
        });
        log.error(
          {
            orgId,
            installationId: id,
            pluginId: deleted.catalog_id,
            err: new Error(teardown.credentialError),
          },
          "Plugin uninstalled but dedicated credential teardown failed — credential row may be orphaned until purged manually",
        );
      }

      logAdminAction({
        actionType: ADMIN_ACTIONS.plugin.uninstall,
        targetType: "plugin",
        targetId: id,
        scope: "workspace",
        metadata: {
          installationId: id,
          pluginId: deleted.catalog_id,
          // `!= null` covers both SQL NULL (from the subselect missing the
          // catalog row) and an absent column (defense in depth against
          // driver-shape drift). Aligned with the config_update guard below.
          ...(deleted.slug != null && { pluginSlug: deleted.slug }),
          orgId,
          ...(scheduledTasksDeleted > 0 && { scheduledTasksDeleted }),
        },
      });
      log.info(
        { orgId, installationId: id, scheduledTasksDeleted },
        "Plugin uninstalled from workspace",
      );
      return c.json({ deleted: true, scheduledTasksDeleted }, 200);
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

      // F-42 strict-mode (#1835): reject the PUT before we touch
      // ciphertext when the schema can't be soundly walked. Mirrors the
      // install + platform-plugin gates.
      const putStrictRejection = checkStrictPluginSecrets(schema);
      if (putStrictRejection !== null) {
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
            strictModeRejection: putStrictRejection.state,
            ...(putStrictRejection.state === "passthrough_with_secret" ? { conflictKey: putStrictRejection.key } : {}),
          },
        });
        return c.json({
          error: "strict_plugin_secrets",
          message: putStrictRejection.state === "corrupt"
            ? `Plugin catalog schema is unreadable (${putStrictRejection.reason}); fix the catalog row before saving.`
            : `Catalog schema for "${putStrictRejection.key}" disagrees on secret vs non-secret; resolve the schema before saving.`,
          requestId,
        }, 422);
      }
      // F-42: the stored JSONB carries `secret: true` fields encrypted.
      // Decrypt through the lib seam (#4194), which classifies failures
      // as `InstalledConfigDecryptError` — surfaced as 500 with a failure
      // audit; the alternative is a silent secret wipe on the PUT.
      let originalConfig: Record<string, unknown>;
      try {
        originalConfig = decryptStoredConfig(originalConfigRaw, schema, {
          installationId: id,
          orgId,
          requestId,
          surface: "marketplace-config-put",
        });
      } catch (err) {
        if (!(err instanceof InstalledConfigDecryptError)) throw err;
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
            error: err.message,
          },
        });
        return c.json({
          error: "internal_error",
          message: "Failed to read current plugin configuration — encrypted secret could not be decrypted.",
          requestId,
        }, 500);
      }
      // Read-modify-write ordering (decrypt → restore-masked → encrypt →
      // mask) is owned by `applyConfigEdit`: the persisted blob is freshly
      // encrypted plaintext (fresh IV, never a ciphertext round-trip) and
      // the response echo is masked (never plaintext).
      const { persistConfig, responseConfig } = applyConfigEdit(originalConfig, body.config, schema);

      // `try/catch` around `yield* queryEffect(...)` so a routing-id unique
      // violation (#3167) maps to the same actionable conflict the install
      // handlers surface, instead of a generic 500. A static-bot install's
      // routing field (chat_id / guild_id / tenant_id / phone_number_id /
      // gchat workspace_id) lives in `config`, so this generic PUT can repoint
      // it onto an id already claimed by another workspace — the migration-0120
      // partial unique index then raises 23505 (wrapped by @effect/sql, which
      // is why the cross-workspace check walks the `.cause` chain). The
      // `tapError` failure audit fires before the throw; any non-routing error
      // is re-thrown to the existing 500 path. (try/catch is the failure-branch
      // pattern that works under both real Effect and the route test shim.)
      let rows: WorkspacePluginRow[];
      try {
        rows = yield* queryEffect<WorkspacePluginRow>(
          `UPDATE workspace_plugins SET config = $1
           WHERE id = $2 AND workspace_id = $3
           RETURNING *, (SELECT name FROM plugin_catalog WHERE id = workspace_plugins.catalog_id) AS name,
                       (SELECT slug FROM plugin_catalog WHERE id = workspace_plugins.catalog_id) AS slug,
                       (SELECT type FROM plugin_catalog WHERE id = workspace_plugins.catalog_id) AS type,
                       (SELECT description FROM plugin_catalog WHERE id = workspace_plugins.catalog_id) AS description`,
          [JSON.stringify(persistConfig), id, orgId],
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
      } catch (err) {
        if (isRoutingIdUniqueViolation(err)) {
          return c.json({
            error: "routing_conflict",
            message:
              "This routing identifier is already connected to a different Atlas workspace. Each one can be linked to only one workspace — disconnect it there first.",
            requestId,
          }, 409);
        }
        throw err;
      }

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
      // F-42: the RETURNING clause gives back the freshly-encrypted blob —
      // never echo it. `applyConfigEdit` derived the masked echo from the
      // same restored plaintext it encrypted, so the UI sees placeholders
      // like it did on GET /available and ciphertext never leaves the DB.
      const updatedResponse = installRowToJson(updated);
      updatedResponse.config = responseConfig;
      return c.json(updatedResponse, 200);
    }),
    { label: "update plugin config" },
  );
});

export { platformCatalog, workspaceMarketplace };
