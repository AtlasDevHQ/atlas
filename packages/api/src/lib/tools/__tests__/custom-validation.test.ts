/**
 * Tests for custom query validation (non-SQL datasource plugins).
 *
 * When a datasource plugin registers a `validate` function on its connection,
 * executeSQL uses that validator instead of the standard SQL validation pipeline.
 */

import { describe, expect, it, beforeEach, mock, type Mock } from "bun:test";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyResult = any;

// --- Mock dependencies ---

mock.module("@atlas/api/lib/semantic", () => ({
  getWhitelistedTables: () => new Set(["companies", "people"]),
  _resetWhitelists: () => {},
}));

mock.module("@atlas/api/lib/auth/audit", () => ({
  logQueryAudit: () => {},
}));

mock.module("@atlas/api/lib/tracing", () => ({
  withSpan: async (
    _name: string,
    _attrs: Record<string, unknown>,
    fn: () => Promise<unknown>,
  ) => fn(),
}));

mock.module("@atlas/api/lib/db/source-rate-limit", () => ({
  acquireSourceSlot: () => ({ acquired: true }),
  decrementSourceConcurrency: () => {},
}));

mock.module("@atlas/api/lib/plugins/hooks", () => ({
  dispatchHook: async () => {},
  dispatchMutableHook: async (
    _hookName: string,
    ctx: { sql: string },
    _field: string,
  ) => ctx.sql,
}));

// --- Query mock ---

let queryFn: Mock<(sql: string, timeout: number) => Promise<{ columns: string[]; rows: Record<string, unknown>[] }>>;

const mockConn = {
  query: (...args: [string, number]) => queryFn(...args),
  close: async () => {},
};

// Custom validator: accepts SOQL-like "SELECT ... FROM ..." but rejects anything with DELETE/INSERT
function soqlValidator(query: string): { valid: boolean; reason?: string } {
  if (/\b(DELETE|INSERT|UPDATE)\b/i.test(query)) {
    return { valid: false, reason: "SOQL only supports SELECT queries" };
  }
  return { valid: true };
}

// Connections mock with getValidator support
let validatorMap: Map<string, ((q: string) => { valid: boolean; reason?: string }) | undefined>;

mock.module("@atlas/api/lib/db/connection", () => ({
  getDB: () => mockConn,
  connections: {
    get: () => mockConn,
    getDefault: () => mockConn,
    getDBType: () => "postgres",
    getTargetHost: () => "localhost",
    list: () => ["default", "salesforce-plugin"],
    getValidator: (id: string) => validatorMap.get(id),
    getParserDialect: () => undefined,
    getForbiddenPatterns: () => [],
  },
  detectDBType: () => "postgres",
}));

// Import after mocks
const { executeSQL } = await import("@atlas/api/lib/tools/sql");

const exec = (sql: string, connectionId?: string) =>
  executeSQL.execute!(
    { sql, explanation: "test", connectionId },
    { toolCallId: "test", messages: [], abortSignal: undefined as never },
  ) as Promise<AnyResult>;

describe("custom query validation", () => {
  beforeEach(() => {
    validatorMap = new Map();
    queryFn = mock(() =>
      Promise.resolve({ columns: ["id", "name"], rows: [{ id: 1, name: "Acme" }] }),
    );
  });

  it("plugin with custom validator accepts valid queries", async () => {
    validatorMap.set("salesforce-plugin", soqlValidator);

    const result = await exec("SELECT Id, Name FROM Account", "salesforce-plugin");

    expect(result.success).toBe(true);
    expect(queryFn).toHaveBeenCalledTimes(1);
  });

  it("plugin with custom validator rejects invalid queries", async () => {
    validatorMap.set("salesforce-plugin", soqlValidator);

    const result = await exec("DELETE FROM Account WHERE Id = '001'", "salesforce-plugin");

    expect(result.success).toBe(false);
    expect(result.error).toContain("SOQL only supports SELECT queries");
    expect(queryFn).not.toHaveBeenCalled();
  });

  it("falls back to validateSQL when no custom validator", async () => {
    // No custom validator for default — standard SQL validation applies
    validatorMap.set("default", undefined);

    const result = await exec("SELECT * FROM companies");

    expect(result.success).toBe(true);
    expect(queryFn).toHaveBeenCalledTimes(1);
  });

  it("standard SQL validation rejects DML when no custom validator", async () => {
    validatorMap.set("default", undefined);

    const result = await exec("DROP TABLE companies");

    expect(result.success).toBe(false);
    expect(result.error).toContain("Forbidden SQL operation");
    expect(queryFn).not.toHaveBeenCalled();
  });

  it("auto-LIMIT is skipped for custom-validated connections", async () => {
    validatorMap.set("salesforce-plugin", soqlValidator);

    await exec("SELECT Id FROM Account", "salesforce-plugin");

    // The query passed to db.query should NOT have LIMIT appended
    const executedQuery = queryFn.mock.calls[0]![0];
    expect(executedQuery).not.toContain("LIMIT");
  });

  it("auto-LIMIT is applied for standard SQL connections", async () => {
    validatorMap.set("default", undefined);

    await exec("SELECT * FROM companies");

    const executedQuery = queryFn.mock.calls[0]![0];
    expect(executedQuery).toContain("LIMIT");
  });

  it("handles validator that throws an exception", async () => {
    validatorMap.set("broken-plugin", () => { throw new Error("validator crashed"); });

    const result = await exec("SELECT 1", "broken-plugin");

    expect(result.success).toBe(false);
    expect(result.error).toContain("internal validator error");
    expect(queryFn).not.toHaveBeenCalled();
  });

  it("handles validator that returns undefined", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    validatorMap.set("bad-plugin", (() => undefined) as any);

    const result = await exec("SELECT 1", "bad-plugin");

    expect(result.success).toBe(false);
    expect(result.error).toContain("misconfigured");
    expect(queryFn).not.toHaveBeenCalled();
  });

  it("handles validator that returns non-boolean valid field", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    validatorMap.set("bad-valid", (() => ({ valid: "yes" })) as any);

    const result = await exec("SELECT 1", "bad-valid");

    expect(result.success).toBe(false);
    expect(result.error).toContain("misconfigured");
    expect(queryFn).not.toHaveBeenCalled();
  });

  it("normalizes SQL before passing to custom validator (trims whitespace and trailing semicolons)", async () => {
    let receivedQuery = "";
    validatorMap.set("trim-check", (q: string) => {
      receivedQuery = q;
      return { valid: true };
    });

    await exec("  SELECT Id FROM Account ;  ", "trim-check");

    expect(receivedQuery).toBe("SELECT Id FROM Account");
    expect(queryFn).toHaveBeenCalledTimes(1);
  });

  it("custom validator used for re-validation after hook mutation", async () => {
    // Install a custom validator that rejects queries containing "FORBIDDEN"
    const strictValidator = (q: string): { valid: boolean; reason?: string } => {
      if (q.includes("FORBIDDEN")) return { valid: false, reason: "contains forbidden keyword" };
      return { valid: true };
    };
    validatorMap.set("custom-conn", strictValidator);

    // The hook rewrites to include "FORBIDDEN" — custom validator should catch it
    mock.module("@atlas/api/lib/plugins/hooks", () => ({
      dispatchHook: async () => {},
      dispatchMutableHook: async (
        _hookName: string,
        _ctx: { sql: string },
        _field: string,
      ) => "SELECT FORBIDDEN FROM data",
    }));

    // Re-import to pick up the new mock
    const { executeSQL: executeSQLv2 } = await import("@atlas/api/lib/tools/sql");

    const result = await (executeSQLv2.execute!(
      { sql: "SELECT Id FROM data", explanation: "query data", connectionId: "custom-conn" },
      { toolCallId: "t7", messages: [], abortSignal: undefined as never },
    ) as Promise<AnyResult>);

    expect(result.success).toBe(false);
    expect(result.error).toContain("contains forbidden keyword");

    // Restore original mock
    mock.module("@atlas/api/lib/plugins/hooks", () => ({
      dispatchHook: async () => {},
      dispatchMutableHook: async (
        _hookName: string,
        ctx: { sql: string },
        _field: string,
      ) => ctx.sql,
    }));
  });
});
