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
import { PlatformOAuthExchangeError } from "@atlas/api/lib/effect/errors";
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
        "`/admin/integrations?error=<platform>&reason=plan_upgrade_required` " +
        "when the workspace's plan does not admit the install (browser callers).",
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
    429: { description: "Rate limited", content: { "application/json": { schema: AuthErrorSchema } } },
    501: { description: "OAuth handler not registered", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const installFormRoute = createRoute({
  method: "post",
  path: "/{platform}/install-form",
  tags: ["Integrations"],
  summary: "Submit form-based install (no OAuth)",
  description:
    "Persists the submitted credentials + install metadata for an `install_model: \"form\"` " +
    "catalog entry (#2660 — Email, future Webhook / Obsidian). Validates the JSON body " +
    "against the per-Platform schema, encrypts secret-marked fields at rest, and upserts the " +
    "workspace_plugins row. 400 with field-level detail on validation failure; the route " +
    "rejects requests pointed at non-form catalog entries with 400 (`wrong_install_model`).",
  request: {
    params: z.object({
      platform: z.string().openapi({ description: "Catalog slug (e.g. 'email')" }),
    }),
    body: {
      content: {
        "application/json": {
          schema: z.record(z.string(), z.unknown()).openapi({
            description:
              "Form data shaped to the catalog entry's `configSchema`. Validated " +
              "server-side by the per-Platform handler — never trust the client.",
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
        "`formErrors`), missing org binding, or platform is not form-installable.",
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
    429: { description: "Rate limited", content: { "application/json": { schema: AuthErrorSchema } } },
    501: { description: "Form handler not registered", content: { "application/json": { schema: ErrorSchema } } },
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
    "a 302 to /admin/integrations on success.",
  request: {
    params: z.object({
      platform: z.string().openapi({ description: "Catalog slug" }),
    }),
    query: z.object({
      code: z.string().openapi({ description: "OAuth authorization code" }),
      state: z.string().openapi({ description: "Signed state token from install" }),
    }),
  },
  responses: {
    302: {
      description:
        "Install complete or failed in a recoverable way — redirected to /admin/integrations. " +
        "Success: `?installed=<platform>`. Credential write missed: `?reconnect=<platform>`. " +
        "Hard failure (browser caller): `?error=<platform>&reason=<code>`. JSON callers receive 400/502 instead.",
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
    501: { description: "OAuth handler not registered", content: { "application/json": { schema: ErrorSchema } } },
    502: { description: "Upstream Platform rejected the OAuth exchange (JSON-Accept caller)", content: { "application/json": { schema: ErrorSchema } } },
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
 * Salesforce moved to `/admin/connections` in #2745 — sending its
 * callbacks to the old page would land users on a screen that no longer
 * lists Salesforce. Add new exceptions here when a future platform
 * follows the same pattern (Jira, etc.).
 */
function adminDestinationForPlatform(platform: string): string {
  if (platform === "salesforce") return "/admin/connections";
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
} | null> {
  const rows = await internalQuery<CatalogRowFromDb>(
    `SELECT slug, install_model, enabled, min_plan
       FROM plugin_catalog
      WHERE slug = $1 AND enabled = true
      LIMIT 1`,
    [slug],
  );
  if (rows.length === 0) return null;
  const row = rows[0];
  if (row.install_model !== "oauth" && row.install_model !== "form" && row.install_model !== "static-bot") {
    log.warn({ slug, install_model: row.install_model }, "Unknown install_model in plugin_catalog row");
    return null;
  }
  return {
    slug: row.slug,
    install_model: row.install_model as CatalogInstallModel,
    min_plan: row.min_plan,
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
    if (row.install_model !== "oauth") {
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
    if (handler.kind !== "oauth") {
      // Catalog said OAuth, dispatch returned a non-OAuth handler — a
      // config drift; treat as 500-equivalent for the route's invariants.
      log.error({ platform, kind: handler.kind }, "Catalog install_model='oauth' but dispatch returned non-OAuth handler");
      return c.json({ error: "handler_unavailable", message: "Install handler misconfigured.", requestId }, 501);
    }

    const { redirectUrl } = await handler.startInstall(workspaceId);
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
    if (row.install_model !== "form") {
      // A caller hitting `/install-form` on an OAuth or static-bot
      // catalog row is either a UI bug (modal opened for the wrong
      // card) or an attacker probing endpoints. Logging the rejection
      // surfaces both. Mirrors the install + callback handlers'
      // similar `log.warn` patterns.
      log.warn(
        { platform, install_model: row.install_model },
        "Refused form install: platform's install_model is not 'form'",
      );
      return c.json(
        { error: "wrong_install_model", message: `Platform "${platform}" uses install_model "${row.install_model}" — not form-installable via this route.`, requestId },
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
        { platform, err: err instanceof Error ? err.message : String(err) },
        "No form install handler registered for platform — operator must wire the handler",
      );
      return c.json(
        { error: "handler_unavailable", message: `Form handler for "${platform}" is not registered on this deploy.`, requestId },
        501,
      );
    }
    if (handler.kind !== "form") {
      log.error({ platform, kind: handler.kind }, "Catalog install_model='form' but dispatch returned non-form handler");
      return c.json({ error: "handler_unavailable", message: "Install handler misconfigured.", requestId }, 501);
    }

    // ── Validate + persist ────────────────────────────────────────
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
  }),
);

integrations.openapi(callbackRoute, async (c) =>
  runHandler(c, "platform callback", async () => {
    const { platform } = c.req.valid("param");
    const { code, state } = c.req.valid("query");
    const requestId = crypto.randomUUID();

    const row = await getInstallableCatalogRowBySlug(platform);
    if (!row) {
      return c.json({ error: "not_found", message: `Unknown platform "${platform}"`, requestId }, 404);
    }
    if (row.install_model !== "oauth") {
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
    if (handler.kind !== "oauth") {
      log.error({ platform, kind: handler.kind }, "Catalog install_model='oauth' but dispatch returned non-OAuth handler");
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
      result = await handler.handleCallback(code, state);
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
    // (`adminDestinationForPlatform`) — Salesforce lives on
    // `/admin/connections`, everything else on `/admin/integrations`.
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
    // stays stable. Slack and the lazy-OAuth set are the universe of
    // chat/action installs the disconnect path can handle today.
    const isSlack = platform === "slack";
    const isIntegrationCredentials = INTEGRATION_CREDENTIALS_SLUGS.has(platform);
    if (!isSlack && !isIntegrationCredentials) {
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
