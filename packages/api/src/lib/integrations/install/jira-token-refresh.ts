/**
 * Jira access-token refresh (#2659).
 *
 * Mirrors {@link ./salesforce-token-refresh.ts}; Atlassian-specific
 * twists:
 *
 *   - **Refresh tokens rotate on every refresh.** Atlassian returns a
 *     fresh `refresh_token` in the success response and the previous
 *     value MUST NOT be reused; persisting the new value back to
 *     `integration_credentials` is non-optional, not opportunistic
 *     (Salesforce sometimes returns one, sometimes not — we kept the
 *     old value when omitted).
 *   - **Permanent failures classify the same way.** Atlassian returns
 *     `invalid_grant` when the stored refresh token is rejected; we
 *     flip `workspace_plugins.config.status` to `"reconnect_needed"`
 *     and surface `IntegrationReconnectRequiredError`.
 *   - **Operator-side misconfig stays transient.** `invalid_client` is
 *     wrong env (`JIRA_CLIENT_ID` / `JIRA_CLIENT_SECRET` typo); marking
 *     the workspace `reconnect_needed` would force every tenant admin
 *     to re-run OAuth after the operator fixes the env. Treated as
 *     transient like Salesforce.
 *
 * @see ./jira-oauth-handler.ts — the initial OAuth dance
 * @see ./salesforce-token-refresh.ts — first reference implementation
 * @see ../credentials/store.ts — the credential bundle store
 */

import { createLogger } from "@atlas/api/lib/logger";
import { internalQuery } from "@atlas/api/lib/db/internal";
import {
  readCredentialBundle,
  saveCredentialBundle,
  type CredentialBundle,
} from "@atlas/api/lib/integrations/credentials/store";
import { IntegrationReconnectRequiredError } from "@atlas/api/lib/effect/errors";
import { JIRA_CATALOG_ID, JIRA_SLUG } from "./jira-oauth-handler";

// Re-export so the lazy-builder + future callers can pull from this
// module. Canonical definition lives in `effect/errors.ts` so the error
// participates in the `AtlasError` union + `mapTaggedError` exhaustive
// switch (409 Conflict + `conflict` wire code).
export { IntegrationReconnectRequiredError };
/** @deprecated #2708 — use {@link IntegrationReconnectRequiredError}; alias removed next release. */
export { JiraReconnectRequiredError } from "@atlas/api/lib/effect/errors";

const log = createLogger("integrations.install.jira-refresh");

const TOKEN_URL = "https://auth.atlassian.com/oauth/token";

/**
 * Atlassian error codes that prove the install will never recover
 * without a fresh OAuth dance. `invalid_grant` is the canonical
 * "refresh token rejected" code from RFC 6749. Kept narrow on purpose
 * — an unknown error code surfaces as transient so we don't mis-classify
 * the install as "reconnect needed" without evidence.
 */
const PERMANENT_REFRESH_FAILURE_CODES = new Set([
  "invalid_grant",
  "unauthorized_client",
  "access_denied",
]);

interface JiraRefreshSuccess {
  readonly access_token: string;
  readonly refresh_token: string;
  readonly expires_in?: number;
  readonly token_type?: string;
  readonly scope?: string;
}

interface JiraRefreshFailure {
  readonly error: string;
  readonly error_description?: string;
}

type JiraRefreshResponse = JiraRefreshSuccess | JiraRefreshFailure;

function isRefreshSuccess(r: JiraRefreshResponse): r is JiraRefreshSuccess {
  return (
    "access_token" in r &&
    typeof r.access_token === "string" &&
    "refresh_token" in r &&
    typeof r.refresh_token === "string"
  );
}

interface RefreshArgs {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly refreshToken: string;
}

/**
 * POST `auth.atlassian.com/oauth/token` with `grant_type=refresh_token`.
 * On HTTP 4xx carrying one of the {@link PERMANENT_REFRESH_FAILURE_CODES},
 * throws `IntegrationReconnectRequiredError`. On anything else (network failure,
 * 5xx, unknown 4xx), throws a plain `Error` so the caller treats it as
 * transient.
 */
async function exchangeRefreshToken(
  args: RefreshArgs,
  workspaceId: string,
): Promise<JiraRefreshSuccess> {
  let resp: Response;
  try {
    resp = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        client_id: args.clientId,
        client_secret: args.clientSecret,
        refresh_token: args.refreshToken,
      }),
    });
  } catch (err) {
    // Network failure — transient. Let the caller retry on the next
    // tool call. Don't flip reconnect_needed without evidence.
    throw new Error(
      `Atlassian token endpoint unreachable: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  let parsed: JiraRefreshResponse;
  try {
    parsed = (await resp.json()) as JiraRefreshResponse;
  } catch (err) {
    throw new Error(
      `Atlassian refresh returned unparseable body (HTTP ${resp.status})`,
      { cause: err },
    );
  }

  if (!resp.ok || !isRefreshSuccess(parsed)) {
    const failure = parsed as JiraRefreshFailure;
    const errorCode = failure.error ?? `http_${resp.status}`;
    if (resp.status >= 400 && resp.status < 500 && PERMANENT_REFRESH_FAILURE_CODES.has(errorCode)) {
      log.warn(
        { workspaceId, errorCode, description: failure.error_description },
        "Jira refresh failed permanently — flagging reconnect_needed",
      );
      throw new IntegrationReconnectRequiredError({
        message: "Jira install needs to be reconnected — refresh token rejected by Atlassian.",
        workspaceId,
        platform: "jira",
        upstreamError: errorCode,
      });
    }
    // Unknown error code or 5xx — treat as transient.
    throw new Error(`Jira refresh failed: ${errorCode} (HTTP ${resp.status})`);
  }

  return parsed;
}

/**
 * Mark the install row as `reconnect_needed`. JSONB merge so unrelated
 * config fields (cloudid, scopes, etc.) survive.
 */
async function markReconnectNeeded(workspaceId: string): Promise<void> {
  try {
    await internalQuery(
      `UPDATE workspace_plugins
          SET config = config || jsonb_build_object('status', 'reconnect_needed')
        WHERE workspace_id = $1 AND catalog_id = $2`,
      [workspaceId, JIRA_CATALOG_ID],
    );
  } catch (err) {
    log.warn(
      { workspaceId, err: err instanceof Error ? err.message : String(err) },
      "Failed to mark Jira install as reconnect_needed (install row may have been disconnected)",
    );
  }
}

/**
 * Clear the `reconnect_needed` marker on a successful refresh. Idempotent.
 */
async function clearReconnectNeeded(workspaceId: string): Promise<void> {
  try {
    await internalQuery(
      `UPDATE workspace_plugins
          SET config = config || jsonb_build_object('status', 'ok')
        WHERE workspace_id = $1 AND catalog_id = $2`,
      [workspaceId, JIRA_CATALOG_ID],
    );
  } catch (err) {
    log.warn(
      { workspaceId, err: err instanceof Error ? err.message : String(err) },
      "Failed to clear reconnect_needed flag after successful Jira refresh",
    );
  }
}

export interface RefreshJiraTokenArgs {
  readonly workspaceId: string;
  readonly clientId: string;
  readonly clientSecret: string;
}

/**
 * Refresh the Jira access token for `workspaceId`. Returns the updated
 * `CredentialBundle` (also persisted to `integration_credentials` with
 * the rotated refresh_token). On permanent failure throws
 * `IntegrationReconnectRequiredError` and flips
 * `workspace_plugins.config.status` to `"reconnect_needed"`.
 */
export async function refreshJiraToken(
  args: RefreshJiraTokenArgs,
): Promise<CredentialBundle> {
  const bundle = await readCredentialBundle(args.workspaceId, JIRA_CATALOG_ID);
  if (!bundle) {
    throw new Error(
      `No Jira credentials found for workspace ${args.workspaceId} — install was disconnected`,
    );
  }
  if (!bundle.refreshToken) {
    log.warn(
      { workspaceId: args.workspaceId },
      "Jira credential bundle has no refresh_token — flagging reconnect_needed",
    );
    await markReconnectNeeded(args.workspaceId);
    throw new IntegrationReconnectRequiredError({
      message: "Jira install has no refresh token — App must grant the offline_access scope.",
      workspaceId: args.workspaceId,
      platform: "jira",
      upstreamError: "no_refresh_token",
    });
  }

  let refreshed: JiraRefreshSuccess;
  try {
    refreshed = await exchangeRefreshToken(
      {
        clientId: args.clientId,
        clientSecret: args.clientSecret,
        refreshToken: bundle.refreshToken,
      },
      args.workspaceId,
    );
  } catch (err) {
    if (err instanceof IntegrationReconnectRequiredError) {
      await markReconnectNeeded(args.workspaceId);
    }
    throw err;
  }

  // Atlassian rotates the refresh token on every refresh — `refresh_token`
  // is required in the success response. The `isRefreshSuccess` guard
  // already asserted both fields are present, so we don't fall back to
  // the old value the way Salesforce does.
  const expiresAt =
    typeof refreshed.expires_in === "number" && Number.isFinite(refreshed.expires_in)
      ? Date.now() + refreshed.expires_in * 1000
      : null;

  const next: CredentialBundle = {
    accessToken: refreshed.access_token,
    refreshToken: refreshed.refresh_token,
    expiresAt,
    tokenType: refreshed.token_type ?? bundle.tokenType,
    scope: refreshed.scope ?? bundle.scope,
    instanceUrl: bundle.instanceUrl,
    ...(bundle.extra ? { extra: bundle.extra } : {}),
  };

  await saveCredentialBundle(args.workspaceId, JIRA_CATALOG_ID, next);
  // Independent UPDATE so a failure to clear the flag doesn't roll back
  // a successful refresh.
  await clearReconnectNeeded(args.workspaceId);

  log.info(
    { workspaceId: args.workspaceId, instanceUrl: next.instanceUrl },
    "Jira token refreshed successfully",
  );
  return next;
}

/** Re-export to keep the slug constant in one place for catalog wiring. */
export { JIRA_SLUG, JIRA_CATALOG_ID };
