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

      const recovered = await recoverInFlight(db);
      expect(recovered).toBe(1);

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
});
