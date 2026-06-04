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

type BanCheckRow = {
  banned: boolean | null;
  /** Computed in SQL with the DB clock — see {@link enforceBanOnSessionCreate}. */
  ban_active: boolean;
};

/**
 * Reproduces the admin plugin's `databaseHooks.session.create.before`
 * (`admin.mjs:33`): block new-session creation for a banned user, and
 * auto-unban (clear the columns) when the ban has expired. Wired into the
 * existing `databaseHooks.session.create.before` in `server.ts`.
 *
 * Whether the ban is *active* is decided with the **database clock** — the SELECT
 * computes `ban_active = banned AND (banExpires IS NULL OR banExpires > NOW())`,
 * and the auto-unban UPDATE clears on `banExpires < NOW()`. Using one time source
 * (the DB) for both the throw decision and the stale-write guard means they can't
 * disagree under app↔DB clock skew (an earlier version decided "expired" with
 * `Date.now()` but cleared with `NOW()`, so a skewed/boundary case could allow a
 * user the DB still considered banned — CodeRabbit). The app-clock predicate
 * {@link isEffectivelyBanned} is still used by the per-request `validateManaged`
 * check, which reads the cookie-cached session user and has no DB statement.
 *
 * Fails OPEN (allows) only when there is no internal DB or the user row is
 * absent — a single-tenant deployment with no `user` table never bans, and a
 * missing user can't have a live ban.
 *
 * Fails CLOSED on a ban-lookup error: refuse session creation rather than risk
 * admitting a banned user. Sign-in already depends on this same internal DB
 * (the `user`/`session` tables live there), so a failed ban read is not a
 * "tolerate the blip" case — it is the same outage. This matches Atlas's other
 * high-privilege auth reads (`resolvePasskeyCount`, `canGenerateSCIMToken`),
 * which also deny on a transient failure. We deliberately do NOT lean on the
 * per-request `validateManaged` check as a fallback: `customSession` returns the
 * cookie-cache-stale user (Better Auth's getSession serves the signed-cookie
 * snapshot on a cache hit, up to `cookieCache.maxAge`), so it cannot reliably
 * catch a ban that the create-time read missed.
 */
export async function enforceBanOnSessionCreate(userId: string): Promise<void> {
  if (!hasInternalDB()) return;

  let rows: BanCheckRow[];
  try {
    rows = await internalQuery<BanCheckRow>(
      `SELECT banned,
              (banned = true AND ("banExpires" IS NULL OR "banExpires" > NOW())) AS ban_active
         FROM "user" WHERE id = $1 LIMIT 1`,
      [userId],
    );
  } catch (err) {
    // Fail closed — see the function doc. A ban read we cannot complete must not
    // become an open door.
    log.error(
      { err: errorMessage(err), userId },
      "Ban lookup failed on session create — refusing sign-in (fail closed)",
    );
    throw new APIError("INTERNAL_SERVER_ERROR", {
      code: "BAN_CHECK_FAILED",
      message: "Unable to verify account status. Please try again.",
    });
  }
  const user = rows[0];
  if (!user) return;

  // Actively banned per the DB clock → refuse, before any write.
  if (user.ban_active) {
    throw new APIError("FORBIDDEN", { code: "BANNED_USER", message: BANNED_USER_MESSAGE });
  }

  // Not active. If the row still carries a now-expired ban, clear it so the
  // column reflects reality (matches the plugin's auto-unban). Best-effort: a
  // failed clear still allows sign-in (the ban is expired regardless).
  if (user.banned === true) {
    // Same DB clock as `ban_active` above; the WHERE re-asserts "still an
    // expired ban" so a concurrent admin re-ban (future/NULL `banExpires`) is
    // not clobbered — the UPDATE matches zero rows and the fresh ban stands.
    try {
      await internalQuery(
        `UPDATE "user" SET banned = false, "banReason" = NULL, "banExpires" = NULL
          WHERE id = $1 AND banned = true AND "banExpires" IS NOT NULL AND "banExpires" < NOW()`,
        [userId],
      );
    } catch (err) {
      log.warn(
        { err: errorMessage(err), userId },
        "Failed to auto-clear an expired ban on session create — allowing sign-in regardless",
      );
    }
  }
  // Falls through to allow: not actively banned (and any expired ban cleared).
}

/**
 * Default ban reason when the caller omits one. Mirrors the Better Auth admin
 * plugin's `"No reason"` fallback (`routes.mjs:461`) so the user list keeps a
 * non-null explanation for UI-triggered bans (the web UI sends no reason).
 */
export const DEFAULT_BAN_REASON = "No reason";

/**
 * Ban a user globally and kill their live sessions.
 *
 * Reports whether the target existed (the removed plugin's `banUser` did a
 * `findUserById` and rejected a missing id with NOT_FOUND — preserve that so a
 * platform admin banning a stale/typo'd id gets a 404, not a false-success
 * audit). When the user is absent the UPDATE matches zero rows and we skip the
 * session delete.
 *
 * @returns `{ found, banExpires }` — `found: false` for an unknown user;
 *   `banExpires` is the resolved expiry Date, or `null` for a permanent ban.
 */
export async function banUserDirect(opts: {
  userId: string;
  reason?: string;
  expiresInSec?: number;
}): Promise<{ found: boolean; banExpires: Date | null }> {
  const banExpires =
    opts.expiresInSec && opts.expiresInSec > 0
      ? new Date(Date.now() + opts.expiresInSec * 1000)
      : null;

  const updated = await internalQuery<{ id: string }>(
    `UPDATE "user"
        SET banned = true,
            "banReason" = $2,
            "banExpires" = $3,
            "updatedAt" = NOW()
      WHERE id = $1
      RETURNING id`,
    [opts.userId, opts.reason ?? DEFAULT_BAN_REASON, banExpires],
  );
  if (updated.length === 0) return { found: false, banExpires: null };

  // Match the plugin: deleteUserSessions on ban so live sessions are revoked
  // immediately rather than lingering until cookie-cache expiry.
  await internalQuery(`DELETE FROM session WHERE "userId" = $1`, [opts.userId]);

  return { found: true, banExpires };
}

/**
 * Create a `platform_admin` user with a password, for the dev/staging seeds
 * (#3159). The removed admin plugin's `createUser` accepted a `role` and set it
 * directly; without it we create via Better Auth's core `signUpEmail` (which
 * hashes the password and runs the normal create hooks — the admin plugin's
 * createUser fired those too) and then promote the row directly, because `role`
 * is an `input: false` additionalField and cannot be set through the create
 * input. The caller is a trusted boot-time seed, not request input.
 *
 * Takes the loose `auth.api` surface (rather than importing `getAuthInstance`)
 * so this module stays free of a cycle with `server.ts`.
 *
 * Retry-safe (CodeRabbit): create + promote is two steps (signUpEmail can't set
 * an `input: false` field), so a prior run that created the user but failed the
 * promotion leaves a sticky un-promoted row the callers' idempotency guards
 * (`seedDevUser`'s user-count, the staging seed's reuse-by-email) won't repair.
 * So we reuse an existing row by email instead of re-creating, ALWAYS (re)promote
 * idempotently, and VERIFY the promotion with `RETURNING` — a partial prior run
 * is repaired on the next attempt rather than left half-done.
 *
 * @returns the user's id (created or repaired), guaranteed `platform_admin`.
 */
export async function createPlatformAdminUser(
  authApi: Record<string, unknown>,
  opts: { email: string; password: string; name: string },
): Promise<string> {
  // Reuse an existing row (repairs a prior run that created but didn't promote)
  // rather than re-creating — signUpEmail on an existing email would hit the
  // enumeration-safe synthetic path and not return the real id.
  const existing = await internalQuery<{ id: string }>(
    `SELECT id FROM "user" WHERE LOWER(email) = LOWER($1) LIMIT 1`,
    [opts.email],
  );

  let userId: string;
  const existingId = existing[0]?.id;
  if (existingId) {
    userId = existingId;
  } else {
    const signUpEmail = authApi.signUpEmail as
      | ((o: {
          body: { email: string; password: string; name: string };
        }) => Promise<{ user?: { id?: string } } | undefined>)
      | undefined;
    if (!signUpEmail) {
      throw new Error("createPlatformAdminUser: signUpEmail API unavailable on the auth instance");
    }
    const result = await signUpEmail({
      body: { email: opts.email, password: opts.password, name: opts.name },
    });
    const createdId = result?.user?.id;
    if (!createdId) {
      throw new Error("createPlatformAdminUser: signUpEmail returned no user id");
    }
    userId = createdId;
  }

  // Idempotent promote, verified: RETURNING proves the row exists and is now
  // platform_admin — so a failed/zero-row promotion is loud, not silently
  // leaving a plain user behind.
  const promoted = await internalQuery<{ id: string }>(
    `UPDATE "user" SET role = 'platform_admin' WHERE id = $1 RETURNING id`,
    [userId],
  );
  if (promoted.length === 0) {
    throw new Error(
      `createPlatformAdminUser: user ${userId} could not be promoted to platform_admin (row missing)`,
    );
  }
  return userId;
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
 *
 * `member` rows are not deleted here. On the normal (internal-DB) path the
 * caller's last-admin lock guard deletes them first — but that is for TOCTOU
 * serialization, not cleanup. The actual orphan-prevention backstop is the
 * `member.userId → user.id` ON DELETE CASCADE (org-plugin FK default): deleting
 * the `user` row drops any remaining `member` rows, including on the
 * no-internal-DB path where the lock guard is skipped.
 *
 * Deletes session/account before the user so the explicit child deletes don't
 * race the cascade; the user delete then sweeps anything left via the FK.
 *
 * @returns `true` if a `user` row was actually deleted, `false` if the id did
 *   not exist — the route reports 404 in that case (the removed plugin's
 *   `removeUser` rejected missing ids, so a no-op delete must not report
 *   success + write a misleading audit row).
 */
export async function removeUserDirect(userId: string): Promise<boolean> {
  await internalQuery(`DELETE FROM session WHERE "userId" = $1`, [userId]);
  await internalQuery(`DELETE FROM account WHERE "userId" = $1`, [userId]);
  const deleted = await internalQuery<{ id: string }>(
    `DELETE FROM "user" WHERE id = $1 RETURNING id`,
    [userId],
  );
  return deleted.length > 0;
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
