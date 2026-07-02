/**
 * `SlackOAuthInstallHandler` — slice 5 of #2649 (issue #2653).
 *
 * Implements {@link OAuthPlatformInstallHandler} for Slack. The actual
 * `oauth.v2.access` exchange + per-tenant `chat_cache:slack:installation:<teamId>`
 * write are lifted from the legacy `packages/api/src/api/routes/slack.ts`
 * handlers (deleted in the same PR). The CSRF state token now flows
 * through the slice 4 `mintOAuthStateToken` / `verifyOAuthStateToken`
 * pair instead of the legacy DB-backed `oauth_state` table.
 *
 * Atomicity per ADR-0003 (two-store chat install metadata + credentials):
 *
 *   1. `workspace_plugins` row INSERT — the install record (typed columns,
 *      FK to `plugin_catalog`). Failure here aborts the whole flow; the
 *      Slack token isn't worth anything without the row that says "this
 *      Workspace has Slack installed."
 *   2. `chat_cache:slack:installation:<teamId>` write via `saveInstallation`
 *      — the per-tenant credential. Failure here returns the install
 *      record with `credentialResult.written: false`. The admin UI
 *      renders "Reconnect needed"; re-running the OAuth dance retries
 *      step 2 (step 1 is an upsert under `idx_workspace_plugins_unique`).
 *
 *   We do NOT roll back step 1 on step 2 failure. The dual-store design
 *   accepts a transient half-state in exchange for keeping each store on
 *   its own atomic write — see ADR-0003 "Consequences > For OAuth callback."
 *
 * Operator config is constructor-injected rather than read from `process.env`
 * inside the methods so the handler unit-tests cleanly without env
 * monkey-patching. The `register.ts` sibling module reads env once at
 * module load and constructs the singleton.
 *
 * @see ../oauth-state-token.ts — state mint/verify primitives
 * @see ../../slack/store.ts — `saveInstallation` (chat_cache write path)
 * @see docs/adr/0003-two-store-chat-install-metadata-credentials.md
 */

import crypto from "crypto";
import { Data } from "effect";
import { createLogger } from "@atlas/api/lib/logger";
import { slackAPI } from "@atlas/api/lib/slack/api";
import { saveInstallation } from "@atlas/api/lib/slack/store";
import { BillingCheckFailedError, ChatIntegrationLimitError, PlatformOAuthExchangeError } from "@atlas/api/lib/effect/errors";
import { checkChatIntegrationLimit, checkChatIntegrationLimitAndInstall } from "@atlas/api/lib/billing/enforcement";
import type { WorkspaceId } from "@useatlas/types";
import { mintOAuthStateToken } from "./oauth-state-token";
import { verifyCallbackState } from "./oauth-callback-verify";
import type {
  CatalogId,
  CredentialResult,
  InstallRecord,
  OAuthPlatformInstallHandler,
} from "./types";

const log = createLogger("integrations.install.slack");

/**
 * Slack `id` in `plugin_catalog`. The seeder derives row ids as
 * `catalog:${slug}` (see `catalog-seeder.ts::upsertEntry`), so the FK
 * target in `workspace_plugins.catalog_id` is `catalog:slack`. Hardcoded
 * here rather than read from the DB at install time — the handler is
 * Slack-specific by construction, so resolving the id dynamically would
 * be ceremony.
 */
const SLACK_CATALOG_ID = "catalog:slack";

/** Catalog slug — also the value bound into the OAuth state token. */
const SLACK_SLUG: CatalogId = "slack";

/**
 * OAuth scopes requested at install time. The first three are preserved
 * verbatim from the legacy slack.ts install route (the scopes determine
 * the bot token's capabilities — a subset of these would silently break
 * `/atlas` slash commands). `channels:read` + `groups:read` power the
 * admin channel picker (`GET /admin/proactive/channels/available` →
 * `conversations.list`); installs predating them soft-degrade to manual
 * channel-id entry until the workspace re-installs.
 */
const SLACK_SCOPES = "commands,chat:write,app_mentions:read,channels:read,groups:read";

/**
 * Per-deploy operator config — Slack app client credentials registered
 * once per region in the Slack API console. Read once from env by
 * `register.ts` and passed in here.
 */
export interface SlackOAuthHandlerConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  /**
   * Public-facing OAuth callback URL — must match exactly what's
   * registered on the Slack App's "Redirect URLs" page. Each SaaS
   * region has its own value (`https://api.us.useatlas.dev/...`,
   * `https://api.eu.useatlas.dev/...`, etc.).
   */
  readonly redirectUri: string;
}

// ---------------------------------------------------------------------------
// Tagged error — used internally; mapped to PlatformOAuthExchangeError at boundary
// ---------------------------------------------------------------------------

/**
 * Internal failure tag used to keep the route-level message terse and
 * operator-translatable. Distinct from `PlatformOAuthExchangeError`
 * (which is the external-facing tagged error in the AtlasError union)
 * so the catch / re-throw in the handler stays type-narrow.
 */
class IncompleteOAuthResponseError extends Data.TaggedError("IncompleteOAuthResponseError")<{
  readonly message: string;
  readonly hasTeamId: boolean;
  readonly hasAccessToken: boolean;
}> {}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export class SlackOAuthInstallHandler implements OAuthPlatformInstallHandler {
  readonly kind = "oauth" as const;

  constructor(private readonly config: SlackOAuthHandlerConfig) {}

  async startInstall(workspaceId: WorkspaceId): Promise<{
    readonly redirectUrl: string;
    readonly stateToken: string;
  }> {
    // ── Pre-redirect chat-integration cap gate (#2998) ─────────────
    // Refuse an at-cap workspace BEFORE minting the Slack authorize URL, so it
    // never completes the full OAuth dance (Slack minting a bot token +
    // installing the app) only to be turned away at the callback. This is a
    // read-only precheck — `handleCallback` STILL runs the atomic
    // check-and-install gate (`checkChatIntegrationLimitAndInstall`) as the
    // TOCTOU guard, because a workspace can reach its cap between here and the
    // callback. Same *timing* as the route's pre-redirect `min_plan` gate
    // (refuse before the dance), though that gate denies with 403
    // `plan_upgrade_required` while this one surfaces 429 `plan_limit_reached`
    // (cap hit) or 503 `billing_check_failed` (count unreadable).
    const capCheck = await checkChatIntegrationLimit(workspaceId, SLACK_CATALOG_ID);
    if (!capCheck.allowed) {
      if (capCheck.reason === "check_failed") {
        // Couldn't read the chat-integration count — fail closed, but as a
        // transient 503 "try again", NOT a 429 "upgrade your plan". Same
        // distinction the callback path draws.
        log.error(
          { workspaceId },
          "Slack install blocked pre-redirect — chat-integration count check failed (failing closed)",
        );
        throw new BillingCheckFailedError({
          message: capCheck.errorMessage,
          workspaceId,
        });
      }
      log.info(
        { workspaceId, limit: capCheck.limit },
        "Slack install blocked pre-redirect — workspace at chat-integration cap",
      );
      throw new ChatIntegrationLimitError({
        message: capCheck.errorMessage,
        workspaceId,
        limit: capCheck.limit,
      });
    }

    const stateToken = mintOAuthStateToken(workspaceId, SLACK_SLUG);
    const url = new URL("https://slack.com/oauth/v2/authorize");
    url.searchParams.set("client_id", this.config.clientId);
    url.searchParams.set("scope", SLACK_SCOPES);
    url.searchParams.set("state", stateToken);
    url.searchParams.set("redirect_uri", this.config.redirectUri);
    return { redirectUrl: url.toString(), stateToken };
  }

  async handleCallback(
    code: string,
    stateToken: string,
  ): Promise<{
    readonly workspaceId: WorkspaceId;
    readonly catalogId: CatalogId;
    readonly installRecord: InstallRecord;
    readonly credentialResult: CredentialResult;
  } | null> {
    // ── 1. Verify state token + catalog binding (shared seam) ─────
    // A token bound to a different catalog slug shouldn't reach the
    // Slack handler — the dispatch routes by slug. If it does, it's a
    // bug or a cross-catalog forge attempt; the seam returns null.
    const verified = verifyCallbackState(
      stateToken,
      SLACK_SLUG,
      log,
      "Slack OAuth callback received state bound to a different catalog — rejecting",
    );
    if (!verified) return null;
    const { workspaceId } = verified;

    // ── 2. Exchange code via Slack's oauth.v2.access ──────────────
    // `slackAPI` handles the form-encoded request body Slack's
    // `oauth.*` namespace requires (vs. JSON for every other method).
    const slackResp = await slackAPI("oauth.v2.access", "", {
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      code,
      redirect_uri: this.config.redirectUri,
    });

    if (!slackResp.ok) {
      log.warn(
        { workspaceId, upstreamError: slackResp.error },
        "Slack oauth.v2.access returned non-OK — refusing install",
      );
      throw new PlatformOAuthExchangeError({
        message: "Slack rejected the OAuth code. Restart the install from your Slack admin.",
        platform: SLACK_SLUG,
        upstreamError: slackResp.error,
      });
    }

    const data = slackResp as Record<string, unknown>;
    const team = data.team as { id?: string; name?: string } | undefined;
    const teamId = typeof team?.id === "string" ? team.id : "";
    const teamName = typeof team?.name === "string" ? team.name : null;
    const accessToken = typeof data.access_token === "string" ? data.access_token : "";
    const botUserId = typeof data.bot_user_id === "string" ? data.bot_user_id : null;
    const scopes = typeof data.scope === "string" ? data.scope : SLACK_SCOPES;
    const appId = typeof data.app_id === "string" ? data.app_id : null;

    if (!teamId || !accessToken) {
      log.error(
        { workspaceId, hasTeamId: !!teamId, hasAccessToken: !!accessToken },
        "Slack OAuth response missing team_id or access_token — refusing install",
      );
      const incomplete = new IncompleteOAuthResponseError({
        message: "Slack OAuth response missing required fields",
        hasTeamId: !!teamId,
        hasAccessToken: !!accessToken,
      });
      throw new PlatformOAuthExchangeError({
        message: "Slack returned an incomplete OAuth response. Restart the install.",
        platform: SLACK_SLUG,
        upstreamError: incomplete._tag,
      });
    }

    // ── 3. Plan cap + install record — atomic (#2953, #3001) ───────
    // Enforce the chat-integration cap and write the workspace_plugins row
    // (the first store) in ONE transaction guarded by a per-workspace
    // advisory lock, so two *distinct* net-new platforms installing
    // concurrently can't both slip past the cap. Reconnecting Slack
    // (already installed) is never blocked — the gate excludes Slack's own
    // row from the count, and the UPSERT collapses the duplicate.
    //
    // Schema notes (mirrors `discord-static-bot-handler.ts`):
    //   - `pillar` + `install_id` became NOT NULL in migration 0092
    //     (#2739) and the auto-fill trigger was dropped in 0096 (#2744),
    //     so every writer must name both columns explicitly — and the
    //     chat-integration cap (#2953) counts `pillar = 'chat'` rows, so
    //     omitting `pillar` would make Slack installs invisible to it.
    //   - Chat-pillar installs are singletons per (workspace, catalog),
    //     enforced by the `workspace_plugins_singleton` partial unique
    //     index (`WHERE pillar IN ('chat','action')`). We target it via
    //     the inference clause so re-install lands on the existing row.
    //   - One install per (workspace, catalog) for chat, so `install_id`
    //     mirrors `id`.
    //   - `RETURNING id` so we hand back the PERSISTED row id, not this
    //     candidate (#3005): on reconnect the UPSERT lands on the existing
    //     row, which keeps its original id (ON CONFLICT DO UPDATE never
    //     touches `id`), so the freshly-minted candidate would not match the
    //     DB row. The gate surfaces the INSERT's RETURNING rows on success.
    const installId = crypto.randomUUID();
    const installConfig = {
      team_id: teamId,
      team_name: teamName,
      bot_user_id: botUserId,
      scopes,
      app_id: appId,
    };
    let capCheck;
    try {
      capCheck = await checkChatIntegrationLimitAndInstall<{ id: string }>(workspaceId, SLACK_CATALOG_ID, {
        sql: `INSERT INTO workspace_plugins (id, workspace_id, catalog_id, install_id, pillar, config, enabled, installed_at)
         VALUES ($1, $2, $3, $1, 'chat', $4::jsonb, true, NOW())
         ON CONFLICT (workspace_id, catalog_id) WHERE pillar IN ('chat', 'action') DO UPDATE
           SET config = EXCLUDED.config,
               enabled = true
         RETURNING id`,
        params: [installId, workspaceId, SLACK_CATALOG_ID, JSON.stringify(installConfig)],
      });
    } catch (err) {
      log.error(
        { workspaceId, teamId, err: err instanceof Error ? err.message : String(err) },
        "Failed to write workspace_plugins install record — aborting install",
      );
      // Re-throw — the install record is the first store; without it
      // the credential write is meaningless. Surfaced to the route as
      // a 5xx by the runHandler bridge.
      throw err;
    }
    if (!capCheck.allowed) {
      if (capCheck.reason === "check_failed") {
        // We couldn't read the workspace's chat-integration count, so the
        // cap check failed closed. Surface this as a transient 503 "try
        // again" — NOT a 429 "upgrade your plan", which would be wrong and
        // non-actionable when the block is an internal-DB blip.
        log.error(
          { workspaceId },
          "Slack install blocked — chat-integration count check failed (failing closed)",
        );
        throw new BillingCheckFailedError({
          message: capCheck.errorMessage,
          workspaceId,
        });
      }
      log.info(
        { workspaceId, limit: capCheck.limit },
        "Slack install blocked — workspace at chat-integration cap",
      );
      throw new ChatIntegrationLimitError({
        message: capCheck.errorMessage,
        workspaceId,
        limit: capCheck.limit,
      });
    }

    // Read the id back from the UPSERT's RETURNING row rather than reusing the
    // candidate `installId` (#3005). On reconnect the row already exists and
    // keeps its ORIGINAL id, so the candidate would be wrong. Mirrors the
    // non-empty guard in `discord-static-bot-handler.ts`.
    const returned = capCheck.rows[0]?.id;
    if (typeof returned !== "string" || returned.length === 0) {
      // Postgres ≥9.5 guarantees `INSERT … ON CONFLICT … RETURNING` returns the
      // row on both insert and update. Empty here means a driver / wrapper
      // regression — fail loudly rather than hand back a stale candidate id
      // (on re-install the DB row has the existing id; falling back to the
      // fresh candidate would strand subsequent lookups and the credential
      // write below).
      throw new Error(
        `workspace_plugins UPSERT returned no id for Slack install (workspaceId=${workspaceId}). RETURNING must always populate on PG ≥9.5; this indicates a driver regression. Aborting install.`,
      );
    }
    const persistedId: string = returned;

    const installRecord: InstallRecord = {
      id: persistedId,
      workspaceId,
      catalogId: SLACK_SLUG,
    };

    // ── 4. Credential — chat_cache:slack:installation:<teamId> ──
    // ADR-0003 atomicity: a failure here leaves the install row in
    // place. The admin sees "Reconnect needed" in /admin/integrations
    // and can retry — re-running this method will UPSERT the install
    // row (no-op on config) and re-attempt the credential write.
    try {
      await saveInstallation(teamId, accessToken, {
        orgId: workspaceId,
        ...(teamName ? { workspaceName: teamName } : {}),
      });
      log.info({ workspaceId, teamId }, "Slack install completed (both stores written)");
      return {
        workspaceId,
        catalogId: SLACK_SLUG,
        installRecord,
        credentialResult: { written: true },
      };
    } catch (err) {
      const errMessage = err instanceof Error ? err.message : String(err);
      log.warn(
        { workspaceId, teamId, err: errMessage },
        "Slack install record written but chat_cache credential write failed — Reconnect required",
      );
      return {
        workspaceId,
        catalogId: SLACK_SLUG,
        installRecord,
        credentialResult: {
          written: false,
          reason: "Credential persist failed — admin should retry via Reconnect",
        },
      };
    }
  }
}
