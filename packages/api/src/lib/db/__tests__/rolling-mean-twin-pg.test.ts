/**
 * Real-Postgres twin-pin for the learned-pattern latency rolling mean (#4576,
 * PRD #4570).
 *
 * `avg_duration_ms` is folded in THREE places that must fold identically
 * (exactly for integer-valued means, within representation tolerance otherwise):
 *   1. `foldRollingMean` (rolling-mean.ts) — the canonical TypeScript definition.
 *   2. `incrementPatternCount`'s UPDATE `CASE` (db/internal.ts) — the production
 *      path for every repeat observation; a hand-written SQL twin of (1).
 *   3. `insertLearnedPattern`'s `ON CONFLICT DO UPDATE` `CASE` — the lost-insert-
 *      race twin that must fold identically to (2).
 *
 * The coupling between the SQL twins and `foldRollingMean` is *manual* — no
 * compile-time check links them. The sibling `pattern-latency-pg.test.ts`
 * asserts the SQL fold against *hand-computed* oracles, so it catches an SQL
 * regression but NOT a divergent edit to `foldRollingMean` itself (its oracle
 * doesn't come from the function). This test closes that gap: it derives its
 * oracle by folding the *same sequence* through `foldRollingMean` in lockstep,
 * so a divergent edit to EITHER side (the SQL `CASE` or the TS function) makes
 * the stored value diverge from the oracle and fails CI — instead of silently
 * corrupting the latency stats that feed the auto-promote gate and retrieval
 * weighting.
 *
 * The weight the SQL uses is the *pre-UPDATE* `repetition_count`, which bumps on
 * every observation — including null (unmeasured) ones that leave the average
 * frozen. The oracle models that exactly (`repTs` advances on every step), so a
 * null-interleaved sequence is a sharp check that the two agree on the weight.
 *
 * Skipped cleanly when `TEST_DATABASE_URL` is unset (matches `pattern-latency-pg`
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
import { foldRollingMean } from "@atlas/api/lib/learn/rolling-mean";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;

const PG_TIMEOUT_MS = 30_000;
const ORG = "org-rolling-mean-twin";

interface PatternRow {
  id: string;
  avg_duration_ms: number | null;
  repetition_count: number;
}

describeIfPg("SQL rolling-mean fold pinned to its TypeScript twin (real Postgres, #4576)", () => {
  let pool: Pool;
  const schemaName = `rmtwin_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DB_URL });
    pool.on("connect", (client) => {
      void client.query(`SET search_path TO "${schemaName}"`).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`rolling-mean-twin-pg: SET search_path failed: ${message}`);
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

  async function rowOrNull(patternSql: string): Promise<PatternRow | null> {
    const res = await pool.query<PatternRow>(
      `SELECT id, avg_duration_ms, repetition_count
       FROM learned_patterns WHERE pattern_sql = $1 LIMIT 1`,
      [patternSql],
    );
    return res.rows[0] ?? null;
  }

  /**
   * insert/increment are fire-and-forget (return void), so poll the row until
   * the detached write has demonstrably landed rather than sleeping a fixed
   * interval that can flake on a loaded runner.
   */
  async function poll(
    patternSql: string,
    predicate: (row: PatternRow) => boolean,
    label: string,
    // Generous vs. the sibling's 5s: the poll now fails loud rather than masking,
    // so a slow-but-succeeding burst (the 120 detached increments in the constant-
    // saturation case) on a loaded runner must not time out before landing. Stays
    // well under the 30s `it()` budget.
    timeoutMs = 20_000,
  ): Promise<PatternRow> {
    const deadline = Date.now() + timeoutMs;
    let last: PatternRow | null = null;
    while (Date.now() < deadline) {
      last = await rowOrNull(patternSql);
      if (last && predicate(last)) return last;
      await new Promise((r) => setTimeout(r, 10));
    }
    // Timed out with the predicate never satisfied. insert/increment are
    // fire-and-forget and `internalExecute` swallows write errors (and drops
    // writes once its circuit breaker trips), so this poll is the ONLY detector
    // that a write landed. A soft `not.toBeNull()` here would return a STALE row
    // and green-pass on exactly the null-frozen-weight and constant-saturation
    // steps whose oracle equals the prior value — the very divergences this suite
    // exists to catch. Fail loudly instead, surfacing the last-seen row.
    throw new Error(
      `rolling-mean-twin-pg: timed out waiting for ${label}; last row: ${
        last ? JSON.stringify(last) : "<none>"
      }`,
    );
  }

  const waitForRow = (patternSql: string): Promise<PatternRow> =>
    poll(patternSql, () => true, `row to appear for ${patternSql}`);
  const waitForCount = (patternSql: string, count: number): Promise<PatternRow> =>
    poll(patternSql, (r) => r.repetition_count === count, `repetition_count=${count} for ${patternSql}`);

  /**
   * Assert the stored value equals the twin's oracle. A divergent fold formula
   * produces a materially different number (>> 1e-9), so the tolerant branch
   * still fails on any real divergence; integer-valued means are exactly
   * representable in both engines, so we pin those exactly (the integer /
   * rounding-boundary case the issue calls out).
   */
  function expectEqualsTwin(actual: number | null, oracle: number | null): void {
    if (oracle === null) {
      expect(actual).toBeNull();
      return;
    }
    expect(actual).not.toBeNull();
    if (Number.isInteger(oracle)) {
      expect(actual).toBe(oracle);
    } else {
      expect(actual as number).toBeCloseTo(oracle, 9);
    }
  }

  /**
   * Drive a seed + a sequence of repeat observations through the production
   * INSERT/UPDATE paths and, in lockstep, fold the same sequence through
   * `foldRollingMean`. At every landed step the stored `avg_duration_ms` must
   * equal the twin's running result. `null` samples advance `repetition_count`
   * (the SQL weight) while leaving the average frozen — modelled identically.
   */
  async function driveAndPin(
    patternSql: string,
    seed: number | null,
    samples: Array<number | null>,
  ): Promise<void> {
    insertLearnedPattern({
      orgId: ORG,
      patternSql,
      description: "twin",
      sourceEntity: "twin",
      sourceQueries: ["seed"],
      proposedBy: "agent",
      durationMs: seed,
    });

    // First-ever observation is `foldRollingMean(null, 0, seed)`; the seeded row
    // has repetition_count = 1.
    let avgTs = foldRollingMean(null, 0, seed);
    let repTs = 1;
    let row = await waitForRow(patternSql);
    expect(row.repetition_count).toBe(repTs);
    expectEqualsTwin(row.avg_duration_ms, avgTs);

    for (let i = 0; i < samples.length; i++) {
      // `samples[i]` is genuinely `number | null` — the sequences deliberately
      // feed nulls; both sinks accept null, so no assertion is needed.
      const sample = samples[i];
      // Production repeat path: the proposer always passes a fingerprint (#3635).
      incrementPatternCount(row.id, `fp-${i}`, sample);
      // SQL weight is the pre-UPDATE repetition_count (= repTs); it bumps every
      // step, null samples included.
      avgTs = foldRollingMean(avgTs, repTs, sample);
      repTs += 1;
      row = await waitForCount(patternSql, repTs);
      expectEqualsTwin(row.avg_duration_ms, avgTs);
    }
  }

  it(
    "seeds the average as the twin's first-observation fold",
    async () => {
      await driveAndPin("SELECT 1 FROM twin_seed", 300, []);
      await driveAndPin("SELECT 2 FROM twin_seed_zero", 0, []);
    },
    PG_TIMEOUT_MS,
  );

  it(
    "folds a representative mixed sequence (zero, null-frozen weight advance, repeating decimal) identically to the twin",
    async () => {
      // Running mean: 10 → 15 → 10 (zero sample pulls the mean) → 8.75 →
      // [null sample: avg frozen at 8.75, weight advances to 5] → 8.75 (folding
      // the mean itself is a no-op) → 7.64… (repeating decimal). Every step's
      // oracle comes from `foldRollingMean`, not a literal.
      await driveAndPin("SELECT a FROM twin_mixed", 10, [20, 0, 5, null, 8.75, 1]);
    },
    PG_TIMEOUT_MS,
  );

  it(
    "hits exact integer rolling-mean boundaries identically to the twin",
    async () => {
      // 1 → 1.5 → 2 → 2.5 → 3: the running mean lands on exact integers at
      // boundaries, pinned with strict equality by `expectEqualsTwin`.
      await driveAndPin("SELECT a FROM twin_int_boundary", 1, [2, 3, 4, 5]);
    },
    PG_TIMEOUT_MS,
  );

  it(
    "seeds a previously-NULL average on the first measured repeat, matching the twin's avg-null branch",
    async () => {
      // NULL seed, then a measured repeat: `foldRollingMean(null, rep, s) === s`
      // regardless of the weight — SQL takes the `avg_duration_ms IS NULL` branch.
      await driveAndPin("SELECT a FROM twin_late_seed", null, [null, 800, 400]);
    },
    PG_TIMEOUT_MS,
  );

  it(
    "stays pinned to the twin across a long varying stream (saturation)",
    async () => {
      // 50 folds of a varying stream, each step re-checked against the twin.
      const samples = Array.from({ length: 50 }, (_, i) => (i + 1) * 7);
      await driveAndPin("SELECT a FROM twin_saturation_varying", 13, samples);
    },
    PG_TIMEOUT_MS,
  );

  it(
    "stays pinned to the twin across a long constant stream (order-independent saturation)",
    async () => {
      // A constant stream's mean is order-independent, so fire the repeats
      // detached and assert the converged value against the twin. Guards against
      // numerical drift diverging between the two engines under many folds.
      const sql = "SELECT a FROM twin_saturation_constant";
      const N = 120;
      const value = 250;
      insertLearnedPattern({
        orgId: ORG,
        patternSql: sql,
        description: "twin",
        sourceEntity: "twin",
        sourceQueries: ["seed"],
        proposedBy: "agent",
        durationMs: value,
      });
      const seeded = await waitForRow(sql);

      let avgTs = foldRollingMean(null, 0, value);
      let repTs = 1;
      for (let i = 0; i < N; i++) {
        incrementPatternCount(seeded.id, `c-${i}`, value);
        avgTs = foldRollingMean(avgTs, repTs, value);
        repTs += 1;
      }
      const row = await waitForCount(sql, repTs);
      expectEqualsTwin(row.avg_duration_ms, avgTs);
    },
    PG_TIMEOUT_MS,
  );

  it(
    "folds the ON CONFLICT lost-insert-race path identically to the twin",
    async () => {
      // Two inserts with the same identity (org, null group, sql) collide on the
      // partial unique index; the second folds via `ON CONFLICT DO UPDATE`'s
      // CASE, which must mirror `incrementPatternCount` and `foldRollingMean`.
      const sql = "SELECT a FROM twin_on_conflict";
      const insert = (durationMs: number): void =>
        insertLearnedPattern({
          orgId: ORG,
          patternSql: sql,
          description: "twin",
          sourceEntity: "twin",
          sourceQueries: [`fp-${durationMs}`],
          proposedBy: "agent",
          durationMs,
        });

      insert(100);
      let row = await waitForCount(sql, 1);
      let avgTs = foldRollingMean(null, 0, 100);
      let repTs = 1;
      expectEqualsTwin(row.avg_duration_ms, avgTs);

      for (const seed of [200, 300, 450]) {
        insert(seed);
        // EXCLUDED.avg_duration_ms is the would-be seed = foldRollingMean(null, 0, seed)
        // = seed; it folds against the prior row weighted by the pre-UPDATE
        // repetition_count — exactly the repeat-observation twin.
        avgTs = foldRollingMean(avgTs, repTs, foldRollingMean(null, 0, seed));
        repTs += 1;
        row = await waitForCount(sql, repTs);
        expectEqualsTwin(row.avg_duration_ms, avgTs);
      }
    },
    PG_TIMEOUT_MS,
  );
});
