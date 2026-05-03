/**
 * Tests for the F-54 / F-55 approval-gate behaviour in `executeSQL`.
 *
 * Two pinned regressions:
 *
 *  1. **Phase 1 catch is fail-CLOSED.** When the dynamic import of
 *     `@atlas/ee/governance/approval` throws, or `checkApprovalRequired`
 *     itself rejects, the tool must return a `success: false` error to
 *     the agent — not silently proceed. The previous implementation
 *     `log.warn` + dropped the gate, which is the exact silent-failure
 *     shape F-54 / F-55 closed elsewhere; CLAUDE.md cites it as a bug.
 *
 *  2. **Identity-missing routes through the user-identity gate.** When
 *     `checkApprovalRequired` returns `{ required: true, identityMissing: true }`
 *     (the defensive defense-in-depth path), `executeSQL` must reach the
 *     existing `userId/approvalOrgId` block and return the
 *     "requester identity could not be determined" error. A future
 *     refactor that reordered the checks could re-introduce a bypass;
 *     this test catches it.
 */

import { describe, expect, it, beforeEach, mock } from "bun:test";
import { Effect } from "effect";
import { createConnectionMock } from "@atlas/api/testing/connection";

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
  query: mock(async () => ({ columns: ["id"], rows: [{ id: 1 }] })),
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
  withEffectSpan: <T>(_n: string, _a: unknown, e: T) => e,
}));

mock.module("@atlas/api/lib/db/source-rate-limit", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Effect type complex to express
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

mock.module("@atlas/api/lib/settings", () => ({
  getSetting: (key: string) => {
    if (key === "ATLAS_ROW_LIMIT") return "1000";
    if (key === "ATLAS_QUERY_TIMEOUT") return "30000";
    return undefined;
  },
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

mock.module("@atlas/api/lib/config", () => ({
  getConfig: () => ({}),
}));

mock.module("@atlas/api/lib/rls", () => ({
  resolveRLSFilters: () => ({ groups: [], combineWith: "and" }),
  injectRLSConditions: (sql: string) => sql,
}));

let requestContextValue: { requestId: string; user?: { id: string; activeOrganizationId?: string; label?: string; claims?: Record<string, unknown> } } = {
  requestId: "test-approval",
  user: { id: "user-1", activeOrganizationId: "org-1", label: "user-1@example.com" },
};

mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
  getRequestContext: () => requestContextValue,
}));

// Mock the EE approval module with stable exports — tests swap the
// `checkApprovalRequired` implementation per-test via `mockImplementation`
// rather than swapping the module factory (Bun caches the imported module
// after the first dynamic import, so factory swaps don't take effect).
type ApprovalMatchResultMock = {
  required: boolean;
  matchedRules: { id: string; name: string }[];
  identityMissing?: boolean;
};
const mockCheckApprovalRequired = mock<
  (orgId: unknown, t: unknown, c: unknown, options?: unknown) =>
    import("effect").Effect.Effect<ApprovalMatchResultMock, Error, never>
>(() => Effect.succeed({ required: false, matchedRules: [] }));
const mockCreateApprovalRequest = mock(() =>
  Effect.succeed({ id: "req-test", status: "pending" }),
);
const mockHasApprovedRequest = mock(() => Effect.succeed(false));

mock.module("@atlas/ee/governance/approval", () => ({
  checkApprovalRequired: mockCheckApprovalRequired,
  createApprovalRequest: mockCreateApprovalRequest,
  hasApprovedRequest: mockHasApprovedRequest,
}));

const { executeSQL } = await import("@atlas/api/lib/tools/sql");

process.env.ATLAS_DATASOURCE_URL = "postgresql://test:test@localhost:5432/test";

type ToolResult = { success: boolean; error?: string; [key: string]: unknown };
const executeTool = executeSQL.execute as unknown as (
  args: { sql: string; explanation: string; connectionId?: string },
  ctx: { toolCallId: string; messages: unknown[]; abortSignal: AbortSignal },
) => Promise<ToolResult>;

const toolCtx = { toolCallId: "tc-approval", messages: [], abortSignal: undefined as unknown as AbortSignal };

describe("F-54/F-55 executeSQL approval gate", () => {
  beforeEach(() => {
    requestContextValue = {
      requestId: "test-approval",
      user: { id: "user-1", activeOrganizationId: "org-1", label: "user-1@example.com" },
    };
    mockCheckApprovalRequired.mockReset();
    // Default: no rules match, query proceeds.
    mockCheckApprovalRequired.mockImplementation(() =>
      Effect.succeed({ required: false, matchedRules: [] }),
    );
    mockCreateApprovalRequest.mockReset();
    mockHasApprovedRequest.mockReset();
    mockHasApprovedRequest.mockImplementation(() => Effect.succeed(false));
  });

  it("Phase 1 fail-CLOSED: synchronous throw from checkApprovalRequired blocks the query", async () => {
    // Simulates a runtime error inside the EE helper — packaging glitch,
    // unexpected DB schema, etc. Pre-fix this would log.warn and proceed.
    mockCheckApprovalRequired.mockImplementation(() => {
      throw new Error("simulated DB outage during approval lookup");
    });
    const result = await executeTool(
      { sql: "SELECT id FROM companies", explanation: "test" },
      toolCtx,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("Approval system unavailable");
    expect(result.error).toContain("administrator");
  });

  it("Phase 1 fail-CLOSED: rejected Effect from checkApprovalRequired also blocks", async () => {
    mockCheckApprovalRequired.mockImplementation(() =>
      Effect.fail(new Error("simulated transient failure")),
    );
    const result = await executeTool(
      { sql: "SELECT id FROM companies", explanation: "test" },
      toolCtx,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("Approval system unavailable");
  });

  it("identity-missing path routes through the requester-identity gate", async () => {
    // Defensive identityMissing flag from the EE helper. The user has an
    // id but no activeOrganizationId — the existing user-identity check
    // in `lib/tools/sql.ts` must return the clear "approve via the Atlas
    // web app" error. A regression that reordered the checks could
    // silently bypass; this test catches it.
    requestContextValue = {
      requestId: "test-approval",
      user: { id: "user-1", label: "user-1@example.com" },
    };
    mockCheckApprovalRequired.mockImplementation(() =>
      Effect.succeed({
        required: true,
        matchedRules: [{ id: "__identity_missing__", name: "missing-requester-identity" }],
        identityMissing: true,
      }),
    );
    const result = await executeTool(
      { sql: "SELECT id FROM companies", explanation: "test" },
      toolCtx,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("requester identity could not be determined");
    // Defense-in-depth: createApprovalRequest must NOT have been called
    // with the sentinel rule. The user-identity gate fires first.
    expect(mockCreateApprovalRequest).not.toHaveBeenCalled();
  });

  it("normal flow: no rules match → query executes successfully", async () => {
    // Sanity check — the gate doesn't interfere with normal queries when
    // no approval rules match.
    const result = await executeTool(
      { sql: "SELECT id FROM companies", explanation: "test" },
      toolCtx,
    );
    expect(result.success).toBe(true);
  });

  it("passes requesterId to checkApprovalRequired so demo / single-user mode passes through cleanly", async () => {
    requestContextValue = {
      requestId: "test-approval",
      user: { id: "demo:alice", label: "demo:alice" },
    };
    mockCheckApprovalRequired.mockImplementation((orgId: unknown, _t: unknown, _c: unknown, options?: unknown) => {
      // Assert sql.ts forwarded the requester id.
      expect(orgId).toBeUndefined();
      const opts = options as { requesterId?: string } | undefined;
      expect(opts?.requesterId).toBe("demo:alice");
      return Effect.succeed({ required: false, matchedRules: [] });
    });

    const result = await executeTool(
      { sql: "SELECT id FROM companies", explanation: "test" },
      toolCtx,
    );
    expect(result.success).toBe(true);
    expect(mockCheckApprovalRequired).toHaveBeenCalled();
  });
});
