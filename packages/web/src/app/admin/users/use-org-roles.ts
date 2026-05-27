"use client";

import { ROLES, type Role } from "./roles";

/**
 * Hook returning the role choices for an invite dialog scoped to a
 * specific org. Today it returns the global `["member", "admin", "owner"]`
 * triple — the FE structure is ready to swap to a per-org dynamic-roles
 * fetch when Better Auth's `dynamicAccessControl` lands on the
 * organization plugin (see #2876 acceptance criteria — "Role dropdown
 * structure ready to receive per-org custom roles from
 * `dynamicAccessControl` (even if today's values are still global)").
 *
 * Returning the same readonly tuple regardless of `orgId` keeps the
 * eventual call-site swap one-line: switch the return type to a fetched
 * list, no consumer rewrites.
 */
export function useOrgRoles(_orgId: string | null): readonly Role[] {
  return ROLES;
}
