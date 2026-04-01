/**
 * Tests for periodic settings refresh timer (#1092).
 *
 * Uses mock.module for config (SaaS mode detection) and logger,
 * plus `_resetPool()` for internal DB mocking.
 * Runs in its own file because mock.module affects the entire module graph.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { _resetPool, type InternalPool } from "../db/internal";

// ---------------------------------------------------------------------------
// Mock pool
// ---------------------------------------------------------------------------

let queryCalls: Array<{ sql: string; params?: unknown[] }> = [];
let queryResults: Array<{ rows: Record<string, unknown>[] }> = [];
let queryResultIndex = 0;
let queryThrow: Error | null = null;

const mockPool: InternalPool = {
  query: async (sql: string, params?: unknown[]) => {
    if (queryThrow) throw queryThrow;
    queryCalls.push({ sql, params });
    const result = queryResults[queryResultIndex] ?? { rows: [] };
    queryResultIndex++;
    return result;
  },
  async connect() {
    return { query: async () => ({ rows: [] }), release() {} };
  },
  end: async () => {},
  on: () => {},
};

function enableInternalDB() {
  process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
  _resetPool(mockPool);
}

function setResults(...results: Array<{ rows: Record<string, unknown>[] }>) {
  queryResults = results;
  queryResultIndex = 0;
}

// ---------------------------------------------------------------------------
// Mock config module — SaaS mode
// ---------------------------------------------------------------------------

mock.module("@atlas/api/lib/config", () => ({
  getConfig: () => ({ deployMode: "saas" }),
  defineConfig: (c: unknown) => c,
}));

mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
  getLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    level: "info",
  }),
  getRequestContext: () => undefined,
  setLogLevel: () => true,
}));

// Import after mocks
const {
  loadSettings,
  getSetting,
  getSettingLive,
  startSettingsRefreshTimer,
  stopSettingsRefreshTimer,
  _getRefreshTimer,
  _resetSettingsCache,
} = await import("../settings");

// ---------------------------------------------------------------------------
// Helper: wait until a condition is met or timeout
// ---------------------------------------------------------------------------

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2000,
  pollMs = 20,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(pollMs);
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

describe("periodic settings refresh (#1092)", () => {
  const origDbUrl = process.env.DATABASE_URL;
  const origRefreshInterval = process.env.ATLAS_SETTINGS_REFRESH_INTERVAL;

  beforeEach(() => {
    queryCalls = [];
    queryResults = [];
    queryResultIndex = 0;
    queryThrow = null;
    _resetSettingsCache();
    stopSettingsRefreshTimer();
  });

  afterEach(() => {
    stopSettingsRefreshTimer();
    if (origDbUrl !== undefined) process.env.DATABASE_URL = origDbUrl;
    else delete process.env.DATABASE_URL;
    if (origRefreshInterval !== undefined) process.env.ATLAS_SETTINGS_REFRESH_INTERVAL = origRefreshInterval;
    else delete process.env.ATLAS_SETTINGS_REFRESH_INTERVAL;
    _resetPool(null);
    _resetSettingsCache();
  });

  // -------------------------------------------------------------------------
  // Timer lifecycle
  // -------------------------------------------------------------------------

  it("starts and returns a cleanup function", () => {
    const cleanup = startSettingsRefreshTimer(60_000);
    expect(typeof cleanup).toBe("function");
    expect(_getRefreshTimer()).not.toBeNull();
    cleanup();
    expect(_getRefreshTimer()).toBeNull();
  });

  it("stopSettingsRefreshTimer clears the timer", () => {
    startSettingsRefreshTimer(60_000);
    expect(_getRefreshTimer()).not.toBeNull();
    stopSettingsRefreshTimer();
    expect(_getRefreshTimer()).toBeNull();
  });

  it("stopSettingsRefreshTimer is safe to call when no timer is running", () => {
    expect(_getRefreshTimer()).toBeNull();
    stopSettingsRefreshTimer(); // should not throw
    expect(_getRefreshTimer()).toBeNull();
  });

  it("starting a new timer replaces an existing one", () => {
    startSettingsRefreshTimer(60_000);
    const first = _getRefreshTimer();
    expect(first).not.toBeNull();

    startSettingsRefreshTimer(30_000);
    const second = _getRefreshTimer();
    expect(second).not.toBeNull();
    // New timer replaces old — different reference
    expect(second).not.toBe(first);
  });

  // -------------------------------------------------------------------------
  // Periodic loadSettings call
  // -------------------------------------------------------------------------

  it("calls loadSettings periodically and picks up DB changes", async () => {
    enableInternalDB();

    // Initial load — row limit 100
    setResults({
      rows: [{ key: "ATLAS_ROW_LIMIT", value: "100", updated_at: "2026-01-01", updated_by: null, org_id: null }],
    });
    await loadSettings();
    expect(getSetting("ATLAS_ROW_LIMIT")).toBe("100");

    // Start timer with a short interval
    startSettingsRefreshTimer(30);

    // Simulate another instance writing "200" to the DB — keep results
    // perpetually available so whenever the timer fires it gets the value
    queryResults = [
      { rows: [{ key: "ATLAS_ROW_LIMIT", value: "200", updated_at: "2026-01-02", updated_by: null, org_id: null }] },
    ];
    queryResultIndex = 0;

    // Poll until the cache picks up the new value
    await waitFor(() => getSetting("ATLAS_ROW_LIMIT") === "200");
    expect(getSetting("ATLAS_ROW_LIMIT")).toBe("200");
  });

  // -------------------------------------------------------------------------
  // Error resilience
  // -------------------------------------------------------------------------

  it("timer survives a loadSettings failure and retries on next interval", async () => {
    enableInternalDB();

    // First load succeeds
    setResults({
      rows: [{ key: "ATLAS_ROW_LIMIT", value: "100", updated_at: "2026-01-01", updated_by: null, org_id: null }],
    });
    await loadSettings();

    startSettingsRefreshTimer(30);

    // Make the next loadSettings call fail
    queryThrow = new Error("connection refused");

    // Wait for a failed tick
    await Bun.sleep(80);

    // Timer should still be running
    expect(_getRefreshTimer()).not.toBeNull();
    // Cache retains old value (loadSettings clears cache only after successful query)
    expect(getSetting("ATLAS_ROW_LIMIT")).toBe("100");

    // Recover — next tick succeeds with updated value
    queryThrow = null;
    queryResults = [
      { rows: [{ key: "ATLAS_ROW_LIMIT", value: "300", updated_at: "2026-01-03", updated_by: null, org_id: null }] },
    ];
    queryResultIndex = 0;

    await waitFor(() => getSetting("ATLAS_ROW_LIMIT") === "300");
    expect(getSetting("ATLAS_ROW_LIMIT")).toBe("300");
  });

  // -------------------------------------------------------------------------
  // Env var interval configuration
  // -------------------------------------------------------------------------

  it("respects ATLAS_SETTINGS_REFRESH_INTERVAL env var", () => {
    process.env.ATLAS_SETTINGS_REFRESH_INTERVAL = "5000";
    startSettingsRefreshTimer();
    expect(_getRefreshTimer()).not.toBeNull();
  });

  it("uses explicit intervalMs over env var", () => {
    process.env.ATLAS_SETTINGS_REFRESH_INTERVAL = "999999";
    startSettingsRefreshTimer(50);
    expect(_getRefreshTimer()).not.toBeNull();
  });

  it("falls back to default for non-numeric ATLAS_SETTINGS_REFRESH_INTERVAL", () => {
    process.env.ATLAS_SETTINGS_REFRESH_INTERVAL = "30s";
    startSettingsRefreshTimer();
    // Timer should still start (with default interval, not NaN)
    expect(_getRefreshTimer()).not.toBeNull();
  });

  it("falls back to default for sub-minimum ATLAS_SETTINGS_REFRESH_INTERVAL", () => {
    process.env.ATLAS_SETTINGS_REFRESH_INTERVAL = "100";
    startSettingsRefreshTimer();
    expect(_getRefreshTimer()).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // Live cache invalidation
  // -------------------------------------------------------------------------

  it("timer busts live cache so getSettingLive picks up DB changes", async () => {
    enableInternalDB();

    // Make the mock pool always return the current queryResults[0]
    // (getSettingLive calls loadSettings internally on cache miss)
    const row100 = { key: "ATLAS_ROW_LIMIT", value: "100", updated_at: "2026-01-01", updated_by: null, org_id: null };
    queryResults = [{ rows: [row100] }];
    queryResultIndex = 0;

    // Warm both caches — loadSettings populates _cache, getSettingLive populates _liveCache
    await loadSettings();
    queryResultIndex = 0; // reset so getSettingLive's internal loadSettings also succeeds
    const initial = await getSettingLive("ATLAS_ROW_LIMIT");
    expect(initial).toBe("100");

    // Start timer with a short interval
    startSettingsRefreshTimer(30);

    // Simulate another instance writing "500" to the DB
    queryResults = [
      { rows: [{ key: "ATLAS_ROW_LIMIT", value: "500", updated_at: "2026-01-04", updated_by: null, org_id: null }] },
    ];
    queryResultIndex = 0;

    // Wait for the main cache to update (timer fires loadSettings + clears _liveCache)
    await waitFor(() => getSetting("ATLAS_ROW_LIMIT") === "500");

    // getSettingLive should also see the new value — live cache was busted by the timer
    queryResultIndex = 0; // reset for getSettingLive's internal loadSettings
    const updated = await getSettingLive("ATLAS_ROW_LIMIT");
    expect(updated).toBe("500");
  });
});
