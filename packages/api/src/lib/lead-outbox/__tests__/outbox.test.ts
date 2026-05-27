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
  email_key: string | null;
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
      this.rows.push({
        id,
        event_type: String(p[0]),
        payload: JSON.parse(String(p[1])),
        email_key: emailKey,
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
      // Mirror CLAIM_SQL (0104 + #2872 follow-up): a row is claimable
      // only if NO older non-terminal same-email sibling exists. This
      // gates both the in_flight-sibling-blocks-newer case AND the
      // retry-cooldown-leapfrog case (older sibling in `pending` with
      // future retry_after still blocks the newer fresh row). NULL
      // email_key rows skip the gate (`o2.email_key IS NOT NULL`
      // short-circuits) — each NULL row is its own dedup group via
      // COALESCE(email_key, id::text).
      const hasOlderNonTerminalSibling = (r: Row): boolean => {
        if (r.email_key == null) return false;
        return this.rows.some(
          (o) =>
            o.id !== r.id &&
            o.email_key === r.email_key &&
            (o.status === "pending" || o.status === "in_flight") &&
            o.created_at < r.created_at,
        );
      };
      const candidates = this.rows
        .filter(
          (r) =>
            r.status === "pending" &&
            r.attempts < 6 &&
            !hasOlderNonTerminalSibling(r),
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
    const demoId = await enqueue(db, {
      eventType: "demo",
      payload: { source: "demo", email: "gworth@globexcorp.com", ip: "203.0.113.30" },
    });
    const signupId = await enqueue(db, {
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
    const first = await enqueue(db, {
      eventType: "demo",
      payload: { source: "demo", email: "msdyson@cyberdynesys.com", ip: "203.0.113.40" },
    });
    const second = await enqueue(db, {
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
    await enqueue(db, { eventType: "demo", payload: { source: "demo", email: "a1@example.test" } });
    await enqueue(db, { eventType: "demo", payload: { source: "demo", email: "a2@example.test" } });
    await enqueue(db, { eventType: "demo", payload: { source: "demo", email: "a3@example.test" } });
    await enqueue(db, { eventType: "demo", payload: { source: "demo", email: "a4@example.test" } });

    const dispatcher: OutboxDispatcher = async () => ({ kind: "ok" });
    const result = await flushBatch(db, dispatcher, 50);
    expect(result.claimed).toBe(4);
    expect(result.ok).toBe(4);
  });

  test("in_flight sibling blocks subsequent claims for the same email", async () => {
    // The cross-tick / cross-pod safety case: a row already in_flight
    // (e.g. claimed by a sibling pod that hasn't finished dispatching)
    // must block any newer same-email row from being claimed.
    await enqueue(db, {
      eventType: "demo",
      payload: { source: "demo", email: "stuck@example.test" },
    });
    // Force the first row into in_flight without going through dispatch
    // — simulates a sibling pod mid-dispatch.
    db.rows[0].status = "in_flight";
    db.rows[0].claimed_at = Date.now();

    // Newer row for the same email lands while the sibling is mid-flight.
    await enqueue(db, {
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
    await enqueue(db, { eventType: "system", payload: { source: "system", op: "ping" } });
    await enqueue(db, { eventType: "system", payload: { source: "system", op: "pong" } });
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
    await enqueue(db, {
      eventType: "demo",
      payload: { source: "demo", email: "  gworth@globexcorp.com  " },
    });
    await enqueue(db, {
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
    await enqueue(db, {
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

  test("enqueue does NOT warn-log for non-email-keyed event types", async () => {
    // A future `system`/`telemetry` event_type whose payload is
    // intentionally not email-keyed must NOT trigger the warn-log,
    // otherwise the log becomes noise and operators learn to ignore it.
    await enqueue(db, {
      eventType: "system",
      payload: { source: "system", op: "ping" },
    });
    expect(db.rows[0].email_key).toBeNull();
    const warn = loggerCalls.warn.find(
      (c) => c.data.event === "lead_outbox.email_key_missing",
    );
    expect(warn).toBeUndefined();
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

