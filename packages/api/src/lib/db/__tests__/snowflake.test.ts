/**
 * Tests for Snowflake URL parsing, detectDBType integration, and connection behavior.
 */
import { describe, it, expect, mock, beforeEach } from "bun:test";
import { resolve } from "path";

// Track all SQL statements executed via the mock connection.
// Reset in each describe block's beforeEach to prevent cross-test pollution.
let executedStatements: string[] = [];

// Flag to make the QUERY_TAG ALTER SESSION fail in specific tests
let queryTagShouldFail = false;

// Mock logger to capture structured log output
const mockWarn = mock(() => {});
mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    info: mock(() => {}),
    warn: mockWarn,
    error: mock(() => {}),
    debug: mock(() => {}),
    child: () => ({ info: mock(() => {}), warn: mockWarn, error: mock(() => {}), debug: mock(() => {}) }),
  }),
}));

// Mock database drivers before importing connection module
mock.module("pg", () => ({
  Pool: class MockPool {
    async query() { return { rows: [], fields: [] }; }
    async connect() { return { async query() { return { rows: [], fields: [] }; }, release() {} }; }
    async end() {}
  },
}));

mock.module("mysql2/promise", () => ({
  createPool: () => ({
    async getConnection() { return { async execute() { return [[], []]; }, release() {} }; },
    async end() {},
  }),
}));

mock.module("snowflake-sdk", () => ({
  configure: () => {},
  createPool: () => ({
    use: async (fn: (conn: unknown) => Promise<unknown>) => {
      const mockConn = {
        execute: (opts: { sqlText: string; complete: (err: Error | null, stmt: unknown, rows: unknown[]) => void }) => {
          executedStatements.push(opts.sqlText);
          if (queryTagShouldFail && opts.sqlText.includes("QUERY_TAG")) {
            opts.complete(new Error("Insufficient privileges to set QUERY_TAG"), null, []);
            return;
          }
          opts.complete(null, { getColumns: () => [] }, []);
        },
      };
      return fn(mockConn);
    },
    drain: async () => {},
    clear: async () => {},
  }),
}));

// Cache-busting import to get a fresh module instance, avoiding interference
// from global mock.module("@atlas/api/lib/db/connection") in other test files
// (e.g. sql.test.ts) that don't export parseSnowflakeURL.
const connModPath = resolve(__dirname, "../connection.ts");
const connMod = await import(`${connModPath}?t=${Date.now()}`);
const parseSnowflakeURL = connMod.parseSnowflakeURL as typeof import("../connection").parseSnowflakeURL;
const detectDBType = connMod.detectDBType as typeof import("../connection").detectDBType;

describe("parseSnowflakeURL", () => {
  it("parses full Snowflake URL with all components", () => {
    const opts = parseSnowflakeURL(
      "snowflake://myuser:mypass@xy12345.us-east-1/mydb/myschema?warehouse=COMPUTE_WH&role=ANALYST"
    );
    expect(opts.account).toBe("xy12345.us-east-1");
    expect(opts.username).toBe("myuser");
    expect(opts.password).toBe("mypass");
    expect(opts.database).toBe("mydb");
    expect(opts.schema).toBe("myschema");
    expect(opts.warehouse).toBe("COMPUTE_WH");
    expect(opts.role).toBe("ANALYST");
  });

  it("parses URL with database only (no schema)", () => {
    const opts = parseSnowflakeURL("snowflake://user:pass@account123/mydb");
    expect(opts.account).toBe("account123");
    expect(opts.username).toBe("user");
    expect(opts.password).toBe("pass");
    expect(opts.database).toBe("mydb");
    expect(opts.schema).toBeUndefined();
    expect(opts.warehouse).toBeUndefined();
    expect(opts.role).toBeUndefined();
  });

  it("parses minimal URL (account only)", () => {
    const opts = parseSnowflakeURL("snowflake://user:pass@account123");
    expect(opts.account).toBe("account123");
    expect(opts.username).toBe("user");
    expect(opts.password).toBe("pass");
    expect(opts.database).toBeUndefined();
    expect(opts.schema).toBeUndefined();
  });

  it("decodes URL-encoded credentials", () => {
    const opts = parseSnowflakeURL("snowflake://my%40user:p%40ss%23word@account123/db");
    expect(opts.username).toBe("my@user");
    expect(opts.password).toBe("p@ss#word");
  });

  it("handles warehouse query parameter only", () => {
    const opts = parseSnowflakeURL("snowflake://user:pass@account123/db/schema?warehouse=WH");
    expect(opts.warehouse).toBe("WH");
    expect(opts.role).toBeUndefined();
  });

  it("throws for non-snowflake protocol", () => {
    expect(() => parseSnowflakeURL("postgresql://user:pass@localhost:5432/db")).toThrow(
      "Invalid Snowflake URL"
    );
  });

  it("accepts empty password (key-pair auth scenario)", () => {
    const opts = parseSnowflakeURL("snowflake://user:@account123/db");
    expect(opts.username).toBe("user");
    expect(opts.password).toBe("");
    expect(opts.database).toBe("db");
  });

  it("throws for missing username", () => {
    expect(() => parseSnowflakeURL("snowflake://:pass@account123/db")).toThrow(
      "missing username"
    );
  });

  it("throws for missing account (unparseable URL)", () => {
    // snowflake://user:pass@/db is not a valid URL — the URL constructor throws
    expect(() => parseSnowflakeURL("snowflake://user:pass@/db")).toThrow();
  });
});

describe("detectDBType — Snowflake", () => {
  it("returns 'snowflake' for snowflake:// URLs", () => {
    expect(detectDBType("snowflake://user:pass@account123/db")).toBe("snowflake");
  });

  it("still returns 'postgres' for postgresql:// URLs", () => {
    expect(detectDBType("postgresql://user:pass@localhost:5432/db")).toBe("postgres");
  });

  it("still returns 'mysql' for mysql:// URLs", () => {
    expect(detectDBType("mysql://user:pass@localhost:3306/db")).toBe("mysql");
  });

  it("throws for unsupported URL schemes", () => {
    expect(() => detectDBType("sqlite:///test.db")).toThrow("Unsupported database URL");
  });
});

describe("createSnowflakeDB — defense-in-depth", () => {
  const ConnectionRegistry = connMod.ConnectionRegistry as typeof import("../connection").ConnectionRegistry;

  beforeEach(() => {
    executedStatements = [];
    queryTagShouldFail = false;
    mockWarn.mockClear();
  });

  it("logs a startup warning recommending a SELECT-only role", () => {
    const registry = new ConnectionRegistry();
    registry.register("sf-test", { url: "snowflake://user:pass@account123/db" });
    expect(mockWarn).toHaveBeenCalledWith(
      expect.stringContaining("no session-level read-only mode"),
    );
  });

  it("sets QUERY_TAG before each query", async () => {
    const registry = new ConnectionRegistry();
    registry.register("sf-tag", { url: "snowflake://user:pass@account123/db" });
    const db = registry.get("sf-tag");
    await db.query("SELECT 1");

    expect(executedStatements).toContain("ALTER SESSION SET QUERY_TAG = 'atlas:readonly'");
    // QUERY_TAG should come after timeout and before the actual query
    const tagIdx = executedStatements.indexOf("ALTER SESSION SET QUERY_TAG = 'atlas:readonly'");
    const queryIdx = executedStatements.indexOf("SELECT 1");
    expect(tagIdx).toBeLessThan(queryIdx);
  });

  it("sets statement timeout before QUERY_TAG", async () => {
    const registry = new ConnectionRegistry();
    registry.register("sf-order", { url: "snowflake://user:pass@account123/db" });
    const db = registry.get("sf-order");
    await db.query("SELECT 1", 15000);

    const timeoutIdx = executedStatements.findIndex((s) => s.includes("STATEMENT_TIMEOUT_IN_SECONDS"));
    const tagIdx = executedStatements.indexOf("ALTER SESSION SET QUERY_TAG = 'atlas:readonly'");
    expect(timeoutIdx).toBeLessThan(tagIdx);
  });

  it("proceeds with the query when QUERY_TAG fails (best-effort)", async () => {
    queryTagShouldFail = true;
    const registry = new ConnectionRegistry();
    registry.register("sf-tag-fail", { url: "snowflake://user:pass@account123/db" });
    const db = registry.get("sf-tag-fail");
    const result = await db.query("SELECT 42");

    // The actual query should still execute despite QUERY_TAG failure
    expect(executedStatements).toContain("SELECT 42");
    expect(result).toEqual({ columns: [], rows: [] });

    // A warning should be logged
    expect(mockWarn).toHaveBeenCalledWith(
      expect.stringContaining("Failed to set QUERY_TAG"),
    );
  });
});
