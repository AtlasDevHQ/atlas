/**
 * Email-outbox unit tests against an in-memory fake of the
 * `EmailOutboxDB` surface. We avoid a real Postgres here — the SQL
 * strings are exercised end-to-end in `outbox-pg.test.ts` (gated on
 * `TEST_DATABASE_URL`). This file nails the enqueue / flush / recover
 * lifecycle, which is pure TypeScript behaviour.
 *
 * The fake recognises each SQL string from the module and dispatches to
 * an in-memory row table with a controllable monotonic clock so backoff
 * gating is deterministic.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// Logger mock MUST be installed before importing outbox.ts so the
// module-level createLogger() call captures our stub. Per CLAUDE.md the
// email-outbox/__tests__/ directory is allowed mock.module() for this.
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
  getTickIntervalMs,
  isFlusherEnabled,
  recoverInFlight,
  DEFAULT_TICK_SECONDS,
  MAX_TICK_SECONDS,
  MIN_TICK_SECONDS,
} = await import("../outbox");
const { DEAD_AFTER_ATTEMPTS, nextDelayMs } = await import("../backoff");
type EmailDispatcher = import("../outbox").EmailDispatcher;
type EmailOutboxDB = import("../outbox").EmailOutboxDB;

type Row = {
  id: string;
  email_type: string;
  payload: unknown;
  org_id: string | null;
  status: "pending" | "in_flight" | "done" | "dead";
  attempts: number;
  last_error: string | null;
  retry_after: number | null;
  claimed_at: number | null;
  created_at: number;
  processed_at: number | null;
};

const MSG = { to: "user@example.com", subject: "Reset", html: "<p>link</p>" };

/**
 * In-memory EmailOutboxDB. `now` is a controllable monotonic clock so
 * the backoff gate (`created_at + tier(attempts) <= now`) is
 * deterministic. created_at is stamped from `now` at insert; `now`
 * does not auto-advance.
 */
class FakeEmailOutboxDB implements EmailOutboxDB {
  rows: Row[] = [];
  now = 1_000_000; // arbitrary baseline (ms)
  private nextId = 1;
  /**
   * Make the next N flush-terminal status writes (MARK_DONE /
   * MARK_TRANSIENT / MARK_DEAD) throw, simulating a Postgres blip between
   * dispatch return and status stamp. Drives the markStatusWithRetry
   * retry-once-then-strand path.
   */
  failNextMarks = 0;

  advance(ms: number): void {
    this.now += ms;
  }

  byId(id: string): Row | undefined {
    return this.rows.find((r) => r.id === id);
  }

  async query<T extends Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<T[]> {
    const p = params ?? [];

    // Inject terminal-write failures for the markStatusWithRetry path.
    // Flush-terminal marks carry `last_error`/`processed_at` (done/dead)
    // or `SET status = 'pending', last_error` (transient) — distinct from
    // the recovery sweeps, which this test never triggers.
    const isFlushTerminalMark =
      /SET status = 'done'/i.test(sql) ||
      /SET status = 'pending',\s*last_error/i.test(sql) ||
      /SET status = 'dead',\s*processed_at = now\(\),\s*\n?\s*last_error = \$1/i.test(sql);
    if (isFlushTerminalMark && this.failNextMarks > 0) {
      this.failNextMarks--;
      throw new Error("simulated terminal-status UPDATE failure");
    }

    if (/^\s*INSERT INTO email_outbox/i.test(sql)) {
      const id = `row-${this.nextId++}`;
      this.rows.push({
        id,
        email_type: String(p[0]),
        payload: typeof p[1] === "string" ? JSON.parse(p[1] as string) : p[1],
        org_id: (p[2] as string | null) ?? null,
        status: "pending",
        attempts: 0,
        last_error: null,
        retry_after: null,
        claimed_at: null,
        created_at: this.now,
        processed_at: null,
      });
      return [{ id }] as unknown as T[];
    }

    if (/^\s*UPDATE email_outbox\s+SET status = 'in_flight'/i.test(sql)) {
      // CLAIM: pending + attempts < DEAD + due (COALESCE(retry_after,
      // created_at + tier(attempts)) <= now), ordered by created_at,id,
      // limited.
      const limit = Number(p[0]);
      const due = this.rows
        .filter(
          (r) =>
            r.status === "pending" &&
            r.attempts < DEAD_AFTER_ATTEMPTS &&
            (r.retry_after ?? r.created_at + nextDelayMs(r.attempts)) <= this.now,
        )
        .sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id))
        .slice(0, limit);
      const claimed: Row[] = [];
      for (const r of due) {
        r.status = "in_flight";
        r.attempts += 1;
        r.claimed_at = this.now;
        claimed.push(r);
      }
      return claimed.map((r) => ({
        id: r.id,
        email_type: r.email_type,
        payload: r.payload,
        org_id: r.org_id,
        attempts: r.attempts,
      })) as unknown as T[];
    }

    if (/SET status = 'done'/i.test(sql)) {
      const r = this.byId(String(p[0]));
      if (r) {
        r.status = "done";
        r.processed_at = this.now;
        r.last_error = null;
        r.retry_after = null;
        r.claimed_at = null;
      }
      return [] as unknown as T[];
    }

    if (/SET status = 'pending',\s*last_error/i.test(sql)) {
      // MARK_TRANSIENT_FAIL: [last_error, id, retry_after(Date|null)]
      const r = this.byId(String(p[1]));
      if (r) {
        r.status = "pending";
        r.last_error = (p[0] as string) ?? null;
        r.retry_after = p[2] instanceof Date ? (p[2] as Date).getTime() : null;
        r.claimed_at = null;
      }
      return [] as unknown as T[];
    }

    if (/SET status = 'dead',\s*processed_at = now\(\),\s*\n?\s*last_error = \$1/i.test(sql)) {
      // MARK_DEAD: [last_error, id]
      const r = this.byId(String(p[1]));
      if (r) {
        r.status = "dead";
        r.processed_at = this.now;
        r.last_error = (p[0] as string) ?? null;
        r.retry_after = null;
        r.claimed_at = null;
      }
      return [] as unknown as T[];
    }

    if (/SET status = 'dead', processed_at = now\(\),\s*\n?\s*last_error = CASE/i.test(sql)) {
      // MARK_EXHAUSTED_IN_FLIGHT_DEAD (no params)
      const hit = this.rows.filter(
        (r) => r.status === "in_flight" && r.attempts >= DEAD_AFTER_ATTEMPTS,
      );
      for (const r of hit) {
        r.status = "dead";
        r.processed_at = this.now;
        r.last_error = r.last_error ?? `crashed mid-send at attempts=${r.attempts} (recovery)`;
      }
      return hit.map((r) => ({ id: r.id })) as unknown as T[];
    }

    if (/^\s*UPDATE email_outbox\s+SET status = 'pending'\s+WHERE status = 'in_flight'/i.test(sql)) {
      // RECOVER_STALE_IN_FLIGHT: [staleAgeMs]
      const staleMs = Number(p[0]);
      const hit = this.rows.filter(
        (r) =>
          r.status === "in_flight" &&
          r.attempts < DEAD_AFTER_ATTEMPTS &&
          (r.claimed_at === null || r.claimed_at < this.now - staleMs),
      );
      for (const r of hit) r.status = "pending";
      return hit.map((r) => ({ id: r.id })) as unknown as T[];
    }

    throw new Error(`FakeEmailOutboxDB: unrecognized SQL:\n${sql}`);
  }
}

const okDispatcher: EmailDispatcher = async () => ({ kind: "ok" });
const transientDispatcher: EmailDispatcher = async () => ({
  kind: "transient",
  message: "Resend 503",
});

beforeEach(() => {
  loggerCalls.warn.length = 0;
  loggerCalls.error.length = 0;
});

describe("enqueue", () => {
  test("inserts a pending row and returns its id", async () => {
    const db = new FakeEmailOutboxDB();
    const id = await enqueue(db, { emailType: "password-reset", message: MSG });
    expect(id).toBe("row-1");
    const row = db.byId(id)!;
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(0);
    expect(row.email_type).toBe("password-reset");
    expect(row.payload).toEqual(MSG);
    expect(row.org_id).toBeNull();
  });

  test("threads orgId through when provided", async () => {
    const db = new FakeEmailOutboxDB();
    const id = await enqueue(db, { emailType: "invite", message: MSG, orgId: "org-7" });
    expect(db.byId(id)!.org_id).toBe("org-7");
  });

  test("rejects an empty recipient at the seam", async () => {
    const db = new FakeEmailOutboxDB();
    await expect(
      enqueue(db, { emailType: "password-reset", message: { ...MSG, to: "  " } }),
    ).rejects.toThrow(/non-empty recipient/);
    expect(db.rows).toHaveLength(0);
  });
});

describe("flushBatch", () => {
  test("delivers a due row and marks it done", async () => {
    const db = new FakeEmailOutboxDB();
    await enqueue(db, { emailType: "password-reset", message: MSG });
    const result = await flushBatch(db, okDispatcher, 10);
    expect(result).toEqual({ claimed: 1, ok: 1, transient: 0, permanent: 0 });
    expect(db.rows[0].status).toBe("done");
    expect(db.rows[0].attempts).toBe(1);
  });

  test("a transient failure returns the row to pending with the error recorded", async () => {
    const db = new FakeEmailOutboxDB();
    await enqueue(db, { emailType: "password-reset", message: MSG });
    const result = await flushBatch(db, transientDispatcher, 10);
    expect(result).toEqual({ claimed: 1, ok: 0, transient: 1, permanent: 0 });
    const row = db.rows[0];
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(1);
    expect(row.last_error).toBe("Resend 503");
    expect(row.retry_after).toBeNull();
  });

  test("a transient failure with a retryAfterMs stamps retry_after", async () => {
    const db = new FakeEmailOutboxDB();
    await enqueue(db, { emailType: "password-reset", message: MSG });
    const dispatcher: EmailDispatcher = async () => ({
      kind: "transient",
      message: "rate limited",
      retryAfterMs: 60_000,
    });
    await flushBatch(db, dispatcher, 10);
    expect(db.rows[0].retry_after).not.toBeNull();
  });

  test("a permanent failure dead-letters the row immediately", async () => {
    const db = new FakeEmailOutboxDB();
    await enqueue(db, { emailType: "password-reset", message: MSG });
    const dispatcher: EmailDispatcher = async () => ({
      kind: "permanent",
      message: "bad api key",
    });
    const result = await flushBatch(db, dispatcher, 10);
    expect(result.permanent).toBe(1);
    expect(db.rows[0].status).toBe("dead");
    expect(db.rows[0].last_error).toBe("bad api key");
  });

  test("backoff: a freshly-failed row is not re-claimed until its tier elapses", async () => {
    const db = new FakeEmailOutboxDB();
    await enqueue(db, { emailType: "password-reset", message: MSG });
    // First flush fails transiently → attempts=1, tier=30s.
    await flushBatch(db, transientDispatcher, 10);
    // Immediately: not due (created_at + 30s > now).
    const second = await flushBatch(db, transientDispatcher, 10);
    expect(second.claimed).toBe(0);
    // After 30s elapses it becomes claimable again.
    db.advance(nextDelayMs(1));
    const third = await flushBatch(db, okDispatcher, 10);
    expect(third.claimed).toBe(1);
    expect(db.rows[0].status).toBe("done");
  });

  test("dead-letters on the final transient failure once the budget is exhausted", async () => {
    const db = new FakeEmailOutboxDB();
    await enqueue(db, { emailType: "password-reset", message: MSG });
    // Drive attempts up to DEAD_AFTER_ATTEMPTS via repeated transient
    // failures, advancing the clock past each tier so the row re-claims.
    for (let i = 0; i < DEAD_AFTER_ATTEMPTS; i++) {
      const r = await flushBatch(db, transientDispatcher, 10);
      if (db.rows[0].status === "dead") break;
      expect(r.claimed).toBe(1);
      db.advance(nextDelayMs(db.rows[0].attempts));
    }
    expect(db.rows[0].status).toBe("dead");
    expect(db.rows[0].last_error).toMatch(/retry budget|after \d+ attempts/i);
  });

  test("a dispatcher that throws is treated as transient, not a crash", async () => {
    const db = new FakeEmailOutboxDB();
    await enqueue(db, { emailType: "password-reset", message: MSG });
    const throwing: EmailDispatcher = async () => {
      throw new Error("boom");
    };
    const result = await flushBatch(db, throwing, 10);
    expect(result.transient).toBe(1);
    expect(db.rows[0].status).toBe("pending");
    expect(loggerCalls.error.some((c) => c.data.event === "email_outbox.dispatcher_threw")).toBe(true);
  });

  test("a malformed payload dead-letters without burning the retry budget", async () => {
    const db = new FakeEmailOutboxDB();
    await enqueue(db, { emailType: "password-reset", message: MSG });
    // Corrupt the stored payload as if it were written by a buggy path.
    db.rows[0].payload = { subject: "no recipient" };
    let dispatched = false;
    const dispatcher: EmailDispatcher = async () => {
      dispatched = true;
      return { kind: "ok" };
    };
    const result = await flushBatch(db, dispatcher, 10);
    expect(dispatched).toBe(false); // never handed to the dispatcher
    expect(result.permanent).toBe(1);
    expect(db.rows[0].status).toBe("dead");
  });

  test("claims up to the batch limit and no more", async () => {
    const db = new FakeEmailOutboxDB();
    for (let i = 0; i < 5; i++) {
      await enqueue(db, { emailType: "password-reset", message: MSG });
    }
    const result = await flushBatch(db, okDispatcher, 3);
    expect(result.claimed).toBe(3);
    expect(db.rows.filter((r) => r.status === "pending")).toHaveLength(2);
  });

  test("a non-positive batch limit claims nothing", async () => {
    const db = new FakeEmailOutboxDB();
    await enqueue(db, { emailType: "password-reset", message: MSG });
    expect(await flushBatch(db, okDispatcher, 0)).toEqual({
      claimed: 0,
      ok: 0,
      transient: 0,
      permanent: 0,
    });
    expect(db.rows[0].status).toBe("pending");
  });
});

describe("markStatusWithRetry (terminal-status write resilience)", () => {
  test("retries a terminal-status write once and still reaches the terminal state", async () => {
    const db = new FakeEmailOutboxDB();
    await enqueue(db, { emailType: "password-reset", message: MSG });
    db.failNextMarks = 1; // first MARK_DONE throws, retry succeeds
    const result = await flushBatch(db, okDispatcher, 10);
    expect(result.ok).toBe(1);
    expect(db.byId("row-1")!.status).toBe("done");
    expect(
      loggerCalls.warn.some((c) => c.data.event === "email_outbox.status_update_retrying"),
    ).toBe(true);
  });

  test("re-throws when the terminal-status write fails twice — row strands in_flight for recovery", async () => {
    const db = new FakeEmailOutboxDB();
    await enqueue(db, { emailType: "password-reset", message: MSG });
    db.failNextMarks = 2; // both attempts throw → flushBatch propagates
    await expect(flushBatch(db, okDispatcher, 10)).rejects.toThrow(
      /simulated terminal-status UPDATE failure/,
    );
    // The claim already flipped it to in_flight; the failed mark leaves it
    // there so recoverInFlight mops it up on the next boot (no silent loss).
    expect(db.byId("row-1")!.status).toBe("in_flight");
  });
});

describe("recoverInFlight", () => {
  test("resets a stale in_flight row to pending", async () => {
    const db = new FakeEmailOutboxDB();
    await enqueue(db, { emailType: "password-reset", message: MSG });
    db.rows[0].status = "in_flight";
    db.rows[0].attempts = 1;
    db.rows[0].claimed_at = db.now;
    db.advance(10 * 60_000); // 10 min — past the 5 min startup window
    const result = await recoverInFlight(db);
    expect(result.reset).toBe(1);
    // Read via byId() so the status union isn't narrowed by the literal
    // assignment above (tsgo can't see recoverInFlight mutates it).
    expect(db.byId("row-1")!.status).toBe("pending");
  });

  test("leaves a freshly-claimed in_flight row alone (multi-pod guard)", async () => {
    const db = new FakeEmailOutboxDB();
    await enqueue(db, { emailType: "password-reset", message: MSG });
    db.rows[0].status = "in_flight";
    db.rows[0].attempts = 1;
    db.rows[0].claimed_at = db.now; // just claimed
    const result = await recoverInFlight(db);
    expect(result.reset).toBe(0);
    expect(db.byId("row-1")!.status).toBe("in_flight");
  });

  test("dead-letters an exhausted in_flight carcass regardless of staleness", async () => {
    const db = new FakeEmailOutboxDB();
    await enqueue(db, { emailType: "password-reset", message: MSG });
    db.rows[0].status = "in_flight";
    db.rows[0].attempts = DEAD_AFTER_ATTEMPTS;
    db.rows[0].claimed_at = db.now; // fresh, but exhausted
    const result = await recoverInFlight(db);
    expect(result.deadLettered).toBe(1);
    expect(db.byId("row-1")!.status).toBe("dead");
  });
});

describe("computeRetryAfterTimestamp", () => {
  test("returns null for undefined / negative / non-finite delays", () => {
    expect(computeRetryAfterTimestamp(undefined)).toBeNull();
    expect(computeRetryAfterTimestamp(-1)).toBeNull();
    expect(computeRetryAfterTimestamp(Number.POSITIVE_INFINITY)).toBeNull();
  });

  test("returns a future Date for a finite positive delay", () => {
    const before = Date.now();
    const got = computeRetryAfterTimestamp(60_000);
    expect(got).toBeInstanceOf(Date);
    expect(got!.getTime()).toBeGreaterThanOrEqual(before + 60_000);
  });
});

describe("config helpers", () => {
  test("getTickIntervalMs defaults to 5s and clamps out-of-range input", () => {
    delete process.env.ATLAS_EMAIL_OUTBOX_TICK_SECONDS;
    expect(getTickIntervalMs()).toBe(DEFAULT_TICK_SECONDS * 1_000);
    process.env.ATLAS_EMAIL_OUTBOX_TICK_SECONDS = "999999";
    expect(getTickIntervalMs()).toBe(MAX_TICK_SECONDS * 1_000);
    process.env.ATLAS_EMAIL_OUTBOX_TICK_SECONDS = "0";
    expect(getTickIntervalMs()).toBe(DEFAULT_TICK_SECONDS * 1_000);
    delete process.env.ATLAS_EMAIL_OUTBOX_TICK_SECONDS;
    void MIN_TICK_SECONDS;
  });

  test("isFlusherEnabled is default-true and honours the off switches", () => {
    delete process.env.ATLAS_EMAIL_OUTBOX_FLUSHER_ENABLED;
    expect(isFlusherEnabled()).toBe(true);
    for (const off of ["false", "0", "no", "off", "OFF"]) {
      process.env.ATLAS_EMAIL_OUTBOX_FLUSHER_ENABLED = off;
      expect(isFlusherEnabled()).toBe(false);
    }
    process.env.ATLAS_EMAIL_OUTBOX_FLUSHER_ENABLED = "true";
    expect(isFlusherEnabled()).toBe(true);
    delete process.env.ATLAS_EMAIL_OUTBOX_FLUSHER_ENABLED;
  });
});
