/**
 * Settings tests that require SaaS mode (mock.module for config).
 *
 * Covers:
 * - requiresRestart suppression in SaaS mode is scoped to keys
 *   applySettingSideEffect hot-reloads; boot-consumed flagged keys keep
 *   the hint (#1089, #3399)
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

// Controllable so the #3389 probe tests can simulate self-hosted, unloaded
// (null) and errored (throwing) config resolution. Defaults to SaaS.
let mockGetConfigImpl: () => { deployMode?: string } | null = () => ({ deployMode: "saas" });

void mock.module("@atlas/api/lib/config", () => ({
  getConfig: () => mockGetConfigImpl(),
  defineConfig: (c: unknown) => c,
}));

// Track setLogLevel calls
let logLevelCalls: Array<{ level: string; result: boolean }> = [];
void mock.module("@atlas/api/lib/logger", () => ({
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
  deleteSetting,
  isSaasModeForGuard,
  _resetSettingsCache,
} = await import("../settings");
const { SaasImmutableSettingError } = await import("../settings-errors");

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
    mockGetConfigImpl = () => ({ deployMode: "saas" });
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
    // #3399 — the suppression is scoped to keys applySettingSideEffect
    // actually hot-reloads (today: ATLAS_LOG_LEVEL only). The old blanket
    // `!inSaas` suppression hid the hint for boot-consumed keys too,
    // leaving SaaS platform admins with silent staleness.
    it("hot-reloaded keys have requiresRestart suppressed in SaaS mode", () => {
      const settings = getSettingsForAdmin(undefined, true);

      const logLevel = settings.find((s) => s.key === "ATLAS_LOG_LEVEL");
      expect(logLevel).toBeDefined();
      // ATLAS_LOG_LEVEL is hot-reloaded by applySettingSideEffect, so the
      // hint stays suppressed (no false restart warning).
      expect(logLevel!.requiresRestart).toBeUndefined();
    });

    it("boot-consumed restart-flagged non-immutable keys KEEP requiresRestart: true in SaaS mode (#3399)", () => {
      const settings = getSettingsForAdmin(undefined, true);

      // #3392 — the expert scheduler pair is consumed once at boot by the
      // process-global scheduler fiber; no cache refresh can apply a
      // change, so the SaaS platform admin must see the restart hint.
      for (const key of [
        "ATLAS_EXPERT_SCHEDULER_ENABLED",
        "ATLAS_EXPERT_SCHEDULER_INTERVAL_HOURS",
      ]) {
        const setting = settings.find((s) => s.key === key);
        expect(setting).toBeDefined();
        expect(setting!.requiresRestart).toBe(true);
      }

      // Other flagged keys without a side-effect handler keep the hint too.
      const provider = settings.find((s) => s.key === "ATLAS_PROVIDER");
      expect(provider).toBeDefined();
      expect(provider!.requiresRestart).toBe(true);

      const model = settings.find((s) => s.key === "ATLAS_MODEL");
      expect(model).toBeDefined();
      expect(model!.requiresRestart).toBe(true);
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

  // -------------------------------------------------------------------------
  // SAAS_IMMUTABLE_KEYS rejection (#1978 sub-finding 6)
  // -------------------------------------------------------------------------

  describe("SAAS_IMMUTABLE_KEYS rejection", () => {
    it("setSetting rejects ATLAS_EMAIL_PROVIDER in SaaS mode with SaasImmutableSettingError", async () => {
      enableInternalDB();
      setResults({ rows: [] });

      let captured: unknown;
      try {
        await setSetting("ATLAS_EMAIL_PROVIDER", "sendgrid", "admin-1");
      } catch (err) {
        captured = err;
      }

      expect(captured).toBeInstanceOf(SaasImmutableSettingError);
      expect((captured as InstanceType<typeof SaasImmutableSettingError>).key).toBe("ATLAS_EMAIL_PROVIDER");
      expect((captured as InstanceType<typeof SaasImmutableSettingError>)._tag).toBe("SaasImmutableSettingError");
      // No DB write should have happened — the rejection must come before persist.
      expect(queryCalls).toHaveLength(0);
    });

    it("setSetting rejects ATLAS_DEPLOY_MODE in SaaS mode", async () => {
      enableInternalDB();
      setResults({ rows: [] });

      await expect(
        setSetting("ATLAS_DEPLOY_MODE", "self-hosted", "admin-1"),
      ).rejects.toThrow(SaasImmutableSettingError);
    });

    // #1983 — pairs with RateLimitGuardLive at boot. Hot-reloading
    // would silently re-open the DDoS hole until next restart.
    it("setSetting rejects ATLAS_RATE_LIMIT_RPM in SaaS mode", async () => {
      enableInternalDB();
      setResults({ rows: [] });

      let captured: unknown;
      try {
        await setSetting("ATLAS_RATE_LIMIT_RPM", "0", "admin-1");
      } catch (err) {
        captured = err;
      }

      expect(captured).toBeInstanceOf(SaasImmutableSettingError);
      expect((captured as InstanceType<typeof SaasImmutableSettingError>).key).toBe("ATLAS_RATE_LIMIT_RPM");
      // No DB write — rejection precedes persist.
      expect(queryCalls).toHaveLength(0);
    });

    it("setSetting allows non-immutable keys in SaaS mode", async () => {
      enableInternalDB();
      setResults({ rows: [] });

      await expect(
        setSetting("ATLAS_ROW_LIMIT", "500", "admin-1"),
      ).resolves.toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // deleteSetting SAAS_IMMUTABLE_KEYS rejection (#3389)
  // -------------------------------------------------------------------------

  describe("deleteSetting SAAS_IMMUTABLE_KEYS rejection (#3389)", () => {
    it("deleteSetting rejects ATLAS_EMAIL_PROVIDER in SaaS mode with SaasImmutableSettingError", async () => {
      enableInternalDB();
      setResults({ rows: [] });

      let captured: unknown;
      try {
        await deleteSetting("ATLAS_EMAIL_PROVIDER", "admin-1");
      } catch (err) {
        captured = err;
      }

      // Same error type + shape as the setSetting guard — the route maps
      // both to the same 409 envelope.
      expect(captured).toBeInstanceOf(SaasImmutableSettingError);
      expect((captured as InstanceType<typeof SaasImmutableSettingError>).key).toBe("ATLAS_EMAIL_PROVIDER");
      expect((captured as InstanceType<typeof SaasImmutableSettingError>)._tag).toBe("SaasImmutableSettingError");
      // No DB delete — clearing the override would silently reset the key
      // to env/default behind the boot-time contract guard.
      expect(queryCalls).toHaveLength(0);
    });

    it("deleteSetting rejects ATLAS_DEPLOY_MODE and ATLAS_RATE_LIMIT_RPM in SaaS mode", async () => {
      enableInternalDB();
      setResults({ rows: [] });

      await expect(
        deleteSetting("ATLAS_DEPLOY_MODE", "admin-1"),
      ).rejects.toThrow(SaasImmutableSettingError);
      await expect(
        deleteSetting("ATLAS_RATE_LIMIT_RPM", "admin-1"),
      ).rejects.toThrow(SaasImmutableSettingError);
      expect(queryCalls).toHaveLength(0);
    });

    it("deleteSetting allows non-immutable keys in SaaS mode", async () => {
      enableInternalDB();
      setResults({ rows: [] });

      await expect(
        deleteSetting("ATLAS_ROW_LIMIT", "admin-1"),
      ).resolves.toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // isSaasModeForGuard probe discipline (#3389)
  // -------------------------------------------------------------------------

  describe("isSaasModeForGuard probe discipline (#3389)", () => {
    // Exported in #3389 so the route-level write gates on PUT/DELETE
    // /admin/settings/{key} share the lib guard's fail-closed discipline.

    it("returns true when deployMode is saas", () => {
      expect(isSaasModeForGuard()).toBe(true);
    });

    it("returns false when deployMode is self-hosted (resolved config stays permissive)", () => {
      mockGetConfigImpl = () => ({ deployMode: "self-hosted" });
      expect(isSaasModeForGuard()).toBe(false);
    });

    it("returns false when config is unloaded (getConfig() → null — legitimate AGPL/dev state)", () => {
      mockGetConfigImpl = () => null;
      expect(isSaasModeForGuard()).toBe(false);
    });

    it("fails CLOSED (true) when getConfig() throws — config-resolution failure is not self-hosted", () => {
      mockGetConfigImpl = () => {
        throw new Error("config resolution exploded");
      };
      expect(isSaasModeForGuard()).toBe(true);
    });
  });
});
