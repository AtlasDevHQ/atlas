/**
 * #3406 — workspace-tier resolution of ATLAS_ROW_LIMIT / ATLAS_QUERY_TIMEOUT
 * in the SQL execution pipeline.
 *
 * Pins that executeSQL threads the request's auth org
 * (`getRequestContext()?.user?.activeOrganizationId`) into the per-query
 * `getSetting` reads, so an org-scoped override row written by a workspace
 * admin governs that workspace's queries — previously the reads passed no
 * orgId and the workspace tier was silently skipped everywhere.
 *
 * Mock structure mirrors sql-rls-settings.test.ts (the settings mock here
 * additionally records the orgId argument).
 */

import { describe, expect, it, beforeEach, mock } from "bun:test";
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
  invalidateOrgSemanticIndexes: () => {},
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
  maskConnectionUrl: (url: string) => url,
}));

mock.module("@atlas/api/lib/tracing", () => ({
  withSpan: async (_name: string, _attrs: unknown, fn: () => Promise<unknown>) => fn(),
  withEffectSpan: <T>(_n: string, _a: unknown, e: T) => e,
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

mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
  // The request's auth org — what the pipeline must thread into getSetting.
  getRequestContext: () => ({
    requestId: "test-3406",
    user: { id: "u1", activeOrganizationId: "org-42", claims: { org_id: "org-42" } },
  }),
}));

// Settings mock records every (key, orgId) read and serves a workspace
// override only when the caller passed the right org — an un-threaded read
// falls through to the platform value, failing the assertions below.
let settingReads: Array<{ key: string; orgId: string | undefined }> = [];
const workspaceOverrides: Record<string, Record<string, string>> = {
  "org-42": {
    ATLAS_ROW_LIMIT: "5",
    ATLAS_QUERY_TIMEOUT: "9000",
  },
};
const getSettingImpl = (key: string, orgId?: string): string | undefined => {
  settingReads.push({ key, orgId });
  return orgId ? workspaceOverrides[orgId]?.[key] : undefined;
};

mock.module("@atlas/api/lib/settings", () => ({
  getSetting: getSettingImpl,
  getSettingAuto: getSettingImpl,
  getSettingLive: async (key: string, orgId?: string) => getSettingImpl(key, orgId),
  getSettingsForAdmin: () => [],
  getSettingsRegistry: () => [],
  getSettingDefinition: () => undefined,
  setSetting: async () => {},
  deleteSetting: async () => {},
  loadSettings: async () => 0,
  getAllSettingOverrides: async () => [],
  _resetSettingsCache: () => {},
}));

let mockConfig: Record<string, unknown> = {};
mock.module("@atlas/api/lib/config", () => ({
  getConfig: () => mockConfig,
}));

mock.module("@atlas/api/lib/rls", () => ({
  resolveRLSFilters: () => ({ groups: [], combineWith: "and" }),
  injectRLSConditions: (sql: string) => sql,
}));

// Import after mocks
const { executeSQL } = await import("@atlas/api/lib/tools/sql");

process.env.ATLAS_DATASOURCE_URL ??= "postgresql://test:test@localhost:5432/test";

type ToolResult = { success: boolean; error?: string; truncated?: boolean; [key: string]: unknown };
const executeTool = executeSQL.execute as unknown as (
  args: { sql: string; explanation: string; connectionId?: string },
  ctx: { toolCallId: string; messages: unknown[]; abortSignal: AbortSignal },
) => Promise<ToolResult>;

const toolCtx = { toolCallId: "tc-3406", messages: [], abortSignal: undefined as unknown as AbortSignal };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("executeSQL — workspace-tier settings resolution (#3406)", () => {
  beforeEach(() => {
    settingReads = [];
    mockConfig = {};
    mockDBConnection.query.mockClear();
  });

  it("threads the auth org into the ATLAS_ROW_LIMIT and ATLAS_QUERY_TIMEOUT reads", async () => {
    const result = await executeTool(
      { sql: "SELECT id FROM companies", explanation: "workspace tier" },
      toolCtx,
    );

    expect(result.success).toBe(true);
    const rowLimitReads = settingReads.filter((r) => r.key === "ATLAS_ROW_LIMIT");
    const timeoutReads = settingReads.filter((r) => r.key === "ATLAS_QUERY_TIMEOUT");
    expect(rowLimitReads.length).toBeGreaterThan(0);
    expect(timeoutReads.length).toBeGreaterThan(0);
    for (const read of [...rowLimitReads, ...timeoutReads]) {
      expect(read.orgId).toBe("org-42");
    }
  });

  it("applies the workspace override to the appended LIMIT and the query timeout", async () => {
    const result = await executeTool(
      { sql: "SELECT id FROM companies", explanation: "workspace values applied" },
      toolCtx,
    );

    expect(result.success).toBe(true);
    const [calledSql, calledTimeout] = mockDBConnection.query.mock.calls[0] as unknown as [
      string,
      number,
    ];
    expect(calledSql).toMatch(/LIMIT 5$/);
    expect(calledTimeout).toBe(9000);
  });
});
