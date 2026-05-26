/**
 * Outbox depth metrics + threshold alerting (#2734, slice 8 of 1.6.0).
 *
 * Three suites in one file:
 *   1. `queryDepthSnapshot` — translates the PG aggregate row into a
 *      typed `OutboxDepthSnapshot` across the shapes the `pg` driver
 *      actually returns (string counts, Date / ISO-string timestamps,
 *      empty result).
 *   2. `OutboxWarnRateLimiter` — emit-then-suppress within the 60s
 *      window, re-emit just past it, and never emit below threshold.
 *   3. `runOutboxTick` — proves the orchestrator records both gauges
 *      and emits exactly one log.warn for a sustained 101+ pending
 *      depth across two within-window ticks.
 *
 * No `mock.module` — every test wires deps explicitly so the slice's
 * contract is enforced at the type level (not at the module-mock
 * level). Per the slice 1.5.4 #2796 lessons, this also keeps the file
 * safe under bun's subprocess-per-file isolation runner.
 */

import { describe, expect, mock, test } from "bun:test";
import {
  DEFAULT_WARN_THRESHOLD,
  MAX_WARN_THRESHOLD,
  MIN_WARN_THRESHOLD,
  OutboxWarnRateLimiter,
  WARN_INTERVAL_MS,
  getWarnThreshold,
  queryDepthSnapshot,
  type OutboxDepthSnapshot,
} from "../depth";
import { runOutboxTick, type GaugeRecorder, type OutboxTickLogger } from "../tick";
import type { OutboxDB, OutboxDispatcher } from "../outbox";

// ─────────────────────────────────────────────────────────────────────
//  Test helpers
// ─────────────────────────────────────────────────────────────────────

interface StubDBOptions {
  snapshotRows?: Array<Record<string, unknown>>;
  claimRows?: Array<Record<string, unknown>>;
}

/**
 * Minimal `OutboxDB` that routes by SQL fingerprint:
 *   - the slice-8 aggregate SELECT → `snapshotRows`
 *   - the slice-2 `UPDATE … RETURNING id, event_type, …` claim → `claimRows`
 *   - anything else → `[]`
 *
 * Each call appends to `db.calls` so a test can assert ordering
 * (snapshot must run BEFORE claim — see the order-of-operations
 * comment in `tick.ts`).
 */
function makeStubDB(opts: StubDBOptions = {}): OutboxDB & {
  calls: Array<{ sql: string; params: unknown[] }>;
} {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const db: OutboxDB & { calls: typeof calls } = {
    calls,
    query: async <T extends Record<string, unknown>>(
      sql: string,
      params?: unknown[],
    ): Promise<T[]> => {
      calls.push({ sql, params: params ?? [] });
      if (/FROM crm_outbox\s+WHERE status IN/i.test(sql)) {
        return (opts.snapshotRows ?? []) as unknown as T[];
      }
      if (/RETURNING id, event_type/i.test(sql)) {
        return (opts.claimRows ?? []) as unknown as T[];
      }
      return [] as unknown as T[];
    },
  };
  return db;
}

const NEVER_DISPATCH: OutboxDispatcher = async () => ({
  kind: "ok",
});

function makeGauge(): GaugeRecorder & { values: number[] } {
  const values: number[] = [];
  return {
    values,
    record(value: number) {
      values.push(value);
    },
  };
}

function makeLogger(): OutboxTickLogger & {
  warnCalls: Array<{ obj: Record<string, unknown>; msg: string }>;
} {
  const warnCalls: Array<{ obj: Record<string, unknown>; msg: string }> = [];
  return {
    warnCalls,
    warn(obj, msg) {
      warnCalls.push({ obj, msg });
    },
  };
}

// ─────────────────────────────────────────────────────────────────────
//  queryDepthSnapshot
// ─────────────────────────────────────────────────────────────────────

describe("queryDepthSnapshot", () => {
  test("parses PG string counts + Date oldest_pending_at", async () => {
    const oldest = new Date("2026-05-26T10:00:00.000Z");
    const db = makeStubDB({
      snapshotRows: [
        { pending_count: "50", dead_count: "5", oldest_pending_at: oldest },
      ],
    });
    const snap = await queryDepthSnapshot(db);
    expect(snap).toEqual({
      pending: 50,
      dead: 5,
      oldestPendingCreatedAt: oldest,
    } satisfies OutboxDepthSnapshot);
  });

  test("parses ISO string oldest_pending_at (driver-config-dependent)", async () => {
    const isoString = "2026-05-26T10:00:00.000Z";
    const db = makeStubDB({
      snapshotRows: [
        { pending_count: "200", dead_count: "0", oldest_pending_at: isoString },
      ],
    });
    const snap = await queryDepthSnapshot(db);
    expect(snap.pending).toBe(200);
    expect(snap.dead).toBe(0);
    expect(snap.oldestPendingCreatedAt?.toISOString()).toBe(isoString);
  });

  test("null oldest_pending_at when no pending rows exist", async () => {
    const db = makeStubDB({
      snapshotRows: [
        { pending_count: "0", dead_count: "12", oldest_pending_at: null },
      ],
    });
    const snap = await queryDepthSnapshot(db);
    expect(snap).toEqual({
      pending: 0,
      dead: 12,
      oldestPendingCreatedAt: null,
    });
  });

  test("handles numeric (not string) count values without coercion bug", async () => {
    const db = makeStubDB({
      snapshotRows: [{ pending_count: 7, dead_count: 0, oldest_pending_at: null }],
    });
    const snap = await queryDepthSnapshot(db);
    expect(snap.pending).toBe(7);
    expect(snap.dead).toBe(0);
  });

  test("missing aggregate row throws (driver invariant violation surfaces as tick_failed)", async () => {
    // Per Codex P2: zero-fallback would leak a misleading "queue
    // empty" reading on a sticky pool failure. Throwing forces the
    // existing `lead_outbox.tick_failed` alert path and lets the
    // OTel gauges keep their last-recorded values until the next
    // successful tick.
    const db = makeStubDB({ snapshotRows: [] });
    await expect(queryDepthSnapshot(db)).rejects.toThrow(
      /driver\/pool invariant violated/,
    );
  });

  test("NaN/Infinity count clamps to 0 with structured warn (defensive path)", async () => {
    const db = makeStubDB({
      snapshotRows: [
        { pending_count: Number.NaN, dead_count: 0, oldest_pending_at: null },
      ],
    });
    const snap = await queryDepthSnapshot(db);
    expect(snap.pending).toBe(0);
    expect(snap.dead).toBe(0);
  });

  test("non-integer count string clamps to 0", async () => {
    const db = makeStubDB({
      snapshotRows: [
        { pending_count: "not-a-number", dead_count: "5", oldest_pending_at: null },
      ],
    });
    const snap = await queryDepthSnapshot(db);
    expect(snap.pending).toBe(0);
    expect(snap.dead).toBe(5);
  });

  test("unparseable oldest_pending_at string yields null without throwing", async () => {
    const db = makeStubDB({
      snapshotRows: [
        { pending_count: "1", dead_count: "0", oldest_pending_at: "garbage-timestamp" },
      ],
    });
    const snap = await queryDepthSnapshot(db);
    expect(snap.pending).toBe(1);
    expect(snap.oldestPendingCreatedAt).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────
//  OutboxWarnRateLimiter
// ─────────────────────────────────────────────────────────────────────

describe("OutboxWarnRateLimiter", () => {
  const baseTime = 1_700_000_000_000;
  const oldestPending = new Date(baseTime - 5 * 60_000);

  function snap(pending: number): OutboxDepthSnapshot {
    return {
      pending,
      dead: 0,
      oldestPendingCreatedAt: pending > 0 ? oldestPending : null,
    };
  }

  test("returns null when pending equals threshold (strictly greater required)", () => {
    const limiter = new OutboxWarnRateLimiter(100);
    expect(limiter.evaluate(snap(100), baseTime)).toBeNull();
    expect(limiter.evaluate(snap(99), baseTime)).toBeNull();
  });

  test("first cross-threshold evaluation emits with age in ms", () => {
    const limiter = new OutboxWarnRateLimiter(100);
    const decision = limiter.evaluate(snap(101), baseTime);
    expect(decision).not.toBeNull();
    expect(decision!.depth).toBe(101);
    expect(decision!.threshold).toBe(100);
    expect(decision!.oldestPendingCreatedAt).toBe(oldestPending);
    expect(decision!.oldestPendingAgeMs).toBe(5 * 60_000);
  });

  test("second evaluation within 60s window is suppressed", () => {
    const limiter = new OutboxWarnRateLimiter(100);
    expect(limiter.evaluate(snap(101), baseTime)).not.toBeNull();
    expect(limiter.evaluate(snap(150), baseTime + 5_000)).toBeNull();
    expect(limiter.evaluate(snap(500), baseTime + WARN_INTERVAL_MS - 1)).toBeNull();
  });

  test("strict-less-than window: -1ms suppresses, exact boundary and +1ms re-emit", () => {
    const limiter = new OutboxWarnRateLimiter(100);
    limiter.evaluate(snap(101), baseTime);
    // Gate is `now - lastWarnAt < intervalMs`. Strict less-than → equality
    // is OUTSIDE the window and re-emits. This matches the "elapsed
    // interval = ready to fire again" convention.
    expect(limiter.evaluate(snap(101), baseTime + WARN_INTERVAL_MS - 1)).toBeNull();
    expect(limiter.evaluate(snap(101), baseTime + WARN_INTERVAL_MS)).not.toBeNull();
    // Reset internal lastWarnAt to baseTime (we just emitted at the boundary)
    // so the +1ms assertion measures the same edge cleanly.
    const fresh = new OutboxWarnRateLimiter(100);
    fresh.evaluate(snap(101), baseTime);
    expect(fresh.evaluate(snap(101), baseTime + WARN_INTERVAL_MS + 1)).not.toBeNull();
  });

  test("falling below threshold then back above re-emits if window has passed", () => {
    const limiter = new OutboxWarnRateLimiter(100);
    limiter.evaluate(snap(101), baseTime);
    expect(limiter.evaluate(snap(0), baseTime + 30_000)).toBeNull(); // below threshold
    expect(limiter.evaluate(snap(150), baseTime + 70_000)).not.toBeNull(); // past window
  });

  test("oldestPendingAgeMs is clamped at 0 (defends against clock skew)", () => {
    const limiter = new OutboxWarnRateLimiter(100);
    const futureOldest = new Date(baseTime + 5_000);
    const decision = limiter.evaluate(
      {
        pending: 101,
        dead: 0,
        oldestPendingCreatedAt: futureOldest,
      },
      baseTime,
    );
    expect(decision!.oldestPendingAgeMs).toBe(0);
  });

  test("snapshot with null oldestPendingCreatedAt yields null age", () => {
    const limiter = new OutboxWarnRateLimiter(100);
    const decision = limiter.evaluate(
      { pending: 101, dead: 0, oldestPendingCreatedAt: null },
      baseTime,
    );
    expect(decision!.oldestPendingAgeMs).toBeNull();
  });

  test("default threshold matches AC #3 (100)", () => {
    expect(DEFAULT_WARN_THRESHOLD).toBe(100);
  });
});

// ─────────────────────────────────────────────────────────────────────
//  getWarnThreshold (env-var parser — AC #3)
// ─────────────────────────────────────────────────────────────────────

/**
 * Save/restore the env var inside try/finally per the CLAUDE.md
 * testing rule: no top-level `process.env.X = ...` at module scope.
 * `getWarnThreshold` reads at call-time, so there is no import-hoist
 * requirement — the wrapper is sufficient and survives the future
 * `bun test --parallel` worker-reuse cutover.
 */
function withEnv<T>(value: string | undefined, fn: () => T): T {
  const KEY = "ATLAS_CRM_OUTBOX_WARN_THRESHOLD";
  const prev = process.env[KEY];
  try {
    if (value === undefined) delete process.env[KEY];
    else process.env[KEY] = value;
    return fn();
  } finally {
    if (prev === undefined) delete process.env[KEY];
    else process.env[KEY] = prev;
  }
}

describe("getWarnThreshold (env-var parser)", () => {
  test("unset env returns DEFAULT_WARN_THRESHOLD", () => {
    expect(withEnv(undefined, () => getWarnThreshold())).toBe(DEFAULT_WARN_THRESHOLD);
  });

  test("valid override is honoured (AC #3 override path)", () => {
    expect(withEnv("200", () => getWarnThreshold())).toBe(200);
    expect(withEnv("50", () => getWarnThreshold())).toBe(50);
  });

  test("non-numeric input falls back to default", () => {
    expect(withEnv("abc", () => getWarnThreshold())).toBe(DEFAULT_WARN_THRESHOLD);
    expect(withEnv("", () => getWarnThreshold())).toBe(DEFAULT_WARN_THRESHOLD);
  });

  test("parseInt-prefix typos like '100abc' fall back to default (not silent 100)", () => {
    // `Number.parseInt("100abc", 10) === 100` — without strict regex
    // validation, operator fat-finger would silently accept the
    // truncation. Verify the stricter `/^-?\d+$/` gate.
    expect(withEnv("100abc", () => getWarnThreshold())).toBe(DEFAULT_WARN_THRESHOLD);
    expect(withEnv("50.5", () => getWarnThreshold())).toBe(DEFAULT_WARN_THRESHOLD);
    expect(withEnv(" 100", () => getWarnThreshold())).toBe(DEFAULT_WARN_THRESHOLD);
  });

  test("below minimum clamps to MIN_WARN_THRESHOLD (zero / negative)", () => {
    // Zero would defeat rate-limiting entirely (warn on every tick),
    // so the clamp at 1 is load-bearing.
    expect(withEnv("0", () => getWarnThreshold())).toBe(MIN_WARN_THRESHOLD);
    expect(withEnv("-5", () => getWarnThreshold())).toBe(MIN_WARN_THRESHOLD);
  });

  test("above maximum clamps to MAX_WARN_THRESHOLD", () => {
    expect(withEnv("2000000", () => getWarnThreshold())).toBe(MAX_WARN_THRESHOLD);
  });
});

// ─────────────────────────────────────────────────────────────────────
//  runOutboxTick
// ─────────────────────────────────────────────────────────────────────

describe("runOutboxTick", () => {
  test("records both gauges from the snapshot, before claiming rows", async () => {
    const oldest = new Date("2026-05-26T10:00:00.000Z");
    const db = makeStubDB({
      snapshotRows: [
        { pending_count: "50", dead_count: "5", oldest_pending_at: oldest },
      ],
      claimRows: [], // idle queue post-snapshot
    });
    const pendingGauge = makeGauge();
    const deadGauge = makeGauge();
    const logger = makeLogger();

    const result = await runOutboxTick({
      db,
      dispatcher: NEVER_DISPATCH,
      batchLimit: 50,
      limiter: new OutboxWarnRateLimiter(100),
      pendingGauge,
      deadGauge,
      logger,
    });

    expect(pendingGauge.values).toEqual([50]);
    expect(deadGauge.values).toEqual([5]);
    expect(result.snapshot.pending).toBe(50);
    expect(result.warned).toBe(false);
    expect(logger.warnCalls).toEqual([]);

    // Order check: snapshot SELECT precedes any UPDATE attempt.
    const snapshotIdx = db.calls.findIndex((c) =>
      /FROM crm_outbox\s+WHERE status IN/i.test(c.sql),
    );
    const claimIdx = db.calls.findIndex((c) => /RETURNING id, event_type/i.test(c.sql));
    expect(snapshotIdx).toBeGreaterThanOrEqual(0);
    expect(claimIdx).toBeGreaterThan(snapshotIdx);
  });

  test("101 pending across two within-window ticks emits exactly one warn", async () => {
    const tickTime = 1_700_000_000_000;
    // `oldest` precedes `tickTime` by 5 min so `oldestPendingAgeMs` is
    // a positive duration (300_000 ms), not the clock-skew clamp.
    const oldest = new Date(tickTime - 5 * 60_000);
    const db = makeStubDB({
      snapshotRows: [
        { pending_count: "101", dead_count: "0", oldest_pending_at: oldest },
      ],
    });
    const pendingGauge = makeGauge();
    const deadGauge = makeGauge();
    const logger = makeLogger();
    const limiter = new OutboxWarnRateLimiter(100);

    // Tick 1: depth 101, should warn.
    const r1 = await runOutboxTick({
      db,
      dispatcher: NEVER_DISPATCH,
      batchLimit: 50,
      limiter,
      pendingGauge,
      deadGauge,
      logger,
      now: () => tickTime,
    });
    expect(r1.warned).toBe(true);
    expect(logger.warnCalls).toHaveLength(1);
    expect(logger.warnCalls[0]!.obj.event).toBe("lead_outbox.depth_threshold_warn");
    expect(logger.warnCalls[0]!.obj.depth).toBe(101);
    expect(logger.warnCalls[0]!.obj.threshold).toBe(100);
    expect(logger.warnCalls[0]!.obj.oldestPendingCreatedAt).toBe(oldest.toISOString());
    // AC #2 requires "depth + oldest pending row's age" — humans read
    // age faster than ISO timestamps, dashboards plot age. Lock the
    // payload field so a destructure-and-forget refactor in
    // `tick.ts:84-94` can't silently drop it.
    expect(typeof logger.warnCalls[0]!.obj.oldestPendingAgeMs).toBe("number");
    expect(logger.warnCalls[0]!.obj.oldestPendingAgeMs).toBe(
      tickTime - oldest.getTime(),
    );

    // Tick 2: still 101, 5s later — still inside the 60s window.
    const r2 = await runOutboxTick({
      db,
      dispatcher: NEVER_DISPATCH,
      batchLimit: 50,
      limiter,
      pendingGauge,
      deadGauge,
      logger,
      now: () => tickTime + 5_000,
    });
    expect(r2.warned).toBe(false);
    expect(logger.warnCalls).toHaveLength(1);

    // Both ticks still recorded the gauge — observability never blinks.
    expect(pendingGauge.values).toEqual([101, 101]);
    expect(deadGauge.values).toEqual([0, 0]);
  });

  test("propagates dispatcher results in `flush` so caller can log claim counts", async () => {
    const dispatchSpy = mock(async () => ({ kind: "ok" as const }));
    const claimRow = {
      id: "row-1",
      event_type: "demo",
      payload: {},
      attempts: 0,
      twenty_person_id: null,
      twenty_note_id: null,
    };
    const db = makeStubDB({
      snapshotRows: [{ pending_count: "1", dead_count: "0", oldest_pending_at: null }],
      claimRows: [claimRow],
    });
    const result = await runOutboxTick({
      db,
      dispatcher: dispatchSpy,
      batchLimit: 50,
      limiter: new OutboxWarnRateLimiter(100),
      pendingGauge: makeGauge(),
      deadGauge: makeGauge(),
      logger: makeLogger(),
    });
    expect(result.flush.claimed).toBe(1);
    expect(result.flush.ok).toBe(1);
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
  });

  test("propagates snapshot errors so the caller's Effect.tryPromise records tick_failed", async () => {
    // Contract from `tick.ts:74`: exceptions from `queryDepthSnapshot`
    // (or `flushBatch`) propagate so the outer `Effect.catchAll` in
    // `layers.ts` logs `lead_outbox.tick_failed`. A future "let's be
    // resilient" refactor that wraps the snapshot in try/catch and
    // returns zeros would silence the transient-DB alert path.
    const db: OutboxDB = {
      query: async () => {
        throw new Error("connection terminated unexpectedly");
      },
    };
    await expect(
      runOutboxTick({
        db,
        dispatcher: NEVER_DISPATCH,
        batchLimit: 50,
        limiter: new OutboxWarnRateLimiter(100),
        pendingGauge: makeGauge(),
        deadGauge: makeGauge(),
        logger: makeLogger(),
      }),
    ).rejects.toThrow("connection terminated unexpectedly");
  });

  test("snapshot under threshold never warns, regardless of depth=threshold edge", async () => {
    const db = makeStubDB({
      snapshotRows: [{ pending_count: "100", dead_count: "0", oldest_pending_at: null }],
    });
    const logger = makeLogger();
    const result = await runOutboxTick({
      db,
      dispatcher: NEVER_DISPATCH,
      batchLimit: 50,
      limiter: new OutboxWarnRateLimiter(100),
      pendingGauge: makeGauge(),
      deadGauge: makeGauge(),
      logger,
    });
    expect(result.warned).toBe(false);
    expect(logger.warnCalls).toEqual([]);
  });
});
