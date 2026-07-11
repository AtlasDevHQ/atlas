import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import {
  isExpertSchedulerEnabled,
  getExpertSchedulerIntervalMs,
  DEFAULT_EXPERT_SCHEDULER_INTERVAL_MS,
  AUTONOMOUS_IMPROVE_ENABLED_KEY,
} from "../scheduler";
import { loadSettings, _resetSettingsCache, getSettingDefinition } from "@atlas/api/lib/settings";
import type { ResolvedConfig } from "@atlas/api/lib/config";
import { _setConfigForTest, _resetConfig } from "@atlas/api/lib/config";

// Mock internal DB. `dbAvailable` / `settingsRows` are mutable so the
// #3392 tests below can seed the settings cache via loadSettings() (the
// readers now resolve through getSetting's tier chain, not raw env).
let dbAvailable = false;
let settingsRows: Array<{
  key: string;
  value: string;
  updated_at: string;
  updated_by: string | null;
  org_id: string | null;
}> = [];

void mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => dbAvailable,
  getInternalDB: () => ({ query: async () => ({ rows: [] }), end: async () => {}, on: () => {} }),
  internalQuery: async () => settingsRows,
  internalExecute: () => {},
  getAutoApproveThreshold: () => 2, // disabled
  getAutoApproveTypes: () => new Set(["update_description", "add_dimension"]),
  insertSemanticAmendment: mock(async () => ({ id: "test-id", autoApprove: false })),
  claimPendingAmendment: mock(async () => null),
  stampClaimedAmendmentApproved: mock(async () => false),
  releaseClaimedAmendment: mock(async () => false),
  rejectPendingAmendment: mock(async () => false),
  getPendingAmendmentCount: mock(async () => 0),
  getApprovedPatterns: async () => [],
  getEncryptionKey: () => null,
  encryptConnectionUrl: (url: string) => url,
  decryptConnectionUrl: (url: string) => url,
  setWorkspaceRegion: mock(async () => {}),
}));

// Mock logger. scheduler.ts imports `withRequestContext` at module top (used by
// the tick), so the mock must provide it even though this file only exercises
// the config getters — otherwise a future tick test here hits `undefined`.
void mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
  withRequestContext: (_ctx: unknown, fn: () => unknown) => fn(),
}));

describe("isExpertSchedulerEnabled", () => {
  beforeEach(() => {
    delete process.env.ATLAS_EXPERT_SCHEDULER_ENABLED;
  });

  it("returns false when not set", () => {
    expect(isExpertSchedulerEnabled()).toBe(false);
  });

  it("returns true when set to 'true'", () => {
    process.env.ATLAS_EXPERT_SCHEDULER_ENABLED = "true";
    expect(isExpertSchedulerEnabled()).toBe(true);
  });

  it("returns true when set to '1'", () => {
    process.env.ATLAS_EXPERT_SCHEDULER_ENABLED = "1";
    expect(isExpertSchedulerEnabled()).toBe(true);
  });

  it("returns false for other values", () => {
    process.env.ATLAS_EXPERT_SCHEDULER_ENABLED = "yes";
    expect(isExpertSchedulerEnabled()).toBe(false);
  });
});

// #4516 — the #4487 SaaS boot-guard is RETIRED. On SaaS every insert is now
// org-stamped and the tick is gated per-workspace (billing gate +
// `ATLAS_AUTONOMOUS_IMPROVE_ENABLED`); self-hosted still inserts its single
// NULL-org row, which is sound because there is only one tenant. So
// `isExpertSchedulerEnabled` is now the DEPLOYMENT master switch only — the
// fiber runs on SaaS too, deploy mode is not consulted here. This block pins the
// retirement: if a future change re-adds a `saas → false` branch, it ships red.
describe("isExpertSchedulerEnabled — SaaS boot-guard retired (#4516)", () => {
  // Fully-typed `ResolvedConfig` so a `deployMode` typo can't compile silently.
  function configWithDeployMode(deployMode: "saas" | "self-hosted"): ResolvedConfig {
    return {
      datasources: {},
      tools: ["explore", "executeSQL"],
      auth: "managed",
      semanticLayer: "./semantic",
      maxTotalConnections: 100,
      source: "file",
      deployMode,
    };
  }

  beforeEach(() => {
    process.env.ATLAS_EXPERT_SCHEDULER_ENABLED = "true";
  });

  afterEach(() => {
    delete process.env.ATLAS_EXPERT_SCHEDULER_ENABLED;
    _resetConfig();
  });

  it("returns true in saas deploy mode when the setting is enabled (boot-guard gone)", () => {
    _setConfigForTest(configWithDeployMode("saas"));
    expect(isExpertSchedulerEnabled()).toBe(true);
  });

  it("returns true in self-hosted deploy mode when the setting is enabled", () => {
    _setConfigForTest(configWithDeployMode("self-hosted"));
    expect(isExpertSchedulerEnabled()).toBe(true);
  });

  it("returns false in saas deploy mode when the setting is disabled", () => {
    delete process.env.ATLAS_EXPERT_SCHEDULER_ENABLED;
    _setConfigForTest(configWithDeployMode("saas"));
    expect(isExpertSchedulerEnabled()).toBe(false);
  });
});

// #4516 — the SaaS enumeration filters `WHERE s.key = $1` bound to
// AUTONOMOUS_IMPROVE_ENABLED_KEY. If settings.ts renames the registry key/envVar
// without updating the constant, enumeration silently matches ZERO workspaces
// (autonomy never runs for any tenant) with no other failure. This crosses the
// constant against the REAL registry (scheduler.test uses the unmocked settings
// module) so that drift ships red — the tautology `KEY === "literal"` cannot.
describe("ATLAS_AUTONOMOUS_IMPROVE_ENABLED registry ↔ constant (#4516)", () => {
  it("the registry has a workspace-scoped entry keyed by the exported constant", () => {
    const def = getSettingDefinition(AUTONOMOUS_IMPROVE_ENABLED_KEY);
    expect(def).toBeDefined();
    expect(def?.scope).toBe("workspace");
    expect(def?.envVar).toBe(AUTONOMOUS_IMPROVE_ENABLED_KEY);
  });
});

describe("getExpertSchedulerIntervalMs", () => {
  beforeEach(() => {
    delete process.env.ATLAS_EXPERT_SCHEDULER_INTERVAL_HOURS;
  });

  it("returns default when not set", () => {
    expect(getExpertSchedulerIntervalMs()).toBe(DEFAULT_EXPERT_SCHEDULER_INTERVAL_MS);
  });

  it("converts hours to milliseconds", () => {
    process.env.ATLAS_EXPERT_SCHEDULER_INTERVAL_HOURS = "12";
    expect(getExpertSchedulerIntervalMs()).toBe(12 * 60 * 60 * 1000);
  });

  it("returns default for invalid values", () => {
    process.env.ATLAS_EXPERT_SCHEDULER_INTERVAL_HOURS = "abc";
    expect(getExpertSchedulerIntervalMs()).toBe(DEFAULT_EXPERT_SCHEDULER_INTERVAL_MS);
  });

  it("returns default for zero", () => {
    process.env.ATLAS_EXPERT_SCHEDULER_INTERVAL_HOURS = "0";
    expect(getExpertSchedulerIntervalMs()).toBe(DEFAULT_EXPERT_SCHEDULER_INTERVAL_MS);
  });

  it("returns default for negative", () => {
    process.env.ATLAS_EXPERT_SCHEDULER_INTERVAL_HOURS = "-5";
    expect(getExpertSchedulerIntervalMs()).toBe(DEFAULT_EXPERT_SCHEDULER_INTERVAL_MS);
  });
});

// #3392 — the readers resolve through getSetting's tier chain, so a
// platform-level DB override (admin settings page) must beat the env var.
describe("platform DB override via getSetting (#3392)", () => {
  beforeEach(() => {
    delete process.env.ATLAS_EXPERT_SCHEDULER_ENABLED;
    delete process.env.ATLAS_EXPERT_SCHEDULER_INTERVAL_HOURS;
    _resetSettingsCache();
    dbAvailable = false;
    settingsRows = [];
  });

  afterEach(() => {
    delete process.env.ATLAS_EXPERT_SCHEDULER_ENABLED;
    delete process.env.ATLAS_EXPERT_SCHEDULER_INTERVAL_HOURS;
    _resetSettingsCache();
    dbAvailable = false;
    settingsRows = [];
  });

  it("platform DB override for ATLAS_EXPERT_SCHEDULER_ENABLED beats the env var", async () => {
    process.env.ATLAS_EXPERT_SCHEDULER_ENABLED = "false";
    dbAvailable = true;
    settingsRows = [
      {
        key: "ATLAS_EXPERT_SCHEDULER_ENABLED",
        value: "true",
        updated_at: "2026-01-01",
        updated_by: null,
        org_id: null,
      },
    ];
    await loadSettings();
    expect(isExpertSchedulerEnabled()).toBe(true);
  });

  it("platform DB override for ATLAS_EXPERT_SCHEDULER_INTERVAL_HOURS beats the env var", async () => {
    process.env.ATLAS_EXPERT_SCHEDULER_INTERVAL_HOURS = "24";
    dbAvailable = true;
    settingsRows = [
      {
        key: "ATLAS_EXPERT_SCHEDULER_INTERVAL_HOURS",
        value: "6",
        updated_at: "2026-01-01",
        updated_by: null,
        org_id: null,
      },
    ];
    await loadSettings();
    expect(getExpertSchedulerIntervalMs()).toBe(6 * 60 * 60 * 1000);
  });

  it("falls back to env when no DB override exists", async () => {
    process.env.ATLAS_EXPERT_SCHEDULER_ENABLED = "true";
    dbAvailable = true;
    settingsRows = [];
    await loadSettings();
    expect(isExpertSchedulerEnabled()).toBe(true);
  });
});
