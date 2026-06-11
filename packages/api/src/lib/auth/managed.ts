/**
 * Managed auth (Better Auth) — session validation.
 *
 * Checks cookies and bearer tokens via auth.api.getSession().
 * Returns AuthResult on success or missing session (never throws for
 * "no session" — returns { authenticated: false } instead).
 * Throws on infrastructure errors (DB unavailable, etc.);
 * callers (middleware.ts) are expected to catch.
 */

import type { AuthResult } from "@atlas/api/lib/auth/types";
import { createAtlasUser } from "@atlas/api/lib/auth/types";
import { parseRole } from "@atlas/api/lib/auth/permissions";
import { getAuthInstance } from "@atlas/api/lib/auth/server";
import { isEffectivelyBanned } from "@atlas/api/lib/auth/admin-user-ops";
import { createLogger } from "@atlas/api/lib/logger";
import { getSetting } from "@atlas/api/lib/settings";
import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";

const log = createLogger("auth:managed");

export async function validateManaged(req: Request): Promise<AuthResult> {
  const auth = getAuthInstance();

  const session = await auth.api.getSession({ headers: req.headers });

  if (!session) {
    log.debug("getSession returned null — no valid session");
    return { authenticated: false, mode: "managed", status: 401, error: "Not signed in" };
  }

  const userId = session.user?.id;
  const email = session.user?.email;
  if (!userId) {
    log.error({ sessionExists: true }, "Session found but user.id is missing");
    return { authenticated: false, mode: "managed", status: 500, error: "Session data is incomplete" };
  }

  // Extract the merged effective role from the session user. Set by the
  // `customSession` plugin in `server.ts`, which already runs
  // `resolveEffectiveRole(user.role, member.role)` on every getSession.
  // Reading the stamped field here avoids a second identical member-table
  // SELECT per request. Falls back to the raw `role` (system-wide,
  // admin plugin) for unit tests that mock auth.api.getSession without
  // routing through the customSession callback.
  const sessionUser = session.user as Record<string, unknown>;

  // #3159 — per-request ban enforcement (defense-in-depth). The removed Better
  // Auth admin plugin rejected banned users only at session-CREATE; we reproduce
  // that create-time guard in server.ts and `banUserDirect` deletes the banned
  // user's live sessions. This read-side check is the third layer: it rejects a
  // banned user whose ban is visible on a fresh getSession read. `banned`/
  // `banExpires` ride along on the getSession user via `additionalFields`; an
  // expired ban (banExpires in the past) is treated as lifted.
  //
  // NOTE the bound: Better Auth serves the cookie-cache snapshot on a cache hit
  // (up to `cookieCache.maxAge`, default 30s — see SESSION_COOKIE_CACHE_*), so
  // this check reflects ban state as of the last fresh read, not strictly the
  // current row. Primary eviction is `banUserDirect`'s session delete; this
  // catches a banned user who still has a live session once the read refreshes.
  if (
    isEffectivelyBanned(
      sessionUser?.banned as boolean | null | undefined,
      sessionUser?.banExpires as string | Date | null | undefined,
      Date.now(),
    )
  ) {
    log.info({ userId }, "Rejecting session — user is banned");
    return { authenticated: false, mode: "managed", status: 401, error: "Account is banned" };
  }

  const stampedRole = sessionUser?.effectiveRole ?? sessionUser?.role;
  // Better Auth can store roles as comma-separated strings; Atlas uses only the first.
  const rawRole = typeof stampedRole === "string" ? stampedRole.split(",")[0].trim() : stampedRole;
  let role: ReturnType<typeof parseRole>;
  if (typeof rawRole === "string") {
    role = parseRole(rawRole);
    if (rawRole && !role) {
      log.warn({ value: rawRole, validRoles: ["member", "admin", "owner"] }, "Session user role is not a valid Atlas role — defaulting to 'member'");
    }
  } else {
    role = undefined;
    if (rawRole !== undefined && rawRole !== null) {
      log.warn({ type: typeof rawRole }, "Session user role is not a string — ignoring");
    }
  }

  const sessionData = session.session as Record<string, unknown> | undefined;

  // Extract activeOrganizationId from session — set by Better Auth org plugin
  // via POST /organization/set-active. Resolved BEFORE timeout enforcement so
  // the workspace tier of the workspace-scoped timeout keys applies (#3406):
  // the timeouts govern the workspace the session is operating in.
  const activeOrganizationId = (sessionData?.activeOrganizationId as string) ?? undefined;

  // Session timeout enforcement (idle + absolute)
  if (sessionData) {
    const now = Date.now();

    const idleRaw = parseInt(getSetting("ATLAS_SESSION_IDLE_TIMEOUT", activeOrganizationId) ?? "0", 10);
    const idleTimeout = Number.isFinite(idleRaw) && idleRaw > 0 ? idleRaw : 0;
    if (idleTimeout > 0 && sessionData.updatedAt) {
      const updatedAt = new Date(sessionData.updatedAt as string).getTime();
      if (Number.isNaN(updatedAt)) {
        log.warn({ userId, updatedAt: sessionData.updatedAt }, "Session updatedAt is not a valid date — rejecting session");
        return { authenticated: false, mode: "managed", status: 401, error: "Session data is invalid" };
      }
      if (now - updatedAt > idleTimeout * 1000) {
        log.info({ userId, idleMs: now - updatedAt, idleTimeout }, "Session idle timeout exceeded");
        return { authenticated: false, mode: "managed", status: 401, error: "Session expired (idle timeout)" };
      }
    }

    const absRaw = parseInt(getSetting("ATLAS_SESSION_ABSOLUTE_TIMEOUT", activeOrganizationId) ?? "0", 10);
    const absoluteTimeout = Number.isFinite(absRaw) && absRaw > 0 ? absRaw : 0;
    if (absoluteTimeout > 0 && sessionData.createdAt) {
      const createdAt = new Date(sessionData.createdAt as string).getTime();
      if (Number.isNaN(createdAt)) {
        log.warn({ userId, createdAt: sessionData.createdAt }, "Session createdAt is not a valid date — rejecting session");
        return { authenticated: false, mode: "managed", status: 401, error: "Session data is invalid" };
      }
      if (now - createdAt > absoluteTimeout * 1000) {
        log.info({ userId, ageMs: now - createdAt, absoluteTimeout }, "Session absolute timeout exceeded");
        return { authenticated: false, mode: "managed", status: 401, error: "Session expired" };
      }
    }
  }

  const passkeyCount = await resolvePasskeyCount(userId);

  // Computed fields land AFTER the spread so a session-user field can't
  // shadow our authoritative claims (asserted in managed.test.ts).
  const claims: Record<string, unknown> = { ...sessionUser, sub: userId, passkeyCount };
  if (activeOrganizationId) {
    claims.org_id = activeOrganizationId;
  }

  return {
    authenticated: true,
    mode: "managed",
    user: createAtlasUser(userId, "managed", email || userId, { role, activeOrganizationId, claims }),
  };
}

// `::int` cast keeps PG's bigint COUNT(*) as a JS number — pg surfaces
// bigint as a string by default. Returns 0 on missing DB / read failure:
// fail-closed gates passkey-only users on infra blips, which is strictly
// safer than admitting them on a stale read.
async function resolvePasskeyCount(userId: string): Promise<number> {
  if (!hasInternalDB()) return 0;
  try {
    const rows = await internalQuery<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM passkey WHERE "userId" = $1`,
      [userId],
    );
    return rows[0]?.count ?? 0;
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err), userId },
      "Failed to look up passkey count — treating as 0",
    );
    return 0;
  }
}
