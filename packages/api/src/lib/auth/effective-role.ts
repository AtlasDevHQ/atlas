/**
 * Resolve the effective role from the user-level `user.role` (Better Auth
 * admin plugin) merged with the active organization's `member.role`.
 *
 * Better Auth keeps these two role surfaces separate by design:
 *   - `user.role` — system-wide (admin plugin): `platform_admin`, `admin`, `user`
 *   - `member.role` — per-org (organization plugin): `owner`, `admin`, `member`
 *
 * Atlas's admin console gate is "is this caller an admin *somewhere I trust*"
 * — system OR active-org. Without merging, an org owner whose `user.role`
 * defaulted to "user" (the common signup → accept-invite flow) is locked out
 * of `/admin` even though every API route they'd touch authorizes them.
 *
 * Used in two places that must stay in lockstep:
 *   1. `validateManaged` — populates `authResult.user.role` for server-side
 *      `requireAdminAuth` checks on Atlas's own /api/v1/admin/* routes.
 *   2. `customSession` plugin — populates `session.user.effectiveRole` so
 *      the client (`useUserRole`) can hide/show admin chrome consistently.
 *
 * Returns the merged role on success, `undefined` only when both sides are
 * empty/unknown. Fails open to `userRole` on DB error — a transient lookup
 * failure shouldn't lock an admin out of the console mid-session.
 */

import type { AtlasRole } from "@atlas/api/lib/auth/types";
import { parseRole } from "@atlas/api/lib/auth/permissions";
import { createLogger } from "@atlas/api/lib/logger";
import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";

const log = createLogger("auth:effective-role");

/** Role precedence — higher number wins. */
const ROLE_LEVEL: Record<string, number> = {
  member: 0,
  admin: 1,
  owner: 2,
  platform_admin: 3,
};

export async function resolveEffectiveRole(
  userRole: AtlasRole | undefined,
  userId: string,
  activeOrganizationId: string | undefined,
): Promise<AtlasRole | undefined> {
  if (!activeOrganizationId || !hasInternalDB()) return userRole;

  try {
    const rows = await internalQuery<{ role: string }>(
      `SELECT role FROM member WHERE "userId" = $1 AND "organizationId" = $2 LIMIT 1`,
      [userId, activeOrganizationId],
    );
    if (rows.length === 0) return userRole;

    const orgRole = parseRole(rows[0].role);
    if (!orgRole) return userRole;

    const userLevel = ROLE_LEVEL[userRole ?? "member"] ?? 0;
    const orgLevel = ROLE_LEVEL[orgRole] ?? 0;
    return orgLevel > userLevel ? orgRole : (userRole ?? "member");
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err), userId, orgId: activeOrganizationId },
      "Failed to look up org member role — falling back to user-level role",
    );
    return userRole;
  }
}
