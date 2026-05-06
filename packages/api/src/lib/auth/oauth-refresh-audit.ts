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
   * The OAuth client_id presenting the refresh token. Under the v1.4.1
   * production hook this is essentially always `null` because Better
   * Auth's `customTokenResponseFields` does not surface the
   * `oauthClient.clientId` column to user code (only the parsed
   * `metadata` JSONB blob, which Atlas does not write `clientId` into).
   * The audit row + counter both fall back to `"unknown"` in that case.
   * The field accepts a real value so a hook upgrade or a follow-up
   * lookup that joins the issued `oauthAccessToken` row can light up
   * the per-agent forensic split without changing call sites.
   *
   * Convention: `null` means "the hook could not determine it" rather
   * than "definitely none." There is no M2M path through this helper
   * (refresh-token grants are always user-bound), so the "definitely
   * none" semantic does not arise.
   */
  clientId: string | null;
  /** The user the refreshed token is bound to. `null` only as defense-in-depth. */
  userId: string | null;
  /**
   * JTI of the *new* access token. NOT populated by the production
   * hook in v1.4.1 — Better Auth's `customTokenResponseFields` runs
   * before the JWT is minted. Reserved for direct integration callers
   * and a future hook that fires post-issuance.
   */
  tokenJti?: string;
  /**
   * Wall-clock seconds between the previous token's `iat` and the
   * refresh. Same caveat as `tokenJti` — not populated by the
   * production hook today; reserved for future upgrade.
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
