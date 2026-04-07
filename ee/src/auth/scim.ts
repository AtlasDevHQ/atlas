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

import { Data, Effect } from "effect";
import { requireEnterpriseEffect, EnterpriseError } from "../index";
import { requireInternalDBEffect } from "../lib/db-guard";
import {
  hasInternalDB,
  internalQuery,
  getInternalDB,
} from "@atlas/api/lib/db/internal";
import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("ee:scim");

// ── Typed errors ────────────────────────────────────────────────────

export type SCIMErrorCode = "not_found" | "conflict" | "validation";

export class SCIMError extends Data.TaggedError("SCIMError")<{
  message: string;
  code: SCIMErrorCode;
}> {}

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

const ensureGroupMappingsTable = (): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (_groupMappingsTableEnsured) return;
    if (!hasInternalDB()) return;

    const pool = getInternalDB();
    yield* Effect.promise(() => pool.query(`
      CREATE TABLE IF NOT EXISTS scim_group_mappings (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id TEXT NOT NULL,
        scim_group_name TEXT NOT NULL,
        role_name TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE(org_id, scim_group_name)
      )
    `));
    _groupMappingsTableEnsured = true;
  });

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
export const listConnections = (orgId: string): Effect.Effect<SCIMConnection[], EnterpriseError> =>
  Effect.gen(function* () {
    yield* requireEnterpriseEffect("scim");
    if (!hasInternalDB()) return [];

    const rows = yield* Effect.promise(() => internalQuery<SCIMConnectionRow>(
      `SELECT id, "providerId", "organizationId"
       FROM "scimProvider"
       WHERE "organizationId" = $1
       ORDER BY id ASC`,
      [orgId],
    ));
    return rows.map(rowToConnection);
  });

/**
 * Delete a SCIM provider connection (revoke access).
 */
export const deleteConnection = (orgId: string, connectionId: string): Effect.Effect<boolean, EnterpriseError> =>
  Effect.gen(function* () {
    yield* requireEnterpriseEffect("scim");
    if (!hasInternalDB()) return false;

    const pool = getInternalDB();
    const result = yield* Effect.promise(() =>
      pool.query(
        `DELETE FROM "scimProvider" WHERE id = $1 AND "organizationId" = $2 RETURNING id`,
        [connectionId, orgId],
      ),
    );

    const deleted = result.rows.length > 0;
    if (deleted) {
      log.info({ orgId, connectionId }, "SCIM connection deleted");
    }
    return deleted;
  });

// ── Sync Status ─────────────────────────────────────────────────────

/**
 * Get aggregate SCIM sync status for an organization.
 * Counts active connections and users provisioned via SCIM.
 */
export const getSyncStatus = (orgId: string): Effect.Effect<SCIMSyncStatus, EnterpriseError> =>
  Effect.gen(function* () {
    yield* requireEnterpriseEffect("scim");
    if (!hasInternalDB()) {
      return { connections: 0, provisionedUsers: 0, lastSyncAt: null };
    }

    // All three queries are independent — run in parallel per CLAUDE.md
    const [connRows, userRows, lastSyncRows] = yield* Effect.promise(() => Promise.all([
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
    ]));

    const connections = parseInt(connRows[0]?.count ?? "0", 10) || 0;
    const provisionedUsers = parseInt(userRows[0]?.count ?? "0", 10) || 0;
    const lastSyncAt = lastSyncRows[0]?.last_sync ?? null;

    return { connections, provisionedUsers, lastSyncAt };
  });

// ── Group → Role Mapping ────────────────────────────────────────────

/**
 * List SCIM group → role mappings for an organization.
 */
export const listGroupMappings = (orgId: string): Effect.Effect<SCIMGroupMapping[], EnterpriseError> =>
  Effect.gen(function* () {
    yield* requireEnterpriseEffect("scim");
    if (!hasInternalDB()) return [];
    yield* ensureGroupMappingsTable();

    const rows = yield* Effect.promise(() => internalQuery<SCIMGroupMappingRow>(
      `SELECT id, org_id, scim_group_name, role_name, created_at
       FROM scim_group_mappings
       WHERE org_id = $1
       ORDER BY scim_group_name ASC`,
      [orgId],
    ));
    return rows.map(rowToGroupMapping);
  });

/**
 * Create a SCIM group → role mapping.
 * Validates the role exists in the organization's custom_roles table.
 */
export const createGroupMapping = (
  orgId: string,
  scimGroupName: string,
  roleName: string,
): Effect.Effect<SCIMGroupMapping, SCIMError | EnterpriseError | Error> =>
  Effect.gen(function* () {
    yield* requireEnterpriseEffect("scim");
    yield* requireInternalDBEffect("SCIM group mapping");
    yield* ensureGroupMappingsTable();

    // Validate group name
    if (!isValidScimGroupName(scimGroupName)) {
      return yield* Effect.fail(new SCIMError({ message: `Invalid SCIM group name: "${scimGroupName}". Must be 1-255 characters, starting with alphanumeric.`, code: "validation" }));
    }

    // Validate role exists in this org
    const roleRows = yield* Effect.promise(() => internalQuery<{ id: string; [key: string]: unknown }>(
      `SELECT id FROM custom_roles WHERE org_id = $1 AND name = $2`,
      [orgId, roleName],
    ));
    if (roleRows.length === 0) {
      return yield* Effect.fail(new SCIMError({ message: `Role "${roleName}" does not exist in this organization. Create the role first.`, code: "not_found" }));
    }

    // Check for duplicate mapping
    const existing = yield* Effect.promise(() => internalQuery<{ id: string; [key: string]: unknown }>(
      `SELECT id FROM scim_group_mappings WHERE org_id = $1 AND scim_group_name = $2`,
      [orgId, scimGroupName],
    ));
    if (existing.length > 0) {
      return yield* Effect.fail(new SCIMError({ message: `A mapping for SCIM group "${scimGroupName}" already exists in this organization.`, code: "conflict" }));
    }

    const rows = yield* Effect.promise(() => internalQuery<SCIMGroupMappingRow>(
      `INSERT INTO scim_group_mappings (org_id, scim_group_name, role_name)
       VALUES ($1, $2, $3)
       RETURNING id, org_id, scim_group_name, role_name, created_at`,
      [orgId, scimGroupName, roleName],
    ));

    if (!rows[0]) return yield* Effect.die(new Error("Failed to create group mapping — no row returned."));

    log.info({ orgId, scimGroupName, roleName }, "SCIM group mapping created");
    return rowToGroupMapping(rows[0]);
  });

/**
 * Delete a SCIM group → role mapping.
 */
export const deleteGroupMapping = (orgId: string, mappingId: string): Effect.Effect<boolean, EnterpriseError> =>
  Effect.gen(function* () {
    yield* requireEnterpriseEffect("scim");
    if (!hasInternalDB()) return false;
    yield* ensureGroupMappingsTable();

    const pool = getInternalDB();
    const result = yield* Effect.promise(() =>
      pool.query(
        `DELETE FROM scim_group_mappings WHERE id = $1 AND org_id = $2 RETURNING id`,
        [mappingId, orgId],
      ),
    );

    const deleted = result.rows.length > 0;
    if (deleted) {
      log.info({ orgId, mappingId }, "SCIM group mapping deleted");
    }
    return deleted;
  });

/**
 * Resolve a SCIM group display name to an Atlas role name.
 * Returns null if no mapping exists for the group.
 */
export const resolveGroupToRole = (orgId: string, scimGroupName: string): Effect.Effect<string | null, Error> =>
  Effect.gen(function* () {
    if (!hasInternalDB()) return null;

    return yield* Effect.tryPromise({
      try: async () => {
        await Effect.runPromise(ensureGroupMappingsTable());
        const rows = await internalQuery<{ role_name: string; [key: string]: unknown }>(
          `SELECT role_name FROM scim_group_mappings WHERE org_id = $1 AND scim_group_name = $2 LIMIT 1`,
          [orgId, scimGroupName],
        );
        return rows[0]?.role_name ?? null;
      },
      catch: (err) => err instanceof Error ? err : new Error(String(err)),
    }).pipe(
      Effect.catchAll((err) => {
        const msg = err.message;
        if (msg.includes("does not exist")) {
          // Table not yet created — no mappings configured
          return Effect.succeed(null);
        }
        // All other errors must propagate — silently returning null
        // would skip role assignment and is a security-relevant failure.
        return Effect.fail(err);
      }),
    );
  });
