/**
 * Tests for the RLS settings overlay in SaaS mode (#1089 gap 1).
 *
 * Validates that:
 * - Settings can disable boot-time RLS
 * - Settings can enable RLS with column + claim
 * - Missing column fails closed (query blocked, error logged)
 * - Missing claim fails closed (query blocked, error logged)
 * - Non-SaaS mode ignores settings overlay
 */

import { describe, expect, it, beforeEach, mock, type Mock } from "bun:test";
import { createConnectionMock } from "@atlas/api/testing/connection";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const whitelistedTables = new Set(["companies"]);
mock.module("@atlas/api/lib/semantic", () => ({
  getOrgWhitelistedTables: () => whitelistedTables,
  loadOrgWhitelist: async () => new Map(),
  invalidateOrgWhitelist: () => {},
  getOrgSemanticIndex: async () => "",
  invalidateOrgSemanticIndex: () => {},
  _resetOrgWhitelists: () => {},
  _resetOrgSemanticIndexes: () => {},
  getWhitelistedTables: () => whitelistedTables,
  _resetWhitelists: () => {},
}));

const mockDBConnection = {
  query: mock(async () => ({
    columns: ["id"],
    rows: [{ id: 1 }],
  })),
  close: async () => {},
};

mock.module("@atlas/api/lib/db/connection", () =>
  createConnectionMock({
    getDB: () => mockDBConnection,
    connections: {
      get: () => mockDBConnection,
      getDefault: () => mockDBConnection,
    },
  }),
);

mock.module("@atlas/api/lib/auth/audit", () => ({
  logQueryAudit: () => {},
}));

mock.module("@atlas/api/lib/security", () => ({
  SENSITIVE_PATTERNS: /password|secret/i,
}));

mock.module("@atlas/api/lib/tracing", () => ({
  withSpan: async (_name: string, _attrs: unknown, fn: () => Promise<unknown>) => fn(),
}));

mock.module("@atlas/api/lib/db/source-rate-limit", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Effect type is complex to express in mock
  withSourceSlot: (_sourceId: string, effect: any) => effect,
}));

mock.module("@atlas/api/lib/cache/index", () => ({
  cacheEnabled: () => false,
  getCache: () => ({ get: () => null, set: () => {} }),
  buildCacheKey: () => "",
  getDefaultTtl: () => 60000,
}));

mock.module("@atlas/api/lib/plugins/hooks", () => ({
  dispatchHook: async () => {},
  dispatchMutableHook: async (_name: string, ctx: { sql: string }) => ctx.sql,
}));

// Track error log calls for security audit trail assertions
let errorLogCalls: Array<unknown[]> = [];

mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: (...args: unknown[]) => { errorLogCalls.push(args); },
    debug: () => {},
  }),
  getRequestContext: () => ({
    requestId: "test-rls",
    user: { id: "u1", claims: { org_id: "org-42" } },
  }),
}));

// Mutable settings for per-test control
let mockSettingValues: Record<string, string | undefined> = {};

mock.module("@atlas/api/lib/settings", () => ({
  getSetting: (key: string) => mockSettingValues[key] ?? undefined,
  getSettingAuto: (key: string) => mockSettingValues[key] ?? undefined,
  getSettingLive: async (key: string) => mockSettingValues[key] ?? undefined,
  getSettingsForAdmin: () => [],
  getSettingsRegistry: () => [],
  getSettingDefinition: () => undefined,
  setSetting: async () => {},
  deleteSetting: async () => {},
  loadSettings: async () => 0,
  getAllSettingOverrides: async () => [],
  _resetSettingsCache: () => {},
}));

// Mutable config for per-test control
let mockConfig: Record<string, unknown> = {};

mock.module("@atlas/api/lib/config", () => ({
  getConfig: () => mockConfig,
}));

// Mock RLS module — track calls to verify overlay behavior
let rlsResolveCalls: Array<{ tables: Set<string>; config: unknown }> = [];
mock.module("@atlas/api/lib/rls", () => ({
  resolveRLSFilters: (_user: unknown, tables: Set<string>, config: unknown) => {
    rlsResolveCalls.push({ tables, config });
    return { groups: [], combineWith: "and" };
  },
  injectRLSConditions: (sql: string) => sql,
}));

// Import after mocks
const { executeSQL } = await import("@atlas/api/lib/tools/sql");

process.env.ATLAS_DATASOURCE_URL = "postgresql://test:test@localhost:5432/test";

type ToolResult = { success: boolean; error?: string; [key: string]: unknown };
const executeTool = executeSQL.execute as unknown as (
  args: { sql: string; explanation: string; connectionId?: string },
  ctx: { toolCallId: string; messages: unknown[]; abortSignal: AbortSignal },
) => Promise<ToolResult>;

const toolCtx = { toolCallId: "tc-rls", messages: [], abortSignal: undefined as unknown as AbortSignal };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("RLS settings overlay in SaaS mode", () => {
  beforeEach(() => {
    mockSettingValues = {
      ATLAS_ROW_LIMIT: "1000",
      ATLAS_QUERY_TIMEOUT: "30000",
    };
    mockConfig = {};
    rlsResolveCalls = [];
    errorLogCalls = [];
    (mockDBConnection.query as Mock<typeof mockDBConnection.query>).mockReset();
    (mockDBConnection.query as Mock<typeof mockDBConnection.query>).mockResolvedValue({
      columns: ["id"],
      rows: [{ id: 1 }],
    });
  });

  it("settings disabling RLS in SaaS mode skips RLS entirely", async () => {
    mockConfig = {
      deployMode: "saas",
      rls: { enabled: true, policies: [{ tables: ["*"], column: "tenant_id", claim: "org_id" }] },
    };
    // Setting explicitly disables RLS
    mockSettingValues.ATLAS_RLS_ENABLED = "false";

    const result = await executeTool(
      { sql: "SELECT id FROM companies", explanation: "test" },
      toolCtx,
    );

    expect(result.success).toBe(true);
    // resolveRLSFilters should NOT have been called — settings disabled RLS
    expect(rlsResolveCalls).toHaveLength(0);
  });

  it("settings enabling RLS with column+claim creates overlay policy", async () => {
    mockConfig = { deployMode: "saas" };
    mockSettingValues.ATLAS_RLS_ENABLED = "true";
    mockSettingValues.ATLAS_RLS_COLUMN = "tenant_id";
    mockSettingValues.ATLAS_RLS_CLAIM = "org_id";

    const result = await executeTool(
      { sql: "SELECT id FROM companies", explanation: "test" },
      toolCtx,
    );

    expect(result.success).toBe(true);
    // resolveRLSFilters should have been called with the overlay config
    expect(rlsResolveCalls).toHaveLength(1);
    const config = rlsResolveCalls[0].config as { enabled: boolean; policies: Array<{ column: string; claim: string }> };
    expect(config.enabled).toBe(true);
    expect(config.policies).toHaveLength(1);
    expect(config.policies[0].column).toBe("tenant_id");
    expect(config.policies[0].claim).toBe("org_id");
  });

  it("RLS enabled but missing column fails closed (query blocked)", async () => {
    mockConfig = { deployMode: "saas" };
    mockSettingValues.ATLAS_RLS_ENABLED = "true";
    // column missing, only claim set
    mockSettingValues.ATLAS_RLS_CLAIM = "org_id";

    const result = await executeTool(
      { sql: "SELECT id FROM companies", explanation: "test" },
      toolCtx,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("not fully configured");
    // Security audit trail: error must be logged for RLS misconfiguration
    expect(errorLogCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("RLS enabled but missing claim fails closed (query blocked)", async () => {
    mockConfig = { deployMode: "saas" };
    mockSettingValues.ATLAS_RLS_ENABLED = "true";
    // claim missing, only column set
    mockSettingValues.ATLAS_RLS_COLUMN = "tenant_id";

    const result = await executeTool(
      { sql: "SELECT id FROM companies", explanation: "test" },
      toolCtx,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("not fully configured");
    // Security audit trail: error must be logged for RLS misconfiguration
    expect(errorLogCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("non-SaaS mode ignores RLS settings overlay", async () => {
    mockConfig = {
      deployMode: "self-hosted",
      rls: { enabled: true, policies: [{ tables: ["*"], column: "tenant_id", claim: "org_id" }] },
    };
    // Even though setting says disabled, non-SaaS ignores it
    mockSettingValues.ATLAS_RLS_ENABLED = "false";

    const result = await executeTool(
      { sql: "SELECT id FROM companies", explanation: "test" },
      toolCtx,
    );

    expect(result.success).toBe(true);
    // resolveRLSFilters SHOULD have been called with boot-time config (not overlay)
    expect(rlsResolveCalls).toHaveLength(1);
    const config = rlsResolveCalls[0].config as { enabled: boolean };
    expect(config.enabled).toBe(true);
  });
});
