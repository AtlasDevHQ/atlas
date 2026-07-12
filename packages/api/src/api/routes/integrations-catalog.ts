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
import { PILLARS } from "@useatlas/types";
import { runHandler } from "@atlas/api/lib/effect/hono";
import { hasInternalDB, makeInternalDBShimLayer } from "@atlas/api/lib/db/internal";
import {
  PillarCatalogQuery,
  PillarCatalogQueryLive,
} from "@atlas/api/lib/effect/pillar-catalog-query";
import {
  maskSecretFields,
  parseConfigSchema,
} from "@atlas/api/lib/plugins/secrets";
import { hasFormInstallHandler } from "@atlas/api/lib/integrations/install";
import { ErrorSchema, AuthErrorSchema } from "./shared-schemas";
import { createAdminRouter, requireOrgContext } from "./admin-router";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/**
 * Optional pillar narrowing (#3377, #4619). Two pillars are exposed:
 * - `datasource` — the Connections Add picker's form-install tiles.
 * - `knowledge` — the Knowledge Base "New collection" picker (#4619); its
 *   rows carry `type = 'context'` and drive the schema-driven credential
 *   forms per connector. Data-driven so a new `BUILTIN_KNOWLEDGE_CATALOG_ROWS`
 *   entry surfaces in the UI without a picker edit.
 *
 * The default (no param) response stays byte-identical to the legacy
 * `type IN ('chat','integration')` listing. `chat` / `action` pillar params
 * are intentionally NOT accepted — the legacy listing already covers those
 * surfaces and widening would change their wire `type` guarantees.
 */
const CatalogQuerySchema = z.object({
  pillar: z.enum(["datasource", "knowledge"]).optional(),
});

const CatalogEntryResponseSchema = z.object({
  id: z.string(),
  slug: z.string(),
  // `datasource` appears only on the `?pillar=datasource` listing
  // (#3377); `context` only on `?pillar=knowledge` (#4619, knowledge rows
  // carry `type = 'context'`). The default listing is filtered to
  // chat/integration server-side and never emits either.
  type: z.enum(["chat", "integration", "datasource", "context"]),
  // `installModel` (camelCase) — wire-side casing match for the rest of
  // the response shape. The DB column is `install_model`; the facade
  // does the translation. `oauth-datasource` is GitHub Data's model
  // (migration 0111) and appears on the `?pillar=datasource` listing.
  installModel: z.enum(["oauth", "form", "static-bot", "oauth-datasource"]),
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
   * Pillar taxonomy per [ADR-0006]. `datasource` rows live on
   * `/admin/connections`; `chat` and `action` rows live on
   * `/admin/integrations`; `knowledge` rows live on `/admin/knowledge`
   * (ADR-0028, surfaced via `?pillar=knowledge` — #4619). Slice 8 wires
   * the UI section split. Derived from the `PILLARS` tuple so the wire
   * enum can never drift from `@useatlas/types`.
   */
  pillar: z.enum(PILLARS),
  /**
   * Whether Atlas has shipped a working install path. `coming_soon`
   * rows render as inert grey cards in admin UI (slice 9 wires the
   * rendering).
   */
  implementationStatus: z.enum(["available", "coming_soon"]),
  /**
   * Non-secret subset of `workspace_plugins.config` for installed rows.
   * Carries operator-visible install metadata: Salesforce
   * `instance_url` / `org_id`, Jira `cloud_id`, etc. Secret-marked
   * fields (driven by the catalog's `config_schema.fields[].secret`
   * flag) are replaced with a masked placeholder server-side via
   * {@link maskSecretFields} so the wire never carries plaintext
   * credentials. `null` when the row is not installed.
   *
   * Slice 7 of 1.5.3 (#2745) introduced this field so the
   * `/admin/connections` Salesforce render path can show "connected
   * org" + "instance URL" detail rows without a second round-trip.
   */
  installConfig: z.record(z.string(), z.unknown()).nullable(),
  /**
   * Whether this row can be installed through the schema-driven
   * form-install (`POST /:platform/install-form`) — i.e. its
   * `installModel` is `form` AND a form-install handler is actually
   * registered for the slug ({@link hasFormInstallHandler}, the same
   * registry the install route's dispatch consults). Emitted ONLY on
   * the `?pillar=datasource` listing (#3387); the default (no-pillar)
   * response stays byte-identical and omits the key entirely.
   *
   * The Add-datasource picker derives its form-install tiles from this
   * flag instead of a hardcoded slug list, so a catalog row without a
   * registered handler (postgres/mysql — native URL-form path;
   * demo-postgres — auto-installed; duckdb — deliberately handler-less,
   * `atlas.config.ts`-only) can never render a submittable tile.
   * Derivation is deploy-mode agnostic — no `deployMode` branch.
   */
  formInstallable: z.boolean().optional(),
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
    "for the catalog entry. Pass `?pillar=datasource` to list datasource-" +
    "pillar catalog rows (with install status), or `?pillar=knowledge` to " +
    "list Knowledge Base connector rows, instead of the default " +
    "chat/integration listing.",
  request: { query: CatalogQuerySchema },
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
    422: {
      description: "Invalid query parameters (unknown `pillar` value)",
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

    // `undefined` keeps the default (legacy chat/integration) listing
    // byte-identical; `datasource` swaps in the pillar-scoped read (#3377).
    const { pillar } = c.req.valid("query");

    // The facade lives behind an Effect Tag — provide its Live Layer
    // with the InternalDB shim so the route can call into it without
    // pulling the AppLayer's ManagedRuntime down here. Same pattern as
    // `admin-proactive-analytics.ts` (#2622) for `AnswerMeterLive`.
    // #3764 — accepted: this per-route boundary provide is the intended shape
    // (route as its own composition root), not a lib-level provide to lift.
    const rows = await Effect.runPromise(
      Effect.gen(function* () {
        const facade = yield* PillarCatalogQuery;
        return yield* facade.withInstallStatusFor(orgId, pillar);
      }).pipe(
        Effect.provide(
          PillarCatalogQueryLive.pipe(Layer.provide(makeInternalDBShimLayer())),
        ),
      ),
    );

    const catalog = rows.map((row) => {
      // Project the non-secret subset of `workspace_plugins.config` to
      // the wire so admin-UI render paths (e.g. /admin/connections for
      // Salesforce, #2745) can show "connected org" / instance URL /
      // tenant id without a second round-trip. `maskSecretFields`
      // fail-closes on a `corrupt` schema (every non-empty string is
      // masked) so a drifted catalog row can never leak plaintext.
      const installConfig = row.install
        ? maskSecretFields(row.install.config, parseConfigSchema(row.configSchema))
        : null;
      return {
        id: row.id,
        slug: row.slug,
        // The facade's `type` is the raw DB string; the route narrows
        // back to the wire union. The legacy-type SQL exclusion (default
        // listing) / pillar predicate (`?pillar=datasource|knowledge`) in
        // the facade keeps this safe — any other value would mean a CHECK
        // constraint regression. Knowledge rows carry `type = 'context'`.
        type: row.type as "chat" | "integration" | "datasource" | "context",
        installModel: row.installModel as "oauth" | "form" | "static-bot" | "oauth-datasource",
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
        installConfig,
        // `formInstallable` (#3387): pillar listing only — the default
        // branch must stay byte-identical (pinned by the exact-body test),
        // so the key is omitted entirely there, not set to false. Derived
        // from the live form-handler registry (the same source the
        // /install-form dispatch consults), never from a parallel slug
        // list, and never from deploy mode.
        ...(pillar === undefined
          ? {}
          : {
              formInstallable:
                row.installModel === "form" && hasFormInstallHandler(row.slug),
            }),
      };
    });

    return c.json({ catalog }, 200);
  });
});
