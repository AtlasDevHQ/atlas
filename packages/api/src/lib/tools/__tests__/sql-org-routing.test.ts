/**
 * Integration tests for executeSQL org-scoped pool routing (#531).
 *
 * Verifies that when activeOrganizationId is set and isOrgPoolingEnabled() is
 * true, connections.getForOrg(orgId, connId) is called and that orgId flows
 * through to recordQuery/recordSuccess/recordError.
 */

import { describe, expect, it, beforeEach, mock, type Mock } from "bun:test";
import { createConnectionMock } from "@atlas/api/testing/connection";

// --- Mocks ---

const mockOrgDBConnection = {
  query: mock(async () => ({
    columns: ["id"],
    rows: [{ id: 1 }],
  })),
  close: async () => {},
};

const mockBaseDBConnection = {
  query: mock(async () => ({
    columns: ["id"],
    rows: [{ id: 1 }],
  })),
  close: async () => {},
};

let mockOrgPoolingEnabled = false;
const mockGetForOrg: Mock<(orgId: string, connId: string) => unknown> = mock(
  () => mockOrgDBConnection,
);
const mockRecordQuery: Mock<(id: string, durationMs: number, orgId?: string) => void> = mock(() => {});
const mockRecordSuccess: Mock<(id: string, orgId?: string) => void> = mock(() => {});
const mockRecordError: Mock<(id: string, orgId?: string) => void> = mock(() => {});

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

mock.module("@atlas/api/lib/db/connection", () =>
  createConnectionMock({
    getDB: () => mockBaseDBConnection,
    connections: {
      get: () => mockBaseDBConnection,
      getDefault: () => mockBaseDBConnection,
      isOrgPoolingEnabled: () => mockOrgPoolingEnabled,
      getForOrg: mockGetForOrg,
      recordQuery: mockRecordQuery,
      recordSuccess: mockRecordSuccess,
      recordError: mockRecordError,
    },
  }),
);

// Mock the request context to inject user with activeOrganizationId
let mockRequestContext: Record<string, unknown> | undefined;
mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
  getRequestContext: () => mockRequestContext,
}));

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
  acquireSourceSlot: () => ({ acquired: true }),
  decrementSourceConcurrency: () => {},
}));

mock.module("@atlas/api/lib/config", () => ({
  getConfig: () => ({}),
}));

mock.module("@atlas/api/lib/rls", () => ({
  resolveRLSFilters: () => ({ groups: [] }),
  injectRLSConditions: (sql: string) => sql,
}));

mock.module("@atlas/api/lib/settings", () => ({
  getSetting: (key: string) => {
    if (key === "ATLAS_ROW_LIMIT") return "1000";
    if (key === "ATLAS_QUERY_TIMEOUT") return "30000";
    return undefined;
  },
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

// Import after mocks
const { executeSQL } = await import("@atlas/api/lib/tools/sql");

// Set env for detectDBType fallback
process.env.ATLAS_DATASOURCE_URL = "postgresql://test:test@localhost:5432/test";

// Helper to call executeSQL.execute with proper typing
type ToolResult = { success: boolean; error?: string; [key: string]: unknown };
const executeTool = executeSQL.execute as unknown as (
  args: { sql: string; explanation: string; connectionId?: string },
  ctx: { toolCallId: string; messages: unknown[]; abortSignal: AbortSignal },
) => Promise<ToolResult>;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("executeSQL org-scoped routing", () => {
  beforeEach(() => {
    mockOrgPoolingEnabled = false;
    mockRequestContext = undefined;
    mockGetForOrg.mockReset();
    mockGetForOrg.mockReturnValue(mockOrgDBConnection);
    mockRecordQuery.mockReset();
    mockRecordSuccess.mockReset();
    mockRecordError.mockReset();
    (mockBaseDBConnection.query as Mock<typeof mockBaseDBConnection.query>).mockReset();
    (mockBaseDBConnection.query as Mock<typeof mockBaseDBConnection.query>).mockResolvedValue({
      columns: ["id"],
      rows: [{ id: 1 }],
    });
    (mockOrgDBConnection.query as Mock<typeof mockOrgDBConnection.query>).mockReset();
    (mockOrgDBConnection.query as Mock<typeof mockOrgDBConnection.query>).mockResolvedValue({
      columns: ["id"],
      rows: [{ id: 1 }],
    });
  });

  it("uses base connection when org pooling is disabled", async () => {
    mockOrgPoolingEnabled = false;
    mockRequestContext = { user: { id: "u1", activeOrganizationId: "org-1" } };

    const result = await executeTool(
      { sql: "SELECT id FROM companies", explanation: "test", connectionId: undefined },
      { toolCallId: "tc-1", messages: [], abortSignal: undefined as unknown as AbortSignal },
    );
    expect(result.success).toBe(true);
    // getForOrg should NOT have been called
    expect(mockGetForOrg.mock.calls.length).toBe(0);
    // recordQuery should have been called without orgId
    expect(mockRecordQuery.mock.calls.length).toBe(1);
    expect((mockRecordQuery.mock.calls as unknown[][])[0]?.[2]).toBeUndefined();
  });

  it("uses org pool when org pooling is enabled and user has orgId", async () => {
    mockOrgPoolingEnabled = true;
    mockRequestContext = { user: { id: "u1", activeOrganizationId: "org-42" } };

    const result = await executeTool(
      { sql: "SELECT id FROM companies", explanation: "test", connectionId: undefined },
      { toolCallId: "tc-2", messages: [], abortSignal: undefined as unknown as AbortSignal },
    );
    expect(result.success).toBe(true);
    // getForOrg should have been called with orgId and "default"
    expect(mockGetForOrg.mock.calls.length).toBe(1);
    expect((mockGetForOrg.mock.calls as unknown[][])[0]?.[0]).toBe("org-42");
    expect((mockGetForOrg.mock.calls as unknown[][])[0]?.[1]).toBe("default");
  });

  it("passes orgId to recordQuery on success", async () => {
    mockOrgPoolingEnabled = true;
    mockRequestContext = { user: { id: "u1", activeOrganizationId: "org-7" } };

    await executeTool(
      { sql: "SELECT id FROM companies", explanation: "test", connectionId: undefined },
      { toolCallId: "tc-3", messages: [], abortSignal: undefined as unknown as AbortSignal },
    );
    // recordQuery called with orgId
    expect(mockRecordQuery.mock.calls.length).toBe(1);
    expect((mockRecordQuery.mock.calls as unknown[][])[0]?.[0]).toBe("default");
    expect((mockRecordQuery.mock.calls as unknown[][])[0]?.[2]).toBe("org-7");
    // recordSuccess called with orgId
    expect(mockRecordSuccess.mock.calls.length).toBe(1);
    expect((mockRecordSuccess.mock.calls as unknown[][])[0]?.[0]).toBe("default");
    expect((mockRecordSuccess.mock.calls as unknown[][])[0]?.[1]).toBe("org-7");
  });

  it("passes orgId to recordError on query failure", async () => {
    mockOrgPoolingEnabled = true;
    mockRequestContext = { user: { id: "u1", activeOrganizationId: "org-err" } };
    (mockOrgDBConnection.query as Mock<typeof mockOrgDBConnection.query>).mockRejectedValue(
      new Error("relation does not exist"),
    );

    const result = await executeTool(
      { sql: "SELECT id FROM companies", explanation: "test", connectionId: undefined },
      { toolCallId: "tc-4", messages: [], abortSignal: undefined as unknown as AbortSignal },
    );
    expect(result.success).toBe(false);
    // recordQuery and recordError called with orgId
    expect(mockRecordQuery.mock.calls.length).toBe(1);
    expect((mockRecordQuery.mock.calls as unknown[][])[0]?.[2]).toBe("org-err");
    expect(mockRecordError.mock.calls.length).toBe(1);
    expect((mockRecordError.mock.calls as unknown[][])[0]?.[0]).toBe("default");
    expect((mockRecordError.mock.calls as unknown[][])[0]?.[1]).toBe("org-err");
  });

  it("uses base connection when org pooling enabled but user has no orgId", async () => {
    mockOrgPoolingEnabled = true;
    mockRequestContext = { user: { id: "u1" } };

    const result = await executeTool(
      { sql: "SELECT id FROM companies", explanation: "test", connectionId: undefined },
      { toolCallId: "tc-5", messages: [], abortSignal: undefined as unknown as AbortSignal },
    );
    expect(result.success).toBe(true);
    expect(mockGetForOrg.mock.calls.length).toBe(0);
  });

  it("routes to specific connectionId with org pool", async () => {
    mockOrgPoolingEnabled = true;
    mockRequestContext = { user: { id: "u1", activeOrganizationId: "org-99" } };

    const result = await executeTool(
      { sql: "SELECT id FROM companies", explanation: "test", connectionId: "warehouse" },
      { toolCallId: "tc-6", messages: [], abortSignal: undefined as unknown as AbortSignal },
    );
    expect(result.success).toBe(true);
    expect(mockGetForOrg.mock.calls.length).toBe(1);
    expect((mockGetForOrg.mock.calls as unknown[][])[0]?.[0]).toBe("org-99");
    expect((mockGetForOrg.mock.calls as unknown[][])[0]?.[1]).toBe("warehouse");
  });

  it("returns agent-friendly error when PoolCapacityExceededError is thrown", async () => {
    mockOrgPoolingEnabled = true;
    mockRequestContext = { user: { id: "u1", activeOrganizationId: "org-full" } };

    // Simulate capacity exceeded
    const CapacityError = (await import("@atlas/api/lib/db/connection")).PoolCapacityExceededError;
    mockGetForOrg.mockImplementation(() => {
      throw new CapacityError(100, 5, 100);
    });

    const result = await executeTool(
      { sql: "SELECT id FROM companies", explanation: "test", connectionId: undefined },
      { toolCallId: "tc-cap", messages: [], abortSignal: undefined as unknown as AbortSignal },
    );
    expect(result.success).toBe(false);
    // Should get agent-friendly message, not operator-facing "failed to initialize"
    expect(result.error).toContain("pool capacity reached");
    expect(result.error).not.toContain("failed to initialize");
  });
});
