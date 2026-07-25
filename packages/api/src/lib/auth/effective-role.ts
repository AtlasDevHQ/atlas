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
 * Two entry points, and picking the wrong one is a security decision:
 *
 *   - {@link resolveEffectiveRole} — the original. Returns the resolved role, or
 *     `undefined` when neither side yields one AND when the member-table lookup
 *     ERRORS. That catch is the intrinsic fail-closed direction for its callers:
 *     a transient DB blip down-privileges an org admin (bounces them from the
 *     console) rather than over-granting, regardless of what `userRole` was
 *     passed. Its callers are the AUTHENTICATION surfaces — `validateManaged`
 *     (server-side `requireAdminAuth` on /api/v1/admin/*), the `customSession`
 *     plugin (`session.user.effectiveRole`, which drives admin chrome), the
 *     agent-auth verifier, and the MCP actor binders.
 *   - {@link resolveEffectiveRoleStrict} — for callers that turn the role into
 *     per-row ACL GRANTS (#4773's brain readers). It propagates the lookup
 *     failure and reports whether the role came from this org's member row.
 *     Collapsing either distinction there is a SILENT change to a result set,
 *     which is a different failure from a bounced admin: nobody sees it.
 *
 * `platform_admin` short-circuits before the lookup on both paths.
 */

import type { AtlasRole } from "@atlas/api/lib/auth/types";
import { parseRole } from "@atlas/api/lib/auth/permissions";
import { createLogger } from "@atlas/api/lib/logger";
import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
// From a dedicated, unmocked module ON PURPOSE: four test files `mock.module`
// this one, and a pure utility exported from here forces every partial factory
// to grow a stub for it — which is how #4773 link-failed two suites twice.
import { rootCause } from "@atlas/api/lib/error-cause";

const log = createLogger("auth:effective-role");

/**
 * A member-table lookup failed. Thrown only by
 * {@link resolveEffectiveRoleStrict}; `resolveEffectiveRole` catches it and
 * degrades to least privilege, which is correct for its own callers and
 * dangerous for a per-row ACL reader (#4773).
 */
export class MemberRoleLookupError extends Error {
  constructor(
    readonly userId: string,
    readonly orgId: string,
    options?: { cause?: unknown },
  ) {
    super(`Failed to look up org member role for user ${userId} in org ${orgId}`, options);
    this.name = "MemberRoleLookupError";
  }
}

/**
 * Where a resolved role actually came from.
 *
 * `fromMemberRow` is the distinction `resolveEffectiveRole`'s bare
 * `AtlasRole | undefined` cannot express, and it matters to anything that
 * derives GRANTS from the role. `member.role` is per-org (#2890), but the
 * no-member-row arm below returns the caller's SESSION role verbatim — so a
 * role resolved against org A, used to read org B where the reader has no
 * member row, would otherwise present as a role legitimately held in B. For a
 * brain reader that mints `role:` ACL tokens, that is a fail-OPEN widening
 * (#4773), so it must be able to tell the two apart.
 *
 * `platform_admin` reports `fromMemberRow: false` — it is a cross-tenant
 * platform role that short-circuits before the lookup and confers no org grant.
 */
export interface EffectiveRoleResolution {
  readonly role: AtlasRole | undefined;
  /** True only when `role` came from THIS org's `member` row. */
  readonly fromMemberRow: boolean;
}

/**
 * The same resolution as {@link resolveEffectiveRole}, except that a
 * member-table failure PROPAGATES as {@link MemberRoleLookupError} and the
 * provenance of the role is reported.
 *
 * For a caller that turns the role into access grants, "the lookup threw" and
 * "this user is a plain member" must not collapse into the same value: the
 * first silently strips `role:`-granted rows from a result set while every
 * surface stays self-consistent, which is invisible from any of them.
 */
export async function resolveEffectiveRoleStrict(
  userRole: AtlasRole | undefined,
  userId: string,
  activeOrganizationId: string | undefined,
): Promise<EffectiveRoleResolution> {
  // platform_admin is cross-tenant and lives only on user.role — it outranks
  // any per-org member role, so short-circuit before the lookup.
  if (userRole === "platform_admin") return { role: "platform_admin", fromMemberRow: false };

  if (!activeOrganizationId || !hasInternalDB()) return { role: userRole, fromMemberRow: false };

  let rows: { role: string }[];
  try {
    rows = await internalQuery<{ role: string }>(
      `SELECT role FROM member WHERE "userId" = $1 AND "organizationId" = $2 LIMIT 1`,
      [userId, activeOrganizationId],
    );
  } catch (err) {
    throw new MemberRoleLookupError(userId, activeOrganizationId, { cause: err });
  }
  if (rows.length === 0) return { role: userRole, fromMemberRow: false };

  // member.role is the single source of truth for tenant admin-ness.
  const parsed = parseRole(rows[0].role);
  if (parsed) return { role: parsed, fromMemberRow: true };
  // A member row EXISTS but its role is outside the vocabulary — drift on the
  // role column itself. Logged here because this is the only place that can
  // see it: the caller receives `fromMemberRow: false`, indistinguishable from
  // "no member row", and for a grant-deriving reader that means every `role:`
  // token silently disappears with nothing anywhere saying why.
  log.warn(
    { userId, orgId: activeOrganizationId, storedRole: rows[0].role },
    "Org member row carries a role outside the vocabulary — treating the reader as having no org role",
  );
  return { role: userRole, fromMemberRow: false };
}

export async function resolveEffectiveRole(
  userRole: AtlasRole | undefined,
  userId: string,
  activeOrganizationId: string | undefined,
): Promise<AtlasRole | undefined> {
  try {
    return (await resolveEffectiveRoleStrict(userRole, userId, activeOrganizationId)).role;
  } catch (err) {
    // log.error (not warn): a member-table read failure on the hot auth path
    // is a real production signal, and it down-privileges an org admin.
    //
    // Unwrap to the ROOT cause. `resolveEffectiveRoleStrict` wraps the driver
    // error in `MemberRoleLookupError`, whose own message only restates the
    // userId and orgId already in this payload — logging it would leave an
    // operator able to see that the lookup broke but not whether it was a pool
    // exhaustion, a statement timeout, a reset connection, or a missing
    // relation.
    const cause = rootCause(err);
    log.error(
      {
        // `?? err` so a driver that rejects with a bare `undefined` logs the
        // wrapper rather than the literal string "undefined".
        err: cause instanceof Error ? cause.message : String(cause ?? err),
        userId,
        orgId: activeOrganizationId,
      },
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
