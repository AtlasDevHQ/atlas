import { describe, test, expect, mock, beforeEach, spyOn } from "bun:test";

// Mock @duckdb/node-api before any imports that use it
const mockColumnNames = mock(() => ["count"]);
const mockGetRowObjects = mock(() => [{ count: 42 }]);
const mockRunAndReadAll = mock(() =>
  Promise.resolve({
    columnNames: mockColumnNames,
    getRowObjects: mockGetRowObjects,
  }),
);
const mockDisconnectSync = mock(() => {});
const mockCloseSync = mock(() => {});
const mockConnect = mock(() =>
  Promise.resolve({
    runAndReadAll: mockRunAndReadAll,
    disconnectSync: mockDisconnectSync,
  }),
);
const mockCreate = mock((_path: string, _opts?: Record<string, string>) =>
  Promise.resolve({
    connect: mockConnect,
    closeSync: mockCloseSync,
  }),
);

mock.module("@duckdb/node-api", () => ({
  DuckDBInstance: {
    create: mockCreate,
  },
}));

import { definePlugin, isDatasourcePlugin } from "@useatlas/plugin-sdk";
import {
  duckdbPlugin,
  buildDuckDBPlugin,
  parseDuckDBUrl,
  DUCKDB_FORBIDDEN_PATTERNS,
} from "../index";
import { createDuckDBConnection } from "../connection";

beforeEach(() => {
  mockColumnNames.mockClear();
  mockGetRowObjects.mockClear();
  mockRunAndReadAll.mockClear();
  mockDisconnectSync.mockClear();
  mockCloseSync.mockClear();
  mockConnect.mockClear();
  mockCreate.mockClear();

  // Re-stub defaults after clearing
  mockColumnNames.mockImplementation(() => ["count"]);
  mockGetRowObjects.mockImplementation(() => [{ count: 42 }]);
  mockRunAndReadAll.mockImplementation(() =>
    Promise.resolve({
      columnNames: mockColumnNames,
      getRowObjects: mockGetRowObjects,
    }),
  );
  mockDisconnectSync.mockImplementation(() => {});
  mockCloseSync.mockImplementation(() => {});
  mockConnect.mockImplementation(() =>
    Promise.resolve({
      runAndReadAll: mockRunAndReadAll,
      disconnectSync: mockDisconnectSync,
    }),
  );
  mockCreate.mockImplementation((_path: string, _opts?: Record<string, string>) =>
    Promise.resolve({
      connect: mockConnect,
      closeSync: mockCloseSync,
    }),
  );
});

// ---------------------------------------------------------------------------
// URL parsing
// ---------------------------------------------------------------------------

describe("parseDuckDBUrl", () => {
  test("parses duckdb:// as in-memory", () => {
    expect(parseDuckDBUrl("duckdb://")).toEqual({ path: ":memory:", readOnly: false });
  });

  test("parses duckdb://:memory: as in-memory", () => {
    expect(parseDuckDBUrl("duckdb://:memory:")).toEqual({ path: ":memory:", readOnly: false });
  });

  test("parses duckdb:///absolute/path.duckdb", () => {
    expect(parseDuckDBUrl("duckdb:///tmp/data.duckdb")).toEqual({
      path: "/tmp/data.duckdb",
      readOnly: true,
    });
  });

  test("parses duckdb://relative/path.duckdb", () => {
    expect(parseDuckDBUrl("duckdb://data/analytics.duckdb")).toEqual({
      path: "data/analytics.duckdb",
      readOnly: true,
    });
  });

  test("rejects non-duckdb URL", () => {
    expect(() => parseDuckDBUrl("postgresql://localhost:5432/db")).toThrow(
      /expected duckdb:\/\/ scheme/,
    );
  });
});

// ---------------------------------------------------------------------------
// Config validation (via createPlugin factory)
// ---------------------------------------------------------------------------

describe("config validation", () => {
  test("accepts valid duckdb:// URL", () => {
    const plugin = duckdbPlugin({
      url: "duckdb://analytics.duckdb",
    });
    expect(plugin.id).toBe("duckdb-datasource");
    expect(plugin.type).toBe("datasource");
    expect(plugin.config?.url).toBe("duckdb://analytics.duckdb");
  });

  test("accepts in-memory URL", () => {
    const plugin = duckdbPlugin({
      url: "duckdb://",
    });
    expect(plugin.config?.url).toBe("duckdb://");
  });

  test("accepts optional readOnly flag", () => {
    const plugin = duckdbPlugin({
      url: "duckdb://data.duckdb",
      readOnly: false,
    });
    expect(plugin.config?.readOnly).toBe(false);
  });

  test("rejects empty URL", () => {
    expect(() => duckdbPlugin({ url: "" })).toThrow(
      /URL must not be empty/,
    );
  });

  test("rejects non-duckdb URL scheme", () => {
    expect(() =>
      duckdbPlugin({ url: "postgresql://localhost:5432/db" }),
    ).toThrow(/URL must start with duckdb:\/\//);
  });

  test("rejects config with neither url nor path", () => {
    expect(() => duckdbPlugin({})).toThrow(/Either url or path is required/);
  });

  test("accepts path-based config", () => {
    const plugin = duckdbPlugin({ path: "/data/analytics.duckdb" });
    expect(plugin.id).toBe("duckdb-datasource");
    expect(plugin.type).toBe("datasource");
  });

  test("accepts path-based in-memory config", () => {
    const plugin = duckdbPlugin({ path: ":memory:" });
    expect(plugin.id).toBe("duckdb-datasource");
  });

  test("accepts path with readOnly override", () => {
    const plugin = duckdbPlugin({ path: "/data/analytics.duckdb", readOnly: false });
    expect(plugin.config?.readOnly).toBe(false);
  });

  test("rejects empty path", () => {
    expect(() => duckdbPlugin({ path: "" })).toThrow(/Path must not be empty/);
  });

  test("rejects whitespace-only path", () => {
    expect(() => duckdbPlugin({ path: "   " })).toThrow(/Path must not be empty/);
  });

  test("url takes precedence when both url and path are provided", () => {
    const plugin = duckdbPlugin({
      url: "duckdb://from-url.duckdb",
      path: "/from-path.duckdb",
    });
    expect(plugin.id).toBe("duckdb-datasource");
  });
});

// ---------------------------------------------------------------------------
// Plugin shape validation
// ---------------------------------------------------------------------------

describe("plugin shape", () => {
  const validConfig = { url: "duckdb://analytics.duckdb" };

  test("createPlugin factory returns a valid plugin", () => {
    const plugin = duckdbPlugin(validConfig);
    expect(plugin.id).toBe("duckdb-datasource");
    expect(plugin.type).toBe("datasource");
    expect(plugin.version).toBe("0.1.0");
    expect(plugin.name).toBe("DuckDB DataSource");
  });

  test("definePlugin accepts the built plugin", () => {
    const plugin = buildDuckDBPlugin(validConfig);
    const validated = definePlugin(plugin);
    expect(validated).toBe(plugin);
  });

  test("isDatasourcePlugin type guard passes", () => {
    const plugin = duckdbPlugin(validConfig);
    expect(isDatasourcePlugin(plugin)).toBe(true);
  });

  test("connection.dbType is 'duckdb'", () => {
    const plugin = duckdbPlugin(validConfig);
    expect(plugin.connection.dbType).toBe("duckdb");
  });

  test("connection.parserDialect is 'PostgresQL'", () => {
    const plugin = duckdbPlugin(validConfig);
    expect(plugin.connection.parserDialect).toBe("PostgresQL");
  });

  test("connection.forbiddenPatterns contains DuckDB-specific patterns", () => {
    const plugin = duckdbPlugin(validConfig);
    expect(plugin.connection.forbiddenPatterns).toBe(DUCKDB_FORBIDDEN_PATTERNS);
    expect(plugin.connection.forbiddenPatterns!.length).toBeGreaterThan(0);
  });

  test("entities is an empty array", () => {
    const plugin = duckdbPlugin(validConfig);
    expect(plugin.entities).toEqual([]);
  });

  test("dialect provides DuckDB-specific guidance", () => {
    const plugin = duckdbPlugin(validConfig);
    expect(plugin.dialect).toContain("DuckDB SQL dialect");
    expect(plugin.dialect).toContain("UNNEST");
    expect(plugin.dialect).toContain("blocked for security");
  });
});

// ---------------------------------------------------------------------------
// Forbidden patterns behavioral tests
// ---------------------------------------------------------------------------

describe("DUCKDB_FORBIDDEN_PATTERNS", () => {
  function matchesAny(sql: string): boolean {
    return DUCKDB_FORBIDDEN_PATTERNS.some((p) => p.test(sql));
  }

  test("blocks PRAGMA statements", () => {
    expect(matchesAny("PRAGMA database_list")).toBe(true);
  });

  test("blocks ATTACH/DETACH", () => {
    expect(matchesAny("ATTACH '/tmp/evil.db' AS evil")).toBe(true);
    expect(matchesAny("DETACH evil")).toBe(true);
  });

  test("blocks INSTALL", () => {
    expect(matchesAny("INSTALL httpfs")).toBe(true);
  });

  test("blocks EXPORT/IMPORT", () => {
    expect(matchesAny("EXPORT DATABASE '/tmp/dump'")).toBe(true);
    expect(matchesAny("IMPORT DATABASE '/tmp/dump'")).toBe(true);
  });

  test("blocks CHECKPOINT", () => {
    expect(matchesAny("CHECKPOINT")).toBe(true);
  });

  test("blocks DESCRIBE/EXPLAIN/SHOW", () => {
    expect(matchesAny("DESCRIBE orders")).toBe(true);
    expect(matchesAny("EXPLAIN SELECT 1")).toBe(true);
    expect(matchesAny("SHOW TABLES")).toBe(true);
  });

  test("blocks file-reading functions", () => {
    expect(matchesAny("SELECT * FROM read_csv_auto('/etc/passwd')")).toBe(true);
    expect(matchesAny("SELECT * FROM read_parquet('data.parquet')")).toBe(true);
    expect(matchesAny("SELECT * FROM read_json('data.json')")).toBe(true);
    expect(matchesAny("SELECT * FROM parquet_scan('*.parquet')")).toBe(true);
  });

  test("blocks SET statements", () => {
    expect(matchesAny("SET threads TO 4")).toBe(true);
  });

  test("allows legitimate SELECT queries", () => {
    expect(matchesAny("SELECT count(*) FROM orders")).toBe(false);
    expect(matchesAny("SELECT id, name FROM users WHERE active = true")).toBe(false);
    expect(matchesAny("SELECT * FROM orders JOIN customers ON orders.cid = customers.id")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Connection factory
// ---------------------------------------------------------------------------

describe("connection factory", () => {
  test("connection.create() returns a PluginDBConnection", async () => {
    const plugin = duckdbPlugin({
      url: "duckdb://analytics.duckdb",
    });
    const conn = await plugin.connection.create();
    expect(typeof conn.query).toBe("function");
    expect(typeof conn.close).toBe("function");
  });

  test("DuckDBInstance.create receives path and read-only options for file DBs", async () => {
    const conn = createDuckDBConnection({
      path: "analytics.duckdb",
    });
    await conn.query("SELECT 1");
    expect(mockCreate).toHaveBeenCalledWith("analytics.duckdb", {
      access_mode: "READ_ONLY",
    });
  });

  test("DuckDBInstance.create skips read-only for in-memory", async () => {
    const conn = createDuckDBConnection({
      path: ":memory:",
    });
    await conn.query("SELECT 1");
    expect(mockCreate).toHaveBeenCalledWith(":memory:", {});
  });

  test("DuckDBInstance.create skips read-only when readOnly is false", async () => {
    const conn = createDuckDBConnection({
      path: "data.duckdb",
      readOnly: false,
    });
    await conn.query("SELECT 1");
    expect(mockCreate).toHaveBeenCalledWith("data.duckdb", {});
  });

  test("query returns { columns, rows }", async () => {
    const conn = createDuckDBConnection({
      path: ":memory:",
    });
    const result = await conn.query("SELECT count(*) AS count FROM t");
    expect(result.columns).toEqual(["count"]);
    expect(result.rows).toEqual([{ count: 42 }]);
  });

  test("query uses lazy initialization (single instance)", async () => {
    const conn = createDuckDBConnection({
      path: ":memory:",
    });
    await conn.query("SELECT 1");
    await conn.query("SELECT 2");
    // Only one instance.create() call despite two queries
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  test("query wraps errors from runAndReadAll", async () => {
    mockRunAndReadAll.mockImplementation(() =>
      Promise.reject(new Error("parse error")),
    );
    const conn = createDuckDBConnection({
      path: ":memory:",
    });
    await expect(conn.query("INVALID SQL")).rejects.toThrow("parse error");
  });

  test("query times out via Promise.race", async () => {
    mockRunAndReadAll.mockImplementation(
      () => new Promise(() => {}), // never resolves
    );
    const conn = createDuckDBConnection({
      path: ":memory:",
    });
    await expect(conn.query("SELECT 1", 50)).rejects.toThrow(
      /DuckDB query timed out after 50ms/,
    );
  });

  test("query runs without timeout when timeoutMs is not provided", async () => {
    const conn = createDuckDBConnection({
      path: ":memory:",
    });
    const result = await conn.query("SELECT 1");
    expect(result.columns).toEqual(["count"]);
  });

  test("close calls disconnectSync and closeSync", async () => {
    const conn = createDuckDBConnection({
      path: ":memory:",
    });
    await conn.query("SELECT 1"); // initialize
    await conn.close();
    expect(mockDisconnectSync).toHaveBeenCalled();
    expect(mockCloseSync).toHaveBeenCalled();
  });

  test("close is a no-op before any query", async () => {
    const conn = createDuckDBConnection({
      path: ":memory:",
    });
    await conn.close(); // should not throw
    expect(mockDisconnectSync).not.toHaveBeenCalled();
    expect(mockCloseSync).not.toHaveBeenCalled();
  });

  test("close does not throw when cleanup fails", async () => {
    mockDisconnectSync.mockImplementation(() => {
      throw new Error("already disconnected");
    });
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const conn = createDuckDBConnection({
      path: ":memory:",
    });
    await conn.query("SELECT 1");
    await conn.close(); // should not throw
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  test("url-based config without readOnly defaults to READ_ONLY for files", async () => {
    const plugin = duckdbPlugin({ url: "duckdb://analytics.duckdb" });
    const conn = await plugin.connection.create();
    await conn.query("SELECT 1");
    expect(mockCreate).toHaveBeenCalledWith("analytics.duckdb", {
      access_mode: "READ_ONLY",
    });
  });

  test("url-based in-memory config without readOnly skips READ_ONLY", async () => {
    const plugin = duckdbPlugin({ url: "duckdb://" });
    const conn = await plugin.connection.create();
    await conn.query("SELECT 1");
    expect(mockCreate).toHaveBeenCalledWith(":memory:", {});
  });

  test("path-based in-memory config without readOnly skips READ_ONLY", async () => {
    const plugin = duckdbPlugin({ path: ":memory:" });
    const conn = await plugin.connection.create();
    await conn.query("SELECT 1");
    expect(mockCreate).toHaveBeenCalledWith(":memory:", {});
  });

  test("path-based config creates connection with correct path", async () => {
    const plugin = duckdbPlugin({ path: "/data/analytics.duckdb" });
    const conn = await plugin.connection.create();
    await conn.query("SELECT 1");
    expect(mockCreate).toHaveBeenCalledWith("/data/analytics.duckdb", {
      access_mode: "READ_ONLY",
    });
  });

  test("path-based config with readOnly false skips READ_ONLY", async () => {
    const plugin = duckdbPlugin({ path: "/data/analytics.duckdb", readOnly: false });
    const conn = await plugin.connection.create();
    await conn.query("SELECT 1");
    expect(mockCreate).toHaveBeenCalledWith("/data/analytics.duckdb", {});
  });

  test("retries initialization after transient failure", async () => {
    let callCount = 0;
    mockCreate.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.reject(new Error("transient failure"));
      }
      return Promise.resolve({
        connect: mockConnect,
        closeSync: mockCloseSync,
      });
    });
    const conn = createDuckDBConnection({
      path: ":memory:",
    });
    // First query fails
    await expect(conn.query("SELECT 1")).rejects.toThrow("transient failure");
    // Second query retries and succeeds
    const result = await conn.query("SELECT 1");
    expect(result.columns).toEqual(["count"]);
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

describe("healthCheck", () => {
  test("returns healthy when ping succeeds", async () => {
    const plugin = duckdbPlugin({
      url: "duckdb://",
    });
    const result = await plugin.healthCheck!();
    expect(result.healthy).toBe(true);
    expect(typeof result.latencyMs).toBe("number");
  });

  test("returns unhealthy when ping fails", async () => {
    mockCreate.mockImplementation(() =>
      Promise.reject(new Error("file not found")),
    );
    const plugin = duckdbPlugin({
      url: "duckdb://missing.duckdb",
    });
    const result = await plugin.healthCheck!();
    expect(result.healthy).toBe(false);
    expect(result.message).toContain("file not found");
    expect(typeof result.latencyMs).toBe("number");
  });

  test("closes connection after successful health check", async () => {
    const plugin = duckdbPlugin({
      url: "duckdb://",
    });
    await plugin.healthCheck!();
    expect(mockDisconnectSync).toHaveBeenCalled();
    expect(mockCloseSync).toHaveBeenCalled();
  });

  test("returns unhealthy (not throws) when construction fails", async () => {
    mockCreate.mockImplementation(() => {
      throw new Error("init failed");
    });
    const plugin = duckdbPlugin({
      url: "duckdb://",
    });
    const result = await plugin.healthCheck!();
    expect(result.healthy).toBe(false);
    expect(result.message).toContain("init failed");
  });
});

// ---------------------------------------------------------------------------
// Initialize
// ---------------------------------------------------------------------------

describe("initialize", () => {
  test("logs path for file database", async () => {
    const plugin = duckdbPlugin({
      url: "duckdb://data/analytics.duckdb",
    });
    const logged: string[] = [];
    const ctx = {
      db: null,
      connections: { get: () => { throw new Error("not implemented"); }, list: () => [] },
      tools: { register: () => {} },
      logger: {
        info: (...args: unknown[]) => { logged.push(String(args[0])); },
        warn: () => {},
        error: () => {},
        debug: () => {},
      },
      config: {},
    };
    await plugin.initialize!(ctx);
    const msg = logged.find((m) => m.includes("DuckDB datasource plugin initialized"));
    expect(msg).toBeDefined();
    expect(msg).toContain("data/analytics.duckdb");
  });

  test("logs 'in-memory' for memory database", async () => {
    const plugin = duckdbPlugin({
      url: "duckdb://",
    });
    const logged: string[] = [];
    const ctx = {
      db: null,
      connections: { get: () => { throw new Error("not implemented"); }, list: () => [] },
      tools: { register: () => {} },
      logger: {
        info: (...args: unknown[]) => { logged.push(String(args[0])); },
        warn: () => {},
        error: () => {},
        debug: () => {},
      },
      config: {},
    };
    await plugin.initialize!(ctx);
    const msg = logged.find((m) => m.includes("DuckDB datasource plugin initialized"));
    expect(msg).toBeDefined();
    expect(msg).toContain("in-memory");
  });
});
