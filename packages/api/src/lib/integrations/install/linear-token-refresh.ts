/**
 * Linear access-token refresh (#2750).
 *
 * Mirrors {@link ./jira-token-refresh.ts}; Linear-specific twists:
 *
 *   - **Refresh tokens rotate on every refresh.** Like Atlassian, Linear
 *     returns a fresh `refresh_token` in the success response and the
 *     previous value MUST NOT be reused. Persisting the new value back
 *     to `integration_credentials` is non-optional.
 *   - **Token endpoint is form-encoded.** Linear's `/oauth/token`
 *     accepts `application/x-www-form-urlencoded`, matching Salesforce
 *     (Atlassian is the odd one out with JSON).
 *   - **Permanent failures classify the same way.** Linear returns
 *     `invalid_grant` when the stored refresh token is rejected and
 *     `invalid_client` when the OAuth App credentials are wrong. Only
 *     `invalid_grant` and Linear-side scope revocation flip
 *     `reconnect_needed`; `invalid_client` stays transient (operator-
 *     side env misconfig should not force every tenant admin to re-
 *     OAuth after the operator fixes the env).
 *
 * @see ./linear-oauth-handler.ts — the initial OAuth dance
 * @see ./jira-token-refresh.ts — sibling reference implementation
 * @see ../credentials/store.ts — the credential bundle store
 */

import { createLogger } from "@atlas/api/lib/logger";
import { internalQuery } from "@atlas/api/lib/db/internal";
import {
  readCredentialBundle,
  saveCredentialBundle,
  type CredentialBundle,
} from "@atlas/api/lib/integrations/credentials/store";
import { LinearReconnectRequiredError } from "@atlas/api/lib/effect/errors";
import { LINEAR_CATALOG_ID, LINEAR_SLUG } from "./linear-oauth-handler";

// Re-export so the lazy-builder + future callers can pull from this
// module. Canonical definition lives in `effect/errors.ts` so the error
// participates in the `AtlasError` union + `mapTaggedError` exhaustive
// switch (409 Conflict + `conflict` wire code, alongside Salesforce + Jira).
export { LinearReconnectRequiredError };

const log = createLogger("integrations.install.linear-refresh");

const TOKEN_URL = "https://api.linear.app/oauth/token";

/**
 * Linear error codes that prove the install will never recover without
 * a fresh OAuth dance. `invalid_grant` is RFC 6749's "refresh token
 * rejected"; `unauthorized_client` and `access_denied` cover scope
 * revocation. Kept narrow on purpose — an unknown error code surfaces
 * as transient so we don't mis-classify the install as "reconnect
 * needed" without evidence.
 *
 * `invalid_client` is intentionally NOT in this set — that signals
 * wrong env wiring (`LINEAR_CLIENT_ID` / `LINEAR_CLIENT_SECRET` typo),
 * not a per-Workspace problem.
 */
const PERMANENT_REFRESH_FAILURE_CODES = new Set([
  "invalid_grant",
  "unauthorized_client",
  "access_denied",
]);

interface LinearRefreshSuccess {
  readonly access_token: string;
  readonly refresh_token: string;
  readonly expires_in?: number;
  readonly token_type?: string;
  readonly scope?: string;
}

interface LinearRefreshFailure {
  readonly error: string;
  readonly error_description?: string;
}

type LinearRefreshResponse = LinearRefreshSuccess | LinearRefreshFailure;

function isRefreshSuccess(r: LinearRefreshResponse): r is LinearRefreshSuccess {
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
 * POST `api.linear.app/oauth/token` with `grant_type=refresh_token`.
 * On HTTP 4xx carrying one of the {@link PERMANENT_REFRESH_FAILURE_CODES},
 * throws `LinearReconnectRequiredError`. On anything else (network failure,
 * 5xx, unknown 4xx, `invalid_client`), throws a plain `Error` so the
 * caller treats it as transient.
 */
async function exchangeRefreshToken(
  args: RefreshArgs,
  workspaceId: string,
): Promise<LinearRefreshSuccess> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: args.clientId,
    client_secret: args.clientSecret,
    refresh_token: args.refreshToken,
  });

  let resp: Response;
  try {
    resp = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
  } catch (err) {
    // Network failure — transient. Let the caller retry on the next
    // tool call. Don't flip reconnect_needed without evidence.
    throw new Error(
      `Linear token endpoint unreachable: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  let parsed: LinearRefreshResponse;
  try {
    parsed = (await resp.json()) as LinearRefreshResponse;
  } catch (err) {
    throw new Error(
      `Linear refresh returned unparseable body (HTTP ${resp.status})`,
      { cause: err },
    );
  }

  if (!resp.ok || !isRefreshSuccess(parsed)) {
    const failure = parsed as LinearRefreshFailure;
    const errorCode = failure.error ?? `http_${resp.status}`;
    if (resp.status >= 400 && resp.status < 500 && PERMANENT_REFRESH_FAILURE_CODES.has(errorCode)) {
      log.warn(
        { workspaceId, errorCode, description: failure.error_description },
        "Linear refresh failed permanently — flagging reconnect_needed",
      );
      throw new LinearReconnectRequiredError({
        message: "Linear install needs to be reconnected — refresh token rejected by Linear.",
        workspaceId,
        upstreamError: errorCode,
      });
    }
    // Unknown error code, 5xx, or `invalid_client` (operator env
    // misconfig) — treat as transient.
    throw new Error(`Linear refresh failed: ${errorCode} (HTTP ${resp.status})`);
  }

  return parsed;
}

/**
 * Mark the install row as `reconnect_needed`. JSONB merge so unrelated
 * config fields (organization_id, scopes, etc.) survive.
 */
async function markReconnectNeeded(workspaceId: string): Promise<void> {
  try {
    await internalQuery(
      `UPDATE workspace_plugins
          SET config = config || jsonb_build_object('status', 'reconnect_needed')
        WHERE workspace_id = $1 AND catalog_id = $2`,
      [workspaceId, LINEAR_CATALOG_ID],
    );
  } catch (err) {
    log.warn(
      { workspaceId, err: err instanceof Error ? err.message : String(err) },
      "Failed to mark Linear install as reconnect_needed (install row may have been disconnected)",
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
      [workspaceId, LINEAR_CATALOG_ID],
    );
  } catch (err) {
    log.warn(
      { workspaceId, err: err instanceof Error ? err.message : String(err) },
      "Failed to clear reconnect_needed flag after successful Linear refresh",
    );
  }
}

export interface RefreshLinearTokenArgs {
  readonly workspaceId: string;
  readonly clientId: string;
  readonly clientSecret: string;
}

/**
 * Refresh the Linear access token for `workspaceId`. Returns the updated
 * `CredentialBundle` (also persisted to `integration_credentials` with
 * the rotated refresh_token). On permanent failure throws
 * `LinearReconnectRequiredError` and flips
 * `workspace_plugins.config.status` to `"reconnect_needed"`.
 */
export async function refreshLinearToken(
  args: RefreshLinearTokenArgs,
): Promise<CredentialBundle> {
  const bundle = await readCredentialBundle(args.workspaceId, LINEAR_CATALOG_ID);
  if (!bundle) {
    throw new Error(
      `No Linear credentials found for workspace ${args.workspaceId} — install was disconnected`,
    );
  }
  if (!bundle.refreshToken) {
    log.warn(
      { workspaceId: args.workspaceId },
      "Linear credential bundle has no refresh_token — flagging reconnect_needed",
    );
    await markReconnectNeeded(args.workspaceId);
    throw new LinearReconnectRequiredError({
      message: "Linear install has no refresh token — App must request the offline scope.",
      workspaceId: args.workspaceId,
      upstreamError: "no_refresh_token",
    });
  }

  let refreshed: LinearRefreshSuccess;
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
    if (err instanceof LinearReconnectRequiredError) {
      await markReconnectNeeded(args.workspaceId);
    }
    throw err;
  }

  // Linear rotates the refresh token on every refresh — `refresh_token`
  // is required in the success response. The `isRefreshSuccess` guard
  // already asserted both fields are present, so we don't fall back to
  // the stored value the way Salesforce sometimes does.
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

  await saveCredentialBundle(args.workspaceId, LINEAR_CATALOG_ID, next);
  // Independent UPDATE so a failure to clear the flag doesn't roll back
  // a successful refresh.
  await clearReconnectNeeded(args.workspaceId);

  log.info(
    { workspaceId: args.workspaceId },
    "Linear token refreshed successfully",
  );
  return next;
}

/** Re-export to keep the slug constant in one place for catalog wiring. */
export { LINEAR_SLUG, LINEAR_CATALOG_ID };
