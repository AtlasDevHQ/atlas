/**
 * Salesforce access-token refresh (#2658).
 *
 * Salesforce access tokens are short-lived; the rotation flow exchanges
 * the stored `refresh_token` for a fresh `access_token` against
 * `<loginUrl>/services/oauth2/token` with `grant_type=refresh_token`.
 *
 * Outcomes:
 *
 *   - Refresh succeeded: persist the new bundle (the existing
 *     refresh_token usually rolls forward — Salesforce sometimes
 *     returns a new one, sometimes not — we keep whichever non-empty
 *     value we have so the chain doesn't break), bump
 *     `integration_credentials.updated_at`, and return the bundle.
 *
 *   - Refresh failed in a way that proves the install is broken
 *     (revoked Connected App, deleted user, etc. — Salesforce returns
 *     `invalid_grant`): flip `workspace_plugins.config.status` to
 *     `"reconnect_needed"`. The admin UI surfaces a Reconnect CTA on
 *     the integration card; until the admin re-runs the OAuth dance
 *     the install is in a quarantined state.
 *
 *   - Refresh failed transiently (network blip, 5xx): throw without
 *     marking reconnect-needed. The agent loop's next call retries.
 *
 * The classification "permanent vs. transient" is the key complexity:
 *   - Permanent → `invalid_grant`, `invalid_client`, `inactive_user`,
 *     `org_locked`, `inactive_org`. Treat HTTP 400 with any of these
 *     codes as permanent.
 *   - Transient → network failures, 5xx, unparseable bodies, and
 *     `rate_limit_exceeded` (Salesforce's OAuth token endpoint has a
 *     short-window per-org throttle that recovers automatically; if we
 *     flipped reconnect-needed on a rate limit the admin would re-run
 *     OAuth uselessly while the next refresh would have worked). No
 *     reconnect-needed marker; let the caller retry on next tool call.
 *
 * @see ./salesforce-oauth-handler.ts — the initial OAuth dance
 * @see ../credentials/store.ts — the credential bundle store
 */

import { createLogger } from "@atlas/api/lib/logger";
import { internalQuery } from "@atlas/api/lib/db/internal";
import {
  readCredentialBundle,
  saveCredentialBundle,
  type CredentialBundle,
} from "@atlas/api/lib/integrations/credentials/store";
import { SalesforceReconnectRequiredError } from "@atlas/api/lib/effect/errors";
import {
  DEFAULT_ACCESS_TOKEN_LIFETIME_MS,
  SALESFORCE_CATALOG_ID,
  SALESFORCE_SLUG,
} from "./salesforce-oauth-handler";

// Re-export so the lazy-builder + callers that already pull from this
// module keep working. Canonical definition lives in `effect/errors.ts`
// so the error participates in the `AtlasError` union + `mapTaggedError`
// exhaustive switch (409 Conflict + `reconnect_required` wire code).
export { SalesforceReconnectRequiredError };

const log = createLogger("integrations.install.salesforce-refresh");

/**
 * Salesforce error codes that prove the install will never recover
 * without a fresh OAuth dance. Sourced from the Salesforce OAuth 2.0
 * Refresh Token Flow docs — kept narrow on purpose; an unknown error
 * code on an HTTP 400 surfaces as a transient throw so we don't
 * mis-classify the install as "reconnect needed" without evidence.
 */
const PERMANENT_REFRESH_FAILURE_CODES = new Set([
  "invalid_grant",
  "invalid_client",
  "invalid_client_id",
  "inactive_user",
  "org_locked",
  "inactive_org",
]);

interface SalesforceRefreshSuccess {
  readonly access_token: string;
  readonly refresh_token?: string;
  readonly instance_url?: string;
  readonly token_type?: string;
  readonly issued_at?: string;
  readonly scope?: string;
  readonly id_token?: string;
}

interface SalesforceRefreshFailure {
  readonly error: string;
  readonly error_description?: string;
}

type SalesforceRefreshResponse = SalesforceRefreshSuccess | SalesforceRefreshFailure;

function isRefreshSuccess(r: SalesforceRefreshResponse): r is SalesforceRefreshSuccess {
  return "access_token" in r && typeof r.access_token === "string";
}

interface RefreshArgs {
  readonly loginUrl: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly refreshToken: string;
}

/**
 * POST `<loginUrl>/services/oauth2/token` with `grant_type=refresh_token`.
 * On HTTP 400 carrying one of the {@link PERMANENT_REFRESH_FAILURE_CODES}
 * codes, throws `SalesforceReconnectRequiredError`. On anything else
 * (network failure, 5xx, unknown 4xx), throws a plain `Error` so the
 * caller treats it as transient.
 */
async function exchangeRefreshToken(
  args: RefreshArgs,
  workspaceId: string,
): Promise<SalesforceRefreshSuccess> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: args.clientId,
    client_secret: args.clientSecret,
    refresh_token: args.refreshToken,
  });

  let resp: Response;
  try {
    resp = await fetch(`${args.loginUrl}/services/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
  } catch (err) {
    // Network failure — transient. Let the caller retry on the next
    // tool call. Don't flip reconnect_needed without evidence.
    throw new Error(
      `Salesforce token endpoint unreachable: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  let parsed: SalesforceRefreshResponse;
  try {
    parsed = (await resp.json()) as SalesforceRefreshResponse;
  } catch (err) {
    throw new Error(
      `Salesforce refresh returned unparseable body (HTTP ${resp.status})`,
      { cause: err },
    );
  }

  if (!resp.ok || !isRefreshSuccess(parsed)) {
    const failure = parsed as SalesforceRefreshFailure;
    const errorCode = failure.error ?? `http_${resp.status}`;
    if (resp.status === 400 && PERMANENT_REFRESH_FAILURE_CODES.has(errorCode)) {
      log.warn(
        { workspaceId, errorCode, description: failure.error_description },
        "Salesforce refresh failed permanently — flagging reconnect_needed",
      );
      throw new SalesforceReconnectRequiredError({
        message: "Salesforce install needs to be reconnected — refresh token rejected by upstream.",
        workspaceId,
        upstreamError: errorCode,
      });
    }
    // Unknown error code or 5xx — treat as transient.
    throw new Error(`Salesforce refresh failed: ${errorCode} (HTTP ${resp.status})`);
  }

  return parsed;
}

/**
 * Mark the install row as `reconnect_needed` in `workspace_plugins.config`.
 * Uses a JSONB set so we don't touch unrelated config fields (instance_url,
 * scopes, etc.). Safe to call multiple times — JSONB `||` is an upsert.
 */
async function markReconnectNeeded(workspaceId: string): Promise<void> {
  try {
    await internalQuery(
      `UPDATE workspace_plugins
          SET config = config || jsonb_build_object('status', 'reconnect_needed')
        WHERE workspace_id = $1 AND catalog_id = $2`,
      [workspaceId, SALESFORCE_CATALOG_ID],
    );
  } catch (err) {
    // The install row vanishing between the credential read and this
    // UPDATE is rare but possible (concurrent disconnect). Log + swallow
    // — the caller already threw `SalesforceReconnectRequiredError`,
    // which is the signal the route surface needs.
    log.warn(
      { workspaceId, err: err instanceof Error ? err.message : String(err) },
      "Failed to mark Salesforce install as reconnect_needed (install row may have been disconnected)",
    );
  }
}

/**
 * Clear the `reconnect_needed` marker on a successful refresh. Idempotent:
 * if the field was already unset (status was "ok"), the JSONB merge with
 * `status: "ok"` is a no-op.
 */
async function clearReconnectNeeded(workspaceId: string): Promise<void> {
  try {
    await internalQuery(
      `UPDATE workspace_plugins
          SET config = config || jsonb_build_object('status', 'ok')
        WHERE workspace_id = $1 AND catalog_id = $2`,
      [workspaceId, SALESFORCE_CATALOG_ID],
    );
  } catch (err) {
    // Log + swallow — the refresh itself already succeeded and the new
    // credentials are persisted. Worst case is a cosmetic stale
    // "Reconnect needed" badge in the admin UI until the next refresh
    // (which will retry this UPDATE). Don't propagate: surfacing this
    // failure would falsely signal that the refresh itself failed, and
    // the agent would unnecessarily evict the cached plugin instance
    // built on the freshly-rotated token.
    log.warn(
      { workspaceId, err: err instanceof Error ? err.message : String(err) },
      "Failed to clear reconnect_needed flag after successful Salesforce refresh",
    );
  }
}

export interface RefreshSalesforceTokenArgs {
  readonly workspaceId: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly loginUrl?: string;
}

/**
 * Refresh the Salesforce access token for `workspaceId`. Returns the
 * updated `CredentialBundle` (also persisted to
 * `integration_credentials`). On permanent failure throws
 * `SalesforceReconnectRequiredError` and flips
 * `workspace_plugins.config.status` to `"reconnect_needed"`.
 *
 * Callers (LazyPluginLoader builder, agent tool-call wrapper) catch
 * the tagged error to evict the cached plugin instance and surface a
 * specific message to the agent / admin UI.
 */
export async function refreshSalesforceToken(
  args: RefreshSalesforceTokenArgs,
): Promise<CredentialBundle> {
  const bundle = await readCredentialBundle(args.workspaceId, SALESFORCE_CATALOG_ID);
  if (!bundle) {
    throw new Error(
      `No Salesforce credentials found for workspace ${args.workspaceId} — install was disconnected`,
    );
  }
  if (!bundle.refreshToken) {
    // No refresh_token in the bundle — this happens when the operator's
    // Connected App didn't grant `refresh_token` scope. Surface as
    // reconnect-needed so admin re-runs the dance with a Connected App
    // that does grant it.
    log.warn(
      { workspaceId: args.workspaceId },
      "Salesforce credential bundle has no refresh_token — flagging reconnect_needed",
    );
    await markReconnectNeeded(args.workspaceId);
    throw new SalesforceReconnectRequiredError({
      message: "Salesforce install has no refresh token — Connected App must grant the refresh_token / offline_access scopes.",
      workspaceId: args.workspaceId,
      upstreamError: "no_refresh_token",
    });
  }

  const loginUrl = (args.loginUrl ?? "https://login.salesforce.com").replace(/\/+$/, "");

  let refreshed: SalesforceRefreshSuccess;
  try {
    refreshed = await exchangeRefreshToken(
      {
        loginUrl,
        clientId: args.clientId,
        clientSecret: args.clientSecret,
        refreshToken: bundle.refreshToken,
      },
      args.workspaceId,
    );
  } catch (err) {
    if (err instanceof SalesforceReconnectRequiredError) {
      await markReconnectNeeded(args.workspaceId);
    }
    throw err;
  }

  // Salesforce typically does NOT return a new refresh_token (the
  // existing one keeps working); preserve the stored value when the
  // refresh response omits it.
  const nextRefreshToken = refreshed.refresh_token ?? bundle.refreshToken;
  const issuedMs = refreshed.issued_at ? Number.parseInt(refreshed.issued_at, 10) : NaN;
  const expiresAt = Number.isFinite(issuedMs) ? issuedMs + DEFAULT_ACCESS_TOKEN_LIFETIME_MS : null;

  const next: CredentialBundle = {
    accessToken: refreshed.access_token,
    refreshToken: nextRefreshToken,
    expiresAt,
    tokenType: refreshed.token_type ?? bundle.tokenType,
    scope: refreshed.scope ?? bundle.scope,
    instanceUrl: refreshed.instance_url ?? bundle.instanceUrl,
    ...(refreshed.id_token
      ? { extra: { ...(bundle.extra ?? {}), id_token: refreshed.id_token } }
      : bundle.extra
        ? { extra: bundle.extra }
        : {}),
  };

  await saveCredentialBundle(args.workspaceId, SALESFORCE_CATALOG_ID, next);
  // If the install had previously been flagged for reconnect, the
  // successful refresh clears it. Independent UPDATE (not part of the
  // credential write transaction) so a failure to clear the flag
  // doesn't roll back a successful refresh — the worst case is a
  // cosmetic "Reconnect needed" lingering until the next refresh.
  await clearReconnectNeeded(args.workspaceId);

  log.info(
    { workspaceId: args.workspaceId, instanceUrl: next.instanceUrl },
    "Salesforce token refreshed successfully",
  );
  return next;
}

/** Re-export to keep the slug constant in one place for catalog wiring. */
export { SALESFORCE_SLUG, SALESFORCE_CATALOG_ID };
