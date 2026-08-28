/**
 * Real-Postgres falsifier for the scim* half of the GDPR purge (#5515).
 *
 * The gap this pins, quoted from the issue: `scimUser.userId` references
 * `user.id` (better-auth's migrator defaults the FK to ON DELETE CASCADE)
 * while `hardDeleteWorkspace` deletes only ORPHANED users — so the cascade
 * never fires for a user who is still a member of another workspace, and
 * their `scimUser` projection (primaryEmail, displayName, serializedEmails)
 * survived the purge of the workspace that provisioned it. The domain-keyed
 * tables (`scimManagedConnection` / `scimManagedCredential` / `scimGroup` /
 * `scimGroupMember` …) had no delete path at all.
 *
 * Why real Postgres: the deletes' value is entirely in their WHERE clauses
 * and their child-before-parent subquery order, and the FK cascades this
 * fixture mirrors are exactly what could make a missing statement look
 * covered. A mocked query layer evaluates none of that.
 *
 * The load-bearing assertions are the NEGATIVE ones, in the migration-0209
 * suite's style:
 *
 *   - the MULTI-WORKSPACE user keeps their account and their OTHER domain's
 *     projection — while their purged-domain projection is gone. Without the
 *     shared user, "the projection is gone" is satisfied by an unscoped
 *     DELETE or by the user-cascade, and the actual bug is unreachable.
 *   - the DECOMMISSIONED connection is deleted too — the catalog is
 *     append-only for audit in normal operation, so a status-narrowed DELETE
 *     would quietly retain it (the repo owner's #5515 decision: no retention
 *     arm).
 *   - the NEIGHBOUR workspace's whole catalog survives, row for row — an
 *     unscoped delete satisfies every "zero rows remain" check while
 *     destroying other tenants' directory sync.
 *   - the final sweep asserts NO scim* row referencing the purged
 *     organization, its provisioning domain, its connections, its groups or
 *     its projections survives — by column, derived from information_schema,
 *     so a table gaining a referencing column joins the sweep automatically.
 *
 * The tables are stood up here rather than by migrations because they are
 * plugin-owned: better-auth's schema-diff creates them at boot where EE SCIM
 * is enabled, never the Atlas runner. FKs mirror what the migrator builds —
 * every declared reference without an explicit onDelete gets CASCADE
 * (get-migration.mjs: `onDelete(field.references.onDelete || "cascade")`).
 * The cascades are deliberately PRESENT so a child DELETE that stopped
 * running would still leave zero rows — and be caught by the exact-count
 * assertions instead, the same split the main falsifier documents for
 * session/account.
 *
 * The never-enabled arm — the catalog ABSENT, the purge complete with no
 * skips — is asserted in hard-delete-purge-pg.test.ts, whose fixture
 * deliberately does not stand these tables up.
 *
 * Skipped cleanly when TEST_DATABASE_URL is unset. CI's api-tests workflow
 * provides the Postgres service.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import { runMigrations } from "@atlas/api/lib/db/migrate";
import {
  hardDeleteWorkspace,
  _resetPool,
  type InternalPool,
  type HardDeleteResult,
} from "@atlas/api/lib/db/internal";
import { SCIM_PLUGIN_TABLES } from "../purge-scope";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;

const PG_TIMEOUT_MS = 120_000;

const ORG = "org-scim-purge";
/** Seeded identically, never purged — the blast-radius control. */
const NEIGHBOUR = "org-scim-neighbour";
/** Member of ORG only — orphaned by the purge; their user-keyed scim rows go. */
const USER_ORPHAN = "user-scim-orphan";
/**
 * Member of BOTH workspaces, provisioned in BOTH domains. THE case: the purge
 * must remove their ORG-domain projection while sparing the user row and the
 * NEIGHBOUR-domain projection. Without this user every projection assertion
 * is satisfiable by the user-FK cascade alone.
 */
const USER_SHARED = "user-scim-shared";

/** The ORG-side ids the final sweep hunts for. */
const ORG_CONNECTION_ROW_IDS = ["mc-org-active", "mc-org-decom"] as const;
const ORG_CONNECTION_IDS = [
  "ba_scim_connection_orgactive",
  "ba_scim_connection_orgdecom",
] as const;
const ORG_SCIM_USER_IDS = ["su-org-orphan", "su-org-shared"] as const;
const ORG_GROUP_IDS = ["g-org"] as const;

/** Minimal Better Auth spine — same shape the main falsifier bootstraps. */
const BETTER_AUTH_BOOTSTRAP_SQL = `
  CREATE TABLE IF NOT EXISTS "user" (
    id TEXT PRIMARY KEY,
    email TEXT,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    name TEXT,
    role TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS "session" (
    id TEXT PRIMARY KEY,
    "userId" TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    token TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS "account" (
    id TEXT PRIMARY KEY,
    "userId" TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    "providerId" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS "organization" (
    id TEXT PRIMARY KEY,
    name TEXT,
    slug TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS "member" (
    id TEXT PRIMARY KEY,
    "organizationId" TEXT NOT NULL REFERENCES "organization"(id) ON DELETE CASCADE,
    "userId" TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    role TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS "invitation" (
    id TEXT PRIMARY KEY,
    "organizationId" TEXT NOT NULL REFERENCES "organization"(id) ON DELETE CASCADE,
    email TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
  );
`;

/**
 * The @better-auth/scim 1.7 catalog, with the columns this suite's seeds and
 * `hardDeleteWorkspace`'s statements touch, plus the personal-data columns the
 * issue names (primaryEmail, displayName, serializedEmails, profile) so their
 * deletion is a deletion of something. FKs mirror the migrator's output —
 * declared references become ON DELETE CASCADE by default.
 */
const SCIM_BOOTSTRAP_SQL = `
  CREATE TABLE IF NOT EXISTS "scimManagedConnection" (
    id TEXT PRIMARY KEY,
    "creationRequestId" TEXT NOT NULL UNIQUE,
    "connectionId" TEXT NOT NULL UNIQUE,
    "provisioningDomainId" TEXT NOT NULL,
    status TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "createdBy" TEXT NOT NULL,
    "decommissionedAt" TIMESTAMPTZ
  );
  CREATE TABLE IF NOT EXISTS "scimManagedCredential" (
    id TEXT PRIMARY KEY,
    "connectionRecordId" TEXT NOT NULL REFERENCES "scimManagedConnection"(id) ON DELETE CASCADE,
    "credentialId" TEXT NOT NULL UNIQUE,
    "tokenDigest" TEXT NOT NULL,
    status TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "createdBy" TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS "scimManagedConnectionEvent" (
    id TEXT PRIMARY KEY,
    "connectionRecordId" TEXT NOT NULL REFERENCES "scimManagedConnection"(id) ON DELETE CASCADE,
    "eventKey" TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    type TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS "scimConnectionBinding" (
    id TEXT PRIMARY KEY,
    "connectionId" TEXT NOT NULL,
    "connectionKey" TEXT NOT NULL,
    "provisioningDomainId" TEXT NOT NULL,
    "decommissionStatus" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS "scimSubject" (
    id TEXT PRIMARY KEY,
    "userId" TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    "profileSourceId" TEXT,
    revision INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS "scimUser" (
    id TEXT PRIMARY KEY,
    "connectionId" TEXT NOT NULL,
    "provisioningDomainId" TEXT NOT NULL,
    "userId" TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    "userName" TEXT NOT NULL,
    "primaryEmail" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "serializedEmails" TEXT NOT NULL,
    active BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS "scimProjectionGrant" (
    id TEXT PRIMARY KEY,
    "connectionId" TEXT NOT NULL,
    "provisioningDomainId" TEXT NOT NULL,
    "scimUserId" TEXT NOT NULL REFERENCES "scimUser"(id) ON DELETE CASCADE,
    "userId" TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS "scimGroup" (
    id TEXT PRIMARY KEY,
    "connectionId" TEXT NOT NULL,
    "provisioningDomainId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS "scimGroupMember" (
    id TEXT PRIMARY KEY,
    "connectionId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL REFERENCES "scimGroup"(id) ON DELETE CASCADE,
    "scimUserId" TEXT NOT NULL REFERENCES "scimUser"(id) ON DELETE CASCADE,
    "membershipKey" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS "scimIdentityTombstone" (
    id TEXT PRIMARY KEY,
    "connectionId" TEXT NOT NULL,
    "provisioningDomainId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "userId" TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    profile TEXT NOT NULL,
    "deletedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
  );
`;

describeIfPg("scim* GDPR purge falsifier (real Postgres, #5515)", () => {
  let pool: Pool;
  const schemaName = `scim_purge_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let result: HardDeleteResult;

  const countWhere = async (table: string, where: string, params: unknown[]): Promise<number> => {
    const r = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM "${table}" WHERE ${where}`,
      params,
    );
    return Number(r.rows[0].n);
  };

  beforeAll(async () => {
    // Scratch schema baked into the connection string, and pgcrypto forced
    // into `public` first — both for the reasons hard-delete-purge-pg.test.ts
    // documents at length (silent-fallback safety; migration 0151's extension
    // landing in the first search_path schema).
    const setupPool = new Pool({ connectionString: TEST_DB_URL, max: 1 });
    await setupPool.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
    await setupPool.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public`);
    await setupPool.end();

    pool = new Pool({
      connectionString: TEST_DB_URL,
      max: 4,
      options: `-c search_path="${schemaName}",public`,
    });
    await pool.query(BETTER_AUTH_BOOTSTRAP_SQL);
    await pool.query(SCIM_BOOTSTRAP_SQL);
    await runMigrations(pool);

    process.env.DATABASE_URL = TEST_DB_URL;
    _resetPool(pool as unknown as InternalPool);

    // ── The two workspaces and the two users ──
    for (const workspaceId of [ORG, NEIGHBOUR]) {
      await pool.query(`INSERT INTO "organization" (id, name, slug) VALUES ($1, $1, $1)`, [
        workspaceId,
      ]);
    }
    await pool.query(`UPDATE "organization" SET workspace_status = 'deleted' WHERE id = $1`, [ORG]);
    await pool.query(`INSERT INTO "user" (id, email) VALUES ($1, 'orphan@scim.test')`, [USER_ORPHAN]);
    await pool.query(`INSERT INTO "user" (id, email) VALUES ($1, 'shared@scim.test')`, [USER_SHARED]);
    await pool.query(
      `INSERT INTO "member" (id, "organizationId", "userId", role) VALUES
         ('m-orphan', $1, $2, 'owner')`,
      [ORG, USER_ORPHAN],
    );
    await pool.query(
      `INSERT INTO "member" (id, "organizationId", "userId", role) VALUES
         ('m-shared-org', $1, $2, 'member')`,
      [ORG, USER_SHARED],
    );
    await pool.query(
      `INSERT INTO "member" (id, "organizationId", "userId", role) VALUES
         ('m-shared-nb', $1, $2, 'member')`,
      [NEIGHBOUR, USER_SHARED],
    );

    // ── The scim catalog, both domains, FK enforcement ON ──
    // Parents first; the fixture models a realistic graph on purpose, because
    // the child deletes' subqueries are the thing under test.
    await pool.query(
      `INSERT INTO "scimManagedConnection"
         (id, "creationRequestId", "connectionId", "provisioningDomainId", status, "createdBy", "decommissionedAt")
       VALUES
         ('mc-org-active', 'req-org-active', $2, $1, 'active', 'usr_admin', NULL),
         ('mc-org-decom',  'req-org-decom',  $3, $1, 'decommissioned', 'usr_admin', now())`,
      [ORG, ORG_CONNECTION_IDS[0], ORG_CONNECTION_IDS[1]],
    );
    await pool.query(
      `INSERT INTO "scimManagedConnection"
         (id, "creationRequestId", "connectionId", "provisioningDomainId", status, "createdBy")
       VALUES ('mc-nb', 'req-nb', 'ba_scim_connection_nb', $1, 'active', 'usr_admin')`,
      [NEIGHBOUR],
    );
    await pool.query(
      `INSERT INTO "scimManagedCredential"
         (id, "connectionRecordId", "credentialId", "tokenDigest", status, "createdBy")
       VALUES
         ('cred-org-active', 'mc-org-active', 'ba_scim_credential_orgactive', 'digest-a', 'active', 'usr_admin'),
         ('cred-org-decom',  'mc-org-decom',  'ba_scim_credential_orgdecom',  'digest-b', 'decommissioned', 'usr_admin'),
         ('cred-nb',         'mc-nb',         'ba_scim_credential_nb',        'digest-c', 'active', 'usr_admin')`,
    );
    await pool.query(
      `INSERT INTO "scimManagedConnectionEvent"
         (id, "connectionRecordId", "eventKey", sequence, type, "actorId")
       VALUES
         ('ev-org-active', 'mc-org-active', 'k1', 1, 'created', 'usr_admin'),
         ('ev-org-decom',  'mc-org-decom',  'k2', 1, 'decommissioned', 'usr_admin'),
         ('ev-nb',         'mc-nb',         'k3', 1, 'created', 'usr_admin')`,
    );
    await pool.query(
      `INSERT INTO "scimConnectionBinding"
         (id, "connectionId", "connectionKey", "provisioningDomainId", "decommissionStatus")
       VALUES
         ('b-org', $2, 'key-org', $1, 'active'),
         ('b-nb', 'ba_scim_connection_nb', 'key-nb', $3, 'active')`,
      [ORG, ORG_CONNECTION_IDS[0], NEIGHBOUR],
    );
    // Both subjects point their `profileSourceId` at an ORG-domain projection
    // — for the SHARED user that is the dangling-pointer case the spec review
    // surfaced: the subject row survives (user-scoped), so a purge that only
    // deleted the projection would leave it referencing a row that no longer
    // exists. The plugin declares the column as a plain optional string (no
    // FK), so nothing cascades it; the purge must NULL it explicitly.
    await pool.query(
      `INSERT INTO "scimSubject" (id, "userId", "profileSourceId") VALUES
         ('subj-orphan', $1, 'su-org-orphan'),
         ('subj-shared', $2, 'su-org-shared')`,
      [USER_ORPHAN, USER_SHARED],
    );
    // The projections. su-org-shared is THE row this issue exists for: a user
    // who survives the purge (member of NEIGHBOUR) whose ORG-domain projection
    // must nonetheless go.
    await pool.query(
      `INSERT INTO "scimUser"
         (id, "connectionId", "provisioningDomainId", "userId", "userName", "primaryEmail", "displayName", "serializedEmails")
       VALUES
         ('su-org-orphan', $3, $1, $4, 'orphan',  'orphan@scim.test', 'Orphan One',  '["orphan@scim.test"]'),
         ('su-org-shared', $3, $1, $5, 'shared',  'shared@scim.test', 'Shared Sam',  '["shared@scim.test"]'),
         ('su-nb-shared',  'ba_scim_connection_nb', $2, $5, 'shared', 'shared@scim.test', 'Shared Sam', '["shared@scim.test"]')`,
      [ORG, NEIGHBOUR, ORG_CONNECTION_IDS[0], USER_ORPHAN, USER_SHARED],
    );
    await pool.query(
      `INSERT INTO "scimProjectionGrant"
         (id, "connectionId", "provisioningDomainId", "scimUserId", "userId", role)
       VALUES
         ('grant-org-orphan', $3, $1, 'su-org-orphan', $4, 'member'),
         ('grant-org-shared', $3, $1, 'su-org-shared', $5, 'member'),
         ('grant-nb-shared',  'ba_scim_connection_nb', $2, 'su-nb-shared', $5, 'member')`,
      [ORG, NEIGHBOUR, ORG_CONNECTION_IDS[0], USER_ORPHAN, USER_SHARED],
    );
    await pool.query(
      `INSERT INTO "scimGroup" (id, "connectionId", "provisioningDomainId", "displayName")
       VALUES
         ('g-org', $2, $1, 'Engineering'),
         ('g-nb', 'ba_scim_connection_nb', $3, 'Engineering')`,
      [ORG, ORG_CONNECTION_IDS[0], NEIGHBOUR],
    );
    await pool.query(
      `INSERT INTO "scimGroupMember" (id, "connectionId", "groupId", "scimUserId", "membershipKey")
       VALUES
         ('gm-org', $1, 'g-org', 'su-org-shared', 'mk-org'),
         ('gm-nb', 'ba_scim_connection_nb', 'g-nb', 'su-nb-shared', 'mk-nb')`,
      [ORG_CONNECTION_IDS[0]],
    );
    await pool.query(
      `INSERT INTO "scimIdentityTombstone"
         (id, "connectionId", "provisioningDomainId", "externalId", "userId", profile)
       VALUES
         ('ts-org', $2, $1, 'ext-orphan', $4, '{"displayName":"Orphan One","emails":["orphan@scim.test"]}'),
         ('ts-nb', 'ba_scim_connection_nb', $3, 'ext-shared', $5, '{"displayName":"Shared Sam"}')`,
      [ORG, ORG_CONNECTION_IDS[0], NEIGHBOUR, USER_ORPHAN, USER_SHARED],
    );

    result = await hardDeleteWorkspace(ORG);
  }, PG_TIMEOUT_MS);

  afterAll(async () => {
    _resetPool(null);
    if (ORIGINAL_DATABASE_URL === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
    await pool?.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`).catch(() => {
      // intentionally ignored: teardown of a throwaway schema
    });
    await pool?.end();
  });

  it("removes the MULTI-WORKSPACE user's projection for the purged domain — while sparing the user and their other domain", async () => {
    // THE #5515 case. The user survives (still a member of NEIGHBOUR) so the
    // user-FK cascade never fires; only the domain-keyed DELETE can remove
    // this projection — and only a correctly scoped one leaves the
    // NEIGHBOUR-domain projection standing.
    const user = await pool.query(`SELECT 1 FROM "user" WHERE id = $1`, [USER_SHARED]);
    expect(user.rows.length, "the shared user must survive the purge").toBe(1);
    expect(
      await countWhere("scimUser", `id = 'su-org-shared'`, []),
      "the shared user's PURGED-domain projection (primaryEmail, displayName, serializedEmails) survived",
    ).toBe(0);
    expect(
      await countWhere("scimUser", `id = 'su-nb-shared'`, []),
      "the shared user's OTHER-domain projection must NOT be touched",
    ).toBe(1);
  });

  it("deletes the DECOMMISSIONED connection too — no status narrowing", async () => {
    // Append-only-for-audit is the catalog's normal-operation posture; the
    // #5515 recorded decision is that a GDPR purge overrides it. A DELETE
    // narrowed to status = 'active' passes every other test in this file.
    expect(await countWhere("scimManagedConnection", `id = 'mc-org-decom'`, [])).toBe(0);
  });

  it("removes the orphaned user's scimSubject and spares the shared user's", async () => {
    expect(
      await countWhere("scimSubject", `id = 'subj-orphan'`, []),
      "the orphaned user's subject record survived",
    ).toBe(0);
    expect(
      await countWhere("scimSubject", `id = 'subj-shared'`, []),
      "the shared user's subject record must survive — deleting it breaks the NEIGHBOUR's provisioning",
    ).toBe(1);
    // …but its profile-source pointer at the purged domain's DELETED
    // projection must be cleared: the column is a plain string with no FK, so
    // without the explicit UPDATE it dangles at a row that no longer exists —
    // scim* residue referencing the purged domain, one join away.
    expect(
      await countWhere("scimSubject", `id = 'subj-shared' AND "profileSourceId" IS NULL`, []),
      "the surviving subject still points its profileSourceId at the purged domain's deleted projection",
    ).toBe(1);
  });

  it("does not touch the neighbouring workspace's catalog (blast radius)", async () => {
    // Row-for-row, by id, so a partially-wrong scope shows the exact victim.
    const survivors: Array<[string, string]> = [
      ["scimManagedConnection", "mc-nb"],
      ["scimManagedCredential", "cred-nb"],
      ["scimManagedConnectionEvent", "ev-nb"],
      ["scimConnectionBinding", "b-nb"],
      ["scimUser", "su-nb-shared"],
      ["scimProjectionGrant", "grant-nb-shared"],
      ["scimGroup", "g-nb"],
      ["scimGroupMember", "gm-nb"],
      ["scimIdentityTombstone", "ts-nb"],
      ["scimSubject", "subj-shared"],
    ];
    for (const [table, id] of survivors) {
      expect(
        await countWhere(table, `id = $1`, [id]),
        `${table}/${id} belongs to the NEIGHBOUR and must survive ORG's purge`,
      ).toBe(1);
    }
  });

  it("leaves NO scim* row referencing the purged organization or its provisioning domain (the sweep)", async () => {
    // The issue's fourth acceptance criterion, verbatim. Derived per table
    // from information_schema so a referencing column cannot opt out: any
    // column that can point at ORG — the domain itself, its connections (by
    // row id or by plugin connectionId), its groups, its projections, or its
    // orphaned user — contributes an arm.
    const survivors: string[] = [];
    for (const table of SCIM_PLUGIN_TABLES) {
      const colRes = await pool.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = $2`,
        [schemaName, table],
      );
      const cols = new Set(colRes.rows.map((r) => r.column_name));
      const arms: string[] = [];
      if (cols.has("provisioningDomainId")) arms.push(`"provisioningDomainId" = '${ORG}'`);
      if (cols.has("connectionId")) {
        arms.push(
          `"connectionId" IN (${ORG_CONNECTION_IDS.map((c) => `'${c}'`).join(", ")})`,
        );
      }
      if (cols.has("connectionRecordId")) {
        arms.push(
          `"connectionRecordId" IN (${ORG_CONNECTION_ROW_IDS.map((c) => `'${c}'`).join(", ")})`,
        );
      }
      if (cols.has("groupId")) {
        arms.push(`"groupId" IN (${ORG_GROUP_IDS.map((c) => `'${c}'`).join(", ")})`);
      }
      if (cols.has("scimUserId")) {
        arms.push(`"scimUserId" IN (${ORG_SCIM_USER_IDS.map((c) => `'${c}'`).join(", ")})`);
      }
      // `profileSourceId` is a PLAIN-STRING reference (no declared FK, so the
      // derived reference pin in better-auth-purge-scope.test.ts cannot see
      // it) — hand-added here, which is exactly why that pin asserts every
      // DECLARED reference is a column this sweep knows.
      if (cols.has("profileSourceId")) {
        arms.push(`"profileSourceId" IN (${ORG_SCIM_USER_IDS.map((c) => `'${c}'`).join(", ")})`);
      }
      if (cols.has("userId")) arms.push(`"userId" = '${USER_ORPHAN}'`);
      expect(arms.length, `${table}: the sweep found no referencing columns — vacuous`).toBeGreaterThan(0);
      const n = await countWhere(table, arms.join(" OR "), []);
      if (n !== 0) survivors.push(`${table} (${n} row(s))`);
    }
    expect(
      survivors,
      `scim* rows referencing the purged organization survived: ${survivors.join(", ")}. ` +
        `The endpoint's response says the workspace's data was irreversibly deleted — false ` +
        `while any of these stands.`,
    ).toEqual([]);
  });

  it("reports the EXACT per-table counts and no skipped scim work", () => {
    // Exact, not merely non-zero: the fixture's row arithmetic is known, so a
    // count that is right by accident (cascade doing a statement's work and
    // the statement matching nothing) cannot hide. ORG owns 2 connections,
    // each with 1 credential + 1 event; 1 binding; 2 projections + their 2
    // grants; 1 group with 1 membership; 1 tombstone.
    expect(result.counts.scimManagedConnection).toBe(2);
    expect(result.counts.scimManagedCredential).toBe(2);
    expect(result.counts.scimManagedConnectionEvent).toBe(2);
    expect(result.counts.scimConnectionBinding).toBe(1);
    expect(result.counts.scimUser).toBe(2);
    expect(result.counts.scimProjectionGrant).toBe(2);
    expect(result.counts.scimGroup).toBe(1);
    expect(result.counts.scimGroupMember).toBe(1);
    expect(result.counts.scimIdentityTombstone).toBe(1);
    // The whole catalog was present, so nothing scim-shaped may be skipped —
    // the probe's drift arm must not fire on a healthy class.
    for (const table of SCIM_PLUGIN_TABLES) {
      expect(result.skippedTables, `${table} wrongly reported as skipped`).not.toContain(table);
    }
  });
});
