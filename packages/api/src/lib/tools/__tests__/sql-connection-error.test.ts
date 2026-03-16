/**
 * Tests for executeSQL connection error handling.
 *
 * Verifies that the catch block in executeSQL only handles known
 * registration/configuration errors and re-throws unexpected ones.
 */
import { describe, it, expect, mock, beforeEach } from "bun:test";

mock.module("@atlas/api/lib/semantic", () => ({
  getWhitelistedTables: () => new Set(["companies"]),
  _resetWhitelists: () => {},
}));

const mockQuery = mock(() =>
  Promise.resolve({ columns: ["id"], rows: [{ id: 1 }] }),
);
const mockConn = { query: mockQuery, close: async () => {} };

// Configurable throwers — tests swap these to simulate different errors
let getDefaultFn: () => typeof mockConn;
let getFn: (id: string) => typeof mockConn;
let getDBTypeFn: (id: string) => string;

mock.module("@atlas/api/lib/db/connection", () => ({
  getDB: () => mockConn,
  connections: {
    get: (id: string) => getFn(id),
    getDefault: () => getDefaultFn(),
    getDBType: (id: string) => getDBTypeFn(id),
    getTargetHost: () => "localhost",
    getValidator: () => undefined,
    getParserDialect: () => undefined,
    getForbiddenPatterns: () => [],
    list: () => ["default"],
  },
  detectDBType: () => "postgres",
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

const { executeSQL } = await import("@atlas/api/lib/tools/sql");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyResult = any;

const exec = (sql: string, connectionId?: string) =>
  executeSQL.execute!(
    { sql, explanation: "test", connectionId },
    { toolCallId: "test", messages: [], abortSignal: undefined as never },
  ) as Promise<AnyResult>;

describe("executeSQL connection error handling", () => {
  beforeEach(() => {
    process.env.ATLAS_DATASOURCE_URL = "postgresql://test:test@localhost:5432/test";
    // Default: everything works
    getDefaultFn = () => mockConn;
    getFn = () => mockConn;
    getDBTypeFn = () => "postgres";
  });

  it("returns error for unregistered connection (known error)", async () => {
    getFn = (id: string) => {
      throw new Error(`Connection "${id}" is not registered.`);
    };

    const result = await exec("SELECT id FROM companies", "unknown-conn");
    expect(result.success).toBe(false);
    expect(result.error).toContain("is not registered");
  });

  it("returns error when no datasource configured (known error)", async () => {
    getDefaultFn = () => {
      throw new Error(
        "No analytics datasource configured. Set ATLAS_DATASOURCE_URL to a PostgreSQL or MySQL connection string, or register a datasource plugin.",
      );
    };

    const result = await exec("SELECT id FROM companies");
    expect(result.success).toBe(false);
    expect(result.error).toContain("is not registered");
  });

  it("re-throws unexpected errors instead of swallowing them", async () => {
    getDefaultFn = () => {
      throw new Error("ECONNREFUSED: connection refused");
    };

    await expect(exec("SELECT id FROM companies")).rejects.toThrow(
      "ECONNREFUSED",
    );
  });

  it("re-throws non-Error exceptions", async () => {
    getDefaultFn = () => {
      throw "unexpected string error";
    };

    await expect(exec("SELECT id FROM companies")).rejects.toThrow(
      "unexpected string error",
    );
  });

  it("re-throws when getDBType fails with unexpected error after get succeeds", async () => {
    getDBTypeFn = () => {
      throw new TypeError("Cannot read properties of undefined");
    };

    await expect(
      exec("SELECT id FROM companies", "some-conn"),
    ).rejects.toThrow("Cannot read properties of undefined");
  });
});
