/**
 * `refreshOAuthCredential` — the one refresh-token rotation flow the
 * three per-platform refreshers collapse onto (#4188).
 *
 * `{jira,linear,salesforce}-token-refresh.ts` were ~280–330 LOC each and
 * their headers described each other as mirrors of a sibling refresher.
 * The HTTP exchange, the permanent-vs-transient classification, and the
 * `mark`/`clearReconnectNeeded` orchestration were near-identical modulo
 * the {@link OAuthRefreshConfig} dimensions (body encoding, permanent-code
 * set, status predicate, rotation flag, bundle assembly); only those
 * dimensions actually vary per platform, and everything else lives here
 * once.
 *
 * The classification contract (unchanged from the originals):
 *
 *   - **Permanent** → the install is broken until a fresh OAuth dance.
 *     An HTTP status in `isPermanentFailureStatus` carrying a code in
 *     `permanentFailureCodes` throws {@link IntegrationReconnectRequiredError}
 *     and flips `workspace_plugins.config.status` to `"reconnect_needed"`.
 *   - **Transient** → network failure, 5xx, unparseable body, an unknown
 *     4xx code, or an operator-side code (`invalid_client`) deliberately
 *     kept OUT of `permanentFailureCodes`. Throws a plain `Error`, never
 *     flips status — the agent loop's next call retries.
 *
 * @see ./oauth-reconnect.ts — the shared status mark/clear pair
 * @see ./jira-token-refresh.ts — Jira config (JSON body, rotation-required)
 * @see ./linear-token-refresh.ts — Linear config (form body, rotation-required)
 * @see ./salesforce-token-refresh.ts — Salesforce config (form body, per-tenant token URL)
 */

import { createLogger } from "@atlas/api/lib/logger";
import {
  readCredentialBundle,
  saveCredentialBundle,
  type CredentialBundle,
} from "@atlas/api/lib/integrations/credentials/store";
import { IntegrationReconnectRequiredError } from "@atlas/api/lib/effect/errors";
import { markReconnectNeeded, clearReconnectNeeded } from "./oauth-reconnect";

/**
 * Superset of the OAuth token-refresh success bodies across platforms.
 * `expires_in` is Jira/Linear; `instance_url` / `issued_at` / `id_token`
 * are Salesforce. Each config's `toBundle` reads only the fields its
 * platform sends.
 */
export interface RefreshSuccessResponse {
  readonly access_token: string;
  readonly refresh_token?: string;
  readonly token_type?: string;
  readonly scope?: string;
  readonly expires_in?: number;
  readonly instance_url?: string;
  readonly issued_at?: string;
  readonly id_token?: string;
}

interface RefreshFailureResponse {
  // Optional: the parsed body is untrusted JSON widened to this shape, so
  // `error` may be absent — hence the `?? http_<status>` fallback below.
  readonly error?: string;
  readonly error_description?: string;
}

type RefreshResponse = RefreshSuccessResponse | RefreshFailureResponse;

/** The per-invocation inputs shared by every platform's refresher. */
export interface OAuthRefreshArgs {
  readonly workspaceId: string;
  readonly clientId: string;
  readonly clientSecret: string;
}

/**
 * The per-platform dimensions of the refresh flow. Adding a fourth
 * OAuth-credential refresher is a new value of this shape — no copied
 * exchange / classify / mark-reconnect code.
 */
export interface OAuthRefreshConfig {
  /** Tagged-error `platform` discriminator ("jira" / "linear" / "salesforce"). */
  readonly platform: string;
  /** Platform name in the "No X credentials" / "X refresh failed" messages. */
  readonly displayName: string;
  /** Vendor name in the endpoint-level messages ("Atlassian" for Jira, else `displayName`). */
  readonly endpointName: string;
  /** Full `plugin_catalog.id` FK ("catalog:jira") — the credential + status key. */
  readonly catalogId: string;
  /** Logger name ("integrations.install.jira-refresh"). */
  readonly logName: string;
  /** Token endpoint body encoding — Atlassian is JSON, everyone else form-encoded. */
  readonly bodyEncoding: "json" | "form";
  /**
   * Whether the success response MUST carry a rotated `refresh_token`
   * (Jira/Linear rotate on every refresh; Salesforce usually omits it
   * and the stored value rolls forward). Drives the success guard.
   */
  readonly requiresRefreshTokenInResponse: boolean;
  /** Upstream error codes that prove the install is broken (reconnect-needed). */
  readonly permanentFailureCodes: ReadonlySet<string>;
  /** Which HTTP statuses qualify for permanent classification (Jira/Linear: any 4xx; Salesforce: exactly 400). */
  readonly isPermanentFailureStatus: (status: number) => boolean;
  /** `IntegrationReconnectRequiredError.message` when the stored bundle has no refresh token. */
  readonly noRefreshTokenMessage: string;
  /** `IntegrationReconnectRequiredError.message` when upstream rejects the refresh token. */
  readonly refreshRejectedMessage: string;
  /** Assemble the persisted bundle from the success body + the stored bundle. */
  readonly toBundle: (response: RefreshSuccessResponse, stored: CredentialBundle) => CredentialBundle;
}

function isRefreshSuccess(
  config: OAuthRefreshConfig,
  r: RefreshResponse,
): r is RefreshSuccessResponse {
  if (!("access_token" in r) || typeof r.access_token !== "string") return false;
  if (
    config.requiresRefreshTokenInResponse &&
    (!("refresh_token" in r) || typeof r.refresh_token !== "string")
  ) {
    return false;
  }
  return true;
}

/**
 * POST the token endpoint with `grant_type=refresh_token`. On a
 * permanent-classified failure throws {@link IntegrationReconnectRequiredError};
 * on anything else (network, 5xx, unknown/transient 4xx) throws a plain
 * `Error` so the caller treats it as transient.
 */
async function exchangeRefreshToken(
  config: OAuthRefreshConfig,
  args: OAuthRefreshArgs,
  tokenUrl: string,
  refreshToken: string,
): Promise<RefreshSuccessResponse> {
  const params = {
    grant_type: "refresh_token",
    client_id: args.clientId,
    client_secret: args.clientSecret,
    refresh_token: refreshToken,
  };
  const { headers, body } =
    config.bodyEncoding === "json"
      ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(params) }
      : {
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams(params).toString(),
        };

  let resp: Response;
  try {
    resp = await fetch(tokenUrl, { method: "POST", headers, body });
  } catch (err) {
    // Network failure — transient. Let the caller retry on the next tool
    // call. Don't flip reconnect_needed without evidence.
    throw new Error(
      `${config.endpointName} token endpoint unreachable: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  let parsed: RefreshResponse;
  try {
    parsed = (await resp.json()) as RefreshResponse;
  } catch (err) {
    throw new Error(
      `${config.endpointName} refresh returned unparseable body (HTTP ${resp.status})`,
      { cause: err },
    );
  }

  if (!resp.ok || !isRefreshSuccess(config, parsed)) {
    const failure = parsed as RefreshFailureResponse;
    const errorCode = failure.error ?? `http_${resp.status}`;
    if (config.isPermanentFailureStatus(resp.status) && config.permanentFailureCodes.has(errorCode)) {
      createLogger(config.logName).warn(
        { workspaceId: args.workspaceId, errorCode, description: failure.error_description },
        `${config.displayName} refresh failed permanently — flagging reconnect_needed`,
      );
      throw new IntegrationReconnectRequiredError({
        message: config.refreshRejectedMessage,
        workspaceId: args.workspaceId,
        platform: config.platform,
        upstreamError: errorCode,
      });
    }
    // Unknown error code, 5xx, or an operator-side code — treat as transient.
    throw new Error(`${config.displayName} refresh failed: ${errorCode} (HTTP ${resp.status})`);
  }

  return parsed;
}

/**
 * Refresh the OAuth access token for `args.workspaceId`. Returns the
 * updated `CredentialBundle` (also persisted to `integration_credentials`).
 * On permanent failure throws {@link IntegrationReconnectRequiredError}
 * and flips `workspace_plugins.config.status` to `"reconnect_needed"`.
 *
 * `tokenUrl` is resolved by the caller — constant for Jira/Linear,
 * per-tenant (`<loginUrl>/services/oauth2/token`) for Salesforce.
 */
export async function refreshOAuthCredential(
  config: OAuthRefreshConfig,
  args: OAuthRefreshArgs,
  tokenUrl: string,
): Promise<CredentialBundle> {
  const log = createLogger(config.logName);
  const disconnectedMessage = `Failed to mark ${config.displayName} install as reconnect_needed (install row may have been disconnected)`;

  const bundle = await readCredentialBundle(args.workspaceId, config.catalogId);
  if (!bundle) {
    throw new Error(
      `No ${config.displayName} credentials found for workspace ${args.workspaceId} — install was disconnected`,
    );
  }
  if (!bundle.refreshToken) {
    log.warn(
      { workspaceId: args.workspaceId },
      `${config.displayName} credential bundle has no refresh_token — flagging reconnect_needed`,
    );
    await markReconnectNeeded(args.workspaceId, config.catalogId, log, disconnectedMessage);
    throw new IntegrationReconnectRequiredError({
      message: config.noRefreshTokenMessage,
      workspaceId: args.workspaceId,
      platform: config.platform,
      upstreamError: "no_refresh_token",
    });
  }

  let refreshed: RefreshSuccessResponse;
  try {
    refreshed = await exchangeRefreshToken(config, args, tokenUrl, bundle.refreshToken);
  } catch (err) {
    if (err instanceof IntegrationReconnectRequiredError) {
      await markReconnectNeeded(args.workspaceId, config.catalogId, log, disconnectedMessage);
    }
    throw err;
  }

  const next = config.toBundle(refreshed, bundle);

  await saveCredentialBundle(args.workspaceId, config.catalogId, next);
  // Independent UPDATE so a failed clear doesn't roll back a successful refresh.
  await clearReconnectNeeded(
    args.workspaceId,
    config.catalogId,
    log,
    `Failed to clear reconnect_needed flag after successful ${config.displayName} refresh`,
  );

  log.info(
    { workspaceId: args.workspaceId, instanceUrl: next.instanceUrl },
    `${config.displayName} token refreshed successfully`,
  );
  return next;
}

/**
 * Shared helper — Jira/Linear return `expires_in` (seconds); compute the
 * absolute expiry ms so the store needn't remember when it was issued.
 */
export function expiresInToAbsolute(expiresIn: number | undefined): number | null {
  return typeof expiresIn === "number" && Number.isFinite(expiresIn)
    ? Date.now() + expiresIn * 1000
    : null;
}
