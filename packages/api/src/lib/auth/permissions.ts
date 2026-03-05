/**
 * Role-based action permissions.
 *
 * Determines whether a user can approve an action based on their role
 * and the action's approval mode. Roles are extracted from the authenticated
 * user, with defaults that vary by auth mode.
 *
 * Role hierarchy: admin > analyst > viewer
 *
 * | Approval mode | viewer | analyst | admin |
 * |---------------|--------|---------|-------|
 * | auto          | yes*   | yes*    | yes*  |
 * | manual        | no     | yes     | yes   |
 * | admin-only    | no     | no      | yes   |
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
// Role hierarchy
// ---------------------------------------------------------------------------

const ROLE_LEVEL: Record<AtlasRole, number> = {
  viewer: 0,
  analyst: 1,
  admin: 2,
};

// ---------------------------------------------------------------------------
// Role extraction
// ---------------------------------------------------------------------------

/**
 * Default role for each auth mode when the user object does not carry
 * an explicit role.
 * - simple-key: analyst (overridable via ATLAS_API_KEY_ROLE)
 * - managed: viewer (role comes from Better Auth organization plugin)
 * - byot: viewer (role comes from JWT claim)
 */
const AUTH_MODE_DEFAULT_ROLE: Record<string, AtlasRole> = {
  "simple-key": "analyst",
  managed: "viewer",
  byot: "viewer",
};

/**
 * Get the effective role for a user. Falls back to auth-mode defaults
 * when the user has no explicit role set.
 */
export function getUserRole(user: AtlasUser): AtlasRole {
  if (user.role) return user.role;
  return AUTH_MODE_DEFAULT_ROLE[user.mode] ?? "viewer";
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
  auto: "viewer", // Not actually checked — auto actions don't need approval
  manual: "analyst",
  "admin-only": "admin",
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
