import { describe, test, expect, mock, beforeEach, spyOn } from "bun:test";

// ---------------------------------------------------------------------------
// Mock snowflake-sdk before any imports that use it
// ---------------------------------------------------------------------------

const mockColumns = [{ getName: () => "count" }];
const mockStmt = { getColumns: () => mockColumns };
const mockRows = [{ count: 42 }];

// Default execute: calls complete(null, stmt, rows)
const mockExecute = mock(
  (opts: { sqlText: string; complete: Function }) => {
    opts.complete(null, mockStmt, mockRows);
  },
);
const mockConn = { execute: mockExecute };

const mockPoolUse = mock(async (fn: Function) => fn(mockConn));
const mockPoolDrain = mock(() => Promise.resolve());
const mockPoolClear = mock(() => Promise.resolve());
const mockCreatePool = mock(() => ({
  use: mockPoolUse,
  drain: mockPoolDrain,
  clear: mockPoolClear,
}));
const mockConfigure = mock(() => {});

mock.module("snowflake-sdk", () => ({
  createPool: mockCreatePool,
  configure: mockConfigure,
}));

import { definePlugin, isDatasourcePlugin } from "@useatlas/plugin-sdk";
import {
  snowflakePlugin,
  buildSnowflakePlugin,
  parseSnowflakeURL,
  extractAccount,
  SNOWFLAKE_FORBIDDEN_PATTERNS,
} from "../index";
import { createSnowflakeConnection } from "../connection";

beforeEach(() => {
  mockExecute.mockClear();
  mockPoolUse.mockClear();
  mockPoolDrain.mockClear();
  mockPoolClear.mockClear();
  mockCreatePool.mockClear();
  mockConfigure.mockClear();

  // Re-stub defaults after clearing
  mockExecute.mockImplementation(
    (opts: { sqlText: string; complete: Function }) => {
      opts.complete(null, mockStmt, mockRows);
    },
  );
  mockPoolUse.mockImplementation(async (fn: Function) => fn(mockConn));
  mockPoolDrain.mockImplementation(() => Promise.resolve());
  mockPoolClear.mockImplementation(() => Promise.resolve());
  mockCreatePool.mockImplementation(() => ({
    use: mockPoolUse,
    drain: mockPoolDrain,
    clear: mockPoolClear,
  }));
  mockConfigure.mockImplementation(() => {});
});

// ---------------------------------------------------------------------------
// URL parsing
// ---------------------------------------------------------------------------

describe("parseSnowflakeURL", () => {
  test("parses a full URL with all segments and params", () => {
    const result = parseSnowflakeURL(
      "snowflake://admin:s3cret@xy12345/mydb/public?warehouse=COMPUTE_WH&role=ANALYST",
    );
    expect(result).toEqual({
      account: "xy12345",
      username: "admin",
      password: "s3cret",
      database: "mydb",
      schema: "public",
      warehouse: "COMPUTE_WH",
      role: "ANALYST",
    });
  });

  test("parses a fully-qualified account locator", () => {
    const result = parseSnowflakeURL(
      "snowflake://user:pass@xy12345.us-east-1/db",
    );
    expect(result.account).toBe("xy12345.us-east-1");
  });

  test("handles URL with database only (no schema)", () => {
    const result = parseSnowflakeURL("snowflake://user:pass@acct/mydb");
    expect(result.database).toBe("mydb");
    expect(result.schema).toBeUndefined();
  });

  test("handles URL with no path segments", () => {
    const result = parseSnowflakeURL("snowflake://user:pass@acct");
    expect(result.database).toBeUndefined();
    expect(result.schema).toBeUndefined();
  });

  test("handles URL with no query params", () => {
    const result = parseSnowflakeURL("snowflake://user:pass@acct/db/schema");
    expect(result.warehouse).toBeUndefined();
    expect(result.role).toBeUndefined();
  });

  test("decodes percent-encoded username and password", () => {
    const result = parseSnowflakeURL(
      "snowflake://my%40user:p%40ss%23word@acct/db",
    );
    expect(result.username).toBe("my@user");
    expect(result.password).toBe("p@ss#word");
  });

  test("rejects non-snowflake URL scheme", () => {
    expect(() => parseSnowflakeURL("postgresql://localhost/db")).toThrow(
      /expected snowflake:\/\/ scheme/,
    );
  });

  test("rejects URL with missing username", () => {
    expect(() => parseSnowflakeURL("snowflake://:pass@acct/db")).toThrow(
      /missing username/,
    );
  });

  test("rejects URL with missing account", () => {
    // URL with empty hostname throws at new URL() level or at our account check
    expect(() => parseSnowflakeURL("snowflake://user:pass@/db")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// extractAccount (safe logging — no credentials)
// ---------------------------------------------------------------------------

describe("extractAccount", () => {
  test("extracts account from snowflake URL", () => {
    expect(extractAccount("snowflake://user:pass@xy12345/db")).toBe("xy12345");
  });

  test("extracts fully-qualified account", () => {
    expect(extractAccount("snowflake://user:pass@xy12345.us-east-1/db")).toBe(
      "xy12345.us-east-1",
    );
  });

  test("strips credentials from URL", () => {
    const result = extractAccount("snowflake://admin:s3cret@xy12345.us-east-1/db");
    expect(result).toBe("xy12345.us-east-1");
    expect(result).not.toContain("admin");
    expect(result).not.toContain("s3cret");
  });

  test("returns (unknown) for invalid URL", () => {
    expect(extractAccount("not-a-url")).toBe("(unknown)");
  });
});

// ---------------------------------------------------------------------------
// Config validation (via createPlugin factory)
// ---------------------------------------------------------------------------

describe("config validation", () => {
  test("accepts valid snowflake:// URL", () => {
    const plugin = snowflakePlugin({
      url: "snowflake://user:pass@xy12345/db/public?warehouse=WH",
    });
    expect(plugin.id).toBe("snowflake-datasource");
    expect(plugin.type).toBe("datasource");
    expect(plugin.config?.url).toBe("snowflake://user:pass@xy12345/db/public?warehouse=WH");
  });

  test("accepts optional maxConnections", () => {
    const plugin = snowflakePlugin({
      url: "snowflake://user:pass@acct/db",
      maxConnections: 5,
    });
    expect(plugin.config?.maxConnections).toBe(5);
  });

  test("rejects empty URL", () => {
    expect(() => snowflakePlugin({ url: "" })).toThrow(
      /URL must not be empty/,
    );
  });

  test("rejects non-snowflake URL scheme", () => {
    expect(() =>
      snowflakePlugin({ url: "postgresql://localhost:5432/db" }),
    ).toThrow(/URL must start with snowflake:\/\//);
  });

  test("rejects missing URL", () => {
    // @ts-expect-error — intentionally passing invalid config
    expect(() => snowflakePlugin({})).toThrow();
  });

  test("rejects URL with missing username at config time", () => {
    expect(() =>
      snowflakePlugin({ url: "snowflake://:pass@acct/db" }),
    ).toThrow(/valid Snowflake connection URL/);
  });

  test("rejects maxConnections of 0", () => {
    expect(() =>
      snowflakePlugin({ url: "snowflake://user:pass@acct/db", maxConnections: 0 }),
    ).toThrow();
  });

  test("rejects negative maxConnections", () => {
    expect(() =>
      snowflakePlugin({ url: "snowflake://user:pass@acct/db", maxConnections: -1 }),
    ).toThrow();
  });

  test("rejects non-integer maxConnections", () => {
    expect(() =>
      snowflakePlugin({ url: "snowflake://user:pass@acct/db", maxConnections: 1.5 }),
    ).toThrow();
  });

  test("rejects maxConnections over 100", () => {
    expect(() =>
      snowflakePlugin({ url: "snowflake://user:pass@acct/db", maxConnections: 101 }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Plugin shape validation
// ---------------------------------------------------------------------------

describe("plugin shape", () => {
  const validConfig = { url: "snowflake://user:pass@xy12345/db/public?warehouse=WH" };

  test("createPlugin factory returns a valid plugin", () => {
    const plugin = snowflakePlugin(validConfig);
    expect(plugin.id).toBe("snowflake-datasource");
    expect(plugin.type).toBe("datasource");
    expect(plugin.version).toBe("0.1.0");
    expect(plugin.name).toBe("Snowflake DataSource");
  });

  test("definePlugin accepts the built plugin", () => {
    const plugin = buildSnowflakePlugin(validConfig);
    const validated = definePlugin(plugin);
    expect(validated).toBe(plugin);
  });

  test("isDatasourcePlugin type guard passes", () => {
    const plugin = snowflakePlugin(validConfig);
    expect(isDatasourcePlugin(plugin)).toBe(true);
  });

  test("connection.dbType is 'snowflake'", () => {
    const plugin = snowflakePlugin(validConfig);
    expect(plugin.connection.dbType).toBe("snowflake");
  });

  test("entities is an empty array", () => {
    const plugin = snowflakePlugin(validConfig);
    expect(plugin.entities).toEqual([]);
  });

  test("dialect provides Snowflake-specific guidance", () => {
    const plugin = snowflakePlugin(validConfig);
    expect(plugin.dialect).toContain("Snowflake SQL dialect");
    expect(plugin.dialect).toContain("FLATTEN()");
    expect(plugin.dialect).toContain("QUALIFY");
    expect(plugin.dialect).toContain("TRY_CAST()");
    expect(plugin.dialect).toContain("VARIANT");
  });

  test("connection.parserDialect is 'Snowflake'", () => {
    const plugin = snowflakePlugin(validConfig);
    expect(plugin.connection.parserDialect).toBe("Snowflake");
  });

  test("connection.forbiddenPatterns is SNOWFLAKE_FORBIDDEN_PATTERNS", () => {
    const plugin = snowflakePlugin(validConfig);
    expect(plugin.connection.forbiddenPatterns).toBe(SNOWFLAKE_FORBIDDEN_PATTERNS);
    expect(plugin.connection.forbiddenPatterns!.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Forbidden patterns (validation.ts)
// ---------------------------------------------------------------------------

describe("SNOWFLAKE_FORBIDDEN_PATTERNS", () => {
  const matches = (sql: string) =>
    SNOWFLAKE_FORBIDDEN_PATTERNS.some((p) => p.test(sql));

  test("blocks PUT/GET/LIST/REMOVE/RM at start of statement", () => {
    expect(matches("PUT file:///tmp/data @stage")).toBe(true);
    expect(matches("GET @stage file:///tmp/data")).toBe(true);
    expect(matches("LIST @stage")).toBe(true);
    expect(matches("REMOVE @stage/file.csv")).toBe(true);
    expect(matches("RM @stage/file.csv")).toBe(true);
  });

  test("blocks case-insensitive variants", () => {
    expect(matches("put file:///tmp @stage")).toBe(true);
    expect(matches("get @stage file:///tmp")).toBe(true);
    expect(matches("list @stage")).toBe(true);
  });

  test("allows PUT/GET/LIST as data values (not at start)", () => {
    expect(matches("SELECT * FROM t WHERE name = 'Get Ready'")).toBe(false);
    expect(matches("SELECT * FROM t WHERE status = 'Put on hold'")).toBe(false);
    expect(matches("SELECT * FROM t WHERE type = 'List'")).toBe(false);
  });

  test("blocks MERGE anywhere in statement", () => {
    expect(matches("MERGE INTO target USING source ON ...")).toBe(true);
  });

  test("blocks SHOW/DESCRIBE/EXPLAIN/USE anywhere", () => {
    expect(matches("SHOW TABLES")).toBe(true);
    expect(matches("DESCRIBE TABLE foo")).toBe(true);
    expect(matches("EXPLAIN SELECT 1")).toBe(true);
    expect(matches("USE DATABASE mydb")).toBe(true);
  });

  test("allows normal SELECT queries", () => {
    expect(matches("SELECT count(*) FROM orders")).toBe(false);
    expect(matches("SELECT * FROM users WHERE id = 1")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Connection factory
// ---------------------------------------------------------------------------

describe("connection factory", () => {
  const testUrl = "snowflake://user:pass@xy12345/db/public?warehouse=WH";

  test("connection.create() returns a PluginDBConnection", async () => {
    const plugin = snowflakePlugin({ url: testUrl });
    const conn = await plugin.connection.create();
    expect(typeof conn.query).toBe("function");
    expect(typeof conn.close).toBe("function");
  });

  test("configures SDK to suppress logging", () => {
    createSnowflakeConnection({ url: testUrl });
    expect(mockConfigure).toHaveBeenCalledWith({ logLevel: "ERROR" });
  });

  test("creates pool with correct connection options", () => {
    createSnowflakeConnection({ url: testUrl, maxConnections: 5 });
    expect(mockCreatePool).toHaveBeenCalledWith(
      {
        account: "xy12345",
        username: "user",
        password: "pass",
        database: "db",
        schema: "public",
        warehouse: "WH",
        role: undefined,
        application: "Atlas",
      },
      { max: 5, min: 0 },
    );
  });

  test("defaults maxConnections to 10", () => {
    createSnowflakeConnection({ url: testUrl });
    expect(mockCreatePool).toHaveBeenCalledWith(
      expect.anything(),
      { max: 10, min: 0 },
    );
  });

  test("query sets timeout, query tag, and executes (3 execute calls)", async () => {
    const conn = createSnowflakeConnection({ url: testUrl });
    await conn.query("SELECT count(*) AS count FROM my_table", 15000);

    // 3 calls: timeout, query tag, actual query
    expect(mockExecute).toHaveBeenCalledTimes(3);

    const calls = mockExecute.mock.calls;
    expect(calls[0][0].sqlText).toBe(
      "ALTER SESSION SET STATEMENT_TIMEOUT_IN_SECONDS = 15",
    );
    expect(calls[1][0].sqlText).toBe(
      "ALTER SESSION SET QUERY_TAG = 'atlas:readonly'",
    );
    expect(calls[2][0].sqlText).toBe(
      "SELECT count(*) AS count FROM my_table",
    );
  });

  test("query uses default 30s timeout when none provided", async () => {
    const conn = createSnowflakeConnection({ url: testUrl });
    await conn.query("SELECT 1");

    const calls = mockExecute.mock.calls;
    expect(calls[0][0].sqlText).toBe(
      "ALTER SESSION SET STATEMENT_TIMEOUT_IN_SECONDS = 30",
    );
  });

  test("timeout floors to minimum 1 second", async () => {
    const conn = createSnowflakeConnection({ url: testUrl });
    await conn.query("SELECT 1", 500);

    const calls = mockExecute.mock.calls;
    expect(calls[0][0].sqlText).toBe(
      "ALTER SESSION SET STATEMENT_TIMEOUT_IN_SECONDS = 1",
    );
  });

  test("query returns { columns, rows }", async () => {
    const conn = createSnowflakeConnection({ url: testUrl });
    const result = await conn.query("SELECT count(*) AS count FROM t");
    expect(result.columns).toEqual(["count"]);
    expect(result.rows).toEqual([{ count: 42 }]);
  });

  test("query tag failure is non-fatal (warns and continues)", async () => {
    mockExecute.mockImplementation(
      (opts: { sqlText: string; complete: Function }) => {
        if (opts.sqlText.includes("QUERY_TAG")) {
          opts.complete(new Error("Insufficient privileges"));
        } else {
          opts.complete(null, mockStmt, mockRows);
        }
      },
    );

    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const conn = createSnowflakeConnection({ url: testUrl });
    const result = await conn.query("SELECT 1");

    // Query still succeeds despite tag failure
    expect(result.columns).toEqual(["count"]);
    expect(warnSpy).toHaveBeenCalled();
    const warnMsg = String(warnSpy.mock.calls[0]);
    expect(warnMsg).toContain("QUERY_TAG");
    warnSpy.mockRestore();
  });

  test("execute error wraps with context", async () => {
    mockExecute.mockImplementation(
      (opts: { sqlText: string; complete: Function }) => {
        if (!opts.sqlText.startsWith("ALTER SESSION")) {
          opts.complete(new Error("SQL compilation error"));
        } else {
          opts.complete(null, mockStmt, mockRows);
        }
      },
    );

    const conn = createSnowflakeConnection({ url: testUrl });
    await expect(conn.query("SELECT bad_col FROM t")).rejects.toThrow(
      /Snowflake query failed: SQL compilation error/,
    );
  });

  test("timeout ALTER SESSION error wraps with context", async () => {
    mockExecute.mockImplementation(
      (opts: { sqlText: string; complete: Function }) => {
        if (opts.sqlText.includes("STATEMENT_TIMEOUT")) {
          opts.complete(new Error("Insufficient privileges"));
        } else {
          opts.complete(null, mockStmt, mockRows);
        }
      },
    );

    const conn = createSnowflakeConnection({ url: testUrl });
    await expect(conn.query("SELECT 1")).rejects.toThrow(
      /Failed to set Snowflake statement timeout.*ALTER SESSION privileges/,
    );
  });

  test("rejects NaN timeout", async () => {
    const conn = createSnowflakeConnection({ url: testUrl });
    await expect(conn.query("SELECT 1", NaN)).rejects.toThrow(
      /Invalid timeout/,
    );
  });

  test("rejects Infinity timeout", async () => {
    const conn = createSnowflakeConnection({ url: testUrl });
    await expect(conn.query("SELECT 1", Infinity)).rejects.toThrow(
      /Invalid timeout/,
    );
  });

  test("handles undefined stmt and rows in callback", async () => {
    mockExecute.mockImplementation(
      (opts: { sqlText: string; complete: Function }) => {
        if (!opts.sqlText.startsWith("ALTER SESSION")) {
          // Simulate callback with no stmt or rows
          opts.complete(null, undefined, undefined);
        } else {
          opts.complete(null, mockStmt, mockRows);
        }
      },
    );

    const conn = createSnowflakeConnection({ url: testUrl });
    const result = await conn.query("SELECT 1");
    expect(result.columns).toEqual([]);
    expect(result.rows).toEqual([]);
  });

  test("pool exhaustion error propagates from query", async () => {
    mockPoolUse.mockImplementation(() =>
      Promise.reject(new Error("ResourceRequest timed out")),
    );
    const conn = createSnowflakeConnection({ url: testUrl });
    await expect(conn.query("SELECT 1")).rejects.toThrow(
      /ResourceRequest timed out/,
    );
  });

  test("close drains and clears pool", async () => {
    const conn = createSnowflakeConnection({ url: testUrl });
    await conn.close();
    expect(mockPoolDrain).toHaveBeenCalled();
    expect(mockPoolClear).toHaveBeenCalled();
  });

  test("close does not throw when drain or clear rejects", async () => {
    mockPoolDrain.mockImplementation(() =>
      Promise.reject(new Error("already drained")),
    );
    mockPoolClear.mockImplementation(() =>
      Promise.reject(new Error("already cleared")),
    );

    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const conn = createSnowflakeConnection({ url: testUrl });
    await conn.close(); // should not throw
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  test("close calls clear even when drain fails", async () => {
    mockPoolDrain.mockImplementation(() =>
      Promise.reject(new Error("drain failed")),
    );

    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const conn = createSnowflakeConnection({ url: testUrl });
    await conn.close();
    // clear should still be called even though drain failed
    expect(mockPoolClear).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

describe("healthCheck", () => {
  const validConfig = { url: "snowflake://user:pass@xy12345/db" };

  test("returns healthy when ping succeeds", async () => {
    const plugin = snowflakePlugin(validConfig);
    const result = await plugin.healthCheck!();
    expect(result.healthy).toBe(true);
    expect(typeof result.latencyMs).toBe("number");
  });

  test("returns unhealthy when query fails", async () => {
    mockExecute.mockImplementation(
      (opts: { sqlText: string; complete: Function }) => {
        opts.complete(new Error("Connection refused"));
      },
    );
    const plugin = snowflakePlugin(validConfig);
    const result = await plugin.healthCheck!();
    expect(result.healthy).toBe(false);
    expect(result.message).toBeDefined();
    expect(typeof result.latencyMs).toBe("number");
  });

  test("closes connection after successful health check", async () => {
    const plugin = snowflakePlugin(validConfig);
    await plugin.healthCheck!();
    expect(mockPoolDrain).toHaveBeenCalled();
    expect(mockPoolClear).toHaveBeenCalled();
  });

  test("closes connection after failed health check", async () => {
    mockExecute.mockImplementation(
      (opts: { sqlText: string; complete: Function }) => {
        opts.complete(new Error("Connection refused"));
      },
    );
    const plugin = snowflakePlugin(validConfig);
    await plugin.healthCheck!();
    expect(mockPoolDrain).toHaveBeenCalled();
    expect(mockPoolClear).toHaveBeenCalled();
  });

  test("returns unhealthy (not throws) when pool construction fails", async () => {
    mockCreatePool.mockImplementation(() => {
      throw new Error("pool init failed");
    });
    const plugin = snowflakePlugin(validConfig);
    const result = await plugin.healthCheck!();
    expect(result.healthy).toBe(false);
    expect(result.message).toContain("pool init failed");
  });

  test("returns unhealthy (not throws) when close fails during cleanup", async () => {
    mockExecute.mockImplementation(
      (opts: { sqlText: string; complete: Function }) => {
        opts.complete(new Error("Connection refused"));
      },
    );
    mockPoolDrain.mockImplementation(() =>
      Promise.reject(new Error("drain failed")),
    );

    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const plugin = snowflakePlugin(validConfig);
    const result = await plugin.healthCheck!();
    // Should return unhealthy result, not throw from close()
    expect(result.healthy).toBe(false);
    expect(typeof result.latencyMs).toBe("number");
    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Initialize
// ---------------------------------------------------------------------------

describe("initialize", () => {
  test("logs account only (no credentials) and warns about read-only", async () => {
    const plugin = snowflakePlugin({
      url: "snowflake://admin:secret@xy12345.us-east-1/mydb/public?warehouse=WH",
    });
    const logged: { level: string; msg: string }[] = [];
    const ctx = {
      db: null,
      connections: { get: () => { throw new Error("not implemented"); }, list: () => [] },
      tools: { register: () => {} },
      logger: {
        info: (...args: unknown[]) => { logged.push({ level: "info", msg: String(args[0]) }); },
        warn: (...args: unknown[]) => { logged.push({ level: "warn", msg: String(args[0]) }); },
        error: () => {},
        debug: () => {},
      },
      config: {},
    };
    await plugin.initialize!(ctx);

    // Check info log has account but no credentials
    const infoMsg = logged.find(
      (m) => m.level === "info" && m.msg.includes("Snowflake datasource plugin initialized"),
    );
    expect(infoMsg).toBeDefined();
    expect(infoMsg!.msg).toContain("xy12345.us-east-1");
    expect(infoMsg!.msg).not.toContain("secret");
    expect(infoMsg!.msg).not.toContain("admin");

    // Check warn log about read-only
    const warnMsg = logged.find(
      (m) => m.level === "warn" && m.msg.includes("read-only mode"),
    );
    expect(warnMsg).toBeDefined();
    expect(warnMsg!.msg).toContain("SQL validation");
  });
});
