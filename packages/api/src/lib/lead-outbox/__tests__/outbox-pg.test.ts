/**
 * Real-Postgres integration tests for the lead-outbox flusher.
 *
 * Skipped cleanly when `TEST_DATABASE_URL` is unset (matches the
 * pattern in `migrate-pg.test.ts`). In CI the api-tests workflow
 * provides a Postgres service container and exports the URL.
 *
 * Each test runs against a unique per-test schema so concurrent shards
 * don't collide; the `crm_outbox` migration is applied via the runner
 * inside the same schema. Tests do NOT call the real Twenty API —
 * dispatchers are local lambdas that simulate the upstream behaviour.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import { runMigrations } from "@atlas/api/lib/db/migrate";
import { MANAGED_AUTH_MIGRATIONS } from "@atlas/api/lib/db/internal";
import {
  enqueue,
  flushBatch,
  recoverInFlight,
  type OutboxDB,
  type OutboxDispatcher,
} from "../outbox";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;

const PG_TIMEOUT_MS = 30_000;

describeIfPg("lead-outbox (real Postgres)", () => {
  let pool: Pool;
  const schemaName = `outbox_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DB_URL });
    pool.on("connect", (client) => {
      void client.query(`SET search_path TO "${schemaName}"`).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`outbox-pg: SET search_path failed: ${message}`);
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

  /** Adapter so the outbox functions can drive the real pg.Pool. */
  function dbFor(): OutboxDB {
    return {
      query: async <T extends Record<string, unknown>>(
        sql: string,
        params?: unknown[],
      ) => {
        const result = await pool.query<T>(sql, params);
        return result.rows;
      },
    };
  }

  async function truncateOutbox(): Promise<void> {
    await pool.query("TRUNCATE crm_outbox");
  }

  it(
    "enqueue → flushBatch → done (happy path)",
    async () => {
      await truncateOutbox();
      const db = dbFor();
      const id = await enqueue(db, {
        eventType: "demo",
        payload: { source: "demo", email: "ok@happy.test" },
      });

      const dispatcher: OutboxDispatcher = async (_row, persist) => {
        await persist.setTwentyPersonId("person-real-1");
        return { kind: "ok" };
      };

      const result = await flushBatch(db, dispatcher, 10);
      expect(result.claimed).toBe(1);
      expect(result.ok).toBe(1);

      const rows = await pool.query(
        "SELECT status, twenty_person_id, processed_at FROM crm_outbox WHERE id = $1",
        [id],
      );
      expect(rows.rows[0].status).toBe("done");
      expect(rows.rows[0].twenty_person_id).toBe("person-real-1");
      expect(rows.rows[0].processed_at).not.toBeNull();
    },
    PG_TIMEOUT_MS,
  );

  it(
    "401 → permanent → dead",
    async () => {
      await truncateOutbox();
      const db = dbFor();
      const id = await enqueue(db, {
        eventType: "demo",
        payload: { source: "demo", email: "401@dead.test" },
      });

      const dispatcher: OutboxDispatcher = async () => ({
        kind: "permanent",
        message: "upsertPerson failed (status=401)",
      });

      await flushBatch(db, dispatcher, 10);

      const rows = await pool.query(
        "SELECT status, last_error FROM crm_outbox WHERE id = $1",
        [id],
      );
      expect(rows.rows[0].status).toBe("dead");
      expect(rows.rows[0].last_error).toContain("401");
    },
    PG_TIMEOUT_MS,
  );

  it(
    "5xx → transient → pending again (retried)",
    async () => {
      await truncateOutbox();
      const db = dbFor();
      const id = await enqueue(db, {
        eventType: "demo",
        payload: { source: "demo", email: "503@retry.test" },
      });

      const dispatcher: OutboxDispatcher = async () => ({
        kind: "transient",
        message: "upstream 503",
      });

      const result = await flushBatch(db, dispatcher, 10);
      expect(result.transient).toBe(1);

      const rows = await pool.query(
        "SELECT status, attempts, last_error FROM crm_outbox WHERE id = $1",
        [id],
      );
      expect(rows.rows[0].status).toBe("pending");
      expect(rows.rows[0].attempts).toBe(1);
      expect(rows.rows[0].last_error).toContain("503");
    },
    PG_TIMEOUT_MS,
  );

  it(
    "idempotent replay — partial success + retry does NOT call upsertPerson twice",
    async () => {
      await truncateOutbox();
      const db = dbFor();
      // Insert with a back-dated created_at so the row clears every
      // backoff tier on every flush. Without this, the second flush
      // would be blocked by the 30s gap that attempts=1 requires.
      await pool.query(
        `INSERT INTO crm_outbox (event_type, payload, status, created_at)
         VALUES ('demo', $1::jsonb, 'pending', now() - INTERVAL '3 hours')`,
        [JSON.stringify({ source: "demo", email: "idempotent@replay.test" })],
      );

      let upsertCalls = 0;
      const dispatcher: OutboxDispatcher = async (row, persist) => {
        if (!row.twentyPersonId) {
          upsertCalls++;
          await persist.setTwentyPersonId("person-idempotent");
        }
        if (row.attempts === 1) {
          // Simulate a crash AFTER the person ID is persisted: return
          // transient so the row goes back to pending for the next tick.
          return { kind: "transient", message: "crashed after person persist" };
        }
        return { kind: "ok" };
      };

      // First flush: upsertPerson called, ID persisted, then transient → pending.
      await flushBatch(db, dispatcher, 10);
      const afterFirst = await pool.query(
        "SELECT status, attempts, twenty_person_id FROM crm_outbox WHERE event_type = 'demo'",
      );
      expect(afterFirst.rows[0].status).toBe("pending");
      expect(afterFirst.rows[0].twenty_person_id).toBe("person-idempotent");

      // Second flush: dispatcher sees the persisted ID and skips
      // upsertPerson. upsertCalls must remain 1.
      await flushBatch(db, dispatcher, 10);
      expect(upsertCalls).toBe(1);

      const afterSecond = await pool.query(
        "SELECT status, twenty_person_id FROM crm_outbox WHERE event_type = 'demo'",
      );
      expect(afterSecond.rows[0].status).toBe("done");
      expect(afterSecond.rows[0].twenty_person_id).toBe("person-idempotent");
    },
    PG_TIMEOUT_MS,
  );

  it(
    "row with both IDs set goes straight to done without any Twenty calls",
    async () => {
      await truncateOutbox();
      const db = dbFor();
      // Insert a row that's been partially-completed across both
      // sub-steps. Back-date created_at so the attempts=2 backoff
      // (~2 minutes) doesn't gate the immediate claim.
      await pool.query(
        `INSERT INTO crm_outbox (event_type, payload, status, attempts, twenty_person_id, twenty_note_id, created_at)
         VALUES ('sales-form', $1::jsonb, 'pending', 2, 'person-X', 'note-Y', now() - INTERVAL '3 hours')`,
        [JSON.stringify({ source: "sales-form", email: "both@set.test" })],
      );

      let dispatchCalls = 0;
      const dispatcher: OutboxDispatcher = async (row, _persist) => {
        dispatchCalls++;
        // Sanity: dispatcher must observe both IDs already populated.
        expect(row.twentyPersonId).toBe("person-X");
        expect(row.twentyNoteId).toBe("note-Y");
        return { kind: "ok" };
      };

      await flushBatch(db, dispatcher, 10);
      expect(dispatchCalls).toBe(1);

      const after = await pool.query(
        "SELECT status FROM crm_outbox WHERE event_type = 'sales-form'",
      );
      expect(after.rows[0].status).toBe("done");
    },
    PG_TIMEOUT_MS,
  );

  it(
    "startup recovery — in_flight row at boot is reset to pending",
    async () => {
      await truncateOutbox();
      const db = dbFor();
      const id = await enqueue(db, {
        eventType: "demo",
        payload: { source: "demo", email: "stranded@recover.test" },
      });
      // Simulate a crash mid-dispatch by forcing the row into in_flight.
      await pool.query(
        "UPDATE crm_outbox SET status = 'in_flight' WHERE id = $1",
        [id],
      );

      // Use 0ms threshold so the just-claimed row is treated as stale
      // for the test (in production, startup uses STARTUP_RECOVERY_STALE_MS).
      const recovered = await recoverInFlight(db, 0);
      expect(recovered.reset).toBe(1);
      expect(recovered.deadLettered).toBe(0);

      const rows = await pool.query(
        "SELECT status FROM crm_outbox WHERE id = $1",
        [id],
      );
      expect(rows.rows[0].status).toBe("pending");
    },
    PG_TIMEOUT_MS,
  );

  it(
    "backoff — recently-failed row is NOT claimed before its tier delay elapses",
    async () => {
      await truncateOutbox();
      const db = dbFor();
      // Insert a row whose attempts=2 and was created just now. The
      // tier delay for attempts=2 is 2 minutes — the claim WHERE
      // should filter it out.
      await pool.query(
        `INSERT INTO crm_outbox (event_type, payload, status, attempts, created_at)
         VALUES ('demo', $1::jsonb, 'pending', 2, now())`,
        [JSON.stringify({ source: "demo", email: "backoff@test" })],
      );

      let calls = 0;
      const dispatcher: OutboxDispatcher = async () => {
        calls++;
        return { kind: "ok" };
      };

      const result = await flushBatch(db, dispatcher, 10);
      expect(result.claimed).toBe(0);
      expect(calls).toBe(0);
    },
    PG_TIMEOUT_MS,
  );

  it(
    "backoff — older row (created before the tier delay) IS claimed",
    async () => {
      await truncateOutbox();
      const db = dbFor();
      // attempts=1 needs a 30s gap from created_at; back-date by 1 minute.
      await pool.query(
        `INSERT INTO crm_outbox (event_type, payload, status, attempts, created_at)
         VALUES ('demo', $1::jsonb, 'pending', 1, now() - INTERVAL '1 minute')`,
        [JSON.stringify({ source: "demo", email: "due@test" })],
      );

      let calls = 0;
      const dispatcher: OutboxDispatcher = async () => {
        calls++;
        return { kind: "ok" };
      };

      const result = await flushBatch(db, dispatcher, 10);
      expect(result.claimed).toBe(1);
      expect(calls).toBe(1);
    },
    PG_TIMEOUT_MS,
  );

  // ── Concurrency: FOR UPDATE SKIP LOCKED is the load-bearing claim
  //    invariant. Two concurrent flushBatch calls must NEVER dispatch
  //    the same row twice — the test pins that property end-to-end.
  it(
    "concurrent claims — exactly one dispatcher fires per row",
    async () => {
      await truncateOutbox();
      const db = dbFor();
      await enqueue(db, {
        eventType: "demo",
        payload: { source: "demo", email: "race@test" },
      });

      let totalDispatched = 0;
      const dispatcher: OutboxDispatcher = async () => {
        totalDispatched++;
        // Hold the lock briefly so the second flush's claim is forced
        // to skip the locked row rather than wait for it.
        await new Promise((resolve) => setTimeout(resolve, 50));
        return { kind: "ok" };
      };

      const [a, b] = await Promise.all([
        flushBatch(db, dispatcher, 10),
        flushBatch(db, dispatcher, 10),
      ]);

      // Exactly one of the two flushes claimed the row.
      expect(a.claimed + b.claimed).toBe(1);
      expect(a.ok + b.ok).toBe(1);
      expect(totalDispatched).toBe(1);

      const rows = await pool.query(
        "SELECT status FROM crm_outbox WHERE event_type = 'demo'",
      );
      expect(rows.rows[0].status).toBe("done");
    },
    PG_TIMEOUT_MS,
  );

  // ── A long-backoff row on the same table must NOT stall a fresh,
  //    immediately-due row. The migration comment and issue body both
  //    promise this — pin it end-to-end.
  it(
    "long-backoff row does NOT block a fresh row claimable in the same tick",
    async () => {
      await truncateOutbox();
      const db = dbFor();
      // Row A: high attempts, recent created_at → gated by tier delay.
      await pool.query(
        `INSERT INTO crm_outbox (event_type, payload, status, attempts, created_at)
         VALUES ('demo', $1::jsonb, 'pending', 4, now())`,
        [JSON.stringify({ source: "demo", email: "stalled@test" })],
      );
      // Row B: fresh, attempts=0 (no backoff) → due immediately.
      await pool.query(
        `INSERT INTO crm_outbox (event_type, payload, status, attempts, created_at)
         VALUES ('demo', $1::jsonb, 'pending', 0, now())`,
        [JSON.stringify({ source: "demo", email: "fresh@test" })],
      );

      const claimedEmails: string[] = [];
      const dispatcher: OutboxDispatcher = async (row) => {
        const payload = row.payload as { email: string };
        claimedEmails.push(payload.email);
        return { kind: "ok" };
      };

      const result = await flushBatch(db, dispatcher, 10);
      expect(result.claimed).toBe(1);
      expect(claimedEmails).toEqual(["fresh@test"]);
    },
    PG_TIMEOUT_MS,
  );

  // ── Retry-After must override the tier-based backoff.
  it(
    "transient outcome with retryAfterMs stamps retry_after and gates the next claim",
    async () => {
      await truncateOutbox();
      const db = dbFor();
      await enqueue(db, {
        eventType: "demo",
        payload: { source: "demo", email: "retry-after@test" },
      });

      // Dispatcher returns transient with a 5-minute Retry-After.
      const dispatcher: OutboxDispatcher = async () => ({
        kind: "transient",
        message: "429 rate-limited",
        retryAfterMs: 5 * 60 * 1_000,
      });

      const first = await flushBatch(db, dispatcher, 10);
      expect(first.transient).toBe(1);

      // Confirm retry_after is stamped roughly 5 minutes out.
      const rowsAfter = await pool.query(
        "SELECT retry_after FROM crm_outbox WHERE event_type = 'demo'",
      );
      expect(rowsAfter.rows[0].retry_after).not.toBeNull();

      // attempts=1 tier delay is 30s. Without retry_after this row
      // would be claimable after backdating ~30s. WITH retry_after the
      // 5-minute upstream-requested delay must win.
      await pool.query(
        `UPDATE crm_outbox SET created_at = now() - INTERVAL '40 seconds'
         WHERE event_type = 'demo'`,
      );

      let dispatchCount = 0;
      const noopDispatcher: OutboxDispatcher = async () => {
        dispatchCount++;
        return { kind: "ok" };
      };
      const second = await flushBatch(db, noopDispatcher, 10);
      expect(second.claimed).toBe(0);
      expect(dispatchCount).toBe(0);
    },
    PG_TIMEOUT_MS,
  );

  // ── Real-PG dead-letter via transient budget exhaustion.
  it(
    "transient on the 6th attempt is dead-lettered in real Postgres",
    async () => {
      await truncateOutbox();
      const db = dbFor();
      // Insert at attempts=5 with a back-dated created_at so the next
      // claim picks it up immediately.
      await pool.query(
        `INSERT INTO crm_outbox (event_type, payload, status, attempts, created_at)
         VALUES ('demo', $1::jsonb, 'pending', 5, now() - INTERVAL '3 hours')`,
        [JSON.stringify({ source: "demo", email: "budget-real@test" })],
      );

      const dispatcher: OutboxDispatcher = async () => ({
        kind: "transient",
        message: "still flaky",
      });

      await flushBatch(db, dispatcher, 10);
      const rows = await pool.query(
        "SELECT status, attempts, last_error FROM crm_outbox WHERE event_type = 'demo'",
      );
      expect(rows.rows[0].status).toBe("dead");
      expect(rows.rows[0].attempts).toBe(6);
      expect(rows.rows[0].last_error).toContain("transient failure after 6 attempts");
    },
    PG_TIMEOUT_MS,
  );

  // ── Backoff TS/SQL lockstep at the database level.
  it(
    "CLAIM_DELAY_SQL evaluates to the same delays as DELAYS_MS at every tier",
    async () => {
      const expected = [
        { attempts: 0, seconds: 0 },
        { attempts: 1, seconds: 30 },
        { attempts: 2, seconds: 120 },
        { attempts: 3, seconds: 480 },
        { attempts: 4, seconds: 1800 },
        { attempts: 5, seconds: 7200 },
      ];
      for (const { attempts, seconds } of expected) {
        const result = await pool.query<{ s: string }>(
          `SELECT EXTRACT(EPOCH FROM (
             CASE $1::int
               WHEN 0 THEN INTERVAL '0'
               WHEN 1 THEN INTERVAL '30 seconds'
               WHEN 2 THEN INTERVAL '2 minutes'
               WHEN 3 THEN INTERVAL '8 minutes'
               WHEN 4 THEN INTERVAL '30 minutes'
               WHEN 5 THEN INTERVAL '2 hours'
               ELSE INTERVAL '2 hours'
             END
           ))::text AS s`,
          [attempts],
        );
        expect(Number.parseFloat(result.rows[0].s)).toBe(seconds);
      }
    },
    PG_TIMEOUT_MS,
  );

  // ── Per-email serialization (#2870) — real-PG variant.
  // Mirrors the unit test in `outbox.test.ts` but exercises the actual
  // CLAIM_SQL CTE (DISTINCT ON + NOT EXISTS) against Postgres so a
  // regression in the SQL shape (e.g. wrong column quoting, forgotten
  // index reference) trips here instead of only in the in-memory fake.
  it(
    "claim dedupes same-email rows: gworth demo→signup pair drains across two ticks",
    async () => {
      await truncateOutbox();
      const db = dbFor();

      const demoId = await enqueue(db, {
        eventType: "demo",
        payload: { source: "demo", email: "gworth@globexcorp.com", ip: "203.0.113.30" },
      });
      const signupId = await enqueue(db, {
        eventType: "signup",
        payload: { source: "signup", email: "gworth@globexcorp.com", name: "Greta Worth" },
      });

      // Both rows should have email_key populated by enqueue.
      const seeded = await pool.query<{ id: string; email_key: string | null }>(
        "SELECT id, email_key FROM crm_outbox ORDER BY created_at",
      );
      expect(seeded.rows).toHaveLength(2);
      expect(seeded.rows[0].email_key).toBe("gworth@globexcorp.com");
      expect(seeded.rows[1].email_key).toBe("gworth@globexcorp.com");

      const dispatcher: OutboxDispatcher = async () => ({ kind: "ok" });

      // Tick 1: only demo claimed; signup blocked by demo's in_flight presence
      // mid-statement (the CTE locks demo first, then NOT EXISTS sees it as
      // about-to-be in_flight for signup's slot). DISTINCT ON also dedupes
      // within the same batch.
      const tick1 = await flushBatch(db, dispatcher, 50);
      expect(tick1.claimed).toBe(1);
      expect(tick1.ok).toBe(1);

      const afterTick1 = await pool.query<{ id: string; status: string }>(
        "SELECT id, status FROM crm_outbox ORDER BY created_at",
      );
      expect(afterTick1.rows.find((r) => r.id === demoId)?.status).toBe("done");
      expect(afterTick1.rows.find((r) => r.id === signupId)?.status).toBe("pending");

      // Tick 2: demo is done, signup is now claimable.
      const tick2 = await flushBatch(db, dispatcher, 50);
      expect(tick2.claimed).toBe(1);
      expect(tick2.ok).toBe(1);

      const afterTick2 = await pool.query<{ status: string }>(
        "SELECT status FROM crm_outbox WHERE id = $1",
        [signupId],
      );
      expect(afterTick2.rows[0].status).toBe("done");
    },
    PG_TIMEOUT_MS,
  );

  it(
    "claim NOT EXISTS gate: in_flight row blocks newer same-email claims (cross-pod safety)",
    async () => {
      await truncateOutbox();
      const db = dbFor();

      // Seed an in_flight row directly (simulates a sibling pod mid-dispatch).
      await pool.query(
        `INSERT INTO crm_outbox (event_type, payload, email_key, status, attempts, claimed_at, created_at)
         VALUES ('demo', $1::jsonb, $2, 'in_flight', 1, now(), now() - INTERVAL '3 hours')`,
        [
          JSON.stringify({ source: "demo", email: "stuck@example.test" }),
          "stuck@example.test",
        ],
      );
      // Newer pending row for the same email.
      await enqueue(db, {
        eventType: "signup",
        payload: { source: "signup", email: "stuck@example.test", name: "Stuck User" },
      });

      const dispatcher: OutboxDispatcher = async () => ({ kind: "ok" });
      const result = await flushBatch(db, dispatcher, 50);
      // No row claimable — sibling is in_flight for this email_key.
      expect(result.claimed).toBe(0);

      const rows = await pool.query<{ event_type: string; status: string }>(
        "SELECT event_type, status FROM crm_outbox ORDER BY created_at",
      );
      expect(rows.rows.find((r) => r.event_type === "signup")?.status).toBe("pending");
    },
    PG_TIMEOUT_MS,
  );

  it(
    "claim does not serialize across distinct emails (throughput preserved)",
    async () => {
      await truncateOutbox();
      const db = dbFor();

      // Four distinct emails — all should claim in one tick.
      await enqueue(db, { eventType: "demo", payload: { source: "demo", email: "a1@example.test" } });
      await enqueue(db, { eventType: "demo", payload: { source: "demo", email: "a2@example.test" } });
      await enqueue(db, { eventType: "demo", payload: { source: "demo", email: "a3@example.test" } });
      await enqueue(db, { eventType: "demo", payload: { source: "demo", email: "a4@example.test" } });

      const dispatcher: OutboxDispatcher = async () => ({ kind: "ok" });
      const result = await flushBatch(db, dispatcher, 50);
      expect(result.claimed).toBe(4);
      expect(result.ok).toBe(4);
    },
    PG_TIMEOUT_MS,
  );
});
