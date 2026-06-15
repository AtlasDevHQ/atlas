/**
 * Resolve the effective role from the user-level `user.role` (Better Auth
 * admin plugin) and the active organization's `member.role` (organization
 * plugin).
 *
 * As of #2890 these two surfaces are single-sourced:
 *   - `user.role` — cross-tenant (admin plugin): only ever `platform_admin`
 *     (or a non-admin default). The redundant system-wide `user.role="admin"`
 *     middle state was dropped.
 *   - `member.role` — per-org (organization plugin): `owner`/`admin`/`member`,
 *     the source of truth for tenant-level admin-ness.
 *
 * The resolution is therefore one branch, not a precedence merge:
 *   effectiveRole = user.role === "platform_admin" ? "platform_admin" : member.role
 * `platform_admin` is cross-tenant and outranks any per-org role, so it
 * short-circuits before the member-table lookup; otherwise `member.role`
 * wins outright (no more `max(user.role, member.role)` level comparison).
 *
 * Used in two places that must stay in lockstep:
 *   1. `validateManaged` — populates `authResult.user.role` for server-side
 *      `requireAdminAuth` checks on Atlas's own /api/v1/admin/* routes.
 *   2. `customSession` plugin — populates `session.user.effectiveRole` so
 *      the client (`useUserRole`) can hide/show admin chrome consistently.
 *
 * Returns the resolved role on success, `undefined` when neither side yields
 * one. On a member-table lookup ERROR it returns `undefined` (least privilege)
 * — the intrinsic fail-closed direction: a transient DB blip down-privileges an
 * org admin (bounces them from the console) rather than over-granting, and does
 * so regardless of what `userRole` the caller passed (no longer relying on it
 * being a non-admin default). Platform admins are unaffected — they
 * short-circuit before the lookup.
 */

import type { AtlasRole } from "@atlas/api/lib/auth/types";
import { parseRole } from "@atlas/api/lib/auth/permissions";
import { createLogger } from "@atlas/api/lib/logger";
import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";

const log = createLogger("auth:effective-role");

export async function resolveEffectiveRole(
  userRole: AtlasRole | undefined,
  userId: string,
  activeOrganizationId: string | undefined,
): Promise<AtlasRole | undefined> {
  // platform_admin is cross-tenant and lives only on user.role — it outranks
  // any per-org member role, so short-circuit before the lookup.
  if (userRole === "platform_admin") return "platform_admin";

  if (!activeOrganizationId || !hasInternalDB()) return userRole;

  try {
    const rows = await internalQuery<{ role: string }>(
      `SELECT role FROM member WHERE "userId" = $1 AND "organizationId" = $2 LIMIT 1`,
      [userId, activeOrganizationId],
    );
    if (rows.length === 0) return userRole;

    // member.role is the single source of truth for tenant admin-ness.
    return parseRole(rows[0].role) ?? userRole;
  } catch (err) {
    // log.error (not warn): a member-table read failure on the hot auth path
    // is a real production signal, and it down-privileges an org admin.
    log.error(
      { err: err instanceof Error ? err.message : String(err), userId, orgId: activeOrganizationId },
      "Failed to look up org member role — failing closed to least privilege (org admins down-privileged)",
    );
    // Intrinsic fail-closed: the member lookup was ATTEMPTED (we have an active
    // org) and threw, so we genuinely don't know the tenant role. Return
    // `undefined` — least privilege downstream — rather than `userRole`. The
    // old `return userRole` was only safe because every current caller passes a
    // non-admin `userRole` here (platform_admin short-circuits at the top, the
    // hosted MCP path forces `undefined`); making it `undefined` removes that
    // caller-dependent invariant so a future caller passing a privileged
    // `userRole` can't accidentally retain it through a DB brownout.
    return undefined;
  }
}
