/**
 * Tests for the connection-lookup catch block in executeSQL.
 *
 * Verifies that known registration/configuration errors
 * (ConnectionNotRegisteredError, NoDatasourceConfiguredError) return
 * curated messages, while unexpected errors return the original error
 * message instead of being silently swallowed.
 */
import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";

mock.module("@atlas/api/lib/semantic", () => ({
  getOrgWhitelistedTables: () => new Set(),
  loadOrgWhitelist: async () => new Map(),
  invalidateOrgWhitelist: () => {},
  getOrgSemanticIndex: async () => "",
  invalidateOrgSemanticIndex: () => {},
  _resetOrgWhitelists: () => {},
  _resetOrgSemanticIndexes: () => {},
  getWhitelistedTables: () => new Set(["companies"]),
  _resetWhitelists: () => {},
}));

const mockQuery = mock(() =>
  Promise.resolve({ columns: ["id"], rows: [{ id: 1 }] }),
);
const mockConn = { query: mockQuery, close: async () => {} };

// Import typed errors for use in test throwers
const { ConnectionNotRegisteredError, NoDatasourceConfiguredError } =
  await import("@atlas/api/lib/db/connection");

// Configurable throwers — tests swap these to simulate different errors
let getDefaultFn: () => typeof mockConn;
let getFn: (id: string) => typeof mockConn;
let getDBTypeFn: (id: string) => string;

mock.module("@atlas/api/lib/db/connection", () => ({
  getDB: () => mockConn,
  ConnectionNotRegisteredError,
  NoDatasourceConfiguredError,
  PoolCapacityExceededError: class extends Error {
    constructor(current: number, requested: number, max: number) {
      super(`Cannot create org pool: would use ${current + requested} connection slots, exceeding maxTotalConnections (${max}).`);
      this.name = "PoolCapacityExceededError";
    }
  },
  connections: {
    get: (id: string) => getFn(id),
    getDefault: () => getDefaultFn(),
    getDBType: (id: string) => getDBTypeFn(id),
    getTargetHost: () => "localhost",
    getValidator: () => undefined,
    getParserDialect: () => undefined,
    getForbiddenPatterns: () => [],
    list: () => ["default"],
    recordQuery: () => {},
    recordError: () => {},
    recordSuccess: () => {},
    isOrgPoolingEnabled: () => false,
    getForOrg: () => mockConn,
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
  const origDatasource = process.env.ATLAS_DATASOURCE_URL;

  beforeEach(() => {
    process.env.ATLAS_DATASOURCE_URL = "postgresql://test:test@localhost:5432/test";
    // Default: everything works
    getDefaultFn = () => mockConn;
    getFn = () => mockConn;
    getDBTypeFn = () => "postgres";
  });

  afterEach(() => {
    if (origDatasource) {
      process.env.ATLAS_DATASOURCE_URL = origDatasource;
    } else {
      delete process.env.ATLAS_DATASOURCE_URL;
    }
  });

  // --- Known registration/configuration errors (curated message) ---

  it("returns curated error for unregistered connection", async () => {
    getFn = (id: string) => {
      throw new ConnectionNotRegisteredError(id);
    };

    const result = await exec("SELECT id FROM companies", "unknown-conn");
    expect(result.success).toBe(false);
    expect(result.error).toContain("is not registered");
    expect(result.error).toContain("Available:");
  });

  it("returns original message when no datasource configured", async () => {
    getDefaultFn = () => {
      throw new NoDatasourceConfiguredError();
    };

    const result = await exec("SELECT id FROM companies");
    expect(result.success).toBe(false);
    expect(result.error).toContain("No analytics datasource configured");
    expect(result.error).toContain("ATLAS_DATASOURCE_URL");
  });

  it("returns curated error when getDBType throws registration error on default path", async () => {
    getDBTypeFn = () => {
      throw new ConnectionNotRegisteredError("default");
    };

    const result = await exec("SELECT id FROM companies");
    expect(result.success).toBe(false);
    expect(result.error).toContain("is not registered");
  });

  // --- Unexpected errors (original message preserved, not swallowed) ---

  it("returns original error for unexpected connection failures", async () => {
    getDefaultFn = () => {
      throw new Error("ECONNREFUSED: connection refused");
    };

    const result = await exec("SELECT id FROM companies");
    expect(result.success).toBe(false);
    expect(result.error).toContain("ECONNREFUSED");
    expect(result.error).toContain("failed to initialize");
  });

  it("returns original error for non-Error exceptions", async () => {
    getDefaultFn = () => {
      throw "unexpected string error";
    };

    const result = await exec("SELECT id FROM companies");
    expect(result.success).toBe(false);
    expect(result.error).toContain("unexpected string error");
  });

  it("returns original error when getDBType fails with unexpected error", async () => {
    getDBTypeFn = () => {
      throw new TypeError("Cannot read properties of undefined");
    };

    const result = await exec("SELECT id FROM companies", "some-conn");
    expect(result.success).toBe(false);
    expect(result.error).toContain("Cannot read properties of undefined");
    expect(result.error).toContain("failed to initialize");
  });

  it("returns original error for unsupported database scheme", async () => {
    getDefaultFn = () => {
      throw new Error(
        'Unsupported database URL scheme "clickhouse://". This adapter is now a plugin.',
      );
    };

    const result = await exec("SELECT id FROM companies");
    expect(result.success).toBe(false);
    expect(result.error).toContain("Unsupported database URL scheme");
  });
});
