/**
 * #3392 — getAutoApproveThreshold / getAutoApproveTypes are workspace-scoped
 * settings and must resolve through getSetting(key, orgId) so per-workspace
 * DB overrides written from the admin settings page are honored.
 *
 * The settings module is mocked here (all value exports — mock-all-exports
 * rule) so we can observe exactly which (key, orgId) pair each helper asks
 * for and simulate a workspace override without a DB. Env-fallback behavior
 * with the REAL settings module is covered by auto-approve-types.test.ts.
 */
import { describe, it, expect, beforeEach, mock } from "bun:test";

void mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
  getRequestContext: () => undefined,
}));

// Stub out heavy deps that internal.ts imports at module level
void mock.module("@effect/sql", () => ({ SqlClient: { Tag: () => ({}) } }));
void mock.module("@effect/sql-pg", () => ({ PgClient: { layerFromPool: () => ({}) } }));

// Per-(key, orgId) value map the mock getSetting resolves from. Keyed
// "KEY" for platform-tier and "KEY\0orgId" for workspace-tier — mirrors
// the real cache-key shape in settings.ts.
let settingValues = new Map<string, string>();

function mockResolve(key: string, orgId?: string): string | undefined {
  if (orgId) {
    const ws = settingValues.get(`${key}\0${orgId}`);
    if (ws !== undefined) return ws;
  }
  return settingValues.get(key);
}

const getSettingMock = mock(mockResolve);

// Mock ALL value exports of the settings module (mock-all-exports rule).
void mock.module("@atlas/api/lib/settings", () => ({
  _resetSettingsCache: () => {},
  getSetting: getSettingMock,
  getSettingAuto: getSettingMock,
  getSettingLive: async (key: string, orgId?: string) => mockResolve(key, orgId),
  loadSettings: async () => 0,
  setSetting: async () => {},
  deleteSetting: async () => {},
  getAllSettingOverrides: async () => [],
  getSettingsForAdmin: () => [],
  getSettingsRegistry: () => [],
  getSettingDefinition: () => undefined,
  refreshSettingsTick: async () => {},
  isSaasModeForGuard: () => false,
}));

const { getAutoApproveThreshold, getAutoApproveTypes } = await import("../internal");

describe("getAutoApproveThreshold — workspace override (#3392)", () => {
  beforeEach(() => {
    settingValues = new Map();
    getSettingMock.mockClear();
  });

  it("asks getSetting for the key with the orgId", () => {
    getAutoApproveThreshold("org-1");
    expect(getSettingMock).toHaveBeenCalledWith("ATLAS_EXPERT_AUTO_APPROVE_THRESHOLD", "org-1");
  });

  it("honors a workspace override over the platform value", () => {
    settingValues.set("ATLAS_EXPERT_AUTO_APPROVE_THRESHOLD", "0.9");
    settingValues.set("ATLAS_EXPERT_AUTO_APPROVE_THRESHOLD\0org-1", "0.5");
    expect(getAutoApproveThreshold("org-1")).toBe(0.5);
  });

  it("falls back to the platform value when the workspace has no override", () => {
    settingValues.set("ATLAS_EXPERT_AUTO_APPROVE_THRESHOLD", "0.9");
    expect(getAutoApproveThreshold("org-2")).toBe(0.9);
  });

  it("is disabled (returns > 1) when nothing is configured", () => {
    expect(getAutoApproveThreshold()).toBe(2);
    expect(getAutoApproveThreshold("org-1")).toBe(2);
  });

  it("rejects an invalid workspace override and stays disabled", () => {
    settingValues.set("ATLAS_EXPERT_AUTO_APPROVE_THRESHOLD\0org-1", "5");
    expect(getAutoApproveThreshold("org-1")).toBe(2);
  });
});

describe("getAutoApproveTypes — workspace override (#3392)", () => {
  beforeEach(() => {
    settingValues = new Map();
    getSettingMock.mockClear();
  });

  it("asks getSetting for the key with the orgId", () => {
    getAutoApproveTypes("org-1");
    expect(getSettingMock).toHaveBeenCalledWith("ATLAS_EXPERT_AUTO_APPROVE_TYPES", "org-1");
  });

  it("honors a workspace override over the platform value", () => {
    settingValues.set("ATLAS_EXPERT_AUTO_APPROVE_TYPES", "update_description");
    settingValues.set("ATLAS_EXPERT_AUTO_APPROVE_TYPES\0org-1", "add_join,add_measure");
    expect(getAutoApproveTypes("org-1")).toEqual(new Set(["add_join", "add_measure"]));
  });

  it("falls back to the built-in default when nothing is configured", () => {
    expect(getAutoApproveTypes("org-1")).toEqual(
      new Set(["update_description", "add_dimension"]),
    );
  });
});

describe("insertSemanticAmendment threads its orgId into the helpers (#3392)", () => {
  // insertSemanticAmendment can't run without a DB, so pin the threading
  // structurally — same source-shape pattern as
  // connection-runtime-guards.test.ts for ATLAS_ROW_LIMIT.
  it("passes the amendment orgId to both auto-approve readers", async () => {
    const src = await Bun.file(new URL("../internal.ts", import.meta.url)).text();
    expect(src).toContain("const settingsOrgId = amendment.orgId ?? undefined;");
    expect(src).toContain("getAutoApproveThreshold(settingsOrgId)");
    expect(src).toContain("getAutoApproveTypes(settingsOrgId)");
  });
});
