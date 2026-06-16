/**
 * Real-Postgres tests for the `/analytics/slow` aggregate (#3616).
 *
 * The fix's core is SQL-semantic — `AVG(duration_ms) FILTER (WHERE duration_ms
 * > 0)`, `COALESCE(... , 0)` over a NULL average, and `ORDER BY ... NULLS LAST`
 * — none of which a mocked query layer can exercise. These run the *exact*
 * production query (imported via `buildSlowQuerySql`, the same builder the
 * route uses, so the test can't drift from the endpoint) against a real
 * Postgres seeded with a mix of real-execution, cache-hit-replay, fanout-parent
 * (duration_ms=0), and all-zero-prefix rows.
 *
 * Skipped cleanly when `TEST_DATABASE_URL` is unset (matches `outbox-pg.test.ts`
 * / `migrate-pg.test.ts`). CI's api-tests workflow provides the Postgres
 * service container and exports the URL.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import { runMigrations } from "@atlas/api/lib/db/migrate";
import { MANAGED_AUTH_MIGRATIONS } from "@atlas/api/lib/db/internal";
import { buildSlowQuerySql, buildFrequentQuerySql, buildUserStatsQuerySql } from "../routes/admin-audit";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;

const PG_TIMEOUT_MS = 30_000;
const ORG = "org-slow-test";

// The org-scoped WHERE the route builds for the no-date-range case
// (`analyticsDateRange` → `WHERE deleted_at IS NULL AND org_id = $1`). Kept in
// sync with that helper; the SQL under test is imported, not duplicated.
const WHERE = "WHERE deleted_at IS NULL AND org_id = $1";

interface SlowRow {
  query: string;
  avg_duration: string | number;
  max_duration: string | number;
  count: string | number;
}

describeIfPg("/analytics/slow aggregate (real Postgres, #3616)", () => {
  let pool: Pool;
  const schemaName = `slow_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DB_URL });
    pool.on("connect", (client) => {
      void client.query(`SET search_path TO "${schemaName}"`).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`audit-slow-pg: SET search_path failed: ${message}`);
      });
    });
    await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
    await runMigrations(pool, { skip: MANAGED_AUTH_MIGRATIONS });
  }, PG_TIMEOUT_MS);

  afterAll(async () => {
    if (!pool) return;
    await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE audit_log CASCADE");
  });

  /** Insert one audit_log row (only the NOT-NULL + filter columns matter). */
  async function insertAudit(sqlText: string, durationMs: number): Promise<void> {
    await pool.query(
      `INSERT INTO audit_log (auth_mode, sql, duration_ms, success, org_id)
       VALUES ('none', $1, $2, true, $3)`,
      [sqlText, durationMs, ORG],
    );
  }

  async function runSlow(): Promise<SlowRow[]> {
    const result = await pool.query<SlowRow>(buildSlowQuerySql(WHERE), [ORG]);
    return result.rows;
  }

  it(
    "excludes zero-duration rows from the AVG but keeps them in COUNT/MAX",
    async () => {
      // One prefix: a real execution, a cache-hit replay (real cost), and a
      // fanout-parent housekeeping row (0). Filtered AVG = (3000+1500)/2 = 2250.
      await insertAudit("SELECT * FROM big_table", 3000); // real execution
      await insertAudit("SELECT * FROM big_table", 1500); // cache-hit replay
      await insertAudit("SELECT * FROM big_table", 0); // fanout parent

      const rows = await runSlow();
      expect(rows).toHaveLength(1);
      // Naive AVG over all 3 would be (3000+1500+0)/3 = 1500; the FILTER
      // excludes the zero row, so the real average is 2250.
      expect(Number(rows[0].avg_duration)).toBe(2250);
      // MAX and COUNT are unfiltered — every row still counts.
      expect(Number(rows[0].max_duration)).toBe(3000);
      expect(Number(rows[0].count)).toBe(3);
    },
    PG_TIMEOUT_MS,
  );

  it(
    "COALESCEs an all-zero-duration prefix to 0 instead of NULL",
    async () => {
      // A prefix made entirely of fanout-parent / cache-miss zero rows: the
      // filtered AVG is NULL, which COALESCE must surface as 0 (not null).
      await insertAudit("SELECT now()", 0);
      await insertAudit("SELECT now()", 0);

      const rows = await runSlow();
      expect(rows).toHaveLength(1);
      expect(rows[0].avg_duration).not.toBeNull();
      expect(Number(rows[0].avg_duration)).toBe(0);
      expect(Number(rows[0].count)).toBe(2); // still counted
    },
    PG_TIMEOUT_MS,
  );

  it(
    "orders by the filtered average and sinks all-zero prefixes last (NULLS LAST)",
    async () => {
      await insertAudit("SELECT * FROM fast_table", 5000); // highest real avg → first
      await insertAudit("SELECT * FROM mid_table", 2000); // middle
      await insertAudit("SELECT * FROM mid_table", 0); // (mid_table real avg stays 2000)
      await insertAudit("SELECT * FROM zero_only", 0); // all-zero → NULL avg → last
      await insertAudit("SELECT * FROM zero_only", 0);

      const rows = await runSlow();
      expect(rows).toHaveLength(3);
      // DESC by filtered average; the all-zero prefix must NOT float to the top
      // (Postgres sorts NULL first under DESC by default — NULLS LAST fixes it).
      expect(rows[0].query).toBe("SELECT * FROM fast_table");
      expect(rows[1].query).toBe("SELECT * FROM mid_table");
      expect(rows[2].query).toBe("SELECT * FROM zero_only");
      expect(Number(rows[2].avg_duration)).toBe(0);
    },
    PG_TIMEOUT_MS,
  );
});

/**
 * The `/analytics/frequent` and `/analytics/users` aggregates carry the SAME
 * `duration_ms > 0` FILTER (#3616) — the original fix only patched `/slow`, so
 * the sibling endpoints still skewed their averages with zero-duration rows.
 * These run the exact production builders against real Postgres.
 */
describeIfPg("/analytics/frequent + /users avg duration filter (real Postgres, #3616)", () => {
  let pool: Pool;
  const schemaName = `freq_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DB_URL });
    pool.on("connect", (client) => {
      void client.query(`SET search_path TO "${schemaName}"`).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`audit-freq-pg: SET search_path failed: ${message}`);
      });
    });
    await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
    await runMigrations(pool, { skip: MANAGED_AUTH_MIGRATIONS });
  }, PG_TIMEOUT_MS);

  afterAll(async () => {
    if (!pool) return;
    await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE audit_log CASCADE");
  });

  async function insertAudit(sqlText: string, durationMs: number): Promise<void> {
    await pool.query(
      `INSERT INTO audit_log (auth_mode, sql, duration_ms, success, org_id)
       VALUES ('none', $1, $2, true, $3)`,
      [sqlText, durationMs, ORG],
    );
  }

  it(
    "frequent: avg_duration excludes zero-duration rows; count keeps them",
    async () => {
      await insertAudit("SELECT * FROM t", 3000);
      await insertAudit("SELECT * FROM t", 1500);
      await insertAudit("SELECT * FROM t", 0); // fanout parent — excluded from AVG only

      const { rows } = await pool.query<{ count: string; avg_duration: string }>(
        buildFrequentQuerySql(WHERE),
        [ORG],
      );
      expect(rows).toHaveLength(1);
      expect(Number(rows[0].count)).toBe(3); // all rows counted (count-ranked)
      expect(Number(rows[0].avg_duration)).toBe(2250); // not 1500
    },
    PG_TIMEOUT_MS,
  );

  it(
    "frequent: an all-zero prefix COALESCEs avg_duration to 0, not NULL",
    async () => {
      await insertAudit("SELECT now()", 0);
      await insertAudit("SELECT now()", 0);
      const { rows } = await pool.query<{ avg_duration: string }>(buildFrequentQuerySql(WHERE), [ORG]);
      expect(rows[0].avg_duration).not.toBeNull();
      expect(Number(rows[0].avg_duration)).toBe(0);
    },
    PG_TIMEOUT_MS,
  );

  it(
    "users: avg_duration excludes zero-duration rows; count keeps them",
    async () => {
      await insertAudit("SELECT 1", 4000);
      await insertAudit("SELECT 1", 2000);
      await insertAudit("SELECT 1", 0); // excluded from AVG only

      const { rows } = await pool.query<{ count: string; avg_duration: string }>(
        buildUserStatsQuerySql(WHERE),
        [ORG],
      );
      // All three rows have NULL user_id → one 'anonymous' bucket.
      expect(rows).toHaveLength(1);
      expect(Number(rows[0].count)).toBe(3);
      expect(Number(rows[0].avg_duration)).toBe(3000); // (4000+2000)/2, not /3
    },
    PG_TIMEOUT_MS,
  );
});
