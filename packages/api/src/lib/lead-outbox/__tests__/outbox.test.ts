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

import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── Logger mock MUST be installed before importing outbox.ts so the
//    module-level `createLogger` call in outbox.ts captures our stub.
//    Per CLAUDE.md the lead-outbox/__tests__/ directory is allowed to
//    use `mock.module()` for this kind of module-scoped substitution.
const loggerCalls: {
  warn: Array<{ data: Record<string, unknown>; message: string }>;
  error: Array<{ data: Record<string, unknown>; message: string }>;
} = { warn: [], error: [] };

mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    info: () => {},
    debug: () => {},
    warn: (data: Record<string, unknown>, message: string) => {
      loggerCalls.warn.push({ data, message });
    },
    error: (data: Record<string, unknown>, message: string) => {
      loggerCalls.error.push({ data, message });
    },
  }),
}));

const {
  computeRetryAfterTimestamp,
  enqueue,
  flushBatch,
  isFlusherEnabled,
  recoverInFlight,
} = await import("../outbox");
type ClaimedOutboxRow = import("../outbox").ClaimedOutboxRow;
type DispatchOutcome = import("../outbox").DispatchOutcome;
type OutboxDB = import("../outbox").OutboxDB;
type OutboxDispatcher = import("../outbox").OutboxDispatcher;
type OutboxPersistHelpers = import("../outbox").OutboxPersistHelpers;

type Row = {
  id: string;
  event_type: string;
  payload: unknown;
  status: "pending" | "in_flight" | "done" | "dead";
  attempts: number;
  last_error: string | null;
  twenty_person_id: string | null;
  twenty_note_id: string | null;
  retry_after: number | null;
  claimed_at: number | null;
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
        retry_after: null,
        claimed_at: null,
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
        row.claimed_at = Date.now();
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
    if (/^\s*UPDATE crm_outbox\s+SET status = 'done'/is.test(sql)) {
      const row = this.rows.find((r) => r.id === p[0]);
      if (row) {
        row.status = "done";
        row.processed_at = Date.now();
        row.last_error = null;
        row.retry_after = null;
        row.claimed_at = null;
      }
      return [] as T[];
    }
    if (/SET status = 'pending',\s+last_error = \$1/is.test(sql)) {
      const row = this.rows.find((r) => r.id === p[1]);
      if (row) {
        row.status = "pending";
        row.last_error = String(p[0]);
        // $3 is the retry_after timestamp (Date | null).
        const retryAfter = p[2];
        row.retry_after = retryAfter instanceof Date ? retryAfter.getTime() : null;
        row.claimed_at = null;
      }
      return [] as T[];
    }
    // MARK_DEAD_SQL — distinct from the recovery dead-letter UPDATE
    // (which carries the WHERE status='in_flight' AND attempts >= ...
    // signature handled earlier).
    if (/^\s*UPDATE crm_outbox\s+SET status = 'dead'/is.test(sql) && p.length >= 2) {
      const row = this.rows.find((r) => r.id === p[1]);
      if (row) {
        row.status = "dead";
        row.processed_at = Date.now();
        row.last_error = String(p[0]);
        row.retry_after = null;
        row.claimed_at = null;
      }
      return [] as T[];
    }
    // Recovery: dead-letter exhausted in_flight rows.
    if (
      /UPDATE crm_outbox[\s\S]+SET status = 'dead'[\s\S]+WHERE status = 'in_flight'[\s\S]+AND attempts >=/is.test(
        sql,
      )
    ) {
      const exhausted = this.rows.filter(
        (r) => r.status === "in_flight" && r.attempts >= 6,
      );
      for (const row of exhausted) {
        row.status = "dead";
        row.processed_at = Date.now();
        row.last_error = `crashed mid-dispatch at attempts=${row.attempts} (recovery)`;
      }
      return exhausted.map((r) => ({ id: r.id })) as unknown as T[];
    }
    // Recovery: reset stale in_flight rows below the attempts cap.
    if (
      /UPDATE crm_outbox\s+SET status = 'pending'\s+WHERE status = 'in_flight'[\s\S]+AND attempts </is.test(
        sql,
      )
    ) {
      // $1 is the stale-age threshold in ms; treat NULL claimed_at as
      // stale, otherwise compare against now() - threshold.
      const staleAgeMs = Number(p[0] ?? 0);
      const cutoff = Date.now() - staleAgeMs;
      const stale = this.rows.filter(
        (r) =>
          r.status === "in_flight" &&
          r.attempts < 6 &&
          (r.claimed_at === null || r.claimed_at < cutoff),
      );
      for (const row of stale) row.status = "pending";
      return stale.map((r) => ({ id: r.id })) as unknown as T[];
    }
    throw new Error(`Unrecognized SQL in FakeOutboxDB: ${sql.slice(0, 80)}…`);
  }
}

// ─────────────────────────────────────────────────────────────────────

let db: FakeOutboxDB;

beforeEach(() => {
  db = new FakeOutboxDB();
  loggerCalls.warn.length = 0;
  loggerCalls.error.length = 0;
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
  test("resets stale in_flight rows to pending and returns the per-bucket counts", async () => {
    await enqueue(db, { eventType: "demo", payload: { source: "demo", email: "a@y.test" } });
    await enqueue(db, { eventType: "demo", payload: { source: "demo", email: "b@y.test" } });
    db.rows[0].status = "in_flight";
    db.rows[0].claimed_at = null; // null claimed_at counts as stale
    db.rows[1].status = "in_flight";
    db.rows[1].claimed_at = Date.now() - 60_000; // claimed 60s ago — stale at 30s threshold

    const result = await recoverInFlight(db, 30_000);
    expect(result).toEqual({ reset: 2, deadLettered: 0 });
    expect(db.rows[0].status as string).toBe("pending");
    expect(db.rows[1].status as string).toBe("pending");
  });

  test("recently-claimed in_flight row is NOT reset (multi-pod safety)", async () => {
    await enqueue(db, { eventType: "demo", payload: { source: "demo", email: "fresh@y.test" } });
    db.rows[0].status = "in_flight";
    db.rows[0].claimed_at = Date.now() - 1_000; // claimed 1s ago — within threshold

    const result = await recoverInFlight(db, 30_000);
    expect(result).toEqual({ reset: 0, deadLettered: 0 });
    expect(db.rows[0].status as string).toBe("in_flight");
  });

  test("exhausted in_flight rows are dead-lettered (not reset to pending)", async () => {
    await enqueue(db, { eventType: "demo", payload: { source: "demo", email: "exhausted@y.test" } });
    db.rows[0].status = "in_flight";
    db.rows[0].attempts = 6;
    db.rows[0].claimed_at = Date.now() - 60_000;

    const result = await recoverInFlight(db, 30_000);
    expect(result).toEqual({ reset: 0, deadLettered: 1 });
    expect(db.rows[0].status as string).toBe("dead");
    expect(db.rows[0].last_error).toContain("crashed mid-dispatch");
  });

  test("done / dead / pending rows are untouched", async () => {
    await enqueue(db, { eventType: "demo", payload: { source: "demo", email: "p@y.test" } });
    await enqueue(db, { eventType: "demo", payload: { source: "demo", email: "d@y.test" } });
    await enqueue(db, { eventType: "demo", payload: { source: "demo", email: "x@y.test" } });
    db.rows[1].status = "done";
    db.rows[2].status = "dead";

    const result = await recoverInFlight(db, 30_000);
    expect(result).toEqual({ reset: 0, deadLettered: 0 });
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

// ── Retry-After plumbing ─────────────────────────────────────────────

describe("Retry-After plumbing", () => {
  test("transient outcome with retryAfterMs stamps absolute retry_after on the row", async () => {
    await enqueue(db, { eventType: "demo", payload: { source: "demo", email: "rate@y.test" } });
    const before = Date.now();
    const dispatcher: OutboxDispatcher = async () => ({
      kind: "transient",
      message: "429 from upstream",
      retryAfterMs: 60_000,
    });

    await flushBatch(db, dispatcher, 10);
    expect(db.rows[0].status).toBe("pending");
    expect(db.rows[0].retry_after).not.toBeNull();
    // Should be ~now + 60s. Allow a wide tolerance for slow CI.
    const stamped = db.rows[0].retry_after as number;
    expect(stamped - before).toBeGreaterThanOrEqual(60_000 - 500);
    expect(stamped - before).toBeLessThanOrEqual(60_000 + 5_000);
  });

  test("transient outcome without retryAfterMs clears any prior retry_after", async () => {
    await enqueue(db, { eventType: "demo", payload: { source: "demo", email: "clr@y.test" } });
    db.rows[0].retry_after = Date.now() + 30_000;

    const dispatcher: OutboxDispatcher = async () => ({
      kind: "transient",
      message: "no header this time",
    });

    await flushBatch(db, dispatcher, 10);
    expect(db.rows[0].retry_after).toBeNull();
  });

  test("computeRetryAfterTimestamp clamps garbage to null", () => {
    expect(computeRetryAfterTimestamp(undefined)).toBeNull();
    expect(computeRetryAfterTimestamp(-5)).toBeNull();
    expect(computeRetryAfterTimestamp(NaN)).toBeNull();
  });

  test("computeRetryAfterTimestamp returns absolute time for valid delay", () => {
    const before = Date.now();
    const stamped = computeRetryAfterTimestamp(120_000);
    expect(stamped).not.toBeNull();
    if (stamped) {
      expect(stamped.getTime() - before).toBeGreaterThanOrEqual(120_000 - 100);
      expect(stamped.getTime() - before).toBeLessThanOrEqual(120_000 + 1_000);
    }
  });
});

// ── AC #3 — structured log on dead-letter ────────────────────────────

describe("dead-letter logging (AC #3)", () => {
  test("permanent dead-letter emits a structured log with rowId + last_error", async () => {
    await enqueue(db, { eventType: "demo", payload: { source: "demo", email: "dead-log@y.test" } });
    const dispatcher: OutboxDispatcher = async () => ({
      kind: "permanent",
      message: "401 unauthorised",
    });
    await flushBatch(db, dispatcher, 10);

    const deadCall = loggerCalls.error.find(
      (c) => c.data.event === "lead_outbox.dead_letter_permanent",
    );
    expect(deadCall).toBeDefined();
    expect(deadCall?.data.rowId).toBe("row-1");
    expect(deadCall?.data.err).toContain("401");
    expect(deadCall?.data.attempts).toBe(1);
  });

  test("retry-budget exhaustion emits a structured log labelled dead_letter_exhausted", async () => {
    await enqueue(db, { eventType: "demo", payload: { source: "demo", email: "budget@y.test" } });
    db.rows[0].attempts = 5;
    const dispatcher: OutboxDispatcher = async () => ({
      kind: "transient",
      message: "503",
    });
    await flushBatch(db, dispatcher, 10);

    const deadCall = loggerCalls.error.find(
      (c) => c.data.event === "lead_outbox.dead_letter_exhausted",
    );
    expect(deadCall).toBeDefined();
    expect(deadCall?.data.rowId).toBe("row-1");
    expect(deadCall?.data.attempts).toBe(6);
  });

  test("transient (within budget) emits warn with retryAfterMs surfaced", async () => {
    await enqueue(db, { eventType: "demo", payload: { source: "demo", email: "tr@y.test" } });
    const dispatcher: OutboxDispatcher = async () => ({
      kind: "transient",
      message: "503",
      retryAfterMs: 45_000,
    });
    await flushBatch(db, dispatcher, 10);

    const warnCall = loggerCalls.warn.find(
      (c) => c.data.event === "lead_outbox.transient_failure",
    );
    expect(warnCall).toBeDefined();
    expect(warnCall?.data.rowId).toBe("row-1");
    expect(warnCall?.data.retryAfterMs).toBe(45_000);
  });
});

// ── AC #7 — end-to-end restart safety ────────────────────────────────

describe("end-to-end restart (AC #7)", () => {
  test("in_flight row recovered + claimed + dispatched in one logical lifecycle", async () => {
    // Simulate the crash scenario: a previous pod claimed the row and
    // crashed before reaching MARK_DONE. recoverInFlight on the new
    // pod's boot must flip it to pending; the very next flushBatch
    // must then claim and complete it.
    await enqueue(db, { eventType: "demo", payload: { source: "demo", email: "e2e@y.test" } });
    db.rows[0].status = "in_flight";
    db.rows[0].attempts = 1;
    db.rows[0].twenty_person_id = "person-from-previous-life";
    db.rows[0].claimed_at = null; // simulate stale carcass

    // Boot recovery — equivalent to the startup-recovery branch in
    // layers.ts:makeSchedulerLive. Use a 0s threshold so a fresh
    // `claimed_at = null` row qualifies as stale immediately.
    const recovered = await recoverInFlight(db, 0);
    expect(recovered).toEqual({ reset: 1, deadLettered: 0 });
    expect(db.rows[0].status as string).toBe("pending");

    // First post-recovery tick: the dispatcher sees the persisted
    // person_id and short-circuits to done WITHOUT calling Twenty.
    let dispatcherFetches = 0;
    const dispatcher: OutboxDispatcher = async (row) => {
      if (!row.twentyPersonId) {
        dispatcherFetches++;
      }
      return { kind: "ok" };
    };
    await flushBatch(db, dispatcher, 10);
    expect(dispatcherFetches).toBe(0);
    expect(db.rows[0].status as string).toBe("done");
  });
});

// ── L1 — final-status UPDATE resilience (single retry) ───────────────

describe("terminal-status UPDATE retry", () => {
  test("MARK_DONE_SQL retries once after a transient pg failure, then succeeds", async () => {
    // Wrap the FakeOutboxDB to fail the first MARK_DONE call and let
    // the second through.
    await enqueue(db, { eventType: "demo", payload: { source: "demo", email: "ok@y.test" } });
    let firstMarkDoneSeen = false;
    const wrappedDb: OutboxDB = {
      query: async <T extends Record<string, unknown>>(
        sql: string,
        params?: unknown[],
      ): Promise<T[]> => {
        if (!firstMarkDoneSeen && /SET status = 'done'/i.test(sql)) {
          firstMarkDoneSeen = true;
          throw new Error("pg blip");
        }
        return db.query<T>(sql, params);
      },
    };

    const dispatcher: OutboxDispatcher = async () => ({ kind: "ok" });
    const result = await flushBatch(wrappedDb, dispatcher, 10);
    expect(result.ok).toBe(1);
    expect(db.rows[0].status).toBe("done");
  });
});

describe("isFlusherEnabled — region gate", () => {
  const KEY = "ATLAS_CRM_OUTBOX_FLUSHER_ENABLED";

  // Snapshot + restore the env around each case so the test order
  // doesn't matter (the broader bun-test isolation also resets vars
  // between files, but within-file we set/clear explicitly).
  let original: string | undefined;
  beforeEach(() => {
    original = process.env[KEY];
    delete process.env[KEY];
  });
  // Use a per-test cleanup rather than afterEach so a failure mid-test
  // still restores the env for the rest of this describe.
  const restore = () => {
    if (original === undefined) delete process.env[KEY];
    else process.env[KEY] = original;
  };

  test("default (env unset) is enabled — preserves pre-gate behavior", () => {
    expect(isFlusherEnabled()).toBe(true);
    restore();
  });

  test("recognized falsey strings disable", () => {
    for (const v of ["false", "FALSE", "False", "0", "no", "NO", "off", " false "]) {
      process.env[KEY] = v;
      expect(isFlusherEnabled()).toBe(false);
    }
    restore();
  });

  test("recognized truthy strings keep enabled", () => {
    for (const v of ["true", "TRUE", "True", "1", "yes", "on"]) {
      process.env[KEY] = v;
      expect(isFlusherEnabled()).toBe(true);
    }
    restore();
  });

  test("unrecognized values default-true (avoid silent disable on typos)", () => {
    // An operator who types "disable" or "off-by-default" should NOT
    // accidentally silence the flusher — the env semantic is opt-out,
    // and only the explicit affordances above flip it off.
    for (const v of ["disable", "0.0", "", "  ", "false-ish"]) {
      process.env[KEY] = v;
      expect(isFlusherEnabled()).toBe(true);
    }
    restore();
  });
});

