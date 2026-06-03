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
  computeRetryDelayMs,
  getBackstopSweepIntervalMs,
  enqueue,
  flushBatch,
  isFlusherEnabled,
  recoverInFlight,
} = await import("../outbox");
const { FlusherSignal, setActiveFlusherSignal } = await import("../signal");
type OutboxRetryScheduler = import("../outbox").OutboxRetryScheduler;
type ClaimedOutboxRow = import("../outbox").ClaimedOutboxRow;
type DispatchOutcome = import("../outbox").DispatchOutcome;
type OutboxDB = import("../outbox").OutboxDB;
type OutboxDispatcher = import("../outbox").OutboxDispatcher;
type OutboxPersistHelpers = import("../outbox").OutboxPersistHelpers;

type Row = {
  id: string;
  event_type: string;
  payload: unknown;
  email_key: string | null;
  workspace_id: string;
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

/**
 * Default workspace_id stamped on test fixtures via the {@link enq}
 * helper below (#2849). Most tests in this file exercise outbox
 * lifecycle behaviour (claim ordering, retry, sub-step idempotency)
 * and don't care which workspace owns the row — the helper threads
 * this constant into `enqueue` so tests stay terse. Tests that
 * specifically exercise per-tenant routing branch on a different
 * `workspaceId`.
 */
const TEST_WORKSPACE_ID = "ws-test";

/**
 * Thin wrapper around `enqueue` that defaults `workspaceId` to
 * `TEST_WORKSPACE_ID`. Use the unwrapped `enqueue` directly when the
 * test needs to assert behaviour for an empty or per-tenant workspace
 * id.
 */
async function enq(
  db: OutboxDB,
  args: { eventType: string; payload: Record<string, unknown>; workspaceId?: string },
): Promise<string> {
  return enqueue(db, {
    eventType: args.eventType,
    payload: args.payload,
    workspaceId: args.workspaceId ?? TEST_WORKSPACE_ID,
  });
}

class FakeOutboxDB implements OutboxDB {
  rows: Row[] = [];
  private nextId = 1;
  /** Monotonic clock for `created_at` — see `clockTick`. */
  private clock = 0;
  /** When true, every claim returns 0 rows (simulates contention). */
  claimBlocked = false;

  /**
   * Strictly-monotonic timestamp for `created_at`. The previous
   * implementation used `Date.now()`, which ticks at ms resolution and
   * tied for back-to-back enqueues — non-deterministic `ORDER BY
   * created_at` then masked claim-ordering regressions in tests. The
   * monotonic counter is the test-side analogue of Postgres' `now()`
   * statement-start microsecond clock.
   */
  private clockTick(): number {
    this.clock += 1;
    return this.clock;
  }

  async query<T extends Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<T[]> {
    const p = params ?? [];
    if (/^\s*INSERT INTO crm_outbox/i.test(sql)) {
      const id = `row-${this.nextId++}`;
      // 0104 added email_key as a 3rd positional parameter; older
      // callers that haven't been updated pass `undefined` and fall
      // through to NULL — matching the SQL column's nullability.
      const emailKey = typeof p[2] === "string" ? p[2] : null;
      // 0106 added workspace_id as a 4th positional parameter. Required
      // at the application layer (`enqueue` throws on empty) — the
      // fake mirrors that by stamping whatever the caller passed; the
      // helper above defaults to `TEST_WORKSPACE_ID`.
      const workspaceId = typeof p[3] === "string" ? p[3] : "";
      this.rows.push({
        id,
        event_type: String(p[0]),
        payload: JSON.parse(String(p[1])),
        email_key: emailKey,
        workspace_id: workspaceId,
        status: "pending",
        attempts: 0,
        last_error: null,
        twenty_person_id: null,
        twenty_note_id: null,
        retry_after: null,
        claimed_at: null,
        // `created_at` resolution: increment a monotonic counter so
        // back-to-back enqueues in a single test step still get
        // distinct, ordered timestamps. `Date.now()` ticks at ms
        // resolution and the unit tests fire enqueues faster than
        // that, which made `ORDER BY created_at` non-deterministic.
        created_at: this.clockTick(),
        processed_at: null,
      });
      return [{ id }] as unknown as T[];
    }
    if (/^\s*UPDATE crm_outbox\s+SET status = 'in_flight'/i.test(sql)) {
      if (this.claimBlocked) return [] as T[];
      const limit = Number(p[0] ?? 50);
      // Mirror CLAIM_SQL (0104 + #2872 follow-ups): a row is claimable
      // only if NO blocking same-email sibling exists.
      //   - Any in_flight sibling blocks regardless of age (rolling
      //     hotfix / manual recovery state where a newer row is
      //     already in_flight).
      //   - Any pending sibling that is strictly older by
      //     (created_at, id) blocks — closes both the retry-cooldown
      //     leapfrog (older row in backoff still gates the newer one)
      //     AND the same-`created_at` bulk-INSERT tie-break (two rows
      //     sharing a timestamp must still serialize).
      //   - NULL email_key rows skip the gate; each is its own dedup
      //     group via COALESCE(email_key, id::text).
      const hasBlockingSibling = (r: Row): boolean => {
        if (r.email_key == null) return false;
        return this.rows.some((o) => {
          if (o.id === r.id) return false;
          if (o.email_key !== r.email_key) return false;
          if (o.status === "in_flight") return true;
          if (o.status === "pending") {
            // (o.created_at, o.id) < (r.created_at, r.id) — row-wise.
            return (
              o.created_at < r.created_at ||
              (o.created_at === r.created_at && o.id < r.id)
            );
          }
          return false;
        });
      };
      const candidates = this.rows
        .filter(
          (r) =>
            r.status === "pending" &&
            r.attempts < 6 &&
            !hasBlockingSibling(r),
        )
        .sort((a, b) => a.created_at - b.created_at);
      const seenDedupKeys = new Set<string>();
      const deduped: Row[] = [];
      for (const row of candidates) {
        const key = row.email_key ?? row.id;
        if (seenDedupKeys.has(key)) continue;
        seenDedupKeys.add(key);
        deduped.push(row);
      }
      const claimed = deduped.slice(0, limit);
      for (const row of claimed) {
        row.status = "in_flight";
        row.attempts += 1;
        row.claimed_at = Date.now();
      }
      return claimed.map((r) => ({
        id: r.id,
        event_type: r.event_type,
        payload: r.payload,
        attempts: r.attempts,
        workspace_id: r.workspace_id,
        // `created_at` added to CLAIM RETURNING in #2874 so a transient
        // failure can schedule its retry timer at the tier due-time.
        created_at: r.created_at,
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
  // No flusher doorbell registered by default — `enqueue`'s inline kick
  // is then a no-op, matching a process with no mounted flusher (#2874).
  setActiveFlusherSignal(null);
});

describe("enqueue", () => {
  test("inserts a pending row and returns its id", async () => {
    const id = await enq(db, {
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
      workspace_id: TEST_WORKSPACE_ID,
    });
  });

  test("stamps workspace_id on every row (#2849)", async () => {
    // AC: rows MUST carry a non-empty workspace_id at enqueue time so
    // the dispatcher's per-row routing key is deterministic. The
    // helper passes TEST_WORKSPACE_ID; an explicit override on
    // `enq` (here for a hypothetical per-tenant install) lands a
    // distinct value.
    await enq(db, {
      eventType: "demo",
      payload: { source: "demo", email: "operator@demo.test" },
    });
    await enq(db, {
      eventType: "demo",
      payload: { source: "demo", email: "tenant@demo.test" },
      workspaceId: "ws-tenant-A",
    });
    expect(db.rows[0].workspace_id).toBe(TEST_WORKSPACE_ID);
    expect(db.rows[1].workspace_id).toBe("ws-tenant-A");
  });

  test("captures workspace_id for all four operator event sources (#2849 AC)", async () => {
    // The AC calls out demo / signup / sales-form / conversion as the
    // four event sources whose enqueue path must capture workspace_id.
    // All four currently route to Atlas's operator pipeline, so they
    // share TEST_WORKSPACE_ID — but the column being present is the
    // load-bearing invariant (a future per-tenant variant lands here
    // with a different value without a schema change).
    await enq(db, {
      eventType: "demo",
      payload: { source: "demo", email: "demo@event.test" },
    });
    await enq(db, {
      eventType: "signup",
      payload: { source: "signup", email: "signup@event.test", name: "Sam" },
    });
    await enq(db, {
      eventType: "sales-form",
      payload: {
        source: "sales-form",
        email: "sales@event.test",
        name: "Sales Form",
        company: "Co",
        planInterest: "team",
        message: "msg",
      },
    });
    await enq(db, {
      eventType: "stamp-conversion",
      payload: {
        source: "conversion",
        email: "convert@event.test",
        stripeCustomerId: "cus_x",
      },
    });
    expect(db.rows).toHaveLength(4);
    for (const row of db.rows) {
      expect(row.workspace_id).toBe(TEST_WORKSPACE_ID);
    }
  });

  test("rejects an empty workspaceId at the seam (#2849)", async () => {
    await expect(
      enqueue(db, {
        eventType: "demo",
        payload: { source: "demo", email: "x@empty.test" },
        workspaceId: "",
      }),
    ).rejects.toThrow(/workspaceId must be non-empty/);
    expect(db.rows).toHaveLength(0);
  });

  test("rings the registered flusher doorbell after a successful insert (#2874)", async () => {
    const signal = new FlusherSignal();
    setActiveFlusherSignal(signal);
    try {
      let woke = false;
      // Park a waiter; a successful enqueue must wake it via the inline
      // kick — this is the < 100ms p99 enqueue→dispatch path (AC #1).
      signal.wait(60_000, () => {
        woke = true;
      });
      await enq(db, { eventType: "demo", payload: { source: "demo", email: "kick@y.test" } });
      expect(woke).toBe(true);
    } finally {
      setActiveFlusherSignal(null);
      signal.close();
    }
  });

  test("a missing doorbell never blocks the enqueue (region-gated / self-hosted)", async () => {
    // No flusher mounted → no registered doorbell. The row must still
    // persist; the backstop sweep or next boot dispatches it.
    setActiveFlusherSignal(null);
    const id = await enq(db, {
      eventType: "demo",
      payload: { source: "demo", email: "nodoor@y.test" },
    });
    expect(id).toBe("row-1");
    expect(db.rows[0].status).toBe("pending");
  });
});

describe("flushBatch — claim & dispatch", () => {
  test("dispatches OK → row marked done with twenty_person_id persisted inside dispatcher", async () => {
    await enq(db, { eventType: "demo", payload: { source: "demo", email: "x@y.test" } });

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
    await enq(db, { eventType: "demo", payload: { source: "demo", email: "fail@y.test" } });
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
    await enq(db, { eventType: "demo", payload: { source: "demo", email: "dead@y.test" } });
    const dispatcher: OutboxDispatcher = async () => ({
      kind: "permanent",
      message: "401 Unauthorized",
    });
    const result = await flushBatch(db, dispatcher, 10);
    expect(result).toMatchObject({ claimed: 1, permanent: 1 });
    expect(db.rows[0].status).toBe("dead");
  });

  test("dispatcher that throws is treated as transient, NOT dead", async () => {
    await enq(db, { eventType: "demo", payload: { source: "demo", email: "throw@y.test" } });
    const dispatcher: OutboxDispatcher = async () => {
      throw new Error("dispatcher bug");
    };
    const result = await flushBatch(db, dispatcher, 10);
    expect(result).toMatchObject({ claimed: 1, transient: 1 });
    expect(db.rows[0].status).toBe("pending");
    expect(db.rows[0].last_error).toContain("dispatcher bug");
  });
});

describe("flushBatch — per-row retry scheduling (#2874)", () => {
  function recordingScheduler(): {
    calls: Array<{ rowId: string; delayMs: number }>;
    scheduler: OutboxRetryScheduler;
  } {
    const calls: Array<{ rowId: string; delayMs: number }> = [];
    return {
      calls,
      scheduler: { scheduleRetry: (rowId, delayMs) => calls.push({ rowId, delayMs }) },
    };
  }

  test("transient WITH Retry-After schedules the next attempt at the header delay", async () => {
    await enq(db, { eventType: "demo", payload: { source: "demo", email: "ra@y.test" } });
    const { calls, scheduler } = recordingScheduler();
    const dispatcher: OutboxDispatcher = async () => ({
      kind: "transient",
      message: "429 slow down",
      retryAfterMs: 45_000,
    });
    const result = await flushBatch(db, dispatcher, 10, scheduler);
    expect(result.transient).toBe(1);
    // AC #2: reschedule at retry_after without waiting for the backstop.
    expect(calls).toEqual([{ rowId: "row-1", delayMs: 45_000 }]);
  });

  test("transient WITHOUT Retry-After still schedules a retry (off the tier due-time)", async () => {
    await enq(db, { eventType: "demo", payload: { source: "demo", email: "tier@y.test" } });
    const { calls, scheduler } = recordingScheduler();
    const dispatcher: OutboxDispatcher = async () => ({ kind: "transient", message: "503" });
    await flushBatch(db, dispatcher, 10, scheduler);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.rowId).toBe("row-1");
    // The fake's `created_at` is a small monotonic counter (effectively
    // ancient vs. wall-clock now), so the row is already past its tier
    // due-time → fire on the next tick. The exact math is pinned in the
    // `computeRetryDelayMs` suite below.
    expect(calls[0]!.delayMs).toBe(0);
  });

  test("ok / permanent / exhausted outcomes never schedule a retry", async () => {
    const { calls, scheduler } = recordingScheduler();

    await enq(db, { eventType: "demo", payload: { source: "demo", email: "ok@y.test" } });
    await flushBatch(db, async () => ({ kind: "ok" }), 10, scheduler);
    expect(calls).toHaveLength(0);

    await enq(db, { eventType: "demo", payload: { source: "demo", email: "perm@y.test" } });
    await flushBatch(db, async () => ({ kind: "permanent", message: "400" }), 10, scheduler);
    expect(calls).toHaveLength(0);

    // Exhausted: a transient on the 6th attempt dead-letters (no retry).
    await enq(db, { eventType: "demo", payload: { source: "demo", email: "exh@y.test" } });
    db.rows[2]!.attempts = 5; // next claim bumps to 6 → dead on transient
    await flushBatch(db, async () => ({ kind: "transient", message: "still 503" }), 10, scheduler);
    expect(db.rows[2]!.status).toBe("dead");
    expect(calls).toHaveLength(0);
  });

  test("scheduler is optional — without one, transient still marks pending (backstop re-claims)", async () => {
    await enq(db, { eventType: "demo", payload: { source: "demo", email: "nosched@y.test" } });
    const result = await flushBatch(db, async () => ({ kind: "transient", message: "503" }), 10);
    expect(result.transient).toBe(1);
    expect(db.rows[0].status).toBe("pending");
  });
});

// ── Sub-step idempotency — the load-bearing AC for #2729 ─────────────

describe("sub-step idempotency", () => {
  test("row with twenty_person_id already set goes straight to done (no upstream call)", async () => {
    // Simulate the partial-success crash recovery path: a previous
    // attempt called upsertPerson and persisted the ID before the
    // process died. The next flush MUST NOT call upsertPerson again.
    await enq(db, { eventType: "demo", payload: { source: "demo", email: "replay@y.test" } });
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
    await enq(db, { eventType: "demo", payload: { source: "demo", email: "once@y.test" } });

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
    await enq(db, { eventType: "demo", payload: { source: "demo", email: "budget@y.test" } });
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
    await enq(db, { eventType: "demo", payload: { source: "demo", email: "skip@y.test" } });
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
    await enq(db, { eventType: "demo", payload: { source: "demo", email: "blocked@y.test" } });
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
    await enq(db, { eventType: "demo", payload: { source: "demo", email: "x@y.test" } });
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

// ── Per-email serialization (#2870) ───────────────────────────────────
//
// Two rows for the same email enqueued back-to-back must dispatch in
// claim order, never concurrently. Before 0104 the flusher claimed
// both same-email rows in a single batch and dispatched them sequentially
// (still risky if any concurrency lands), AND a future multi-pod deploy
// could grab them in parallel. The fix dedupes by `email_key` inside
// CLAIM_SQL so only the earliest pending row per email is claimed per
// tick — the rest wait for the claimed row to reach a terminal state.

describe("per-email serialization (#2870)", () => {
  test("gworth demo→signup pair: only the first row is claimed per tick", async () => {
    // C10 fixture from scripts/test-fixtures/crm-personas.yml. Two
    // rows for the same email, demo enqueued first, signup second.
    // Pre-fix both would be claimed in one batch; post-fix the signup
    // waits for demo to land.
    const demoId = await enq(db, {
      eventType: "demo",
      payload: { source: "demo", email: "gworth@globexcorp.com", ip: "203.0.113.30" },
    });
    const signupId = await enq(db, {
      eventType: "signup",
      payload: { source: "signup", email: "gworth@globexcorp.com", name: "Greta Worth" },
    });

    const dispatchOrder: string[] = [];
    const dispatcher: OutboxDispatcher = async (row) => {
      dispatchOrder.push((row.payload as { source: string }).source);
      return { kind: "ok" };
    };

    // Tick 1 — only the demo row is claimed; signup is still pending.
    const tick1 = await flushBatch(db, dispatcher, 50);
    expect(tick1.claimed).toBe(1);
    expect(tick1.ok).toBe(1);
    expect(dispatchOrder).toEqual(["demo"]);
    expect(db.rows.find((r) => r.id === demoId)!.status as string).toBe("done");
    expect(db.rows.find((r) => r.id === signupId)!.status as string).toBe("pending");

    // Tick 2 — demo is done, signup is now claimable.
    const tick2 = await flushBatch(db, dispatcher, 50);
    expect(tick2.claimed).toBe(1);
    expect(tick2.ok).toBe(1);
    expect(dispatchOrder).toEqual(["demo", "signup"]);
    expect(db.rows.find((r) => r.id === signupId)!.status as string).toBe("done");
  });

  test("msdyson demo→demo idempotency pair: same-source repeats serialize too", async () => {
    // B8 fixture. Two demo events for the same email with different IPs.
    // The reported bug surfaced as `atlasIp` showing the FIRST IP after
    // the smoke run, indicating the two PATCHes raced. Post-fix the
    // .41 PATCH runs in tick 2 with .40 already committed in Twenty —
    // strictly sequential, no race possible.
    const first = await enq(db, {
      eventType: "demo",
      payload: { source: "demo", email: "msdyson@cyberdynesys.com", ip: "203.0.113.40" },
    });
    const second = await enq(db, {
      eventType: "demo",
      payload: { source: "demo", email: "msdyson@cyberdynesys.com", ip: "203.0.113.41" },
    });

    const dispatchedIps: string[] = [];
    const dispatcher: OutboxDispatcher = async (row) => {
      dispatchedIps.push((row.payload as { ip: string }).ip);
      return { kind: "ok" };
    };

    const tick1 = await flushBatch(db, dispatcher, 50);
    expect(tick1.claimed).toBe(1);
    expect(dispatchedIps).toEqual(["203.0.113.40"]);
    expect(db.rows.find((r) => r.id === first)!.status as string).toBe("done");
    expect(db.rows.find((r) => r.id === second)!.status as string).toBe("pending");

    const tick2 = await flushBatch(db, dispatcher, 50);
    expect(tick2.claimed).toBe(1);
    expect(dispatchedIps).toEqual(["203.0.113.40", "203.0.113.41"]);
    expect(db.rows.find((r) => r.id === second)!.status as string).toBe("done");
  });

  test("distinct emails dispatch in the same tick (no throughput regression)", async () => {
    // Per-email serialization must NOT serialize across distinct
    // emails — a workspace with 1000 leads-per-minute should still
    // drain at the same rate as before the fix.
    await enq(db, { eventType: "demo", payload: { source: "demo", email: "a1@example.test" } });
    await enq(db, { eventType: "demo", payload: { source: "demo", email: "a2@example.test" } });
    await enq(db, { eventType: "demo", payload: { source: "demo", email: "a3@example.test" } });
    await enq(db, { eventType: "demo", payload: { source: "demo", email: "a4@example.test" } });

    const dispatcher: OutboxDispatcher = async () => ({ kind: "ok" });
    const result = await flushBatch(db, dispatcher, 50);
    expect(result.claimed).toBe(4);
    expect(result.ok).toBe(4);
  });

  test("in_flight sibling blocks subsequent claims for the same email", async () => {
    // The cross-tick / cross-pod safety case: a row already in_flight
    // (e.g. claimed by a sibling pod that hasn't finished dispatching)
    // must block any newer same-email row from being claimed.
    await enq(db, {
      eventType: "demo",
      payload: { source: "demo", email: "stuck@example.test" },
    });
    // Force the first row into in_flight without going through dispatch
    // — simulates a sibling pod mid-dispatch.
    db.rows[0].status = "in_flight";
    db.rows[0].claimed_at = Date.now();

    // Newer row for the same email lands while the sibling is mid-flight.
    await enq(db, {
      eventType: "demo",
      payload: { source: "demo", email: "stuck@example.test" },
    });

    let calls = 0;
    const dispatcher: OutboxDispatcher = async () => {
      calls++;
      return { kind: "ok" };
    };
    const result = await flushBatch(db, dispatcher, 50);
    // No row claimable — sibling already in_flight for this email.
    expect(result.claimed).toBe(0);
    expect(calls).toBe(0);
    expect(db.rows[1].status as string).toBe("pending");
  });

  test("rows with NULL email_key dispatch independently (no spurious dedup)", async () => {
    // Future event types that aren't email-keyed (or legacy rows with
    // a missing email field) must NOT get grouped together by the
    // DISTINCT ON in CLAIM_SQL — each NULL row is its own dedup
    // group via `COALESCE(email_key, id::text)`.
    await enq(db, { eventType: "system", payload: { source: "system", op: "ping" } });
    await enq(db, { eventType: "system", payload: { source: "system", op: "pong" } });
    expect(db.rows[0].email_key).toBeNull();
    expect(db.rows[1].email_key).toBeNull();

    const dispatcher: OutboxDispatcher = async () => ({ kind: "ok" });
    const result = await flushBatch(db, dispatcher, 50);
    expect(result.claimed).toBe(2);
    expect(result.ok).toBe(2);
  });

  test("enqueue normalizes email_key — case and whitespace collapse together", async () => {
    // Two payloads with cosmetically different email casing must
    // collide on email_key so they serialize together (matches the
    // lead-normalizer's `.toLowerCase().trim()`). Without this a
    // payload-side typo (`gworth@globexcorp.com` vs `GWorth@globexcorp.com`)
    // would bypass per-email serialization.
    await enq(db, {
      eventType: "demo",
      payload: { source: "demo", email: "  gworth@globexcorp.com  " },
    });
    await enq(db, {
      eventType: "signup",
      payload: { source: "signup", email: "GWORTH@GlobexCorp.com" },
    });
    expect(db.rows[0].email_key).toBe("gworth@globexcorp.com");
    expect(db.rows[1].email_key).toBe("gworth@globexcorp.com");

    let dispatched = 0;
    const dispatcher: OutboxDispatcher = async () => {
      dispatched++;
      return { kind: "ok" };
    };
    const tick1 = await flushBatch(db, dispatcher, 50);
    expect(tick1.claimed).toBe(1);
    expect(dispatched).toBe(1);
  });

  test("enqueue warn-logs when an email-keyed event type lands without an email", async () => {
    // A `demo` event-type payload that's missing/malformed `email`
    // (type-system bypass, schema drift, plugin payload corruption)
    // should still enqueue — but loud-log so operators can grep for
    // the silent-serialization-disabled signal before atlasFirstSource
    // flips weeks later.
    await enq(db, {
      eventType: "demo",
      // Cast through unknown so the test exercises the runtime guard
      // rather than relying on a TS-narrowed payload type.
      payload: { source: "demo" } as Record<string, unknown>,
    });
    expect(db.rows[0].email_key).toBeNull();
    const warn = loggerCalls.warn.find(
      (c) => c.data.event === "lead_outbox.email_key_missing",
    );
    expect(warn).toBeDefined();
    expect(warn?.data.eventType).toBe("demo");
    expect(warn?.data.rawType).toBe("undefined");
  });

  test("enqueue warn-logs for stamp-conversion (Twenty-side event_type, not upstream source)", async () => {
    // Conversion stamps land in crm_outbox with event_type
    // `"stamp-conversion"` (the `STAMP_CONVERSION_EVENT_TYPE` constant
    // in `ee/src/saas-crm/index.ts`), NOT `"conversion"`. The warn-log
    // gate must match the actual enqueued event_type so conversion
    // payloads with a missing email surface as silent-serialization-
    // disabled.
    await enq(db, {
      eventType: "stamp-conversion",
      payload: { source: "conversion" } as Record<string, unknown>,
    });
    const warn = loggerCalls.warn.find(
      (c) => c.data.event === "lead_outbox.email_key_missing",
    );
    expect(warn).toBeDefined();
    expect(warn?.data.eventType).toBe("stamp-conversion");
  });

  test("enqueue does NOT warn-log for non-email-keyed event types", async () => {
    // A future `system`/`telemetry` event_type whose payload is
    // intentionally not email-keyed must NOT trigger the warn-log,
    // otherwise the log becomes noise and operators learn to ignore it.
    await enq(db, {
      eventType: "system",
      payload: { source: "system", op: "ping" },
    });
    expect(db.rows[0].email_key).toBeNull();
    const warn = loggerCalls.warn.find(
      (c) => c.data.event === "lead_outbox.email_key_missing",
    );
    expect(warn).toBeUndefined();
  });

  test("same-created_at siblings serialize via the (created_at, id) tie-break", async () => {
    // Bulk-INSERT scenario: backfill-crm-leads.ts produces many rows
    // with one `now()` value. Without an id tie-break on the older-
    // sibling gate, tick 1 dedupes via DISTINCT ON but tick 2 sees a
    // same-`created_at` pending sibling as not-older and claims a
    // second row while the first is still in_flight.
    await enq(db, {
      eventType: "demo",
      payload: { source: "demo", email: "tied@example.test" },
    });
    await enq(db, {
      eventType: "demo",
      payload: { source: "demo", email: "tied@example.test" },
    });
    // Force identical timestamps to exercise the row-wise compare.
    db.rows[0].created_at = 1000;
    db.rows[1].created_at = 1000;
    const lowerIdRowId = db.rows[0].id < db.rows[1].id ? db.rows[0].id : db.rows[1].id;
    const higherIdRowId =
      db.rows[0].id < db.rows[1].id ? db.rows[1].id : db.rows[0].id;

    const slowDispatcher: OutboxDispatcher = async () => ({ kind: "ok" });
    // Tick 1: only the lower-id row is claimable; the higher-id row
    // is blocked because its same-`created_at` sibling with a smaller
    // id is still pending.
    const tick1 = await flushBatch(db, slowDispatcher, 50);
    expect(tick1.claimed).toBe(1);
    expect(db.rows.find((r) => r.id === lowerIdRowId)!.status as string).toBe("done");
    expect(db.rows.find((r) => r.id === higherIdRowId)!.status as string).toBe(
      "pending",
    );

    // Tick 2: the lower-id row is done; higher-id now has no blocking
    // sibling and becomes claimable.
    const tick2 = await flushBatch(db, slowDispatcher, 50);
    expect(tick2.claimed).toBe(1);
    expect(db.rows.find((r) => r.id === higherIdRowId)!.status as string).toBe(
      "done",
    );
  });

  test("newer in_flight sibling blocks an older pending row (rolling-hotfix safety)", async () => {
    // Rolling-hotfix scenario: an old pod with the pre-fix CLAIM_SQL
    // already leapfrogged R2 (newer) into in_flight while R1 (older,
    // in retry cooldown) waited. A new pod with the fixed CLAIM_SQL
    // must not then claim R1 — both would dispatch concurrently with
    // R2's still-in-flight upsert, flipping atlasLastSource.
    await enq(db, {
      eventType: "demo",
      payload: { source: "demo", email: "rolling@hotfix.test", ip: "203.0.113.60" },
    });
    await enq(db, {
      eventType: "demo",
      payload: { source: "demo", email: "rolling@hotfix.test", ip: "203.0.113.61" },
    });
    // R1 is older + pending; R2 is newer + in_flight (already claimed
    // by the legacy pod). The gate must still block R1.
    db.rows[1].status = "in_flight";
    db.rows[1].claimed_at = Date.now();

    let dispatched = 0;
    const dispatcher: OutboxDispatcher = async () => {
      dispatched++;
      return { kind: "ok" };
    };
    const result = await flushBatch(db, dispatcher, 50);
    expect(result.claimed).toBe(0);
    expect(dispatched).toBe(0);
    expect(db.rows[0].status as string).toBe("pending");
  });
});

// ── Startup recovery ─────────────────────────────────────────────────

describe("recoverInFlight", () => {
  test("resets stale in_flight rows to pending and returns the per-bucket counts", async () => {
    await enq(db, { eventType: "demo", payload: { source: "demo", email: "a@y.test" } });
    await enq(db, { eventType: "demo", payload: { source: "demo", email: "b@y.test" } });
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
    await enq(db, { eventType: "demo", payload: { source: "demo", email: "fresh@y.test" } });
    db.rows[0].status = "in_flight";
    db.rows[0].claimed_at = Date.now() - 1_000; // claimed 1s ago — within threshold

    const result = await recoverInFlight(db, 30_000);
    expect(result).toEqual({ reset: 0, deadLettered: 0 });
    expect(db.rows[0].status as string).toBe("in_flight");
  });

  test("exhausted in_flight rows are dead-lettered (not reset to pending)", async () => {
    await enq(db, { eventType: "demo", payload: { source: "demo", email: "exhausted@y.test" } });
    db.rows[0].status = "in_flight";
    db.rows[0].attempts = 6;
    db.rows[0].claimed_at = Date.now() - 60_000;

    const result = await recoverInFlight(db, 30_000);
    expect(result).toEqual({ reset: 0, deadLettered: 1 });
    expect(db.rows[0].status as string).toBe("dead");
    expect(db.rows[0].last_error).toContain("crashed mid-dispatch");
  });

  test("done / dead / pending rows are untouched", async () => {
    await enq(db, { eventType: "demo", payload: { source: "demo", email: "p@y.test" } });
    await enq(db, { eventType: "demo", payload: { source: "demo", email: "d@y.test" } });
    await enq(db, { eventType: "demo", payload: { source: "demo", email: "x@y.test" } });
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
    await enq(db, { eventType: "demo", payload: { source: "demo", email: "a@y.test" } });
    await enq(db, { eventType: "demo", payload: { source: "demo", email: "b@y.test" } });

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
    await enq(db, { eventType: "demo", payload: { source: "demo", email: "rate@y.test" } });
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
    await enq(db, { eventType: "demo", payload: { source: "demo", email: "clr@y.test" } });
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

// ── #2874 — retry-timer delay math (mirrors the SQL claim gate) ───────
describe("computeRetryDelayMs", () => {
  const NOW = 1_700_000_000_000;

  test("upstream Retry-After wins over the tier delay", () => {
    // created 1h ago, attempts=1 (tier 30s) — but the header says 60s.
    expect(computeRetryDelayMs(new Date(NOW - 3_600_000), 1, 60_000, NOW)).toBe(60_000);
  });

  test("no Retry-After → remaining time until created_at + tier", () => {
    // created 10s ago, attempts=1 → tier 30s → 20s remain.
    expect(computeRetryDelayMs(new Date(NOW - 10_000), 1, undefined, NOW)).toBe(20_000);
  });

  test("a row already past its tier due-time fires immediately (floored at 0)", () => {
    // created 60s ago, attempts=1 (tier 30s) → already due.
    expect(computeRetryDelayMs(new Date(NOW - 60_000), 1, undefined, NOW)).toBe(0);
  });

  test("accepts a string created_at (raw pg row shape)", () => {
    expect(
      computeRetryDelayMs(new Date(NOW - 10_000).toISOString(), 1, undefined, NOW),
    ).toBe(20_000);
  });

  test("unparseable created_at falls back to the full tier delay (still bounded)", () => {
    // attempts=2 → tier 3m. Over-delays a back-dated row marginally, but
    // never strands it — the backstop sweep guarantees eventual claim.
    expect(computeRetryDelayMs("not-a-date", 2, undefined, NOW)).toBe(180_000);
  });

  test("invalid Retry-After (negative / NaN) is ignored; tier applies", () => {
    expect(computeRetryDelayMs(new Date(NOW - 10_000), 1, -5, NOW)).toBe(20_000);
    expect(computeRetryDelayMs(new Date(NOW - 10_000), 1, NaN, NOW)).toBe(20_000);
  });

  test("ceiling tier (attempts=5) schedules ~12h out", () => {
    expect(computeRetryDelayMs(new Date(NOW), 5, undefined, NOW)).toBe(43_200_000);
  });
});

// ── AC #3 — structured log on dead-letter ────────────────────────────

describe("dead-letter logging (AC #3)", () => {
  test("permanent dead-letter emits a structured log with rowId + last_error", async () => {
    await enq(db, { eventType: "demo", payload: { source: "demo", email: "dead-log@y.test" } });
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
    await enq(db, { eventType: "demo", payload: { source: "demo", email: "budget@y.test" } });
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
    await enq(db, { eventType: "demo", payload: { source: "demo", email: "tr@y.test" } });
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
    await enq(db, { eventType: "demo", payload: { source: "demo", email: "e2e@y.test" } });
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
    await enq(db, { eventType: "demo", payload: { source: "demo", email: "ok@y.test" } });
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

describe("getBackstopSweepIntervalMs — #2874", () => {
  const KEY = "ATLAS_CRM_OUTBOX_BACKSTOP_SWEEP_SECONDS";
  let original: string | undefined;
  beforeEach(() => {
    original = process.env[KEY];
    delete process.env[KEY];
  });
  const restore = () => {
    if (original === undefined) delete process.env[KEY];
    else process.env[KEY] = original;
  };

  test("defaults to 300s (5 min) when unset", () => {
    expect(getBackstopSweepIntervalMs()).toBe(300_000);
    restore();
  });

  test("parses a valid override", () => {
    process.env[KEY] = "60";
    expect(getBackstopSweepIntervalMs()).toBe(60_000);
    restore();
  });

  test("clamps below the 1s minimum and above the 24h maximum", () => {
    process.env[KEY] = "0";
    // 0 is non-positive → treated as unset → default (not the 1s floor).
    expect(getBackstopSweepIntervalMs()).toBe(300_000);
    process.env[KEY] = "-5";
    expect(getBackstopSweepIntervalMs()).toBe(300_000);
    process.env[KEY] = "999999"; // > 86400s
    expect(getBackstopSweepIntervalMs()).toBe(86_400_000);
    restore();
  });

  test("non-numeric input falls back to the default", () => {
    process.env[KEY] = "five-minutes";
    expect(getBackstopSweepIntervalMs()).toBe(300_000);
    restore();
  });
});

