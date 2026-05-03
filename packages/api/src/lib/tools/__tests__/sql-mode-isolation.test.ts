/**
 * Integration tests for mode isolation through the executeSQL tool (#1430).
 *
 * These cover the security contract that `isConnectionVisibleInMode` returning
 * `false` must surface to the agent as a ConnectionNotFound-shaped error
 * with NO draft connection IDs leaked in `available` or `error`.
 */

import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { createConnectionMock } from "@atlas/api/testing/connection";

// Controls used by tests
let mockAtlasMode: "published" | "developer" = "published";
let mockActiveOrgId: string | undefined = "org-1";
const mockIsVisible = mock(async (_orgId: string, _id: string, _mode: string) => true);

mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
  getRequestContext: () =>
    mockActiveOrgId
      ? {
          requestId: "test-req",
          atlasMode: mockAtlasMode,
          user: {
            id: "user-1",
            mode: "managed" as const,
            label: "test@test.com",
            activeOrganizationId: mockActiveOrgId,
          },
        }
      : { requestId: "test-req", atlasMode: mockAtlasMode },
  withRequestContext: (_ctx: unknown, fn: () => unknown) => fn(),
}));

mock.module("@atlas/api/lib/semantic", () => ({
  getOrgWhitelistedTables: () => new Set(["companies"]),
  loadOrgWhitelist: async () => new Map(),
  invalidateOrgWhitelist: () => {},
  getOrgSemanticIndex: async () => "",
  invalidateOrgSemanticIndex: () => {},
  _resetOrgWhitelists: () => {},
  _resetOrgSemanticIndexes: () => {},
  getWhitelistedTables: () => new Set(["companies"]),
  _resetWhitelists: () => {},
}));

const mockConn = {
  query: async () => ({ columns: ["id"], rows: [{ id: 1 }] }),
  close: async () => {},
};

mock.module("@atlas/api/lib/db/connection", () => ({
  ...createConnectionMock({
    connections: {
      // List includes a draft connection ID — the test verifies it must NOT
      // appear in the error returned to a published-mode agent.
      list: () => ["default", "warehouse", "secret_draft_conn"],
      describe: () => [
        { id: "default", dbType: "postgres" as const },
        { id: "warehouse", dbType: "postgres" as const },
        { id: "secret_draft_conn", dbType: "postgres" as const },
      ],
      has: () => true,
      isOrgPoolingEnabled: () => true,
      get: () => mockConn,
      getDefault: () => mockConn,
      getForOrg: () => mockConn,
      getDBType: () => "postgres" as const,
      getTargetHost: () => "localhost",
      getValidator: () => undefined,
      getParserDialect: () => "PostgresQL",
      getForbiddenPatterns: () => [] as RegExp[],
      recordQuery: () => {},
      recordSuccess: () => {},
      recordError: () => {},
    },
  }),
  isConnectionVisibleInMode: mockIsVisible,
}));

mock.module("@atlas/api/lib/tracing", () => ({
  withSpan: async (_n: string, _a: Record<string, unknown>, fn: () => Promise<unknown>) => fn(),
  withEffectSpan: <T>(_n: string, _a: unknown, e: T) => e,
}));

mock.module("@atlas/api/lib/db/source-rate-limit", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  withSourceSlot: (_sourceId: string, effect: any) => effect,
}));

mock.module("@atlas/api/lib/auth/audit", () => ({
  logQueryAudit: () => {},
}));

mock.module("@atlas/api/lib/config", () => ({
  getConfig: () => null,
}));

mock.module("@atlas/api/lib/security", () => ({
  SENSITIVE_PATTERNS: /__never_matches__/,
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

mock.module("@atlas/api/lib/cache/index", () => ({
  getCache: () => ({ get: () => null, set: () => {} }),
  buildCacheKey: () => "k",
  cacheEnabled: () => false,
  getDefaultTtl: () => 60,
}));

mock.module("@atlas/api/lib/learn/pattern-proposer", () => ({
  proposePatternIfNovel: () => {},
}));

const { executeSQL } = await import("../sql");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyResult = any;

const runQuery = (sql: string, connectionId?: string) =>
  executeSQL.execute!(
    { sql, explanation: "test", connectionId },
    { toolCallId: "test", messages: [], abortSignal: undefined as never },
  ) as Promise<AnyResult>;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("executeSQL mode isolation gate", () => {
  const origDatasource = process.env.ATLAS_DATASOURCE_URL;

  beforeEach(() => {
    process.env.ATLAS_DATASOURCE_URL = "postgresql://test:test@localhost:5432/test";
    mockAtlasMode = "published";
    mockActiveOrgId = "org-1";
    mockIsVisible.mockReset();
    mockIsVisible.mockImplementation(async (_o: string, _i: string, _m: string) => true);
  });

  afterEach(() => {
    if (origDatasource) process.env.ATLAS_DATASOURCE_URL = origDatasource;
    else delete process.env.ATLAS_DATASOURCE_URL;
  });

  it("rejects a draft connection in published mode", async () => {
    mockIsVisible.mockImplementation(async (_o: string, id: string, _m: string) => id !== "secret_draft_conn");

    const result = await runQuery("SELECT id FROM companies", "secret_draft_conn");
    expect(result.success).toBe(false);
    expect(result.error).toContain("not available in published mode");
  });

  it("does not leak other connection IDs in the error message or payload", async () => {
    // Zero-knowledge guarantee: a published-mode user asking for a draft must
    // not learn the names of other drafts, other connections, or `default`.
    mockIsVisible.mockImplementation(async (_o: string, id: string, _m: string) => id !== "secret_draft_conn");

    const result = await runQuery("SELECT id FROM companies", "secret_draft_conn");
    expect(result.success).toBe(false);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("warehouse");
    expect(serialized).not.toContain("default");
    // The error must not include the "Available:" list either.
    expect(result.error ?? "").not.toMatch(/Available:/);
  });

  it("accepts a draft connection in developer mode", async () => {
    mockAtlasMode = "developer";
    mockIsVisible.mockImplementation(async (_o: string, _i: string, _m: string) => true);

    const result = await runQuery("SELECT id FROM companies", "secret_draft_conn");
    expect(result.success).toBe(true);
  });

  it("self-hosted without auth (no orgId) skips the gate", async () => {
    mockActiveOrgId = undefined;
    mockIsVisible.mockImplementation(async (_o: string, _i: string, _m: string) => false);

    const result = await runQuery("SELECT id FROM companies", "warehouse");
    // Gate is skipped because authOrgId is undefined; fallthrough to normal
    // resolution. Mock pool returns successfully.
    expect(result.success).toBe(true);
    expect(mockIsVisible).not.toHaveBeenCalled();
  });
});
