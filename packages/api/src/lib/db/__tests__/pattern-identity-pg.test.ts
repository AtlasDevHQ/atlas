/**
 * Real-Postgres tests for DB-enforced learned-pattern identity (#4572, v0.0.50).
 *
 * Migration 0172 adds a PARTIAL UNIQUE INDEX over query_pattern rows on
 * (org_id, connection_group_id, md5(pattern_sql)) with NULLS NOT DISTINCT, and
 * turns `insertLearnedPattern` into an `ON CONFLICT DO UPDATE` upsert. The
 * guarantee — a concurrent duplicate observation collapses into the repetition
 * increment it should have been, never a second row — is a property of the
 * index + ON CONFLICT under real concurrency, so none of it is exercisable
 * through a mocked query layer. These run the production `insertLearnedPattern`
 * / `incrementPatternCount` against a real Postgres and assert convergence.
 *
 * Skipped cleanly when `TEST_DATABASE_URL` is unset (matches `pattern-latency-pg`
 * / `migrate-pg`). CI's api-tests workflow provides the Postgres service.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
const ORG = "org-identity-test";

interface PatternRow {
  id: string;
  org_id: string | null;
  connection_group_id: string | null;
  repetition_count: number;
  confidence: number;
  avg_duration_ms: number | null;
  status: string;
  source_queries: string[] | null;
}

describeIfPg("DB-enforced learned-pattern identity (real Postgres, #4572)", () => {
  let pool: Pool;
  const schemaName = `identity_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DB_URL });
    pool.on("connect", (client) => {
      void client.query(`SET search_path TO "${schemaName}"`).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`pattern-identity-pg: SET search_path failed: ${message}`);
      });
    });
    await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
    await runMigrations(pool, { skip: MANAGED_AUTH_MIGRATIONS });
    // Point the production internal-DB helpers at this pool so the exact
    // upsert/increment SQL under test runs against this schema.
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

  async function rows(patternSql: string): Promise<PatternRow[]> {
    const res = await pool.query<PatternRow>(
      `SELECT id, org_id, connection_group_id, repetition_count, confidence,
              avg_duration_ms, status, source_queries
         FROM learned_patterns WHERE pattern_sql = $1 ORDER BY id`,
      [patternSql],
    );
    return res.rows;
  }

  /**
   * insertLearnedPattern / incrementPatternCount are fire-and-forget (they
   * return void — no awaitable handle), so poll until the observable end state
   * lands rather than sleeping a fixed interval (which flakes on a loaded
   * runner). Fails loudly with the last-seen rows if the deadline passes.
   */
  async function pollRows(
    patternSql: string,
    predicate: (r: PatternRow[]) => boolean,
    timeoutMs = 5000,
  ): Promise<PatternRow[]> {
    const deadline = Date.now() + timeoutMs;
    let last: PatternRow[] = [];
    while (Date.now() < deadline) {
      last = await rows(patternSql);
      if (predicate(last)) return last;
      await new Promise((r) => setTimeout(r, 10));
    }
    // Surface what we last saw so the caller's assertion prints a clear diff.
    return last;
  }

  const seed = (patternSql: string, opts: { org?: string | null; group?: string | null; durationMs?: number; fp?: string } = {}) =>
    insertLearnedPattern({
      orgId: opts.org === undefined ? ORG : opts.org,
      connectionGroupId: opts.group ?? null,
      patternSql,
      description: "identity test",
      sourceEntity: "t",
      sourceQueries: [opts.fp ?? "fp1"],
      proposedBy: "agent",
      durationMs: opts.durationMs,
    });

  // ── AC #1: concurrent proposals yield one row, incremented ──────────

  it(
    "concurrent proposals of the same SQL collapse to one row with incremented repetition",
    async () => {
      const sql = "select a from concurrent where b = ?";
      const N = 8;
      // Fire N fire-and-forget upserts in the same tick — they race on the pool.
      // Exactly one INSERT wins; the other N-1 take ON CONFLICT DO UPDATE. The
      // partial unique index is what serializes that, so the terminal state is
      // deterministic: one row, repetition_count = N.
      for (let i = 0; i < N; i++) seed(sql, { fp: `fp-${i}` });

      const settled = await pollRows(sql, (r) => r.length === 1 && r[0].repetition_count === N);
      expect(settled).toHaveLength(1);
      expect(settled[0].repetition_count).toBe(N);
      // Confidence climbs 0.1 per observation, capped at 1.0.
      expect(settled[0].confidence).toBeCloseTo(Math.min(1.0, 0.1 * N), 5);
    },
    PG_TIMEOUT_MS,
  );

  // ── AC #2: ON CONFLICT increment == fast-path increment ─────────────

  it(
    "a repeat observation via ON CONFLICT updates confidence/repetition/latency identically to incrementPatternCount",
    async () => {
      // Row A: driven purely through the ON CONFLICT path (two inserts).
      const sqlA = "select a from conflict_path where b = ?";
      seed(sqlA, { durationMs: 100, fp: "a1" });
      await pollRows(sqlA, (r) => r.length === 1);
      seed(sqlA, { durationMs: 200, fp: "a2" });
      const aRows = await pollRows(sqlA, (r) => r.length === 1 && r[0].repetition_count === 2);

      // Row B: seeded once, then bumped through the fast path (incrementPatternCount).
      const sqlB = "select a from increment_path where b = ?";
      seed(sqlB, { durationMs: 100, fp: "b1" });
      const [bSeed] = await pollRows(sqlB, (r) => r.length === 1);
      incrementPatternCount(bSeed.id, "b2", 200);
      const bRows = await pollRows(sqlB, (r) => r.length === 1 && r[0].repetition_count === 2);

      // The two paths must land on identical row math.
      expect(aRows).toHaveLength(1);
      expect(bRows).toHaveLength(1);
      const a = aRows[0];
      const b = bRows[0];
      expect(a.repetition_count).toBe(b.repetition_count); // 2
      expect(a.confidence).toBeCloseTo(b.confidence, 6); // 0.2
      expect(a.avg_duration_ms).toBe(b.avg_duration_ms); // (100+200)/2 = 150
      expect(a.avg_duration_ms).toBe(150);
      // Both accumulated two source fingerprints.
      expect(a.source_queries).toHaveLength(2);
      expect(b.source_queries).toHaveLength(2);
    },
    PG_TIMEOUT_MS,
  );

  it(
    "ON CONFLICT latency fold: a later observation with no duration leaves avg/last_seen untouched (EXCLUDED-NULL branch)",
    async () => {
      const sql = "select a from conflict_no_dur where b = ?";
      seed(sql, { durationMs: 100, fp: "d1" });
      const [before] = await pollRows(sql, (r) => r.length === 1 && r[0].avg_duration_ms === 100);
      // Second observation via ON CONFLICT, but with no measurement → the fold's
      // `WHEN EXCLUDED.avg_duration_ms IS NULL THEN <keep old>` branch fires.
      seed(sql, { fp: "d2" }); // no durationMs
      const [after] = await pollRows(sql, (r) => r.length === 1 && r[0].repetition_count === 2);
      expect(after.avg_duration_ms).toBe(100); // unchanged
      expect(before.avg_duration_ms).toBe(100);
    },
    PG_TIMEOUT_MS,
  );

  it(
    "ON CONFLICT latency fold: a first measurement arriving on the conflict seeds the previously-NULL average (avg-NULL branch)",
    async () => {
      const sql = "select a from conflict_late_seed where b = ?";
      seed(sql, { fp: "l1" }); // seeded NULL latency
      await pollRows(sql, (r) => r.length === 1 && r[0].avg_duration_ms === null);
      // Second observation carries the first real duration → the fold's
      // `WHEN learned_patterns.avg_duration_ms IS NULL THEN EXCLUDED` branch fires.
      seed(sql, { durationMs: 200, fp: "l2" });
      const [after] = await pollRows(sql, (r) => r.length === 1 && r[0].repetition_count === 2);
      expect(after.avg_duration_ms).toBe(200); // seeded directly, not averaged against NULL
    },
    PG_TIMEOUT_MS,
  );

  // ── AC #3: CHECK constraints reject invalid status/type ─────────────

  it(
    "chk_learned_patterns_status rejects an unknown status with 23514 and admits the transient 'applying'",
    async () => {
      // Unknown status → check_violation.
      await expect(
        pool.query(
          `INSERT INTO learned_patterns (org_id, pattern_sql, status) VALUES ($1, 'select 1', 'bogus')`,
          [ORG],
        ),
      ).rejects.toMatchObject({ code: "23514" });

      // 'applying' is a DB value (amendment claim state, #4506) even though it is
      // not a wire status — the CHECK must admit it or the claim UPDATE breaks.
      await pool.query(
        `INSERT INTO learned_patterns (org_id, pattern_sql, type, status)
         VALUES ($1, 'select 2', 'semantic_amendment', 'applying')`,
        [ORG],
      );
      const { rows: r } = await pool.query<{ status: string }>(
        `SELECT status FROM learned_patterns WHERE pattern_sql = 'select 2'`,
      );
      expect(r[0]?.status).toBe("applying");
    },
    PG_TIMEOUT_MS,
  );

  it(
    "chk_learned_patterns_type rejects an unknown type with 23514",
    async () => {
      await expect(
        pool.query(
          `INSERT INTO learned_patterns (org_id, pattern_sql, type) VALUES ($1, 'select 3', 'bogus_type')`,
          [ORG],
        ),
      ).rejects.toMatchObject({ code: "23514" });
    },
    PG_TIMEOUT_MS,
  );

  // ── AC #4: legacy NULL-scope rows cannot multiply ───────────────────

  it(
    "NULL-scope rows (org_id NULL, connection_group_id NULL) collide rather than multiply",
    async () => {
      const sql = "select a from null_scope where b = ?";
      seed(sql, { org: null, group: null, fp: "n1" });
      seed(sql, { org: null, group: null, fp: "n2" });

      const settled = await pollRows(sql, (r) => r.length === 1 && r[0].repetition_count === 2);
      expect(settled).toHaveLength(1);
      expect(settled[0].org_id).toBeNull();
      expect(settled[0].connection_group_id).toBeNull();
      expect(settled[0].repetition_count).toBe(2);
    },
    PG_TIMEOUT_MS,
  );

  it(
    "NULL-group rows under a real org still collide (NULLS NOT DISTINCT on the group column)",
    async () => {
      const sql = "select a from org_null_group where b = ?";
      seed(sql, { org: "o-nn", group: null, fp: "g1" });
      seed(sql, { org: "o-nn", group: null, fp: "g2" });

      const settled = await pollRows(sql, (r) => r.length === 1 && r[0].repetition_count === 2);
      expect(settled).toHaveLength(1);
      expect(settled[0].org_id).toBe("o-nn");
      expect(settled[0].connection_group_id).toBeNull();
    },
    PG_TIMEOUT_MS,
  );

  // ── Scope + type non-collision (the flip side of identity) ──────────

  it(
    "the same SQL under different connection groups stays two distinct rows",
    async () => {
      const sql = "select a from cross_group where b = ?";
      seed(sql, { org: "o-x", group: "us-prod", fp: "u1" });
      seed(sql, { org: "o-x", group: "eu-prod", fp: "e1" });
      seed(sql, { org: "o-x", group: null, fp: "d1" });

      const settled = await pollRows(sql, (r) => r.length === 3);
      expect(settled).toHaveLength(3);
      const groups = settled.map((r) => r.connection_group_id);
      expect(groups).toContain("us-prod");
      expect(groups).toContain("eu-prod");
      expect(groups).toContain(null);
      // No row was ever bumped — each is a distinct identity.
      expect(settled.every((r) => r.repetition_count === 1)).toBe(true);
    },
    PG_TIMEOUT_MS,
  );

  it(
    "the same SQL + same group under two different orgs stays two distinct rows (org_id is part of the identity)",
    async () => {
      // Guards the org_id column of the composite: under NULLS NOT DISTINCT, a
      // dropped or reordered org_id term would let two tenants' identical SQL
      // collide — a cross-tenant merge. Two orgs, identical sql+group → two rows.
      const sql = "select a from cross_org where b = ?";
      seed(sql, { org: "o-1", group: "g", fp: "t1" });
      seed(sql, { org: "o-2", group: "g", fp: "t2" });

      const settled = await pollRows(sql, (r) => r.length === 2);
      expect(settled).toHaveLength(2);
      expect(settled.map((r) => r.org_id).sort()).toEqual(["o-1", "o-2"]);
      expect(settled.every((r) => r.repetition_count === 1)).toBe(true);
    },
    PG_TIMEOUT_MS,
  );

  it(
    "semantic_amendment rows are unconstrained by the partial index (many per scope)",
    async () => {
      // The partial index is WHERE type = 'query_pattern', so amendment rows —
      // a review queue — may share (org, group, sql) freely.
      for (let i = 0; i < 3; i++) {
        await pool.query(
          `INSERT INTO learned_patterns (org_id, connection_group_id, pattern_sql, type, status)
           VALUES ($1, NULL, 'amend body', 'semantic_amendment', 'pending')`,
          [ORG],
        );
      }
      const settled = await rows("amend body");
      expect(settled).toHaveLength(3);
    },
    PG_TIMEOUT_MS,
  );

  // ── Reject guard rides the ON CONFLICT race (#3636) ─────────────────

  it(
    "a proposal race against an admin-rejected row leaves it frozen, never resurrected",
    async () => {
      const sql = "select a from rejected_race where b = ?";
      // Land a rejected row directly (simulating a prior admin reject).
      await pool.query(
        `INSERT INTO learned_patterns (org_id, connection_group_id, pattern_sql, status, repetition_count, confidence)
         VALUES ($1, NULL, $2, 'rejected', 5, 0.9)`,
        [ORG, sql],
      );

      // A fresh proposal for the same identity would upsert — but the reject
      // guard on DO UPDATE must no-op it (conflict handled, zero rows updated).
      seed(sql, { org: ORG, group: null, durationMs: 999, fp: "resurrect" });

      // The reject-race upsert is fire-and-forget, and its correct outcome
      // ("row unchanged") is indistinguishable from "not run yet" — so a
      // `() => true` poll could green even if the guard were deleted. Establish
      // a happens-before barrier: fire a CONTROL upsert for a fresh identity
      // through the same write path and drive it to rep 2. Once the control's
      // second observation has landed, the write queue has demonstrably drained
      // past the reject-race upsert dispatched before it, so a still-frozen
      // rejected row is a real assertion, not a timing artifact.
      const controlSql = "select a from reject_race_control where b = ?";
      seed(controlSql, { org: ORG, group: null, fp: "c1" });
      await pollRows(controlSql, (r) => r.length === 1);
      seed(controlSql, { org: ORG, group: null, fp: "c2" });
      await pollRows(controlSql, (r) => r.length === 1 && r[0].repetition_count === 2);

      const settled = await rows(sql);
      expect(settled).toHaveLength(1);
      expect(settled[0].status).toBe("rejected");
      expect(settled[0].repetition_count).toBe(5); // not bumped to 6
      expect(settled[0].confidence).toBeCloseTo(0.9, 6); // not eroded
      expect(settled[0].avg_duration_ms).toBeNull(); // 999 never folded in
    },
    PG_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// Migration 0172 pre-dedup fold. The index this migration adds would abort the
// deploy if prod already held concurrent-race duplicate rows (the artifact the
// index exists to prevent). 0172 folds those into one survivor first. This can
// only be exercised on a table that still HAS duplicates — i.e. before the
// index exists — so this block runs every migration EXCEPT 0172 into its own
// schema, seeds duplicates, then applies the real 0172 SQL file (not a copy, so
// no drift) and asserts the fold + the now-live index/CHECK.
// ---------------------------------------------------------------------------
describeIfPg("migration 0172 pre-dedup fold (real Postgres, #4572)", () => {
  let pool: Pool;
  const schemaName = `identity_dedup_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const migration0172 = readFileSync(
    join(import.meta.dir, "../migrations/0172_learned_patterns_identity.sql"),
    "utf8",
  );

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DB_URL });
    pool.on("connect", (client) => {
      void client.query(`SET search_path TO "${schemaName}"`).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`pattern-identity-pg dedup: SET search_path failed: ${message}`);
      });
    });
    await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
    // Every migration EXCEPT 0172 — so learned_patterns exists WITHOUT the
    // unique index, and duplicates can be seeded to exercise the fold.
    await runMigrations(pool, {
      skip: [...MANAGED_AUTH_MIGRATIONS, "0172_learned_patterns_identity.sql"],
    });
  }, PG_TIMEOUT_MS);

  afterAll(async () => {
    if (!pool) return;
    await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    await pool.end();
  });

  it(
    "folds pre-existing duplicate query_pattern rows into one survivor, then the index + CHECK go live",
    async () => {
      // Three NULL-scope duplicates (rep 1/2/3, confidence .1/.3/.2) — exactly
      // the concurrent-race artifact — plus a singleton that must survive intact
      // and an amendment sharing the identity that must be left unconstrained.
      await pool.query(
        `INSERT INTO learned_patterns (org_id, connection_group_id, pattern_sql, repetition_count, confidence, status, type) VALUES
           (NULL, NULL, 'dup sql', 1, 0.1, 'pending', 'query_pattern'),
           (NULL, NULL, 'dup sql', 2, 0.3, 'pending', 'query_pattern'),
           (NULL, NULL, 'dup sql', 3, 0.2, 'pending', 'query_pattern'),
           ('o1', 'g1', 'single sql', 7, 0.5, 'pending', 'query_pattern'),
           (NULL, NULL, 'dup sql', 1, 0.1, 'pending', 'semantic_amendment')`,
      );

      // Apply the real migration file (dedup fold + unique index + CHECKs).
      await pool.query(migration0172);

      // The three query_pattern duplicates collapsed to one, repetition summed
      // (1+2+3) and confidence set to the group max (0.3).
      const dup = await pool.query<{ repetition_count: number; confidence: number }>(
        `SELECT repetition_count, confidence FROM learned_patterns
          WHERE pattern_sql = 'dup sql' AND type = 'query_pattern'`,
      );
      expect(dup.rows).toHaveLength(1);
      expect(dup.rows[0].repetition_count).toBe(6);
      expect(dup.rows[0].confidence).toBeCloseTo(0.3, 5);

      // The singleton is untouched; the amendment sharing the identity survives
      // (the partial index is query_pattern-only).
      const single = await pool.query<{ c: string }>(
        `SELECT count(*)::text AS c FROM learned_patterns WHERE pattern_sql = 'single sql'`,
      );
      expect(single.rows[0].c).toBe("1");
      const amend = await pool.query<{ c: string }>(
        `SELECT count(*)::text AS c FROM learned_patterns
          WHERE pattern_sql = 'dup sql' AND type = 'semantic_amendment'`,
      );
      expect(amend.rows[0].c).toBe("1");

      // The unique index is now live: a raw duplicate insert (no ON CONFLICT)
      // of the same identity is rejected with 23505.
      await expect(
        pool.query(
          `INSERT INTO learned_patterns (org_id, connection_group_id, pattern_sql, type)
           VALUES (NULL, NULL, 'dup sql', 'query_pattern')`,
        ),
      ).rejects.toMatchObject({ code: "23505" });

      // And the CHECK is live: an out-of-set status is rejected with 23514.
      await expect(
        pool.query(
          `INSERT INTO learned_patterns (pattern_sql, status) VALUES ('chk probe', 'bogus')`,
        ),
      ).rejects.toMatchObject({ code: "23514" });
    },
    PG_TIMEOUT_MS,
  );
});
