/**
 * Real-Postgres tests for per-pattern query latency (#3635, PRD #3617 B-1).
 *
 * The rolling-average semantics live entirely in SQL — an incremental mean
 * `(avg * n + d) / (n + 1)` that reads the *pre-UPDATE* `repetition_count` as
 * the weight `n`, plus the first-observation seed and the NULL-observation
 * no-op. None of that is exercisable through a mocked query layer (the mock
 * never evaluates the CASE arithmetic), so these run the production
 * `insertLearnedPattern` / `incrementPatternCount` against a real Postgres and
 * assert the stored `avg_duration_ms` converges across repetitions.
 *
 * Skipped cleanly when `TEST_DATABASE_URL` is unset (matches `audit-slow-pg`
 * / `migrate-pg`). CI's api-tests workflow provides the Postgres service.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import { runMigrations } from "@atlas/api/lib/db/migrate";
import {
  MANAGED_AUTH_MIGRATIONS,
  _resetPool,
  insertLearnedPattern,
  incrementPatternCount,
  type InternalPool,
} from "@atlas/api/lib/db/internal";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;

const PG_TIMEOUT_MS = 30_000;
const ORG = "org-latency-test";

interface PatternRow {
  id: string;
  avg_duration_ms: number | null;
  last_seen_at: Date | null;
  repetition_count: number;
}

describeIfPg("per-pattern latency rolling average (real Postgres, #3635)", () => {
  let pool: Pool;
  const schemaName = `latency_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DB_URL });
    pool.on("connect", (client) => {
      void client.query(`SET search_path TO "${schemaName}"`).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`pattern-latency-pg: SET search_path failed: ${message}`);
      });
    });
    await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
    await runMigrations(pool, { skip: MANAGED_AUTH_MIGRATIONS });
    // Point the production internal-DB helpers at this pool so the exact
    // insert/increment SQL under test runs against this schema.
    _resetPool(pool as unknown as InternalPool);
  }, PG_TIMEOUT_MS);

  afterAll(async () => {
    if (!pool) return;
    _resetPool(null);
    await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    await pool.end();
  });

  afterEach(async () => {
    await pool.query("DELETE FROM learned_patterns");
  });

  /** Read back the learned pattern for a SQL string, or null if not yet present. */
  async function rowOrNull(patternSql: string): Promise<PatternRow | null> {
    const res = await pool.query<PatternRow>(
      `SELECT id, avg_duration_ms, last_seen_at, repetition_count
       FROM learned_patterns WHERE pattern_sql = $1 LIMIT 1`,
      [patternSql],
    );
    return res.rows[0] ?? null;
  }

  /**
   * insertLearnedPattern / incrementPatternCount are fire-and-forget (they
   * return void — no awaitable handle), so we can't await the detached write.
   * Rather than a fixed sleep (which can flake on a loaded runner if the
   * detached promise lands late), poll the row until the write has demonstrably
   * landed, then assert against it.
   */
  async function poll(
    patternSql: string,
    predicate: (row: PatternRow) => boolean,
    timeoutMs = 5000,
  ): Promise<PatternRow> {
    const deadline = Date.now() + timeoutMs;
    let last: PatternRow | null = null;
    while (Date.now() < deadline) {
      last = await rowOrNull(patternSql);
      if (last && predicate(last)) return last;
      await new Promise((r) => setTimeout(r, 10));
    }
    // Surface whatever we last saw so the caller's assertions give a clear diff.
    expect(last).not.toBeNull();
    return last!;
  }

  /** Wait until the pattern row exists (i.e. the insert landed). */
  const waitForRow = (patternSql: string): Promise<PatternRow> => poll(patternSql, () => true);

  /** Wait until repetition_count reaches `count` (i.e. a specific increment landed). */
  const waitForCount = (patternSql: string, count: number): Promise<PatternRow> =>
    poll(patternSql, (r) => r.repetition_count === count);

  it(
    "seeds avg_duration_ms + last_seen_at from the first observation",
    async () => {
      const sql = "SELECT a FROM seed_first WHERE x = 1";
      insertLearnedPattern({
        orgId: ORG,
        patternSql: sql,
        description: "seed test",
        sourceEntity: "seed_first",
        sourceQueries: ["fp1"],
        proposedBy: "agent",
        durationMs: 300,
      });

      const row = await waitForRow(sql);
      expect(row.avg_duration_ms).toBe(300);
      expect(row.last_seen_at).not.toBeNull();
      expect(row.repetition_count).toBe(1);
    },
    PG_TIMEOUT_MS,
  );

  it(
    "leaves latency NULL when the first observation has no duration",
    async () => {
      const sql = "SELECT a FROM seed_null WHERE x = 1";
      insertLearnedPattern({
        orgId: ORG,
        patternSql: sql,
        description: "seed null test",
        sourceEntity: "seed_null",
        sourceQueries: ["fp1"],
        proposedBy: "agent",
        // no durationMs
      });

      const row = await waitForRow(sql);
      expect(row.avg_duration_ms).toBeNull();
      expect(row.last_seen_at).toBeNull();
    },
    PG_TIMEOUT_MS,
  );

  it(
    "maintains a true rolling mean across repetitions and advances last_seen_at",
    async () => {
      const sql = "SELECT a FROM rolling WHERE x = 1";
      // Seed at 100, then observe 200, 300, 400. The incremental mean must
      // equal the plain arithmetic mean at every step:
      //   after seed:           100
      //   after 200: (100*1+200)/2 = 150
      //   after 300: (150*2+300)/3 = 200
      //   after 400: (200*3+400)/4 = 250
      insertLearnedPattern({
        orgId: ORG,
        patternSql: sql,
        description: "rolling test",
        sourceEntity: "rolling",
        sourceQueries: ["fp1"],
        proposedBy: "agent",
        durationMs: 100,
      });
      let row = await waitForRow(sql);
      expect(row.avg_duration_ms).toBe(100);
      const seededSeenAt = row.last_seen_at;
      expect(seededSeenAt).not.toBeNull();

      for (const { d, expected, count } of [
        { d: 200, expected: 150, count: 2 },
        { d: 300, expected: 200, count: 3 },
        { d: 400, expected: 250, count: 4 },
      ]) {
        incrementPatternCount(row.id, `fp-${d}`, d);
        row = await waitForCount(sql, count);
        expect(row.avg_duration_ms).toBeCloseTo(expected, 6);
      }

      // last_seen_at advanced to at least the seed timestamp (seed + increment
      // can land in the same millisecond, so equality is allowed — `>=`).
      expect(row.last_seen_at).not.toBeNull();
      expect(row.last_seen_at!.getTime()).toBeGreaterThanOrEqual(seededSeenAt!.getTime());
    },
    PG_TIMEOUT_MS,
  );

  it(
    "an increment without a duration leaves avg_duration_ms and last_seen_at untouched",
    async () => {
      const sql = "SELECT a FROM no_dur WHERE x = 1";
      insertLearnedPattern({
        orgId: ORG,
        patternSql: sql,
        description: "no-dur test",
        sourceEntity: "no_dur",
        sourceQueries: ["fp1"],
        proposedBy: "agent",
        durationMs: 500,
      });
      let row = await waitForRow(sql);
      const seenAtBefore = row.last_seen_at;
      expect(row.avg_duration_ms).toBe(500);

      // Bump the repetition without a measurement — latency columns frozen.
      incrementPatternCount(row.id, "fp2");
      row = await waitForCount(sql, 2);
      expect(row.avg_duration_ms).toBe(500);
      expect(row.last_seen_at!.getTime()).toBe(seenAtBefore!.getTime());
    },
    PG_TIMEOUT_MS,
  );

  it(
    "a first duration arriving on increment seeds the previously-NULL average",
    async () => {
      const sql = "SELECT a FROM late_seed WHERE x = 1";
      insertLearnedPattern({
        orgId: ORG,
        patternSql: sql,
        description: "late seed test",
        sourceEntity: "late_seed",
        sourceQueries: ["fp1"],
        proposedBy: "agent",
        // seeded NULL
      });
      let row = await waitForRow(sql);
      expect(row.avg_duration_ms).toBeNull();

      // First real measurement on the duplicate path seeds the average directly
      // (avg IS NULL branch) rather than averaging against NULL.
      incrementPatternCount(row.id, "fp2", 800);
      row = await waitForCount(sql, 2);
      expect(row.avg_duration_ms).toBe(800);
      expect(row.last_seen_at).not.toBeNull();
    },
    PG_TIMEOUT_MS,
  );
});
