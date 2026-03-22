/**
 * Enterprise custom role management.
 *
 * Granular permission-based RBAC system. Roles are sets of permission flags.
 * Three built-in roles (admin, analyst, viewer) are seeded on migration and
 * cannot be deleted. Custom roles are per-organization.
 *
 * CRUD functions call `requireEnterprise("roles")` — unlicensed deployments
 * get a clear error. Permission check helpers do NOT require a license and
 * fall back to legacy admin/member role mapping.
 */

import { requireEnterprise } from "../index";
import {
  hasInternalDB,
  internalQuery,
  getInternalDB,
} from "@atlas/api/lib/db/internal";
import { createLogger } from "@atlas/api/lib/logger";
import type { AtlasUser } from "@atlas/api/lib/auth/types";

const log = createLogger("ee:roles");

// ── Permission flags ─────────────────────────────────────────────

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

export type RoleErrorCode = "not_found" | "conflict" | "validation" | "builtin_protected";

export class RoleError extends Error {
  constructor(message: string, public readonly code: RoleErrorCode) {
    super(message);
    this.name = "RoleError";
  }
}

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

/**
 * Legacy role-to-permission mapping for non-enterprise deployments.
 * Maps the AtlasRole (member/admin/owner) to permission sets.
 */
const LEGACY_ROLE_PERMISSIONS: Record<string, readonly Permission[]> = {
  owner: [...PERMISSIONS],
  admin: [...PERMISSIONS],
  member: ["query", "query:raw_data"],
};

/**
 * Resolve the effective permissions for a user session.
 *
 * Resolution strategy:
 * 1. If enterprise + internal DB + custom role assigned: use custom role permissions
 * 2. Otherwise, fall back to legacy role mapping (admin/owner = all, member = query)
 *
 * This function does NOT call requireEnterprise — it is used during request
 * handling where the check should be transparent.
 */
export async function resolvePermissions(user: AtlasUser | undefined): Promise<Set<Permission>> {
  // No user → check auth mode. Only grant all permissions in no-auth mode (local dev).
  if (!user) {
    const { detectAuthMode } = await import("@atlas/api/lib/auth/detect");
    const mode = detectAuthMode();
    if (mode === "none") {
      return new Set([...PERMISSIONS]);
    }
    log.warn("resolvePermissions called with undefined user in managed auth mode — denying all");
    return new Set<Permission>();
  }

  const role = user.role ?? "member";

  // Try enterprise custom roles if internal DB is available
  if (hasInternalDB() && user.activeOrganizationId) {
    try {
      // Check if user has a custom role name assigned (stored in the user's role field)
      const rows = await internalQuery<CustomRoleRow>(
        `SELECT id, org_id, name, description, permissions, is_builtin, created_at, updated_at
         FROM custom_roles
         WHERE org_id = $1 AND name = $2
         LIMIT 1`,
        [user.activeOrganizationId, role],
      );

      if (rows[0]) {
        const customRole = rowToRole(rows[0]);
        return new Set(customRole.permissions);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("does not exist")) {
        // Table not yet created by migration — fall through to legacy
        log.debug("custom_roles table not yet created — using legacy permissions");
      } else {
        // Fail closed: DB error → minimal permissions, not elevated legacy ones
        log.error({ err: msg }, "Failed to resolve custom role — denying elevated permissions");
        return new Set<Permission>(["query"]);
      }
    }
  }

  // Legacy fallback
  const legacyPerms = LEGACY_ROLE_PERMISSIONS[role] ?? LEGACY_ROLE_PERMISSIONS.member;
  return new Set(legacyPerms);
}

/**
 * Check whether a user has a specific permission.
 * Falls back to legacy role checks if enterprise roles are not configured.
 */
export async function hasPermission(
  user: AtlasUser | undefined,
  permission: Permission,
): Promise<boolean> {
  const perms = await resolvePermissions(user);
  return perms.has(permission);
}

/**
 * Hono middleware factory that checks a specific permission.
 * Returns a function that takes `(req, requestId, user)` and returns
 * an error response object or null if authorized.
 */
export async function checkPermission(
  user: AtlasUser | undefined,
  permission: Permission,
  requestId: string,
): Promise<{ body: Record<string, unknown>; status: 403 } | null> {
  const allowed = await hasPermission(user, permission);
  if (!allowed) {
    log.warn(
      { userId: user?.id, permission, requestId },
      "Permission check failed: user lacks %s",
      permission,
    );
    return {
      body: {
        error: "insufficient_permissions",
        message: `This action requires the "${permission}" permission.`,
        requestId,
      },
      status: 403,
    };
  }
  return null;
}

// ── CRUD ─────────────────────────────────────────────────────────

/**
 * List all roles for an organization (built-in + custom).
 * Lazily seeds built-in roles on first access per org.
 */
export async function listRoles(orgId: string): Promise<CustomRole[]> {
  requireEnterprise("roles");
  if (!hasInternalDB()) return [];

  // Lazy seed: ensure built-in roles exist for this org
  await seedBuiltinRoles(orgId);

  const rows = await internalQuery<CustomRoleRow>(
    `SELECT id, org_id, name, description, permissions, is_builtin, created_at, updated_at
     FROM custom_roles
     WHERE org_id = $1
     ORDER BY is_builtin DESC, name ASC`,
    [orgId],
  );
  return rows.map(rowToRole);
}

/**
 * Get a single role by ID, scoped to org.
 */
export async function getRole(orgId: string, roleId: string): Promise<CustomRole | null> {
  requireEnterprise("roles");
  if (!hasInternalDB()) return null;

  const rows = await internalQuery<CustomRoleRow>(
    `SELECT id, org_id, name, description, permissions, is_builtin, created_at, updated_at
     FROM custom_roles
     WHERE id = $1 AND org_id = $2`,
    [roleId, orgId],
  );
  return rows[0] ? rowToRole(rows[0]) : null;
}

/**
 * Create a custom role for an organization.
 */
export async function createRole(
  orgId: string,
  input: { name: string; description?: string; permissions: string[] },
): Promise<CustomRole> {
  requireEnterprise("roles");
  if (!hasInternalDB()) {
    throw new Error("Internal database required for custom role management.");
  }

  // Validate name
  const name = input.name.toLowerCase().trim();
  if (!isValidRoleName(name)) {
    throw new RoleError(
      `Invalid role name: "${input.name}". Must start with a letter, contain only lowercase letters, numbers, hyphens, or underscores, and be 1-63 characters.`,
      "validation",
    );
  }

  // Reject reserved legacy role names that would shadow built-in behavior
  const RESERVED_ROLE_NAMES = new Set(["member", "owner"]);
  if (RESERVED_ROLE_NAMES.has(name)) {
    throw new RoleError(`"${name}" is a reserved role name.`, "validation");
  }

  // Validate permissions
  const invalidPerms = input.permissions.filter((p) => !isValidPermission(p));
  if (invalidPerms.length > 0) {
    throw new RoleError(
      `Invalid permissions: ${invalidPerms.join(", ")}. Valid permissions: ${PERMISSIONS.join(", ")}`,
      "validation",
    );
  }

  // Check name uniqueness within org
  const existing = await internalQuery<{ id: string }>(
    `SELECT id FROM custom_roles WHERE org_id = $1 AND name = $2`,
    [orgId, name],
  );
  if (existing.length > 0) {
    throw new RoleError(`Role "${name}" already exists in this organization.`, "conflict");
  }

  const rows = await internalQuery<CustomRoleRow>(
    `INSERT INTO custom_roles (org_id, name, description, permissions, is_builtin)
     VALUES ($1, $2, $3, $4, false)
     RETURNING id, org_id, name, description, permissions, is_builtin, created_at, updated_at`,
    [orgId, name, input.description ?? "", JSON.stringify(input.permissions)],
  );

  if (!rows[0]) throw new Error("Failed to create role — no row returned.");

  log.info({ orgId, roleName: name }, "Custom role created");
  return rowToRole(rows[0]);
}

/**
 * Update a custom role's description and/or permissions.
 * Built-in roles cannot be modified.
 */
export async function updateRole(
  orgId: string,
  roleId: string,
  input: { description?: string; permissions?: string[] },
): Promise<CustomRole> {
  requireEnterprise("roles");
  if (!hasInternalDB()) {
    throw new Error("Internal database required for custom role management.");
  }

  // Fetch existing
  const existing = await getRole(orgId, roleId);
  if (!existing) throw new RoleError("Role not found.", "not_found");

  if (existing.isBuiltin) {
    throw new RoleError("Built-in roles cannot be modified.", "builtin_protected");
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
      throw new RoleError(
        `Invalid permissions: ${invalidPerms.join(", ")}. Valid permissions: ${PERMISSIONS.join(", ")}`,
        "validation",
      );
    }
    sets.push(`permissions = $${paramIdx++}`);
    params.push(JSON.stringify(input.permissions));
  }

  if (sets.length === 0) {
    return existing;
  }

  sets.push(`updated_at = now()`);
  params.push(roleId, orgId);

  const rows = await internalQuery<CustomRoleRow>(
    `UPDATE custom_roles SET ${sets.join(", ")}
     WHERE id = $${paramIdx++} AND org_id = $${paramIdx}
     RETURNING id, org_id, name, description, permissions, is_builtin, created_at, updated_at`,
    params,
  );

  if (!rows[0]) throw new RoleError("Role not found or update failed.", "not_found");

  log.info({ orgId, roleId }, "Custom role updated");
  return rowToRole(rows[0]);
}

/**
 * Delete a custom role. Built-in roles cannot be deleted.
 */
export async function deleteRole(orgId: string, roleId: string): Promise<boolean> {
  requireEnterprise("roles");
  if (!hasInternalDB()) {
    throw new Error("Internal database required for role deletion.");
  }

  // Check if it's a built-in role
  const role = await getRole(orgId, roleId);
  if (!role) return false;

  if (role.isBuiltin) {
    throw new RoleError("Built-in roles cannot be deleted.", "builtin_protected");
  }

  // Block deletion when role has active members
  const members = await listRoleMembers(orgId, roleId);
  if (members.length > 0) {
    throw new RoleError(
      `Cannot delete role with ${members.length} active member(s). Reassign them first.`,
      "validation",
    );
  }

  const pool = getInternalDB();
  const result = await pool.query(
    `DELETE FROM custom_roles WHERE id = $1 AND org_id = $2 RETURNING id`,
    [roleId, orgId],
  );

  const deleted = result.rows.length > 0;
  if (deleted) {
    log.info({ orgId, roleId, roleName: role.name }, "Custom role deleted");
  }
  return deleted;
}

/**
 * List members assigned to a specific role in an organization.
 * Uses Better Auth's `member` table to find users with the matching role name.
 */
export async function listRoleMembers(
  orgId: string,
  roleId: string,
): Promise<Array<{ userId: string; role: string; createdAt: string }>> {
  requireEnterprise("roles");
  if (!hasInternalDB()) return [];

  // First get the role name
  const role = await getRole(orgId, roleId);
  if (!role) throw new RoleError("Role not found.", "not_found");

  // Query Better Auth member table for users with this role in this org
  const rows = await internalQuery<{
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
  );

  return rows.map((r) => ({
    userId: r.userId,
    role: r.role,
    createdAt: String(r.createdAt),
  }));
}

/**
 * Assign a role to a user by updating their role in the Better Auth member table.
 * Validates that the role exists in the organization.
 */
export async function assignRole(
  orgId: string,
  userId: string,
  roleName: string,
): Promise<{ userId: string; role: string }> {
  requireEnterprise("roles");
  if (!hasInternalDB()) {
    throw new Error("Internal database required for role assignment.");
  }

  // Verify the role exists in this org
  const roleRows = await internalQuery<{ id: string }>(
    `SELECT id FROM custom_roles WHERE org_id = $1 AND name = $2`,
    [orgId, roleName],
  );
  if (roleRows.length === 0) {
    throw new RoleError(`Role "${roleName}" does not exist in this organization.`, "not_found");
  }

  // Update the member's role
  const result = await internalQuery<{ userId: string; role: string; [key: string]: unknown }>(
    `UPDATE member SET role = $1, "updatedAt" = now()
     WHERE "organizationId" = $2 AND "userId" = $3
     RETURNING "userId", role`,
    [roleName, orgId, userId],
  );

  if (result.length === 0) {
    throw new RoleError("User is not a member of this organization.", "not_found");
  }

  log.info({ orgId, userId, roleName }, "Role assigned to user");
  return { userId: result[0].userId, role: result[0].role };
}

// ── Seeding ──────────────────────────────────────────────────────

/**
 * Seed built-in roles for an organization. Called during migration.
 * Idempotent — checks each role by name + org_id before inserting.
 */
export async function seedBuiltinRoles(orgId: string): Promise<void> {
  if (!hasInternalDB()) {
    log.debug("seedBuiltinRoles skipped — no internal DB");
    return;
  }

  const pool = getInternalDB();
  for (const def of BUILTIN_ROLES) {
    try {
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
    } catch (err) {
      log.error({ orgId, roleName: def.name, err: err instanceof Error ? err.message : String(err) }, "Failed to seed built-in role");
      throw err;
    }
  }
}
