/**
 * Real-Postgres tests for the promote/decay DB helpers (#3636, PRD #3617 B-2).
 *
 * The nightly scheduler has NO concurrent-run mutex — `Schedule.spaced` can
 * overlap a slow tick with the next one. The ENTIRE idempotency + concurrent-
 * admin-safety story therefore rests on the `status` / `auto_promoted` WHERE
 * clauses in `promoteLearnedPatterns` / `demoteLearnedPatterns` and the
 * candidate-selection filter in `getPromoteDecayCandidates`. The unit/scheduler
 * tests mock those helpers away, so the SQL guarantees were untested. These run
 * the exact production SQL against real Postgres and assert:
 *   - a double promote/demote is a no-op the second time (idempotency),
 *   - a human approval (auto_promoted=false) is never demoted by decay,
 *   - candidate selection includes pending + machine-promoted rows only,
 *     excluding rejected, human-approved, and non-query_pattern rows.
 *
 * Skipped cleanly when `TEST_DATABASE_URL` is unset (matches `audit-slow-pg`
 * / `pattern-latency-pg`). CI's api-tests workflow provides the Postgres service.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import { runMigrations } from "@atlas/api/lib/db/migrate";
import {
  MANAGED_AUTH_MIGRATIONS,
  _resetPool,
  promoteLearnedPatterns,
  demoteLearnedPatterns,
  getPromoteDecayCandidates,
  type InternalPool,
} from "@atlas/api/lib/db/internal";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;

const PG_TIMEOUT_MS = 30_000;
const ORG = "org-promote-decay-test";

interface StatusRow {
  status: string;
  auto_promoted: boolean;
}

describeIfPg("promote/decay DB helpers (real Postgres, #3636)", () => {
  let pool: Pool;
  const schemaName = `promote_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DB_URL });
    pool.on("connect", (client) => {
      void client.query(`SET search_path TO "${schemaName}"`).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`promote-decay-pg: SET search_path failed: ${message}`);
      });
    });
    await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
    await runMigrations(pool, { skip: MANAGED_AUTH_MIGRATIONS });
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

  /** Insert a pattern row and return its generated uuid. */
  async function seed(opts: {
    sql: string;
    status: string;
    autoPromoted?: boolean;
    type?: string;
    confidence?: number;
    repetitionCount?: number;
  }): Promise<string> {
    const res = await pool.query<{ id: string }>(
      `INSERT INTO learned_patterns
        (org_id, pattern_sql, status, type, auto_promoted, confidence, repetition_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        ORG,
        opts.sql,
        opts.status,
        opts.type ?? "query_pattern",
        opts.autoPromoted ?? false,
        opts.confidence ?? 0.9,
        opts.repetitionCount ?? 10,
      ],
    );
    return res.rows[0].id;
  }

  async function statusOf(id: string): Promise<StatusRow> {
    const res = await pool.query<StatusRow>(
      `SELECT status, auto_promoted FROM learned_patterns WHERE id = $1`,
      [id],
    );
    return res.rows[0];
  }

  it(
    "promote is idempotent — the second run on an already-promoted row is a no-op",
    async () => {
      const id = await seed({ sql: "SELECT 1", status: "pending" });

      const first = await promoteLearnedPatterns([id]);
      expect(first.count).toBe(1);
      const after = await statusOf(id);
      expect(after.status).toBe("approved");
      expect(after.auto_promoted).toBe(true);

      // Re-run (simulating an overlapping tick): the row is no longer pending,
      // so the WHERE matches nothing — count 0, state unchanged.
      const second = await promoteLearnedPatterns([id]);
      expect(second.count).toBe(0);
      expect((await statusOf(id)).status).toBe("approved");
    },
    PG_TIMEOUT_MS,
  );

  it(
    "decay is idempotent and NEVER demotes a human approval (auto_promoted=false)",
    async () => {
      const machine = await seed({ sql: "SELECT 2", status: "approved", autoPromoted: true });
      const human = await seed({ sql: "SELECT 3", status: "approved", autoPromoted: false });

      const first = await demoteLearnedPatterns([machine, human]);
      // Only the machine-promoted row is demoted; the human approval is untouched.
      expect(first.count).toBe(1);
      expect((await statusOf(machine)).status).toBe("pending");
      expect((await statusOf(machine)).auto_promoted).toBe(true); // survives the round-trip
      expect((await statusOf(human)).status).toBe("approved");

      // Re-run: machine row is now pending, human still approved-but-not-auto →
      // neither matches the demote WHERE. No-op.
      const second = await demoteLearnedPatterns([machine, human]);
      expect(second.count).toBe(0);
    },
    PG_TIMEOUT_MS,
  );

  it(
    "a concurrent admin approval (clears auto_promoted) is protected from decay",
    async () => {
      const id = await seed({ sql: "SELECT 4", status: "approved", autoPromoted: true });
      // Admin reviews it between candidate selection and the decay UPDATE: the
      // approve path sets auto_promoted=false. Decay must then skip it.
      await pool.query(`UPDATE learned_patterns SET auto_promoted = false WHERE id = $1`, [id]);

      const res = await demoteLearnedPatterns([id]);
      expect(res.count).toBe(0);
      expect((await statusOf(id)).status).toBe("approved");
    },
    PG_TIMEOUT_MS,
  );

  it(
    "candidate selection includes pending + machine-promoted only; excludes rejected, human-approved, and non-query rows",
    async () => {
      const pending = await seed({ sql: "SELECT 10", status: "pending" });
      const machine = await seed({ sql: "SELECT 11", status: "approved", autoPromoted: true });
      await seed({ sql: "SELECT 12", status: "approved", autoPromoted: false }); // human — excluded
      await seed({ sql: "SELECT 13", status: "rejected" }); // excluded
      await seed({ sql: "SELECT 14", status: "pending", type: "semantic_amendment" }); // excluded

      const candidates = await getPromoteDecayCandidates();
      const ids = candidates.map((c) => c.id).sort();
      expect(ids).toEqual([pending, machine].sort());
    },
    PG_TIMEOUT_MS,
  );
});
