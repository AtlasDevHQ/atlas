/**
 * Server-side forced-password-change gate (#3345).
 *
 * `password_change_required` is stamped when an admin provisions a user with
 * a temp password (and by the default-admin-seed backfill). Before this gate
 * the flag was honored ONLY by the web admin layout's client-side redirect —
 * REST, the agent (`POST /api/v1/chat`), and hosted MCP all accepted the temp
 * credential indefinitely, which nullified the primary mitigation credited to
 * the default-admin-password finding (#3334).
 *
 * The gate runs inside `authenticateRequest` for managed-mode requests (the
 * only mode with Atlas-held passwords) and inside the hosted-MCP bearer
 * verification. A flagged user gets 403 with the `password_change_required`
 * marker on every path except the endpoints needed to complete the change:
 *
 *   - GET  /api/v1/admin/me/password-status  (the web/widget dialog's probe)
 *   - POST /api/v1/admin/me/password         (the change itself)
 *
 * Better Auth's own routes (`/api/auth/*` — sign-in/sign-out/session) do not
 * flow through `authenticateRequest`, so logout keeps working.
 *
 * Lookup result is cached briefly per user; the change-password handler calls
 * {@link invalidatePasswordGate} after clearing the flag so the unblock is
 * immediate. DB errors fail CLOSED (500) — matching the status endpoint's
 * posture; managed auth already requires the internal DB, so a DB outage
 * fails the session validation before this gate anyway.
 */

import type { AuthResult } from "@atlas/api/lib/auth/types";
import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("auth:password-gate");

/** Marker token clients can branch on (also used by the web 403 copy). */
export const PASSWORD_CHANGE_REQUIRED_ERROR = "password_change_required";

const EXEMPT_PATHS = new Set([
  "/api/v1/admin/me/password",
  "/api/v1/admin/me/password-status",
]);

/** Cache TTL — bounds the per-request DB read without delaying enforcement
 *  meaningfully (a freshly-flagged user is blocked within this window). */
const CACHE_TTL_MS = 30_000;

const _cache = new Map<string, { flagged: boolean; expiresAt: number }>();
let _writesSinceSweep = 0;

/** Drop expired entries so unique user ids can't accumulate forever in a
 *  long-lived worker. Amortized: runs every 256 cache writes. */
function sweepExpiredEntries(now: number): void {
  for (const [cachedUserId, entry] of _cache) {
    if (entry.expiresAt <= now) _cache.delete(cachedUserId);
  }
}

/** Clear the cached verdict for a user (call after clearing the flag). */
export function invalidatePasswordGate(userId: string): void {
  _cache.delete(userId);
}

/** @internal — test-only: reset all cached verdicts. */
export function _resetPasswordGateCache(): void {
  _cache.clear();
  _lookupOverride = null;
}

let _lookupOverride: ((userId: string) => Promise<boolean>) | null = null;

/** @internal — test-only: override the DB lookup. */
export function _setPasswordGateLookupOverride(
  override: ((userId: string) => Promise<boolean>) | null,
): void {
  _lookupOverride = override;
}

async function lookupFlag(userId: string): Promise<boolean> {
  if (_lookupOverride) return _lookupOverride(userId);
  if (!hasInternalDB()) return false; // managed auth is impossible without it
  const rows = await internalQuery<{ password_change_required: boolean }>(
    `SELECT password_change_required FROM "user" WHERE id = $1`,
    [userId],
  );
  return rows[0]?.password_change_required === true;
}

/** Whether `pathname` is exempt from the gate (the change-password flow itself). */
export function isPasswordGateExemptPath(pathname: string): boolean {
  return EXEMPT_PATHS.has(pathname.replace(/\/+$/, "") || "/");
}

/**
 * Cached `password_change_required` lookup. Throws on a lookup failure —
 * callers decide their fail-closed envelope (500 here, 503 at the MCP edge).
 */
export async function isPasswordChangeRequired(userId: string): Promise<boolean> {
  const now = Date.now();
  const cached = _cache.get(userId);
  if (cached) {
    if (cached.expiresAt > now) return cached.flagged;
    _cache.delete(userId);
  }
  const flagged = await lookupFlag(userId);
  _cache.set(userId, { flagged, expiresAt: now + CACHE_TTL_MS });
  if ((++_writesSinceSweep & 0xff) === 0) sweepExpiredEntries(now);
  return flagged;
}

/**
 * Enforce the forced-password-change flag for a managed-mode user.
 * Returns a 403/500 `AuthResult` when the request must be blocked, or
 * `null` to proceed.
 */
export async function checkPasswordChangeGate(
  userId: string,
  requestUrl: string,
): Promise<AuthResult | null> {
  let pathname: string;
  try {
    pathname = new URL(requestUrl).pathname;
  } catch {
    // intentionally ignored: relative test URLs etc. — treat the raw value
    // as the path so the gate still applies.
    pathname = requestUrl;
  }
  if (isPasswordGateExemptPath(pathname)) return null;

  let flagged: boolean;
  try {
    flagged = await isPasswordChangeRequired(userId);
  } catch (err) {
    log.error(
      { userId, err: err instanceof Error ? err.message : String(err) },
      "password_change_required lookup failed — blocking request (fail-closed)",
    );
    return {
      authenticated: false,
      mode: "managed",
      status: 500,
      error:
        "Unable to verify password-change status. Please retry or contact your administrator.",
    };
  }

  if (!flagged) return null;

  log.warn({ userId, pathname }, "Request blocked — password change required");
  return {
    authenticated: false,
    mode: "managed",
    status: 403,
    error:
      `${PASSWORD_CHANGE_REQUIRED_ERROR}: your password must be changed before continuing. ` +
      `Change it via the web app or POST /api/v1/admin/me/password.`,
  };
}
