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
import { internalQuery } from "@atlas/api/lib/db/internal";
import { slackAPI } from "@atlas/api/lib/slack/api";
import { saveInstallation } from "@atlas/api/lib/slack/store";
import { PlatformOAuthExchangeError } from "@atlas/api/lib/effect/errors";
import type { WorkspaceId } from "@useatlas/types";
import {
  mintOAuthStateToken,
  verifyOAuthStateToken,
} from "./oauth-state-token";
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
 * OAuth scopes requested at install time. Preserved verbatim from the
 * legacy slack.ts install route so the upgrade is invisible to existing
 * dogfood installs (the scopes determine the bot token's capabilities
 * — a subset of these would silently break `/atlas` slash commands).
 */
const SLACK_SCOPES = "commands,chat:write,app_mentions:read";

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
    // ── 1. Verify state token — null on every failure mode ────────
    const verified = verifyOAuthStateToken(stateToken);
    if (!verified) return null;
    // Promote the verified workspaceId string to the brand. The token
    // was minted from a branded WorkspaceId at startInstall time; the
    // signed payload guarantees the round-trip preserves the same
    // bytes, so the assertion is sound here. We don't pull
    // `assertWorkspaceId` from `@useatlas/chat` (used at the proactive
    // listener boundary) because that helper rejects empty strings —
    // which the token verifier already filters out — and would add a
    // cross-package dep this module otherwise doesn't need.
    const workspaceId = verified.workspaceId as WorkspaceId;
    if (verified.catalogId !== SLACK_SLUG) {
      // A token bound to a different catalog slug shouldn't reach the
      // Slack handler — the dispatch routes by slug. If it does, it's
      // a bug or a cross-catalog forge attempt; treat as invalid state.
      log.warn(
        { expected: SLACK_SLUG, got: verified.catalogId },
        "Slack OAuth callback received state bound to a different catalog — rejecting",
      );
      return null;
    }

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

    // ── 3. Install record — workspace_plugins INSERT (first store) ──
    // Stable id per row — derived once so retries land on the same
    // unique-index hit. ON CONFLICT updates `config`/`enabled` rather
    // than swapping the id, so cross-store joins stay stable.
    const installId = crypto.randomUUID();
    const installConfig = {
      team_id: teamId,
      team_name: teamName,
      bot_user_id: botUserId,
      scopes,
      app_id: appId,
    };
    try {
      await internalQuery(
        `INSERT INTO workspace_plugins (id, workspace_id, catalog_id, config, enabled, installed_at)
         VALUES ($1, $2, $3, $4::jsonb, true, NOW())
         ON CONFLICT (workspace_id, catalog_id) DO UPDATE
           SET config = EXCLUDED.config,
               enabled = true`,
        [installId, workspaceId, SLACK_CATALOG_ID, JSON.stringify(installConfig)],
      );
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

    const installRecord: InstallRecord = {
      id: installId,
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
