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

import type { AtlasUser, AtlasRole, OrgRole } from "@atlas/api/lib/auth/types";
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
 * can import the type without taking a hard dep on `@atlas/ee` — see #2563
 * (slice 1/11 of #2017, inverting the core → ee dependency).
 *
 * ⚠️ **This tuple belongs in `@useatlas/types` next to `ATLAS_ROLES`, and
 * #5191 tried to move it there. It was REVERTED, and the reason is worth
 * knowing before anyone tries again.**
 *
 * The issue's premise — *"both consumers resolve it as `workspace:*`, so no npm
 * publish is required to land this"* — is true of the monorepo and FALSE of the
 * scaffold lane. `create-atlas`'s templates depend on the PUBLISHED
 * `@useatlas/types` (`^0.7.0` → 0.10.0), and Deploy Validation builds
 * `packages/api` against that npm copy. So the moment this module re-exported
 * the tuple from `@useatlas/types`, the scaffold failed with
 * `Export PERMISSIONS doesn't exist in target module` — on a REQUIRED check,
 * because the published build has `ATLAS_ROLES` and not this.
 *
 * The move is therefore gated on a `/publish` of `@useatlas/types` landing
 * FIRST, which is CLAUDE.md's ref-bump ordering rule arriving through a
 * different door. Tracked as a follow-up; see the note in
 * `packages/web/src/app/admin/roles/__tests__/permission-grouping.test.ts`,
 * which keeps a hand-copy until then.
 *
 * Adding a flag requires:
 *   1. Appending it here
 *   2. A BACKFILL MIGRATION reconciling seeded `custom_roles` rows — without
 *      it the flag is silently absent for every workspace that has ever opened
 *      /admin/roles, because `resolvePermissions` returns the stored set rather
 *      than unioning it with the definitions. `ee/src/auth/roles.test.ts` has a
 *      drift guard that reddens if the newest backfill disagrees.
 *   3. Adding it to the appropriate `BUILTIN_ROLES` entries in
 *      `ee/src/auth/roles.ts`. Only `admin` picks a new flag up automatically
 *      (`[...PERMISSIONS]`); the others are hand-listed, deliberately — see
 *      `dashboards:share`.
 *   4. (Optional) Mapping it into `LEGACY_ROLE_PERMISSIONS` in
 *      `lib/auth/permission-resolve.ts` for non-enterprise deployments
 */
export const PERMISSIONS = [
  "query",
  "query:raw_data",
  // #5189 — the first pair ENFORCED outside the admin perimeter. Every
  // `admin:*` flag below is gated by `adminAuth` upstream, so those can only
  // ever *subtract* from admin; these are enforced by
  // `requireWorkspacePermission` and can therefore GRANT to an
  // analyst/viewer/member who is not an org admin. (`query`/`query:raw_data`
  // above are non-admin-named but are not enforced at any route today.)
  //
  // The read/write split is **does this persist**, not **is this a GET**. Read
  // covers non-persisting viewing: list/get/render/export/screenshot. Write
  // covers anything that persists — create/update/delete, cards, org share
  // links, BOTH refresh routes (they UPDATE the published card cache) and
  // `GET /{id}/draft` (the first call forks) — plus the authoring assists
  // `/suggest` and `/preview-card`. The per-route table and the full sweep live
  // in `api/routes/dashboards.ts`; keep the rule stated in one place and this
  // pointing at it, because an earlier draft of this comment stated the
  // method-based rule that was rejected, at the definition site a reader
  // reaches first.
  "dashboards:read",
  "dashboards:write",
  // #5192 — a THIRD dashboards flag, and the reason it is not a finer slice of
  // authoring: `POST /{id}/share` in `shareMode: "public"` mints a token served
  // by `publicDashboards` at `/api/public/dashboards/{token}`, which bypasses
  // auth entirely. That is publishing workspace data to the unauthenticated
  // internet — a distinct authority from "can edit a dashboard", not a degree
  // of it. #5189's two-flags-not-three decision was about read-vs-write
  // granularity within authoring and still stands.
  //
  // Withheld from `member`, `analyst` and `viewer`; admin/owner/platform_admin
  // pick it up through the `[...PERMISSIONS]` spreads. Enforced in the share
  // handler on the PUBLIC branch only — an `org`-mode share re-checks org
  // membership on read, so it is authoring-adjacent and stays on
  // `dashboards:write`, as does REVOKING a link (de-escalation must never be
  // harder than escalation).
  "dashboards:share",
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

/**
 * Cap an effective role at a ceiling — returns whichever of the two ranks
 * lower in the `member < admin < owner < platform_admin` hierarchy.
 *
 * Used by the workspace-API-key path (#4046): the key stores the minter's role
 * as a CEILING at mint time, and the live member role is re-resolved at use time.
 * Capping the live role at the stored ceiling means a key never grants MORE than
 * the minter held when they created it (even if the member was later promoted),
 * while a demotion still down-privileges the key (the live role is lower).
 */
export function capRole(role: AtlasRole, ceiling: AtlasRole): AtlasRole {
  return ROLE_LEVEL[role] <= ROLE_LEVEL[ceiling] ? role : ceiling;
}

/**
 * Clamp any role down to the org-assignable range (`member | admin | owner`),
 * stripping the cross-tenant `platform_admin` to `owner`.
 *
 * Used by the workspace-API-key mint path (#4046): a workspace key is org-scoped
 * and must never carry cross-tenant god-mode, so a `platform_admin` minter mints
 * at most an `owner`-authority key. The return type is `OrgRole`, so the
 * isolation invariant is COMPILER-guaranteed at the call site rather than rested
 * on an `as OrgRole` cast (the single unavoidable narrowing is localized here and
 * unit-tested). Mirrors the cli downgrade's "no cross-tenant authority on a
 * portable credential" rule.
 */
export function clampToOrgRole(role: AtlasRole): OrgRole {
  // capRole at the `owner` ceiling can only return member/admin/owner (owner
  // outranks nothing higher in the org range), so the narrowing is sound.
  return capRole(role, "owner") as OrgRole;
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
 * Fail-closed on an ABSENT user: no bound identity (e.g. the stdio
 * `system:mcp` trusted actor) returns `false`, so admin tools always
 * register but only a real bound identity at/above `minRole` clears the
 * gate (ADR-0016: "RBAC is the only source of authority").
 *
 * NOTE — a PRESENT user is NOT fail-closed on role: `getUserRole` falls back
 * to the auth-mode default (ultimately `member`, level 0) when `user.role` is
 * undefined, so a bound user with an unresolved role still CLEARS a
 * `minRole: "member"` gate (it is denied only for `admin`/`owner`/
 * `platform_admin` thresholds). Concretely: a hosted user whose DB role-
 * lookup returns `undefined` (e.g. transient error, new member not yet
 * propagated) is treated as `member`, not denied — they keep read access but
 * are blocked from admin/owner/platform_admin tools. "No resolved role"
 * therefore means "treated as member, not fully denied" — do NOT assume
 * undefined-role ⇒ blocked across the board.
 */
export function meetsRoleRequirement(
  user: AtlasUser | undefined,
  minRole: AtlasRole,
): boolean {
  if (!user) return false;
  return ROLE_LEVEL[getUserRole(user)] >= ROLE_LEVEL[minRole];
}
