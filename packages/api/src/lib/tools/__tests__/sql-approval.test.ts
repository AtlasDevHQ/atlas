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

let requestContextValue: {
  requestId: string;
  user?: { id: string; activeOrganizationId?: string; label?: string; claims?: Record<string, unknown> };
  // #2072 — surface stamped by route-level withRequestContext frames.
  approvalSurface?: "chat" | "mcp" | "scheduler" | "slack" | "teams" | "webhook";
} = {
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
const mockCreateApprovalRequest = mock<
  // #2072 — typed signature so per-test `mockImplementation((opts) => ...)`
  // can assert the surface field on the payload without a `(opts: unknown)`
  // cast that TypeScript narrows away from the original mock factory.
  (opts: unknown) => import("effect").Effect.Effect<{ id: string; status: string }, never, never>
>(() => Effect.succeed({ id: "req-test", status: "pending" }));
const mockHasApprovedRequest = mock(() => Effect.succeed(false));

// Force enterprise on so `ConditionalEELayer` lazy-imports `@atlas/ee/layers`
// — without this, the no-op `ApprovalGate` fires and every test sees
// `required: false` instead of the mock behaviour.
process.env.ATLAS_ENTERPRISE_ENABLED = "true";

// Core ApprovalError stub so the route's `instanceof ApprovalError` /
// `domainError` mapping sees the same class the test layer constructs.
mock.module("@atlas/api/lib/governance/errors", () => ({
  ApprovalError: class ApprovalError extends Error {
    public readonly _tag = "ApprovalError" as const;
    public readonly code: string;
    constructor(args: { message: string; code: string }) {
      super(args.message);
      this.code = args.code;
    }
  },
}));

// Core residency / compliance / model-routing error stubs — the
// EnterpriseLayer's no-op defaults lazy-require these even when only
// ApprovalGate is exercised. Without the stubs the test fails on a
// require() of an unmocked module.
mock.module("@atlas/api/lib/residency/errors", () => ({
  ResidencyError: class extends Error { public readonly _tag = "ResidencyError" as const; },
}));
mock.module("@atlas/api/lib/compliance/errors", () => ({
  ComplianceError: class extends Error { public readonly _tag = "ComplianceError" as const; },
  ReportError: class extends Error { public readonly _tag = "ReportError" as const; },
}));
mock.module("@atlas/api/lib/model-routing/errors", () => ({
  ModelConfigError: class extends Error { public readonly _tag = "ModelConfigError" as const; },
  ModelConfigDecryptError: class extends Error { public readonly _tag = "ModelConfigDecryptError" as const; },
}));

mock.module("@atlas/ee/layers", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Layer, Effect: E } = require("effect") as typeof import("effect");
  return {
    EELayer: Layer.unwrapEffect(
      E.sync(() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const services = require("@atlas/api/lib/effect/services") as typeof import("@atlas/api/lib/effect/services");
        return Layer.succeed(services.ApprovalGate, {
          available: true,
          checkApprovalRequired: mockCheckApprovalRequired,
          createApprovalRequest: mockCreateApprovalRequest,
          hasApprovedRequest: mockHasApprovedRequest,
          // Unused-by-sql.ts methods; stub with `Effect.die` so a future
          // regression that reaches them is loud.
          listApprovalRules: () => E.die("not stubbed"),
          createApprovalRule: () => E.die("not stubbed"),
          updateApprovalRule: () => E.die("not stubbed"),
          deleteApprovalRule: () => E.die("not stubbed"),
          listApprovalRequests: () => E.die("not stubbed"),
          getApprovalRequest: () => E.die("not stubbed"),
          reviewApprovalRequest: () => E.die("not stubbed"),
          expireStaleRequests: () => E.die("not stubbed"),
          getPendingCount: () => E.die("not stubbed"),
        } as never);
      }),
    ),
  };
});

// Legacy module-mock as a no-op stub for any transitive EE re-export
// chain that still resolves the old path.
mock.module("@atlas/ee/governance/approval", () => ({
  checkApprovalRequired: mockCheckApprovalRequired,
  createApprovalRequest: mockCreateApprovalRequest,
  hasApprovedRequest: mockHasApprovedRequest,
  ApprovalError: class extends Error { public readonly _tag = "ApprovalError" as const; },
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

  // ── #2072 surface forwarding ─────────────────────────────────────────
  // Pin the wire from RequestContext.approvalSurface into
  // checkApprovalRequired's options bag and through to the createApprovalRequest
  // payload. The DB-side filter is unit-tested in
  // ee/src/governance/approval.test.ts, but a refactor that drops the
  // `surface: checkSurface` spread in lib/tools/sql.ts would silently
  // degrade every surface-scoped rule to no-op against the corresponding
  // transport without those tests failing.

  it("#2072: forwards approvalSurface from RequestContext into checkApprovalRequired", async () => {
    requestContextValue = {
      requestId: "test-approval",
      user: { id: "user-1", activeOrganizationId: "org-1", label: "user-1@example.com" },
      approvalSurface: "mcp",
    };
    mockCheckApprovalRequired.mockImplementation((_orgId: unknown, _t: unknown, _c: unknown, options?: unknown) => {
      const opts = options as { surface?: string } | undefined;
      expect(opts?.surface).toBe("mcp");
      return Effect.succeed({ required: false, matchedRules: [] });
    });

    const result = await executeTool(
      { sql: "SELECT id FROM companies", explanation: "test" },
      toolCtx,
    );
    expect(result.success).toBe(true);
    expect(mockCheckApprovalRequired).toHaveBeenCalled();
  });

  it("#2072: omits surface from checkApprovalRequired options when RequestContext doesn't stamp one", async () => {
    requestContextValue = {
      requestId: "test-approval",
      user: { id: "user-1", activeOrganizationId: "org-1", label: "user-1@example.com" },
      // approvalSurface deliberately absent — legacy / unstamped path.
    };
    mockCheckApprovalRequired.mockImplementation((_orgId: unknown, _t: unknown, _c: unknown, options?: unknown) => {
      const opts = options as { surface?: string } | undefined;
      expect(opts?.surface).toBeUndefined();
      return Effect.succeed({ required: false, matchedRules: [] });
    });

    const result = await executeTool(
      { sql: "SELECT id FROM companies", explanation: "test" },
      toolCtx,
    );
    expect(result.success).toBe(true);
  });

  it("#2072: stamps approvalSurface on the createApprovalRequest payload when a rule matches", async () => {
    requestContextValue = {
      requestId: "test-approval",
      user: { id: "user-1", activeOrganizationId: "org-1", label: "user-1@example.com" },
      approvalSurface: "slack",
    };
    mockCheckApprovalRequired.mockImplementation(() =>
      Effect.succeed({
        required: true,
        matchedRules: [{ id: "rule-1", name: "PII tables" }],
      }),
    );
    mockCreateApprovalRequest.mockImplementation((opts: unknown) => {
      const p = opts as { surface?: string | null };
      expect(p.surface).toBe("slack");
      return Effect.succeed({ id: "req-test", status: "pending" });
    });

    const result = await executeTool(
      { sql: "SELECT id FROM companies", explanation: "test" },
      toolCtx,
    );
    expect(result.success).toBe(false);
    expect(result.approval_required).toBe(true);
    expect(mockCreateApprovalRequest).toHaveBeenCalled();
  });

  it("#2072: stamps null surface on the createApprovalRequest payload when caller didn't stamp one", async () => {
    // Legacy / unstamped path — the queue row records null which renders
    // as "unknown_origin" in admin-action metadata. Pinning this keeps
    // the audit-dimension contract intact for callers that haven't been
    // retrofitted.
    requestContextValue = {
      requestId: "test-approval",
      user: { id: "user-1", activeOrganizationId: "org-1", label: "user-1@example.com" },
    };
    mockCheckApprovalRequired.mockImplementation(() =>
      Effect.succeed({
        required: true,
        matchedRules: [{ id: "rule-1", name: "PII tables" }],
      }),
    );
    mockCreateApprovalRequest.mockImplementation((opts: unknown) => {
      const p = opts as { surface?: string | null };
      expect(p.surface).toBeNull();
      return Effect.succeed({ id: "req-test", status: "pending" });
    });

    const result = await executeTool(
      { sql: "SELECT id FROM companies", explanation: "test" },
      toolCtx,
    );
    expect(result.success).toBe(false);
    expect(mockCreateApprovalRequest).toHaveBeenCalled();
  });
});
