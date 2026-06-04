/**
 * Direct internal-DB user-management operations (#3159).
 *
 * These replace the Better Auth **admin plugin** server API
 * (`auth.api.{listUsers,banUser,unbanUser,removeUser,revokeUserSessions}`).
 * The plugin's defining footgun was authorizing the caller by the raw
 * `user.role` column via `hasPermission(...)`; removing it retires that seam
 * entirely. Authorization is the *route's* job (`platform_admin`-gated in
 * `api/routes/admin.ts`) — these helpers assume the caller is already
 * authorized and just perform the persistence, reproducing the exact SQL the
 * plugin issued so ban / revoke / delete semantics are preserved:
 *
 *  - `banUser`  → `UPDATE "user" SET banned…` then `deleteUserSessions` (the
 *    plugin killed live sessions on ban — `routes.mjs:465`).
 *  - `removeUser` → `deleteUserSessions` + `internalAdapter.deleteUser`, the
 *    latter deleting `session` + `account` + `user` (`internal-adapter.mjs:145`).
 *    `member` rows are deleted by the caller's last-admin lock guard, not here.
 *  - `revokeUserSessions` / `unbanUser` → the obvious single statements.
 *
 * Ban *enforcement* (the plugin's `databaseHooks.session.create.before`) is
 * reproduced by {@link enforceBanOnSessionCreate} (wired in `server.ts`) plus a
 * per-request check in `managed.ts`; both share {@link isEffectivelyBanned}.
 *
 * Lives in `lib/` (no import from `api/routes/`) so the route layer, the auth
 * server config, and the session-validation path can all consume it.
 */

import { APIError } from "better-auth/api";
import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import { createLogger } from "@atlas/api/lib/logger";
import { errorMessage } from "@atlas/api/lib/audit/error-scrub";

const log = createLogger("auth:admin-user-ops");

/**
 * Message shown to a banned user when session creation is refused. Mirrors the
 * Better Auth admin plugin's default `bannedUserMessage`.
 */
export const BANNED_USER_MESSAGE =
  "You have been banned from this application. Please contact support if you believe this is an error.";

// `type` (not `interface`) so the object literal gets TypeScript's implicit
// string index signature and satisfies `internalQuery`'s
// `T extends Record<string, unknown>` constraint.
export type PlatformUserRow = {
  id: string;
  email: string;
  name: string | null;
  role: string | null;
  banned: boolean;
  banReason: string | null;
  banExpires: string | null;
  createdAt: string;
};

/**
 * Pure predicate: is this user *effectively* banned right now? A ban with a
 * `banExpires` in the past is treated as lifted (the plugin auto-unbanned on
 * the next session create). An unparseable `banExpires` fails CLOSED — an
 * active ban — rather than silently admitting the user.
 */
export function isEffectivelyBanned(
  banned: boolean | null | undefined,
  banExpires: string | Date | null | undefined,
  now: number,
): boolean {
  if (banned !== true) return false;
  if (banExpires === null || banExpires === undefined) return true; // permanent
  const expiresMs =
    banExpires instanceof Date ? banExpires.getTime() : new Date(banExpires).getTime();
  if (Number.isNaN(expiresMs)) return true; // unparseable → fail closed
  return expiresMs > now;
}

type BanFieldsRow = {
  banned: boolean | null;
  banExpires: string | Date | null;
};

/**
 * Reproduces the admin plugin's `databaseHooks.session.create.before`
 * (`admin.mjs:33`): block new-session creation for a banned user, and
 * auto-unban (clear the columns) when the ban has expired. Wired into the
 * existing `databaseHooks.session.create.before` in `server.ts`.
 *
 * Fails OPEN (allows) when there is no internal DB, the user row is absent, or
 * the ban lookup itself errors. A missing user can't have a live ban, and a
 * single-tenant deployment with no `user` table never bans. On a read error we
 * log and allow rather than blocking *every* sign-in during a DB blip — the
 * per-request `validateManaged` ban check (which the admin plugin never had) is
 * the backstop that rejects a banned user who slips through here.
 */
export async function enforceBanOnSessionCreate(userId: string): Promise<void> {
  if (!hasInternalDB()) return;

  let rows: BanFieldsRow[];
  try {
    rows = await internalQuery<BanFieldsRow>(
      `SELECT banned, "banExpires" FROM "user" WHERE id = $1 LIMIT 1`,
      [userId],
    );
  } catch (err) {
    log.warn(
      { err: errorMessage(err), userId },
      "Ban lookup failed on session create — allowing sign-in; the per-request ban check is the backstop",
    );
    return;
  }
  const user = rows[0];
  if (!user) return;
  if (user.banned !== true) return;

  const now = Date.now();
  if (!isEffectivelyBanned(user.banned, user.banExpires, now)) {
    // Ban has expired — clear it so the column reflects reality, then allow
    // (matches the plugin's auto-unban path). Best-effort: if the clear fails,
    // still allow the session (the ban is expired regardless).
    try {
      await internalQuery(
        `UPDATE "user" SET banned = false, "banReason" = NULL, "banExpires" = NULL WHERE id = $1`,
        [userId],
      );
    } catch (err) {
      log.warn(
        { err: errorMessage(err), userId },
        "Failed to auto-clear an expired ban on session create — allowing sign-in regardless",
      );
    }
    return;
  }

  throw new APIError("FORBIDDEN", { code: "BANNED_USER", message: BANNED_USER_MESSAGE });
}

/**
 * Ban a user globally and kill their live sessions.
 *
 * @returns the resolved `banExpires` Date, or `null` for a permanent ban.
 */
export async function banUserDirect(opts: {
  userId: string;
  reason?: string;
  expiresInSec?: number;
}): Promise<Date | null> {
  const banExpires =
    opts.expiresInSec && opts.expiresInSec > 0
      ? new Date(Date.now() + opts.expiresInSec * 1000)
      : null;

  await internalQuery(
    `UPDATE "user"
        SET banned = true,
            "banReason" = $2,
            "banExpires" = $3,
            "updatedAt" = NOW()
      WHERE id = $1`,
    [opts.userId, opts.reason ?? null, banExpires],
  );

  // Match the plugin: deleteUserSessions on ban so live sessions are revoked
  // immediately rather than lingering until cookie-cache expiry.
  await internalQuery(`DELETE FROM session WHERE "userId" = $1`, [opts.userId]);

  return banExpires;
}

/** Lift a user's ban (clears banned/banReason/banExpires). */
export async function unbanUserDirect(userId: string): Promise<void> {
  await internalQuery(
    `UPDATE "user"
        SET banned = false,
            "banReason" = NULL,
            "banExpires" = NULL,
            "updatedAt" = NOW()
      WHERE id = $1`,
    [userId],
  );
}

/**
 * Revoke every session a user holds.
 *
 * @returns the number of session rows deleted (from the `RETURNING` set).
 */
export async function revokeUserSessionsDirect(userId: string): Promise<number> {
  const rows = await internalQuery<{ id: string }>(
    `DELETE FROM session WHERE "userId" = $1 RETURNING id`,
    [userId],
  );
  return rows.length;
}

/**
 * Globally delete a user. Reproduces Better Auth's admin `removeUser`:
 * `deleteUserSessions` + `deleteUser` (= delete session, account, then user).
 * `member` rows are deleted by the caller's last-admin lock guard before this
 * runs, so they are not touched here.
 *
 * Deletes in child→parent order so an FK (if present) is never violated mid-way.
 */
export async function removeUserDirect(userId: string): Promise<void> {
  await internalQuery(`DELETE FROM session WHERE "userId" = $1`, [userId]);
  await internalQuery(`DELETE FROM account WHERE "userId" = $1`, [userId]);
  await internalQuery(`DELETE FROM "user" WHERE id = $1`, [userId]);
}

/**
 * Platform-wide user list (the global, non-org-scoped path that the admin
 * plugin's `listUsers` served). Pagination + optional email search + optional
 * exact `role` filter on the user-level `user.role` column (only ever
 * `platform_admin` post-#2890; tenant role display is enriched by the caller).
 */
export async function listPlatformUsers(opts: {
  limit: number;
  offset: number;
  search?: string;
  role?: string;
}): Promise<{ users: PlatformUserRow[]; total: number }> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let i = 1;

  if (opts.search) {
    conditions.push(`email ILIKE $${i++}`);
    params.push(`%${opts.search}%`);
  }
  if (opts.role) {
    conditions.push(`role = $${i++}`);
    params.push(opts.role);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const [userRows, countRows] = await Promise.all([
    internalQuery<PlatformUserRow>(
      `SELECT id, email, name, role,
              COALESCE(banned, false) AS banned, "banReason", "banExpires", "createdAt"
         FROM "user"
         ${where}
        ORDER BY "createdAt" DESC
        LIMIT $${i} OFFSET $${i + 1}`,
      [...params, opts.limit, opts.offset],
    ),
    internalQuery<{ count: string }>(
      `SELECT COUNT(*) AS count FROM "user" ${where}`,
      params,
    ),
  ]);

  return {
    users: userRows,
    total: parseInt(String(countRows[0]?.count ?? "0"), 10),
  };
}
