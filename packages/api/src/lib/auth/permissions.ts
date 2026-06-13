/**
 * Role-based action permissions.
 *
 * Determines whether a user can approve an action based on their role
 * and the action's approval mode. Roles are extracted from the authenticated
 * user, with defaults that vary by auth mode.
 *
 * Role hierarchy: platform_admin > owner > admin > member
 *
 * platform_admin is a global (cross-tenant) role for platform operators.
 * The other three roles are workspace-scoped via Better Auth's org plugin.
 *
 * | Approval mode | member | admin | owner | platform_admin |
 * |---------------|--------|-------|-------|----------------|
 * | auto          | yes*   | yes*  | yes*  | yes*           |
 * | manual        | no     | yes   | yes   | yes            |
 * | admin-only    | no     | no    | yes   | yes            |
 *
 * * Auto-approved actions are executed immediately in handleAction and never
 *   reach the approval endpoint. canApprove returns true for any authenticated
 *   user when mode is "auto".
 */

import type { AtlasUser, AtlasRole } from "@atlas/api/lib/auth/types";
import type { ActionApprovalMode } from "@atlas/api/lib/action-types";
import { ATLAS_ROLES } from "@atlas/api/lib/auth/types";
import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("auth:permissions");

// ---------------------------------------------------------------------------
// Permission flags (granular RBAC)
// ---------------------------------------------------------------------------

/**
 * Granular permission flags consumed by the enterprise custom-role surface
 * (`@atlas/ee/auth/roles`) and the `admin-router.ts` permission middleware.
 *
 * Hosted here (rather than in `@atlas/ee/auth/roles`) so core route handlers
 * can import the type without taking a hard dep on `@atlas/ee` —
 * see #2563 (slice 1/11 of #2017, inverting the core → ee dependency).
 * EE re-exports `PERMISSIONS`, `Permission`, and `isValidPermission` from
 * `ee/src/auth/roles.ts` for back-compat through slice 11.
 *
 * Adding a flag requires:
 *   1. Appending it here
 *   2. Adding it to the appropriate `BUILTIN_ROLES` entries in
 *      `ee/src/auth/roles.ts` so seeded org rows pick it up
 *   3. (Optional) Mapping it into `LEGACY_ROLE_PERMISSIONS` in the same
 *      file for non-enterprise deployments
 */
export const PERMISSIONS = [
  "query",
  "query:raw_data",
  "admin:users",
  "admin:connections",
  "admin:settings",
  "admin:audit",
  "admin:roles",
  "admin:semantic",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/** Validate that a string is a known permission flag. */
export function isValidPermission(p: string): p is Permission {
  return (PERMISSIONS as readonly string[]).includes(p);
}

// ---------------------------------------------------------------------------
// Role hierarchy
// ---------------------------------------------------------------------------

const ROLE_LEVEL: Record<AtlasRole, number> = {
  member: 0,
  admin: 1,
  owner: 2,
  platform_admin: 3,
};

// ---------------------------------------------------------------------------
// Role extraction
// ---------------------------------------------------------------------------

/**
 * Default role for each auth mode when the user object does not carry
 * an explicit role.
 * - simple-key: admin (overridable via ATLAS_API_KEY_ROLE)
 * - managed: member (role comes from Better Auth organization plugin)
 * - byot: member (role comes from JWT claim)
 */
const AUTH_MODE_DEFAULT_ROLE: Record<string, AtlasRole> = {
  "simple-key": "admin",
  managed: "member",
  byot: "member",
};

/**
 * Get the effective role for a user. Falls back to auth-mode defaults
 * when the user has no explicit role set.
 */
export function getUserRole(user: AtlasUser): AtlasRole {
  if (user.role) return user.role;
  return AUTH_MODE_DEFAULT_ROLE[user.mode] ?? "member";
}

/**
 * Parse and validate a role string. Returns the role if valid, undefined otherwise.
 */
export function parseRole(value: string | undefined): AtlasRole | undefined {
  if (!value) return undefined;
  const lower = value.toLowerCase().trim();
  if ((ATLAS_ROLES as readonly string[]).includes(lower)) {
    return lower as AtlasRole;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Permission check
// ---------------------------------------------------------------------------

/**
 * Minimum role required for each approval mode.
 * Auto-approved actions bypass this check entirely (no human approval needed).
 */
const APPROVAL_MODE_MIN_ROLE: Record<ActionApprovalMode, AtlasRole> = {
  auto: "member", // Not actually checked — auto actions don't need approval
  manual: "admin",
  // "admin-only" requires the owner role. The name is a legacy holdover from
  // when admin was the highest role. With the owner > admin > member hierarchy,
  // this effectively means "owner-only". Renaming would be a config-breaking change.
  "admin-only": "owner",
};

/**
 * Check whether a user can approve an action given its approval configuration.
 *
 * @param user - The authenticated user attempting to approve. If undefined
 *   (no-auth mode), approval is always denied.
 * @param approvalMode - The action's effective approval mode (auto/manual/admin-only).
 * @param requiredRole - Optional per-action role override from config. When set,
 *   this takes precedence over the approval mode's default role requirement.
 * @returns true if the user has sufficient permissions to approve.
 */
export function canApprove(
  user: AtlasUser | undefined,
  approvalMode: ActionApprovalMode,
  requiredRole?: AtlasRole,
): boolean {
  // No user = no-auth mode. Actions require identity.
  if (!user) {
    log.debug("canApprove: denied — no authenticated user");
    return false;
  }

  // Auto-approved actions don't need human approval
  if (approvalMode === "auto") {
    return true;
  }

  const userRole = getUserRole(user);
  const userLevel = ROLE_LEVEL[userRole];

  // If a per-action requiredRole is set, use it as the minimum
  if (requiredRole) {
    const requiredLevel = ROLE_LEVEL[requiredRole];
    const modeMinRole = APPROVAL_MODE_MIN_ROLE[approvalMode];
    const modeMinLevel = ROLE_LEVEL[modeMinRole];
    if (requiredLevel < modeMinLevel) {
      log.warn(
        { approvalMode, requiredRole, modeMinRole },
        "Per-action requiredRole (%s) is lower than approval mode default (%s) — this weakens the '%s' mode for this action",
        requiredRole,
        modeMinRole,
        approvalMode,
      );
    }
    const allowed = userLevel >= requiredLevel;
    if (!allowed) {
      log.debug(
        { userId: user.id, userRole, requiredRole, approvalMode },
        "canApprove: denied — user role below per-action requiredRole",
      );
    }
    return allowed;
  }

  // Otherwise, use the approval mode's default minimum role
  const minRole = APPROVAL_MODE_MIN_ROLE[approvalMode];
  const minLevel = ROLE_LEVEL[minRole];
  const allowed = userLevel >= minLevel;

  if (!allowed) {
    log.debug(
      { userId: user.id, userRole, minRole, approvalMode },
      "canApprove: denied — user role below approval mode minimum",
    );
  }

  return allowed;
}

/**
 * Does the user's effective role meet a minimum-role threshold?
 *
 * The role primitive behind the MCP dispatch RBAC gate (#3508 / ADR-0016
 * gate 3): authority is the bound actor's role, live-resolved at the MCP
 * edge (#3505), compared on the `member < admin < owner < platform_admin`
 * hierarchy. Distinct from {@link canApprove}, which is the action-approval
 * decision keyed on an approval *mode*; this is a plain "is this actor at
 * least <role>" check for gating admin/config tools.
 *
 * Fail-closed: an absent user (no bound identity — e.g. the stdio
 * `system:mcp` trusted actor) returns `false`, so admin tools always
 * register but only a real bound identity at/above `minRole` clears the
 * gate (ADR-0016: "RBAC is the only source of authority").
 */
export function meetsRoleRequirement(
  user: AtlasUser | undefined,
  minRole: AtlasRole,
): boolean {
  if (!user) return false;
  return ROLE_LEVEL[getUserRole(user)] >= ROLE_LEVEL[minRole];
}
