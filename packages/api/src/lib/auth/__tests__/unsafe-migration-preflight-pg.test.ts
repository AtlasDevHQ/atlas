/**
 * Real-Postgres falsifier for the unsafe-column pre-flight (issue 5580).
 *
 * The incident: better-auth 1.6.25 -> 1.7.1 added a required `account.issuer`.
 * Better Auth's migrator refuses to add a required column with no default to a
 * POPULATED table, so it threw, `_migrationError` was set, that became an
 * `INTERNAL_DB_UNREACHABLE` diagnostic, and under SaaS `/api/health` returned
 * 503 — failing the Railway healthcheck in all three prod regions.
 *
 * ## Why this test has to use real Postgres, and a populated table
 *
 * This is the whole reason the bug shipped green. `migrate.test.ts` mocks both
 * the pool and the auth instance: it asserts that a THROWN error sets
 * `_migrationError`, which is true and was true throughout — it just never runs
 * the real migrator, so it cannot see the migrator decide to throw. And a fresh
 * test database has an EMPTY `account`, which makes the refusal unreachable by
 * construction: Better Auth creates an absent table whole, with the column
 * already NOT NULL, and never takes the ALTER path at all.
 *
 * So the two properties below are load-bearing and neither is incidental:
 *
 *   1. a real database, because the refusal is a decision the migrator makes by
 *      querying the live schema; and
 *   2. a table that already HAS A ROW, because "populated" is the entire
 *      predicate. Delete the INSERT and this suite passes with the pre-flight
 *      removed.
 *
 * ## Why the field is invented rather than `account.issuer`
 *
 * Pinning `issuer` would pin the 1.7 upgrade, and this rule is not about that
 * column — it is about any required column arriving at a populated table. The
 * fixture declares its own required additional field, so the test keeps meaning
 * the same thing after `issuer` is long since backfilled, and it will catch the
 * NEXT bump rather than re-catching the last one.
 *
 * Skipped cleanly when TEST_DATABASE_URL is unset.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import { getMigrations } from "better-auth/db/migration";
import { preflightUnsafeColumns } from "@atlas/api/lib/auth/unsafe-migration-preflight";
import { _resetPool, type InternalPool } from "@atlas/api/lib/db/internal";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
const PG_TIMEOUT_MS = 120_000;

/**
 * The `user` table at its PRE-BUMP shape: everything Better Auth's core schema
 * requires, and NOT `tenantRegion`. Standing it up by hand rather than letting
 * Better Auth create it is the point — the table has to already exist, at the
 * older shape, for the ALTER path to be reachable at all.
 */
const USER_TABLE_AT_OLD_SHAPE = `
  CREATE TABLE "user" (
    "id"            text PRIMARY KEY,
    "name"          text NOT NULL,
    "email"         text NOT NULL UNIQUE,
    "emailVerified" boolean NOT NULL DEFAULT false,
    "image"         text,
    "createdAt"     timestamptz NOT NULL DEFAULT now(),
    "updatedAt"     timestamptz NOT NULL DEFAULT now()
  );
`;

describeIfPg("Better Auth unsafe-column pre-flight (real Postgres, issue 5580)", () => {
  let pool: Pool;
  const schemaName = `ba_preflight_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

  /** Minimal options declaring a REQUIRED additional field with no default. */
  const authOptions = () =>
    ({
      database: pool,
      user: {
        additionalFields: {
          tenantRegion: { type: "string", required: true },
        },
      },
    }) as unknown as Parameters<typeof getMigrations>[0];

  const columnIsNullable = async (table: string, column: string): Promise<string | null> => {
    const r = await pool.query<{ is_nullable: string }>(
      `SELECT is_nullable FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = $2 AND column_name = $3`,
      [schemaName, table, column],
    );
    return r.rows[0]?.is_nullable ?? null;
  };

  beforeAll(async () => {
    const setupPool = new Pool({ connectionString: TEST_DB_URL, max: 1 });
    await setupPool.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
    await setupPool.end();

    pool = new Pool({
      connectionString: TEST_DB_URL,
      max: 4,
      options: `-c search_path="${schemaName}",public`,
    });
    await pool.query(USER_TABLE_AT_OLD_SHAPE);

    // POPULATED. This single row is what makes the migrator refuse; without it
    // the whole scenario evaporates and the pre-flight is untested.
    await pool.query(
      `INSERT INTO "user" (id, name, email) VALUES ('u-preflight', 'Pre Flight', 'pre@flight.test')`,
    );

    process.env.DATABASE_URL = TEST_DB_URL;
    _resetPool(pool as unknown as InternalPool);
  }, PG_TIMEOUT_MS);

  afterAll(async () => {
    _resetPool(null);
    if (ORIGINAL_DATABASE_URL === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
    await pool?.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`).catch(() => {});
    await pool?.end().catch(() => {});
  }, PG_TIMEOUT_MS);

  it(
    "the premise: Better Auth refuses the required column while the table is populated",
    async () => {
      // Asserted FIRST and on its own, so a future Better Auth that stops
      // refusing turns this suite red here — at the premise — rather than
      // leaving the assertions below silently vacuous.
      const plan = await getMigrations(authOptions(), { throwOnUnsafe: false });
      expect(plan.unsafeChanges.length).toBeGreaterThan(0);
      expect(plan.unsafeChanges.join(" ")).toContain("tenantRegion");

      await expect(getMigrations(authOptions())).rejects.toThrow(/tenantRegion/);
      expect(await columnIsNullable("user", "tenantRegion")).toBeNull();
    },
    PG_TIMEOUT_MS,
  );

  it(
    "adds the column as NULLABLE and reports it, so the migration can proceed",
    async () => {
      const result = await preflightUnsafeColumns(authOptions());

      expect(result.added).toContain("user.tenantRegion");
      expect(result.skipped).toEqual([]);
      // The column exists and is nullable — NOT NULL would have failed on the
      // existing row, which is the refusal we are working around.
      expect(await columnIsNullable("user", "tenantRegion")).toBe("YES");

      // And the existing row survived, holding NULL rather than a fabricated
      // value. Backfilling a guess is the failure mode Better Auth's own error
      // text warns about (MySQL filling every row with an empty string).
      const rows = await pool.query<{ tenantRegion: string | null }>(
        `SELECT "tenantRegion" FROM "user" WHERE id = 'u-preflight'`,
      );
      expect(rows.rowCount).toBe(1);
      expect(rows.rows[0]?.tenantRegion).toBeNull();
    },
    PG_TIMEOUT_MS,
  );

  it(
    "after the pre-flight, the migrator no longer refuses — the incident cannot recur",
    async () => {
      // The closing assertion, and the one that actually models the outage:
      // this call is what threw in prod. It must now resolve.
      const plan = await getMigrations(authOptions(), { throwOnUnsafe: false });
      expect(plan.unsafeChanges).toEqual([]);
      await expect(getMigrations(authOptions())).resolves.toBeDefined();
    },
    PG_TIMEOUT_MS,
  );

  it(
    "is idempotent — a second boot adds nothing and reports nothing",
    async () => {
      const again = await preflightUnsafeColumns(authOptions());
      expect(again.added).toEqual([]);
      expect(again.skipped).toEqual([]);
      expect(again.unsafeChanges).toEqual([]);
    },
    PG_TIMEOUT_MS,
  );
});
