/**
 * Unit tests for the settings module.
 *
 * Uses _resetPool(mockPool) injection pattern to avoid mock.module.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { _resetPool, type InternalPool } from "../db/internal";
import {
  getSetting,
  getSettingAuto,
  getSettingLive,
  setSetting,
  deleteSetting,
  getAllSettingOverrides,
  loadSettings,
  getSettingsForAdmin,
  getSettingsRegistry,
  getSettingDefinition,
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
  // getSetting — resolution order (no orgId = self-hosted / platform)
  // ---------------------------------------------------------------------------

  describe("getSetting (no orgId)", () => {
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
          { key: "ATLAS_ROW_LIMIT", value: "200", updated_at: "2026-01-01", updated_by: null, org_id: null },
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
  // getSetting — 4-tier fallback with orgId (workspace-scoped settings)
  // ---------------------------------------------------------------------------

  describe("getSetting (4-tier fallback)", () => {
    it("tier 1: returns workspace override when present", async () => {
      process.env.ATLAS_ROW_LIMIT = "999";
      enableInternalDB();
      setResults({
        rows: [
          { key: "ATLAS_ROW_LIMIT", value: "500", updated_at: "2026-01-01", updated_by: null, org_id: null },
          { key: "ATLAS_ROW_LIMIT", value: "100", updated_at: "2026-01-01", updated_by: null, org_id: "org-1" },
        ],
      });
      await loadSettings();

      expect(getSetting("ATLAS_ROW_LIMIT", "org-1")).toBe("100");
    });

    it("tier 2: falls back to platform override when no workspace override", async () => {
      process.env.ATLAS_ROW_LIMIT = "999";
      enableInternalDB();
      setResults({
        rows: [
          { key: "ATLAS_ROW_LIMIT", value: "500", updated_at: "2026-01-01", updated_by: null, org_id: null },
        ],
      });
      await loadSettings();

      expect(getSetting("ATLAS_ROW_LIMIT", "org-1")).toBe("500");
    });

    it("tier 3: falls back to env var when no DB overrides", async () => {
      process.env.ATLAS_ROW_LIMIT = "999";
      enableInternalDB();
      setResults({ rows: [] });
      await loadSettings();

      expect(getSetting("ATLAS_ROW_LIMIT", "org-1")).toBe("999");
    });

    it("tier 4: falls back to default when nothing else set", async () => {
      delete process.env.ATLAS_ROW_LIMIT;
      enableInternalDB();
      setResults({ rows: [] });
      await loadSettings();

      expect(getSetting("ATLAS_ROW_LIMIT", "org-1")).toBe("1000");
    });

    it("platform-scoped settings ignore orgId and resolve normally", async () => {
      process.env.ATLAS_PROVIDER = "openai";
      enableInternalDB();
      setResults({
        rows: [
          { key: "ATLAS_PROVIDER", value: "bedrock", updated_at: "2026-01-01", updated_by: null, org_id: null },
        ],
      });
      await loadSettings();

      // Even with orgId, platform-scoped resolves from platform override
      expect(getSetting("ATLAS_PROVIDER", "org-1")).toBe("bedrock");
    });

    it("different orgs get different workspace overrides", async () => {
      delete process.env.ATLAS_ROW_LIMIT;
      enableInternalDB();
      setResults({
        rows: [
          { key: "ATLAS_ROW_LIMIT", value: "100", updated_at: "2026-01-01", updated_by: null, org_id: "org-1" },
          { key: "ATLAS_ROW_LIMIT", value: "200", updated_at: "2026-01-01", updated_by: null, org_id: "org-2" },
        ],
      });
      await loadSettings();

      expect(getSetting("ATLAS_ROW_LIMIT", "org-1")).toBe("100");
      expect(getSetting("ATLAS_ROW_LIMIT", "org-2")).toBe("200");
      // No org = default (no platform override in this test)
      expect(getSetting("ATLAS_ROW_LIMIT")).toBe("1000");
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

    it("loads rows into cache including org-scoped", async () => {
      enableInternalDB();
      setResults({
        rows: [
          { key: "ATLAS_ROW_LIMIT", value: "42", updated_at: "2026-01-01", updated_by: "admin", org_id: null },
          { key: "ATLAS_LOG_LEVEL", value: "debug", updated_at: "2026-01-01", updated_by: null, org_id: null },
          { key: "ATLAS_ROW_LIMIT", value: "10", updated_at: "2026-01-01", updated_by: null, org_id: "org-1" },
        ],
      });

      const count = await loadSettings();
      expect(count).toBe(3);
      expect(getSetting("ATLAS_ROW_LIMIT")).toBe("42");
      expect(getSetting("ATLAS_ROW_LIMIT", "org-1")).toBe("10");
      expect(getSetting("ATLAS_LOG_LEVEL")).toBe("debug");
    });

    it("handles table-not-exist error gracefully", async () => {
      enableInternalDB();
      queryThrow = new Error('relation "settings" does not exist');

      const count = await loadSettings();
      expect(count).toBe(0);
    });

    it("atomic swap — getSetting sees old values while load is in-flight", async () => {
      enableInternalDB();

      // Load initial data
      setResults({
        rows: [
          { key: "ATLAS_ROW_LIMIT", value: "100", updated_at: "2026-01-01", updated_by: null, org_id: null },
        ],
      });
      await loadSettings();
      expect(getSetting("ATLAS_ROW_LIMIT")).toBe("100");

      // Intercept mock query to read getSetting during the DB await
      let midQueryValue: string | undefined;
      const savedQuery = mockPool.query;
      mockPool.query = async (sql: string, params?: unknown[]) => {
        midQueryValue = getSetting("ATLAS_ROW_LIMIT");
        return savedQuery(sql, params);
      };

      setResults({
        rows: [
          { key: "ATLAS_ROW_LIMIT", value: "200", updated_at: "2026-01-02", updated_by: null, org_id: null },
        ],
      });
      await loadSettings();

      // During the query, old value was still readable (not undefined/default)
      expect(midQueryValue).toBe("100");
      // After load completes, new value is visible
      expect(getSetting("ATLAS_ROW_LIMIT")).toBe("200");

      mockPool.query = savedQuery;
    });

    it("atomic swap — error during reload preserves old cache", async () => {
      enableInternalDB();

      // Load initial data
      setResults({
        rows: [
          { key: "ATLAS_ROW_LIMIT", value: "100", updated_at: "2026-01-01", updated_by: null, org_id: null },
        ],
      });
      await loadSettings();
      expect(getSetting("ATLAS_ROW_LIMIT")).toBe("100");

      // Next load throws
      queryThrow = new Error("connection reset by peer");
      const count = await loadSettings();
      expect(count).toBe(0);

      // Old cache value is still readable (not wiped)
      expect(getSetting("ATLAS_ROW_LIMIT")).toBe("100");
    });

    it("atomic swap — stale entries are removed (full replacement, not merge)", async () => {
      enableInternalDB();

      // Load two entries
      setResults({
        rows: [
          { key: "ATLAS_ROW_LIMIT", value: "100", updated_at: "2026-01-01", updated_by: null, org_id: null },
          { key: "ATLAS_QUERY_TIMEOUT", value: "5000", updated_at: "2026-01-01", updated_by: null, org_id: null },
        ],
      });
      await loadSettings();
      expect(getSetting("ATLAS_ROW_LIMIT")).toBe("100");
      expect(getSetting("ATLAS_QUERY_TIMEOUT")).toBe("5000");

      // Reload with only one entry — the other should fall through to default
      setResults({
        rows: [
          { key: "ATLAS_ROW_LIMIT", value: "200", updated_at: "2026-01-02", updated_by: null, org_id: null },
        ],
      });
      await loadSettings();
      expect(getSetting("ATLAS_ROW_LIMIT")).toBe("200");
      expect(getSetting("ATLAS_QUERY_TIMEOUT")).toBe("30000"); // default
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

    it("upserts platform setting (no orgId) and updates cache", async () => {
      enableInternalDB();
      setResults({ rows: [] }); // for the upsert query

      await setSetting("ATLAS_ROW_LIMIT", "250", "admin-1");

      expect(queryCalls).toHaveLength(1);
      expect(queryCalls[0].sql).toContain("INSERT INTO settings");
      expect(queryCalls[0].sql).toContain("ON CONFLICT");
      expect(queryCalls[0].sql).toContain("org_id IS NULL");
      expect(queryCalls[0].params).toEqual(["ATLAS_ROW_LIMIT", "250", "admin-1"]);

      // Cache is updated
      expect(getSetting("ATLAS_ROW_LIMIT")).toBe("250");
    });

    it("upserts workspace-scoped setting with orgId", async () => {
      enableInternalDB();
      setResults({ rows: [] });

      await setSetting("ATLAS_ROW_LIMIT", "50", "admin-1", "org-1");

      expect(queryCalls).toHaveLength(1);
      expect(queryCalls[0].sql).toContain("org_id IS NOT NULL");
      expect(queryCalls[0].params).toEqual(["ATLAS_ROW_LIMIT", "50", "admin-1", "org-1"]);

      // Workspace-scoped cache entry
      expect(getSetting("ATLAS_ROW_LIMIT", "org-1")).toBe("50");
      // Platform level unaffected (falls to default)
      delete process.env.ATLAS_ROW_LIMIT;
      expect(getSetting("ATLAS_ROW_LIMIT")).toBe("1000");
    });

    it("ignores orgId for platform-scoped settings", async () => {
      enableInternalDB();
      setResults({ rows: [] });

      await setSetting("ATLAS_PROVIDER", "openai", "admin-1", "org-1");

      // Should use the platform upsert (org_id IS NULL)
      expect(queryCalls[0].sql).toContain("org_id IS NULL");
      expect(queryCalls[0].params).toEqual(["ATLAS_PROVIDER", "openai", "admin-1"]);
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

    it("throws for unknown keys", async () => {
      enableInternalDB();
      await expect(deleteSetting("NONEXISTENT_KEY")).rejects.toThrow(
        "Unknown setting key",
      );
    });

    it("removes platform override, reverts to env var", async () => {
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

    it("removes workspace override, falls back to platform override", async () => {
      enableInternalDB();
      // Set platform override
      setResults({ rows: [] });
      await setSetting("ATLAS_ROW_LIMIT", "500");
      // Set workspace override
      setResults({ rows: [] });
      await setSetting("ATLAS_ROW_LIMIT", "100", undefined, "org-1");

      expect(getSetting("ATLAS_ROW_LIMIT", "org-1")).toBe("100");

      // Delete workspace override
      setResults({ rows: [] });
      await deleteSetting("ATLAS_ROW_LIMIT", undefined, "org-1");

      // Falls back to platform override
      expect(getSetting("ATLAS_ROW_LIMIT", "org-1")).toBe("500");
    });

    it("ignores orgId for platform-scoped settings", async () => {
      enableInternalDB();
      setResults({ rows: [] }); // upsert
      await setSetting("ATLAS_PROVIDER", "openai");

      setResults({ rows: [] }); // delete
      await deleteSetting("ATLAS_PROVIDER", undefined, "org-1");

      // Should use org_id IS NULL (platform delete)
      const deleteCall = queryCalls.find((c) => c.sql.includes("DELETE"));
      expect(deleteCall?.sql).toContain("org_id IS NULL");
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

    it("returns all DB rows when no orgId", async () => {
      enableInternalDB();
      const rows = [
        { key: "ATLAS_ROW_LIMIT", value: "42", updated_at: "2026-01-01", updated_by: "admin", org_id: null },
      ];
      setResults({ rows });

      const result = await getAllSettingOverrides();
      expect(result).toEqual(rows);
    });

    it("filters by orgId when provided", async () => {
      enableInternalDB();
      const rows = [
        { key: "ATLAS_ROW_LIMIT", value: "42", updated_at: "2026-01-01", updated_by: "admin", org_id: null },
        { key: "ATLAS_ROW_LIMIT", value: "10", updated_at: "2026-01-01", updated_by: "admin", org_id: "org-1" },
      ];
      setResults({ rows });

      const result = await getAllSettingOverrides("org-1");
      expect(queryCalls[0].sql).toContain("org_id IS NULL OR org_id = $1");
      expect(queryCalls[0].params).toEqual(["org-1"]);
      expect(result).toEqual(rows);
    });
  });

  // ---------------------------------------------------------------------------
  // getSettingsForAdmin
  // ---------------------------------------------------------------------------

  describe("getSettingsForAdmin", () => {
    it("returns workspace-scoped settings by default (fail-closed)", () => {
      delete process.env.ATLAS_ROW_LIMIT;
      delete process.env.ATLAS_PROVIDER;

      const settings = getSettingsForAdmin();
      expect(settings.length).toBeGreaterThan(0);
      // Default (no isPlatformAdmin) only returns workspace-scoped
      expect(settings.every((s) => s.scope === "workspace")).toBe(true);

      const rowLimit = settings.find((s) => s.key === "ATLAS_ROW_LIMIT");
      expect(rowLimit).toBeDefined();
      expect(rowLimit!.source).toBe("default");
      expect(rowLimit!.currentValue).toBe("1000");

      // Platform-scoped settings should NOT be visible
      expect(settings.find((s) => s.key === "ATLAS_PROVIDER")).toBeUndefined();
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
          { key: "ATLAS_ROW_LIMIT", value: "200", updated_at: "2026-01-01", updated_by: null, org_id: null },
        ],
      });
      await loadSettings();

      const settings = getSettingsForAdmin();
      const rowLimit = settings.find((s) => s.key === "ATLAS_ROW_LIMIT");
      expect(rowLimit!.source).toBe("override");
      expect(rowLimit!.currentValue).toBe("200");
    });

    it("masks secret values (platform admin view)", () => {
      process.env.ANTHROPIC_API_KEY = "sk-ant-very-long-secret-key-value-here";

      const settings = getSettingsForAdmin(undefined, true);
      const apiKey = settings.find((s) => s.key === "ANTHROPIC_API_KEY");
      expect(apiKey!.currentValue).not.toContain("very-long");
      expect(apiKey!.currentValue).toContain("••••");
      expect(apiKey!.secret).toBe(true);

      delete process.env.ANTHROPIC_API_KEY;
    });

    it("shows workspace-override source for org-scoped entries", async () => {
      enableInternalDB();
      setResults({
        rows: [
          { key: "ATLAS_ROW_LIMIT", value: "500", updated_at: "2026-01-01", updated_by: null, org_id: null },
          { key: "ATLAS_ROW_LIMIT", value: "100", updated_at: "2026-01-01", updated_by: null, org_id: "org-1" },
        ],
      });
      await loadSettings();

      const settings = getSettingsForAdmin("org-1");
      const rowLimit = settings.find((s) => s.key === "ATLAS_ROW_LIMIT");
      expect(rowLimit!.source).toBe("workspace-override");
      expect(rowLimit!.currentValue).toBe("100");
    });

    it("non-platform-admin sees only workspace-scoped settings", () => {
      const settings = getSettingsForAdmin("org-1", false);
      const allWorkspace = settings.every((s) => s.scope === "workspace");
      expect(allWorkspace).toBe(true);
      expect(settings.length).toBeGreaterThan(0);
      // Should not include platform-only settings like ATLAS_PROVIDER
      expect(settings.find((s) => s.key === "ATLAS_PROVIDER")).toBeUndefined();
    });

    it("platform-admin sees all settings", () => {
      const settings = getSettingsForAdmin("org-1", true);
      expect(settings.find((s) => s.key === "ATLAS_PROVIDER")).toBeDefined();
      expect(settings.find((s) => s.key === "ATLAS_ROW_LIMIT")).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // scope metadata
  // ---------------------------------------------------------------------------

  describe("scope metadata", () => {
    it("workspace-scoped settings have correct scope", () => {
      const workspaceKeys = [
        "ATLAS_ROW_LIMIT", "ATLAS_QUERY_TIMEOUT", "ATLAS_RATE_LIMIT_RPM",
        "ATLAS_SESSION_IDLE_TIMEOUT", "ATLAS_SESSION_ABSOLUTE_TIMEOUT", "ATLAS_AGENT_MAX_STEPS",
      ];
      for (const key of workspaceKeys) {
        const def = getSettingDefinition(key);
        expect(def).toBeDefined();
        expect(def!.scope).toBe("workspace");
      }
    });

    it("platform-scoped settings have correct scope", () => {
      const platformKeys = [
        "ATLAS_PROVIDER", "ATLAS_MODEL", "ATLAS_LOG_LEVEL",
        "ATLAS_RLS_ENABLED", "ATLAS_RLS_COLUMN", "ATLAS_RLS_CLAIM",
        "ATLAS_TABLE_WHITELIST", "ATLAS_CORS_ORIGIN", "ATLAS_BRAND_COLOR",
        "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "DATABASE_URL", "ATLAS_DATASOURCE_URL",
      ];
      for (const key of platformKeys) {
        const def = getSettingDefinition(key);
        expect(def).toBeDefined();
        expect(def!.scope).toBe("platform");
      }
    });
  });

  // ---------------------------------------------------------------------------
  // requiresRestart metadata
  // ---------------------------------------------------------------------------

  describe("requiresRestart metadata", () => {
    it("hot-reloadable settings do not have requiresRestart", () => {
      const registry = getSettingsRegistry();
      const hotReloadable = ["ATLAS_ROW_LIMIT", "ATLAS_QUERY_TIMEOUT", "ATLAS_RATE_LIMIT_RPM", "ATLAS_AGENT_MAX_STEPS"];
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
      // Use platform admin view to see all settings including platform-scoped
      const settings = getSettingsForAdmin(undefined, true);
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
          { key: "ATLAS_ROW_LIMIT", value: "50", updated_at: "2026-01-01", updated_by: "admin", org_id: null },
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
          { key: "ATLAS_QUERY_TIMEOUT", value: "5000", updated_at: "2026-01-01", updated_by: "admin", org_id: null },
        ],
      });
      await loadSettings();

      expect(getSetting("ATLAS_QUERY_TIMEOUT")).toBe("5000");
    });

    it("ATLAS_RATE_LIMIT_RPM resolves DB override for runtime consumers", async () => {
      enableInternalDB();
      setResults({
        rows: [
          { key: "ATLAS_RATE_LIMIT_RPM", value: "10", updated_at: "2026-01-01", updated_by: "admin", org_id: null },
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

  // ---------------------------------------------------------------------------
  // getSettingDefinition
  // ---------------------------------------------------------------------------

  describe("getSettingDefinition", () => {
    it("returns definition for known keys", () => {
      const def = getSettingDefinition("ATLAS_ROW_LIMIT");
      expect(def).toBeDefined();
      expect(def!.key).toBe("ATLAS_ROW_LIMIT");
      expect(def!.scope).toBe("workspace");
    });

    it("returns undefined for unknown keys", () => {
      expect(getSettingDefinition("NONEXISTENT")).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // getSettingAuto — dispatches through the same cache as getSetting
  // ---------------------------------------------------------------------------

  describe("getSettingAuto", () => {
    it("resolves like getSetting for env vars", () => {
      process.env.ATLAS_ROW_LIMIT = "777";
      expect(getSettingAuto("ATLAS_ROW_LIMIT")).toBe("777");
    });

    it("resolves like getSetting for DB overrides", async () => {
      enableInternalDB();
      setResults({
        rows: [
          { key: "ATLAS_ROW_LIMIT", value: "42", updated_at: "2026-01-01", updated_by: null, org_id: null },
        ],
      });
      await loadSettings();
      expect(getSettingAuto("ATLAS_ROW_LIMIT")).toBe("42");
    });

    it("returns default when nothing is set", () => {
      delete process.env.ATLAS_ROW_LIMIT;
      expect(getSettingAuto("ATLAS_ROW_LIMIT")).toBe("1000");
    });
  });

  // ---------------------------------------------------------------------------
  // getSettingLive — TTL cache with DB re-read
  // ---------------------------------------------------------------------------

  describe("getSettingLive", () => {
    it("falls back to getSetting when no internal DB", async () => {
      disableInternalDB();
      process.env.ATLAS_ROW_LIMIT = "123";
      const value = await getSettingLive("ATLAS_ROW_LIMIT");
      expect(value).toBe("123");
    });

    it("re-reads from DB on cache miss", async () => {
      enableInternalDB();
      setResults(
        // First loadSettings call (from getSettingLive)
        { rows: [{ key: "ATLAS_ROW_LIMIT", value: "50", updated_at: "2026-01-01", updated_by: null, org_id: null }] },
      );

      const value = await getSettingLive("ATLAS_ROW_LIMIT");
      expect(value).toBe("50");
      // Should have called the DB
      expect(queryCalls.length).toBeGreaterThanOrEqual(1);
    });

    it("returns cached value on subsequent calls within TTL", async () => {
      enableInternalDB();
      setResults(
        { rows: [{ key: "ATLAS_ROW_LIMIT", value: "50", updated_at: "2026-01-01", updated_by: null, org_id: null }] },
      );

      await getSettingLive("ATLAS_ROW_LIMIT");
      const callCount = queryCalls.length;

      // Second call should use TTL cache — no new DB query
      const value2 = await getSettingLive("ATLAS_ROW_LIMIT");
      expect(value2).toBe("50");
      expect(queryCalls.length).toBe(callCount); // no new queries
    });
  });

  // ---------------------------------------------------------------------------
  // requiresRestart — deploy-mode-aware
  // ---------------------------------------------------------------------------

  describe("requiresRestart in SaaS mode", () => {
    it("restart-required settings show requiresRestart in self-hosted mode", () => {
      // Self-hosted is the default when getConfig() returns null or non-saas
      const settings = getSettingsForAdmin(undefined, true);
      const provider = settings.find((s) => s.key === "ATLAS_PROVIDER");
      expect(provider).toBeDefined();
      // In self-hosted (default), requiresRestart should be true
      expect(provider!.requiresRestart).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // setSetting busts live cache
  // ---------------------------------------------------------------------------

  describe("setSetting live cache invalidation", () => {
    it("busts live cache on write so next read picks up new value", async () => {
      enableInternalDB();
      // Load initial value
      setResults({
        rows: [{ key: "ATLAS_ROW_LIMIT", value: "100", updated_at: "2026-01-01", updated_by: null, org_id: null }],
      });
      await loadSettings();
      // Warm live cache
      await getSettingLive("ATLAS_ROW_LIMIT");

      // Write a new value
      setResults({ rows: [] }); // for upsert
      await setSetting("ATLAS_ROW_LIMIT", "200", "admin");

      // getSetting should reflect the new value immediately (cache was updated)
      expect(getSetting("ATLAS_ROW_LIMIT")).toBe("200");
    });
  });

  // ---------------------------------------------------------------------------
  // deleteSetting busts live cache
  // ---------------------------------------------------------------------------

  describe("deleteSetting live cache invalidation", () => {
    it("busts live cache on delete", async () => {
      enableInternalDB();
      setResults({ rows: [] });
      await setSetting("ATLAS_ROW_LIMIT", "100", "admin");
      expect(getSetting("ATLAS_ROW_LIMIT")).toBe("100");

      setResults({ rows: [] });
      await deleteSetting("ATLAS_ROW_LIMIT", "admin");

      // Should revert to env or default
      delete process.env.ATLAS_ROW_LIMIT;
      expect(getSetting("ATLAS_ROW_LIMIT")).toBe("1000");
    });
  });
});
