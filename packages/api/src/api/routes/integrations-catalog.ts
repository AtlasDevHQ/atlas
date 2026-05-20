/**
 * GET /api/v1/integrations/catalog — read-only customer-facing surface over
 * `plugin_catalog`, seeded at boot by `CatalogSeeder` (#2650).
 *
 * Slice 3 of 1.5.2 (#2651). Connect / Disconnect handlers land in #2654
 * and #2656 — this route ships only the read path so the `/admin/integrations`
 * card surface has data to render.
 *
 * Filters:
 *   - `enabled = true` (SQL — narrowed by the partial index on the column).
 *   - SaaS deploy mode → also requires `saas_eligible = true` (SQL).
 *   - Plan tier: above-plan rows are returned with `upsellOnly: true` rather
 *     than filtered out, so the UI can render a read-only upsell card per
 *     #2651 AC. Below-or-equal rows return `upsellOnly: false`.
 *
 * The workspace install join is computed in-process from
 * `workspace_plugins WHERE workspace_id = ?` so the catalog query is a single
 * SQL fragment per deploy-mode branch (no per-row LATERAL).
 *
 * Vocabulary note: catalog `min_plan` is `starter|team|business|enterprise`,
 * but workspace `plan_tier` is `free|trial|starter|pro|business`. Tracking
 * issue #2666 covers the cleanup; in the interim {@link PLAN_RANK} below
 * holds one comparator that handles both vocabularies.
 */

import { Effect } from "effect";
import { createRoute, z } from "@hono/zod-openapi";
import { runEffect } from "@atlas/api/lib/effect/hono";
import { RequestContext } from "@atlas/api/lib/effect/services";
import { internalQuery } from "@atlas/api/lib/db/internal";
import { getConfig } from "@atlas/api/lib/config";
import { createLogger } from "@atlas/api/lib/logger";
import { ErrorSchema, AuthErrorSchema } from "./shared-schemas";
import { createAdminRouter, requireOrgContext } from "./admin-router";

const log = createLogger("integrations-catalog");

// ---------------------------------------------------------------------------
// Plan rank — interim unified table covering both vocabularies (#2666).
// ---------------------------------------------------------------------------

/**
 * Rank for the plan-tier comparator. The catalog's `min_plan` and the
 * workspace's `plan_tier` use different vocabularies today (#2666); this
 * table holds the union so both sides can be ranked. A row is installable
 * when `PLAN_RANK[workspacePlan] >= PLAN_RANK[catalogMinPlan]`.
 */
const PLAN_RANK: Record<string, number> = {
  // workspace plan_tier (@useatlas/types PLAN_TIERS)
  free: 0,
  trial: 1,
  starter: 1,
  pro: 2,
  business: 3,
  // catalog-only min_plan values (config.ts CATALOG_MIN_PLANS)
  team: 2,
  enterprise: 4,
};

function isUpsellOnly(
  workspacePlan: string,
  requiredPlan: string,
  context?: { slug?: string; id?: string },
): boolean {
  const requiredRank = PLAN_RANK[requiredPlan];
  if (requiredRank === undefined) {
    // Unknown required tier — treat as upsell so the card renders read-only.
    log.warn(
      { requiredPlan, slug: context?.slug, id: context?.id },
      "plugin_catalog.min_plan has unknown value — flagging entry as upsellOnly",
    );
    return true;
  }
  const wsRank = PLAN_RANK[workspacePlan] ?? 0;
  return wsRank < requiredRank;
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const CatalogEntryResponseSchema = z.object({
  id: z.string(),
  slug: z.string(),
  type: z.enum(["chat", "integration"]),
  // `installModel` (camelCase) — wire-side casing match for the rest of
  // the response shape. The DB column is `install_model`; the mapper
  // below at `entries.map(...)` does the translation.
  installModel: z.enum(["oauth", "form", "static-bot"]),
  name: z.string(),
  description: z.string().nullable(),
  iconUrl: z.string().nullable(),
  minPlan: z.string(),
  configSchema: z.unknown().nullable(),
  installed: z.boolean(),
  installedAt: z.string().nullable(),
  installedBy: z.string().nullable(),
  upsellOnly: z.boolean(),
});

const CatalogResponseSchema = z.object({
  catalog: z.array(CatalogEntryResponseSchema),
});

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

interface CatalogRow extends Record<string, unknown> {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  type: string;
  install_model: string;
  icon_url: string | null;
  config_schema: unknown;
  min_plan: string;
  saas_eligible: boolean;
}

interface InstallationRow extends Record<string, unknown> {
  catalog_id: string;
  installed_at: string | Date;
  installed_by: string | null;
}

function asIsoString(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

const listCatalogRoute = createRoute({
  method: "get",
  path: "/catalog",
  tags: ["Integrations"],
  summary: "List installable integrations for the current workspace",
  description:
    "Returns every enabled catalog entry visible to the requesting workspace. " +
    "Rows above the workspace's plan tier are returned with `upsellOnly: true` " +
    "so the UI can render a read-only upsell card. On SaaS deploys, " +
    "`saas_eligible = false` rows are hidden entirely. The `installed` " +
    "boolean reflects whether the workspace has a row in `workspace_plugins` " +
    "for the catalog entry.",
  responses: {
    200: {
      description: "Catalog entries",
      content: { "application/json": { schema: CatalogResponseSchema } },
    },
    400: {
      description: "No active organization",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    404: {
      description: "Internal database not configured",
      content: { "application/json": { schema: ErrorSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

/**
 * Catalog read endpoint mounted under `/api/v1/integrations`. Uses
 * {@link createAdminRouter} so the same admin-role + MFA gate as the rest
 * of the admin surface applies — slice 3 of #2651 keeps this read-only;
 * install / disconnect mutations land in #2654 / #2656.
 */
export const integrationsCatalog = createAdminRouter();
integrationsCatalog.use(requireOrgContext());

integrationsCatalog.openapi(listCatalogRoute, async (c) => {
  return runEffect(
    c,
    Effect.gen(function* () {
      yield* RequestContext;
      const { orgId } = c.var.orgContext;

      const isSaas = getConfig()?.deployMode === "saas";

      // Independent queries — plan lookup, catalog read, install lookup all
      // resolve from the same internal DB. Run in parallel to keep latency
      // bounded by the slowest, not the sum.
      //
      // `type IN ('chat', 'integration')` excludes legacy marketplace rows
      // (`datasource|context|interaction|action|sandbox`) — the DB CHECK
      // still admits them (migration 0014 + 0087) and `admin-marketplace`'s
      // platform-admin write path can insert them. Letting them through
      // would fail the client-side Zod parse on `type` (which enums
      // `chat | integration`) and render the page as a schema-mismatch
      // banner. See `admin-schemas.ts:IntegrationsCatalogEntrySchema`.
      const catalogSql = isSaas
        ? `SELECT id, slug, name, description, type, install_model, icon_url,
                  config_schema, min_plan, saas_eligible
             FROM plugin_catalog
            WHERE enabled = true AND saas_eligible = true
              AND type IN ('chat', 'integration')
            ORDER BY type ASC, name ASC`
        : `SELECT id, slug, name, description, type, install_model, icon_url,
                  config_schema, min_plan, saas_eligible
             FROM plugin_catalog
            WHERE enabled = true
              AND type IN ('chat', 'integration')
            ORDER BY type ASC, name ASC`;

      // `Effect.tryPromise` (not `Effect.promise`) — DB rejections must
      // flow through Effect's typed-failure channel so `runEffect` /
      // `classifyError` map them to a clean 500 with `requestId`. The
      // `Effect.promise` constructor declares "never rejects" and would
      // turn DB failures into defects.
      const [planRows, catalog, installations] = yield* Effect.tryPromise({
        try: () =>
          Promise.all([
            internalQuery<{ plan_tier: string }>(
              "SELECT plan_tier FROM organization WHERE id = $1",
              [orgId],
            ),
            internalQuery<CatalogRow>(catalogSql),
            internalQuery<InstallationRow>(
              `SELECT catalog_id, installed_at, installed_by
                 FROM workspace_plugins
                WHERE workspace_id = $1`,
              [orgId],
            ),
          ]),
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      });

      // Fallback to "free" matches the `organization.plan_tier` column
      // default. `requireOrgContext` already 400'd if the active org is
      // missing — this empty-row case is the rare "org exists but
      // plan_tier is null" path; fail closed to the most restrictive
      // tier so upsell flagging stays conservative.
      const workspacePlan = planRows[0]?.plan_tier ?? "free";

      const installedByCatalogId = new Map<string, InstallationRow>(
        installations.map((row) => [row.catalog_id, row]),
      );

      const entries = catalog.map((row) => {
        const installation = installedByCatalogId.get(row.id);
        return {
          id: row.id,
          slug: row.slug,
          type: row.type as "chat" | "integration",
          installModel: row.install_model as "oauth" | "form" | "static-bot",
          name: row.name,
          description: row.description,
          iconUrl: row.icon_url,
          minPlan: row.min_plan,
          configSchema: row.config_schema ?? null,
          installed: installation !== undefined,
          installedAt: installation ? asIsoString(installation.installed_at) : null,
          installedBy: installation?.installed_by ?? null,
          upsellOnly: isUpsellOnly(workspacePlan, row.min_plan, { slug: row.slug, id: row.id }),
        };
      });

      return c.json({ catalog: entries }, 200);
    }),
    { label: "list integrations catalog" },
  );
});
