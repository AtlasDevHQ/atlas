/**
 * Direct tests for the unified SQL execution pipeline seam (#4185).
 *
 * `runSqlPipelineEffect` is the ONE core effect both `runUserQueryPipeline`
 * (raw path: dashboards, metrics, validate-proposal, executeSQL-over-REST)
 * and the agent `executeSQL` leaf wrap. These tests exercise the shared
 * seam itself — approval fail-closed, RLS injection, auto row limit — and
 * pin that governance behavior is identical regardless of which pre-step
 * (dashboard parameter binding vs result-cache check) a wrapper
 * contributes. Before #4185 that identity was comment-maintained across
 * two hand-mirrored copies; a fix to one could silently skip the other.
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

let executedQueries: string[] = [];
const mockDBConnection = {
  query: mock(async (sql: string) => {
    executedQueries.push(sql);
    return { columns: ["id"], rows: [{ id: 1 }] };
  }),
  close: async () => {},
};

// Mutable so the non-bindable-dialect test can present a datasource where
// dashboard parameter binding is unsupported (fail-closed rejection).
let mockDbType = "postgres";

mock.module("@atlas/api/lib/db/connection", () =>
  createConnectionMock({
    getDB: () => mockDBConnection,
    connections: {
      get: () => mockDBConnection,
      getDefault: () => mockDBConnection,
      getDBType: () => mockDbType,
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Effect type complex to express
  withSourceSlot: (_sourceId: string, effect: any) => effect,
}));

// Result cache — the agent-path pre-step. Mutable knobs let the ordering
// test place a poisoned entry that MUST NOT be served past the approval gate.
let cacheIsEnabled = false;
let cacheEntry:
  | { columns: string[]; rows: Record<string, unknown>[]; cachedAt: number; ttl: number; executionMs?: number }
  | null = null;
mock.module("@atlas/api/lib/cache/index", () => ({
  cacheEnabled: () => cacheIsEnabled,
  getCache: () => ({ get: () => cacheEntry, set: () => {} }),
  buildCacheKey: () => "seam-test-key",
  getDefaultTtl: () => 60000,
}));

// Captures what SQL string the beforeQuery hook receives — the hook-input
// contract test asserts the per-path derivation (original vs bound SQL).
let hookSqlSeen: string[] = [];
mock.module("@atlas/api/lib/plugins/hooks", () => ({
  dispatchHook: async () => {},
  dispatchMutableHook: async (_name: string, ctx: { sql: string }) => {
    hookSqlSeen.push(ctx.sql);
    return ctx.sql;
  },
}));

// Row limit is a mutable knob so the auto-LIMIT test can pin a distinctive value.
let rowLimitSetting = "1000";
mock.module("@atlas/api/lib/settings", () => ({
  getSetting: (key: string) => {
    if (key === "ATLAS_ROW_LIMIT") return rowLimitSetting;
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

// RLS — mutable knobs: disabled by default; the injection test enables it
// and asserts the injected predicate reaches the driver.
let rlsConfigEnabled = false;
mock.module("@atlas/api/lib/config", () => ({
  getConfig: () =>
    rlsConfigEnabled
      ? { rls: { enabled: true, policies: [{ tables: ["*"], column: "tenant_id", claim: "tenantId" }] } }
      : {},
}));

// Captures the filter groups the pipeline passes into injection so the RLS
// test asserts propagation (resolved filters → injector), not just plumbing.
let rlsGroupsSeen: unknown[] = [];
mock.module("@atlas/api/lib/rls", () => ({
  resolveRLSFilters: () =>
    rlsConfigEnabled
      ? { groups: [{ filters: [{ table: "companies", column: "tenant_id", value: "tenant-42" }] }], combineWith: "and" }
      : { groups: [], combineWith: "and" },
  injectRLSConditions: (sql: string, groups: unknown) => {
    rlsGroupsSeen.push(groups);
    return rlsConfigEnabled ? `${sql} WHERE tenant_id = 'tenant-42'` : sql;
  },
}));

let requestContextValue: {
  requestId: string;
  user?: { id: string; activeOrganizationId?: string; label?: string; claims?: Record<string, unknown> };
} = {
  requestId: "test-seam",
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

// ── EE approval gate mock (same scaffolding as sql-approval.test.ts) ──
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
  (opts: unknown) => import("effect").Effect.Effect<{ id: string; status: string }, never, never>
>(() => Effect.succeed({ id: "req-seam", status: "pending" }));
const mockHasApprovedRequest = mock(() => Effect.succeed(false));

// Force enterprise on so `ConditionalEELayer` lazy-imports `@atlas/ee/layers`
// — without this, the no-op `ApprovalGate` fires and every test sees
// `required: false` instead of the mock behaviour. `??=` per the
// module-load contract (docs/development/testing.md).
process.env.ATLAS_ENTERPRISE_ENABLED ??= "true";

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

mock.module("@atlas/ee/governance/approval", () => ({
  checkApprovalRequired: mockCheckApprovalRequired,
  createApprovalRequest: mockCreateApprovalRequest,
  hasApprovedRequest: mockHasApprovedRequest,
  ApprovalError: class extends Error { public readonly _tag = "ApprovalError" as const; },
}));

const { runSqlPipelineEffect } = await import("@atlas/api/lib/tools/sql");
type SqlPipelineOutcome = import("@atlas/api/lib/tools/sql").SqlPipelineOutcome;

process.env.ATLAS_DATASOURCE_URL ??= "postgresql://test:test@localhost:5432/test";

/** Run the seam with a given pre-step (or none) against the default connection. */
function runSeam(
  preStep?: import("@atlas/api/lib/tools/sql").SqlPipelineOptions["preStep"],
  sql = "SELECT id FROM companies",
): Promise<SqlPipelineOutcome> {
  return Effect.runPromise(
    runSqlPipelineEffect({
      sql,
      explanation: "seam test",
      connId: "default",
      ...(preStep ? { preStep } : {}),
    }),
  );
}

/** The three wrapper configurations that must share one gate. */
const PRE_STEPS: {
  label: string;
  preStep?: import("@atlas/api/lib/tools/sql").SqlPipelineOptions["preStep"];
}[] = [
  { label: "raw path (bind-dashboard-parameters)", preStep: { kind: "bind-dashboard-parameters", values: {} } },
  { label: "agent path (check-cache)", preStep: { kind: "check-cache" } },
  { label: "no pre-step", preStep: undefined },
];

describe("unified SQL pipeline seam (#4185)", () => {
  beforeEach(() => {
    requestContextValue = {
      requestId: "test-seam",
      user: { id: "user-1", activeOrganizationId: "org-1", label: "user-1@example.com" },
    };
    executedQueries = [];
    hookSqlSeen = [];
    rlsGroupsSeen = [];
    mockDbType = "postgres";
    mockDBConnection.query.mockClear();
    cacheIsEnabled = false;
    cacheEntry = null;
    rowLimitSetting = "1000";
    rlsConfigEnabled = false;
    mockCheckApprovalRequired.mockReset();
    mockCheckApprovalRequired.mockImplementation(() =>
      Effect.succeed({ required: false, matchedRules: [] }),
    );
    mockCreateApprovalRequest.mockReset();
    mockCreateApprovalRequest.mockImplementation(() =>
      Effect.succeed({ id: "req-seam", status: "pending" }),
    );
    mockHasApprovedRequest.mockReset();
    mockHasApprovedRequest.mockImplementation(() => Effect.succeed(false));
  });

  // ── Approval gate: fail-closed, once, for every wrapper shape ──────
  for (const { label, preStep } of PRE_STEPS) {
    it(`approval fail-closed blocks the query — ${label}`, async () => {
      mockCheckApprovalRequired.mockImplementation(() => {
        throw new Error("simulated EE outage");
      });
      const outcome = await runSeam(preStep);
      expect(outcome.kind).toBe("approval_unavailable");
      expect(mockDBConnection.query).not.toHaveBeenCalled();
    });

    it(`approval-required match blocks and files a request — ${label}`, async () => {
      mockCheckApprovalRequired.mockImplementation(() =>
        Effect.succeed({ required: true, matchedRules: [{ id: "rule-1", name: "PII tables" }] }),
      );
      const outcome = await runSeam(preStep);
      expect(outcome.kind).toBe("approval_required");
      if (outcome.kind === "approval_required") {
        expect(outcome.approvalRequestId).toBe("req-seam");
        expect(outcome.ruleName).toBe("PII tables");
        expect(outcome.matchedRules).toEqual(["PII tables"]);
      }
      expect(mockDBConnection.query).not.toHaveBeenCalled();
    });

    it(`CREATE-phase fail-closed: a sync throw from createApprovalRequest blocks — ${label}`, async () => {
      // The second fail-closed region (#3764): a governance-WRITE failure
      // must block, not silently execute. A sync throw surfaces as a defect
      // that only `catchAllCause` maps — this pins that path at the seam.
      mockCheckApprovalRequired.mockImplementation(() =>
        Effect.succeed({ required: true, matchedRules: [{ id: "rule-1", name: "PII tables" }] }),
      );
      mockCreateApprovalRequest.mockImplementation(() => {
        throw new Error("simulated DB outage during approval request creation");
      });
      await expect(runSeam(preStep)).rejects.toThrow("Approval workflow failed");
      expect(mockDBConnection.query).not.toHaveBeenCalled();
    });

    it(`identity-missing blocks with approval_identity_missing — ${label}`, async () => {
      requestContextValue = {
        requestId: "test-seam",
        user: { id: "user-1", label: "user-1@example.com" },
      };
      mockCheckApprovalRequired.mockImplementation(() =>
        Effect.succeed({
          required: true,
          matchedRules: [{ id: "__identity_missing__", name: "missing-requester-identity" }],
          identityMissing: true,
        }),
      );
      const outcome = await runSeam(preStep);
      expect(outcome.kind).toBe("approval_identity_missing");
      expect(mockCreateApprovalRequest).not.toHaveBeenCalled();
      expect(mockDBConnection.query).not.toHaveBeenCalled();
    });
  }

  it("an already-approved match unblocks: executes without filing a second request", async () => {
    mockCheckApprovalRequired.mockImplementation(() =>
      Effect.succeed({ required: true, matchedRules: [{ id: "rule-1", name: "PII tables" }] }),
    );
    mockHasApprovedRequest.mockImplementation(() => Effect.succeed(true));
    const outcome = await runSeam({ kind: "bind-dashboard-parameters", values: {} });
    expect(outcome.kind).toBe("executed");
    expect(mockCreateApprovalRequest).not.toHaveBeenCalled();
    expect(mockDBConnection.query).toHaveBeenCalledTimes(1);
  });

  it("a cache hit can never bypass the approval gate (agent pre-step ordering)", async () => {
    // Poison the cache with a servable entry AND make approval required:
    // the outcome must be approval_required, not a served cache hit. Pins
    // the pre-step's position AFTER the gate.
    cacheIsEnabled = true;
    cacheEntry = { columns: ["id"], rows: [{ id: 99 }], cachedAt: Date.now(), ttl: 60000, executionMs: 5 };
    mockCheckApprovalRequired.mockImplementation(() =>
      Effect.succeed({ required: true, matchedRules: [{ id: "rule-1", name: "PII tables" }] }),
    );
    const outcome = await runSeam({ kind: "check-cache" });
    expect(outcome.kind).toBe("approval_required");
    expect(mockDBConnection.query).not.toHaveBeenCalled();
  });

  // ── RLS injection ───────────────────────────────────────────────────
  it("injects RLS conditions into the executed SQL when RLS is enabled", async () => {
    rlsConfigEnabled = true;
    const outcome = await runSeam({ kind: "bind-dashboard-parameters", values: {} });
    expect(outcome.kind).toBe("executed");
    expect(executedQueries).toHaveLength(1);
    expect(executedQueries[0]).toContain("tenant_id = 'tenant-42'");
    // The RESOLVED filter groups must reach the injector — not just any call.
    expect(rlsGroupsSeen).toHaveLength(1);
    expect(rlsGroupsSeen[0]).toEqual([
      { filters: [{ table: "companies", column: "tenant_id", value: "tenant-42" }] },
    ]);
  });

  it("RLS applies identically under the agent pre-step", async () => {
    rlsConfigEnabled = true;
    const outcome = await runSeam({ kind: "check-cache" });
    expect(outcome.kind).toBe("executed");
    expect(executedQueries[0]).toContain("tenant_id = 'tenant-42'");
  });

  // ── Auto row limit ──────────────────────────────────────────────────
  it("appends the configured row limit to the executed SQL", async () => {
    rowLimitSetting = "7";
    const outcome = await runSeam({ kind: "bind-dashboard-parameters", values: {} });
    expect(outcome.kind).toBe("executed");
    expect(executedQueries[0]).toMatch(/LIMIT 7\b/);
  });

  it("row limit applies identically under the agent pre-step", async () => {
    rowLimitSetting = "7";
    const outcome = await runSeam({ kind: "check-cache" });
    expect(outcome.kind).toBe("executed");
    expect(executedQueries[0]).toMatch(/LIMIT 7\b/);
  });

  // ── Dashboard parameter binding (raw pre-step, #2267) ──────────────
  it("rejects placeholder SQL on a non-bindable dialect — fail closed, never sent to the driver", async () => {
    mockDbType = "clickhouse";
    const outcome = await runSeam(
      { kind: "bind-dashboard-parameters", values: { id: 1 } },
      "SELECT id FROM companies WHERE id = :id",
    );
    expect(outcome.kind).toBe("validation_failed");
    if (outcome.kind === "validation_failed") {
      expect(outcome.message).toContain("Parameterized queries are supported on PostgreSQL and MySQL");
    }
    expect(mockDBConnection.query).not.toHaveBeenCalled();
  });

  it("rejects placeholder SQL with a missing parameter value — fail closed", async () => {
    const outcome = await runSeam(
      { kind: "bind-dashboard-parameters", values: {} },
      "SELECT id FROM companies WHERE id = :id",
    );
    expect(outcome.kind).toBe("validation_failed");
    expect(mockDBConnection.query).not.toHaveBeenCalled();
  });

  // ── beforeQuery hook input contract ─────────────────────────────────
  it("agent pre-step hands the plugin hook the ORIGINAL untrimmed SQL", async () => {
    // Historical contract: agent-path plugins see the raw string (trailing
    // semicolon intact); execution still runs the normalized SQL.
    const outcome = await runSeam({ kind: "check-cache" }, "SELECT id FROM companies;");
    expect(outcome.kind).toBe("executed");
    expect(hookSqlSeen).toEqual(["SELECT id FROM companies;"]);
    expect(executedQueries[0]).not.toContain(";");
  });

  it("raw pre-step hands the plugin hook the BOUND SQL aligned with the bind array (#2267)", async () => {
    const outcome = await runSeam(
      { kind: "bind-dashboard-parameters", values: { id: 1 } },
      "SELECT id FROM companies WHERE id = :id",
    );
    expect(outcome.kind).toBe("executed");
    expect(hookSqlSeen).toHaveLength(1);
    expect(hookSqlSeen[0]).not.toContain(":id");
    expect(hookSqlSeen[0]).toContain("$1");
  });

  // ── Executed outcome shape ──────────────────────────────────────────
  it("executed outcome carries the response record both wrappers adapt", async () => {
    const outcome = await runSeam({ kind: "bind-dashboard-parameters", values: {} });
    expect(outcome.kind).toBe("executed");
    if (outcome.kind === "executed") {
      expect(outcome.result.success).toBe(true);
      expect(outcome.result.columns).toEqual(["id"]);
      expect(outcome.result.row_count).toBe(1);
    }
  });
});
