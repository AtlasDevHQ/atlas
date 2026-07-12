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
  // promoteLearnedPatterns / demoteLearnedPatterns / getPromoteDecayCandidates
  // gate on hasInternalDB() === !!process.env.DATABASE_URL (unlike the latency
  // helpers, which don't), so point DATABASE_URL at the test DB for the run.
  let origDbUrl: string | undefined;

  beforeAll(async () => {
    origDbUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = TEST_DB_URL;
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
    if (origDbUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = origDbUrl;
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
    orgId?: string | null;
    updatedAt?: string;
  }): Promise<string> {
    const res = await pool.query<{ id: string }>(
      `INSERT INTO learned_patterns
        (org_id, pattern_sql, status, type, auto_promoted, confidence, repetition_count, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8::timestamptz, now()))
       RETURNING id`,
      [
        opts.orgId === undefined ? ORG : opts.orgId,
        opts.sql,
        opts.status,
        opts.type ?? "query_pattern",
        opts.autoPromoted ?? false,
        opts.confidence ?? 0.9,
        opts.repetitionCount ?? 10,
        opts.updatedAt ?? null,
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

      const candidates = await getPromoteDecayCandidates(ORG);
      const ids = candidates.map((c) => c.id).sort();
      expect(ids).toEqual([pending, machine].sort());
    },
    PG_TIMEOUT_MS,
  );

  it(
    "excludes seen-once (repetition_count = 1) pending rows from promotion candidates, never from decay (#4581)",
    async () => {
      // A single capture is not evidence — it must stay out of the auto-promoter's
      // candidate set until it repeats, regardless of a low `minRepetitions`.
      const seenOnce = await seed({ sql: "SELECT 40", status: "pending", repetitionCount: 1 });
      const repeated = await seed({ sql: "SELECT 41", status: "pending", repetitionCount: 2 });
      // Decay is a repetition-independent path: a machine-approved row must remain
      // reachable for demotion even at repetition 1, so the floor is scoped to the
      // pending arm only.
      const machineRep1 = await seed({
        sql: "SELECT 42",
        status: "approved",
        autoPromoted: true,
        repetitionCount: 1,
      });

      const ids = (await getPromoteDecayCandidates(ORG)).map((c) => c.id).sort();
      expect(ids).toEqual([repeated, machineRep1].sort());
      expect(ids).not.toContain(seenOnce);
    },
    PG_TIMEOUT_MS,
  );

  it(
    "candidate scope is per-workspace — a different org's rows are excluded (#4582)",
    async () => {
      const mine = await seed({ sql: "SELECT 20", status: "pending", orgId: ORG });
      await seed({ sql: "SELECT 21", status: "pending", orgId: "other-org" });
      // A NULL-org (self-hosted-shaped) row must not bleed into an org scan.
      await seed({ sql: "SELECT 22", status: "pending", orgId: null });

      const scoped = await getPromoteDecayCandidates(ORG);
      expect(scoped.map((c) => c.id)).toEqual([mine]);

      // A null scope sees only the NULL-org row, never the org-stamped ones.
      const nullScoped = await getPromoteDecayCandidates(null);
      expect(nullScoped.map((c) => c.org_id)).toEqual([null]);
    },
    PG_TIMEOUT_MS,
  );

  it(
    "candidate order is freshest-touched first, so the cap keeps fresh rows (#4582)",
    async () => {
      // Insert oldest → newest by updated_at; the scan must return newest first
      // so a `LIMIT` truncation drops the STALEST rows, never the fresh ones a
      // tenant is actively re-running.
      const stale = await seed({ sql: "SELECT 30", status: "pending", updatedAt: "2020-01-01T00:00:00Z" });
      const mid = await seed({ sql: "SELECT 31", status: "pending", updatedAt: "2023-01-01T00:00:00Z" });
      const fresh = await seed({ sql: "SELECT 32", status: "pending", updatedAt: "2026-01-01T00:00:00Z" });

      const all = await getPromoteDecayCandidates(ORG);
      expect(all.map((c) => c.id)).toEqual([fresh, mid, stale]);

      // Under a cap of 2, the two freshest survive; the stalest is deferred.
      const capped = await getPromoteDecayCandidates(ORG, 2);
      expect(capped.map((c) => c.id)).toEqual([fresh, mid]);
    },
    PG_TIMEOUT_MS,
  );
});
