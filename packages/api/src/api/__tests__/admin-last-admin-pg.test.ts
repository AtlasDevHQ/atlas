/**
 * Real-Postgres coverage for the atomic last-admin guards (#3158). Mirrors the
 * chat-cap-pg.test.ts harness: skips cleanly when `TEST_DATABASE_URL` is unset,
 * runs in a unique per-test schema, and exercises the per-workspace advisory
 * lock under GENUINE concurrency — which the mock-pool unit tests cannot see.
 *
 * The unit tests (`admin-users-org-scope.test.ts`) cover the 403/404/200
 * mapping with scripted query responses. Here we prove the SERIALIZATION the
 * mapping relies on:
 *   - The "control" test first reproduces the TOCTOU on the OLD shape (two
 *     naive count-then-update demotions both observe `count = 2` and both
 *     succeed → 0 admins). This is the bug #3158 fixes, asserted so the harness
 *     itself is proven capable of exhibiting the race.
 *   - The fix tests run the SAME guarded operations through
 *     `withWorkspaceAdminLock` and assert that exactly one of two racing
 *     operations succeeds and at least one admin always remains — across a
 *     demote/demote race AND a delete/demote race (the cross-path case #3158
 *     calls out).
 *
 * Opt in locally with:
 *   bun run db:up && export TEST_DATABASE_URL=postgresql://atlas:atlas@localhost:5432/atlas
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import {
  _resetPool,
  withWorkspaceAdminLock,
  type InternalPool,
} from "@atlas/api/lib/db/internal";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;
const PG_TEST_TIMEOUT_MS = 30_000;

// Standalone `member`/`organization` fixture — only the columns the guards
// touch. Better Auth owns these in production; the guard SQL never joins beyond
// them, so no FK scaffolding or Atlas migration set is needed.
const BOOTSTRAP_SQL = `
  CREATE TABLE IF NOT EXISTS organization (
    id text PRIMARY KEY,
    name text
  );
  CREATE TABLE IF NOT EXISTS member (
    id text PRIMARY KEY,
    "userId" text NOT NULL,
    "organizationId" text NOT NULL,
    role text NOT NULL DEFAULT 'member'
  );
`;

const ADMIN_COUNT_SQL = `SELECT COUNT(*)::int AS count FROM member WHERE "organizationId" = $1 AND role IN ('admin','owner')`;

describeIfPg("last-admin guard serialization (real Postgres, #3158)", () => {
  let pool: Pool;
  const schemaName = `last_admin_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;

  beforeAll(async () => {
    // Create the scratch schema on a one-shot client before the long-lived
    // pool lands a `search_path`-scoped connection.
    const bootstrap = new Pool({ connectionString: TEST_DB_URL });
    try {
      await bootstrap.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
    } finally {
      await bootstrap.end();
    }

    // search_path baked into the connection string (libpq `options`) so it is
    // set server-side at startup — no unawaited `SET search_path` race.
    pool = new Pool({
      connectionString: TEST_DB_URL,
      options: `-c search_path="${schemaName}",public`,
    });
    await pool.query(BOOTSTRAP_SQL);

    // Point the guard's module pool (`getInternalDB()` inside
    // withWorkspaceAdminLock) at this scratch-schema pool.
    process.env.DATABASE_URL = TEST_DB_URL;
    _resetPool(pool as unknown as InternalPool, null);
  }, PG_TEST_TIMEOUT_MS);

  afterAll(async () => {
    _resetPool(null, null);
    if (ORIGINAL_DATABASE_URL === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
    if (!pool) return;
    await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query(`DELETE FROM member`);
    await pool.query(`DELETE FROM organization`);
  });

  /** Seed an org with two admins (`a`, `b`) so either can be the "last" one. */
  async function seedTwoAdmins(orgId: string): Promise<void> {
    await pool.query(`INSERT INTO organization (id, name) VALUES ($1, $1)`, [orgId]);
    await pool.query(
      `INSERT INTO member (id, "userId", "organizationId", role) VALUES
         ($1, 'a', $3, 'admin'),
         ($2, 'b', $3, 'admin')`,
      [`${orgId}-a`, `${orgId}-b`, orgId],
    );
  }

  async function adminCount(orgId: string): Promise<number> {
    const res = await pool.query<{ count: number }>(ADMIN_COUNT_SQL, [orgId]);
    return res.rows[0]?.count ?? -1;
  }

  /** Guarded demotion mirroring changeUserRoleRoute's locked callback. */
  async function demoteViaLock(orgId: string, userId: string): Promise<"ok" | "last_admin"> {
    return withWorkspaceAdminLock<"ok" | "last_admin">(orgId, async (tx) => {
      const cur = await tx.query<{ role: string }>(
        `SELECT role FROM member WHERE "userId" = $1 AND "organizationId" = $2 LIMIT 1`,
        [userId, orgId],
      );
      const role = cur[0]?.role;
      if (role === "admin" || role === "owner") {
        const remaining = await tx.query<{ count: string }>(ADMIN_COUNT_SQL, [orgId]);
        if (parseInt(String(remaining[0]?.count ?? "0"), 10) <= 1) return "last_admin";
      }
      await tx.query(
        `UPDATE member SET role = 'member' WHERE "userId" = $1 AND "organizationId" = $2`,
        [userId, orgId],
      );
      return "ok";
    });
  }

  /**
   * Guarded delete mirroring deleteUserRoute's locked callback. The real path
   * runs Better Auth's `removeUser` (which cascade-deletes the member row); the
   * DELETE here reproduces that effect under the same lock, so the serialization
   * behaviour is identical.
   */
  async function deleteViaLock(orgId: string, userId: string): Promise<"ok" | "last_admin"> {
    return withWorkspaceAdminLock<"ok" | "last_admin">(orgId, async (tx) => {
      const cur = await tx.query<{ role: string }>(
        `SELECT role FROM member WHERE "userId" = $1 AND "organizationId" = $2 LIMIT 1`,
        [userId, orgId],
      );
      const role = cur[0]?.role;
      if (role === "admin" || role === "owner") {
        const remaining = await tx.query<{ count: string }>(ADMIN_COUNT_SQL, [orgId]);
        if (parseInt(String(remaining[0]?.count ?? "0"), 10) <= 1) return "last_admin";
      }
      await tx.query(
        `DELETE FROM member WHERE "userId" = $1 AND "organizationId" = $2`,
        [userId, orgId],
      );
      return "ok";
    });
  }

  it(
    "CONTROL — naive count-then-update lets two demotions strip the last admin (the #3158 race)",
    async () => {
      const org = `org-race-${Date.now()}`;
      await seedTwoAdmins(org);

      // Two unsynchronized connections, no advisory lock: both read the count
      // BEFORE either writes, so both observe 2 (> 1) and proceed. This is
      // exactly the TOCTOU the guards used to have; asserting it proves the
      // harness can exhibit the race the fix must close.
      const c1 = await pool.connect();
      const c2 = await pool.connect();
      try {
        const count1 = (await c1.query<{ count: number }>(ADMIN_COUNT_SQL, [org])).rows[0]!.count;
        const count2 = (await c2.query<{ count: number }>(ADMIN_COUNT_SQL, [org])).rows[0]!.count;
        expect(count1).toBe(2);
        expect(count2).toBe(2);
        await c1.query(`UPDATE member SET role = 'member' WHERE "userId" = 'a' AND "organizationId" = $1`, [org]);
        await c2.query(`UPDATE member SET role = 'member' WHERE "userId" = 'b' AND "organizationId" = $1`, [org]);
      } finally {
        c1.release();
        c2.release();
      }

      // Both succeeded → the workspace has ZERO admins. The bug.
      expect(await adminCount(org)).toBe(0);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "FIX — two concurrent demotions via the lock: exactly one succeeds, one admin remains",
    async () => {
      const org = `org-demote-${Date.now()}`;
      await seedTwoAdmins(org);

      const [r1, r2] = await Promise.all([
        demoteViaLock(org, "a"),
        demoteViaLock(org, "b"),
      ]);

      const oks = [r1, r2].filter((r) => r === "ok");
      const blocked = [r1, r2].filter((r) => r === "last_admin");
      expect(oks).toHaveLength(1);
      expect(blocked).toHaveLength(1);
      // The invariant the guard protects: never fewer than one admin/owner.
      expect(await adminCount(org)).toBe(1);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "FIX — a delete racing a demotion serialize on the lock: an admin always remains",
    async () => {
      const org = `org-del-${Date.now()}`;
      await seedTwoAdmins(org);

      const [del, dem] = await Promise.all([
        deleteViaLock(org, "a"),
        demoteViaLock(org, "b"),
      ]);

      // Exactly one of the two cross-path operations is refused as "last admin".
      const blocked = [del, dem].filter((r) => r === "last_admin");
      expect(blocked).toHaveLength(1);
      // And the workspace still has at least one admin/owner.
      expect(await adminCount(org)).toBeGreaterThanOrEqual(1);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "demoting an admin is allowed when a co-admin remains (no false positive under the lock)",
    async () => {
      const org = `org-ok-${Date.now()}`;
      await pool.query(`INSERT INTO organization (id, name) VALUES ($1, $1)`, [org]);
      await pool.query(
        `INSERT INTO member (id, "userId", "organizationId", role) VALUES
           ($1, 'a', $4, 'owner'),
           ($2, 'b', $4, 'admin'),
           ($3, 'c', $4, 'admin')`,
        [`${org}-a`, `${org}-b`, `${org}-c`, org],
      );

      // Sequential demotions: two of the three admins/owners can be demoted;
      // the third is refused, leaving exactly one.
      expect(await demoteViaLock(org, "b")).toBe("ok");
      expect(await demoteViaLock(org, "c")).toBe("ok");
      expect(await demoteViaLock(org, "a")).toBe("last_admin");
      expect(await adminCount(org)).toBe(1);
    },
    PG_TEST_TIMEOUT_MS,
  );
});
