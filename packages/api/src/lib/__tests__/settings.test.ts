/**
 * Unit tests for the settings module.
 *
 * Uses _resetPool(mockPool) injection pattern to avoid mock.module.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { _resetPool, type InternalPool } from "../db/internal";
import {
  getSetting,
  setSetting,
  deleteSetting,
  getAllSettingOverrides,
  loadSettings,
  getSettingsForAdmin,
  getSettingsRegistry,
  _resetSettingsCache,
} from "../settings";

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
  end: async () => {},
  on: () => {},
};

function enableInternalDB() {
  process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
  _resetPool(mockPool);
}

function disableInternalDB() {
  delete process.env.DATABASE_URL;
  _resetPool(null);
}

function setResults(...results: Array<{ rows: Record<string, unknown>[] }>) {
  queryResults = results;
  queryResultIndex = 0;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

describe("settings module", () => {
  const origDbUrl = process.env.DATABASE_URL;
  const origEnvVars: Record<string, string | undefined> = {};

  beforeEach(() => {
    queryCalls = [];
    queryResults = [];
    queryResultIndex = 0;
    queryThrow = null;
    _resetSettingsCache();
    // Save env vars we might modify
    for (const key of ["ATLAS_ROW_LIMIT", "ATLAS_PROVIDER", "ATLAS_LOG_LEVEL"]) {
      origEnvVars[key] = process.env[key];
    }
  });

  afterEach(() => {
    if (origDbUrl !== undefined) process.env.DATABASE_URL = origDbUrl;
    else delete process.env.DATABASE_URL;
    _resetPool(null);
    _resetSettingsCache();
    // Restore env vars
    for (const [key, val] of Object.entries(origEnvVars)) {
      if (val !== undefined) process.env[key] = val;
      else delete process.env[key];
    }
  });

  // ---------------------------------------------------------------------------
  // getSetting — resolution order
  // ---------------------------------------------------------------------------

  describe("getSetting", () => {
    it("returns default when no override and no env var", () => {
      delete process.env.ATLAS_ROW_LIMIT;
      expect(getSetting("ATLAS_ROW_LIMIT")).toBe("1000");
    });

    it("returns env var when set", () => {
      process.env.ATLAS_ROW_LIMIT = "500";
      expect(getSetting("ATLAS_ROW_LIMIT")).toBe("500");
    });

    it("returns DB override over env var", async () => {
      process.env.ATLAS_ROW_LIMIT = "500";
      enableInternalDB();
      setResults({
        rows: [
          { key: "ATLAS_ROW_LIMIT", value: "200", updated_at: "2026-01-01", updated_by: null },
        ],
      });
      await loadSettings();

      expect(getSetting("ATLAS_ROW_LIMIT")).toBe("200");
    });

    it("returns undefined for unknown keys with no env var", () => {
      expect(getSetting("NONEXISTENT_KEY")).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // loadSettings
  // ---------------------------------------------------------------------------

  describe("loadSettings", () => {
    it("returns 0 when no internal DB", async () => {
      disableInternalDB();
      const count = await loadSettings();
      expect(count).toBe(0);
    });

    it("loads rows into cache", async () => {
      enableInternalDB();
      setResults({
        rows: [
          { key: "ATLAS_ROW_LIMIT", value: "42", updated_at: "2026-01-01", updated_by: "admin" },
          { key: "ATLAS_LOG_LEVEL", value: "debug", updated_at: "2026-01-01", updated_by: null },
        ],
      });

      const count = await loadSettings();
      expect(count).toBe(2);
      expect(getSetting("ATLAS_ROW_LIMIT")).toBe("42");
      expect(getSetting("ATLAS_LOG_LEVEL")).toBe("debug");
    });

    it("handles table-not-exist error gracefully", async () => {
      enableInternalDB();
      queryThrow = new Error('relation "settings" does not exist');

      const count = await loadSettings();
      expect(count).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // setSetting
  // ---------------------------------------------------------------------------

  describe("setSetting", () => {
    it("throws when no internal DB", async () => {
      disableInternalDB();
      await expect(setSetting("ATLAS_ROW_LIMIT", "100")).rejects.toThrow(
        "Internal database required",
      );
    });

    it("throws for unknown keys", async () => {
      enableInternalDB();
      await expect(setSetting("NONEXISTENT_KEY", "value")).rejects.toThrow(
        "Unknown setting key",
      );
    });

    it("upserts into DB and updates cache", async () => {
      enableInternalDB();
      setResults({ rows: [] }); // for the upsert query

      await setSetting("ATLAS_ROW_LIMIT", "250", "admin-1");

      expect(queryCalls).toHaveLength(1);
      expect(queryCalls[0].sql).toContain("INSERT INTO settings");
      expect(queryCalls[0].sql).toContain("ON CONFLICT");
      expect(queryCalls[0].params).toEqual(["ATLAS_ROW_LIMIT", "250", "admin-1"]);

      // Cache is updated
      expect(getSetting("ATLAS_ROW_LIMIT")).toBe("250");
    });
  });

  // ---------------------------------------------------------------------------
  // deleteSetting
  // ---------------------------------------------------------------------------

  describe("deleteSetting", () => {
    it("throws when no internal DB", async () => {
      disableInternalDB();
      await expect(deleteSetting("ATLAS_ROW_LIMIT")).rejects.toThrow(
        "Internal database required",
      );
    });

    it("removes from DB and cache, reverts to env var", async () => {
      process.env.ATLAS_ROW_LIMIT = "500";
      enableInternalDB();

      // First set an override
      setResults({ rows: [] }); // upsert
      await setSetting("ATLAS_ROW_LIMIT", "100");
      expect(getSetting("ATLAS_ROW_LIMIT")).toBe("100");

      // Now delete
      setResults({ rows: [] }); // delete
      await deleteSetting("ATLAS_ROW_LIMIT");

      // Should revert to env var
      expect(getSetting("ATLAS_ROW_LIMIT")).toBe("500");
    });
  });

  // ---------------------------------------------------------------------------
  // getAllSettingOverrides
  // ---------------------------------------------------------------------------

  describe("getAllSettingOverrides", () => {
    it("returns empty array when no internal DB", async () => {
      disableInternalDB();
      const result = await getAllSettingOverrides();
      expect(result).toEqual([]);
    });

    it("returns DB rows", async () => {
      enableInternalDB();
      const rows = [
        { key: "ATLAS_ROW_LIMIT", value: "42", updated_at: "2026-01-01", updated_by: "admin" },
      ];
      setResults({ rows });

      const result = await getAllSettingOverrides();
      expect(result).toEqual(rows);
    });
  });

  // ---------------------------------------------------------------------------
  // getSettingsForAdmin
  // ---------------------------------------------------------------------------

  describe("getSettingsForAdmin", () => {
    it("returns all registered settings with source=default", () => {
      // Clear any env vars that might affect the test
      delete process.env.ATLAS_ROW_LIMIT;
      delete process.env.ATLAS_PROVIDER;

      const settings = getSettingsForAdmin();
      expect(settings.length).toBeGreaterThan(0);

      const rowLimit = settings.find((s) => s.key === "ATLAS_ROW_LIMIT");
      expect(rowLimit).toBeDefined();
      expect(rowLimit!.source).toBe("default");
      expect(rowLimit!.currentValue).toBe("1000");
    });

    it("shows env source when env var is set", () => {
      process.env.ATLAS_ROW_LIMIT = "500";
      _resetSettingsCache();

      const settings = getSettingsForAdmin();
      const rowLimit = settings.find((s) => s.key === "ATLAS_ROW_LIMIT");
      expect(rowLimit!.source).toBe("env");
      expect(rowLimit!.currentValue).toBe("500");
    });

    it("shows override source when DB override exists", async () => {
      process.env.ATLAS_ROW_LIMIT = "500";
      enableInternalDB();
      setResults({
        rows: [
          { key: "ATLAS_ROW_LIMIT", value: "200", updated_at: "2026-01-01", updated_by: null },
        ],
      });
      await loadSettings();

      const settings = getSettingsForAdmin();
      const rowLimit = settings.find((s) => s.key === "ATLAS_ROW_LIMIT");
      expect(rowLimit!.source).toBe("override");
      expect(rowLimit!.currentValue).toBe("200");
    });

    it("masks secret values", () => {
      process.env.ANTHROPIC_API_KEY = "sk-ant-very-long-secret-key-value-here";

      const settings = getSettingsForAdmin();
      const apiKey = settings.find((s) => s.key === "ANTHROPIC_API_KEY");
      expect(apiKey!.currentValue).not.toContain("very-long");
      expect(apiKey!.currentValue).toContain("••••");
      expect(apiKey!.secret).toBe(true);

      delete process.env.ANTHROPIC_API_KEY;
    });
  });

  // ---------------------------------------------------------------------------
  // requiresRestart metadata
  // ---------------------------------------------------------------------------

  describe("requiresRestart metadata", () => {
    it("hot-reloadable settings do not have requiresRestart", () => {
      const registry = getSettingsRegistry();
      const hotReloadable = ["ATLAS_ROW_LIMIT", "ATLAS_QUERY_TIMEOUT", "ATLAS_RATE_LIMIT_RPM"];
      for (const key of hotReloadable) {
        const def = registry.find((s) => s.key === key);
        expect(def).toBeDefined();
        expect(def!.requiresRestart).toBeFalsy();
      }
    });

    it("restart-required settings have requiresRestart: true", () => {
      const registry = getSettingsRegistry();
      const restartRequired = [
        "ATLAS_PROVIDER", "ATLAS_MODEL", "ATLAS_LOG_LEVEL",
        "ATLAS_CORS_ORIGIN", "ATLAS_TABLE_WHITELIST",
        "ATLAS_RLS_ENABLED", "ATLAS_RLS_COLUMN", "ATLAS_RLS_CLAIM",
      ];
      for (const key of restartRequired) {
        const def = registry.find((s) => s.key === key);
        expect(def).toBeDefined();
        expect(def!.requiresRestart).toBe(true);
      }
    });

    it("getSettingsForAdmin includes requiresRestart in output", () => {
      const settings = getSettingsForAdmin();
      const rowLimit = settings.find((s) => s.key === "ATLAS_ROW_LIMIT");
      expect(rowLimit!.requiresRestart).toBeFalsy();

      const provider = settings.find((s) => s.key === "ATLAS_PROVIDER");
      expect(provider!.requiresRestart).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // getSetting is used by runtime consumers (sql.ts, middleware.ts)
  // ---------------------------------------------------------------------------

  describe("runtime consumer wiring", () => {
    it("ATLAS_ROW_LIMIT resolves DB override for runtime consumers", async () => {
      enableInternalDB();
      setResults({
        rows: [
          { key: "ATLAS_ROW_LIMIT", value: "50", updated_at: "2026-01-01", updated_by: "admin" },
        ],
      });
      await loadSettings();

      // Simulates what sql.ts does: getSetting("ATLAS_ROW_LIMIT")
      expect(getSetting("ATLAS_ROW_LIMIT")).toBe("50");
    });

    it("ATLAS_QUERY_TIMEOUT resolves DB override for runtime consumers", async () => {
      enableInternalDB();
      setResults({
        rows: [
          { key: "ATLAS_QUERY_TIMEOUT", value: "5000", updated_at: "2026-01-01", updated_by: "admin" },
        ],
      });
      await loadSettings();

      expect(getSetting("ATLAS_QUERY_TIMEOUT")).toBe("5000");
    });

    it("ATLAS_RATE_LIMIT_RPM resolves DB override for runtime consumers", async () => {
      enableInternalDB();
      setResults({
        rows: [
          { key: "ATLAS_RATE_LIMIT_RPM", value: "10", updated_at: "2026-01-01", updated_by: "admin" },
        ],
      });
      await loadSettings();

      expect(getSetting("ATLAS_RATE_LIMIT_RPM")).toBe("10");
    });

    it("setSetting updates cache so runtime consumers see change immediately", async () => {
      enableInternalDB();
      setResults({ rows: [] }); // upsert

      await setSetting("ATLAS_ROW_LIMIT", "77", "admin");
      expect(getSetting("ATLAS_ROW_LIMIT")).toBe("77");
    });
  });
});
