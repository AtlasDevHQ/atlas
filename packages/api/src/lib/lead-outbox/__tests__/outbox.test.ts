/**
 * Lead-outbox unit tests against an in-memory fake of the `OutboxDB`
 * surface. We avoid spinning up a real Postgres here — the SQL strings
 * are exercised end-to-end by `outbox-pg.test.ts` (gated on
 * `TEST_DATABASE_URL`). This file's job is to nail down the
 * idempotency contract and sub-step replay semantics, which are pure
 * TypeScript behaviour and don't need a real DB to fail loudly.
 *
 * The fake recognises each SQL string from the module and dispatches to
 * an in-memory row table. It is deliberately literal — the dispatcher
 * code under test is what we're verifying, not the SQL.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import {
  enqueue,
  flushBatch,
  recoverInFlight,
  type ClaimedOutboxRow,
  type DispatchOutcome,
  type OutboxDB,
  type OutboxDispatcher,
  type OutboxPersistHelpers,
} from "../outbox";

type Row = {
  id: string;
  event_type: string;
  payload: unknown;
  status: "pending" | "in_flight" | "done" | "dead";
  attempts: number;
  last_error: string | null;
  twenty_person_id: string | null;
  twenty_note_id: string | null;
  created_at: number;
  processed_at: number | null;
};

class FakeOutboxDB implements OutboxDB {
  rows: Row[] = [];
  private nextId = 1;
  /** When true, every claim returns 0 rows (simulates contention). */
  claimBlocked = false;

  async query<T extends Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<T[]> {
    const p = params ?? [];
    if (/^\s*INSERT INTO crm_outbox/i.test(sql)) {
      const id = `row-${this.nextId++}`;
      this.rows.push({
        id,
        event_type: String(p[0]),
        payload: JSON.parse(String(p[1])),
        status: "pending",
        attempts: 0,
        last_error: null,
        twenty_person_id: null,
        twenty_note_id: null,
        created_at: Date.now(),
        processed_at: null,
      });
      return [{ id }] as unknown as T[];
    }
    if (/^\s*UPDATE crm_outbox\s+SET status = 'in_flight'/i.test(sql)) {
      if (this.claimBlocked) return [] as T[];
      const limit = Number(p[0] ?? 50);
      const candidates = this.rows
        .filter((r) => r.status === "pending" && r.attempts < 6)
        .slice(0, limit);
      for (const row of candidates) {
        row.status = "in_flight";
        row.attempts += 1;
      }
      return candidates.map((r) => ({
        id: r.id,
        event_type: r.event_type,
        payload: r.payload,
        attempts: r.attempts,
        twenty_person_id: r.twenty_person_id,
        twenty_note_id: r.twenty_note_id,
      })) as unknown as T[];
    }
    if (/SET twenty_person_id = \$1/i.test(sql)) {
      const row = this.rows.find((r) => r.id === p[1]);
      if (row) row.twenty_person_id = String(p[0]);
      return [] as T[];
    }
    if (/SET twenty_note_id = \$1/i.test(sql)) {
      const row = this.rows.find((r) => r.id === p[1]);
      if (row) row.twenty_note_id = String(p[0]);
      return [] as T[];
    }
    if (/SET status = 'done'/i.test(sql)) {
      const row = this.rows.find((r) => r.id === p[0]);
      if (row) {
        row.status = "done";
        row.processed_at = Date.now();
        row.last_error = null;
      }
      return [] as T[];
    }
    if (/SET status = 'pending', last_error = \$1/i.test(sql)) {
      const row = this.rows.find((r) => r.id === p[1]);
      if (row) {
        row.status = "pending";
        row.last_error = String(p[0]);
      }
      return [] as T[];
    }
    if (/SET status = 'dead'/i.test(sql)) {
      const row = this.rows.find((r) => r.id === p[1]);
      if (row) {
        row.status = "dead";
        row.processed_at = Date.now();
        row.last_error = String(p[0]);
      }
      return [] as T[];
    }
    if (/UPDATE crm_outbox SET status = 'pending'\s+WHERE status = 'in_flight'/i.test(sql)) {
      const affected = this.rows.filter((r) => r.status === "in_flight");
      for (const row of affected) row.status = "pending";
      return affected.map((r) => ({ id: r.id })) as unknown as T[];
    }
    throw new Error(`Unrecognized SQL in FakeOutboxDB: ${sql.slice(0, 80)}…`);
  }
}

// ─────────────────────────────────────────────────────────────────────

let db: FakeOutboxDB;

beforeEach(() => {
  db = new FakeOutboxDB();
});

describe("enqueue", () => {
  test("inserts a pending row and returns its id", async () => {
    const id = await enqueue(db, {
      eventType: "demo",
      payload: { source: "demo", email: "a@b.test" },
    });
    expect(id).toBe("row-1");
    expect(db.rows[0]).toMatchObject({
      id: "row-1",
      event_type: "demo",
      status: "pending",
      attempts: 0,
      twenty_person_id: null,
      twenty_note_id: null,
    });
  });
});

describe("flushBatch — claim & dispatch", () => {
  test("dispatches OK → row marked done with twenty_person_id persisted inside dispatcher", async () => {
    await enqueue(db, { eventType: "demo", payload: { source: "demo", email: "x@y.test" } });

    const dispatcher: OutboxDispatcher = async (row, persist) => {
      expect(row.twentyPersonId).toBeNull();
      await persist.setTwentyPersonId("person-1");
      return { kind: "ok" };
    };

    const result = await flushBatch(db, dispatcher, 10);
    expect(result).toMatchObject({ claimed: 1, ok: 1, transient: 0, permanent: 0 });
    expect(db.rows[0].status).toBe("done");
    expect(db.rows[0].twenty_person_id).toBe("person-1");
  });

  test("transient failure → row reverts to pending with last_error stamped", async () => {
    await enqueue(db, { eventType: "demo", payload: { source: "demo", email: "fail@y.test" } });
    const dispatcher: OutboxDispatcher = async () => ({
      kind: "transient",
      message: "upstream 503",
    });
    const result = await flushBatch(db, dispatcher, 10);
    expect(result).toMatchObject({ claimed: 1, ok: 0, transient: 1 });
    expect(db.rows[0].status).toBe("pending");
    expect(db.rows[0].attempts).toBe(1);
    expect(db.rows[0].last_error).toContain("503");
  });

  test("permanent failure → row immediately dead with last_error", async () => {
    await enqueue(db, { eventType: "demo", payload: { source: "demo", email: "dead@y.test" } });
    const dispatcher: OutboxDispatcher = async () => ({
      kind: "permanent",
      message: "401 Unauthorized",
    });
    const result = await flushBatch(db, dispatcher, 10);
    expect(result).toMatchObject({ claimed: 1, permanent: 1 });
    expect(db.rows[0].status).toBe("dead");
  });

  test("dispatcher that throws is treated as transient, NOT dead", async () => {
    await enqueue(db, { eventType: "demo", payload: { source: "demo", email: "throw@y.test" } });
    const dispatcher: OutboxDispatcher = async () => {
      throw new Error("dispatcher bug");
    };
    const result = await flushBatch(db, dispatcher, 10);
    expect(result).toMatchObject({ claimed: 1, transient: 1 });
    expect(db.rows[0].status).toBe("pending");
    expect(db.rows[0].last_error).toContain("dispatcher bug");
  });
});

// ── Sub-step idempotency — the load-bearing AC for #2729 ─────────────

describe("sub-step idempotency", () => {
  test("row with twenty_person_id already set goes straight to done (no upstream call)", async () => {
    // Simulate the partial-success crash recovery path: a previous
    // attempt called upsertPerson and persisted the ID before the
    // process died. The next flush MUST NOT call upsertPerson again.
    await enqueue(db, { eventType: "demo", payload: { source: "demo", email: "replay@y.test" } });
    db.rows[0].twenty_person_id = "person_already_done";

    let upsertCalls = 0;
    const dispatcher: OutboxDispatcher = async (row, persist) => {
      if (!row.twentyPersonId) {
        upsertCalls++;
        await persist.setTwentyPersonId("would-be-duplicate");
      }
      return { kind: "ok" };
    };

    await flushBatch(db, dispatcher, 10);
    expect(upsertCalls).toBe(0);
    expect(db.rows[0].twenty_person_id).toBe("person_already_done");
    expect(db.rows[0].status).toBe("done");
  });

  test("upsertPerson called exactly once across retries when twenty_person_id is set", async () => {
    await enqueue(db, { eventType: "demo", payload: { source: "demo", email: "once@y.test" } });

    let upsertCalls = 0;
    const dispatcher: OutboxDispatcher = async (row, persist) => {
      if (!row.twentyPersonId) {
        upsertCalls++;
        await persist.setTwentyPersonId(`person-${upsertCalls}`);
      }
      // First attempt "crashes" AFTER persisting the person id: return
      // transient so the row goes back to pending. Second attempt sees
      // the persisted id, skips upsertPerson, and completes.
      if (row.attempts === 1) {
        return { kind: "transient", message: "crashed after upsertPerson" };
      }
      return { kind: "ok" };
    };

    // Round 1: claim → attempts=1. upsertPerson runs, persists, then returns transient.
    await flushBatch(db, dispatcher, 10);
    expect(db.rows[0].twenty_person_id).toBe("person-1");
    expect(db.rows[0].status as string).toBe("pending");
    expect(db.rows[0].attempts).toBe(1);

    // Round 2: claim → attempts=2. Dispatcher sees the persisted id
    // and short-circuits — upsertPerson is NOT called again. Row done.
    await flushBatch(db, dispatcher, 10);
    expect(upsertCalls).toBe(1);
    expect(db.rows[0].status as string).toBe("done");
    expect(db.rows[0].twenty_person_id).toBe("person-1");
  });
});

// ── Retry budget ─────────────────────────────────────────────────────

describe("retry budget exhaustion", () => {
  test("transient failure on the 6th attempt is dead-lettered", async () => {
    await enqueue(db, { eventType: "demo", payload: { source: "demo", email: "budget@y.test" } });
    // Simulate 5 prior failed attempts so the next claim bumps attempts → 6.
    db.rows[0].attempts = 5;

    const dispatcher: OutboxDispatcher = async () => ({
      kind: "transient",
      message: "still failing",
    });

    const result = await flushBatch(db, dispatcher, 10);
    expect(result).toMatchObject({ claimed: 1, permanent: 1 });
    expect(db.rows[0].status as string).toBe("dead");
    expect(db.rows[0].attempts).toBe(6);
    // The dead message labels the cause as "transient failure after N attempts"
    // so an operator scanning crm_outbox can distinguish budget-exhaustion
    // from a 4xx dead-letter.
    expect(db.rows[0].last_error).toContain(`transient failure after 6 attempts`);
  });

  test("rows already at the dead threshold are not claimed at all", async () => {
    await enqueue(db, { eventType: "demo", payload: { source: "demo", email: "skip@y.test" } });
    // attempts=6 means the WHERE filter excludes the row.
    db.rows[0].attempts = 6;

    let calls = 0;
    const dispatcher: OutboxDispatcher = async () => {
      calls++;
      return { kind: "ok" };
    };

    const result = await flushBatch(db, dispatcher, 10);
    expect(result.claimed).toBe(0);
    expect(calls).toBe(0);
  });
});

// ── Concurrency ──────────────────────────────────────────────────────

describe("concurrent flush behaviour", () => {
  test("blocked claim returns 0 rows and the dispatcher is never called", async () => {
    await enqueue(db, { eventType: "demo", payload: { source: "demo", email: "blocked@y.test" } });
    db.claimBlocked = true;

    let calls = 0;
    const dispatcher: OutboxDispatcher = async () => {
      calls++;
      return { kind: "ok" };
    };

    const result = await flushBatch(db, dispatcher, 10);
    expect(result.claimed).toBe(0);
    expect(calls).toBe(0);
    // Row still pending and unclaimed.
    expect(db.rows[0].status).toBe("pending");
    expect(db.rows[0].attempts).toBe(0);
  });

  test("batchLimit=0 is a no-op without touching the DB", async () => {
    await enqueue(db, { eventType: "demo", payload: { source: "demo", email: "x@y.test" } });
    let calls = 0;
    const dispatcher: OutboxDispatcher = async () => {
      calls++;
      return { kind: "ok" };
    };
    const result = await flushBatch(db, dispatcher, 0);
    expect(result).toEqual({ claimed: 0, ok: 0, transient: 0, permanent: 0 });
    expect(calls).toBe(0);
  });
});

// ── Startup recovery ─────────────────────────────────────────────────

describe("recoverInFlight", () => {
  test("resets every in_flight row to pending and returns the count", async () => {
    await enqueue(db, { eventType: "demo", payload: { source: "demo", email: "a@y.test" } });
    await enqueue(db, { eventType: "demo", payload: { source: "demo", email: "b@y.test" } });
    db.rows[0].status = "in_flight";
    db.rows[1].status = "in_flight";

    const n = await recoverInFlight(db);
    expect(n).toBe(2);
    // Cast to widen the literal type — the prior `= "in_flight"`
    // assignments narrow TS's view of `status`, and the mutation
    // inside `recoverInFlight` is invisible to it.
    expect(db.rows[0].status as string).toBe("pending");
    expect(db.rows[1].status as string).toBe("pending");
  });

  test("done / dead / pending rows are untouched", async () => {
    await enqueue(db, { eventType: "demo", payload: { source: "demo", email: "p@y.test" } });
    await enqueue(db, { eventType: "demo", payload: { source: "demo", email: "d@y.test" } });
    await enqueue(db, { eventType: "demo", payload: { source: "demo", email: "x@y.test" } });
    db.rows[1].status = "done";
    db.rows[2].status = "dead";

    const n = await recoverInFlight(db);
    expect(n).toBe(0);
    expect(db.rows[0].status).toBe("pending");
    expect(db.rows[1].status).toBe("done");
    expect(db.rows[2].status).toBe("dead");
  });
});

// ── Helpers contract — make sure persist callbacks are bound per row ─

describe("persist helper binding", () => {
  test("setTwentyPersonId / setTwentyNoteId write the correct row id", async () => {
    await enqueue(db, { eventType: "demo", payload: { source: "demo", email: "a@y.test" } });
    await enqueue(db, { eventType: "demo", payload: { source: "demo", email: "b@y.test" } });

    let nthCall = 0;
    const dispatcher: OutboxDispatcher = async (
      row: ClaimedOutboxRow,
      persist: OutboxPersistHelpers,
    ): Promise<DispatchOutcome> => {
      nthCall++;
      await persist.setTwentyPersonId(`person-${nthCall}`);
      await persist.setTwentyNoteId(`note-${nthCall}`);
      return { kind: "ok" };
    };

    await flushBatch(db, dispatcher, 10);
    // Order matters: rows are claimed in ORDER BY created_at, which in
    // our fake matches insertion order. row-1 → person-1, row-2 → person-2.
    expect(db.rows[0].twenty_person_id).toBe("person-1");
    expect(db.rows[0].twenty_note_id).toBe("note-1");
    expect(db.rows[1].twenty_person_id).toBe("person-2");
    expect(db.rows[1].twenty_note_id).toBe("note-2");
  });
});
