/**
 * Tests for org-scoped table whitelist enforcement in validateSQL.
 *
 * Verifies that when activeOrganizationId is present in the request context,
 * SQL validation uses getOrgWhitelistedTables instead of getWhitelistedTables.
 * This is the security enforcement point for tenant isolation.
 *
 * Uses mock.module() — all named exports mocked.
 */
import { describe, it, expect, mock, beforeEach } from "bun:test";
import { createConnectionMock } from "@atlas/api/testing/connection";

// ---------------------------------------------------------------------------
// Mock request context to simulate org-scoped requests
// ---------------------------------------------------------------------------

let mockOrgId: string | undefined;

mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
  getRequestContext: () =>
    mockOrgId
      ? {
          requestId: "test-req",
          user: {
            id: "user-1",
            mode: "managed" as const,
            label: "test@test.com",
            activeOrganizationId: mockOrgId,
          },
        }
      : undefined,
  withRequestContext: (_ctx: unknown, fn: () => unknown) => fn(),
}));

// ---------------------------------------------------------------------------
// Mock semantic layer — org whitelist returns different tables than file-based
// ---------------------------------------------------------------------------

const orgTables = new Set(["org_orders", "org_users"]);
const fileTables = new Set(["file_orders", "file_users", "file_companies"]);

// Track loadOrgWhitelist invocations so the regression test can
// assert validateSQL preloads the cache. Pre-fix, the MCP edge skipped
// this preload and getOrgWhitelistedTables returned an empty Set,
// rejecting every table with `unknown_entity`.
let loadOrgWhitelistCallCount = 0;
const loadOrgWhitelistCalls: Array<{ orgId: string; mode: string | undefined }> = [];

mock.module("@atlas/api/lib/semantic", () => ({
  getWhitelistedTables: () => fileTables,
  getOrgWhitelistedTables: (_orgId: string) => orgTables,
  loadOrgWhitelist: async (orgId: string, mode: string | undefined) => {
    loadOrgWhitelistCallCount++;
    loadOrgWhitelistCalls.push({ orgId, mode });
    return new Map();
  },
  invalidateOrgWhitelist: () => {},
  getOrgSemanticIndex: async () => "",
  invalidateOrgSemanticIndex: () => {},
  _resetOrgWhitelists: () => {},
  _resetOrgSemanticIndexes: () => {},
  _resetWhitelists: () => {},
  getCrossSourceJoins: () => [],
}));

mock.module("@atlas/api/lib/db/connection", () =>
  createConnectionMock({
    connections: {
      list: () => ["default"],
      describe: () => [{ id: "default", dbType: "postgres" as const }],
      _reset: () => {},
    },
  }),
);

mock.module("@atlas/api/lib/auth/audit", () => ({
  logQueryAudit: () => {},
}));

mock.module("@atlas/api/lib/tracing", () => ({
  withSpan: (_name: string, fn: () => unknown) => fn(),
  withEffectSpan: <T>(_n: string, _a: unknown, e: T) => e,
}));

mock.module("@atlas/api/lib/config", () => ({
  getConfig: () => null,
}));

mock.module("@atlas/api/lib/security", () => ({
  SENSITIVE_PATTERNS: [],
}));

mock.module("@atlas/api/lib/settings", () => ({
  getSetting: () => undefined,
  getSettingAuto: () => undefined,
  getSettingLive: async () => undefined,
  getSettingsForAdmin: () => [],
  getSettingsRegistry: () => [],
  getSettingDefinition: () => undefined,
  setSetting: async () => {},
  deleteSetting: async () => {},
  loadSettings: async () => 0,
  getAllSettingOverrides: async () => [],
  _resetSettingsCache: () => {},
}));

const { validateSQL } = await import("../sql");

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("org-scoped SQL whitelist enforcement", () => {
  beforeEach(() => {
    mockOrgId = undefined;
    loadOrgWhitelistCallCount = 0;
    loadOrgWhitelistCalls.length = 0;
  });

  it("uses org whitelist when activeOrganizationId is present", async () => {
    mockOrgId = "org-123";
    // org_orders is in the org whitelist
    const result = await validateSQL("SELECT * FROM org_orders");
    expect(result.valid).toBe(true);
  });

  it("rejects tables not in org whitelist even if in file whitelist", async () => {
    mockOrgId = "org-123";
    // file_companies is in file whitelist but NOT in org whitelist
    const result = await validateSQL("SELECT * FROM file_companies");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("not in the allowed list");
  });

  it("SaaS rejection points at the admin UI, NOT catalog.yml (#2143)", async () => {
    // On a hosted SaaS workspace there is no catalog.yml in the image —
    // the whitelist is sourced from the per-org `entities` table managed
    // through admin → Semantic. The pre-fix error tail told users to
    // "Check catalog.yml" which is a dead end on SaaS.
    mockOrgId = "org-123";
    const result = await validateSQL("SELECT * FROM file_companies");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("admin → Semantic");
    expect(result.error).not.toContain("catalog.yml");
  });

  it("self-hosted rejection still points at catalog.yml", async () => {
    // The on-disk YAML guidance must remain for self-hosters who edit
    // `semantic/entities/*.yml` directly.
    mockOrgId = undefined;
    const result = await validateSQL("SELECT * FROM org_orders");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("catalog.yml");
    expect(result.error).not.toContain("admin → Semantic");
  });

  it("uses file whitelist when no orgId (self-hosted)", async () => {
    mockOrgId = undefined;
    // file_companies is in the file whitelist
    const result = await validateSQL("SELECT * FROM file_companies");
    expect(result.valid).toBe(true);
  });

  it("rejects tables not in file whitelist when no orgId", async () => {
    mockOrgId = undefined;
    // org_orders is only in the org whitelist, not file
    const result = await validateSQL("SELECT * FROM org_orders");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("not in the allowed list");
  });

  it("preloads the org whitelist on every validateSQL call (regression: MCP edge bug)", async () => {
    // Pre-fix, the MCP edge tool handler called validateSQL without
    // first calling loadOrgWhitelist(orgId). getOrgWhitelistedTables
    // then returned an empty Set (no cache entry for this orgId in
    // the MCP process), so every table was rejected as unknown_entity.
    // The chat path (agent.ts:570) preloaded explicitly; the MCP path
    // didn't. Fixed by lazy-loading inside validateSQL itself —
    // belt-and-suspenders against any future code path that forgets.
    mockOrgId = "org-mcp-edge";
    await validateSQL("SELECT * FROM org_orders");
    expect(loadOrgWhitelistCallCount).toBe(1);
    expect(loadOrgWhitelistCalls[0]).toEqual({ orgId: "org-mcp-edge", mode: undefined });
  });

  it("does NOT preload when no orgId is set (self-hosted no-auth path)", async () => {
    // Self-hosted with no active org → uses the file whitelist
    // (loaded once at startup). loadOrgWhitelist must not be called
    // because there's no org to load for.
    mockOrgId = undefined;
    await validateSQL("SELECT * FROM file_companies");
    expect(loadOrgWhitelistCallCount).toBe(0);
  });

  it("org isolation: different orgs see different whitelists", async () => {
    // This validates the code path — the mock returns the same set for any orgId,
    // but the important thing is that it calls getOrgWhitelistedTables, not getWhitelistedTables
    mockOrgId = "org-A";
    const resultA = await validateSQL("SELECT * FROM org_users");
    expect(resultA.valid).toBe(true);

    mockOrgId = "org-B";
    const resultB = await validateSQL("SELECT * FROM org_users");
    expect(resultB.valid).toBe(true);

    // File-only table rejected for both orgs
    mockOrgId = "org-A";
    const resultFile = await validateSQL("SELECT * FROM file_companies");
    expect(resultFile.valid).toBe(false);
  });
});
