/**
 * Real-Postgres tests for the `demo_leads → crm_outbox` backfill (#2736).
 *
 * Skips cleanly when `TEST_DATABASE_URL` is unset so local dev that hasn't
 * run `bun run db:up` is unaffected. CI provides Postgres via a service
 * container in the api-tests job and exports
 * `TEST_DATABASE_URL=postgresql://atlas:atlas@localhost:5432/atlas`.
 *
 * The two scenarios pinned here are the ones the issue (#2736) calls out
 * as the acceptance bar:
 *   1. `--dry-run` reports the row count + a sample of normalized
 *      payloads and writes nothing.
 *   2. Batch boundaries — 1001 rows at `batchSize=500` yields exactly
 *      3 batches and enqueues all 1001 rows.
 *
 * We deliberately don't mock the pool: the script's SQL (keyset cursor,
 * UNNEST bulk insert, BEGIN/COMMIT batch atomicity) is the part most
 * likely to drift and a pg-mem stub wouldn't surface a real plan-time
 * error. The migration smoke test (`migrate-pg.test.ts`) sets the
 * precedent.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import { runMigrations } from "@atlas/api/lib/db/migrate";
import { MANAGED_AUTH_MIGRATIONS } from "@atlas/api/lib/db/internal";
import {
  runBackfill,
  DEFAULT_BATCH_SIZE,
  DRY_RUN_SAMPLE_SIZE,
} from "../backfill-crm-leads";
import type { SaasCrmLeadInput } from "@atlas/api/lib/effect/services";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;
const PG_TEST_TIMEOUT_MS = 60_000;

describeIfPg("backfill-crm-leads (real Postgres)", () => {
  let pool: Pool;
  const schemaName = `backfill_crm_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DB_URL });
    pool.on("connect", (client) => {
      void client.query(`SET search_path TO "${schemaName}"`).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`backfill-crm-leads: SET search_path failed: ${message}`);
      });
    });
    await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
    await runMigrations(pool, { skip: MANAGED_AUTH_MIGRATIONS });
  }, PG_TEST_TIMEOUT_MS);

  afterAll(async () => {
    if (!pool) return;
    await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    await pool.end();
  });

  beforeEach(async () => {
    // Per-test reset — the suite shares a schema (migrations are expensive
    // to re-run) so we wipe the two tables the script touches between
    // tests. Local-pool TRUNCATE is cheaper than spinning a new schema.
    await pool.query(`TRUNCATE demo_leads, crm_outbox RESTART IDENTITY CASCADE`);
  });

  /** Adapter from the pg `Pool` to the script's narrower `BackfillDB`
   *  shape. The script uses `query(sql, params)` returning `{ rows }`,
   *  which `Pool.query` satisfies without a wrapper. The cast is here
   *  only to satisfy the generic row-typing parameter the script
   *  declares — at runtime this is the pool itself. */
  const db = (): Parameters<typeof runBackfill>[0]["db"] =>
    pool as unknown as Parameters<typeof runBackfill>[0]["db"];

  describe("dry-run path", () => {
    it("reports total row count and a normalized sample without writing", async () => {
      // Seed three rows with distinct emails. Three is enough to exercise
      // the sample-truncation logic (DRY_RUN_SAMPLE_SIZE = 3) while
      // keeping the assertion's eyeball-readability.
      await pool.query(
        `INSERT INTO demo_leads (email, ip_address, user_agent)
         VALUES
           ('alice@example.com', '10.0.0.1', 'curl/8.0'),
           ('bob@example.com',   '10.0.0.2', NULL),
           ('CAROL@Example.com', NULL,        'firefox/130')`,
      );
      const logs: string[] = [];

      const stats = await runBackfill({
        db: db(),
        dryRun: true,
        batchSize: DEFAULT_BATCH_SIZE,
        source: "demo",
        log: (m) => logs.push(m),
      });

      expect(stats.totalRows).toBe(3);
      expect(stats.enqueued).toBe(0);
      expect(stats.batches).toBe(1);
      expect(stats.sample).toHaveLength(3);

      // The normalizer lowercases + trims email — confirm the third row
      // (`CAROL@Example.com`) ended up canonicalized. Without this, a
      // future normalizer refactor that dropped the lowercase step would
      // pass type-check and silently drift.
      const emails = stats.sample.map((s) => s.person.email).sort();
      expect(emails).toEqual(["alice@example.com", "bob@example.com", "carol@example.com"]);
      for (const s of stats.sample) {
        expect(s.eventSource).toBe("DEMO");
      }

      // crm_outbox stays untouched — the load-bearing dry-run invariant.
      const { rows } = await pool.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM crm_outbox`,
      );
      expect(rows[0]?.n).toBe("0");

      // Header line ("DRY-RUN — N row(s), batch size B") AND summary
      // line ("DRY-RUN summary — …") both contain "DRY-RUN" — exactly
      // two of them. Pinning the count surfaces a future log-style
      // refactor that drops either marker.
      const dryRunLines = logs.filter((l) => l.includes("DRY-RUN"));
      expect(dryRunLines).toHaveLength(2);
    }, PG_TEST_TIMEOUT_MS);

    it("caps the sample at DRY_RUN_SAMPLE_SIZE even when the table is larger", async () => {
      const values = Array.from({ length: 10 }, (_, i) => `('lead${i}@example.com')`).join(", ");
      await pool.query(`INSERT INTO demo_leads (email) VALUES ${values}`);

      const stats = await runBackfill({
        db: db(),
        dryRun: true,
        batchSize: DEFAULT_BATCH_SIZE,
        source: "demo",
        log: () => {},
      });

      expect(stats.totalRows).toBe(10);
      expect(stats.sample).toHaveLength(DRY_RUN_SAMPLE_SIZE);
    }, PG_TEST_TIMEOUT_MS);

    it("returns zeros and writes nothing when demo_leads is empty", async () => {
      const stats = await runBackfill({
        db: db(),
        dryRun: false,
        batchSize: DEFAULT_BATCH_SIZE,
        source: "demo",
        log: () => {},
      });
      expect(stats).toEqual({ totalRows: 0, enqueued: 0, batches: 0, sample: [] });
      const { rows } = await pool.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM crm_outbox`,
      );
      expect(rows[0]?.n).toBe("0");
    }, PG_TEST_TIMEOUT_MS);
  });

  describe("batch boundary handling", () => {
    it("1001 rows at batchSize=500 produces 3 batches and enqueues all 1001 outbox rows", async () => {
      // Bulk seed — single multi-row INSERT keeps the setup fast even at
      // four-digit row counts. Each email is distinct so the
      // `demo_leads.email` UNIQUE constraint doesn't push back.
      const values: string[] = [];
      for (let i = 0; i < 1001; i++) {
        values.push(`('seed-${i}@example.com')`);
      }
      await pool.query(`INSERT INTO demo_leads (email) VALUES ${values.join(", ")}`);

      const logs: string[] = [];
      const stats = await runBackfill({
        db: db(),
        dryRun: false,
        batchSize: 500,
        source: "demo",
        log: (m) => logs.push(m),
      });

      expect(stats.totalRows).toBe(1001);
      expect(stats.enqueued).toBe(1001);
      expect(stats.batches).toBe(3); // 500 + 500 + 1

      // Outbox actually grew. Each batch is a single multi-row VALUES
      // INSERT (atomic by virtue of being one statement) — a partial
      // commit would still surface as a non-1001 count here.
      const { rows: outboxCount } = await pool.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM crm_outbox`,
      );
      expect(outboxCount[0]?.n).toBe("1001");

      // The seed used a single multi-row INSERT, so every demo_leads row
      // shares the same `now()` timestamp. That this test terminates
      // (vs looping forever past 1001/1001) is the regression gate for
      // the `(created_at, id)` keyset bug — see the cursor docstring.

      // Every enqueued row uses the expected event_type + 'pending'
      // status. Pinning these two is enough — the flusher reads both and
      // a drift would silently swallow the dispatch.
      const { rows: shape } = await pool.query<{ event_type: string; status: string; n: string }>(
        `SELECT event_type, status, COUNT(*)::text AS n
           FROM crm_outbox
          GROUP BY event_type, status`,
      );
      expect(shape).toHaveLength(1);
      expect(shape[0]?.event_type).toBe("demo");
      expect(shape[0]?.status).toBe("pending");
      expect(shape[0]?.n).toBe("1001");

      // Three batch log lines, then the success summary. Logs are not
      // load-bearing but their absence would mean the operator gets no
      // mid-run progress on a long backfill — that's the AC. Match on
      // the per-batch prefix (`batch N:`) so the header's `batch size`
      // phrasing doesn't bleed into the count.
      const batchLines = logs.filter((l) => /batch \d+:/.test(l));
      expect(batchLines).toHaveLength(3);
    }, PG_TEST_TIMEOUT_MS);

    it("preserves payload shape — first row round-trips through normalizer to outbox.payload", async () => {
      await pool.query(
        `INSERT INTO demo_leads (email, ip_address, user_agent)
         VALUES ('roundtrip@example.com', '192.168.1.1', 'Chrome/130')`,
      );

      await runBackfill({
        db: db(),
        dryRun: false,
        batchSize: DEFAULT_BATCH_SIZE,
        source: "demo",
        log: () => {},
      });

      const { rows } = await pool.query<{ event_type: string; payload: Record<string, unknown> }>(
        `SELECT event_type, payload FROM crm_outbox LIMIT 1`,
      );
      expect(rows[0]?.event_type).toBe("demo");
      // payload is the raw AtlasLeadEvent (the dispatcher re-normalizes).
      // Email lowercases at the *normalizer* seam — the payload itself
      // carries the original form. Pin both so a future "lowercase at
      // enqueue" refactor doesn't silently change the contract.
      //
      // Pinning against `SaasCrmLeadInput` (the EE dispatcher's read
      // shape — `ee/src/saas-crm/index.ts:dispatchOutboxRow` casts
      // `row.payload as SaasCrmLeadInput`) keeps the producer +
      // consumer in lockstep at compile time. A drift in either side
      // surfaces here as a type mismatch rather than a runtime
      // "Unknown lead source" in production.
      const expected: SaasCrmLeadInput = {
        source: "demo",
        email: "roundtrip@example.com",
        ip: "192.168.1.1",
        userAgent: "Chrome/130",
      };
      expect(rows[0]?.payload).toEqual(expected);
    }, PG_TEST_TIMEOUT_MS);

    it("rejects batchSize < 1 before any DB work", async () => {
      await expect(
        runBackfill({
          db: db(),
          dryRun: true,
          batchSize: 0,
          source: "demo",
          log: () => {},
        }),
      ).rejects.toThrow(/batchSize/);
    }, PG_TEST_TIMEOUT_MS);

    it("handles a single-row table — one batch, one row enqueued", async () => {
      // The short-page break (`page.rows.length < options.batchSize`) is
      // the load-bearing termination condition when batchSize > total.
      // Without this test, an off-by-one regression that re-issues the
      // empty-page query would only surface as a perf regression, not
      // an incorrectness one.
      await pool.query(`INSERT INTO demo_leads (email) VALUES ('only@example.com')`);
      const stats = await runBackfill({
        db: db(),
        dryRun: false,
        batchSize: 500,
        source: "demo",
        log: () => {},
      });
      expect(stats).toMatchObject({ totalRows: 1, enqueued: 1, batches: 1 });
    }, PG_TEST_TIMEOUT_MS);

    it("count-drift guard: throws if the INSERT returns fewer rows than the batch", async () => {
      // Pins the post-condition that `result.rows.length` matches
      // `page.rows.length`. If a future ON CONFLICT DO NOTHING is added
      // to the bulk-INSERT SQL, RETURNING would omit skipped rows and
      // stats.enqueued would silently under-report. Inject a
      // count-skewing fake `db` to prove the guard fires.
      await pool.query(`INSERT INTO demo_leads (email) VALUES ('drift@example.com')`);
      const realQuery = pool.query.bind(pool);
      const skewedDb = {
        async query<T extends Record<string, unknown>>(sql: string, params?: unknown[]) {
          const result = await realQuery<T>(sql, params);
          // Drop the RETURNING result on the bulk-INSERT path only.
          if (/^\s*INSERT INTO crm_outbox/.test(sql)) {
            return { rows: [] as T[] };
          }
          return { rows: result.rows };
        },
      } as Parameters<typeof runBackfill>[0]["db"];

      await expect(
        runBackfill({
          db: skewedDb,
          dryRun: false,
          batchSize: 500,
          source: "demo",
          log: () => {},
        }),
      ).rejects.toThrow(/ON CONFLICT/);
    }, PG_TEST_TIMEOUT_MS);
  });
});
