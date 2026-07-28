/**
 * Real-Postgres tests for migration 0184 — sealing ownerless personal SCIM
 * providers (GHSA-j8v8-g9cx-5qf4).
 *
 * Why real Postgres: the migration is a guarded `DO $$ ... $$` block whose
 * whole value is in its WHERE clause (`userId IS NULL AND organizationId IS
 * NULL`) and its two existence guards. A mocked query layer evaluates none of
 * that — it would happily report success against SQL that seals the wrong rows
 * or throws on a database where SCIM was never enabled.
 *
 * The load-bearing assertions here are the NEGATIVE ones: that the migration
 * leaves org-scoped providers and already-owned providers untouched, and that
 * it no-ops rather than erroring when the table or column is absent. A test
 * that only checked "the ownerless row got sealed" would pass just as well
 * against `UPDATE "scimProvider" SET "userId" = ...` with no WHERE clause at
 * all — which would lock every tenant out of their own SCIM administration.
 *
 * `scimProvider` is owned by Better Auth, not by the Atlas migration runner, so
 * these tests stand the table up themselves rather than relying on a prior
 * migration to have created it.
 *
 * Skipped cleanly when `TEST_DATABASE_URL` is unset (matches `migrate-pg` /
 * `connection-group-descriptions-pg`). CI's api-tests workflow provides the
 * Postgres service.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;

const PG_TIMEOUT_MS = 30_000;
const SENTINEL = "00000000-0000-0000-0000-000000000000";

const MIGRATION_SQL = readFileSync(
  join(import.meta.dir, "..", "migrations", "0184_scim_provider_seal_ownerless.sql"),
  "utf8",
);

describeIfPg("migration 0184 — seal ownerless SCIM providers (GHSA-j8v8-g9cx-5qf4)", () => {
  let pool: Pool;
  const schemaName = `scimseal_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DB_URL });
    pool.on("connect", (client) => {
      void client.query(`SET search_path TO "${schemaName}"`).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`scim-provider-seal-ownerless-pg: SET search_path failed: ${message}`);
      });
    });
    await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
  }, PG_TIMEOUT_MS);

  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    await pool.end();
  }, PG_TIMEOUT_MS);

  /**
   * Stand up the plugin-owned table as `providerOwnership: { enabled: true }`
   * shapes it: `userId` present and NULLABLE (the fail-open shape the advisory
   * turns on).
   */
  async function createTableWithOwnerColumn(): Promise<void> {
    await pool.query(`DROP TABLE IF EXISTS "scimProvider"`);
    await pool.query(`
      CREATE TABLE "scimProvider" (
        id             TEXT PRIMARY KEY,
        "providerId"   TEXT NOT NULL,
        "scimToken"    TEXT NOT NULL,
        "organizationId" TEXT,
        "userId"       TEXT
      )
    `);
  }

  async function ownerOf(id: string): Promise<string | null> {
    const { rows } = await pool.query<{ userId: string | null }>(
      `SELECT "userId" FROM "scimProvider" WHERE id = $1`,
      [id],
    );
    return rows[0]?.userId ?? null;
  }

  describe("with the table and owner column present", () => {
    beforeEach(async () => {
      await createTableWithOwnerColumn();
      await pool.query(
        `INSERT INTO "scimProvider" (id, "providerId", "scimToken", "organizationId", "userId") VALUES
           ('p-ownerless', 'corp-idp',  'tok-1', NULL,      NULL),
           ('p-owned',     'mine-idp',  'tok-2', NULL,      'user-alice'),
           ('p-org',       'acme-idp',  'tok-3', 'org-acme', NULL),
           ('p-org-owned', 'beta-idp',  'tok-4', 'org-beta', 'user-bob')`,
      );
      await pool.query(MIGRATION_SQL);
    }, PG_TIMEOUT_MS);

    it("seals the ownerless PERSONAL provider — the exploitable row", async () => {
      expect(await ownerOf("p-ownerless")).toBe(SENTINEL);
    });

    it("leaves an already-owned personal provider alone", async () => {
      // Negative: a legitimate owner must not be overwritten with the sentinel,
      // which would lock them out of their own connection.
      expect(await ownerOf("p-owned")).toBe("user-alice");
    });

    it("leaves ORG-scoped providers alone even when ownerless", async () => {
      // Negative, and the most important one. Org-scoped rows take the
      // membership/role branch and were never vulnerable. Sealing them would
      // break SCIM administration for every enterprise tenant — the exact
      // blast radius a WHERE-clause slip would produce.
      expect(await ownerOf("p-org")).toBeNull();
      expect(await ownerOf("p-org-owned")).toBe("user-bob");
    });

    it("seals exactly one row — no collateral writes", async () => {
      const { rows } = await pool.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM "scimProvider" WHERE "userId" = $1`,
        [SENTINEL],
      );
      expect(rows[0]?.n).toBe("1");
    });

    it("is idempotent — a second run changes nothing", async () => {
      await pool.query(MIGRATION_SQL);
      expect(await ownerOf("p-ownerless")).toBe(SENTINEL);
      expect(await ownerOf("p-owned")).toBe("user-alice");
      expect(await ownerOf("p-org")).toBeNull();
    });

    it("sealed rows keep their token — provisioning is not destroyed", async () => {
      // The sentinel locks the MANAGEMENT endpoints, not the /scim/v2 protocol
      // routes, which authenticate by bearer token alone. Deleting the row (the
      // advisory's other suggestion) would have broken live provisioning.
      const { rows } = await pool.query<{ scimToken: string }>(
        `SELECT "scimToken" FROM "scimProvider" WHERE id = 'p-ownerless'`,
      );
      expect(rows[0]?.scimToken).toBe("tok-1");
    });
  });

  describe("guards", () => {
    it("no-ops when the scimProvider table is absent (SCIM never enabled)", async () => {
      await pool.query(`DROP TABLE IF EXISTS "scimProvider"`);
      // Must not throw: a self-hosted deploy without EE SCIM runs this
      // migration too, and an error here would abort the whole boot migration.
      // Awaited deliberately — an un-awaited `.resolves` assertion passes even
      // when the query rejects, which is the exact false-green this file exists
      // to rule out.
      await expect(pool.query(MIGRATION_SQL)).resolves.toBeDefined();
    }, PG_TIMEOUT_MS);

    it("no-ops when the userId column is absent (providerOwnership not yet applied)", async () => {
      // Ordering safety net: if Better Auth's boot auto-migrate has not yet
      // added the column, the migration must skip rather than fail.
      await pool.query(`DROP TABLE IF EXISTS "scimProvider"`);
      await pool.query(`
        CREATE TABLE "scimProvider" (
          id             TEXT PRIMARY KEY,
          "providerId"   TEXT NOT NULL,
          "scimToken"    TEXT NOT NULL,
          "organizationId" TEXT
        )
      `);
      await pool.query(`INSERT INTO "scimProvider" VALUES ('p1', 'idp', 'tok', NULL)`);
      await expect(pool.query(MIGRATION_SQL)).resolves.toBeDefined();
    }, PG_TIMEOUT_MS);
  });
});
