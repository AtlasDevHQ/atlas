/**
 * Jira access-token refresh (#2659) — a config over the shared
 * {@link refreshOAuthCredential} flow (#4188).
 *
 * Atlassian-specific dimensions captured in {@link JIRA_REFRESH_CONFIG}:
 *
 *   - **JSON token body.** Atlassian's `oauth/token` takes a JSON body
 *     (Salesforce/Linear are form-encoded).
 *   - **Refresh tokens rotate on every refresh.** Atlassian returns a
 *     fresh `refresh_token` in the success response and the previous
 *     value MUST NOT be reused — so the success guard requires it
 *     (`requiresRefreshTokenInResponse: true`) and the rotated value is
 *     persisted back to `integration_credentials`, non-optionally.
 *   - **Permanent failure classification.** `invalid_grant` (RFC 6749's
 *     "refresh token rejected") flips `reconnect_needed`. `invalid_client`
 *     is deliberately absent — it's operator env misconfig
 *     (`JIRA_CLIENT_ID`/`SECRET` typo) and marking every tenant
 *     reconnect-needed would force needless re-OAuth after the operator
 *     fixes the env. Any 4xx qualifies for permanent classification.
 *
 * @see ./oauth-token-refresh.ts — the shared exchange + classification flow
 * @see ./jira-oauth-handler.ts — the initial OAuth dance
 * @see ../credentials/store.ts — the credential bundle store
 */

import type { CredentialBundle } from "@atlas/api/lib/integrations/credentials/store";
import { IntegrationReconnectRequiredError } from "@atlas/api/lib/effect/errors";
import {
  refreshOAuthCredential,
  expiresInToAbsolute,
  type OAuthRefreshConfig,
} from "./oauth-token-refresh";
import { JIRA_CATALOG_ID, JIRA_SLUG } from "./jira-oauth-handler";

// Re-export so the lazy-builder + future callers can pull from this
// module. Canonical definition lives in `effect/errors.ts` so the error
// participates in the `AtlasError` union + `mapTaggedError` exhaustive
// switch (409 Conflict + `conflict` wire code).
export { IntegrationReconnectRequiredError };
/** @deprecated #2708 — use {@link IntegrationReconnectRequiredError}; alias removed next release. */
export { JiraReconnectRequiredError } from "@atlas/api/lib/effect/errors";

const TOKEN_URL = "https://auth.atlassian.com/oauth/token";

/**
 * Atlassian error codes that prove the install will never recover
 * without a fresh OAuth dance. `invalid_grant` is the canonical "refresh
 * token rejected" code from RFC 6749. Kept narrow on purpose — an
 * unknown error code surfaces as transient so we don't mis-classify the
 * install as "reconnect needed" without evidence.
 */
const PERMANENT_REFRESH_FAILURE_CODES = new Set([
  "invalid_grant",
  "unauthorized_client",
  "access_denied",
]);

const JIRA_REFRESH_CONFIG: OAuthRefreshConfig = {
  platform: "jira",
  displayName: "Jira",
  endpointName: "Atlassian",
  catalogId: JIRA_CATALOG_ID,
  logName: "integrations.install.jira-refresh",
  bodyEncoding: "json",
  requiresRefreshTokenInResponse: true,
  permanentFailureCodes: PERMANENT_REFRESH_FAILURE_CODES,
  isPermanentFailureStatus: (status) => status >= 400 && status < 500,
  noRefreshTokenMessage:
    "Jira install has no refresh token — App must grant the offline_access scope.",
  refreshRejectedMessage:
    "Jira install needs to be reconnected — refresh token rejected by Atlassian.",
  // Atlassian rotates the refresh token on every refresh — the success
  // guard already asserted it's present, so we don't fall back to the
  // stored value the way Salesforce does.
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
export function refreshJiraToken(args: RefreshJiraTokenArgs): Promise<CredentialBundle> {
  return refreshOAuthCredential(JIRA_REFRESH_CONFIG, args, TOKEN_URL);
}

/** Re-export to keep the slug constant in one place for catalog wiring. */
export { JIRA_SLUG, JIRA_CATALOG_ID };
