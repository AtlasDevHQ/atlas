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
  HOT_RELOADED_KEYS,
  isHotReloadedKey,
  securitySensitiveAuditFields,
  securitySensitiveAuditLine,
  redactAuditValue,
  redactPresentAuditValue,
  settingUpdateResponseBody,
  settingsCacheEverLoaded,
  SECURITY_SENSITIVE_KEYS,
  type SecuritySensitiveKey,
  type SecuritySensitiveAuditInput,
  type SettingDefinition,
  type AuditedValue,
  _resetSettingsCache,
} from "../settings";
import { ANSWER_STYLE_NAMES, isAnswerStyle } from "../answer-styles";

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
    for (const key of ["ATLAS_ROW_LIMIT", "ATLAS_PROVIDER", "ATLAS_LOG_LEVEL", "ATLAS_BRAND_COLOR"]) {
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

    it("ATLAS_BRAND_COLOR defaults to forest (lockstep with brand.css / DEFAULT_BRAND_COLOR)", () => {
      // Pins the settings.ts leg of the four-way brand-color lockstep so a
      // silent reversion to the retired teal is caught here. See ADR-0023 §1.
      delete process.env.ATLAS_BRAND_COLOR;
      expect(getSetting("ATLAS_BRAND_COLOR")).toBe("oklch(0.4 0.115 158)");
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

    // #1978 — SAAS_IMMUTABLE_KEYS rejection only fires in SaaS mode. The
    // SaaS path is covered in settings-saas.test.ts; here the self-hosted
    // path verifies the same write succeeds, so a future regression that
    // accidentally checks SAAS_IMMUTABLE_KEYS without isSaasMode()
    // gating fails the test.
    it("permits writes to SAAS_IMMUTABLE_KEYS in self-hosted mode", async () => {
      enableInternalDB();
      setResults({ rows: [] });

      await expect(
        setSetting("ATLAS_EMAIL_PROVIDER", "sendgrid", "admin-1"),
      ).resolves.toBeUndefined();

      // Cache reflects the write.
      expect(getSetting("ATLAS_EMAIL_PROVIDER")).toBe("sendgrid");
    });

    // #4462 — RESEND_API_KEY and ATLAS_PROVIDER joined SAAS_IMMUTABLE_KEYS.
    // Self-hosted must stay runtime-editable: the DPA guard early-returns
    // outside SaaS, and the proactive provider guard is SaaS-only too.
    it("permits writes to the #4462 immutable keys in self-hosted mode", async () => {
      enableInternalDB();
      setResults({ rows: [] });

      await expect(
        setSetting("RESEND_API_KEY", "re_local", "admin-1"),
      ).resolves.toBeUndefined();
      expect(getSetting("RESEND_API_KEY")).toBe("re_local");

      setResults({ rows: [] });
      await expect(
        setSetting("ATLAS_PROVIDER", "openai", "admin-1"),
      ).resolves.toBeUndefined();
      expect(getSetting("ATLAS_PROVIDER")).toBe("openai");
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

    // #3389 — mirror of the setSetting self-hosted test above: the delete
    // guard must stay isSaasModeForGuard()-gated, so clearing an immutable
    // key's override outside SaaS keeps working. SaaS rejection is covered
    // in settings-saas.test.ts.
    it("permits deletes of SAAS_IMMUTABLE_KEYS overrides in self-hosted mode", async () => {
      enableInternalDB();
      setResults({ rows: [] });

      await expect(
        deleteSetting("ATLAS_EMAIL_PROVIDER", "admin-1"),
      ).resolves.toBeUndefined();
    });

    // #4462 — same mirror for the two keys added in #4462.
    it("permits deletes of the #4462 immutable keys in self-hosted mode", async () => {
      enableInternalDB();
      setResults({ rows: [] });

      await expect(
        deleteSetting("RESEND_API_KEY", "admin-1"),
      ).resolves.toBeUndefined();
      await expect(
        deleteSetting("ATLAS_PROVIDER", "admin-1"),
      ).resolves.toBeUndefined();
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

    // #4669 — platform tier of workspace-scoped keys for the platform
    // console: the caller's own workspace override must NOT mask the
    // global row the operator is managing.
    describe("platform tier of workspace-scoped keys (#4669)", () => {
      it("platform-admin view surfaces the global row even when the caller's workspace overrides it", async () => {
        enableInternalDB();
        setResults({
          rows: [
            { key: "ATLAS_ROW_LIMIT", value: "500", updated_at: "2026-01-01", updated_by: null, org_id: null },
            { key: "ATLAS_ROW_LIMIT", value: "100", updated_at: "2026-01-01", updated_by: null, org_id: "org-1" },
          ],
        });
        await loadSettings();

        const settings = getSettingsForAdmin("org-1", true);
        const rowLimit = settings.find((s) => s.key === "ATLAS_ROW_LIMIT");
        expect(rowLimit).toBeDefined();
        // Workspace-resolved view is unchanged...
        expect(rowLimit!.source).toBe("workspace-override");
        expect(rowLimit!.currentValue).toBe("100");
        // ...while the platform tier shows the global row.
        expect(rowLimit!.platformSource).toBe("override");
        expect(rowLimit!.platformValue).toBe("500");
      });

      it("platformSource falls back to env, then default", () => {
        process.env.ATLAS_ROW_LIMIT = "500";
        _resetSettingsCache();
        let rowLimit = getSettingsForAdmin("org-1", true).find((s) => s.key === "ATLAS_ROW_LIMIT");
        expect(rowLimit!.platformSource).toBe("env");
        expect(rowLimit!.platformValue).toBe("500");

        delete process.env.ATLAS_ROW_LIMIT;
        rowLimit = getSettingsForAdmin("org-1", true).find((s) => s.key === "ATLAS_ROW_LIMIT");
        expect(rowLimit!.platformSource).toBe("default");
        expect(rowLimit!.platformValue).toBe("1000");
      });

      it("a key with no registry default resolves platformSource 'default' with platformValue undefined", () => {
        // Pins the wire shape the platform console renders as "not set":
        // the row still appears (platformSource present) but carries no
        // value. ATLAS_SANDBOX_URL is workspace-scoped with no default.
        const origSandboxUrl = process.env.ATLAS_SANDBOX_URL;
        delete process.env.ATLAS_SANDBOX_URL;
        try {
          const sandboxUrl = getSettingsForAdmin("org-1", true).find((s) => s.key === "ATLAS_SANDBOX_URL");
          expect(sandboxUrl).toBeDefined();
          expect(sandboxUrl!.platformSource).toBe("default");
          expect(sandboxUrl!.platformValue).toBeUndefined();
        } finally {
          if (origSandboxUrl !== undefined) process.env.ATLAS_SANDBOX_URL = origSandboxUrl;
          else delete process.env.ATLAS_SANDBOX_URL;
        }
      });

      it("platform fields are omitted from the non-platform-admin view", () => {
        const rowLimit = getSettingsForAdmin("org-1", false).find((s) => s.key === "ATLAS_ROW_LIMIT");
        expect(rowLimit!.platformSource).toBeUndefined();
        expect(rowLimit!.platformValue).toBeUndefined();
      });

      it("platform-scoped keys never carry platform fields (currentValue already IS the platform tier)", () => {
        const provider = getSettingsForAdmin("org-1", true).find((s) => s.key === "ATLAS_PROVIDER");
        expect(provider!.platformSource).toBeUndefined();
        expect(provider!.platformValue).toBeUndefined();
      });
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
        // #3392 — read per proposal via getSetting(key, orgId) in
        // lib/db/internal.ts, so the workspace override is honored.
        "ATLAS_EXPERT_AUTO_APPROVE_THRESHOLD", "ATLAS_EXPERT_AUTO_APPROVE_TYPES",
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
        // #3392 — the expert scheduler is one process-global boot-time
        // fiber; no per-workspace tick exists, so these are platform-scoped.
        "ATLAS_EXPERT_SCHEDULER_ENABLED", "ATLAS_EXPERT_SCHEDULER_INTERVAL_HOURS",
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
      const hotReloadable = ["ATLAS_ROW_LIMIT", "ATLAS_QUERY_TIMEOUT", "ATLAS_AGENT_MAX_STEPS"];
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
        // ATLAS_RATE_LIMIT_RPM moved here in #1983 — pairs with
        // RateLimitGuardLive at boot. Hot-reloading would re-open
        // the DDoS hole until next restart.
        "ATLAS_RATE_LIMIT_RPM",
        // #3392/#3399 — the expert scheduler is a single process-global
        // fiber forked once at boot; both keys are consumed only there,
        // so they need a restart in BOTH deploy modes.
        "ATLAS_EXPERT_SCHEDULER_ENABLED", "ATLAS_EXPERT_SCHEDULER_INTERVAL_HOURS",
        // #4130 — billing scheduler cadences: same boot-consumed shape as
        // the expert scheduler pair (interval resolved when the fiber forks).
        "ATLAS_BILLING_RECONCILE_INTERVAL_HOURS", "ATLAS_UNCLAIMED_GRACE_REAP_INTERVAL_HOURS",
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
  // ATLAS_DEFAULT_ANSWER_STYLE — the workspace "house voice" (#4303, PRD #4292)
  // ---------------------------------------------------------------------------

  describe("Knowledge Base ingest-cap registry entries (#4235)", () => {
    // The ABSENCE of a static `default` on these two keys is load-bearing, not
    // an oversight: `getSetting`'s precedence is override → env → registry
    // default, so a static default would SHADOW the deploy-mode-aware fallback
    // in `lib/knowledge/ingest-limits.ts` and silently clamp the SaaS ceiling
    // back to the self-hosted 25 MB / 1000 docs — re-capping the Business tier
    // at a quarter of what it was sold, with a fully green suite (the
    // ingest-limits tests mock `getSettingAuto` wholesale and cannot see it).
    // Same pattern as ATLAS_RATE_LIMIT_RPM.
    it.each([
      ["ATLAS_KNOWLEDGE_INGEST_MAX_DOCS"],
      ["ATLAS_KNOWLEDGE_INGEST_MAX_BUNDLE_BYTES"],
    ])("%s carries NO static default (the resolver owns it)", (key) => {
      const def = getSettingDefinition(key);
      expect(def).toBeDefined();
      expect(def!.scope).toBe("platform");
      expect(def!.default).toBeUndefined();
    });

    it("keeps a static default on the per-document cap — it is not deploy-mode-aware", () => {
      // Platform-only by design: an abuse guardrail on one row, never a
      // pricing lever, so it has no tier half and no SaaS ceiling to reach.
      const def = getSettingDefinition("ATLAS_KNOWLEDGE_INGEST_MAX_DOC_BYTES");
      expect(def).toBeDefined();
      expect(def!.default).toBe("1000000");
    });
  });

  describe("ATLAS_DEFAULT_ANSWER_STYLE registry entry (#4303)", () => {
    it("is a workspace-scoped, hot-reloadable select with no built-in default", () => {
      const def = getSettingDefinition("ATLAS_DEFAULT_ANSWER_STYLE");
      expect(def).toBeDefined();
      expect(def!.scope).toBe("workspace");
      expect(def!.type).toBe("select");
      // Pins the env-tier spelling for self-hosted deployments (the registry
      // requires an envVar; nothing requires the var to be set).
      expect(def!.envVar).toBe("ATLAS_DEFAULT_ANSWER_STYLE");
      // Hot-reloadable: the agent loop reads it per turn through the settings
      // cache — a restart hint would contradict the no-redeploy contract.
      expect(def!.requiresRestart).toBeFalsy();
      // No registry default: unset means "fall through to the surface
      // default" (analyst for web/SDK/MCP, conversational for chat
      // platforms), NOT a frozen copy of one of them.
      expect(def!.default).toBeUndefined();
    });

    it("offers every registered style except conversational (drift lock against the answer-style registry)", () => {
      const def = getSettingDefinition("ATLAS_DEFAULT_ANSWER_STYLE");
      // conversational is the chat-platform voice — its addendum references
      // Slack progressive-disclosure buttons that don't exist on the
      // analyst-grade surfaces this default applies to, so it is not offered
      // as a house voice. Everything else in the registry is.
      expect(def!.options).toEqual(
        ANSWER_STYLE_NAMES.filter((s) => s !== "conversational"),
      );
      // Every offered option must be a registry style — a token the resolver
      // would reject can never be a legal admin choice.
      for (const opt of def!.options ?? []) {
        expect(isAnswerStyle(opt)).toBe(true);
      }
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
  // saasVisible / saasWritable metadata (#3376)
  // ---------------------------------------------------------------------------

  describe("saasVisible / saasWritable metadata (#3376)", () => {
    // Pins the split-axis flags on the real registry: the SaaS
    // /admin/sandbox page saves these keys through the generic
    // PUT /admin/settings/{key} route, which rejects writes when the
    // effective saasWritable (saasWritable ?? saasVisible ?? true) is
    // false. If either flag drifts, the sandbox page's save path on
    // SaaS breaks (#3375 regression vector).
    it("ATLAS_SANDBOX_BACKEND is hidden from the generic page but writable on SaaS", () => {
      const def = getSettingDefinition("ATLAS_SANDBOX_BACKEND");
      expect(def).toBeDefined();
      expect(def!.saasVisible).toBe(false);
      expect(def!.saasWritable).toBe(true);
    });

    it("ATLAS_SANDBOX_URL inherits un-writability — only the self-hosted view writes it (#3390 review)", () => {
      const def = getSettingDefinition("ATLAS_SANDBOX_URL");
      expect(def).toBeDefined();
      expect(def!.saasVisible).toBe(false);
      expect(def!.saasWritable).toBeUndefined();
    });

    it("ATLAS_DEMO_INDUSTRY inherits un-writability from saasVisible: false", () => {
      const def = getSettingDefinition("ATLAS_DEMO_INDUSTRY");
      expect(def).toBeDefined();
      expect(def!.saasVisible).toBe(false);
      // No explicit saasWritable — effective writability inherits the
      // hidden flag, so SaaS workspace admins cannot write it.
      expect(def!.saasWritable).toBeUndefined();
    });

    it("only dedicated-page keys split the axes (saasVisible: false + saasWritable: true)", () => {
      const splitKeys = getSettingsRegistry()
        .filter((s) => s.saasVisible === false && s.saasWritable === true)
        .map((s) => s.key)
        .toSorted();
      // Append here ONLY when a dedicated SaaS admin page is the writer
      // for the key (parity contract Rule 4, enterprise-gating.md).
      // ATLAS_CACHE_ENABLED / ATLAS_CACHE_TTL: the /admin/cache page writes
      // them inline (#4545). ATLAS_SANDBOX_BACKEND: the /admin/sandbox page.
      expect(splitKeys).toEqual([
        "ATLAS_CACHE_ENABLED",
        "ATLAS_CACHE_TTL",
        "ATLAS_SANDBOX_BACKEND",
      ]);
    });

    // #4545 — the three Query Cache knobs. Scope is load-bearing: it decides
    // who can tune each knob. ENABLED/TTL are per-workspace; MAX_SIZE is
    // platform-wide (one process-global LRU) and must never become
    // workspace-scoped (which would let a tenant resize the shared backend).
    it("ATLAS_CACHE_ENABLED / ATLAS_CACHE_TTL are workspace-scoped", () => {
      for (const key of ["ATLAS_CACHE_ENABLED", "ATLAS_CACHE_TTL"]) {
        const def = getSettingDefinition(key);
        expect(def).toBeDefined();
        expect(def!.scope).toBe("workspace");
      }
    });

    it("ATLAS_CACHE_MAX_SIZE is platform-scoped, hidden, and not workspace-writable", () => {
      const def = getSettingDefinition("ATLAS_CACHE_MAX_SIZE");
      expect(def).toBeDefined();
      expect(def!.scope).toBe("platform");
      expect(def!.saasVisible).toBe(false);
      // No explicit saasWritable — a platform key is never workspace-writable.
      expect(def!.saasWritable).toBeUndefined();
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

    // #3399 — self-hosted shows the hint for EVERY flagged key, including
    // keys that would be hot-reloaded on SaaS (applySettingSideEffect is
    // SaaS-gated, so ATLAS_LOG_LEVEL still needs a restart here) and the
    // boot-consumed scheduler pair (#3392).
    it("self-hosted keeps requiresRestart: true for hot-reloaded and boot-consumed flagged keys alike", () => {
      const settings = getSettingsForAdmin(undefined, true);
      for (const key of [
        "ATLAS_LOG_LEVEL",
        "ATLAS_EXPERT_SCHEDULER_ENABLED",
        "ATLAS_EXPERT_SCHEDULER_INTERVAL_HOURS",
      ]) {
        const setting = settings.find((s) => s.key === key);
        expect(setting).toBeDefined();
        expect(setting!.requiresRestart).toBe(true);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // HOT_RELOADED_KEYS — single source of truth for the SaaS suppression (#3399)
  // ---------------------------------------------------------------------------

  describe("HOT_RELOADED_KEYS (#3399)", () => {
    it("contains exactly the keys applySettingSideEffect dispatches on", () => {
      // Pin the set's contents: it is derived from SETTING_SIDE_EFFECTS in
      // settings.ts, so this only changes when a side-effect handler is
      // added/removed — which is exactly when the SaaS requiresRestart
      // suppression should widen/narrow with it.
      expect([...HOT_RELOADED_KEYS].toSorted()).toEqual(["ATLAS_LOG_LEVEL"]);
    });

    it("isHotReloadedKey matches the set", () => {
      expect(isHotReloadedKey("ATLAS_LOG_LEVEL")).toBe(true);
      expect(isHotReloadedKey("ATLAS_EXPERT_SCHEDULER_ENABLED")).toBe(false);
      expect(isHotReloadedKey("ATLAS_EXPERT_SCHEDULER_INTERVAL_HOURS")).toBe(false);
      expect(isHotReloadedKey("NONEXISTENT_KEY")).toBe(false);
    });

    it("every hot-reloaded key is restart-flagged in the registry (suppression has a target)", () => {
      // A side-effect handler on a non-flagged key would be dead suppression
      // logic — the registry never sets the hint for it in the first place.
      const registry = getSettingsRegistry();
      for (const key of HOT_RELOADED_KEYS) {
        const def = registry.find((s) => s.key === key);
        expect(def).toBeDefined();
        expect(def!.requiresRestart).toBe(true);
      }
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

// #3797 — runtime changes to abuse-control thresholds emit a security-audit
// warn. The decision (which keys, and whether a value disables the control) is
// a pure function, tested here without DB/logger plumbing.
describe("securitySensitiveAuditFields (#3797)", () => {
  it("includes both start_trial RPM limiters in the sensitive set", () => {
    expect(SECURITY_SENSITIVE_KEYS.has("ATLAS_TRIAL_IP_RATE_LIMIT_RPM")).toBe(true);
    expect(SECURITY_SENSITIVE_KEYS.has("ATLAS_TRIAL_EMAIL_RATE_LIMIT_RPM")).toBe(true);
  });

  it("returns null (no audit) for a non-sensitive key", () => {
    expect(securitySensitiveAuditFields("ATLAS_ROW_LIMIT", "set", "0")).toBeNull();
  });

  it("audits a normal change without flagging disablesControl", () => {
    expect(securitySensitiveAuditFields("ATLAS_TRIAL_IP_RATE_LIMIT_RPM", "set", "10")).toEqual({
      disablesControl: false,
      widensAuthority: false,
    });
  });

  it("flags disablesControl when set to the 0 disabled-sentinel", () => {
    expect(securitySensitiveAuditFields("ATLAS_TRIAL_EMAIL_RATE_LIMIT_RPM", "set", "0")).toEqual({
      disablesControl: true,
      widensAuthority: false,
    });
  });

  // ⚠️ THIS ROW USED TO ASSERT THE OPPOSITE, and it was wrong about the reader.
  // `parseRpm` returns the shipped DEFAULT on a non-finite value, so `"off"`
  // leaves the limiter running at 5rpm — nothing was disabled, and flagging it
  // trains an incident responder to discount the one signal that says an abuse
  // control went away. The written value still rides in the log line — these
  // keys carry no `secret` flag, so #5180's redaction leaves them verbatim —
  // and a garbled write is therefore not invisible; it is just not a *disable*.
  it("does NOT flag disablesControl on a non-finite value — the reader keeps the default", () => {
    expect(securitySensitiveAuditFields("ATLAS_TRIAL_IP_RATE_LIMIT_RPM", "set", "off")).toEqual({
      disablesControl: false,
      widensAuthority: false,
    });
  });

  // The audit must agree with `trial-abuse.ts`'s `parseRpm` about what a value
  // MEANS, exactly as the alias threshold agrees with `aliasAutoApproveThreshold`.
  // Review measured this table against both implementations. FIVE rows are
  // ones the pre-#5161 rule got wrong: `0.9`/`0.4`/`1e-9` as false negatives
  // (the reader floors them to the disabled sentinel) and `off`/`abc` as false
  // alarms (the reader keeps its default). `-1` and `""` it happened to get
  // right, for the wrong reason.
  it.each([
    // [written, reader's effective limit, disablesControl]
    ["0", "0 — the disabled sentinel", true],
    ["", "0 (Number('') is 0)", true],
    // parseRpm FLOORS, so a sub-1 value silently disables the limiter.
    ["0.9", "0 (floored)", true],
    ["0.4", "0 (floored)", true],
    ["1e-9", "0 (floored)", true],
    // Non-finite and negative both fall back to the shipped default: ON.
    ["off", "5 (fallback — control stays ON)", false],
    ["abc", "5 (fallback — control stays ON)", false],
    ["-1", "5 (fallback — control stays ON)", false],
    ["5", "5", false],
    ["1", "1", false],
  ])("rpm %p → reader applies %s → disablesControl=%p", (written, _effect, expected) => {
    expect(securitySensitiveAuditFields("ATLAS_TRIAL_IP_RATE_LIMIT_RPM", "set", written)).toEqual({
      disablesControl: expected,
      widensAuthority: false,
    });
  });

  it("audits a clear without flagging disablesControl (revert is value-unknown)", () => {
    expect(securitySensitiveAuditFields("ATLAS_TRIAL_IP_RATE_LIMIT_RPM", "clear", undefined)).toEqual({
      disablesControl: false,
      widensAuthority: false,
    });
  });
});

// #5161 — the two alias auto-approve knobs joined the audited set. They weaken
// in the OPPOSITE direction from the abuse thresholds above: the empty value is
// the SAFE end (everything queues for review), so the numeric `0`/non-finite
// disable rule would have flagged the safest possible write as a disable and
// fired `disablesControl: true` on every string write to the source list. That
// inversion is what these tests pin.
describe("securitySensitiveAuditFields — alias auto-approve authority (#5161)", () => {
  // Typed as the closed union, so a typo or a stale key name is a compile
  // error rather than a test that quietly asserts nothing about a key that no
  // longer exists. This is also `SecuritySensitiveKey`'s only consumer — an
  // exported type with no user OUTSIDE its own module is a claim nothing
  // checks — `SECURITY_SENSITIVE_RULES` and `isSecuritySensitiveKey` consume it
  // inside settings.ts, which is what makes it load-bearing there.
  const SOURCES: SecuritySensitiveKey = "ATLAS_BRAIN_ALIAS_AUTO_APPROVE_SOURCES";
  const THRESHOLD: SecuritySensitiveKey = "ATLAS_BRAIN_ALIAS_AUTO_APPROVE_THRESHOLD";
  const ABUSE_THRESHOLD_KEYS: SecuritySensitiveKey[] = [
    "ATLAS_TRIAL_IP_RATE_LIMIT_RPM",
    "ATLAS_TRIAL_EMAIL_RATE_LIMIT_RPM",
  ];
  const AUTHORITY_KEYS: SecuritySensitiveKey[] = [SOURCES, THRESHOLD];

  it("includes both alias auto-approve keys in the sensitive set", () => {
    expect(SECURITY_SENSITIVE_KEYS.has(SOURCES)).toBe(true);
    expect(SECURITY_SENSITIVE_KEYS.has(THRESHOLD)).toBe(true);
  });

  it("every sensitive key is classified into exactly one family", () => {
    // The two families weaken in OPPOSITE directions, so a key that belongs to
    // neither list is a key whose audit direction nobody decided. The dispatch
    // table makes omitting a RULE a compile error; this makes omitting the
    // THOUGHT a test failure, in both directions.
    // Widened to `string[]` on purpose: the comparison is against
    // `SECURITY_SENSITIVE_KEYS`, which is a `ReadonlySet<string>`, and the
    // point of the test is that the two AGREE — narrowing this side to the
    // union would make one half of the comparison the thing being checked.
    const classified: string[] = [...ABUSE_THRESHOLD_KEYS, ...AUTHORITY_KEYS].sort();
    expect(classified).toEqual([...SECURITY_SENSITIVE_KEYS].sort());
    expect(new Set(classified).size).toBe(classified.length);
  });

  it("every sensitive key exists in the settings registry", () => {
    // The compiler ties the key literal to the RULES table; nothing ties it to
    // the registry. A renamed registry key would silently stop being audited —
    // `isSecuritySensitiveKey` returns false, no line is ever emitted again,
    // and every test above still passes because they all pass literals in.
    for (const key of SECURITY_SENSITIVE_KEYS) {
      expect(getSettingDefinition(key)).toBeDefined();
    }
  });

  // ⚠️ The partition test above proves each key was CLASSIFIED. It cannot prove
  // it was classified CORRECTLY — `Record<SecuritySensitiveKey, Rule>` demands
  // *a* rule, not the right one, so a fifth key wired to the wrong family by
  // copy-paste compiles clean and passes the partition. These drive the
  // behaviour off the family arrays, so a new key inherits its family's claim
  // instead of needing someone to remember to write one.
  it.each(ABUSE_THRESHOLD_KEYS)("%s treats a floored zero as the disabled sentinel", (key) => {
    expect(securitySensitiveAuditFields(key, "set", "0")).toEqual({
      disablesControl: true,
      widensAuthority: false,
    });
  });

  it.each(AUTHORITY_KEYS)("%s never reports disablesControl — its safe end is empty", (key) => {
    // `Number("0")` is 0, so an authority key wired to the abuse rule by
    // mistake would report `disablesControl: true` here. For SOURCES, "0" is
    // an unrecognised class (widens); for THRESHOLD it is a bar of 0 (widens).
    // Either way `disablesControl` must stay false.
    expect(securitySensitiveAuditFields(key, "set", "0")).toMatchObject({
      disablesControl: false,
    });
  });

  it("a clear flags neither EVEN WHEN a value rides along", () => {
    // Every other clear assertion passes `undefined`, which is the one input
    // where the `action` guard is not load-bearing — so dropping
    // `action === "set"` from any of the three rules survived the whole suite.
    // `value` is typed `string | undefined`, so this state is representable
    // even though today's only caller always passes undefined.
    for (const [key, value] of [
      ["ATLAS_TRIAL_IP_RATE_LIMIT_RPM", "0"],
      [SOURCES, "extractor"],
      [THRESHOLD, "0.5"],
    ] as const) {
      expect(securitySensitiveAuditFields(key, "clear", value)).toEqual({
        disablesControl: false,
        widensAuthority: false,
      });
    }
  });

  it("the shipped default source list never reads as a widening", () => {
    // `ALIAS_SOURCE_CLASS_NOT_WIDENING` duplicates the registry `default`,
    // deliberately (settings.ts must not import brain modules) — so the
    // duplication needs a test or it rots silently. Renaming
    // the source class in the brain module without updating the audit would
    // make the shipped default audit as a widening, and every real widening
    // audit as safe.
    const def = getSettingDefinition(SOURCES);
    expect(def?.default).toBe("warehouse_key");
    expect(securitySensitiveAuditFields(SOURCES, "set", def?.default)).toMatchObject({
      widensAuthority: false,
    });
  });

  it("the shipped source list is not a widening", () => {
    expect(securitySensitiveAuditFields(SOURCES, "set", "warehouse_key")).toEqual({
      disablesControl: false,
      widensAuthority: false,
    });
  });

  it("adding any class beyond warehouse_key widens", () => {
    expect(securitySensitiveAuditFields(SOURCES, "set", "warehouse_key,extractor")).toEqual({
      disablesControl: false,
      widensAuthority: true,
    });
    // Bare, not just appended — a replacement is as much a widening as an
    // addition, and a predicate written as "contains a comma" would miss it.
    expect(securitySensitiveAuditFields(SOURCES, "set", "extractor")).toMatchObject({
      widensAuthority: true,
    });
  });

  it("an unrecognized class still counts as an attempt to widen", () => {
    // `aliasAutoApproveSources` drops tokens it doesn't know, so this widens
    // nothing in effect. It is audited anyway: an audit log that goes quiet on
    // a typo'd privilege escalation is the wrong failure.
    expect(securitySensitiveAuditFields(SOURCES, "set", "warehouse_key,extractr")).toMatchObject({
      widensAuthority: true,
    });
  });

  it("whitespace and empty tokens do not manufacture a widening", () => {
    expect(securitySensitiveAuditFields(SOURCES, "set", " warehouse_key , ")).toMatchObject({
      widensAuthority: false,
    });
  });

  it("an empty source list is a narrowing, not a disable", () => {
    // Nothing is eligible, so nothing auto-approves. The numeric rule would
    // have read "" as 0 and called this a disabled control.
    expect(securitySensitiveAuditFields(SOURCES, "set", "")).toEqual({
      disablesControl: false,
      widensAuthority: false,
    });
  });

  it("lowering the confidence bar below the shipped 1 widens", () => {
    expect(securitySensitiveAuditFields(THRESHOLD, "set", "0.9")).toEqual({
      disablesControl: false,
      widensAuthority: true,
    });
  });

  // ⚠️ THE AUDIT MUST PARSE AS THE READER PARSES, and this table is the claim.
  // `aliasAutoApproveThreshold` uses `Number.parseFloat` plus a 0..1 range; an
  // earlier draft of the audit used `Number`, and review measured the two rows
  // marked below as divergences — one a false negative on exactly the
  // escalation the flag exists to catch.
  it.each([
    // [written value, reader's effective bar, widensAuthority]
    ["0.9", "0.9", true],
    ["0", "0", true],
    ["1", "1 (the shipped bar)", false],
    // `Number("0.5x")` is NaN → audited as harmless; `parseFloat("0.5x")` is
    // 0.5 and the reader HALVES the bar. A typo'd write that really does widen.
    ["0.5x", "0.5", true],
    // The mirror: parses, but out of range, so the reader disables entirely —
    // the safest state. Flagging it as a widening was a false alarm.
    ["-0.5", "disabled (out of range)", false],
    ["1.5", "disabled (out of range)", false],
    ["very confident", "disabled (unparseable)", false],
    ["", "disabled (empty)", false],
  ])(
    "threshold %p → reader applies %s → widensAuthority=%p",
    (written, _readerEffect, expected) => {
      expect(securitySensitiveAuditFields(THRESHOLD, "set", written)).toEqual({
        disablesControl: false,
        widensAuthority: expected,
      });
    },
  );

  it("the shipped threshold of 1 is not a widening", () => {
    expect(securitySensitiveAuditFields(THRESHOLD, "set", "1")).toMatchObject({
      widensAuthority: false,
    });
  });

  it("an empty threshold is the SAFE end — neither a widening nor a disable", () => {
    // The single most important row here. Empty = queue everything for human
    // review, which the reference page names as the setting to reach for when
    // you want every alias seen by a person. `Number("")` is 0, so the abuse
    // rule would flag it `disablesControl: true`.
    expect(securitySensitiveAuditFields(THRESHOLD, "set", "")).toEqual({
      disablesControl: false,
      widensAuthority: false,
    });
  });

  it("an unparseable threshold is a narrowing — the reader disables on it", () => {
    expect(securitySensitiveAuditFields(THRESHOLD, "set", "very confident")).toEqual({
      disablesControl: false,
      widensAuthority: false,
    });
  });

  it("a clear flags neither, on either key (revert is value-unknown)", () => {
    // Consistent with the abuse thresholds: a workspace-level clear reverts to
    // a platform override that may itself be wide, so the written value here
    // does not determine the resulting authority.
    expect(securitySensitiveAuditFields(SOURCES, "clear", undefined)).toEqual({
      disablesControl: false,
      widensAuthority: false,
    });
    expect(securitySensitiveAuditFields(THRESHOLD, "clear", undefined)).toEqual({
      disablesControl: false,
      widensAuthority: false,
    });
  });
});

// #5180 — the security-audit line used to put the WRITTEN VALUE into the log
// stream verbatim. Harmless for today's four members (two RPM limits, a source
// list, a confidence bar — none carries `secret`), and filed anyway because
// #5178 made joining the set a two-line, compile-checked change that never
// requires touching, or reading, the logging line. The next `secret: true` key
// to join would have written its plaintext to the logs.
//
// The redaction is a pure function of the DEFINITION, so it is tested here
// against real registry entries without DB or logger plumbing — the same
// treatment `securitySensitiveAuditFields` gets above.
/**
 * Build an expected `AuditedValue`. Tests have to name the strings they expect,
 * and `AuditedValue` is branded precisely so production code cannot — this cast
 * is the test's side of that trade, and it is the only one in the file.
 */
const audited = (value: string): AuditedValue => value as AuditedValue;

describe("audit value redaction (#5180)", () => {
  const RPM: SecuritySensitiveKey = "ATLAS_TRIAL_IP_RATE_LIMIT_RPM";
  const SOURCES: SecuritySensitiveKey = "ATLAS_BRAIN_ALIAS_AUTO_APPROVE_SOURCES";

  // Real registry definitions, not synthetic literals: a hand-written pair
  // would agree with whatever the test wanted, and the pairing this fix
  // protects is the one the registry actually ships.
  const SECRET_DEF = getSettingDefinition("ANTHROPIC_API_KEY");
  const PLAIN_DEF = getSettingDefinition(RPM);

  it("the two fixtures differ on the only axis under test", () => {
    // Both are live registry entries, so a registry edit could quietly make
    // them agree — at which point every assertion below would pass whatever
    // `redactAuditValue` did with them.
    expect(SECRET_DEF?.secret).toBe(true);
    expect(PLAIN_DEF?.secret).not.toBe(true);
  });

  // ⚠️ NO CHARACTERS SURVIVE, AT ANY LENGTH. The audit path deliberately does
  // NOT reuse `maskSecret`, whose `first4••••last4` long arm is a recognition
  // affordance for one admin looking at their own key on their own settings
  // page. A log stream is retained, exported and broadly readable, and that
  // mask leaks 8 of 9 characters of a short secret into it. These fixtures
  // straddle the boundary the display mask cares about (8 / 9 / 32 chars) to
  // pin that the audit path has no such boundary left.
  /** Straddles the boundary the display mask cared about: 32 / 9 / 8 / 3 / 1. */
  const SECRET_LENGTHS = ["sk-ant-api03-SUPERSECRET-payload", "abcdefghi", "hunter22", "   ", "x"];

  it.each(SECRET_LENGTHS)("withholds a secret's value entirely — %p", (written) => {
    const { value, masked, maskReason } = redactAuditValue("ANTHROPIC_API_KEY", SECRET_DEF, written);
    expect(masked).toBe(true);
    expect(maskReason).toBe("secret");
    expect(value).toBe(audited("[withheld:secret-setting]"));
  });

  // ⚠️ THE CLAIM THAT ACTUALLY BITES, and the first draft of it could not fail.
  // That draft asserted, per row, that no character of the input survived —
  // but it stripped lowercase letters before comparing, so for `"abcdefghi"`
  // and `"x"` it iterated ZERO times and asserted nothing at all. The property
  // worth pinning is stronger and uniform: the output does not depend on the
  // input. `maskSecret` reveals eight characters of two of these five values,
  // so it goes red here.
  it("produces one identical placeholder for every secret, whatever its length", () => {
    const outputs = new Set(SECRET_LENGTHS.map((w) => redactAuditValue("ANTHROPIC_API_KEY", SECRET_DEF, w).value));
    expect(outputs.size).toBe(1);
    expect([...outputs][0]).toBe(audited("[withheld:secret-setting]"));
    // And the distinctive one, named directly rather than derived.
    expect(redactAuditValue("ANTHROPIC_API_KEY", SECRET_DEF, "sk-ant-api03-SUPERSECRET-payload").value).not.toContain(
      "SUPERSECRET",
    );
  });

  // ⚠️ THE CONTROL. The fix must not be "mask everything": the written value is
  // what tells an incident responder WHICH WAY a control moved, and an audit
  // line that redacts a rate limit has thrown away its own subject.
  it("leaves a non-secret definition's value verbatim", () => {
    expect(redactAuditValue(RPM, PLAIN_DEF, "0")).toEqual({
      value: audited("0"),
      masked: false,
      maskReason: undefined,
    });
    expect(redactAuditValue(SOURCES, getSettingDefinition(SOURCES), "warehouse_key,extractor")).toEqual({
      value: audited("warehouse_key,extractor"),
      masked: false,
      maskReason: undefined,
    });
  });

  it("fails closed on an unknown definition, and says WHY", () => {
    // "We could not tell whether this is a secret" is not a licence to print.
    // The reason is separate from the routine one because a sensitive key with
    // no registry entry is drift — reported as a plain masked write it would be
    // indistinguishable from the healthy case, and the backstop would fire
    // silently.
    expect(redactAuditValue("ATLAS_SOMETHING_RENAMED", undefined, "mystery-value-here")).toEqual({
      value: audited("[withheld:secret-setting]"),
      masked: true,
      maskReason: "unknown_definition",
    });
  });

  it("a clear carries no value and is not reported as masked", () => {
    // `masked: true` here would be a lie in the audit's own metadata — nothing
    // was withheld, there was nothing to withhold.
    expect(redactAuditValue("ANTHROPIC_API_KEY", SECRET_DEF, undefined)).toEqual({
      value: undefined,
      masked: false,
      maskReason: undefined,
    });
    expect(redactAuditValue(RPM, PLAIN_DEF, undefined)).toEqual({
      value: undefined,
      masked: false,
      maskReason: undefined,
    });
  });

  // ⚠️ THE EMPTY SECRET IS WITHHELD LIKE ANY OTHER, and the earlier draft that
  // returned `undefined` here was a one-bit oracle. Every other secret reads
  // `[withheld:secret-setting]`, so a lone `undefined` singled the empty one
  // out — and for the empty secret, "its length is zero" IS the secret. The
  // set/clear distinction it was protecting lives in `action`, which is where
  // it always was.
  it("withholds an empty write to a secret key like any other value", () => {
    expect(redactAuditValue("ANTHROPIC_API_KEY", SECRET_DEF, "")).toEqual({
      value: audited("[withheld:secret-setting]"),
      masked: true,
      maskReason: "secret",
    });
    expect(redactAuditValue(RPM, PLAIN_DEF, "")).toEqual({
      value: audited(""),
      masked: false,
      maskReason: undefined,
    });
  });
});

describe("settingUpdateResponseBody — the PUT echo (#5263)", () => {
  // The third sink for a written value, and the last one that played the
  // request back verbatim. Driven here rather than through the route because
  // the route 403s a `secret: true` key before a body exists: an assertion
  // written against `PUT /admin/settings/{key}` can only ever reach the
  // verbatim arm, which passes identically with this fix and without it.
  const SECRET_DEF = getSettingDefinition("ANTHROPIC_API_KEY");
  const PLAIN_DEF = getSettingDefinition("ATLAS_TRIAL_IP_RATE_LIMIT_RPM");
  const SECRET_VALUE = "sk-ant-api03-SUPERSECRET-payload";

  it("the two fixtures differ on the only axis under test", () => {
    // ⚠️ `toBeDefined` on the plain one FIRST: `expect(PLAIN_DEF?.secret)
    // .not.toBe(true)` passes when `PLAIN_DEF` is `undefined`, which would
    // route the "verbatim" case through the fail-closed arm and make the
    // control below assert the placeholder while reading as a pass.
    expect(SECRET_DEF?.secret).toBe(true);
    expect(PLAIN_DEF).toBeDefined();
    expect(PLAIN_DEF?.secret).not.toBe(true);
  });

  it("⭐ withholds a `secret: true` value from the response body", () => {
    const body = settingUpdateResponseBody(SECRET_DEF, "ANTHROPIC_API_KEY", SECRET_VALUE);
    expect(body.value).toBe(audited("[withheld:secret-setting]"));
    expect(body.valueMasked).toBe(true);
    // ⚠️ THE WHOLE SERIALIZED BODY, not just `value`. A future field carrying
    // the plaintext — `previousValue`, a diff, an echo of the request — would
    // satisfy the assertion above and still be the disclosure.
    expect(JSON.stringify(body)).not.toContain("SUPERSECRET");
  });

  // ⚠️ THE CONTROL. "Redact everything" passes the test above and destroys the
  // response's only useful content: an admin UI that cannot read back what it
  // just stored has no way to show the write took effect.
  it("records a non-secret value verbatim, and says it was not masked", () => {
    expect(settingUpdateResponseBody(PLAIN_DEF, "ATLAS_TRIAL_IP_RATE_LIMIT_RPM", "0")).toEqual({
      success: true,
      key: "ATLAS_TRIAL_IP_RATE_LIMIT_RPM",
      value: audited("0"),
      valueMasked: false,
    });
  });

  // ⚠️ The two flags must not agree by accident. `valueMasked` is the ONLY
  // thing separating the placeholder from a setting whose literal value is
  // that string, so a builder hardcoding it either way passes one of the two
  // tests above and lies on the other.
  it("`valueMasked` tracks the arm taken, on both arms", () => {
    expect(settingUpdateResponseBody(SECRET_DEF, "ANTHROPIC_API_KEY", "x").valueMasked).toBe(true);
    expect(
      settingUpdateResponseBody(PLAIN_DEF, "ATLAS_TRIAL_IP_RATE_LIMIT_RPM", "x").valueMasked,
    ).toBe(false);
  });

  it("fails closed on a key with no registry entry", () => {
    // The route 400s an unknown key before the write, so this is a backstop
    // against a rename rather than a live path — which is exactly why it must
    // not be the permissive one.
    const body = settingUpdateResponseBody(undefined, "ATLAS_SOMETHING_RENAMED", SECRET_VALUE);
    expect(body.value).toBe(audited("[withheld:secret-setting]"));
    expect(body.valueMasked).toBe(true);
    expect(JSON.stringify(body)).not.toContain("SUPERSECRET");
  });

  it("⭐ reports definition_mismatch, not unknown_definition — the arms are distinguishable", () => {
    // ⚠️ THE REASON, not just the withholding, and driven through all THREE sinks
    // that share the decision. `unknown_definition` reads as registry drift and
    // sends an operator to grep `SETTINGS_REGISTRY`; for a definition belonging to
    // another key the entry is right there and the bug is at the call site.
    // Reported as drift, that alert is closed as a false positive.
    //
    // Before centralisation each sink recomputed this after discarding the
    // evidence, and the response sink could not report it at all.
    const body = settingUpdateResponseBody(PLAIN_DEF, "ATLAS_MODEL", "0");
    expect(body.maskReason).toBe("definition_mismatch");

    const decided = redactPresentAuditValue("ATLAS_MODEL", PLAIN_DEF, "0");
    expect(decided.maskReason).toBe("definition_mismatch");

    // …and the genuinely-absent case still says drift, so the two are not merged.
    expect(redactPresentAuditValue("ATLAS_NOPE", undefined, "0").maskReason).toBe(
      "unknown_definition",
    );
  });

  it("a mismatched AND secret definition reports the caller bug, not the secrecy", () => {
    // Order is observable and was preserved from the three hand-written copies:
    // the caller bug is the actionable fact, and another key's secrecy is not
    // evidence about this one.
    expect(
      redactPresentAuditValue("ATLAS_MODEL", SECRET_DEF, "x").maskReason,
    ).toBe("definition_mismatch");
  });

  it("⭐ withholds when the definition belongs to a DIFFERENT key", () => {
    // The discard `auditSettingsWrite` has and this builder did not. Without it
    // the two sinks apply different fail-closed rules: the row would withhold
    // the characters and record `maskReason: "definition_mismatch"` while this
    // body echoed the plaintext — the third sink leaking exactly what #5263
    // closed, in the one input class the seam was hardened against.
    //
    // Unreachable through today's route (`SETTINGS_MAP` is keyed by `def.key`,
    // so `mismatched` is always false there) and reachable the day
    // `getSettingDefinition` gains alias or rename resolution.
    //
    // ⚠️ A NON-SECRET definition, and that is the whole reason this test can
    // fail. The first draft passed `SECRET_DEF`, which reaches the withheld
    // placeholder through its OWN `secret: true` arm whether or not the discard
    // exists — measured: deleting the discard left the suite green. With a
    // non-secret definition for another key, the discard is the only thing
    // standing between this value and the verbatim arm.
    const body = settingUpdateResponseBody(PLAIN_DEF, "ATLAS_MODEL", "0");
    expect(body.value).toBe(audited("[withheld:secret-setting]"));
    expect(body.valueMasked).toBe(true);
  });

  it("a definition whose key MATCHES is still used — the discard is not a blanket withhold", () => {
    // The discriminating half. A builder that discarded every definition would
    // pass the test above and withhold every value in the product.
    expect(
      settingUpdateResponseBody(PLAIN_DEF, "ATLAS_TRIAL_IP_RATE_LIMIT_RPM", "0").value,
    ).toBe(audited("0"));
  });

  it("echoes the key it was given, not the definition's", () => {
    // A body naming the definition's key would misreport which setting the
    // caller just wrote whenever the two disagree — the same wrong-definition
    // input class `auditSettingsWrite` guards, arriving at the response.
    expect(settingUpdateResponseBody(PLAIN_DEF, "ATLAS_MODEL", "x").key).toBe("ATLAS_MODEL");
  });
});

describe("securitySensitiveAuditLine (#5180)", () => {
  const RPM: SecuritySensitiveKey = "ATLAS_TRIAL_IP_RATE_LIMIT_RPM";

  /** `key`'s real registry entry, with `secret` forced either way. */
  function definitionWithSecret(key: string, secret: boolean): SettingDefinition {
    const def = getSettingDefinition(key);
    if (!def) throw new Error(`no registry definition for ${key}`);
    return { ...def, secret };
  }

  function lineFor(overrides: Partial<SecuritySensitiveAuditInput> = {}) {
    return securitySensitiveAuditLine({
      key: RPM,
      definition: getSettingDefinition(RPM),
      action: "set",
      value: audited("0"),
      actorId: "user_1",
      orgId: "org_1",
      ...overrides,
    });
  }

  it("returns null for a non-sensitive key — no audit line at all", () => {
    expect(lineFor({ key: "ATLAS_ROW_LIMIT", definition: getSettingDefinition("ATLAS_ROW_LIMIT") }))
      .toBeNull();
  });

  it("is the whole logged payload, redaction included", () => {
    // Asserted as the FULL object rather than a `toMatchObject`: the defect
    // being fixed was an extra field in this payload, so a partial match is
    // exactly the assertion that could not have caught it.
    expect(lineFor()).toEqual({
      key: RPM,
      action: "set",
      value: audited("0"),
      valueMasked: false,
      maskReason: undefined,
      disablesControl: true,
      widensAuthority: false,
      actorId: "user_1",
      orgId: "org_1",
      event: "security_setting.changed",
    });
  });

  it("carries the actor and org through unchanged, and undefined when absent", () => {
    expect(lineFor({ action: "clear", value: undefined, actorId: undefined, orgId: undefined }))
      .toEqual({
        key: RPM,
        action: "clear",
        value: undefined,
        valueMasked: false,
        maskReason: undefined,
        disablesControl: false,
        widensAuthority: false,
        actorId: undefined,
        orgId: undefined,
        event: "security_setting.changed",
      });
  });

  // Credential rotation on a sensitive key: the exact scenario the "a
  // `secret: true` key IS allowed in the set" rationale rests on, and the one
  // combination the payload builder never saw in a test. Nothing is withheld
  // because a clear carries no value — the audit's whole content here is that
  // the override went away, and that survives redaction intact.
  it("audits a CLEAR on a secret key with nothing withheld", () => {
    expect(
      lineFor({
        definition: definitionWithSecret(RPM, true),
        action: "clear",
        value: undefined,
      }),
    ).toEqual({
      key: RPM,
      action: "clear",
      value: undefined,
      valueMasked: false,
      maskReason: undefined,
      disablesControl: false,
      widensAuthority: false,
      actorId: "user_1",
      orgId: "org_1",
      event: "security_setting.changed",
    });
  });

  // ⚠️ THE ROW THE WHOLE ISSUE IS ABOUT, and it is only reachable because
  // `definition` is a parameter. None of today's four sensitive keys is
  // `secret: true`, so with the registry lookup inlined in the builder, the
  // masked and unmasked values coincided on EVERY reachable input — mutating
  // the builder to log the raw value, or to hardcode `valueMasked: false`,
  // passed the entire suite. Both mutations now go red here.
  it("masks the value when the definition says secret, and says so in the payload", () => {
    const line = lineFor({
      definition: definitionWithSecret(RPM, true),
      value: "sk-ant-api03-SUPERSECRET-payload",
    });
    expect(line?.value).toBe(audited("[withheld:secret-setting]"));
    expect(line?.value).not.toContain("SUPERSECRET");
    expect(line?.valueMasked).toBe(true);
    expect(line?.maskReason).toBe("secret");
  });

  // ⚠️ REDACTION MUST NOT BLIND THE CLASSIFICATION. The obvious way to close a
  // plaintext leak is to mask early and let everything downstream read the
  // masked string — which silently turns every rule into a no-op, because a
  // masked value parses as nothing. The flags are the reason this line exists;
  // losing them to protect the value would be a worse audit than the leak.
  //
  // `"0"` is the fixture that can see it: withheld it becomes `[redacted]`,
  // which `Number` reads as NaN → "the reader kept its default" →
  // disablesControl false. Raw, it is the documented disabled sentinel → true.
  // ANY other secret redacts to that same unparseable placeholder, so masked
  // and raw agree and the test cannot fail — which is exactly what the first
  // draft of this assertion did, with a 32-char key on both sides.
  it("decides the flags from the WRITTEN value even when the payload is masked", () => {
    const line = lineFor({ definition: definitionWithSecret(RPM, true), value: "0" });
    expect(line?.disablesControl).toBe(true);
    expect(line?.valueMasked).toBe(true);
    expect(line?.value).toBe(audited("[withheld:secret-setting]"));
  });

  // The control, at the payload level: the fix must not be "mask everything".
  it("leaves the value verbatim when the definition is not secret", () => {
    const line = lineFor({
      definition: definitionWithSecret(RPM, false),
      value: "sk-ant-api03-SUPERSECRET-payload",
    });
    expect(line?.value).toBe(audited("sk-ant-api03-SUPERSECRET-payload"));
    expect(line?.valueMasked).toBe(false);
  });

  it("fails closed when the definition belongs to a DIFFERENT key", () => {
    // A non-secret definition, so a builder that trusted the mismatched
    // argument would log verbatim. It tells us nothing about RPM, so the
    // masked branch is the only honest one.
    const line = lineFor({
      definition: definitionWithSecret("ATLAS_ROW_LIMIT", false),
      value: "mystery-value-here",
    });
    expect(line?.value).toBe(audited("[withheld:secret-setting]"));
    expect(line?.valueMasked).toBe(true);
    // ⚠️ `definition_mismatch`, NOT `unknown_definition`. Both withhold, but
    // they route an operator to different places: drift means grep the
    // registry, mismatch means the key is present and the CALLER is wrong.
    // Reporting a caller bug as drift gets the alert closed as a false
    // positive against a registry that looks fine.
    expect(line?.maskReason).toBe("definition_mismatch");
  });

  it("fails closed when there is no definition at all", () => {
    const line = lineFor({ definition: undefined, value: "mystery-value-here" });
    expect(line?.value).toBe(audited("[withheld:secret-setting]"));
    expect(line?.valueMasked).toBe(true);
    expect(line?.maskReason).toBe("unknown_definition");
  });

  // The general claim over the real set, so it stays live as the set grows
  // rather than needing someone to remember it. Today every member is
  // non-secret, so this is the verbatim control; the day a `secret: true` key
  // joins SECURITY_SENSITIVE_KEYS it becomes the masking assertion with no
  // edit here, which is the future this issue exists to cover.
  //
  // ⚠️ The registry lookup is asserted BEFORE it is used. Written as
  // `def?.secret === true`, a key renamed out of the registry collapses into
  // "not secret", so the row would demand the value verbatim while
  // `redactAuditValue` correctly fails closed — going red with a message that
  // accuses the redaction of a bug that is actually a rename. The assertion
  // below names the real cause; `:1327` owns the claim itself.
  it.each([...SECURITY_SENSITIVE_KEYS])(
    "%s redacts exactly as its own registry definition dictates",
    (key) => {
      const written = "audit-probe-0123456789";
      const def = getSettingDefinition(key);
      expect(def).toBeDefined();
      const line = securitySensitiveAuditLine({
        key,
        definition: def,
        action: "set",
        value: written,
        actorId: undefined,
        orgId: undefined,
      });
      const withheld = def === undefined || def.secret === true;
      expect(line).not.toBeNull();
      expect(line?.valueMasked).toBe(withheld);
      expect(line?.value).toBe(audited(withheld ? "[withheld:secret-setting]" : written));
    },
  );
});

// #5162 — the signal the alias authority path fails closed on. These live in
// the ALWAYS-RUN lane deliberately: the behavioural falsifier is in
// `vocabulary-decide-pg.test.ts`, which self-skips without TEST_DATABASE_URL,
// and one arm here is not reachable from a pg suite at all (they set
// DATABASE_URL in beforeAll, so `!hasInternalDB()` is false in both branches).
// Review measured the consequence: mutating the body to `return _cacheEverLoaded`
// turned alias auto-approval permanently OFF for every self-hosted deployment
// with nothing in the repo going red — before this block existed. The first
// test below is what changed that.
const origDatabaseUrlForLatchTests = process.env.DATABASE_URL;

describe("settingsCacheEverLoaded (#5162)", () => {
  // This describe is a TOP-LEVEL sibling of `describe("settings module")`, so
  // it inherits none of that block's teardown — and its helpers mutate
  // `process.env.DATABASE_URL` and install `mockPool` as the internal pool.
  // Without this, whatever describe is appended next silently inherits a fake
  // DATABASE_URL and an injected pool.
  afterEach(() => {
    _resetPool(null);
    _resetSettingsCache();
    if (origDatabaseUrlForLatchTests === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = origDatabaseUrlForLatchTests;
  });

  it("reads as LOADED when there is no internal DB — self-hosted is not degraded", () => {
    // The deliberately-inverted arm. A deployment with no internal DB resolves
    // through env → default BY DESIGN, and an opt-out there is an env var that
    // IS present, so failing closed would break every self-hosted deployment
    // for a tier it was never going to have.
    disableInternalDB();
    _resetSettingsCache();
    expect(settingsCacheEverLoaded()).toBe(true);
  });

  it("reads as NOT loaded when an internal DB exists but no load has succeeded", () => {
    enableInternalDB();
    _resetSettingsCache();
    expect(settingsCacheEverLoaded()).toBe(false);
  });

  it("latches on a successful load", async () => {
    enableInternalDB();
    _resetSettingsCache();
    setResults({ rows: [] });
    await loadSettings();
    // Zero overrides is a SUCCESSFUL read, not an absent one — the latch is
    // about whether the tier was consulted, not whether it had contents.
    expect(settingsCacheEverLoaded()).toBe(true);
  });

  it("STAYS latched across a later failed load", async () => {
    // The claim the source comment makes and nothing checked: `_cache` swaps
    // atomically, so a later failure leaves the last good contents in place and
    // the tier is still readable. Adding `_cacheEverLoaded = false` to the
    // catch, or moving the assignment before the query, goes red here.
    enableInternalDB();
    _resetSettingsCache();
    setResults({ rows: [] });
    await loadSettings();
    expect(settingsCacheEverLoaded()).toBe(true);

    const savedQuery = mockPool.query;
    mockPool.query = async () => {
      throw new Error("connection terminated unexpectedly");
    };
    try {
      await loadSettings();
    } finally {
      mockPool.query = savedQuery;
    }
    expect(settingsCacheEverLoaded()).toBe(true);
  });

  it("does NOT latch when the FIRST load fails — the #5162 window", async () => {
    enableInternalDB();
    _resetSettingsCache();
    const savedQuery = mockPool.query;
    mockPool.query = async () => {
      throw new Error("connection terminated unexpectedly");
    };
    try {
      await loadSettings();
    } finally {
      mockPool.query = savedQuery;
    }
    expect(settingsCacheEverLoaded()).toBe(false);
  });
});

// #5161 — the access half. The registry, not the docs, is what a Cloud
// workspace admin's settings page actually reads.
describe("alias auto-approve knobs are platform-admin-only on Cloud (#5161)", () => {
  it("both carry saasVisible: false", () => {
    // Asserted as `=== false`, not falsy: the field is OPTIONAL and defaults to
    // TRUE, which is exactly how both keys shipped visible without anyone
    // writing `saasVisible: true`. `toBeFalsy()` would pass on `undefined` —
    // the very value that caused the defect.
    for (const key of [
      "ATLAS_BRAIN_ALIAS_AUTO_APPROVE_SOURCES",
      "ATLAS_BRAIN_ALIAS_AUTO_APPROVE_THRESHOLD",
    ]) {
      const def = getSettingsRegistry().find((s) => s.key === key);
      expect(def).toBeDefined();
      expect(def?.saasVisible).toBe(false);
    }
  });

  it("stay workspace-scoped — hidden is about who writes, not about per-workspace values", () => {
    // The two axes are independent, and collapsing them is the misreading the
    // decision turned on. `ATLAS_BRAIN_AUDIENCE_SYNC_ENABLED` is the precedent:
    // workspace-scoped AND hidden, with a platform admin setting the
    // per-workspace override.
    for (const key of [
      "ATLAS_BRAIN_ALIAS_AUTO_APPROVE_SOURCES",
      "ATLAS_BRAIN_ALIAS_AUTO_APPROVE_THRESHOLD",
      "ATLAS_BRAIN_AUDIENCE_SYNC_ENABLED",
    ]) {
      expect(getSettingsRegistry().find((s) => s.key === key)?.scope).toBe("workspace");
    }
  });
});
