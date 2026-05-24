/**
 * GET /api/v1/integrations/catalog — read-only customer-facing surface over
 * `plugin_catalog`, seeded at boot by `CatalogSeeder` (#2650).
 *
 * Pivot to `PillarCatalogQuery` facade — #2741 (slice 3 of 1.5.3). The
 * three SELECTs that used to live inline now live behind the facade Tag
 * defined in `lib/effect/pillar-catalog-query.ts`. The facade collapses
 * (plan + catalog + installs) → `CatalogEntryWithState[]` and applies the
 * install-status state machine (`resolveInstallStatus` from
 * `lib/integrations/install-status-machine.ts`) per row. This route stays
 * a thin projection from the facade's rich row → the on-wire envelope.
 *
 * Wire-shape additions (#2741): `pillar` and `implementationStatus`.
 * Existing fields stay byte-identical so slice 8 (admin-UI section
 * split by pillar) and slice 9 (coming-soon badge) can land additively
 * without re-coordinating with this route.
 *
 * Filters: deploy-mode (saas narrows to `saas_eligible = true`) and the
 * legacy-type exclusion (`type IN ('chat', 'integration')`) live inside
 * the facade — the route doesn't re-derive them. Plan tier: above-plan
 * rows are returned with `upsellOnly: true` so the UI renders a
 * read-only upsell card per #2651.
 */

import { createRoute, z } from "@hono/zod-openapi";
import { Effect, Layer } from "effect";
import { runHandler } from "@atlas/api/lib/effect/hono";
import { hasInternalDB, makeInternalDBShimLayer } from "@atlas/api/lib/db/internal";
import {
  PillarCatalogQuery,
  PillarCatalogQueryLive,
} from "@atlas/api/lib/effect/pillar-catalog-query";
import { ErrorSchema, AuthErrorSchema } from "./shared-schemas";
import { createAdminRouter, requireOrgContext } from "./admin-router";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const CatalogEntryResponseSchema = z.object({
  id: z.string(),
  slug: z.string(),
  type: z.enum(["chat", "integration"]),
  // `installModel` (camelCase) — wire-side casing match for the rest of
  // the response shape. The DB column is `install_model`; the facade
  // does the translation.
  installModel: z.enum(["oauth", "form", "static-bot"]),
  name: z.string(),
  description: z.string().nullable(),
  iconUrl: z.string().nullable(),
  minPlan: z.string(),
  configSchema: z.unknown().nullable(),
  installed: z.boolean(),
  installedAt: z.string().nullable(),
  installedBy: z.string().nullable(),
  // Per-install state derived from `workspace_plugins.config.status`.
  // `null` when the install row is absent OR the platform doesn't
  // participate in the status taxonomy. `"reconnect_needed"` when the
  // token refresh permanently failed (#2658).
  installStatus: z.string().nullable(),
  upsellOnly: z.boolean(),
  /**
   * Whether the workspace's current plan tier admits installing this
   * entry. Mirrors `!upsellOnly` today, but the explicit field reads
   * better at call sites (`if (!entry.accessible) ...` vs the double
   * negative). Operator workspaces (`is_operator_workspace = true`)
   * always see `accessible: true` regardless of plan tier.
   */
  accessible: z.boolean(),
  /**
   * Plan tier the workspace would need to upgrade to in order to
   * install this entry, or `null` when the entry is already accessible.
   * Matches `minPlan` for inaccessible entries; the dedicated field
   * lets the UI render "Upgrade to Starter" copy without re-deriving
   * the comparison.
   */
  upgradeRequired: z.string().nullable(),
  // ── New in #2741 (slice 3 of 1.5.3) ───────────────────────────────
  /**
   * Three-pillar taxonomy per [ADR-0006]. `datasource` rows live on
   * `/admin/connections`; `chat` and `action` rows live on
   * `/admin/integrations`. Slice 8 wires the UI section split.
   */
  pillar: z.enum(["datasource", "chat", "action"]),
  /**
   * Whether Atlas has shipped a working install path. `coming_soon`
   * rows render as inert grey cards in admin UI (slice 9 wires the
   * rendering).
   */
  implementationStatus: z.enum(["available", "coming_soon"]),
});

const CatalogResponseSchema = z.object({
  catalog: z.array(CatalogEntryResponseSchema),
});

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
 * of the admin surface applies.
 */
export const integrationsCatalog = createAdminRouter();
integrationsCatalog.use(requireOrgContext());

integrationsCatalog.openapi(listCatalogRoute, async (c) => {
  return runHandler(c, "list integrations catalog", async () => {
    const { orgId, requestId } = c.var.orgContext;

    if (!hasInternalDB()) {
      return c.json(
        { error: "not_available", message: "No internal database configured.", requestId },
        404,
      );
    }

    // The facade lives behind an Effect Tag — provide its Live Layer
    // with the InternalDB shim so the route can call into it without
    // pulling the AppLayer's ManagedRuntime down here. Same pattern as
    // `admin-proactive-analytics.ts` (#2622) for `AnswerMeterLive`.
    const rows = await Effect.runPromise(
      Effect.gen(function* () {
        const facade = yield* PillarCatalogQuery;
        return yield* facade.withInstallStatusFor(orgId);
      }).pipe(
        Effect.provide(
          PillarCatalogQueryLive.pipe(Layer.provide(makeInternalDBShimLayer())),
        ),
      ),
    );

    const catalog = rows.map((row) => ({
      id: row.id,
      slug: row.slug,
      // The facade's `type` is the raw DB string; the route narrows
      // back to the wire union. The legacy-type SQL exclusion in the
      // facade keeps this safe — any other value would mean a CHECK
      // constraint regression.
      type: row.type as "chat" | "integration",
      installModel: row.installModel as "oauth" | "form" | "static-bot",
      name: row.name,
      description: row.description,
      iconUrl: row.iconUrl,
      minPlan: row.minPlan,
      configSchema: row.configSchema ?? null,
      installed: row.install !== null,
      installedAt: row.install?.installedAt ?? null,
      installedBy: row.install?.installedBy ?? null,
      installStatus: row.install?.status ?? null,
      upsellOnly: !row.planAccessible,
      accessible: row.planAccessible,
      upgradeRequired: row.planAccessible ? null : row.minPlan,
      pillar: row.pillar,
      implementationStatus: row.implementationStatus,
    }));

    return c.json({ catalog }, 200);
  });
});
