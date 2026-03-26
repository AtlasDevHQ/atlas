/**
 * Enterprise SCIM directory sync management.
 *
 * Provides admin-facing helpers for SCIM provider connections (list, delete)
 * and SCIM group → custom role mapping. The actual SCIM 2.0 protocol
 * endpoints (Users CRUD, discovery, token generation) are handled by the
 * `@better-auth/scim` plugin registered in server.ts — this module only
 * wraps the enterprise gate and the custom group-mapping layer.
 *
 * Every admin-facing CRUD function calls `requireEnterprise("scim")` —
 * unlicensed deployments get a clear error. The `resolveGroupToRole`
 * helper is designed for the provisioning hot path and intentionally
 * skips the gate, returning null when no mapping exists.
 */

import { requireEnterprise } from "../index";
import {
  hasInternalDB,
  internalQuery,
  getInternalDB,
} from "@atlas/api/lib/db/internal";
import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("ee:scim");

// ── Typed errors ────────────────────────────────────────────────────

export type SCIMErrorCode = "not_found" | "conflict" | "validation";

export class SCIMError extends Error {
  constructor(message: string, public readonly code: SCIMErrorCode) {
    super(message);
    this.name = "SCIMError";
  }
}

// ── Types ───────────────────────────────────────────────────────────

export interface SCIMConnection {
  id: string;
  providerId: string;
  organizationId: string | null;
}

interface SCIMConnectionRow {
  id: string;
  providerId: string;
  organizationId: string | null;
  [key: string]: unknown;
}

export interface SCIMGroupMapping {
  id: string;
  orgId: string;
  scimGroupName: string;
  roleName: string;
  createdAt: string;
}

interface SCIMGroupMappingRow {
  id: string;
  org_id: string;
  scim_group_name: string;
  role_name: string;
  created_at: string;
  [key: string]: unknown;
}

export interface SCIMSyncStatus {
  connections: number;
  provisionedUsers: number;
  lastSyncAt: string | null;
}

// ── Table bootstrapping ─────────────────────────────────────────────

let _groupMappingsTableEnsured = false;

async function ensureGroupMappingsTable(): Promise<void> {
  if (_groupMappingsTableEnsured) return;
  if (!hasInternalDB()) return;

  const pool = getInternalDB();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS scim_group_mappings (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id TEXT NOT NULL,
      scim_group_name TEXT NOT NULL,
      role_name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(org_id, scim_group_name)
    )
  `);
  _groupMappingsTableEnsured = true;
}

/** @internal — test-only. Reset the table-ensured flag. */
export function _resetTableEnsured(): void {
  _groupMappingsTableEnsured = false;
}

// ── Helpers ─────────────────────────────────────────────────────────

function rowToConnection(row: SCIMConnectionRow): SCIMConnection {
  return {
    id: row.id,
    providerId: row.providerId,
    organizationId: row.organizationId ?? null,
  };
}

function rowToGroupMapping(row: SCIMGroupMappingRow): SCIMGroupMapping {
  return {
    id: row.id,
    orgId: row.org_id,
    scimGroupName: row.scim_group_name,
    roleName: row.role_name,
    createdAt: String(row.created_at),
  };
}

// ── Validation ──────────────────────────────────────────────────────

// SCIM group display names: alphanumeric start, up to 255 chars.
// Allows spaces, underscores, hyphens, dots — restrictive enough to prevent
// injection while permitting common IdP group name formats.
const SCIM_GROUP_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9 _.-]{0,254}$/;

export function isValidScimGroupName(name: string): boolean {
  return SCIM_GROUP_NAME_RE.test(name);
}

// ── SCIM Connections (reads from Better Auth's scimProvider table) ──

/**
 * List SCIM provider connections for an organization.
 * Reads from the `scimProvider` table created by @better-auth/scim.
 */
export async function listConnections(orgId: string): Promise<SCIMConnection[]> {
  requireEnterprise("scim");
  if (!hasInternalDB()) return [];

  const rows = await internalQuery<SCIMConnectionRow>(
    `SELECT id, "providerId", "organizationId"
     FROM "scimProvider"
     WHERE "organizationId" = $1
     ORDER BY id ASC`,
    [orgId],
  );
  return rows.map(rowToConnection);
}

/**
 * Delete a SCIM provider connection (revoke access).
 */
export async function deleteConnection(orgId: string, connectionId: string): Promise<boolean> {
  requireEnterprise("scim");
  if (!hasInternalDB()) return false;

  const pool = getInternalDB();
  const result = await pool.query(
    `DELETE FROM "scimProvider" WHERE id = $1 AND "organizationId" = $2 RETURNING id`,
    [connectionId, orgId],
  );

  const deleted = result.rows.length > 0;
  if (deleted) {
    log.info({ orgId, connectionId }, "SCIM connection deleted");
  }
  return deleted;
}

// ── Sync Status ─────────────────────────────────────────────────────

/**
 * Get aggregate SCIM sync status for an organization.
 * Counts active connections and users provisioned via SCIM.
 */
export async function getSyncStatus(orgId: string): Promise<SCIMSyncStatus> {
  requireEnterprise("scim");
  if (!hasInternalDB()) {
    return { connections: 0, provisionedUsers: 0, lastSyncAt: null };
  }

  // All three queries are independent — run in parallel per CLAUDE.md
  const [connRows, userRows, lastSyncRows] = await Promise.all([
    internalQuery<{ count: string; [key: string]: unknown }>(
      `SELECT COUNT(*)::text AS count FROM "scimProvider" WHERE "organizationId" = $1`,
      [orgId],
    ),
    // Count users provisioned via SCIM — Better Auth stores each external identity
    // in the `account` table with a `providerId` matching the SCIM provider's ID.
    internalQuery<{ count: string; [key: string]: unknown }>(
      `SELECT COUNT(DISTINCT a."userId")::text AS count
       FROM account a
       JOIN "scimProvider" sp ON a."providerId" = sp."providerId"
       WHERE sp."organizationId" = $1`,
      [orgId],
    ),
    // Last sync approximation: most recent SCIM-provisioned user creation.
    // Misses sync events that only update/deactivate existing users.
    internalQuery<{ last_sync: string | null; [key: string]: unknown }>(
      `SELECT MAX(a."createdAt")::text AS last_sync
       FROM account a
       JOIN "scimProvider" sp ON a."providerId" = sp."providerId"
       WHERE sp."organizationId" = $1`,
      [orgId],
    ),
  ]);

  const connections = parseInt(connRows[0]?.count ?? "0", 10) || 0;
  const provisionedUsers = parseInt(userRows[0]?.count ?? "0", 10) || 0;
  const lastSyncAt = lastSyncRows[0]?.last_sync ?? null;

  return { connections, provisionedUsers, lastSyncAt };
}

// ── Group → Role Mapping ────────────────────────────────────────────

/**
 * List SCIM group → role mappings for an organization.
 */
export async function listGroupMappings(orgId: string): Promise<SCIMGroupMapping[]> {
  requireEnterprise("scim");
  if (!hasInternalDB()) return [];
  await ensureGroupMappingsTable();

  const rows = await internalQuery<SCIMGroupMappingRow>(
    `SELECT id, org_id, scim_group_name, role_name, created_at
     FROM scim_group_mappings
     WHERE org_id = $1
     ORDER BY scim_group_name ASC`,
    [orgId],
  );
  return rows.map(rowToGroupMapping);
}

/**
 * Create a SCIM group → role mapping.
 * Validates the role exists in the organization's custom_roles table.
 */
export async function createGroupMapping(
  orgId: string,
  scimGroupName: string,
  roleName: string,
): Promise<SCIMGroupMapping> {
  requireEnterprise("scim");
  if (!hasInternalDB()) {
    throw new Error("Internal database required for SCIM group mapping.");
  }
  await ensureGroupMappingsTable();

  // Validate group name
  if (!isValidScimGroupName(scimGroupName)) {
    throw new SCIMError(
      `Invalid SCIM group name: "${scimGroupName}". Must be 1-255 characters, starting with alphanumeric.`,
      "validation",
    );
  }

  // Validate role exists in this org
  const roleRows = await internalQuery<{ id: string; [key: string]: unknown }>(
    `SELECT id FROM custom_roles WHERE org_id = $1 AND name = $2`,
    [orgId, roleName],
  );
  if (roleRows.length === 0) {
    throw new SCIMError(
      `Role "${roleName}" does not exist in this organization. Create the role first.`,
      "not_found",
    );
  }

  // Check for duplicate mapping
  const existing = await internalQuery<{ id: string; [key: string]: unknown }>(
    `SELECT id FROM scim_group_mappings WHERE org_id = $1 AND scim_group_name = $2`,
    [orgId, scimGroupName],
  );
  if (existing.length > 0) {
    throw new SCIMError(
      `A mapping for SCIM group "${scimGroupName}" already exists in this organization.`,
      "conflict",
    );
  }

  const rows = await internalQuery<SCIMGroupMappingRow>(
    `INSERT INTO scim_group_mappings (org_id, scim_group_name, role_name)
     VALUES ($1, $2, $3)
     RETURNING id, org_id, scim_group_name, role_name, created_at`,
    [orgId, scimGroupName, roleName],
  );

  if (!rows[0]) throw new Error("Failed to create group mapping — no row returned.");

  log.info({ orgId, scimGroupName, roleName }, "SCIM group mapping created");
  return rowToGroupMapping(rows[0]);
}

/**
 * Delete a SCIM group → role mapping.
 */
export async function deleteGroupMapping(orgId: string, mappingId: string): Promise<boolean> {
  requireEnterprise("scim");
  if (!hasInternalDB()) return false;
  await ensureGroupMappingsTable();

  const pool = getInternalDB();
  const result = await pool.query(
    `DELETE FROM scim_group_mappings WHERE id = $1 AND org_id = $2 RETURNING id`,
    [mappingId, orgId],
  );

  const deleted = result.rows.length > 0;
  if (deleted) {
    log.info({ orgId, mappingId }, "SCIM group mapping deleted");
  }
  return deleted;
}

/**
 * Resolve a SCIM group display name to an Atlas role name.
 * Returns null if no mapping exists for the group.
 */
export async function resolveGroupToRole(orgId: string, scimGroupName: string): Promise<string | null> {
  if (!hasInternalDB()) return null;

  try {
    await ensureGroupMappingsTable();
    const rows = await internalQuery<{ role_name: string; [key: string]: unknown }>(
      `SELECT role_name FROM scim_group_mappings WHERE org_id = $1 AND scim_group_name = $2 LIMIT 1`,
      [orgId, scimGroupName],
    );
    return rows[0]?.role_name ?? null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("does not exist")) {
      // Table not yet created — no mappings configured
      return null;
    }
    // All other errors must propagate — silently returning null
    // would skip role assignment and is a security-relevant failure.
    throw err;
  }
}
