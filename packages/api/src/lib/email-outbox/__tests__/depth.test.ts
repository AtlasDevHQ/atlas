/**
 * Depth snapshot + threshold rate-limiter for the email_outbox flusher.
 * Pure behaviour against a stub DB / injected clock — no real Postgres.
 */

import { describe, expect, mock, test } from "bun:test";

mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({ info() {}, debug() {}, warn() {}, error() {} }),
}));

const {
  queryDepthSnapshot,
  getWarnThreshold,
  OutboxWarnRateLimiter,
  DEFAULT_WARN_THRESHOLD,
  WARN_INTERVAL_MS,
} = await import("../depth");
type EmailOutboxDB = import("../outbox").EmailOutboxDB;

function stubDb(row: Record<string, unknown> | null): EmailOutboxDB {
  return {
    async query<T extends Record<string, unknown>>(): Promise<T[]> {
      return (row === null ? [] : [row]) as unknown as T[];
    },
  };
}

describe("queryDepthSnapshot", () => {
  test("parses string counts (pg numeric) and the oldest pending timestamp", async () => {
    const at = new Date("2026-05-29T00:00:00Z");
    const snap = await queryDepthSnapshot(
      stubDb({ pending_count: "7", dead_count: "2", oldest_pending_at: at.toISOString() }),
    );
    expect(snap.pending).toBe(7);
    expect(snap.dead).toBe(2);
    expect(snap.oldestPendingCreatedAt?.getTime()).toBe(at.getTime());
  });

  test("tolerates numeric counts and a null oldest timestamp", async () => {
    const snap = await queryDepthSnapshot(
      stubDb({ pending_count: 0, dead_count: 0, oldest_pending_at: null }),
    );
    expect(snap.pending).toBe(0);
    expect(snap.dead).toBe(0);
    expect(snap.oldestPendingCreatedAt).toBeNull();
  });

  test("throws when the aggregate returns no row (driver/pool invariant violated)", async () => {
    await expect(queryDepthSnapshot(stubDb(null))).rejects.toThrow(/no aggregate row/i);
  });
});

describe("getWarnThreshold", () => {
  test("defaults when unset and rejects a non-integer", () => {
    delete process.env.ATLAS_EMAIL_OUTBOX_WARN_THRESHOLD;
    expect(getWarnThreshold()).toBe(DEFAULT_WARN_THRESHOLD);
    process.env.ATLAS_EMAIL_OUTBOX_WARN_THRESHOLD = "100abc";
    expect(getWarnThreshold()).toBe(DEFAULT_WARN_THRESHOLD);
    delete process.env.ATLAS_EMAIL_OUTBOX_WARN_THRESHOLD;
  });

  test("honours a valid override", () => {
    process.env.ATLAS_EMAIL_OUTBOX_WARN_THRESHOLD = "10";
    expect(getWarnThreshold()).toBe(10);
    delete process.env.ATLAS_EMAIL_OUTBOX_WARN_THRESHOLD;
  });
});

describe("OutboxWarnRateLimiter", () => {
  const oldest = new Date("2026-05-29T00:00:00Z");

  test("returns null when depth is at or below threshold", () => {
    const lim = new OutboxWarnRateLimiter(5);
    expect(lim.evaluate({ pending: 5, dead: 0, oldestPendingCreatedAt: null }, 0)).toBeNull();
  });

  test("emits a decision above threshold and rate-limits within the interval", () => {
    const lim = new OutboxWarnRateLimiter(5);
    // Baseline must exceed WARN_INTERVAL_MS — lastWarnAt starts at 0, so
    // the very first warn only fires once `now` is past one interval (in
    // production `now` is Date.now(), always far past it).
    const t0 = WARN_INTERVAL_MS + 1_000;
    const first = lim.evaluate({ pending: 6, dead: 0, oldestPendingCreatedAt: oldest }, t0);
    expect(first).not.toBeNull();
    expect(first!.depth).toBe(6);
    expect(first!.threshold).toBe(5);
    // Still elevated, but within WARN_INTERVAL_MS → suppressed.
    const second = lim.evaluate(
      { pending: 7, dead: 0, oldestPendingCreatedAt: oldest },
      t0 + WARN_INTERVAL_MS - 1,
    );
    expect(second).toBeNull();
    // After the interval elapses → re-warns.
    const third = lim.evaluate(
      { pending: 7, dead: 0, oldestPendingCreatedAt: oldest },
      t0 + WARN_INTERVAL_MS + 1,
    );
    expect(third).not.toBeNull();
  });

  test("computes oldest pending age from the injected clock", () => {
    const lim = new OutboxWarnRateLimiter(0);
    const now = oldest.getTime() + 90_000;
    const decision = lim.evaluate({ pending: 1, dead: 0, oldestPendingCreatedAt: oldest }, now);
    expect(decision!.oldestPendingAgeMs).toBe(90_000);
  });
});
