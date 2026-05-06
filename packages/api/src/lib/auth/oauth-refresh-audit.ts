/**
 * OAuth refresh-token audit + telemetry hook (#2066).
 *
 * Better Auth's `oauthProvider` plugin issues a fresh access token on the
 * `refresh_token` grant — that path is the load-bearing piece of the
 * "agent stays connected past the original JWT's expiry" contract. Without
 * this hook the only Atlas-side record of a refresh is the underlying
 * pino access log, which retention rotates out and which forensic queries
 * cannot pivot on.
 *
 * The helper is intentionally fire-and-forget — both `logAdminAction`
 * (under the hood) and the OTel counter swallow their own write errors,
 * so the refresh path never fails because audit/telemetry is misconfigured.
 *
 * Wired from `server.ts` via `customTokenResponseFields` — that's the
 * only oauthProvider hook that surfaces `grantType`, so the side-effect
 * is gated on `grantType === "refresh_token"`. The hook contract gives
 * us userId + scopes + (best-effort) clientId from the OAuth client
 * metadata blob. `tokenJti` and `ageAtRefreshSec` are recorded when the
 * caller can supply them — they're surfaced to bun:test integration
 * callers but are best-effort under the production hook.
 */

import { logAdminAction, ADMIN_ACTIONS } from "@atlas/api/lib/audit";
import { oauthTokenRefresh } from "@atlas/api/lib/metrics";
import { createLogger } from "@atlas/api/lib/logger";
import { getConfig } from "@atlas/api/lib/config";

const log = createLogger("oauth-refresh-audit");

export interface OAuthTokenRefreshAuditInfo {
  /**
   * The OAuth client_id presenting the refresh token. Pivots forensic
   * queries on which agent (Claude Desktop, Cursor, …) is rotating.
   * Best-effort under the production hook — pulled from the client
   * metadata blob when available, falls back to `"unknown"` otherwise.
   */
  clientId: string | null;
  /** The user the refreshed token is bound to. */
  userId: string | null;
  /** JTI of the *new* access token, if the JWT plugin is active. */
  tokenJti?: string;
  /**
   * Wall-clock seconds between the previous token's `iat` and the
   * refresh, when known. Surfaces "rotation cadence" for dashboards.
   */
  ageAtRefreshSec?: number;
  /** Scopes carried on the refreshed token. */
  scopes: readonly string[];
}

function resolveDeployMode(): "self-hosted" | "saas" {
  return getConfig()?.deployMode === "saas" ? "saas" : "self-hosted";
}

/**
 * Emits a single `oauth_token.refresh` audit row + atlas.oauth.token_refresh
 * counter increment. Returns `void` — the hook layer doesn't block on
 * audit / telemetry writes.
 *
 * Never throws. A misconfigured audit or metrics pipeline must not
 * abort the user-facing refresh response.
 */
export function recordOAuthTokenRefresh(info: OAuthTokenRefreshAuditInfo): void {
  try {
    oauthTokenRefresh.add(1, {
      "client.id": info.clientId ?? "unknown",
      "deploy.mode": resolveDeployMode(),
    });
  } catch (err: unknown) {
    // Counter increments shouldn't throw, but the OTel SDK can panic if
    // the SDK is initialized in a degraded state. Don't let a metric
    // failure surface as a 500 on the refresh response.
    log.debug(
      { err: err instanceof Error ? err.message : String(err) },
      "oauthTokenRefresh counter increment failed (non-fatal)",
    );
  }

  // Audit row — `logAdminAction` is fire-and-forget under the hood, so
  // we don't need a try/catch around it. `targetId` is the clientId
  // (the entity whose token rotated); when the hook can't surface it,
  // we fall back to `"unknown"` so forensic queries pivoting on
  // `target_id IS NULL` don't see this row by accident.
  logAdminAction({
    actionType: ADMIN_ACTIONS.oauth_token.refresh,
    targetType: "oauth_token",
    targetId: info.clientId ?? "unknown",
    metadata: {
      clientId: info.clientId,
      userId: info.userId,
      ...(info.tokenJti ? { tokenJti: info.tokenJti } : {}),
      ...(typeof info.ageAtRefreshSec === "number"
        ? { ageAtRefreshSec: info.ageAtRefreshSec }
        : {}),
      scopes: info.scopes,
    },
  });
}
