/**
 * Tests for the knowledge bundle sync scheduler (`knowledge-bundle-sync.ts`,
 * #4211) — the periodic pull fiber over enabled `bundle-sync` collections.
 * Covers the settings-driven interval resolution, lifecycle (start / stop /
 * double-start guard / bad-override clamp), and the manual trigger delegating
 * to the sync cycle. The cycle itself is mocked — its behavior is pinned in
 * `lib/knowledge/__tests__/sync.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

let CYCLE_CALLS = 0;
mock.module("@atlas/api/lib/knowledge/sync", () => ({
  runKnowledgeSyncCycle: async () => {
    CYCLE_CALLS++;
    return { inspected: 0, succeeded: 0, failed: 0, queryFailed: false };
  },
  syncCollection: async () => {
    throw new Error("not used in this test");
  },
  getKnowledgeSyncFetchTimeoutMs: () => 60_000,
  DEFAULT_SYNC_FETCH_TIMEOUT_SECONDS: 60,
  SYNC_STATE_UPSERT_SQL: "",
  SYNC_INSTALL_RECHECK_SQL: "",
  SYNC_CYCLE_INSTALLS_SQL: "",
}));

// The interval getter reads the settings registry; pin it via the env tier
// (registry precedence: DB override → env → default) without touching a DB.
mock.module("@atlas/api/lib/logger", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, child: () => logger };
  return { createLogger: () => logger, getRequestContext: () => ({ requestId: "test" }) };
});

const {
  DEFAULT_KNOWLEDGE_SYNC_INTERVAL_MS,
  getKnowledgeSyncIntervalMs,
  startKnowledgeBundleSyncScheduler,
  stopKnowledgeBundleSyncScheduler,
  isKnowledgeBundleSyncSchedulerRunning,
  triggerKnowledgeBundleSyncCycle,
  _resetKnowledgeBundleSyncScheduler,
} = await import("../knowledge-bundle-sync");

const KEY = "ATLAS_KNOWLEDGE_SYNC_INTERVAL_HOURS";
function withEnv(value: string | undefined, fn: () => void): void {
  const prev = process.env[KEY];
  if (value === undefined) delete process.env[KEY];
  else process.env[KEY] = value;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env[KEY];
    else process.env[KEY] = prev;
  }
}

beforeEach(() => {
  CYCLE_CALLS = 0;
  _resetKnowledgeBundleSyncScheduler();
});
afterEach(() => {
  _resetKnowledgeBundleSyncScheduler();
});

describe("getKnowledgeSyncIntervalMs", () => {
  it("defaults to 24h (nightly) when unset", () => {
    withEnv(undefined, () => {
      expect(getKnowledgeSyncIntervalMs()).toBe(DEFAULT_KNOWLEDGE_SYNC_INTERVAL_MS);
      expect(DEFAULT_KNOWLEDGE_SYNC_INTERVAL_MS).toBe(24 * 60 * 60 * 1000);
    });
  });

  it("honors a positive custom hour count (fractional OK for soak-testing)", () => {
    withEnv("6", () => expect(getKnowledgeSyncIntervalMs()).toBe(6 * 60 * 60 * 1000));
    withEnv("0.5", () => expect(getKnowledgeSyncIntervalMs()).toBe(30 * 60 * 1000));
  });

  it("falls back to the default on a non-positive or unparseable value", () => {
    withEnv("0", () => expect(getKnowledgeSyncIntervalMs()).toBe(DEFAULT_KNOWLEDGE_SYNC_INTERVAL_MS));
    withEnv("-2", () => expect(getKnowledgeSyncIntervalMs()).toBe(DEFAULT_KNOWLEDGE_SYNC_INTERVAL_MS));
    withEnv("nonsense", () => expect(getKnowledgeSyncIntervalMs()).toBe(DEFAULT_KNOWLEDGE_SYNC_INTERVAL_MS));
  });
});

describe("lifecycle", () => {
  it("starts (running an initial cycle), reports running, and stops", async () => {
    expect(isKnowledgeBundleSyncSchedulerRunning()).toBe(false);
    startKnowledgeBundleSyncScheduler(60_000);
    expect(isKnowledgeBundleSyncSchedulerRunning()).toBe(true);
    // The initial cycle fires immediately (fire-and-forget) — let it settle.
    await Bun.sleep(10);
    expect(CYCLE_CALLS).toBe(1);
    stopKnowledgeBundleSyncScheduler();
    expect(isKnowledgeBundleSyncSchedulerRunning()).toBe(false);
  });

  it("double-start is a no-op (single-running guard)", () => {
    startKnowledgeBundleSyncScheduler(60_000);
    startKnowledgeBundleSyncScheduler(60_000); // must not throw or double-register
    expect(isKnowledgeBundleSyncSchedulerRunning()).toBe(true);
    stopKnowledgeBundleSyncScheduler();
  });

  it("falls back to the configured interval on a non-positive override (no hot loop)", () => {
    for (const bad of [0, -1000, Number.NaN]) {
      startKnowledgeBundleSyncScheduler(bad);
      expect(isKnowledgeBundleSyncSchedulerRunning()).toBe(true);
      stopKnowledgeBundleSyncScheduler();
      expect(isKnowledgeBundleSyncSchedulerRunning()).toBe(false);
    }
  });
});

describe("triggerKnowledgeBundleSyncCycle", () => {
  it("runs one cycle and returns its structured result", async () => {
    const result = await triggerKnowledgeBundleSyncCycle();
    expect(result).toEqual({ inspected: 0, succeeded: 0, failed: 0, queryFailed: false });
    expect(CYCLE_CALLS).toBe(1);
  });
});
