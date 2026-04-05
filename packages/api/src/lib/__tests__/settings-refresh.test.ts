/**
 * Tests for periodic settings refresh (#1092, #1275).
 *
 * Tests refreshSettingsTick() which is called by the SettingsLive Effect
 * fiber in SaaS mode. Layer startup/dispose lifecycle is tested
 * separately in lib/effect/__tests__/layers.test.ts.
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
  refreshSettingsTick,
  _resetSettingsCache,
} = await import("../settings");

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

describe("periodic settings refresh (#1092, #1275)", () => {
  const origDbUrl = process.env.DATABASE_URL;

  beforeEach(() => {
    queryCalls = [];
    queryResults = [];
    queryResultIndex = 0;
    queryThrow = null;
    _resetSettingsCache();
  });

  afterEach(() => {
    if (origDbUrl !== undefined) process.env.DATABASE_URL = origDbUrl;
    else delete process.env.DATABASE_URL;
    _resetPool(null);
    _resetSettingsCache();
  });

  // -------------------------------------------------------------------------
  // refreshSettingsTick
  // -------------------------------------------------------------------------

  it("refreshSettingsTick calls loadSettings and busts live cache", async () => {
    enableInternalDB();

    // Load initial value
    setResults({
      rows: [{ key: "ATLAS_ROW_LIMIT", value: "100", updated_at: "2026-01-01", updated_by: null, org_id: null }],
    });
    await loadSettings();
    expect(getSetting("ATLAS_ROW_LIMIT")).toBe("100");

    // Prime the live cache
    queryResultIndex = 0;
    const initial = await getSettingLive("ATLAS_ROW_LIMIT");
    expect(initial).toBe("100");

    // Simulate DB change
    queryResults = [
      { rows: [{ key: "ATLAS_ROW_LIMIT", value: "200", updated_at: "2026-01-02", updated_by: null, org_id: null }] },
    ];
    queryResultIndex = 0;

    // refreshSettingsTick should re-read DB and bust live cache
    await refreshSettingsTick();

    expect(getSetting("ATLAS_ROW_LIMIT")).toBe("200");

    // getSettingLive should also see the new value (live cache was busted)
    queryResultIndex = 0;
    const updated = await getSettingLive("ATLAS_ROW_LIMIT");
    expect(updated).toBe("200");
  });

  it("refreshSettingsTick handles errors without throwing", async () => {
    enableInternalDB();

    // Load initial value
    setResults({
      rows: [{ key: "ATLAS_ROW_LIMIT", value: "100", updated_at: "2026-01-01", updated_by: null, org_id: null }],
    });
    await loadSettings();

    // Make the next loadSettings call fail
    queryThrow = new Error("connection refused");

    // refreshSettingsTick should not throw (loadSettings handles its own errors)
    await refreshSettingsTick();

    // Old value retained
    expect(getSetting("ATLAS_ROW_LIMIT")).toBe("100");
  });

  it("refreshSettingsTick recovers after a transient DB failure", async () => {
    enableInternalDB();

    // Load initial value
    setResults({
      rows: [{ key: "ATLAS_ROW_LIMIT", value: "100", updated_at: "2026-01-01", updated_by: null, org_id: null }],
    });
    await loadSettings();
    expect(getSetting("ATLAS_ROW_LIMIT")).toBe("100");

    // Simulate DB failure
    queryThrow = new Error("connection refused");
    await refreshSettingsTick();
    expect(getSetting("ATLAS_ROW_LIMIT")).toBe("100"); // old value retained

    // Recover — DB comes back with updated value
    queryThrow = null;
    queryResults = [
      { rows: [{ key: "ATLAS_ROW_LIMIT", value: "300", updated_at: "2026-01-03", updated_by: null, org_id: null }] },
    ];
    queryResultIndex = 0;

    await refreshSettingsTick();
    expect(getSetting("ATLAS_ROW_LIMIT")).toBe("300");
  });

  it("refreshSettingsTick is a no-op when no internal DB", async () => {
    // No DATABASE_URL set — loadSettings is a no-op
    await refreshSettingsTick(); // should not throw
  });
});
