/**
 * validateProposal — the LLM-authored test query must run through the
 * shared user-query pipeline (per-connection validation → RLS → auto-LIMIT),
 * never a raw `db.query` (#3338).
 */

import { describe, expect, it, beforeEach, mock, type Mock } from "bun:test";
import { createConnectionMock } from "@atlas/api/testing/connection";
import type { UserQueryOutcome, RunUserQueryOpts } from "@atlas/api/lib/tools/sql";

// --- Mocks (registered before importing the module under test) ---

const proposalRow = {
  id: "prop-1",
  type: "semantic_amendment",
  amendment_payload: JSON.stringify({
    entityName: "companies",
    amendmentType: "add_column_description",
    amendment: {},
    testQuery: "SELECT id FROM companies",
  }),
};

const mockInternalQuery: Mock<(sql: string, params?: unknown[]) => Promise<unknown[]>> =
  mock(() => Promise.resolve([proposalRow]));

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => true,
  internalQuery: mockInternalQuery,
}));

mock.module("@atlas/api/lib/db/connection", () =>
  createConnectionMock({
    connections: {
      isOrgPoolingEnabled: () => false,
    },
  }),
);

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

mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
  withRequestContext: (_ctx: unknown, fn: () => unknown) => fn(),
  getRequestContext: () => null,
}));

const okOutcome: UserQueryOutcome = {
  kind: "ok",
  columns: ["id"],
  rows: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }],
  rowCount: 4,
  executionMs: 5,
  truncated: false,
  maskingApplied: false,
};

const mockRunUserQueryPipeline: Mock<(opts: RunUserQueryOpts) => Promise<UserQueryOutcome>> =
  mock(() => Promise.resolve(okOutcome));

mock.module("@atlas/api/lib/tools/sql", () => ({
  runUserQueryPipeline: mockRunUserQueryPipeline,
  validateSQL: mock(() => Promise.resolve({ valid: true, classification: { tablesAccessed: [], columnsAccessed: [] } })),
  parserDatabase: () => "PostgresQL",
  extractClassification: () => ({ tablesAccessed: [], columnsAccessed: [] }),
  buildSqlExecuteSpanAttrs: () => ({}),
  executeSQL: {},
}));

const { validateProposal } = await import("@atlas/api/lib/tools/validate-proposal");

type ValidateResult = {
  yamlValid: boolean;
  whitelistValid: boolean;
  testQueryResult?: { success: boolean; error?: string; rowCount?: number; sampleRows?: Record<string, unknown>[] };
  issues: string[];
};

async function run(): Promise<ValidateResult> {
  // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- AI SDK execute options are irrelevant to this tool
  return (await validateProposal.execute!({ proposalId: "prop-1" }, {} as any)) as ValidateResult;
}

describe("validateProposal test query routing (#3338)", () => {
  beforeEach(() => {
    mockRunUserQueryPipeline.mockClear();
    mockRunUserQueryPipeline.mockResolvedValue(okOutcome);
    mockInternalQuery.mockResolvedValue([proposalRow]);
  });

  it("routes the test query through runUserQueryPipeline with an explicit connectionId", async () => {
    const result = await run();
    expect(mockRunUserQueryPipeline).toHaveBeenCalledTimes(1);
    const opts = mockRunUserQueryPipeline.mock.calls[0][0];
    expect(opts.sql).toBe("SELECT id FROM companies");
    expect(opts.connectionId).toBe("default");
    expect(result.testQueryResult?.success).toBe(true);
    expect(result.testQueryResult?.rowCount).toBe(4);
    // Sample rows are capped at 3
    expect(result.testQueryResult?.sampleRows).toHaveLength(3);
  });

  it("surfaces an RLS block as a failed test query (fail-closed, not raw rows)", async () => {
    mockRunUserQueryPipeline.mockResolvedValue({
      kind: "rls_failed",
      message: "RLS policy requires claim \"tenant_id\" but it is missing. Query blocked.",
    });
    const result = await run();
    expect(result.testQueryResult?.success).toBe(false);
    expect(result.testQueryResult?.error).toContain("RLS");
    expect(result.issues.some((i) => i.includes("Test query failed"))).toBe(true);
  });

  it("surfaces validation failures with the validation message", async () => {
    mockRunUserQueryPipeline.mockResolvedValue({
      kind: "validation_failed",
      message: 'Table "secrets" is not in the allowed list.',
    });
    const result = await run();
    expect(result.testQueryResult?.success).toBe(false);
    expect(result.issues.some((i) => i.includes("failed SQL validation"))).toBe(true);
  });

  it("flags zero-row results as a potential column mismatch", async () => {
    mockRunUserQueryPipeline.mockResolvedValue({ ...okOutcome, rows: [], rowCount: 0 });
    const result = await run();
    expect(result.testQueryResult?.success).toBe(true);
    expect(result.issues.some((i) => i.includes("0 rows"))).toBe(true);
  });
});
