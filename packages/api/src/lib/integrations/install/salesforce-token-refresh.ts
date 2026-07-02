/**
 * Salesforce access-token refresh (#2658) — a config over the shared
 * {@link refreshOAuthCredential} flow (#4188).
 *
 * Salesforce exchanges the stored `refresh_token` for a fresh
 * `access_token` against `<loginUrl>/services/oauth2/token`. The
 * Salesforce-specific dimensions captured in
 * {@link SALESFORCE_REFRESH_CONFIG} + {@link refreshSalesforceToken}:
 *
 *   - **Per-tenant token URL.** The login host is operator-supplied
 *     (`SALESFORCE_LOGIN_URL`, default `login.salesforce.com`), so the
 *     token URL is resolved per call rather than a module constant.
 *   - **Refresh token usually rolls forward.** Salesforce sometimes
 *     returns a new `refresh_token`, sometimes not — we keep whichever
 *     non-empty value we have (`requiresRefreshTokenInResponse: false`;
 *     `toBundle` falls back to the stored value) so the chain doesn't
 *     break.
 *   - **Permanent failure classification.** `invalid_grant` /
 *     `inactive_user` / `org_locked` / `inactive_org` flip
 *     `reconnect_needed`, but ONLY on an HTTP 400. `invalid_client` /
 *     `rate_limit_exceeded` and 5xx stay transient — operator-side or
 *     recoverable failures must not force every tenant admin to re-OAuth.
 *
 * @see ./oauth-token-refresh.ts — the shared exchange + classification flow
 * @see ./salesforce-oauth-handler.ts — the initial OAuth dance
 * @see ../credentials/store.ts — the credential bundle store
 */

import type { CredentialBundle } from "@atlas/api/lib/integrations/credentials/store";
import { IntegrationReconnectRequiredError } from "@atlas/api/lib/effect/errors";
import {
  refreshOAuthCredential,
  type OAuthRefreshConfig,
} from "./oauth-token-refresh";
import {
  DEFAULT_ACCESS_TOKEN_LIFETIME_MS,
  SALESFORCE_CATALOG_ID,
  SALESFORCE_SLUG,
} from "./salesforce-oauth-handler";

// Re-export so the lazy-builder + callers that pull from this module keep
// working. Canonical definition lives in `effect/errors.ts` so the error
// participates in the `AtlasError` union + `mapTaggedError` exhaustive
// switch (409 Conflict + `conflict` wire code).
export { IntegrationReconnectRequiredError };
/** @deprecated #2708 — use {@link IntegrationReconnectRequiredError}; alias removed next release. */
export { SalesforceReconnectRequiredError } from "@atlas/api/lib/effect/errors";

const DEFAULT_LOGIN_URL = "https://login.salesforce.com";

/**
 * Salesforce error codes that prove the install will never recover
 * without a fresh OAuth dance. Sourced from the Salesforce OAuth 2.0
 * Refresh Token Flow docs — kept narrow on purpose; an unknown error
 * code on an HTTP 400 surfaces as a transient throw so we don't
 * mis-classify the install as "reconnect needed" without evidence.
 */
const PERMANENT_REFRESH_FAILURE_CODES = new Set([
  "invalid_grant",
  "inactive_user",
  "org_locked",
  "inactive_org",
]);

const SALESFORCE_REFRESH_CONFIG: OAuthRefreshConfig = {
  platform: "salesforce",
  displayName: "Salesforce",
  endpointName: "Salesforce",
  catalogId: SALESFORCE_CATALOG_ID,
  logName: "integrations.install.salesforce-refresh",
  bodyEncoding: "form",
  requiresRefreshTokenInResponse: false,
  permanentFailureCodes: PERMANENT_REFRESH_FAILURE_CODES,
  isPermanentFailureStatus: (status) => status === 400,
  noRefreshTokenMessage:
    "Salesforce install has no refresh token — Connected App must grant the refresh_token / offline_access scopes.",
  refreshRejectedMessage:
    "Salesforce install needs to be reconnected — refresh token rejected by upstream.",
  // Salesforce typically does NOT return a new refresh_token (the
  // existing one keeps working); preserve the stored value when the
  // refresh response omits it, and carry a rotated id_token into `extra`.
  toBundle: (r, stored) => {
    const issuedMs = r.issued_at ? Number.parseInt(r.issued_at, 10) : NaN;
    const expiresAt = Number.isFinite(issuedMs) ? issuedMs + DEFAULT_ACCESS_TOKEN_LIFETIME_MS : null;
    return {
      accessToken: r.access_token,
      refreshToken: r.refresh_token ?? stored.refreshToken,
      expiresAt,
      tokenType: r.token_type ?? stored.tokenType,
      scope: r.scope ?? stored.scope,
      instanceUrl: r.instance_url ?? stored.instanceUrl,
      ...(r.id_token
        ? { extra: { ...(stored.extra ?? {}), id_token: r.id_token } }
        : stored.extra
          ? { extra: stored.extra }
          : {}),
    };
  },
};

export interface RefreshSalesforceTokenArgs {
  readonly workspaceId: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly loginUrl?: string;
}

/**
 * Refresh the Salesforce access token for `workspaceId`. Returns the
 * updated `CredentialBundle` (also persisted to `integration_credentials`).
 * On permanent failure throws `IntegrationReconnectRequiredError` and
 * flips `workspace_plugins.config.status` to `"reconnect_needed"`.
 *
 * Callers (LazyPluginLoader builder, agent tool-call wrapper) catch the
 * tagged error to evict the cached plugin instance and surface a specific
 * message to the agent / admin UI.
 */
export function refreshSalesforceToken(
  args: RefreshSalesforceTokenArgs,
): Promise<CredentialBundle> {
  const loginUrl = (args.loginUrl ?? DEFAULT_LOGIN_URL).replace(/\/+$/, "");
  return refreshOAuthCredential(
    SALESFORCE_REFRESH_CONFIG,
    args,
    `${loginUrl}/services/oauth2/token`,
  );
}

/** Re-export to keep the slug constant in one place for catalog wiring. */
export { SALESFORCE_SLUG, SALESFORCE_CATALOG_ID };
