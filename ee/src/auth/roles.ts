/**
 * Enterprise custom role management.
 *
 * Granular permission-based RBAC system. Roles are sets of permission flags.
 * Three built-in roles (admin, analyst, viewer) are seeded on migration and
 * cannot be deleted. Custom roles are per-organization.
 *
 * CRUD functions route through the `eeRead`/`eeWrite` combinators, which apply
 * the `requireEnterpriseEffect("roles")` gate — unlicensed deployments get a
 * clear error. Permission check helpers do NOT require a license and
 * fall back to legacy admin/member role mapping.
 */

import { Effect, Layer } from "effect";
import { EnterpriseError } from "@atlas/api/lib/effect/errors";
import { eeRead, eeWrite } from "../lib/ee-query";
import {
  hasInternalDB,
  internalQuery,
  getInternalDB,
} from "@atlas/api/lib/db/internal";
import { createLogger } from "@atlas/api/lib/logger";
import { ATLAS_ROLES } from "@atlas/api/lib/auth/types";
import {
  PERMISSIONS,
  isValidPermission,
  type Permission,
} from "@atlas/api/lib/auth/permissions";
import {
  RolesPolicy,
  type RolesPolicyShape,
} from "@atlas/api/lib/effect/services";
import {
  RoleError,
  type RoleErrorCode,
} from "@atlas/api/lib/auth/roles-errors";
import { checkPermission as coreCheckPermission } from "@atlas/api/lib/auth/permission-resolve";

/**
 * Lower-cased set of every built-in Atlas role name. Kept in lockstep with
 * `ATLAS_ROLES` (single source of truth in `@useatlas/types/auth`) so that
 * adding a platform-level role in the future automatically widens what the
 * custom-role surface refuses to shadow. See F-10 in
 * .claude/research/security-audit-1-2-3.md — a workspace admin could
 * previously create a custom role literally named `platform_admin`, then
 * assign it via this same module's `assignRole` path, which writes the name
 * into `member.role`; `resolveEffectiveRole` would then promote the target
 * user to cross-org governance.
 */
const RESERVED_ATLAS_ROLE_NAMES: ReadonlySet<string> = new Set(
  ATLAS_ROLES.map((r) => r.toLowerCase()),
);

const log = createLogger("ee:roles");

// ── Built-in role definitions ────────────────────────────────────

export interface BuiltinRoleDefinition {
  name: string;
  description: string;
  permissions: readonly Permission[];
}

export const BUILTIN_ROLES: readonly BuiltinRoleDefinition[] = [
  {
    name: "admin",
    description: "Full access to all features and administration",
    permissions: [...PERMISSIONS],
  },
  {
    name: "analyst",
    description: "Can query data (including raw data) and view audit logs",
    permissions: ["query", "query:raw_data", "admin:audit"],
  },
  {
    name: "viewer",
    description: "Can query data with aggregate results only",
    permissions: ["query"],
  },
] as const;

// ── Types ────────────────────────────────────────────────────────

export interface CustomRole {
  id: string;
  orgId: string;
  name: string;
  description: string;
  permissions: Permission[];
  isBuiltin: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Internal row shape from the custom_roles table. */
interface CustomRoleRow {
  id: string;
  org_id: string;
  name: string;
  description: string;
  permissions: string | string[];
  is_builtin: boolean;
  created_at: string;
  updated_at: string;
  [key: string]: unknown;
}

// ── Typed errors ─────────────────────────────────────────────────

/**
 * `RoleError` lives in `@atlas/api/lib/auth/roles-errors` post-#2571
 * so the `RolesPolicy` Tag in core can type its failure channel
 * without core importing from `@atlas/ee`. Re-exported here for
 * back-compat — same `_tag` + payload + `instanceof` semantics.
 */
export { RoleError, type RoleErrorCode };

// ── Helpers ──────────────────────────────────────────────────────

function rowToRole(row: CustomRoleRow): CustomRole {
  let rawPermissions: string[];
  try {
    rawPermissions = typeof row.permissions === "string"
      ? JSON.parse(row.permissions) as string[]
      : row.permissions;
  } catch (parseErr) {
    log.error({ roleId: row.id, roleName: row.name, raw: row.permissions, err: parseErr instanceof Error ? parseErr.message : String(parseErr) }, "Failed to parse permissions JSON for role — defaulting to empty");
    rawPermissions = [];
  }

  // Filter out any unknown permissions (forward compat) with warning
  const unknown = rawPermissions.filter((p) => !isValidPermission(p));
  if (unknown.length > 0) {
    log.warn({ roleId: row.id, unknownPermissions: unknown }, "Role contains unrecognized permissions — these will be ignored");
  }
  const permissions = rawPermissions.filter(isValidPermission);

  return {
    id: row.id,
    orgId: row.org_id,
    name: row.name,
    description: row.description ?? "",
    permissions,
    isBuiltin: row.is_builtin,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

const ROLE_NAME_RE = /^[a-z][a-z0-9_-]{0,62}$/;

export function isValidRoleName(name: string): boolean {
  return ROLE_NAME_RE.test(name.toLowerCase());
}

// ── Permission resolution ────────────────────────────────────────

// ── CRUD ─────────────────────────────────────────────────────────

/**
 * List all roles for an organization (built-in + custom).
 * Lazily seeds built-in roles on first access per org.
 */
export const listRoles = (orgId: string): Effect.Effect<CustomRole[], EnterpriseError | Error> =>
  eeRead("roles", [], Effect.gen(function* () {
    // Lazy seed: ensure built-in roles exist for this org
    yield* seedBuiltinRoles(orgId);

    const rows = yield* Effect.promise(() => internalQuery<CustomRoleRow>(
      `SELECT id, org_id, name, description, permissions, is_builtin, created_at, updated_at
       FROM custom_roles
       WHERE org_id = $1
       ORDER BY is_builtin DESC, name ASC`,
      [orgId],
    ));
    return rows.map(rowToRole);
  }));

/**
 * Get a single role by ID, scoped to org.
 */
export const getRole = (orgId: string, roleId: string): Effect.Effect<CustomRole | null, EnterpriseError> =>
  eeRead("roles", null, Effect.gen(function* () {
    const rows = yield* Effect.promise(() => internalQuery<CustomRoleRow>(
      `SELECT id, org_id, name, description, permissions, is_builtin, created_at, updated_at
       FROM custom_roles
       WHERE id = $1 AND org_id = $2`,
      [roleId, orgId],
    ));
    return rows[0] ? rowToRole(rows[0]) : null;
  }));

/**
 * Get a single role by name, scoped to org. Used by the audit path for
 * role.assign to resolve the caller's `roleName` body param into the row id
 * so the audit row ties the assignment to a stable primary key rather than
 * a string that tenant admins can rename later.
 */
export const getRoleByName = (orgId: string, name: string): Effect.Effect<CustomRole | null, EnterpriseError> =>
  eeRead("roles", null, Effect.gen(function* () {
    const rows = yield* Effect.promise(() => internalQuery<CustomRoleRow>(
      `SELECT id, org_id, name, description, permissions, is_builtin, created_at, updated_at
       FROM custom_roles
       WHERE org_id = $1 AND name = $2`,
      [orgId, name.toLowerCase()],
    ));
    return rows[0] ? rowToRole(rows[0]) : null;
  }));

/**
 * Create a custom role for an organization.
 */
export const createRole = (
  orgId: string,
  input: { name: string; description?: string; permissions: string[] },
): Effect.Effect<CustomRole, RoleError | EnterpriseError | Error> =>
  eeWrite("roles", "custom role management", Effect.gen(function* () {
    // Validate name
    const name = input.name.toLowerCase().trim();
    if (!isValidRoleName(name)) {
      return yield* Effect.fail(new RoleError({ message: `Invalid role name: "${input.name}". Must start with a letter, contain only lowercase letters, numbers, hyphens, or underscores, and be 1-63 characters.`, code: "validation" }));
    }

    // Reject any name that shadows a built-in Atlas role. Matching on the
    // full ATLAS_ROLES set (not just the legacy ["member","owner"] pair)
    // prevents a tenant admin from creating a custom role named
    // `platform_admin` and then promoting any org member to cross-org
    // governance via assignRole. See F-10.
    if (RESERVED_ATLAS_ROLE_NAMES.has(name)) {
      return yield* Effect.fail(new RoleError({ message: `"${name}" is a reserved role name.`, code: "validation" }));
    }

    // Validate permissions
    const invalidPerms = input.permissions.filter((p) => !isValidPermission(p));
    if (invalidPerms.length > 0) {
      return yield* Effect.fail(new RoleError({ message: `Invalid permissions: ${invalidPerms.join(", ")}. Valid permissions: ${PERMISSIONS.join(", ")}`, code: "validation" }));
    }

    // Check name uniqueness within org
    const existing = yield* Effect.promise(() => internalQuery<{ id: string }>(
      `SELECT id FROM custom_roles WHERE org_id = $1 AND name = $2`,
      [orgId, name],
    ));
    if (existing.length > 0) {
      return yield* Effect.fail(new RoleError({ message: `Role "${name}" already exists in this organization.`, code: "conflict" }));
    }

    const rows = yield* Effect.promise(() => internalQuery<CustomRoleRow>(
      `INSERT INTO custom_roles (org_id, name, description, permissions, is_builtin)
       VALUES ($1, $2, $3, $4, false)
       RETURNING id, org_id, name, description, permissions, is_builtin, created_at, updated_at`,
      [orgId, name, input.description ?? "", JSON.stringify(input.permissions)],
    ));

    if (!rows[0]) return yield* Effect.die(new Error("Failed to create role — no row returned."));

    log.info({ orgId, roleName: name }, "Custom role created");
    return rowToRole(rows[0]);
  }));

/**
 * Update a custom role's description and/or permissions.
 * Built-in roles cannot be modified.
 */
export const updateRole = (
  orgId: string,
  roleId: string,
  input: { description?: string; permissions?: string[] },
): Effect.Effect<CustomRole, RoleError | EnterpriseError | Error> =>
  eeWrite("roles", "custom role management", Effect.gen(function* () {
    // Fetch existing
    const existing = yield* getRole(orgId, roleId);
    if (!existing) return yield* Effect.fail(new RoleError({ message: "Role not found.", code: "not_found" }));

    if (existing.isBuiltin) {
      return yield* Effect.fail(new RoleError({ message: "Built-in roles cannot be modified.", code: "builtin_protected" }));
    }

    // Build update
    const sets: string[] = [];
    const params: unknown[] = [];
    let paramIdx = 1;

    if (input.description !== undefined) {
      sets.push(`description = $${paramIdx++}`);
      params.push(input.description);
    }

    if (input.permissions !== undefined) {
      const invalidPerms = input.permissions.filter((p) => !isValidPermission(p));
      if (invalidPerms.length > 0) {
        return yield* Effect.fail(new RoleError({ message: `Invalid permissions: ${invalidPerms.join(", ")}. Valid permissions: ${PERMISSIONS.join(", ")}`, code: "validation" }));
      }
      sets.push(`permissions = $${paramIdx++}`);
      params.push(JSON.stringify(input.permissions));
    }

    if (sets.length === 0) {
      return existing;
    }

    sets.push(`updated_at = now()`);
    params.push(roleId, orgId);

    const rows = yield* Effect.promise(() => internalQuery<CustomRoleRow>(
      `UPDATE custom_roles SET ${sets.join(", ")}
       WHERE id = $${paramIdx++} AND org_id = $${paramIdx}
       RETURNING id, org_id, name, description, permissions, is_builtin, created_at, updated_at`,
      params,
    ));

    if (!rows[0]) return yield* Effect.fail(new RoleError({ message: "Role not found or update failed.", code: "not_found" }));

    log.info({ orgId, roleId }, "Custom role updated");
    return rowToRole(rows[0]);
  }));

/**
 * Delete a custom role. Built-in roles cannot be deleted.
 */
export const deleteRole = (orgId: string, roleId: string): Effect.Effect<boolean, RoleError | EnterpriseError | Error> =>
  eeWrite("roles", "role deletion", Effect.gen(function* () {
    // Check if it's a built-in role
    const role = yield* getRole(orgId, roleId);
    if (!role) return false;

    if (role.isBuiltin) {
      return yield* Effect.fail(new RoleError({ message: "Built-in roles cannot be deleted.", code: "builtin_protected" }));
    }

    // Block deletion when role has active members
    const members = yield* listRoleMembers(orgId, roleId);
    if (members.length > 0) {
      return yield* Effect.fail(new RoleError({ message: `Cannot delete role with ${members.length} active member(s). Reassign them first.`, code: "validation" }));
    }

    const pool = getInternalDB();
    const result = yield* Effect.promise(() =>
      pool.query(
        `DELETE FROM custom_roles WHERE id = $1 AND org_id = $2 RETURNING id`,
        [roleId, orgId],
      ),
    );

    const deleted = result.rows.length > 0;
    if (deleted) {
      log.info({ orgId, roleId, roleName: role.name }, "Custom role deleted");
    }
    return deleted;
  }));

/**
 * List members assigned to a specific role in an organization.
 * Uses Better Auth's `member` table to find users with the matching role name.
 */
export const listRoleMembers = (
  orgId: string,
  roleId: string,
): Effect.Effect<Array<{ userId: string; role: string; createdAt: string }>, RoleError | EnterpriseError> =>
  eeRead("roles", [], Effect.gen(function* () {
    // First get the role name
    const role = yield* getRole(orgId, roleId);
    if (!role) return yield* Effect.fail(new RoleError({ message: "Role not found.", code: "not_found" }));

    // Query Better Auth member table for users with this role in this org
    const rows = yield* Effect.promise(() => internalQuery<{
      userId: string;
      role: string;
      createdAt: string;
      [key: string]: unknown;
    }>(
      `SELECT "userId", role, "createdAt"
       FROM member
       WHERE "organizationId" = $1 AND role = $2
       ORDER BY "createdAt" ASC`,
      [orgId, role.name],
    ));

    return rows.map((r) => ({
      userId: r.userId,
      role: r.role,
      createdAt: String(r.createdAt),
    }));
  }));

/**
 * Assign a role to a user by updating their role in the Better Auth member table.
 * Validates that the role exists in the organization.
 */
export const assignRole = (
  orgId: string,
  userId: string,
  roleName: string,
): Effect.Effect<{ userId: string; role: string }, RoleError | EnterpriseError | Error> =>
  eeWrite("roles", "role assignment", Effect.gen(function* () {
    // Belt-and-suspenders: refuse to write a built-in Atlas role name into
    // `member.role` from the custom-role assignment path. createRole already
    // blocks these names, but a legacy row could exist from before the guard
    // tightened; this check also defends against future callers passing a
    // roleName they've computed rather than looked up. See F-10.
    if (RESERVED_ATLAS_ROLE_NAMES.has(roleName.toLowerCase())) {
      return yield* Effect.fail(new RoleError({
        message: `"${roleName}" is a built-in Atlas role and cannot be assigned through the custom-role endpoint.`,
        code: "validation",
      }));
    }

    // Verify the role exists in this org
    const roleRows = yield* Effect.promise(() => internalQuery<{ id: string }>(
      `SELECT id FROM custom_roles WHERE org_id = $1 AND name = $2`,
      [orgId, roleName],
    ));
    if (roleRows.length === 0) {
      return yield* Effect.fail(new RoleError({ message: `Role "${roleName}" does not exist in this organization.`, code: "not_found" }));
    }

    // Update the member's role
    const result = yield* Effect.promise(() => internalQuery<{ userId: string; role: string; [key: string]: unknown }>(
      `UPDATE member SET role = $1, "updatedAt" = now()
       WHERE "organizationId" = $2 AND "userId" = $3
       RETURNING "userId", role`,
      [roleName, orgId, userId],
    ));

    if (result.length === 0) {
      return yield* Effect.fail(new RoleError({ message: "User is not a member of this organization.", code: "not_found" }));
    }

    log.info({ orgId, userId, roleName }, "Role assigned to user");
    return { userId: result[0].userId, role: result[0].role };
  }));

// ── Seeding ──────────────────────────────────────────────────────

/**
 * Seed built-in roles for an organization. Called during migration.
 * Idempotent — checks each role by name + org_id before inserting.
 */
export const seedBuiltinRoles = (orgId: string): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    if (!hasInternalDB()) {
      log.debug("seedBuiltinRoles skipped — no internal DB");
      return;
    }

    const pool = getInternalDB();
    for (const def of BUILTIN_ROLES) {
      yield* Effect.tryPromise({
        try: async () => {
          const existing = await pool.query(
            `SELECT id FROM custom_roles WHERE org_id = $1 AND name = $2`,
            [orgId, def.name],
          );
          if (existing.rows.length === 0) {
            await pool.query(
              `INSERT INTO custom_roles (org_id, name, description, permissions, is_builtin)
               VALUES ($1, $2, $3, $4, true)`,
              [orgId, def.name, def.description, JSON.stringify(def.permissions)],
            );
          }
        },
        catch: (err) => {
          log.error({ orgId, roleName: def.name, err: err instanceof Error ? err.message : String(err) }, "Failed to seed built-in role");
          return err instanceof Error ? err : new Error(String(err));
        },
      });
    }
  });

// ── Tag wiring (#2571 — slice 9/11 of #2017) ─────────────────────────
//
// Bridges this module's functions into the `RolesPolicy` Tag so core
// call sites (`api/routes/admin-router.ts` for the F-53 permission
// chokepoint, `api/routes/admin-roles.ts` for the custom-role CRUD,
// `api/routes/admin.ts` for inline `enforcePermission` checks) can
// `yield* RolesPolicy` instead of statically or dynamically importing
// this module. Aggregated into `ee/src/layers.ts:EELayer`; the no-op
// default in `lib/effect/services.ts:NoopRolesPolicyLayer` covers
// self-hosted with fail-closed semantics.

export const makeRolesPolicyLive = (): RolesPolicyShape => ({
  checkPermission: coreCheckPermission,
  listRoles,
  getRole,
  getRoleByName,
  createRole,
  updateRole,
  deleteRole,
  listRoleMembers,
  assignRole,
});

export const RolesPolicyLive: Layer.Layer<RolesPolicy> = Layer.sync(
  RolesPolicy,
  makeRolesPolicyLive,
);
