/**
 * Enterprise SCIM directory sync management.
 *
 * Provides admin-facing helpers for SCIM provider connections (list, delete)
 * and SCIM group → custom role mapping. The actual SCIM 2.0 protocol
 * endpoints (Users CRUD, discovery, token generation) are handled by the
 * `@better-auth/scim` plugin registered in server.ts — this module only
 * wraps the enterprise gate and the custom group-mapping layer.
 *
 * Every admin-facing CRUD function routes through the `eeRead`/`eeWrite`
 * combinators, which apply the `requireEnterpriseEffect("scim")` gate —
 * unlicensed deployments get a clear error. The `resolveGroupToRole`
 * helper is designed for the provisioning hot path and intentionally
 * skips the gate, returning null when no mapping exists.
 */

import crypto from "node:crypto";
import { Effect, Layer } from "effect";
import { EnterpriseError } from "@atlas/api/lib/effect/errors";
import { eeRead, eeWrite } from "../lib/ee-query";
import {
  hasInternalDB,
  internalQuery,
  getInternalDB,
} from "@atlas/api/lib/db/internal";
import { createLogger } from "@atlas/api/lib/logger";
import {
  SCIMProvenance,
  type SCIMProvenanceShape,
} from "@atlas/api/lib/effect/services";
import {
  SCIMError,
  type SCIMErrorCode,
} from "@atlas/api/lib/auth/auth-errors";

const log = createLogger("ee:scim");

// ── Typed errors ────────────────────────────────────────────────────

/**
 * `SCIMError` lives in `@atlas/api/lib/auth/auth-errors` post-#2570.
 * Re-exported here for back-compat.
 */
export { SCIMError, type SCIMErrorCode };

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

// ── SCIM Connections (reads Better Auth's managed-connection catalog) ──
//
// Until #5493 these read `scimProvider`, the single table @better-auth/scim
// 1.6 kept per connection. 1.7 replaced it with a catalog:
// `scimManagedConnection` (the connection), `scimManagedCredential` (its
// bearer tokens, HMAC-digested), `scimManagedConnectionEvent` (an audit
// trail) and `scimUser` (the provisioned-user projection).
//
// The exported `SCIMConnection` shape is deliberately UNCHANGED so the admin
// API contract and its OpenAPI schema do not move:
//
//   id             -> scimManagedConnection.id                  (row PK)
//   providerId     -> scimManagedConnection.connectionId        (IdP-facing id)
//   organizationId -> scimManagedConnection.provisioningDomainId
//
// `provisioningDomainId` is the plugin's name for "the application-owned
// boundary that receives provisioned resources", which for Atlas is the
// organization — server.ts passes the org id when creating a connection.

/**
 * List SCIM connections for an organization.
 *
 * Filters to `status = 'active'`: a decommissioned connection keeps its row
 * (the catalog is append-only for audit) but must not appear in the admin
 * list as though it were still provisioning.
 */
export const listConnections = (orgId: string): Effect.Effect<SCIMConnection[], EnterpriseError> =>
  eeRead("scim", [], Effect.gen(function* () {
    const rows = yield* Effect.promise(() => internalQuery<SCIMConnectionRow>(
      `SELECT id,
              "connectionId" AS "providerId",
              "provisioningDomainId" AS "organizationId"
       FROM "scimManagedConnection"
       WHERE "provisioningDomainId" = $1
         AND status = 'active'
       ORDER BY id ASC`,
      [orgId],
    ));
    return rows.map(rowToConnection);
  }));

/**
 * Message for the "enterprise gate let us through but the plugin is not
 * registered" case. One string, three call sites — the condition is
 * identical at each.
 */
const pluginMissing = (operation: string): string =>
  `SCIM plugin is not registered on the auth instance — cannot ${operation}. `
  + "This indicates the enterprise gate and plugin registration have diverged.";

/**
 * Resolve the plugin's server-only API off the auth singleton.
 *
 * The SCIM plugin is pushed conditionally in `buildPlugins()` (enterprise
 * only), so the singleton's inferred `api` type cannot name its endpoints.
 * Callers reach this only behind `eeRead`/`eeWrite`'s enterprise gate — the
 * same condition that registers the plugin.
 */
async function scimApi(): Promise<{
  createSCIMManagedConnection?: (input: { body: Record<string, unknown> }) => Promise<unknown>;
  rotateSCIMManagedCredential?: (input: { body: Record<string, unknown> }) => Promise<unknown>;
  decommissionSCIMManagedConnection?: (input: { body: Record<string, unknown> }) => Promise<unknown>;
}> {
  const { getAuthInstance } = await import("@atlas/api/lib/auth/server");
  return getAuthInstance().api as unknown as Awaited<ReturnType<typeof scimApi>>;
}

/**
 * Resolve the plugin-facing `connectionId` for a connection the given org
 * actually owns, or `undefined`.
 *
 * ⚠️ This lookup is the ONLY cross-organization containment on the
 * managed-connection operations. The plugin's server-only endpoints take a
 * `connectionId` at face value and do no tenancy check of their own, so
 * every caller must scope through here first — it is what stops one
 * workspace rotating or decommissioning another's credential, and it
 * replaces the `AND "organizationId" = $2` predicate the 1.6 SQL carried
 * inline. Shared rather than duplicated per call site: two copies of a
 * containment check is one copy that can drift.
 */
const ownedConnectionId = (
  orgId: string,
  connectionRowId: string,
): Effect.Effect<string | undefined> =>
  Effect.gen(function* () {
    const rows = yield* Effect.promise(() => internalQuery<{ connectionId: string; [key: string]: unknown }>(
      `SELECT "connectionId"
       FROM "scimManagedConnection"
       WHERE id = $1
         AND "provisioningDomainId" = $2
         AND status = 'active'
       LIMIT 1`,
      [connectionRowId, orgId],
    ));
    return rows[0]?.connectionId;
  });

/**
 * Decommission a SCIM connection (revoke access).
 *
 * ⚠️ This is deliberately NOT a `DELETE`. In the 1.6 model one row WAS the
 * connection, so deleting it revoked access completely. In 1.7 a connection
 * owns credentials, a binding and a provisioned-user projection, and tearing
 * it down is a lifecycle with a cursor (`decommissionStatus` moves
 * active -> reconciling -> complete) that reconciles the users it provisioned.
 * A raw DELETE would orphan `scimManagedCredential` and `scimUser` rows and
 * skip that reconciliation, leaving provisioned users behind with no
 * connection to attribute them to — and because these are raw-SQL sites,
 * nothing would fail loudly.
 *
 * So this delegates to the plugin's own `decommissionSCIMManagedConnection`
 * server-only endpoint. It is not reachable over HTTP (that is the structural
 * half of the GHSA-j8v8-g9cx-5qf4 fix); the authorization for reaching it
 * lives on the Atlas admin route that calls into here.
 *
 * Returns false when the org owns no active connection with that id, which
 * the route surfaces as a 404 — the same contract as before.
 */
export const deleteConnection = (orgId: string, connectionId: string): Effect.Effect<boolean, EnterpriseError> =>
  eeRead("scim", false, Effect.gen(function* () {
    const target = yield* ownedConnectionId(orgId, connectionId);
    if (!target) return false;

    // `Effect.promise` (not `tryPromise`) to match the rest of this module:
    // a failure here surfaces as a DEFECT, which is exactly what
    // `admin-scim.ts` already catches via `tapErrorCause` to write the
    // failure audit row. Converting it to a typed error would widen this
    // function's error channel and slip past that handler.
    yield* Effect.promise(async () => {
      const api = await scimApi();
      if (typeof api.decommissionSCIMManagedConnection !== "function") {
        // Fail loudly rather than reporting a revoke that never happened —
        // a silent success here would tell an admin that an IdP connection
        // was torn down while it kept provisioning users.
        throw new Error(pluginMissing("decommission a connection"));
      }
      await api.decommissionSCIMManagedConnection({ body: { connectionId: target } });
    });

    log.info({ orgId, connectionId, target }, "SCIM connection decommissioned");
    return true;
  }));

// ── Credential minting (the GHSA-j8v8-g9cx-5qf4 operation) ──────────
//
// In 1.6 this was `POST /api/auth/scim/generate-token`, a PUBLIC plugin
// route whose ownership check fell open on a NULL `userId`. 1.7 withdraws
// the route and exposes the operation as a SERVER_ONLY endpoint, so the
// only way to reach it is from application code — which means Atlas now
// owns the authorization for it. That check lives on the admin route in
// `api/routes/admin-scim.ts` (`canGenerateSCIMToken`); these helpers
// deliberately do NOT re-implement it, so there is exactly one place where
// the policy is decided.

/** Scopes every Atlas-issued SCIM credential carries. */
const ATLAS_SCIM_SCOPES = [
  "scim.users.read",
  "scim.users.write",
  "scim.groups.read",
  "scim.groups.write",
] as const;

/** Credential lifetime. Matches the one-year default the admin UI documents. */
const CREDENTIAL_TTL_MS = 365 * 24 * 60 * 60 * 1000;

interface IssuedCredential {
  connectionId: string;
  credentialId: string;
  token: string;
  expiresAt: string;
}

/**
 * Read the issued credential out of a mint/rotate response.
 *
 * Every field fails loudly rather than falling back. An earlier revision
 * defaulted `connectionId` to the creation-request id and `expiresAt` to
 * `now + TTL`; both are FABRICATIONS. The request id is an idempotency key,
 * not a connection id, so the caller would receive — and the audit row would
 * record — an id no row matches, and a later rotate or decommission against
 * it would 404. The invented expiry would be shown to an admin as though
 * upstream had set it.
 *
 * The plugin returns the plaintext once and stores only an HMAC digest, so a
 * shape change upstream has to surface here rather than yield values that
 * render as a valid-looking credential.
 */
function readIssued(result: unknown): IssuedCredential {
  const r = (result ?? {}) as Record<string, unknown>;
  const token = typeof r.token === "string" ? r.token : undefined;
  const credentialId = typeof r.credentialId === "string" ? r.credentialId : undefined;
  const connectionId = typeof r.connectionId === "string" ? r.connectionId : undefined;
  const expiresAt = typeof r.expiresAt === "string"
    ? r.expiresAt
    : r.expiresAt instanceof Date
      ? r.expiresAt.toISOString()
      : undefined;

  const missing = [
    token === undefined ? "token" : null,
    credentialId === undefined ? "credentialId" : null,
    connectionId === undefined ? "connectionId" : null,
    expiresAt === undefined ? "expiresAt" : null,
  ].filter((f): f is string => f !== null);

  if (missing.length > 0) {
    throw new Error(
      `SCIM credential mint response is missing ${missing.join(", ")} — `
        + "@better-auth/scim's response shape changed. Refusing to report a "
        + "successful issue with fabricated values.",
    );
  }
  // Non-null assertions are justified by the `missing` check directly above:
  // every one of these is proven defined by the time we get here.
  return {
    connectionId: connectionId!,
    credentialId: credentialId!,
    token: token!,
    expiresAt: expiresAt!,
  };
}

/**
 * Create a SCIM connection for an organization and mint its first credential.
 *
 * `actorUserId` lands in the connection's `createdBy`, which 1.7 declares
 * NOT NULL — the ownerless-row state the advisory turned on cannot be
 * represented any more.
 */
export const createConnection = (
  orgId: string,
  actorUserId: string,
): Effect.Effect<IssuedCredential, SCIMError | EnterpriseError | Error> =>
  eeWrite("scim", "create SCIM connection", Effect.gen(function* () {
    const api = yield* Effect.promise(() => scimApi());
    if (typeof api.createSCIMManagedConnection !== "function") {
      return yield* Effect.fail(new Error(pluginMissing("create a connection")));
    }
    // `creationRequestId` is the plugin's idempotency key (UNIQUE). A fresh
    // uuid per attempt means a retry creates a new connection rather than
    // silently colliding — the admin sees two and can decommission one,
    // which is safer than a retry quietly returning someone else's row.
    const creationRequestId = crypto.randomUUID();
    const result = yield* Effect.tryPromise({
      try: () => api.createSCIMManagedConnection!({
        body: {
          creationRequestId,
          provisioningDomainId: orgId,
          actorId: actorUserId,
          scopes: [...ATLAS_SCIM_SCOPES],
          expiresAt: new Date(Date.now() + CREDENTIAL_TTL_MS).toISOString(),
        },
      }),
      catch: (err) => (err instanceof Error ? err : new Error(String(err))),
    });
    const issued = readIssued(result);
    // Never log `issued.token`.
    log.info(
      { orgId, actorUserId, connectionId: issued.connectionId, credentialId: issued.credentialId },
      "SCIM connection created and credential issued",
    );
    return issued;
  }));

/**
 * Rotate the bearer credential on an existing connection.
 *
 * Scoped to the caller's org before touching the plugin: the endpoint is
 * server-only and takes the connection id at face value, so this lookup is
 * what stops one org rotating another's credential — the same containment
 * the 1.6 route was missing.
 */
export const rotateCredential = (
  orgId: string,
  connectionId: string,
  actorUserId: string,
): Effect.Effect<IssuedCredential, SCIMError | EnterpriseError | Error> =>
  eeWrite("scim", "rotate SCIM credential", Effect.gen(function* () {
    const target = yield* ownedConnectionId(orgId, connectionId);
    if (!target) {
      return yield* Effect.fail(new SCIMError({
        code: "not_found" satisfies SCIMErrorCode,
        message: "SCIM connection not found.",
      }));
    }

    const api = yield* Effect.promise(() => scimApi());
    if (typeof api.rotateSCIMManagedCredential !== "function") {
      return yield* Effect.fail(new Error(pluginMissing("rotate a credential")));
    }
    const result = yield* Effect.tryPromise({
      try: () => api.rotateSCIMManagedCredential!({
        body: {
          connectionId: target,
          provisioningDomainId: orgId,
          actorId: actorUserId,
          scopes: [...ATLAS_SCIM_SCOPES],
          expiresAt: new Date(Date.now() + CREDENTIAL_TTL_MS).toISOString(),
        },
      }),
      catch: (err) => (err instanceof Error ? err : new Error(String(err))),
    });
    const issued = readIssued(result);
    log.info(
      { orgId, actorUserId, connectionId: issued.connectionId, credentialId: issued.credentialId },
      "SCIM credential rotated",
    );
    return issued;
  }));

// ── Sync Status ─────────────────────────────────────────────────────

/**
 * Aggregate SCIM sync status for an organization.
 *
 * `scimUser` is the 1.7 projection of provisioned users, carrying both
 * `userId` and `provisioningDomainId`. That removes the join through
 * `account."providerId"` the 1.6 version needed, and it makes `lastSyncAt`
 * accurate rather than approximate: the old query read
 * `MAX(account."createdAt")`, so it only ever saw user CREATION and silently
 * ignored updates and deactivations. `scimUser."updatedAt"` moves on every
 * sync.
 */
export const getSyncStatus = (orgId: string): Effect.Effect<SCIMSyncStatus, EnterpriseError> =>
  eeRead("scim", { connections: 0, provisionedUsers: 0, lastSyncAt: null }, Effect.gen(function* () {
    // All three queries are independent — run in parallel per CLAUDE.md
    const [connRows, userRows, lastSyncRows] = yield* Effect.promise(() => Promise.all([
      internalQuery<{ count: string; [key: string]: unknown }>(
        `SELECT COUNT(*)::text AS count
         FROM "scimManagedConnection"
         WHERE "provisioningDomainId" = $1 AND status = 'active'`,
        [orgId],
      ),
      internalQuery<{ count: string; [key: string]: unknown }>(
        `SELECT COUNT(DISTINCT "userId")::text AS count
         FROM "scimUser"
         WHERE "provisioningDomainId" = $1 AND active = true`,
        [orgId],
      ),
      internalQuery<{ last_sync: string | null; [key: string]: unknown }>(
        `SELECT MAX("updatedAt")::text AS last_sync
         FROM "scimUser"
         WHERE "provisioningDomainId" = $1`,
        [orgId],
      ),
    ]));

    const connections = parseInt(connRows[0]?.count ?? "0", 10) || 0;
    const provisionedUsers = parseInt(userRows[0]?.count ?? "0", 10) || 0;
    const lastSyncAt = lastSyncRows[0]?.last_sync ?? null;

    return { connections, provisionedUsers, lastSyncAt };
  }));

// ── Group → Role Mapping ────────────────────────────────────────────

/**
 * List SCIM group → role mappings for an organization.
 */
export const listGroupMappings = (orgId: string): Effect.Effect<SCIMGroupMapping[], EnterpriseError> =>
  eeRead("scim", [], Effect.gen(function* () {
    yield* ensureGroupMappingsTable();

    const rows = yield* Effect.promise(() => internalQuery<SCIMGroupMappingRow>(
      `SELECT id, org_id, scim_group_name, role_name, created_at
       FROM scim_group_mappings
       WHERE org_id = $1
       ORDER BY scim_group_name ASC`,
      [orgId],
    ));
    return rows.map(rowToGroupMapping);
  }));

/**
 * Create a SCIM group → role mapping.
 * Validates the role exists in the organization's custom_roles table.
 */
export const createGroupMapping = (
  orgId: string,
  scimGroupName: string,
  roleName: string,
): Effect.Effect<SCIMGroupMapping, SCIMError | EnterpriseError | Error> =>
  eeWrite("scim", "SCIM group mapping", Effect.gen(function* () {
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
  }));

/**
 * Delete a SCIM group → role mapping.
 */
export const deleteGroupMapping = (orgId: string, mappingId: string): Effect.Effect<boolean, EnterpriseError> =>
  eeRead("scim", false, Effect.gen(function* () {
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
  }));

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

// ── Tag wiring (#2570 — slice 8/11 of #2017) ─────────────────────────

export const makeSCIMProvenanceLive = (): SCIMProvenanceShape => ({
  available: true,
  listConnections,
  deleteConnection,
  getSyncStatus,
  createConnection,
  rotateCredential,
  listGroupMappings,
  createGroupMapping,
  deleteGroupMapping,
  resolveGroupToRole,
});

export const SCIMProvenanceLive: Layer.Layer<SCIMProvenance> = Layer.sync(
  SCIMProvenance,
  makeSCIMProvenanceLive,
);
