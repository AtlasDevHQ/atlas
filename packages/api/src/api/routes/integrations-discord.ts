/**
 * Discord static-bot install routes — slice 11 of 1.5.3 Phase D (#2749).
 *
 * Two endpoints mounted under `/api/v1/integrations/discord/`:
 *
 *   `GET /api/v1/integrations/discord/install`  — admin clicks "Install" in
 *     /admin/integrations; we mint a signed state token bound to
 *     `(workspaceId, "catalog:discord")` and redirect to Discord's
 *     bot-install URL with the operator-owned `client_id`.
 *
 *   `GET /api/v1/integrations/discord/callback` — Discord redirects here
 *     after the customer authorizes the Atlas bot in their server. The
 *     redirect query includes `guild_id` (the server the bot was added
 *     to) and `state` (our state token). We verify the state, then
 *     dispatch to `DiscordStaticBotInstallHandler.confirmInstall` which
 *     UPSERTs the install row and round-trips Discord's API to verify
 *     the bot is currently a member of that guild.
 *
 * **Why a Discord-specific route exists alongside the generic
 * `/integrations/:platform/install`.** The generic dispatcher
 * (`integrations.ts`) handles `install_model === "oauth"` (Slack, Jira,
 * Salesforce) — those exchange an authorization code for a per-Workspace
 * credential. Discord is `install_model === "static-bot"` (the bot is
 * operator-shared, no per-Workspace credential) BUT still uses an
 * OAuth-shaped redirect flow because Discord's "add bot to server" UX
 * IS an OAuth authorize page. The static-bot keystone (Telegram, #2748)
 * captures the routing identifier from a form submit; Discord captures
 * it from an OAuth callback. Both end at the same `confirmInstall`
 * entrypoint — only the routing-identifier capture differs.
 *
 * Mount: `index.ts` registers this router under `/api/v1/integrations`
 * BEFORE the generic `integrations` sub-router so Hono's first-match
 * precedence picks these handlers up rather than the generic one
 * (which would reject Discord with 400 `wrong_install_model`).
 *
 * Auth + plan-tier semantics mirror the OAuth `/install` route in
 * `integrations.ts` — see the docstring there for the F-04 install-
 * hijack rationale and the plan-tier downgrade defense.
 */

import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { z } from "zod";
import { internalQuery } from "@atlas/api/lib/db/internal";
import { createLogger } from "@atlas/api/lib/logger";
import { getWebOrigin } from "@atlas/api/lib/web-origin";
import { runHandler } from "@atlas/api/lib/effect/hono";
import { getConfig } from "@atlas/api/lib/config";
import {
  ChatIntegrationLimitError,
  DiscordApiUnavailableError,
  DiscordGuildIdInvalidError,
  DiscordReachabilityError,
} from "@atlas/api/lib/effect/errors";
import {
  getInstallHandler,
  mintOAuthStateToken,
  verifyOAuthStateToken,
} from "@atlas/api/lib/integrations/install";
import { DISCORD_CATALOG_ID, DISCORD_SLUG } from "@atlas/api/lib/integrations/install/discord-static-bot-handler";
import {
  isPlanEligible,
  parsePlanTier,
} from "@atlas/api/lib/integrations/install/plan-rank";
import { adminAuthPreamble } from "./admin-auth";
import { validationHook } from "./validation-hook";
import { ErrorSchema, AuthErrorSchema } from "./shared-schemas";
import { PLAN_TIERS } from "@useatlas/types";
import type {
  PlanTier,
  PlanUpgradeRequiredBody,
  WorkspaceId,
} from "@useatlas/types";

const log = createLogger("integrations.discord");

/**
 * Discord OAuth2 bot-install permissions bitmask. We request the minimum
 * scope the chat-adapter needs to read context and post agent responses
 * with rich cards:
 *
 *   - `View Channels`             (1 &lt;&lt; 10  =        1024) — list channels the bot is in
 *   - `Send Messages`             (1 &lt;&lt; 11  =        2048) — post agent responses
 *   - `Embed Links`               (1 &lt;&lt; 14  =       16384) — render result-card embeds
 *   - `Read Message History`      (1 &lt;&lt; 16  =       65536) — reply-in-thread context
 *   - `Send Messages in Threads`  (1 &lt;&lt; 38  = 274877906944) — thread replies
 *
 * Sum: 274877991936. Bots can edit/delete their *own* messages without
 * MANAGE_MESSAGES, so we intentionally do not request that permission —
 * granting it would let Atlas moderate other users' messages, which the
 * agent has no use for.
 *
 * Operators who need different permissions can override via
 * `DISCORD_OAUTH_PERMISSIONS` in env. The chat-adapter handles the
 * actual permission check at message-send time; this bitmask is just
 * what we *request* at the install screen.
 *
 * Keep this constant in lockstep with `apps/docs/content/docs/integrations/discord.mdx`
 * ("Pick a server and authorize") — that page lists the requested
 * permissions verbatim so admins know what they're agreeing to.
 */
const DEFAULT_DISCORD_PERMISSIONS = "274877991936";

const PlanUpgradeRequiredBodySchema = z.object({
  error: z.literal("plan_upgrade_required"),
  message: z.string(),
  required_plan: z.enum(PLAN_TIERS),
  current_plan: z.enum(PLAN_TIERS),
  requestId: z.string(),
}) satisfies z.ZodType<PlanUpgradeRequiredBody>;

const discordIntegrations = new OpenAPIHono({ defaultHook: validationHook });

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const installRoute = createRoute({
  method: "get",
  path: "/install",
  tags: ["Integrations"],
  summary: "Discord bot-install redirect",
  description:
    "Redirects to Discord's OAuth2 bot-install page using the operator-owned client_id. " +
    "Customer admin authorizes the Atlas bot in their server; Discord then redirects to " +
    "`/api/v1/integrations/discord/callback?guild_id=…&state=…`.",
  responses: {
    302: {
      description:
        "Redirect to Discord's OAuth2 authorize page on success, or to " +
        "`/admin/integrations?error=discord&reason=plan_upgrade_required` " +
        "when the workspace's plan does not admit the install (browser callers).",
    },
    400: {
      description: "Caller lacks workspace binding, or Discord is not OAuth-installable",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Not authenticated",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    403: {
      description:
        "Caller is not a workspace admin, or the workspace's plan does not admit Discord. " +
        "Plan-upgrade responses follow PlanUpgradeRequiredBody (JSON callers; browsers see a 302).",
      content: {
        "application/json": {
          schema: z.union([PlanUpgradeRequiredBodySchema, AuthErrorSchema]),
        },
      },
    },
    404: {
      description: "Discord catalog row missing or kill-switched",
      content: { "application/json": { schema: ErrorSchema } },
    },
    501: {
      description:
        "Discord install handler not registered — operator must set DISCORD_BOT_TOKEN + DISCORD_CLIENT_ID.",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const callbackRoute = createRoute({
  method: "get",
  path: "/callback",
  tags: ["Integrations"],
  summary: "Discord bot-install callback",
  description:
    "Handles the redirect from Discord's bot-install authorization page. Verifies the " +
    "state token, extracts `guild_id`, and dispatches into the static-bot install handler.",
  request: {
    query: z.object({
      // Discord redirects with `guild_id` set when the user picks a
      // server, or `error` set when they cancel. Both optional at the
      // OpenAPI layer; the handler enforces the success-path required
      // fields.
      state: z.string().openapi({ description: "Signed state token from /install" }),
      guild_id: z.string().optional().openapi({ description: "Authorized guild snowflake" }),
      // Discord also returns `permissions` (granted bitmask) on success
      // and `error` / `error_description` on user cancel; we accept but
      // don't currently use them.
      permissions: z.string().optional(),
      error: z.string().optional(),
      error_description: z.string().optional(),
    }),
  },
  responses: {
    302: {
      description:
        "Install complete — redirected to /admin/integrations. " +
        "Success: `?installed=discord`. User cancel: `?error=discord&reason=authorization_denied`. " +
        "Chat-integration cap reached (browser caller): `?error=discord&reason=plan_limit_reached`. " +
        "JSON callers receive structured 4xx/5xx responses instead.",
    },
    400: {
      description: "Invalid state, user cancel, or missing guild_id",
      content: { "application/json": { schema: ErrorSchema } },
    },
    404: {
      description: "Discord catalog row missing",
      content: { "application/json": { schema: ErrorSchema } },
    },
    // #2953 — workspace at its plan's chat-integration cap (JSON callers;
    // browsers get a 302 with `reason=plan_limit_reached`). `plan_limit_exceeded`
    // body carries the `limit` that was hit.
    429: {
      description: "Chat-integration cap reached for the workspace's plan tier: `plan_limit_exceeded` (JSON-Accept caller)",
      content: { "application/json": { schema: ErrorSchema.extend({ limit: z.number() }) } },
    },
    501: {
      description: "Discord install handler not registered",
      content: { "application/json": { schema: ErrorSchema } },
    },
    502: {
      description: "Discord API unreachable while verifying the guild",
      content: { "application/json": { schema: ErrorSchema } },
    },
    // #2953 — the chat-integration count couldn't be determined (transient DB
    // fault), so the cap check failed closed: `billing_check_failed` "try again".
    503: {
      description: "Billing/plan-limit check unavailable: `billing_check_failed` (JSON-Accept caller)",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface CatalogRow {
  readonly slug: string;
  readonly install_model: string;
  readonly min_plan: string;
}

async function loadDiscordCatalogRow(): Promise<CatalogRow | null> {
  const rows = await internalQuery<CatalogRow & Record<string, unknown>>(
    `SELECT slug, install_model, min_plan
       FROM plugin_catalog
      WHERE slug = $1 AND enabled = true
      LIMIT 1`,
    [DISCORD_SLUG],
  );
  if (rows.length === 0) return null;
  return rows[0];
}

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

function prefersHtml(req: Request): boolean {
  return (req.headers.get("accept") ?? "").includes("text/html");
}

function buildAdminIntegrationsUrl(
  param: "installed" | "reconnect" | "error",
  extra?: Record<string, string>,
): string {
  const webOrigin = getWebOrigin();
  const base = webOrigin
    ? `${webOrigin}/admin/integrations`
    : "/admin/integrations";
  const qs = new URLSearchParams({ [param]: "discord", ...extra });
  return `${base}?${qs.toString()}`;
}

/**
 * Sanitize an upstream-provided message before echoing it back in a
 * JSON response body. Strips ASCII control chars (newlines, NUL, etc.)
 * and caps length at 256 chars. Used on `error_description` query
 * params — Discord's user-cancel redirect carries this field, and
 * anyone who can craft the redirect URL controls the text.
 *
 * Returns null for empty / non-string input.
 */
function sanitizeUpstreamMessage(raw: string | undefined): string | null {
  if (typeof raw !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const cleaned = raw.replace(/[\x00-\x1f\x7f]/g, " ").trim();
  if (cleaned.length === 0) return null;
  return cleaned.length > 256 ? `${cleaned.slice(0, 253)}...` : cleaned;
}

function resolvePublicApiUrl(req: Request): string {
  const explicit = process.env.ATLAS_PUBLIC_API_URL;
  if (explicit && explicit.length > 0) return explicit.replace(/\/+$/, "");
  return new URL(req.url).origin;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

discordIntegrations.openapi(installRoute, async (c) =>
  runHandler(c, "discord install", async () => {
    const requestId = crypto.randomUUID();
    const preamble = await adminAuthPreamble(c.req.raw, requestId);
    if ("error" in preamble) {
      return c.json(preamble.error, preamble.status, preamble.headers);
    }

    const deployMode = getConfig()?.deployMode;
    const orgIdRaw = preamble.authResult.user?.activeOrganizationId ?? undefined;
    if (preamble.authResult.mode === "none" && deployMode === "saas") {
      log.warn({ deployMode }, "Refusing Discord install: SaaS deploy with mode=none is a misconfig");
      return c.json(
        {
          error: "missing_org_binding",
          message: "Install must be initiated by an authenticated workspace admin.",
          requestId,
        },
        400,
      );
    }
    if (!orgIdRaw && preamble.authResult.mode !== "none") {
      return c.json(
        {
          error: "missing_org_binding",
          message: "Install must be initiated by an authenticated workspace admin.",
          requestId,
        },
        400,
      );
    }
    const workspaceId = (orgIdRaw ?? "self-hosted") as WorkspaceId;

    const row = await loadDiscordCatalogRow();
    if (!row) {
      return c.json(
        { error: "not_found", message: `Unknown platform "discord"`, requestId },
        404,
      );
    }
    if (row.install_model !== "static-bot") {
      // Catalog drift — Discord is `static-bot` everywhere we ship.
      log.error(
        { install_model: row.install_model },
        "Discord catalog row has wrong install_model — operator must fix",
      );
      return c.json(
        {
          error: "wrong_install_model",
          message: `Catalog row for "discord" has install_model "${row.install_model}" — expected "static-bot".`,
          requestId,
        },
        400,
      );
    }

    // Plan-tier gate (#2701). Discord follows the same posture as the
    // generic install route — browsers get a 302 to the upsell banner,
    // JSON callers get the structured 403.
    if (orgIdRaw) {
      const entitlement = await getWorkspaceEntitlement(orgIdRaw);
      if (!entitlement.isOperator) {
        const requiredPlan = parsePlanTier(row.min_plan);
        if (requiredPlan === null) {
          log.error(
            { workspaceId, rawMinPlan: row.min_plan },
            "Discord install denied: plugin_catalog.min_plan is not a recognized plan tier",
          );
          return c.json(
            {
              error: "handler_unavailable",
              message: "Internal configuration error for \"discord\". Contact your administrator.",
              requestId,
            },
            501,
          );
        }
        if (!isPlanEligible(entitlement.planTier, requiredPlan)) {
          const currentPlan = entitlement.planTier ?? "free";
          log.info(
            { workspaceId, requiredPlan, currentPlan },
            "Discord install denied: workspace plan does not admit this integration",
          );
          if (prefersHtml(c.req.raw)) {
            return c.redirect(
              buildAdminIntegrationsUrl("error", {
                reason: "plan_upgrade_required",
                required_plan: requiredPlan,
              }),
            );
          }
          return c.json(
            {
              error: "plan_upgrade_required" as const,
              message: `Installing discord requires the "${requiredPlan}" plan. Your workspace is on the "${currentPlan}" plan.`,
              required_plan: requiredPlan,
              current_plan: currentPlan,
              requestId,
            },
            403,
          );
        }
      }
    }

    // Dispatch — the handler holds the operator's client_id for us.
    let handler;
    try {
      handler = getInstallHandler({ slug: DISCORD_SLUG, install_model: "static-bot" });
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "No Discord install handler registered — operator must wire DISCORD_BOT_TOKEN + DISCORD_CLIENT_ID",
      );
      return c.json(
        {
          error: "handler_unavailable",
          message: "Discord install is not configured on this deploy. Operator must set DISCORD_BOT_TOKEN and DISCORD_CLIENT_ID.",
          requestId,
        },
        501,
      );
    }
    if (handler.kind !== "static-bot") {
      log.error(
        { kind: handler.kind },
        "Catalog install_model='static-bot' but dispatch returned non-static-bot handler",
      );
      return c.json(
        { error: "handler_unavailable", message: "Install handler misconfigured.", requestId },
        501,
      );
    }
    // Narrow to the concrete Discord handler so we can read clientId.
    // `applicationId` is typed as optional on the StaticBotInstallHandler
    // interface — Telegram returns undefined here, Discord must populate
    // it. A same-slot misregistration (e.g. Telegram's handler wired
    // under the discord slug) surfaces as a 501 rather than building a
    // broken install URL with an empty client_id.
    const clientId = handler.applicationId;
    if (typeof clientId !== "string" || clientId.length === 0) {
      log.error(
        "Discord handler missing applicationId — dispatch may have returned a non-Discord static-bot handler under the 'discord' slug",
      );
      return c.json(
        { error: "handler_unavailable", message: "Install handler misconfigured.", requestId },
        501,
      );
    }

    // Mint state token + build the Discord bot-install URL.
    const stateToken = mintOAuthStateToken(workspaceId, DISCORD_CATALOG_ID);
    const publicApiUrl = resolvePublicApiUrl(c.req.raw);
    const redirectUri = `${publicApiUrl}/api/v1/integrations/discord/callback`;
    const permissions = process.env.DISCORD_OAUTH_PERMISSIONS || DEFAULT_DISCORD_PERMISSIONS;
    const authorizeUrl =
      `https://discord.com/oauth2/authorize` +
      `?client_id=${encodeURIComponent(clientId)}` +
      `&scope=${encodeURIComponent("bot applications.commands")}` +
      `&permissions=${encodeURIComponent(permissions)}` +
      `&response_type=code` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&state=${encodeURIComponent(stateToken)}`;
    log.info({ workspaceId }, "Discord install — redirecting to authorize URL");
    return c.redirect(authorizeUrl);
  }),
);

discordIntegrations.openapi(callbackRoute, async (c) =>
  runHandler(c, "discord callback", async () => {
    const requestId = crypto.randomUUID();
    const query = c.req.valid("query");

    // Verify state first — no DB writes, no upstream calls.
    const verified = verifyOAuthStateToken(query.state);
    if (verified === null || verified.catalogId !== DISCORD_CATALOG_ID) {
      log.warn(
        { hasState: Boolean(query.state), catalogId: verified?.catalogId },
        "Discord callback rejected invalid state token",
      );
      if (prefersHtml(c.req.raw)) {
        return c.redirect(buildAdminIntegrationsUrl("error", { reason: "invalid_state" }));
      }
      return c.json(
        {
          error: "invalid_state",
          message: "Invalid or expired install state. Restart the install from /admin/integrations.",
          requestId,
        },
        400,
      );
    }
    const workspaceId = verified.workspaceId as WorkspaceId;

    // Discord-side user cancel — `error` + `error_description` in query.
    // `error_description` is attacker-influenceable (anyone who can craft
    // the redirect URL controls the text), so sanitize before forwarding
    // to JSON callers: strip control chars + cap length.
    if (query.error) {
      log.info({ workspaceId, error: query.error }, "Discord install: user cancelled authorization");
      if (prefersHtml(c.req.raw)) {
        return c.redirect(
          buildAdminIntegrationsUrl("error", { reason: "authorization_denied" }),
        );
      }
      const safeDescription = sanitizeUpstreamMessage(query.error_description);
      return c.json(
        {
          error: "authorization_denied",
          message: safeDescription || "Discord authorization was not granted.",
          requestId,
        },
        400,
      );
    }

    const guildId = query.guild_id;
    if (!guildId) {
      log.warn(
        { workspaceId, queryKeys: Object.keys(query) },
        "Discord callback missing guild_id — Discord redirect did not include the authorized guild",
      );
      if (prefersHtml(c.req.raw)) {
        return c.redirect(buildAdminIntegrationsUrl("error", { reason: "missing_guild_id" }));
      }
      return c.json(
        {
          error: "missing_guild_id",
          message: "Discord did not include a guild_id in the callback. Restart the install and select a server.",
          requestId,
        },
        400,
      );
    }

    // ── Defensive catalog reload (#2790 codex P1) ────────────────
    // /install already gated on `plugin_catalog.enabled = true` + plan
    // eligibility, but the OAuth round-trip is async — an operator
    // kill-switch flipped after /install AND before /callback would
    // otherwise still persist the install row. Re-load the catalog
    // here with the same `enabled = true` predicate; missing-row →
    // 404 (admin UI surfaces the right toast).
    const catalogRow = await loadDiscordCatalogRow();
    if (!catalogRow) {
      log.warn(
        { workspaceId },
        "Discord callback: catalog row missing or disabled — refusing install",
      );
      if (prefersHtml(c.req.raw)) {
        return c.redirect(buildAdminIntegrationsUrl("error", { reason: "catalog_unavailable" }));
      }
      return c.json(
        { error: "not_found", message: `Discord integration is no longer available.`, requestId },
        404,
      );
    }

    // ── Defensive plan re-check (#2790 codex P1) ─────────────────
    // No single-use OAuth code is burned by Discord static-bot, but
    // persisting an install row for a workspace that no longer admits
    // the integration creates an admin-facing inconsistency (Installed
    // card + upsell banner). Re-read entitlement, deny on downgrade.
    //
    // Asymmetric DB-blip handling vs `/install`: a 500 here would
    // strand the user with a half-completed OAuth round-trip and no
    // recovery path (the next /install attempt mints a fresh state
    // token, so retry IS the recovery — but only after the DB is back).
    // We log + let the install land if the entitlement read throws,
    // matching the integrations.ts callback's posture.
    if (workspaceId !== "self-hosted") {
      let entitlement: Awaited<ReturnType<typeof getWorkspaceEntitlement>> | undefined;
      try {
        entitlement = await getWorkspaceEntitlement(workspaceId);
      } catch (err) {
        log.warn(
          {
            workspaceId,
            err: err instanceof Error ? err.message : String(err),
          },
          "Discord callback plan re-check failed — skipping and letting install land (original /install already plan-checked)",
        );
      }
      if (entitlement && !entitlement.isOperator) {
        const requiredPlan = parsePlanTier(catalogRow.min_plan);
        if (requiredPlan && !isPlanEligible(entitlement.planTier, requiredPlan)) {
          const currentPlan = entitlement.planTier ?? "free";
          log.info(
            { workspaceId, requiredPlan, currentPlan },
            "Discord callback denied: workspace plan changed mid-OAuth — install not written",
          );
          if (prefersHtml(c.req.raw)) {
            return c.redirect(
              buildAdminIntegrationsUrl("error", {
                reason: "plan_upgrade_required",
                required_plan: requiredPlan,
              }),
            );
          }
          return c.json(
            {
              error: "plan_upgrade_required" as const,
              message: `Installing discord requires the "${requiredPlan}" plan. Your workspace is on the "${currentPlan}" plan.`,
              required_plan: requiredPlan,
              current_plan: currentPlan,
              requestId,
            },
            403,
          );
        }
      }
    }

    // Dispatch into the handler — UPSERT + reachability verification.
    let handler;
    try {
      handler = getInstallHandler({ slug: DISCORD_SLUG, install_model: "static-bot" });
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "No Discord install handler registered at callback time",
      );
      return c.json(
        {
          error: "handler_unavailable",
          message: "Discord install is not configured on this deploy.",
          requestId,
        },
        501,
      );
    }
    if (handler.kind !== "static-bot") {
      log.error({ kind: handler.kind }, "Discord callback: dispatch returned non-static-bot handler");
      return c.json(
        { error: "handler_unavailable", message: "Install handler misconfigured.", requestId },
        501,
      );
    }

    try {
      await handler.confirmInstall(workspaceId, guildId, undefined, {
        // Discord's bot-install authorize page doesn't return the guild
        // name in the redirect query, so the handler falls back to its
        // own API roundtrip. Pass undefined explicitly to document the
        // contract — no admin-provided override at this surface.
      });
    } catch (err) {
      if (err instanceof DiscordGuildIdInvalidError || err instanceof DiscordReachabilityError) {
        log.warn(
          { workspaceId, err: err.message },
          "Discord install rejected guild — actionable 4xx",
        );
        if (prefersHtml(c.req.raw)) {
          return c.redirect(buildAdminIntegrationsUrl("error", { reason: "upstream_error" }));
        }
        return c.json(
          { error: "bad_request", message: err.message, requestId },
          400,
        );
      }
      if (err instanceof DiscordApiUnavailableError) {
        log.error({ workspaceId, err: err.message }, "Discord API unreachable during callback");
        if (prefersHtml(c.req.raw)) {
          return c.redirect(buildAdminIntegrationsUrl("error", { reason: "upstream_unavailable" }));
        }
        return c.json(
          { error: "upstream_error", message: err.message, requestId },
          502,
        );
      }
      // Workspace at its plan's chat-integration cap. Browser callers get
      // the friendly upgrade redirect; JSON callers fall through to the 429
      // `plan_limit_exceeded` mapping in runHandler. (A `BillingCheckFailedError`
      // is intentionally left to the 503 JSON mapper — transient "try again".)
      if (err instanceof ChatIntegrationLimitError) {
        log.info(
          { workspaceId, limit: err.limit },
          "Discord install blocked — workspace at chat-integration cap",
        );
        if (prefersHtml(c.req.raw)) {
          return c.redirect(buildAdminIntegrationsUrl("error", { reason: "plan_limit_reached" }));
        }
        return c.json(
          { error: "plan_limit_exceeded", message: err.message, requestId, limit: err.limit },
          429,
        );
      }
      throw err;
    }

    log.info({ workspaceId }, "Discord install completed via OAuth callback");
    return c.redirect(buildAdminIntegrationsUrl("installed"));
  }),
);

export { discordIntegrations };
