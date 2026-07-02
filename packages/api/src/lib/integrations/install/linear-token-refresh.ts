/**
 * Linear access-token refresh (#2750) — a config over the shared
 * {@link refreshOAuthCredential} flow (#4188).
 *
 * Linear-specific dimensions captured in {@link LINEAR_REFRESH_CONFIG}:
 *
 *   - **Form-encoded token body.** Linear's `/oauth/token` accepts
 *     `application/x-www-form-urlencoded`, matching Salesforce (Atlassian
 *     is the odd one out with JSON).
 *   - **Refresh tokens rotate on every refresh.** Like Atlassian, Linear
 *     returns a fresh `refresh_token` and the previous value MUST NOT be
 *     reused (`requiresRefreshTokenInResponse: true`).
 *   - **Permanent failure classification.** Only `invalid_grant` /
 *     `unauthorized_client` / `access_denied` flip `reconnect_needed`;
 *     `invalid_client` stays transient (operator-side env misconfig
 *     should not force every tenant admin to re-OAuth). Any 4xx qualifies
 *     for permanent classification.
 *
 * @see ./oauth-token-refresh.ts — the shared exchange + classification flow
 * @see ./linear-oauth-handler.ts — the initial OAuth dance
 * @see ../credentials/store.ts — the credential bundle store
 */

import type { CredentialBundle } from "@atlas/api/lib/integrations/credentials/store";
import { IntegrationReconnectRequiredError } from "@atlas/api/lib/effect/errors";
import {
  refreshOAuthCredential,
  expiresInToAbsolute,
  type OAuthRefreshConfig,
} from "./oauth-token-refresh";
import { LINEAR_CATALOG_ID, LINEAR_SLUG } from "./linear-oauth-handler";

// Re-export so the lazy-builder + future callers can pull from this
// module. Canonical definition lives in `effect/errors.ts` so the error
// participates in the `AtlasError` union + `mapTaggedError` exhaustive
// switch (409 Conflict + `conflict` wire code, alongside Salesforce + Jira).
export { IntegrationReconnectRequiredError };
/** @deprecated #2708 — use {@link IntegrationReconnectRequiredError}; alias removed next release. */
export { LinearReconnectRequiredError } from "@atlas/api/lib/effect/errors";

const TOKEN_URL = "https://api.linear.app/oauth/token";

/**
 * Linear error codes that prove the install will never recover without a
 * fresh OAuth dance. `invalid_grant` is RFC 6749's "refresh token
 * rejected"; `unauthorized_client` and `access_denied` cover scope
 * revocation. `invalid_client` is intentionally NOT in this set — that
 * signals wrong env wiring (`LINEAR_CLIENT_ID`/`SECRET` typo), not a
 * per-Workspace problem.
 */
const PERMANENT_REFRESH_FAILURE_CODES = new Set([
  "invalid_grant",
  "unauthorized_client",
  "access_denied",
]);

const LINEAR_REFRESH_CONFIG: OAuthRefreshConfig = {
  platform: "linear",
  displayName: "Linear",
  endpointName: "Linear",
  catalogId: LINEAR_CATALOG_ID,
  logName: "integrations.install.linear-refresh",
  bodyEncoding: "form",
  requiresRefreshTokenInResponse: true,
  permanentFailureCodes: PERMANENT_REFRESH_FAILURE_CODES,
  isPermanentFailureStatus: (status) => status >= 400 && status < 500,
  noRefreshTokenMessage:
    "Linear install has no refresh token — App must request the offline scope.",
  refreshRejectedMessage:
    "Linear install needs to be reconnected — refresh token rejected by Linear.",
  // Linear rotates the refresh token on every refresh — the success
  // guard already asserted it's present, so we don't fall back to the
  // stored value the way Salesforce sometimes does.
  toBundle: (r, stored) => ({
    accessToken: r.access_token,
    refreshToken: r.refresh_token ?? stored.refreshToken,
    expiresAt: expiresInToAbsolute(r.expires_in),
    tokenType: r.token_type ?? stored.tokenType,
    scope: r.scope ?? stored.scope,
    instanceUrl: stored.instanceUrl,
    ...(stored.extra ? { extra: stored.extra } : {}),
  }),
};

export interface RefreshLinearTokenArgs {
  readonly workspaceId: string;
  readonly clientId: string;
  readonly clientSecret: string;
}

/**
 * Refresh the Linear access token for `workspaceId`. Returns the updated
 * `CredentialBundle` (also persisted to `integration_credentials` with
 * the rotated refresh_token). On permanent failure throws
 * `IntegrationReconnectRequiredError` and flips
 * `workspace_plugins.config.status` to `"reconnect_needed"`.
 */
export function refreshLinearToken(args: RefreshLinearTokenArgs): Promise<CredentialBundle> {
  return refreshOAuthCredential(LINEAR_REFRESH_CONFIG, args, TOKEN_URL);
}

/** Re-export to keep the slug constant in one place for catalog wiring. */
export { LINEAR_SLUG, LINEAR_CATALOG_ID };
