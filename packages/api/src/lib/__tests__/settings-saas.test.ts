/**
 * Settings tests that require SaaS mode (mock.module for config).
 *
 * Covers:
 * - requiresRestart is suppressed in SaaS mode (#1089)
 * - applySettingSideEffect calls setLogLevel in SaaS mode (#1089)
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { _resetPool, type InternalPool } from "../db/internal";

// ---------------------------------------------------------------------------
// Mock pool (same pattern as settings.test.ts)
// ---------------------------------------------------------------------------

let queryCalls: Array<{ sql: string; params?: unknown[] }> = [];
let queryResults: Array<{ rows: Record<string, unknown>[] }> = [];
let queryResultIndex = 0;

const mockPool: InternalPool = {
  query: async (sql: string, params?: unknown[]) => {
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
// Mock config module to return SaaS mode
// ---------------------------------------------------------------------------

mock.module("@atlas/api/lib/config", () => ({
  getConfig: () => ({ deployMode: "saas" }),
  defineConfig: (c: unknown) => c,
}));

// Track setLogLevel calls
let logLevelCalls: Array<{ level: string; result: boolean }> = [];
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
  setLogLevel: (level: string) => {
    const valid = ["trace", "debug", "info", "warn", "error", "fatal"].includes(level);
    logLevelCalls.push({ level, result: valid });
    return valid;
  },
}));

// Import after mocks
const {
  getSettingsForAdmin,
  setSetting,
  _resetSettingsCache,
} = await import("../settings");

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

describe("settings (SaaS mode)", () => {
  const origDbUrl = process.env.DATABASE_URL;
  const origLogLevel = process.env.ATLAS_LOG_LEVEL;

  beforeEach(() => {
    queryCalls = [];
    queryResults = [];
    queryResultIndex = 0;
    logLevelCalls = [];
    _resetSettingsCache();
  });

  afterEach(() => {
    if (origDbUrl !== undefined) process.env.DATABASE_URL = origDbUrl;
    else delete process.env.DATABASE_URL;
    if (origLogLevel !== undefined) process.env.ATLAS_LOG_LEVEL = origLogLevel;
    else delete process.env.ATLAS_LOG_LEVEL;
    _resetPool(null);
    _resetSettingsCache();
  });

  // -------------------------------------------------------------------------
  // requiresRestart in SaaS mode (#1089 gap 6)
  // -------------------------------------------------------------------------

  describe("requiresRestart in SaaS mode", () => {
    it("restart-required settings have requiresRestart suppressed in SaaS mode", () => {
      const settings = getSettingsForAdmin(undefined, true);

      // In SaaS mode, normally-restart-required settings are hot-reloadable
      const provider = settings.find((s) => s.key === "ATLAS_PROVIDER");
      expect(provider).toBeDefined();
      // requiresRestart should be undefined (suppressed) in SaaS mode
      expect(provider!.requiresRestart).toBeFalsy();

      const model = settings.find((s) => s.key === "ATLAS_MODEL");
      expect(model).toBeDefined();
      expect(model!.requiresRestart).toBeFalsy();

      const logLevel = settings.find((s) => s.key === "ATLAS_LOG_LEVEL");
      expect(logLevel).toBeDefined();
      expect(logLevel!.requiresRestart).toBeFalsy();
    });

    it("non-restart settings remain unchanged in SaaS mode", () => {
      const settings = getSettingsForAdmin(undefined, true);

      const rowLimit = settings.find((s) => s.key === "ATLAS_ROW_LIMIT");
      expect(rowLimit).toBeDefined();
      expect(rowLimit!.requiresRestart).toBeFalsy();
    });
  });

  // -------------------------------------------------------------------------
  // applySettingSideEffect in SaaS mode (#1089 gap 5)
  // -------------------------------------------------------------------------

  describe("applySettingSideEffect in SaaS mode", () => {
    it("setSetting ATLAS_LOG_LEVEL calls setLogLevel in SaaS mode", async () => {
      enableInternalDB();
      setResults({ rows: [] }); // for upsert

      await setSetting("ATLAS_LOG_LEVEL", "debug", "admin-1");

      // setLogLevel should have been called with the new level
      expect(logLevelCalls).toHaveLength(1);
      expect(logLevelCalls[0].level).toBe("debug");
      expect(logLevelCalls[0].result).toBe(true);
    });

    it("setSetting for non-side-effect key does not call setLogLevel", async () => {
      enableInternalDB();
      setResults({ rows: [] });

      await setSetting("ATLAS_ROW_LIMIT", "500", "admin-1");

      // No setLogLevel calls
      expect(logLevelCalls).toHaveLength(0);
    });
  });
});
