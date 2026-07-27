/**
 * Real-Postgres coverage for the migration advisory lock's schema scoping (#4844).
 *
 * `runMigrations` serialises concurrent migrators on
 * `pg_advisory_lock(hashtext(...))`. The key used to be the bare constant
 * `'atlas_migrations'`, which is **database-wide** — so every `-pg` test suite
 * blocked on one lock even though each runs its migrations into its own private
 * scratch schema. Measured on this repo: one suite 0.9s, eight concurrent
 * suites 30.5s wall, landing exactly on the suites' 30s `beforeAll` budget and
 * failing a different one per run.
 *
 * Two properties matter and both are asserted here:
 *   1. In `public` the key is **bit-identical** to the historical constant, so a
 *      rolling deploy can never have old and new instances holding different
 *      keys (which would let them migrate concurrently — the race the lock
 *      exists to prevent).
 *   2. Two different scratch schemas get different keys, and a lock held in one
 *      does not block the other. That is the actual fix.
 *
 * Skips cleanly when `TEST_DATABASE_URL` is unset. Opt in locally with:
 *   bun run db:up && export TEST_DATABASE_URL=postgresql://atlas:atlas@localhost:5432/atlas
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import { ADVISORY_LOCK_KEY_SQL } from "@atlas/api/lib/db/migrate";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;
const PG_TEST_TIMEOUT_MS = 30_000;

const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const SCHEMA_A = `lockscope_a_${suffix}`;
const SCHEMA_B = `lockscope_b_${suffix}`;

/** Read the lock key that a session with the given search_path would use. */
async function keyForSchema(pool: Pool, schema: string): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query(`SET search_path TO "${schema}"`);
    const { rows } = await client.query(`SELECT ${ADVISORY_LOCK_KEY_SQL} AS key`);
    return rows[0].key as number;
  } finally {
    client.release();
  }
}

describeIfPg("migration advisory lock is scoped to the target schema (real Postgres)", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DB_URL, max: 4 });
    await pool.query(`CREATE SCHEMA IF NOT EXISTS "${SCHEMA_A}"`);
    await pool.query(`CREATE SCHEMA IF NOT EXISTS "${SCHEMA_B}"`);
  }, PG_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${SCHEMA_A}" CASCADE`);
    await pool.query(`DROP SCHEMA IF EXISTS "${SCHEMA_B}" CASCADE`);
    await pool.end();
  }, PG_TEST_TIMEOUT_MS);

  it(
    "keeps the historical key in public, so a rolling deploy can't split the lock",
    async () => {
      const client = await pool.connect();
      try {
        await client.query("SET search_path TO public");
        const { rows } = await client.query(
          `SELECT ${ADVISORY_LOCK_KEY_SQL} AS scoped,
                  hashtext('atlas_migrations') AS legacy`,
        );
        expect(rows[0].scoped).toBe(rows[0].legacy);
      } finally {
        client.release();
      }
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "gives distinct scratch schemas distinct keys",
    async () => {
      const [a, b] = await Promise.all([
        keyForSchema(pool, SCHEMA_A),
        keyForSchema(pool, SCHEMA_B),
      ]);
      expect(a).not.toBe(b);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "does not block a migrator working in a different schema",
    async () => {
      const holder = await pool.connect();
      const other = await pool.connect();
      try {
        await holder.query(`SET search_path TO "${SCHEMA_A}"`);
        await holder.query(`SELECT pg_advisory_lock(${ADVISORY_LOCK_KEY_SQL})`);

        // A migrator targeting SCHEMA_B must acquire immediately. try_ is used
        // rather than a blocking lock so a regression fails fast as `false`
        // instead of hanging until the suite timeout.
        await other.query(`SET search_path TO "${SCHEMA_B}"`);
        const { rows } = await other.query(
          `SELECT pg_try_advisory_lock(${ADVISORY_LOCK_KEY_SQL}) AS acquired`,
        );
        expect(rows[0].acquired).toBe(true);

        await other.query(`SELECT pg_advisory_unlock(${ADVISORY_LOCK_KEY_SQL})`);
      } finally {
        await holder.query(`SELECT pg_advisory_unlock_all()`).catch(() => {});
        holder.release();
        other.release();
      }
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "still serialises two migrators targeting the same schema",
    async () => {
      // The negative half: scoping must not have disabled the lock outright.
      const holder = await pool.connect();
      const rival = await pool.connect();
      try {
        await holder.query(`SET search_path TO "${SCHEMA_A}"`);
        await holder.query(`SELECT pg_advisory_lock(${ADVISORY_LOCK_KEY_SQL})`);

        await rival.query(`SET search_path TO "${SCHEMA_A}"`);
        const { rows } = await rival.query(
          `SELECT pg_try_advisory_lock(${ADVISORY_LOCK_KEY_SQL}) AS acquired`,
        );
        expect(rows[0].acquired).toBe(false);
      } finally {
        await holder.query(`SELECT pg_advisory_unlock_all()`).catch(() => {});
        holder.release();
        rival.release();
      }
    },
    PG_TEST_TIMEOUT_MS,
  );
});
