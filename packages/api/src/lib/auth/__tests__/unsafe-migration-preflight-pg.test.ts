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
import {
  getMigrationError,
  resetMigrationState,
  runBootMigrations,
} from "@atlas/api/lib/auth/migrate";
import { resetAuthModeCache } from "@atlas/api/lib/auth/detect";
import { _setAuthInstance } from "@atlas/api/lib/auth/server";
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
  /**
   * A dedicated scratch DATABASE, not a scratch schema (#4647).
   * `docs/development/testing.md` makes this mandatory for any suite that runs
   * Better Auth's real migrator against shared Postgres, and this suite calls
   * `getMigrations()` — which reaches `db.introspection.getTables()` — four
   * times. That scan reads `pg_catalog` across EVERY schema the role can see,
   * so `search_path` cannot scope it: a sibling `-pg` suite's temp schema being
   * created or dropped mid-scan aborts it with a phantom
   * `relation ... does not exist`. Worse for this suite specifically, the plan
   * could be computed against a `user` table in another schema while the
   * pre-flight's ALTERs execute under ours — the two halves disagreeing about
   * which table they mean. A private database is the only isolation that holds.
   */
  const scratchDbName = `ba_preflight_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let scratchDbUrl: string;

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
        WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
      [table, column],
    );
    return r.rows[0]?.is_nullable ?? null;
  };

  beforeAll(async () => {
    const url = new URL(TEST_DB_URL as string);
    url.pathname = `/${scratchDbName}`;
    scratchDbUrl = url.toString();

    const admin = new Pool({ connectionString: TEST_DB_URL, max: 1 });
    try {
      // CREATE DATABASE cannot run inside a transaction, and the target does
      // not exist yet — so it runs on a one-shot admin pool bound to
      // TEST_DATABASE_URL's own database.
      await admin.query(`CREATE DATABASE "${scratchDbName}"`);
    } finally {
      // teardown-of-teardown: log, never mask a CREATE DATABASE failure.
      await admin.end().catch((err: unknown) => {
        console.warn(
          `unsafe-migration-preflight beforeAll: admin pool end failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
    }

    pool = new Pool({ connectionString: scratchDbUrl, max: 4 });
    await pool.query(USER_TABLE_AT_OLD_SHAPE);

    // POPULATED. This single row is what makes the migrator refuse; without it
    // the whole scenario evaporates and the pre-flight is untested.
    await pool.query(
      `INSERT INTO "user" (id, name, email) VALUES ('u-preflight', 'Pre Flight', 'pre@flight.test')`,
    );

    process.env.DATABASE_URL = scratchDbUrl;
    _resetPool(pool as unknown as InternalPool);
  }, PG_TIMEOUT_MS);

  afterAll(async () => {
    _resetPool(null);
    if (ORIGINAL_DATABASE_URL === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;

    // Close this suite's pool first, then DROP DATABASE from an admin
    // connection to the ORIGINAL database — DROP fails while any session is
    // still connected to the target. The DROP sits in a `finally` so a
    // `pool.end()` rejection cannot skip it and leak the scratch database on
    // the shared server.
    try {
      if (pool) await pool.end();
    } finally {
      const admin = new Pool({ connectionString: TEST_DB_URL, max: 1 });
      try {
        await admin.query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
            WHERE datname = $1 AND pid <> pg_backend_pid()`,
          [scratchDbName],
        );
        await admin.query(`DROP DATABASE IF EXISTS "${scratchDbName}"`);
      } finally {
        // teardown-of-teardown: log, never mask a terminate/DROP failure.
        await admin.end().catch((err: unknown) => {
          console.warn(
            `unsafe-migration-preflight afterAll: admin pool end failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        });
      }
    }
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

  /**
   * The refusals. Each of these is a shape the pre-flight must NOT repair, and
   * each must land in `skipped` rather than being dropped — a silent drop is
   * the original incident recurring from the module written to prevent it.
   */
  describe("refuses what it cannot repair faithfully, and says so", () => {
    const withField = (name: string, attr: Record<string, unknown>) =>
      ({
        database: pool,
        user: { additionalFields: { [name]: attr } },
      }) as unknown as Parameters<typeof getMigrations>[0];

    it(
      "an INDEXED required column — Better Auth builds the index in the same pass, so pre-creating the column would lose it",
      async () => {
        const r = await preflightUnsafeColumns(withField("shardKey", {
          type: "string",
          required: true,
          index: true,
        }));
        expect(r.skipped).toContain("user.shardKey");
        expect(r.added).toEqual([]);
        expect(await columnIsNullable("user", "shardKey")).toBeNull();
      },
      PG_TIMEOUT_MS,
    );

    it(
      "a UNIQUE required column — same reason, and a unique index is worse to lose",
      async () => {
        const r = await preflightUnsafeColumns(withField("externalId", {
          type: "string",
          required: true,
          unique: true,
        }));
        expect(r.skipped).toContain("user.externalId");
        expect(r.added).toEqual([]);
      },
      PG_TIMEOUT_MS,
    );

    it(
      "a required json column WITH a default — Better Auth still refuses it, because its static-default test covers only string/number/boolean",
      async () => {
        // The regression guard for the predicate gap: a naive
        // `defaultValue !== undefined` skip drops this silently, and the
        // migration then fails with nothing naming the column.
        const r = await preflightUnsafeColumns(withField("prefs", {
          type: "json",
          required: true,
          defaultValue: { a: 1 },
        }));
        expect(r.unsafeChanges.join(" ")).toContain("prefs");
        expect(r.added).toContain("user.prefs");
      },
      PG_TIMEOUT_MS,
    );

    it(
      "a required string with a STATIC default is not unsafe at all — Better Auth accepts it, so the pre-flight leaves it alone",
      async () => {
        const r = await preflightUnsafeColumns(withField("tier", {
          type: "string",
          required: true,
          defaultValue: "free",
        }));
        expect(r.unsafeChanges).toEqual([]);
        expect(r.added).toEqual([]);
        expect(r.skipped).toEqual([]);
      },
      PG_TIMEOUT_MS,
    );
  });
});

/**
 * The CALL SITE, pinned.
 *
 * The suite above proves the module works. It does not prove anything CALLS it:
 * delete the `preflightUnsafeColumns(auth.options)` line from
 * `runBootMigrations()` and every assertion above still passes, because they
 * invoke the module directly. That is the gap this block closes, and it is the
 * one that matters — the whole fix is inert if the call site goes away.
 *
 * So this drives the real `runBootMigrations()` against a populated old-shape
 * database and asserts what the boot actually reports: `getMigrationError()`
 * null. That is the value `/api/health` reads through the
 * `INTERNAL_DB_UNREACHABLE` diagnostic, so a null here is the same fact as a
 * 200 from the probe that failed in prod.
 */
/**
 * `account` as better-auth 1.6.25 left it — no `issuer`. Copied from the prod
 * internal DB's column list, which is the shape every region was carrying when
 * the 1.7 bump landed.
 */
const ACCOUNT_TABLE_AT_OLD_SHAPE = `
  CREATE TABLE "account" (
    "id"                     text PRIMARY KEY,
    "accountId"              text NOT NULL,
    "providerId"             text NOT NULL,
    "userId"                 text NOT NULL,
    "accessToken"            text,
    "refreshToken"           text,
    "idToken"                text,
    "accessTokenExpiresAt"   timestamptz,
    "refreshTokenExpiresAt"  timestamptz,
    "scope"                  text,
    "password"               text,
    "createdAt"              timestamptz NOT NULL DEFAULT now(),
    "updatedAt"              timestamptz NOT NULL DEFAULT now()
  );
`;

describeIfPg("runBootMigrations survives an unsafe Better Auth column (issue 5580)", () => {
  let pool: Pool;
  const scratchDbName = `ba_boot_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let scratchDbUrl: string;
  const ENV_KEYS = [
    "DATABASE_URL",
    "ATLAS_AUTH_MODE",
    "BETTER_AUTH_SECRET",
    "BETTER_AUTH_URL",
  ] as const;
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];

    const url = new URL(TEST_DB_URL as string);
    url.pathname = `/${scratchDbName}`;
    scratchDbUrl = url.toString();

    const admin = new Pool({ connectionString: TEST_DB_URL, max: 1 });
    try {
      await admin.query(`CREATE DATABASE "${scratchDbName}"`);
    } finally {
      await admin.end().catch((err: unknown) => {
        console.warn(
          `ba_boot beforeAll: admin pool end failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
    }

    pool = new Pool({ connectionString: scratchDbUrl, max: 4 });
    await pool.query(USER_TABLE_AT_OLD_SHAPE);
    await pool.query(
      `INSERT INTO "user" (id, name, email) VALUES ('u-boot', 'Boot', 'boot@flight.test')`,
    );
    // `account` at its PRE-1.7 shape and POPULATED — the exact prod condition.
    // Without both halves this suite is vacuous: Better Auth creates an absent
    // table whole (no ALTER path), and an empty one takes the ALTER without
    // complaint. Only an existing table WITH A ROW makes 1.7's required
    // `issuer` unsafe, which is what the pre-flight has to repair.
    await pool.query(ACCOUNT_TABLE_AT_OLD_SHAPE);
    await pool.query(
      `INSERT INTO "account" (id, "accountId", "providerId", "userId")
       VALUES ('a-boot', 'a-boot', 'credential', 'u-boot')`,
    );

    process.env.DATABASE_URL = scratchDbUrl;
    process.env.ATLAS_AUTH_MODE = "managed";
    process.env.BETTER_AUTH_SECRET = "preflight-boot-test-better-auth-secret-01";
    // Better Auth's oauth-provider plugin parses this at init (`new URL`); an
    // unset value makes the instance build throw, so the migrator never runs.
    process.env.BETTER_AUTH_URL = "http://localhost:3001";

    resetMigrationState();
    resetAuthModeCache();
    _setAuthInstance(null);
    _resetPool(pool as unknown as InternalPool);

    await runBootMigrations();
  }, PG_TIMEOUT_MS);

  afterAll(async () => {
    resetMigrationState();
    resetAuthModeCache();
    _setAuthInstance(null);
    _resetPool(null);
    for (const k of ENV_KEYS) {
      if (savedEnv[k] !== undefined) process.env[k] = savedEnv[k];
      else delete process.env[k];
    }
    try {
      if (pool) await pool.end();
    } finally {
      const admin = new Pool({ connectionString: TEST_DB_URL, max: 1 });
      try {
        await admin.query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
            WHERE datname = $1 AND pid <> pg_backend_pid()`,
          [scratchDbName],
        );
        await admin.query(`DROP DATABASE IF EXISTS "${scratchDbName}"`);
      } finally {
        await admin.end().catch((err: unknown) => {
          console.warn(
            `ba_boot afterAll: admin pool end failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        });
      }
    }
  }, PG_TIMEOUT_MS);

  it(
    "reports no migration error — the value /api/health reads to decide 503",
    () => {
      expect(getMigrationError()).toBeNull();
    },
    PG_TIMEOUT_MS,
  );

  it(
    "repaired the column the 1.7 bump actually tripped on — account.issuer, nullable",
    async () => {
      // The premise AND the repair in one assertion. If a future Better Auth
      // stops declaring `issuer` required, this goes red here rather than
      // leaving the suite quietly vacuous — the same reason the module suite
      // asserts its premise first.
      const r = await pool.query<{ is_nullable: string }>(
        `SELECT is_nullable FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'account'
            AND column_name = 'issuer'`,
      );
      expect(r.rows[0]?.is_nullable).toBe("YES");

      // And the pre-existing row survived, holding NULL rather than a guess.
      const rows = await pool.query(`SELECT issuer FROM "account" WHERE id = 'a-boot'`);
      expect(rows.rowCount).toBe(1);
      expect(rows.rows[0]?.issuer).toBeNull();
    },
    PG_TIMEOUT_MS,
  );
});
