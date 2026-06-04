/**
 * Platform install routes — slice 5 of #2649 (issue #2653).
 *
 * `/api/v1/integrations/:platform/install`  — start the OAuth dance
 * `/api/v1/integrations/:platform/callback` — handle the OAuth callback
 *
 * The handler family is dispatched by `getInstallHandler(catalogRow)`
 * from `lib/integrations/install`. This router is generic over the
 * Platform: it resolves the catalog row by slug, narrows the dispatch
 * result on `kind`, and calls into the per-Platform handler. Per-Platform
 * details (Slack's `oauth.v2.access`, Jira's `oauth/token`, etc.) live
 * in the registered handler, not here.
 *
 * Today only `install_model: "oauth"` is supported (slice 5 — Slack).
 * Form-based and static-bot install models surface a clear 400 — their
 * UI flows differ (form submit vs. routing-id capture) and don't share
 * this router's redirect-and-callback shape.
 *
 * Mount sibling: `integrations-catalog.ts` is also mounted at
 * `/api/v1/integrations` (path `/catalog`) and uses `createAdminRouter()`
 * which applies `adminAuth` + `mfaRequired` middleware. Hono scopes
 * sub-router middleware to that sub-router's own routes — the admin gate
 * does NOT bleed into this router's `/:platform/install,callback`. The
 * two sub-routers share a mount prefix but have non-overlapping paths
 * (`/catalog` is never a valid platform slug because the row id
 * `catalog:catalog` would never be seeded, and the catalog router owns
 * the `/catalog` segment first).
 *
 * Auth: install requires an authenticated workspace admin (per the F-04
 * install-hijack threat — without an org binding, an attacker can race
 * to claim a real OAuth token under their workspace). Callback verifies
 * the same binding via the state token signed at install time. In SaaS
 * deploy mode, the `mode === "none"` no-auth branch is refused outright
 * — managed-auth misconfig must never let an install land without an
 * org binding (would write under a shared sentinel workspace id).
 */

import { Effect } from "effect";
import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { z } from "zod";
import { internalQuery } from "@atlas/api/lib/db/internal";
import { createLogger } from "@atlas/api/lib/logger";
import { getWebOrigin } from "@atlas/api/lib/web-origin";
import { runHandler, runEffect } from "@atlas/api/lib/effect/hono";
import { getConfig } from "@atlas/api/lib/config";
import { ChatIntegrationLimitError, PlatformOAuthExchangeError } from "@atlas/api/lib/effect/errors";
import {
  WorkspaceInstaller,
  WorkspaceInstallerLive,
  INTEGRATION_CREDENTIALS_SLUGS,
} from "@atlas/api/lib/effect/workspace-installer";
import { getInstallHandler } from "@atlas/api/lib/integrations/install";
import { FormInstallValidationError } from "@atlas/api/lib/integrations/install/email-form-handler";
import {
  isPlanEligible,
  parsePlanTier,
} from "@atlas/api/lib/integrations/install/plan-rank";
import { verifyOAuthStateToken } from "@atlas/api/lib/integrations/install/oauth-state-token";
import { findDataCandidateBySlug } from "@atlas/api/lib/openapi/data-candidates";
import {
  detectMisrouting,
  isStrictRoutingEnabled,
} from "@atlas/api/lib/residency/misrouting";
import { adminAuthPreamble, requireAdminAuth } from "./admin-auth";
import {
  MFA_ENROLLMENT_REQUIRED,
  shouldRequireMfaForAuthResult,
} from "./admin-mfa-required";
import { validationHook } from "./validation-hook";
import { ErrorSchema, AuthErrorSchema } from "./shared-schemas";
import { PLAN_TIERS } from "@useatlas/types";
import type {
  PlanTier,
  PlanUpgradeRequiredBody,
  WorkspaceId,
} from "@useatlas/types";
import type { CatalogInstallModel } from "@atlas/api/lib/config";

const log = createLogger("integrations");

/**
 * Catalog slugs whose OAuth callback carries `installation_id` instead
 * of (or alongside) the standard OAuth 2.0 `code` parameter — i.e. the
 * GitHub App install flow. Other platforms get a 400 if a caller
 * smuggles `installation_id` into their callback URL: it's never
 * legitimate (no upstream provider for those platforms emits it) and
 * forwarding it to the per-Platform handler would surface as a
 * misleading "upstream OAuth exchange refused" envelope.
 *
 * Adding a future Platform whose callback uses installation_id-shaped
 * credentials (e.g. a future GitHub-data row) is one entry here.
 */
const INSTALLATION_ID_PLATFORMS: ReadonlySet<string> = new Set([
  "github",
  "github-single-tenant",
  // github-data (#3030) — the OAuth-datasource row reusing the SAME GitHub App
  // install dance (code + installation_id) as the action `github` row.
  "github-data",
]);

/**
 * Catalog slugs whose credentials live INLINE in
 * `workspace_plugins.config` (encrypted via selective-field encryption,
 * ADR-0007 unified install pipeline) — i.e. no separate
 * `integration_credentials` / `chat_cache` row. Disconnect for these
 * slugs is two DB ops total: a no-op credential-store teardown +
 * the workspace_plugins DELETE that `WorkspaceInstaller.uninstall`
 * already runs. The route's per-Platform 501 gate admits them so the
 * facade isn't blocked.
 *
 * github-pat (form-install) was the first inline-cred slug — it shipped
 * via #2807 without disconnect wiring, which has now been folded in.
 * github / github-single-tenant land here for the same reason.
 *
 * Future inline-cred form/static-bot slugs (email, webhook, obsidian,
 * linear-apikey, telegram, discord, teams) live behind their own
 * separate credential-store dispatches today and are NOT covered by
 * this set — adding them is a follow-up that requires matching
 * `WorkspaceInstaller.deleteCredentialStoreForSlug` branches.
 */
const INLINE_CREDENTIAL_SLUGS: ReadonlySet<string> = new Set([
  "github",
  "github-single-tenant",
  "github-pat",
]);

/**
 * Slugs that store credentials in a dedicated per-Platform credential
 * table (not `integration_credentials` and not inline in
 * `workspace_plugins.config`). Disconnect must drop both the
 * dedicated row AND the catalog row — `deleteCredentialStoreForSlug`
 * in `lib/effect/workspace-installer.ts` carries the per-slug branch.
 *
 * `twenty` is currently the only member; the credential table is
 * `twenty_integrations` (created in #2727).
 */
const DEDICATED_TABLE_CREDENTIAL_SLUGS: ReadonlySet<string> = new Set(["twenty"]);

/**
 * OpenAPI schema for the 403 {@link PlanUpgradeRequiredBody}. Pins the
 * wire shape — both plan fields are PlanTier (the same union used
 * everywhere else) — and the `z.ZodType<PlanUpgradeRequiredBody>`
 * `satisfies` clause makes adding a tier in `@useatlas/types` a
 * compile error here until the schema is updated.
 */
const PlanUpgradeRequiredBodySchema = z.object({
  error: z.literal("plan_upgrade_required"),
  message: z.string(),
  required_plan: z.enum(PLAN_TIERS),
  current_plan: z.enum(PLAN_TIERS),
  requestId: z.string(),
}) satisfies z.ZodType<PlanUpgradeRequiredBody>;

const integrations = new OpenAPIHono({ defaultHook: validationHook });

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const installRoute = createRoute({
  method: "get",
  path: "/{platform}/install",
  tags: ["Integrations"],
  summary: "Platform OAuth install redirect",
  description:
    "Redirects to the Platform's OAuth authorization page. Requires the caller to be an " +
    "authenticated workspace admin — the state token binds the resulting install record " +
    "to the caller's workspace.",
  request: {
    params: z.object({
      platform: z.string().openapi({ description: "Catalog slug (e.g. 'slack')" }),
    }),
  },
  responses: {
    302: {
      description:
        "Redirect to Platform OAuth authorization page on success, or to " +
        "`/admin/integrations?error=<platform>&reason=<code>` when the install is " +
        "refused before the redirect (browser callers): `plan_upgrade_required` " +
        "when the workspace's plan tier does not admit the install, or " +
        "`plan_limit_reached` (#2998) when a chat integration would exceed the " +
        "plan's chat-integration cap.",
    },
    400: { description: "Platform is not OAuth-installable, or unknown", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Not authenticated", content: { "application/json": { schema: AuthErrorSchema } } },
    403: {
      description:
        "Caller is not a workspace admin, or the workspace's plan tier does not " +
        "admit this integration (JSON callers; browsers see a 302 to the admin UI). " +
        "Plan-upgrade responses follow the PlanUpgradeRequiredBody shape with " +
        "PlanTier-typed `required_plan` + `current_plan` fields.",
      content: {
        "application/json": {
          schema: z.union([PlanUpgradeRequiredBodySchema, AuthErrorSchema]),
        },
      },
    },
    404: { description: "Platform not found in catalog", content: { "application/json": { schema: ErrorSchema } } },
    // #2998 — chat-integration cap reached pre-redirect (`plan_limit_exceeded`,
    // body carries the `limit`), OR rate limited. Browser callers get a 302 to
    // the admin UI with `reason=plan_limit_reached` for the cap case instead.
    429: {
      description:
        "Chat-integration cap reached for the workspace's plan tier " +
        "(`plan_limit_exceeded`, JSON-Accept caller), or rate limited.",
      content: {
        "application/json": {
          schema: z.union([ErrorSchema.extend({ limit: z.number() }), AuthErrorSchema]),
        },
      },
    },
    501: { description: "OAuth handler not registered", content: { "application/json": { schema: ErrorSchema } } },
    // #2998 — the chat-integration count couldn't be determined (transient DB
    // fault), so the pre-redirect cap check failed closed: `billing_check_failed`
    // "try again" (browser and JSON callers alike).
    503: {
      description: "Billing/plan-limit check unavailable: `billing_check_failed` (pre-redirect cap precheck)",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const installFormRoute = createRoute({
  method: "post",
  path: "/{platform}/install-form",
  tags: ["Integrations"],
  summary: "Submit a non-OAuth install (form credentials or static-bot routing id)",
  description:
    "Persists the submitted install for a non-OAuth catalog entry. Two install models share " +
    "this route:\n\n" +
    "- `install_model: \"form\"` (#2660 — Email, Webhook / Obsidian): validates the JSON body " +
    "against the per-Platform schema, encrypts secret-marked fields at rest, and upserts the " +
    "workspace_plugins row. 400 with field-level detail on validation failure.\n" +
    "- `install_model: \"static-bot\"` (#3140 — Telegram / Teams / Google Chat / WhatsApp): the " +
    "first `required` field in the catalog `config_schema` is the routing identifier (chat_id, " +
    "tenant_id, …); the route forwards its value to the handler's `confirmInstall`, which upserts the " +
    "workspace_plugins(pillar='chat') row. The cap gate (`checkChatIntegrationLimitAndInstall`, the " +
    "advisory-locked insert path — over-cap → 429, reconnect grandfathered) lives inside " +
    "`confirmInstall`; Discord and Slack run it today, the four form-shaped static-bots adopt it in " +
    "#3141–#3144. Until a platform's slice ships, its catalog row stays `coming_soon` and the route " +
    "refuses it (409 `platform_not_available`), so this route never reaches a not-yet-cap-gated handler.\n\n" +
    "The route rejects requests pointed at OAuth-installable catalog entries with 400 " +
    "(`wrong_install_model`), and OAuth-shaped static-bots (Discord) with 400 " +
    "(`oauth_shaped_static_bot` — install those via their dedicated OAuth endpoint).",
  request: {
    params: z.object({
      platform: z.string().openapi({ description: "Catalog slug (e.g. 'email', 'telegram')" }),
    }),
    body: {
      content: {
        "application/json": {
          schema: z.record(z.string(), z.unknown()).openapi({
            description:
              "Form data shaped to the catalog entry's `configSchema`. For static-bot installs " +
              "this carries the routing identifier (e.g. `chat_id`) plus optional label fields. " +
              "Validated server-side by the per-Platform handler — never trust the client.",
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Install record + credential persisted",
      content: {
        "application/json": {
          schema: z.object({
            installed: z.literal(true),
            platform: z.string(),
            installId: z.string(),
          }),
        },
      },
    },
    400: {
      description:
        "Validation failure (per-field detail in `fieldErrors`, top-level issues in " +
        "`formErrors`), missing org binding, platform is not form/static-bot-installable " +
        "(`wrong_install_model`), an OAuth-shaped static-bot was submitted here " +
        "(`oauth_shaped_static_bot`), a static-bot routing identifier was missing " +
        "(`missing_routing_identifier`), or a static-bot routing id failed the handler's " +
        "format / reachability check (`bad_request`, carrying the upstream message).",
      content: {
        "application/json": {
          schema: ErrorSchema.extend({
            // Optional per-field detail emitted on `invalid_form_data`
            // (FormInstallValidationError) — keys are the catalog
            // `configSchema` field names. `formErrors` covers
            // schema-level issues (`.strict()` unrecognized keys,
            // top-level `.refine` rejections) that don't bind to one
            // field.
            fieldErrors: z.record(z.string(), z.array(z.string())).optional(),
            formErrors: z.array(z.string()).optional(),
          }),
        },
      },
    },
    401: { description: "Not authenticated", content: { "application/json": { schema: AuthErrorSchema } } },
    403: {
      description:
        "Caller is not a workspace admin, or the workspace's plan tier " +
        "does not admit this integration. Plan-upgrade responses follow " +
        "the PlanUpgradeRequiredBody shape with PlanTier-typed " +
        "`required_plan` + `current_plan` fields.",
      content: {
        "application/json": {
          schema: z.union([PlanUpgradeRequiredBodySchema, AuthErrorSchema]),
        },
      },
    },
    404: { description: "Platform not found in catalog", content: { "application/json": { schema: ErrorSchema } } },
    // #3140 — static-bot whose slice hasn't shipped yet (`coming_soon`).
    409: { description: "Static-bot platform not available for install yet (`platform_not_available`)", content: { "application/json": { schema: ErrorSchema } } },
    // #3140 — static-bot install at the workspace's chat-integration cap
    // (`plan_limit_exceeded`, body carries `limit`), or rate limited. Raised by
    // `confirmInstall`'s cap gate — live once a platform's handler is migrated
    // onto `checkChatIntegrationLimitAndInstall` (#3141–#3144); Discord/Slack
    // already do.
    429: {
      description:
        "Chat-integration cap reached for a static-bot install " +
        "(`plan_limit_exceeded`, JSON body carries `limit`), or rate limited.",
      content: {
        "application/json": {
          schema: z.union([ErrorSchema.extend({ limit: z.number() }), AuthErrorSchema]),
        },
      },
    },
    501: { description: "Form / static-bot handler not registered, or catalog misconfig", content: { "application/json": { schema: ErrorSchema } } },
    // #3140 — static-bot reachability round-trip to the platform failed
    // (`upstream_error`): the bot couldn't confirm the routing identifier.
    502: { description: "Static-bot upstream verification unreachable (`upstream_error`)", content: { "application/json": { schema: ErrorSchema } } },
    // #3140 — the chat-integration count couldn't be determined (transient DB
    // fault), so the cap check failed closed: `billing_check_failed` "try again"
    // (raised by `confirmInstall`'s cap gate, same migration note as 429).
    503: { description: "Billing/plan-limit check unavailable for a static-bot install: `billing_check_failed`", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const callbackRoute = createRoute({
  method: "get",
  path: "/{platform}/callback",
  tags: ["Integrations"],
  summary: "Platform OAuth callback",
  description:
    "Handles the OAuth callback from the Platform: verifies the state token, exchanges the " +
    "code for credentials, and writes the install record + per-Platform credential. Returns " +
    "a 302 to /admin/integrations on success. " +
    "GitHub App installs deliver `installation_id` instead of `code` — the route accepts " +
    "either and forwards whichever is present to the handler.",
  request: {
    params: z.object({
      platform: z.string().openapi({ description: "Catalog slug" }),
    }),
    query: z.object({
      code: z
        .string()
        .optional()
        .openapi({ description: "OAuth authorization code (standard OAuth 2.0 flows)" }),
      installation_id: z
        .string()
        .optional()
        .openapi({ description: "GitHub App installation id (GitHub App install flow)" }),
      state: z.string().openapi({ description: "Signed state token from install" }),
    }),
  },
  responses: {
    302: {
      description:
        "Install complete or failed in a recoverable way — redirected to /admin/integrations. " +
        "Success: `?installed=<platform>`. Credential write missed: `?reconnect=<platform>`. " +
        "Hard failure (browser caller): `?error=<platform>&reason=<code>` (chat-integration cap reached → " +
        "`reason=plan_limit_reached`). JSON callers receive 400/429/502/503 instead.",
    },
    400: { description: "Invalid or expired state, or unknown platform (JSON-Accept caller)", content: { "application/json": { schema: ErrorSchema } } },
    403: {
      description:
        "Workspace plan changed mid-OAuth and no longer admits this " +
        "integration (JSON callers; browsers see a 302 to the admin UI). " +
        "Body follows the PlanUpgradeRequiredBody shape with PlanTier-typed " +
        "`required_plan` + `current_plan` fields.",
      content: {
        "application/json": {
          schema: z.union([PlanUpgradeRequiredBodySchema, AuthErrorSchema]),
        },
      },
    },
    404: { description: "Platform not found in catalog", content: { "application/json": { schema: ErrorSchema } } },
    // #2953 — workspace at its plan's chat-integration cap (JSON callers;
    // browsers get a 302 to the admin UI with `reason=plan_limit_reached`).
    // `plan_limit_exceeded` body carries the `limit` that was hit.
    429: {
      description: "Chat-integration cap reached for the workspace's plan tier: `plan_limit_exceeded` (JSON-Accept caller)",
      content: { "application/json": { schema: ErrorSchema.extend({ limit: z.number() }) } },
    },
    501: { description: "OAuth handler not registered", content: { "application/json": { schema: ErrorSchema } } },
    502: { description: "Upstream Platform rejected the OAuth exchange (JSON-Accept caller)", content: { "application/json": { schema: ErrorSchema } } },
    // #2953 — the chat-integration count couldn't be determined (transient DB
    // fault), so the cap check failed closed: `billing_check_failed` "try again".
    503: {
      description: "Billing/plan-limit check unavailable: `billing_check_failed` (JSON-Accept caller)",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const disconnectRoute = createRoute({
  method: "delete",
  path: "/{platform}",
  tags: ["Integrations"],
  summary: "Disconnect a Platform install",
  description:
    "Removes a Platform install for the caller's workspace. Two-store teardown per " +
    "ADR-0003: the per-Platform credential row in `chat_cache` is deleted BEFORE the " +
    "`workspace_plugins` install record so credentials never outlive the install record. " +
    "Requires an authenticated workspace admin.",
  request: {
    params: z.object({
      platform: z.string().openapi({ description: "Catalog slug (e.g. 'slack')" }),
    }),
  },
  responses: {
    200: {
      description: "Disconnect complete",
      content: { "application/json": { schema: z.object({ message: z.string() }) } },
    },
    400: { description: "Caller has no workspace binding", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Not authenticated", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Caller is not a workspace admin, or MFA enrollment required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Platform not found in catalog, or no install for this workspace", content: { "application/json": { schema: ErrorSchema } } },
    421: { description: "Misdirected request (strict region routing)", content: { "application/json": { schema: AuthErrorSchema } } },
    429: { description: "Rate limited", content: { "application/json": { schema: AuthErrorSchema } } },
    // 500 covers both paths: explicit preamble auth-dispatch failure
    // (`{ error, message, requestId }`) AND runHandler's classifyError
    // mapping of an unexpected teardown error (same shape). AuthErrorSchema
    // is permissive enough to cover both — ErrorSchema would force a TS
    // mismatch on the preamble shape's wider Record<string, unknown>.
    500: { description: "Internal error (auth dispatch or teardown)", content: { "application/json": { schema: AuthErrorSchema } } },
    501: { description: "Disconnect not implemented for this Platform", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface CatalogRowFromDb extends Record<string, unknown> {
  readonly slug: string;
  readonly install_model: string;
  readonly enabled: boolean;
  readonly min_plan: string;
  /**
   * The catalog row's `config_schema` JSONB. Carried on the lookup so the
   * static-bot install branch can resolve which declared field is the routing
   * identifier (#3140) without a second query. `null` / absent for rows that
   * declare no schema; the OAuth + form branches ignore it.
   */
  readonly config_schema?: unknown;
  /**
   * `implementation_status` — `'available'` once a platform's slice has
   * shipped, `'coming_soon'` until then. The static-bot branch refuses
   * `coming_soon` rows (#3140): the four form-shaped platforms stay
   * `coming_soon` until their slices (#3141–#3144) flip them on *and* migrate
   * their `confirmInstall` onto the cap gate, so gating here keeps the spine
   * from ever reaching a not-yet-cap-gated handler.
   */
  readonly implementation_status?: string;
}

/**
 * The OAuth callback's realistic caller is a browser — the platform
 * authorize page redirects with a `<meta>`-driven 302. We want hard
 * failures (invalid state, upstream-non-OK) to land on the admin UI with
 * an actionable toast, not on a raw JSON page.
 *
 * Heuristic: if the `Accept` header includes `text/html` (the browser
 * default), redirect to `/admin/integrations?error=:platform&reason=:code`.
 * Otherwise keep the JSON response so curl-based debugging still sees the
 * machine-readable error. Browsers don't send `application/json` on a
 * top-level navigation, so this split is stable.
 */
function prefersHtml(req: Request): boolean {
  const accept = req.headers.get("accept") ?? "";
  return accept.includes("text/html");
}

/**
 * Per-platform admin destination for browser-facing redirects after the
 * OAuth dance (success, reconnect, plan_upgrade_required, invalid_state,
 * upstream_error). Most platforms render on `/admin/integrations`, but
 * datasource-pillar installs render on `/admin/connections`:
 *   - Salesforce moved there in #2745, and
 *   - every built-in REST data candidate (stripe-data form, github-data
 *     oauth-datasource — #3028/#3030) is a `pillar='datasource'` card on
 *     that page.
 * Sending their callbacks to `/admin/integrations` would land users on a
 * screen that doesn't list the card they just connected. Add new
 * exceptions here when a future non-datasource platform follows the
 * Salesforce pattern (Jira, etc.).
 */
function adminDestinationForPlatform(platform: string): string {
  if (platform === "salesforce") return "/admin/connections";
  // A built-in REST data candidate (e.g. github-data) is a datasource card.
  if (findDataCandidateBySlug(platform) !== undefined) return "/admin/connections";
  return "/admin/integrations";
}

function buildPlatformAdminUrl(
  param: "installed" | "reconnect" | "error",
  platform: string,
  extra?: Record<string, string>,
): string {
  const webOrigin = getWebOrigin();
  const path = adminDestinationForPlatform(platform);
  const base = webOrigin ? `${webOrigin}${path}` : path;
  const qs = new URLSearchParams({ [param]: platform, ...extra });
  return `${base}?${qs.toString()}`;
}

/**
 * Look up an *installable* catalog row by slug. Returns `null` when the
 * row doesn't exist, has been disabled by ops (`enabled = false`), or
 * carries an unknown `install_model` (the CHECK constraint normally
 * prevents the latter, but a planner-friendly assert keeps the route
 * safe against a future schema relaxation).
 *
 * The `enabled = true` predicate is load-bearing: ops can flip a row to
 * disabled in the DB without a deploy (see ADR-0002 S3 — the seeder
 * preserves DB-side `enabled=false`). Without this gate, a disabled
 * platform could still be installed by hitting the URL directly,
 * defeating the kill switch.
 */
async function getInstallableCatalogRowBySlug(slug: string): Promise<{
  slug: string;
  install_model: CatalogInstallModel;
  min_plan: string;
  config_schema: unknown;
  implementation_status: string | null;
} | null> {
  const rows = await internalQuery<CatalogRowFromDb>(
    `SELECT slug, install_model, enabled, min_plan, config_schema, implementation_status
       FROM plugin_catalog
      WHERE slug = $1 AND enabled = true
      LIMIT 1`,
    [slug],
  );
  if (rows.length === 0) return null;
  const row = rows[0];
  if (
    row.install_model !== "oauth" &&
    row.install_model !== "form" &&
    row.install_model !== "static-bot" &&
    row.install_model !== "oauth-datasource"
  ) {
    log.warn({ slug, install_model: row.install_model }, "Unknown install_model in plugin_catalog row");
    return null;
  }
  return {
    slug: row.slug,
    install_model: row.install_model as CatalogInstallModel,
    min_plan: row.min_plan,
    config_schema: row.config_schema ?? null,
    implementation_status: row.implementation_status ?? null,
  };
}

/**
 * Resolve `{ planTier, isOperator }` for a workspace from the
 * `organization` table. `planTier` is narrowed via {@link parsePlanTier}
 * at the SQL boundary so downstream gates see `PlanTier | null` rather
 * than a raw string — a legacy / unknown value maps to `null` and
 * callers treat `null` as "no plan / not an operator", which by
 * construction denies any `min_plan != 'free'` install attempt without
 * admitting the operator bypass.
 *
 * On a self-hosted no-auth deploy (sentinel `workspaceId =
 * "self-hosted"`), there's no organization row at all. The function
 * returns `{ planTier: null, isOperator: false }` and the same fail-
 * closed default applies — `null` collapses to `"free"` in the
 * response body only when the caller builds an upgrade prompt.
 */
async function getWorkspaceEntitlement(orgId: string): Promise<{
  planTier: PlanTier | null;
  isOperator: boolean;
}> {
  if (orgId === "self-hosted") return { planTier: null, isOperator: false };
  const rows = await internalQuery<{
    plan_tier: string | null;
    is_operator_workspace: boolean | null;
  }>(
    `SELECT plan_tier, is_operator_workspace
       FROM organization
      WHERE id = $1
      LIMIT 1`,
    [orgId],
  );
  if (rows.length === 0) return { planTier: null, isOperator: false };
  return {
    planTier: parsePlanTier(rows[0]?.plan_tier),
    isOperator: rows[0]?.is_operator_workspace === true,
  };
}

/** Discriminated result of {@link checkPlanEligibility}. */
type PlanCheckResult =
  | { readonly kind: "admit" }
  | {
      readonly kind: "deny";
      readonly required_plan: PlanTier;
      readonly current_plan: PlanTier;
    }
  | { readonly kind: "catalog_drift"; readonly rawMinPlan: string };

/**
 * Plan-tier gate for the install endpoints. Returns a discriminated
 * result so the caller can route catalog drift (unknown `min_plan`)
 * to a structured 501 rather than masquerading as an upgrade prompt
 * with a bogus tier name.
 *
 *  - `admit`: workspace's plan admits the install (or operator bypass).
 *  - `deny`: plan ranks below `min_plan`; surface as 403
 *    {@link PlanUpgradeRequiredBody} — both plan fields are
 *    {@link PlanTier}.
 *  - `catalog_drift`: catalog row's `min_plan` is not a recognized
 *    plan tier (legacy tier values dropped by an earlier migration,
 *    operator typo in a seed). Caller propagates as a structured 501
 *    `handler_unavailable` with the raw value logged so an operator
 *    can fix the row. The earlier "403 with the bogus name in the
 *    body" path confused customers (the bogus tier isn't buyable)
 *    and the operator only saw it via the 403 log line.
 *
 * Unknown `planTier` values (legacy / NULL row) collapse to `"free"`
 * for the response body so the user sees an actionable current_plan.
 * The gate itself fails closed via {@link isPlanEligible}.
 */
function checkPlanEligibility(
  entitlement: { planTier: PlanTier | null; isOperator: boolean },
  catalogMinPlan: string,
): PlanCheckResult {
  if (entitlement.isOperator) return { kind: "admit" };
  const requiredPlan = parsePlanTier(catalogMinPlan);
  if (requiredPlan === null) {
    return { kind: "catalog_drift", rawMinPlan: catalogMinPlan };
  }
  if (isPlanEligible(entitlement.planTier, requiredPlan)) {
    return { kind: "admit" };
  }
  return {
    kind: "deny",
    required_plan: requiredPlan,
    current_plan: entitlement.planTier ?? "free",
  };
}

/**
 * Compose the 403 {@link PlanUpgradeRequiredBody} from a denied
 * {@link checkPlanEligibility} result. Centralized here so every
 * route emits the same message string and field ordering.
 */
function buildPlanUpgradeBody(
  platform: string,
  deny: Extract<PlanCheckResult, { kind: "deny" }>,
  requestId: string,
): PlanUpgradeRequiredBody {
  return {
    error: "plan_upgrade_required",
    message: `Installing ${platform} requires the "${deny.required_plan}" plan. Your workspace is on the "${deny.current_plan}" plan.`,
    required_plan: deny.required_plan,
    current_plan: deny.current_plan,
    requestId,
  };
}

/**
 * Resolve the routing-identifier field key from a catalog row's
 * `config_schema` (#3140 — static-bot install spine).
 *
 * A static-bot install captures one routing identifier the admin types into a
 * form (Telegram `chat_id`, Teams `tenant_id`, Google Chat `workspace_id`,
 * WhatsApp `phone_number_id`) plus optional label fields. The convention,
 * consistent across all four catalog rows, is that the routing identifier is
 * the **first `required` string field** in `config_schema`; every other field
 * is an optional label forwarded to the handler as `extras` (the handler
 * extracts its own known keys and drops the rest, per the
 * `StaticBotInstallHandler` contract). Resolving this server-side keeps the
 * routing-id semantics in one place and lets the admin form stay a generic
 * flat config-field submit.
 *
 * `config_schema` is `unknown` on the wire, so narrow defensively. Returns the
 * field key, or `null` when no required string field exists (a catalog
 * mis-seed — the caller surfaces a structured 501 so an operator can fix the
 * row rather than persisting an install with an empty routing id).
 */
function resolveStaticBotRoutingKey(configSchema: unknown): string | null {
  if (!Array.isArray(configSchema)) return null;
  for (const field of configSchema) {
    if (!field || typeof field !== "object") continue;
    const f = field as Record<string, unknown>;
    if (typeof f.key === "string" && f.key.length > 0 && f.type === "string" && f.required === true) {
      return f.key;
    }
  }
  return null;
}

/**
 * The set of field keys a catalog row's `config_schema` declares (#3140). Used
 * to whitelist the `extras` a static-bot install forwards to `confirmInstall`
 * so an undeclared body key can't reach persistence — defense-in-depth over the
 * handler's own key extraction. Narrows the `unknown` schema defensively.
 */
function staticBotDeclaredKeys(configSchema: unknown): ReadonlySet<string> {
  const keys = new Set<string>();
  if (!Array.isArray(configSchema)) return keys;
  for (const field of configSchema) {
    if (!field || typeof field !== "object") continue;
    const key = (field as Record<string, unknown>).key;
    if (typeof key === "string" && key.length > 0) keys.add(key);
  }
  return keys;
}


// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

integrations.openapi(installRoute, async (c) =>
  runHandler(c, "platform install", async () => {
    const { platform } = c.req.valid("param");

    // ── Admin auth ────────────────────────────────────────────────
    const requestId = crypto.randomUUID();
    const preamble = await adminAuthPreamble(c.req.raw, requestId);
    if ("error" in preamble) {
      return c.json(preamble.error, preamble.status, preamble.headers);
    }

    // Org id is the WorkspaceId for the install row.
    //
    // F-04 fail-closed under SaaS: if auth mode is "none" (no-auth) AND
    // the deploy is SaaS, refuse outright. SaaS pins managed auth in
    // config, so a mode=none branch here means auth middleware
    // regressed or is misconfigured. Allowing an OAuth dance to land
    // with a shared sentinel workspaceId would write tenant-shared
    // install + credential rows — the exact install-hijack the legacy
    // route's SaaS-mode guard prevented. Self-hosted no-auth keeps the
    // sentinel branch for single-tenant dev.
    const deployMode = getConfig()?.deployMode;
    const orgIdRaw = preamble.authResult.user?.activeOrganizationId ?? undefined;
    if (preamble.authResult.mode === "none" && deployMode === "saas") {
      log.warn({ deployMode }, "Refusing install: SaaS deploy with mode=none is a misconfig");
      return c.json(
        { error: "missing_org_binding", message: "Install must be initiated by an authenticated workspace admin.", requestId },
        400,
      );
    }
    if (!orgIdRaw && preamble.authResult.mode !== "none") {
      return c.json({ error: "missing_org_binding", message: "Install must be initiated by an authenticated workspace admin.", requestId }, 400);
    }
    // For "none" mode (self-hosted no-auth dev only — SaaS branch
    // refused above), use a sentinel workspace id so the slice 4
    // state-token mint succeeds. Anyone running self-hosted-no-auth is
    // a single-tenant install; the install row's workspace_id only
    // needs to be stable for the dual-store join.
    const workspaceId = (orgIdRaw ?? "self-hosted") as WorkspaceId;

    // ── Catalog lookup ────────────────────────────────────────────
    const row = await getInstallableCatalogRowBySlug(platform);
    if (!row) {
      return c.json({ error: "not_found", message: `Unknown platform "${platform}"`, requestId }, 404);
    }
    // `oauth-datasource` (github-data, #3030) shares this OAuth install/callback
    // route — the HTTP dance is identical; only the handler's persistence differs.
    if (row.install_model !== "oauth" && row.install_model !== "oauth-datasource") {
      return c.json(
        { error: "wrong_install_model", message: `Platform "${platform}" uses install_model "${row.install_model}" — not OAuth-installable via this route.`, requestId },
        400,
      );
    }

    // ── Plan-tier gate (#2701) ────────────────────────────────────
    // Browser callers expect a redirect-driven UX (clicking Connect on a
    // locked card already routes through the UI, but a direct deep-link
    // or stale-state click must land somewhere sensible). Send browsers
    // back to /admin/integrations with the same reason code the catalog
    // upsell banner reads. JSON callers receive the structured 403.
    if (orgIdRaw) {
      const entitlement = await getWorkspaceEntitlement(orgIdRaw);
      const planCheck = checkPlanEligibility(entitlement, row.min_plan);
      if (planCheck.kind === "catalog_drift") {
        log.error(
          { workspaceId, platform, rawMinPlan: planCheck.rawMinPlan },
          "Install denied: plugin_catalog.min_plan is not a recognized plan tier — operator must fix the catalog row",
        );
        return c.json(
          {
            error: "handler_unavailable",
            message: `Internal configuration error for "${platform}". Contact your administrator.`,
            requestId,
          },
          501,
        );
      }
      if (planCheck.kind === "deny") {
        log.info(
          {
            workspaceId,
            platform,
            requiredPlan: planCheck.required_plan,
            currentPlan: planCheck.current_plan,
          },
          "Install denied: workspace plan does not admit this integration",
        );
        if (prefersHtml(c.req.raw)) {
          return c.redirect(
            buildPlatformAdminUrl("error", platform, {
              reason: "plan_upgrade_required",
              required_plan: planCheck.required_plan,
            }),
          );
        }
        return c.json(
          buildPlanUpgradeBody(platform, planCheck, requestId),
          403,
        );
      }
    }

    // ── Dispatch + start install ──────────────────────────────────
    let handler: ReturnType<typeof getInstallHandler>;
    try {
      handler = getInstallHandler(row);
    } catch (err) {
      log.warn(
        { platform, err: err instanceof Error ? err.message : String(err) },
        "No install handler registered for platform — operator must wire the handler",
      );
      return c.json(
        { error: "handler_unavailable", message: `OAuth handler for "${platform}" is not registered on this deploy.`, requestId },
        501,
      );
    }
    if (handler.kind !== "oauth" && handler.kind !== "oauth-datasource") {
      // Catalog said OAuth(-datasource), dispatch returned a different handler —
      // a config drift; treat as 500-equivalent for the route's invariants.
      log.error({ platform, kind: handler.kind }, "Catalog install_model is OAuth-shaped but dispatch returned a non-OAuth handler");
      return c.json({ error: "handler_unavailable", message: "Install handler misconfigured.", requestId }, 501);
    }

    // ── Pre-redirect chat-integration cap gate (#2998) ────────────
    // Slack's `startInstall` runs a read-only chat-integration cap precheck
    // before minting the authorize URL, so an at-cap workspace is refused
    // BEFORE Slack mints a bot token / installs the app — it no longer
    // completes the whole dance only to be turned away at the callback. The
    // callback's atomic gate stays in place as the TOCTOU guard. We translate
    // the cap/billing tagged errors the same way the callback handler does
    // (`startInstall` exchanges no code, so unlike the callback it has no
    // `PlatformOAuthExchangeError`/`upstream_error` arm):
    //   - ChatIntegrationLimitError → browser: 302 to the admin UI with
    //     `reason=plan_limit_reached`; JSON callers fall through to the 429
    //     `plan_limit_exceeded` mapping in runHandler.
    //   - BillingCheckFailedError (count couldn't be read) → left to the 503
    //     `billing_check_failed` mapper: a transient "try again", not an
    //     upgrade prompt, for browser and JSON callers alike.
    // Handlers that don't run a chat-cap precheck never throw
    // ChatIntegrationLimitError here, so this catch is inert for them and just
    // re-throws — every other error propagates unchanged to runHandler.
    let redirectUrl: string;
    try {
      ({ redirectUrl } = await handler.startInstall(workspaceId));
    } catch (err) {
      if (err instanceof ChatIntegrationLimitError) {
        log.info(
          { platform, workspaceId: err.workspaceId, limit: err.limit },
          "Install blocked pre-redirect — workspace at chat-integration cap",
        );
        if (prefersHtml(c.req.raw)) {
          return c.redirect(buildPlatformAdminUrl("error", platform, { reason: "plan_limit_reached" }));
        }
      }
      throw err;
    }
    return c.redirect(redirectUrl);
  }),
);

integrations.openapi(installFormRoute, async (c) =>
  runHandler(c, "platform install-form", async () => {
    const { platform } = c.req.valid("param");
    const formData = c.req.valid("json");

    // ── Admin auth ────────────────────────────────────────────────
    // `requireAdminAuth` throws an HTTPException carrying the
    // pre-built JSON response on failure, so the four auth-preamble
    // failure modes (401 unauthenticated / 403 forbidden / 429 rate
    // limited / 500 auth system fault) flow out directly and don't
    // pollute this handler's declared response union — without that
    // narrowing, the @hono/zod-openapi route signature rejects the
    // `c.json(preamble.error, preamble.status)` return because no
    // single declared status matches the four-way union.
    const requestId = crypto.randomUUID();
    const preamble = await adminAuthPreamble(c.req.raw, requestId);
    requireAdminAuth(preamble);

    // F-04 same posture as the OAuth install branch: SaaS mode=none is
    // refused outright because it would write the workspace_plugins
    // row under a tenant-shared sentinel workspaceId — leaking creds
    // across customers. Self-hosted no-auth still gets the sentinel
    // (single-tenant dev). The OAuth branch's docblock covers the
    // full rationale; this is the form-based mirror.
    const deployMode = getConfig()?.deployMode;
    const orgIdRaw = preamble.authResult.user?.activeOrganizationId ?? undefined;
    if (preamble.authResult.mode === "none" && deployMode === "saas") {
      log.warn({ deployMode }, "Refusing form install: SaaS deploy with mode=none is a misconfig");
      return c.json(
        { error: "missing_org_binding", message: "Install must be initiated by an authenticated workspace admin.", requestId },
        400,
      );
    }
    if (!orgIdRaw && preamble.authResult.mode !== "none") {
      return c.json(
        { error: "missing_org_binding", message: "Install must be initiated by an authenticated workspace admin.", requestId },
        400,
      );
    }
    const workspaceId = (orgIdRaw ?? "self-hosted") as WorkspaceId;

    // ── Catalog lookup + dispatch ─────────────────────────────────
    const row = await getInstallableCatalogRowBySlug(platform);
    if (!row) {
      return c.json({ error: "not_found", message: `Unknown platform "${platform}"`, requestId }, 404);
    }
    if (row.install_model !== "form" && row.install_model !== "static-bot") {
      // A caller hitting `/install-form` on an OAuth(-datasource) catalog
      // row is either a UI bug (modal opened for the wrong card) or an
      // attacker probing endpoints. Logging the rejection surfaces both.
      // Mirrors the install + callback handlers' similar `log.warn`
      // patterns. `form` (#2660) and `static-bot` (#3140) — both non-OAuth
      // install submits — are the two accepted models here.
      log.warn(
        { platform, install_model: row.install_model },
        "Refused install-form: platform's install_model is neither 'form' nor 'static-bot'",
      );
      return c.json(
        { error: "wrong_install_model", message: `Platform "${platform}" uses install_model "${row.install_model}" — not installable via this route (OAuth platforms use /install).`, requestId },
        400,
      );
    }

    // ── Plan-tier gate (#2701) ────────────────────────────────────
    // Ordered BEFORE handler dispatch to match the /install branch — a
    // workspace below the catalog row's plan should see 403
    // plan_upgrade_required even when the operator hasn't wired the
    // form handler (which would otherwise 501). Avoids the "501 on
    // Pro plan, 403 on Free plan, for the same unconfigured platform"
    // contract divergence the /install branch already avoids.
    //
    // POST callers (admin UI form submit) get the structured 403
    // body — no redirect path because the UI's `useAdminMutation`
    // already routes 403 responses to the upgrade toast.
    if (orgIdRaw) {
      const entitlement = await getWorkspaceEntitlement(orgIdRaw);
      const planCheck = checkPlanEligibility(entitlement, row.min_plan);
      if (planCheck.kind === "catalog_drift") {
        log.error(
          { workspaceId, platform, rawMinPlan: planCheck.rawMinPlan },
          "Form install denied: plugin_catalog.min_plan is not a recognized plan tier — operator must fix the catalog row",
        );
        return c.json(
          {
            error: "handler_unavailable",
            message: `Internal configuration error for "${platform}". Contact your administrator.`,
            requestId,
          },
          501,
        );
      }
      if (planCheck.kind === "deny") {
        log.info(
          {
            workspaceId,
            platform,
            requiredPlan: planCheck.required_plan,
            currentPlan: planCheck.current_plan,
          },
          "Form install denied: workspace plan does not admit this integration",
        );
        return c.json(
          buildPlanUpgradeBody(platform, planCheck, requestId),
          403,
        );
      }
    }

    let handler: ReturnType<typeof getInstallHandler>;
    try {
      handler = getInstallHandler(row);
    } catch (err) {
      log.warn(
        { platform, install_model: row.install_model, err: err instanceof Error ? err.message : String(err) },
        "No install handler registered for platform — operator must wire the handler",
      );
      return c.json(
        { error: "handler_unavailable", message: `Install handler for "${platform}" is not registered on this deploy.`, requestId },
        501,
      );
    }

    // ── Persist — branch on the catalog install model ─────────────
    // The model check above admitted only `form` and `static-bot`.
    // `getInstallHandler` dispatches by `install_model`, so a handler.kind
    // that disagrees is a registration typo (a wrong-kind handler in the
    // right registry) — surface it as a 501 rather than calling the wrong
    // method.
    if (row.install_model === "form") {
      if (handler.kind !== "form") {
        log.error({ platform, kind: handler.kind }, "Catalog install_model='form' but dispatch returned non-form handler");
        return c.json({ error: "handler_unavailable", message: "Install handler misconfigured.", requestId }, 501);
      }
      try {
        const { installRecord } = await handler.validateConfig(workspaceId, formData);
        log.info({ workspaceId, platform, installId: installRecord.id }, "Form-based install completed");
        return c.json({ installed: true as const, platform, installId: installRecord.id }, 200);
      } catch (err) {
        // Tagged validation errors → 400 with field-level detail so the
        // UI modal can highlight the wrong inputs. Every other throw
        // bubbles up to `runHandler`'s `classifyError` for the standard
        // 5xx-with-requestId path.
        if (err instanceof FormInstallValidationError) {
          // `fieldErrors` is `Readonly<Record<string, readonly string[]>>`
          // — Hono's JSON serializer accepts it, but cast back to plain
          // arrays at the response boundary so OpenAPI schema clients
          // see a regular `string[]`.
          const fieldErrors: Record<string, string[]> = {};
          for (const [k, v] of Object.entries(err.fieldErrors)) fieldErrors[k] = [...v];
          return c.json(
            {
              error: "invalid_form_data",
              message: "One or more fields failed validation.",
              requestId,
              fieldErrors,
              ...(err.formErrors.length > 0 ? { formErrors: [...err.formErrors] } : {}),
            },
            400,
          );
        }
        throw err;
      }
    }

    // ── static-bot routing-identifier install (#3140) ─────────────
    if (handler.kind !== "static-bot") {
      log.error({ platform, kind: handler.kind }, "Catalog install_model='static-bot' but dispatch returned non-static-bot handler");
      return c.json({ error: "handler_unavailable", message: "Install handler misconfigured.", requestId }, 501);
    }

    // Spine gate: only install static-bots a slice has marked `available`.
    // The four form-shaped platforms stay `coming_soon` until #3141–#3144 ship
    // them — and those slices are what migrate each handler's `confirmInstall`
    // onto the cap gate (`checkChatIntegrationLimitAndInstall`). Refusing
    // `coming_soon` here keeps this generic route from ever reaching a handler
    // that persists its install WITHOUT the cap gate (Telegram/Teams/gchat/
    // WhatsApp `confirmInstall` is a bare UPSERT today — only Discord and Slack
    // run the gate). So the spine is intentionally dormant for real platforms;
    // a registered fixture proves the path end-to-end in tests.
    if (row.implementation_status === "coming_soon") {
      log.info(
        { platform },
        "Refused static-bot install: platform is coming_soon (slice not shipped — see #3141–#3144)",
      );
      return c.json(
        {
          error: "platform_not_available",
          message: `Platform "${platform}" is not available for install yet.`,
          requestId,
        },
        409,
      );
    }

    // OAuth-shaped static-bots (Discord) capture their routing identifier
    // through an OAuth bot-install redirect that proves the admin's workspace
    // controls the target server. Accepting a directly-typed routing id here
    // would skip that ownership proof (`confirmInstall` verifies the bot is
    // reachable, not that the caller owns it), so refuse and point at the
    // dedicated OAuth endpoint. Keyed on the explicit `oauthShaped` flag, NOT
    // on `applicationId` — Teams/WhatsApp populate `applicationId` for their
    // manifest/parity URLs while remaining form-shaped (#3140 review).
    if (handler.oauthShaped) {
      log.warn(
        { platform },
        "Refused static-bot form install: platform is OAuth-shaped (use its OAuth install endpoint)",
      );
      return c.json(
        {
          error: "oauth_shaped_static_bot",
          message: `Platform "${platform}" captures its routing identifier through an OAuth bot-install flow — install it via its OAuth endpoint, not the form route.`,
          requestId,
        },
        400,
      );
    }

    // The routing identifier is the first `required` string field declared in
    // the catalog `config_schema` (chat_id / tenant_id / workspace_id /
    // phone_number_id). A row with no such field is an operator mis-seed —
    // surface a 501 rather than persisting an install with an empty routing id.
    const routingKey = resolveStaticBotRoutingKey(row.config_schema);
    if (!routingKey) {
      log.error(
        { platform },
        "static-bot catalog row declares no required routing-identifier field in config_schema — operator must fix the row",
      );
      return c.json(
        { error: "handler_unavailable", message: `Internal configuration error for "${platform}". Contact your administrator.`, requestId },
        501,
      );
    }
    const rawRouting = formData[routingKey];
    if (typeof rawRouting !== "string" || rawRouting.trim().length === 0) {
      return c.json(
        {
          error: "missing_routing_identifier",
          message: `Install for "${platform}" requires a non-empty "${routingKey}".`,
          requestId,
        },
        400,
      );
    }
    // Trim surrounding whitespace — a form input can carry copy-paste padding
    // that the handler's anchored format regex would otherwise reject.
    const routingIdentifier = rawRouting.trim();
    // Forward only the catalog-declared fields (minus the routing id) as extras,
    // built from `config_schema` rather than cloned from the raw body. The
    // handler already drops keys it doesn't know, but whitelisting here keeps
    // an undeclared JSON key from ever reaching `confirmInstall` — so a handler
    // that persists `extras` can't write schema-foreign data into
    // workspace_plugins.config (#3148 review).
    const declaredKeys = staticBotDeclaredKeys(row.config_schema);
    const extras: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(formData)) {
      if (key !== routingKey && declaredKeys.has(key)) extras[key] = value;
    }

    // `confirmInstall` validates the routing id, round-trips the platform for
    // reachability, and upserts the workspace_plugins(pillar='chat') row. Its
    // tagged failures all map through `runHandler`'s `classifyError`, so no
    // explicit catch is needed — routing-id-invalid / reachability → 400,
    // upstream unreachable → 502, and (once a handler is migrated onto
    // `checkChatIntegrationLimitAndInstall`) at-cap → 429 `plan_limit_exceeded`
    // / count-check-failed → 503 `billing_check_failed`, with reconnect
    // grandfathered inside the gate.
    //
    // The cap gate lives INSIDE `confirmInstall` (the single advisory-locked
    // insert path), not here: Discord and Slack run it today; the four
    // form-shaped static-bots adopt it in #3141–#3144. The `coming_soon` gate
    // above guarantees this route only reaches a handler once its slice has
    // shipped that migration, so the 429/503 paths are live exactly when the
    // platform is installable.
    const { installRecord } = await handler.confirmInstall(workspaceId, routingIdentifier, undefined, extras);
    log.info({ workspaceId, platform, installId: installRecord.id }, "Static-bot install completed");
    return c.json({ installed: true as const, platform, installId: installRecord.id }, 200);
  }),
);

integrations.openapi(callbackRoute, async (c) =>
  runHandler(c, "platform callback", async () => {
    const { platform } = c.req.valid("param");
    const { code, installation_id: installationId, state } = c.req.valid("query");
    const requestId = crypto.randomUUID();

    // GitHub App installs deliver `installation_id`; standard OAuth 2.0
    // flows deliver `code`. The credential identifier the per-Platform
    // handler consumes is one or the other — never both in practice.
    //
    // **Platform-scoped acceptance.** Only the two GitHub catalog rows
    // accept `installation_id`; sending it to any other Platform's
    // callback URL is unambiguously a tampered redirect (no upstream
    // OAuth provider for those platforms ever emits the field) and gets
    // a 400 here rather than being forwarded to the handler. Forwarding
    // an `installation_id` into Jira's / Salesforce's / Linear's
    // `handleCallback` would surface as a misleading "upstream OAuth
    // exchange refused" message — the platform-scoped reject is clearer
    // and matches the principle that the route knows the slug semantics
    // before the handler does.
    if (installationId !== undefined && !INSTALLATION_ID_PLATFORMS.has(platform)) {
      log.warn(
        { platform },
        "Callback received installation_id for a non-GitHub Platform — rejecting (tampered redirect)",
      );
      return c.json(
        {
          error: "unexpected_installation_id",
          message: `Platform "${platform}" does not use the GitHub App installation_id flow. Restart the install.`,
          requestId,
        },
        400,
      );
    }
    // Platform-aware callback dispatch:
    //   - `github` (multi-tenant) needs BOTH `code` (user OAuth, for
    //     installation-ownership verification) and `installation_id`
    //     (the credential identifier). The handler verifies ownership
    //     before persisting.
    //   - `github-single-tenant` needs `installation_id` (operator-
    //     baked; ignored by the handler in favor of the env value).
    //   - All other OAuth handlers consume `code` for the standard
    //     OAuth 2.0 code → token exchange.
    //
    // The route picks the first positional arg per platform; the
    // optional third `extras` arg carries `installation_id` for
    // GitHub multi-tenant. Other handlers ignore extras.
    let handlerPositionalCode: string;
    let handlerExtras: { installationId?: string } | undefined;
    if (platform === "github" || platform === "github-data") {
      // Multi-tenant GitHub App dance — `github` (action) and `github-data`
      // (datasource, #3030) are identical here: both need `code` (user OAuth, for
      // installation-ownership verification) + `installation_id` (the credential).
      if (typeof code !== "string" || code.length === 0) {
        return c.json(
          {
            error: "missing_credential_identifier",
            message:
              "GitHub App callback missing `code` — ensure the App has \"Request user authorization (OAuth) during installation\" enabled and restart.",
            requestId,
          },
          400,
        );
      }
      if (typeof installationId !== "string" || installationId.length === 0) {
        return c.json(
          {
            error: "missing_credential_identifier",
            message: "GitHub App callback missing `installation_id`.",
            requestId,
          },
          400,
        );
      }
      handlerPositionalCode = code;
      handlerExtras = { installationId };
    } else if (platform === "github-single-tenant") {
      if (typeof installationId !== "string" || installationId.length === 0) {
        return c.json(
          {
            error: "missing_credential_identifier",
            message: "GitHub single-tenant callback missing `installation_id`.",
            requestId,
          },
          400,
        );
      }
      handlerPositionalCode = installationId;
      handlerExtras = { installationId };
    } else {
      if (typeof code !== "string" || code.length === 0) {
        return c.json(
          {
            error: "missing_credential_identifier",
            message:
              "Callback is missing `code` — the upstream Platform did not deliver an OAuth credential.",
            requestId,
          },
          400,
        );
      }
      handlerPositionalCode = code;
      handlerExtras = undefined;
    }

    const row = await getInstallableCatalogRowBySlug(platform);
    if (!row) {
      return c.json({ error: "not_found", message: `Unknown platform "${platform}"`, requestId }, 404);
    }
    // `oauth-datasource` (github-data, #3030) shares this callback route.
    if (row.install_model !== "oauth" && row.install_model !== "oauth-datasource") {
      return c.json(
        { error: "wrong_install_model", message: `Platform "${platform}" uses install_model "${row.install_model}" — not OAuth-installable via this route.`, requestId },
        400,
      );
    }

    let handler: ReturnType<typeof getInstallHandler>;
    try {
      handler = getInstallHandler(row);
    } catch (err) {
      log.warn(
        { platform, err: err instanceof Error ? err.message : String(err) },
        "No install handler registered for platform",
      );
      return c.json(
        { error: "handler_unavailable", message: `OAuth handler for "${platform}" is not registered on this deploy.`, requestId },
        501,
      );
    }
    if (handler.kind !== "oauth" && handler.kind !== "oauth-datasource") {
      log.error({ platform, kind: handler.kind }, "Catalog install_model is OAuth-shaped but dispatch returned a non-OAuth handler");
      return c.json({ error: "handler_unavailable", message: "Install handler misconfigured.", requestId }, 501);
    }

    // ── Plan-tier gate (#2701, defensive) ──────────────────────────
    // The /install endpoint already plan-checked, but a downgrade
    // mid-OAuth would let an OAuth token land on a no-longer-eligible
    // workspace. Verify the state token first (no DB write, no
    // upstream call), extract the workspace binding, plan-check, then
    // delegate to the per-Platform `handleCallback`. The handler does
    // its own state verification, so we re-verify here only to read
    // the binding — the redundant work is a few microseconds of HMAC
    // and is fail-loud on tamper, which is the right posture for a
    // defensive gate.
    //
    // Browser callers get a redirect to the admin UI with the same
    // reason code the catalog upsell banner reads; JSON callers see
    // a structured 403.
    const verifiedState = verifyOAuthStateToken(state);
    if (verifiedState !== null) {
      // DB-blip handling here is asymmetric vs `/install` and
      // `/install-form`: if the entitlement read throws on those
      // routes, a 500 is fine — the user hasn't burned anything yet
      // and a retry is free. On `/callback` the upstream OAuth code
      // is single-use; a 500 here means the user retries OAuth with
      // an expired code and gets a confusing 502. Better to log the
      // DB error, skip the mid-OAuth defensive plan re-check, and
      // let the install land — the original `/install` already
      // plan-checked, so we're only exposed to the narrow race
      // window of "workspace downgraded between install and
      // callback". Treat that case the same as the broader
      // "downgraded after install" case the DELETE path explicitly
      // supports (#2701 — downgraded customers must still be able
      // to clean up).
      let entitlement: Awaited<ReturnType<typeof getWorkspaceEntitlement>> | undefined;
      try {
        entitlement = await getWorkspaceEntitlement(verifiedState.workspaceId);
      } catch (err) {
        log.warn(
          {
            workspaceId: verifiedState.workspaceId,
            platform,
            err: err instanceof Error ? err.message : String(err),
          },
          "OAuth callback plan re-check failed — skipping defensive check and letting install land (original /install already plan-checked)",
        );
      }
      const planCheck =
        entitlement === undefined
          ? ({ kind: "admit" } as const)
          : checkPlanEligibility(entitlement, row.min_plan);
      if (planCheck.kind === "catalog_drift") {
        log.error(
          {
            workspaceId: verifiedState.workspaceId,
            platform,
            rawMinPlan: planCheck.rawMinPlan,
          },
          "OAuth callback: plugin_catalog.min_plan is not a recognized plan tier — letting install land (original /install already plan-checked)",
        );
        // Original /install already plan-checked successfully — a
        // mid-OAuth catalog typo would be operator-introduced and must
        // not strand the single-use OAuth code on the customer. Skip
        // the defensive gate the same way the DB-blip path above does.
      }
      if (planCheck.kind === "deny") {
        log.info(
          {
            workspaceId: verifiedState.workspaceId,
            platform,
            requiredPlan: planCheck.required_plan,
            currentPlan: planCheck.current_plan,
          },
          "OAuth callback denied: workspace plan changed mid-OAuth — install not written",
        );
        if (prefersHtml(c.req.raw)) {
          return c.redirect(
            buildPlatformAdminUrl("error", platform, {
              reason: "plan_upgrade_required",
              required_plan: planCheck.required_plan,
            }),
          );
        }
        return c.json(
          buildPlanUpgradeBody(platform, planCheck, requestId),
          403,
        );
      }
    }
    // Note: a null `verifiedState` (forged / expired / tampered) is
    // intentionally left to the per-Platform handler to surface as
    // `invalid_state` — we don't duplicate that branch here.

    let result: Awaited<ReturnType<typeof handler.handleCallback>>;
    try {
      result = await handler.handleCallback(handlerPositionalCode, state, handlerExtras);
    } catch (err) {
      // ONLY `PlatformOAuthExchangeError` is a user-actionable
      // "the upstream Platform refused the code exchange" — those get
      // the browser redirect to a translated toast. Every other throw
      // (e.g. the workspace_plugins INSERT in slice 5's handler
      // failing, an unhandled DB error, a logic bug) must propagate
      // to `runHandler`'s tagged-error → HTTP mapping so the user
      // sees a real 5xx with a `requestId` for log correlation —
      // not a misleading "click Reconnect" toast on top of a server
      // fault. JSON callers always fall through to the standard
      // mapper.
      if (err instanceof PlatformOAuthExchangeError) {
        log.warn(
          { platform, err: err.message, upstreamError: err.upstreamError },
          "Install callback failed: upstream OAuth exchange refused",
        );
        if (prefersHtml(c.req.raw)) {
          return c.redirect(buildPlatformAdminUrl("error", platform, { reason: "upstream_error" }));
        }
      }
      // Workspace at its plan's chat-integration cap. Browser callers get
      // the friendly upgrade redirect (mirrors the min_plan deny path
      // above); JSON callers fall through to the 429 `plan_limit_exceeded`
      // mapping in runHandler. (A `BillingCheckFailedError` — count couldn't
      // be read — is intentionally left to the 503 JSON mapper: it's a
      // transient "try again", not an upgrade prompt.)
      if (err instanceof ChatIntegrationLimitError) {
        log.info(
          { platform, workspaceId: err.workspaceId, limit: err.limit },
          "Install callback blocked — workspace at chat-integration cap",
        );
        if (prefersHtml(c.req.raw)) {
          return c.redirect(buildPlatformAdminUrl("error", platform, { reason: "plan_limit_reached" }));
        }
      }
      throw err;
    }
    if (result === null) {
      // Forged / expired / tampered state. Log once at the handler
      // boundary so the operator sees the rate (a flood of these means
      // an attacker probing). Browser callers get a toast-friendly
      // redirect; JSON callers keep the 400.
      log.warn({ platform }, "Install callback rejected invalid state token");
      if (prefersHtml(c.req.raw)) {
        return c.redirect(buildPlatformAdminUrl("error", platform, { reason: "invalid_state" }));
      }
      const restartFrom = adminDestinationForPlatform(platform);
      return c.json(
        { error: "invalid_state", message: `Invalid or expired install state. Restart the install from ${restartFrom}.`, requestId },
        400,
      );
    }

    // Success — redirect to admin UI. Partial-failure (credential write
    // didn't land) flips the query param so the admin page shows a
    // Reconnect affordance per ADR-0003. Destination is per-platform
    // (`adminDestinationForPlatform`) — datasource-pillar installs
    // (Salesforce + the REST data candidates like github-data) live on
    // `/admin/connections`, chat/action platforms on `/admin/integrations`.
    const queryParam = result.credentialResult.written ? "installed" : "reconnect";
    return c.redirect(buildPlatformAdminUrl(queryParam, platform));
  }),
);

// ---------------------------------------------------------------------------
// DELETE /:platform — disconnect a Platform install
//
// Tears down a Platform install in two stores in the order mandated by
// ADR-0003 / ADR-0005:
//
//   1. Credential row — `chat_cache:<platform>:installation:<teamId>`
//      for Slack, or the `integration_credentials` row keyed by
//      (workspace_id, catalog_id) for lazy OAuth integrations
//      (Salesforce today; future Jira / etc.).
//   2. `workspace_plugins` row — install metadata.
//
// Order is load-bearing: the credential row MUST go first. If the
// workspace_plugins delete then fails the install row dangles, but
// the next event's downstream credential resolution misses on the
// already-cleared credential store and the listener / agent loop
// short-circuits with a clear "credential missing" signal (the
// WorkspaceInstallGate itself only joins the install + catalog +
// organization tables — it does NOT check credentials; the silent skip
// or explicit-error happens one step later in the per-event handler
// or the LazyPluginLoader builder). The workspace is safe either way.
// The reverse order opens the failure mode where the install row is
// gone but a credential is still resident with no admin-visible UI to
// reach it.
//
// Per-Platform credential teardown is dispatched by slug:
//   - `slack` → chat_cache (legacy two-store, ADR-0003)
//   - Anything in `INTEGRATION_CREDENTIALS_SLUGS` →
//     `integration_credentials` (lazy OAuth, ADR-0005)
//
// Other slugs surface 501 rather than a no-op so the admin sees a
// real error if they try.
// ---------------------------------------------------------------------------

/**
 * Disconnect-side variant of {@link getInstallableCatalogRowBySlug} — same
 * shape minus the `enabled = true` predicate. Disconnect must succeed even
 * when ops has kill-switched a Platform via `plugin_catalog.enabled = false`:
 * existing installs still need to be tearable down, otherwise the kill
 * switch strands credentials in `chat_cache` with no admin-visible UI.
 *
 * Returns the row's canonical `id` so callers can join against
 * `workspace_plugins.catalog_id` directly rather than synthesizing
 * `catalog:${slug}` (which is the seeder's convention but isn't a contract
 * the DB enforces).
 */
async function getCatalogRowBySlugForDisconnect(slug: string): Promise<{
  id: string;
  slug: string;
} | null> {
  const rows = await internalQuery<{ id: string; slug: string } & Record<string, unknown>>(
    `SELECT id, slug
       FROM plugin_catalog
      WHERE slug = $1
      LIMIT 1`,
    [slug],
  );
  if (rows.length === 0) return null;
  return { id: rows[0]!.id, slug: rows[0]!.slug };
}

// Per-Platform credential-store dispatch lives in
// `lib/effect/workspace-installer.ts` (`INTEGRATION_CREDENTIALS_SLUGS`
// + `deleteCredentialStoreForSlug`). The route layer only consults the
// imported set to decide whether disconnect is even wired (501 path
// below).

integrations.openapi(disconnectRoute, async (c) =>
  // No plan-tier gate here (#2701). A downgraded customer whose plan
  // no longer admits installing this integration must always retain
  // the ability to clean up credentials — the admin UI surfaces this
  // case as the "Configured but inactive — plan downgrade" banner +
  // working Disconnect button. Adding a plan check here would strand
  // credentials in `integration_credentials` / `chat_cache` with no
  // user-reachable cleanup path. Mirrors the install carve-out
  // documented in `apps/docs/content/docs/guides/integrations.mdx`
  // §"Plan tiers and integrations".
  runHandler(c, "platform disconnect", async () => {
    const { platform } = c.req.valid("param");
    const requestId = crypto.randomUUID();

    // ── Admin auth (same gate as install) ─────────────────────────
    const preamble = await adminAuthPreamble(c.req.raw, requestId);
    if ("error" in preamble) {
      return c.json(preamble.error, preamble.status, preamble.headers);
    }

    // ── MFA gate ──────────────────────────────────────────────────
    // The install endpoint sits in a sub-router that uses the leaner
    // `adminAuthPreamble` (which skips MFA), but DELETE is destructive
    // and the action is privileged enough that an admin without an
    // enrolled second factor shouldn't be able to tear down a tenant
    // install — mirrors the `mfaRequired` middleware applied by
    // `createAdminRouter` to every other admin write surface.
    if (shouldRequireMfaForAuthResult(preamble.authResult)) {
      log.info(
        { requestId, userId: preamble.authResult.user?.id, path: c.req.path },
        "mfa_gate.blocked",
      );
      return c.json(
        {
          error: MFA_ENROLLMENT_REQUIRED,
          message:
            "Two-factor authentication is required for admin accounts. Enroll an authenticator app or passkey to continue.",
          requestId,
        },
        403,
      );
    }

    // The disconnect endpoint can't fall back to a sentinel
    // workspaceId the way install does — without a real binding there
    // is no install row to find. Self-hosted no-auth dev still works
    // because the SaaS install used the same sentinel.
    const deployMode = getConfig()?.deployMode;
    const orgIdRaw = preamble.authResult.user?.activeOrganizationId ?? undefined;
    if (preamble.authResult.mode === "none" && deployMode === "saas") {
      log.warn({ deployMode }, "Refusing disconnect: SaaS deploy with mode=none is a misconfig");
      return c.json(
        { error: "missing_org_binding", message: "Disconnect must be initiated by an authenticated workspace admin.", requestId },
        400,
      );
    }
    if (!orgIdRaw && preamble.authResult.mode !== "none") {
      return c.json({ error: "missing_org_binding", message: "Disconnect must be initiated by an authenticated workspace admin.", requestId }, 400);
    }
    const workspaceId = (orgIdRaw ?? "self-hosted") as WorkspaceId;

    // ── Region misrouting check (strict-routing only) ─────────────
    // Same defense `adminAuth` runs on every admin write — without it
    // a request reaching the wrong region's API could tear down stores
    // in the wrong cell during a residency split-brain.
    if (orgIdRaw) {
      const misrouted = await detectMisrouting(orgIdRaw, requestId);
      if (misrouted && isStrictRoutingEnabled()) {
        // Omit `correctApiUrl` when the region-config didn't supply one —
        // Hono's JSON serializer rejects `undefined` values in typed
        // response bodies. The expectedRegion + actualRegion still give
        // the caller enough to act.
        const body: Record<string, unknown> = {
          error: "misdirected_request",
          message: `This request should be directed to the ${misrouted.expectedRegion} region API.`,
          expectedRegion: misrouted.expectedRegion,
          actualRegion: misrouted.actualRegion,
          requestId,
        };
        if (misrouted.correctApiUrl) body.correctApiUrl = misrouted.correctApiUrl;
        return c.json(body, 421);
      }
    }

    // ── Per-Platform disconnect-handler check ─────────────────────
    // The facade's `uninstall` is general but the route layer keeps
    // the "is this platform supported by this deploy" gate so the
    // pre-cutover 501 envelope (for non-wired chat/action platforms)
    // stays stable. Three slug classes are wired:
    //   - `slack` → chat_cache two-store teardown
    //   - `INTEGRATION_CREDENTIALS_SLUGS` (salesforce / jira / linear)
    //     → integration_credentials teardown
    //   - `INLINE_CREDENTIAL_SLUGS` (github / github-single-tenant /
    //     github-pat) → no separate credential store; the
    //     workspace_plugins DELETE is the credential teardown
    const isSlack = platform === "slack";
    const isIntegrationCredentials = INTEGRATION_CREDENTIALS_SLUGS.has(platform);
    const isInlineCredential = INLINE_CREDENTIAL_SLUGS.has(platform);
    const isDedicatedTable = DEDICATED_TABLE_CREDENTIAL_SLUGS.has(platform);
    if (!isSlack && !isIntegrationCredentials && !isInlineCredential && !isDedicatedTable) {
      // Cheap pre-check: catalog lookup so the 404 still fires before
      // the 501. Otherwise an attacker probing unknown slugs would
      // learn whether the slug exists (501 vs 404).
      const catalog = await getCatalogRowBySlugForDisconnect(platform);
      if (!catalog) {
        return c.json({ error: "not_found", message: `Unknown platform "${platform}"`, requestId }, 404);
      }
      return c.json(
        { error: "disconnect_unavailable", message: `Disconnect for "${platform}" is not yet implemented on this deploy.`, requestId },
        501,
      );
    }

    // ── Pivot to WorkspaceInstaller.uninstall (#2742) ─────────────
    // Two-store teardown (ADR-0003 order: credentials FIRST, install
    // row SECOND) is owned by the facade. Tagged errors flow through
    // `runEffect`'s `classifyError`: `CatalogNotFoundError` /
    // `InstallNotFoundError` → 404; defects (unexpected DB failure)
    // → 500 with requestId. `runEffect` throws `HTTPException`s
    // directly — they bubble up to Hono's error handler as the
    // structured error envelope.
    await runEffect(
      c,
      Effect.gen(function* () {
        const installer = yield* WorkspaceInstaller;
        yield* installer.uninstall(workspaceId, platform);
      }).pipe(Effect.provide(WorkspaceInstallerLive)),
      { label: "platform disconnect" },
    );

    log.info(
      { workspaceId, platform },
      "Platform install disconnected (both stores cleared)",
    );
    return c.json({ message: `${platform} disconnected successfully.` }, 200);
  }),
);

export { integrations };
