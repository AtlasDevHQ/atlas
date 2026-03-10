import { describe, test, expect, mock, beforeEach, spyOn } from "bun:test";

// Mock mysql2/promise before any imports that use it
const mockExecute = mock((): Promise<unknown[]> =>
  Promise.resolve([
    [{ count: 42 }],
    [{ name: "count" }],
  ]),
);
const mockRelease = mock(() => {});
const mockGetConnection = mock(() =>
  Promise.resolve({
    execute: mockExecute,
    release: mockRelease,
  }),
);
const mockEnd = mock(() => Promise.resolve());
const mockCreatePool = mock(() => ({
  getConnection: mockGetConnection,
  end: mockEnd,
}));

mock.module("mysql2/promise", () => ({
  createPool: mockCreatePool,
}));

import { definePlugin, isDatasourcePlugin } from "@useatlas/plugin-sdk";
import {
  mysqlPlugin,
  buildMySQLPlugin,
  extractHost,
} from "../src/index";
import { createMySQLConnection } from "../src/connection";

beforeEach(() => {
  mockExecute.mockClear();
  mockRelease.mockClear();
  mockGetConnection.mockClear();
  mockEnd.mockClear();
  mockCreatePool.mockClear();

  // Re-stub defaults after clearing
  mockExecute.mockImplementation((sql?: string) => {
    // SET commands return no result set
    if (typeof sql === "string" && sql.startsWith("SET ")) {
      return Promise.resolve([[], []]);
    }
    return Promise.resolve([
      [{ count: 42 }],
      [{ name: "count" }],
    ]);
  });
  mockRelease.mockImplementation(() => {});
  mockGetConnection.mockImplementation(() =>
    Promise.resolve({
      execute: mockExecute,
      release: mockRelease,
    }),
  );
  mockEnd.mockImplementation(() => Promise.resolve());
  mockCreatePool.mockImplementation(() => ({
    getConnection: mockGetConnection,
    end: mockEnd,
  }));
});

// ---------------------------------------------------------------------------
// extractHost (safe logging — no credentials)
// ---------------------------------------------------------------------------

describe("extractHost", () => {
  test("extracts hostname from mysql:// URL", () => {
    expect(extractHost("mysql://localhost:3306/mydb")).toBe("localhost");
  });

  test("strips credentials from URL", () => {
    expect(extractHost("mysql://admin:s3cret@db.prod.example.com:3306/mydb")).toBe(
      "db.prod.example.com",
    );
  });

  test("returns (unknown) for invalid URL", () => {
    expect(extractHost("not-a-url")).toBe("(unknown)");
  });
});

// ---------------------------------------------------------------------------
// Config validation (via createPlugin factory)
// ---------------------------------------------------------------------------

describe("config validation", () => {
  test("accepts valid mysql:// URL", () => {
    const plugin = mysqlPlugin({
      url: "mysql://localhost:3306/mydb",
    });
    expect(plugin.id).toBe("mysql-datasource");
    expect(plugin.types).toEqual(["datasource"]);
    expect(plugin.config?.url).toBe("mysql://localhost:3306/mydb");
  });

  test("accepts valid mysql2:// URL", () => {
    const plugin = mysqlPlugin({
      url: "mysql2://localhost:3306/mydb",
    });
    expect(plugin.config?.url).toBe("mysql2://localhost:3306/mydb");
  });

  test("accepts optional poolSize and idleTimeoutMs", () => {
    const plugin = mysqlPlugin({
      url: "mysql://localhost:3306/mydb",
      poolSize: 20,
      idleTimeoutMs: 60000,
    });
    expect(plugin.config?.poolSize).toBe(20);
    expect(plugin.config?.idleTimeoutMs).toBe(60000);
  });

  test("rejects empty URL", () => {
    expect(() => mysqlPlugin({ url: "" })).toThrow(
      /URL must not be empty/,
    );
  });

  test("rejects non-mysql URL scheme", () => {
    expect(() =>
      mysqlPlugin({ url: "postgresql://localhost:5432/db" }),
    ).toThrow(/URL must start with mysql:\/\/ or mysql2:\/\//);
  });

  test("rejects missing URL", () => {
    // @ts-expect-error — intentionally passing invalid config
    expect(() => mysqlPlugin({})).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Plugin shape validation
// ---------------------------------------------------------------------------

describe("plugin shape", () => {
  const validConfig = { url: "mysql://localhost:3306/mydb" };

  test("createPlugin factory returns a valid plugin", () => {
    const plugin = mysqlPlugin(validConfig);
    expect(plugin.id).toBe("mysql-datasource");
    expect(plugin.types).toEqual(["datasource"]);
    expect(plugin.version).toBe("0.1.0");
    expect(plugin.name).toBe("MySQL DataSource");
  });

  test("definePlugin accepts the built plugin", () => {
    const plugin = buildMySQLPlugin(validConfig);
    const validated = definePlugin(plugin);
    expect(validated).toBe(plugin);
  });

  test("isDatasourcePlugin type guard passes", () => {
    const plugin = mysqlPlugin(validConfig);
    expect(isDatasourcePlugin(plugin)).toBe(true);
  });

  test("connection.dbType is 'mysql'", () => {
    const plugin = mysqlPlugin(validConfig);
    expect(plugin.connection.dbType).toBe("mysql");
  });

  test("entities is an empty array", () => {
    const plugin = mysqlPlugin(validConfig);
    expect(plugin.entities).toEqual([]);
  });

  test("dialect provides MySQL-specific guidance", () => {
    const plugin = mysqlPlugin(validConfig);
    expect(plugin.dialect).toContain("MySQL SQL dialect");
    expect(plugin.dialect).toContain("backtick");
    expect(plugin.dialect).toContain("DATE_FORMAT");
    expect(plugin.dialect).toContain("IFNULL");
  });
});

// ---------------------------------------------------------------------------
// Connection factory
// ---------------------------------------------------------------------------

describe("connection factory", () => {
  test("connection.create() returns a PluginDBConnection", async () => {
    const plugin = mysqlPlugin({
      url: "mysql://localhost:3306/mydb",
    });
    const conn = await plugin.connection.create();
    expect(typeof conn.query).toBe("function");
    expect(typeof conn.close).toBe("function");
  });

  test("connection.create() caches the pool (single pool per plugin)", () => {
    const plugin = mysqlPlugin({
      url: "mysql://localhost:3306/mydb",
    });
    const conn1 = plugin.connection.create();
    const conn2 = plugin.connection.create();
    expect(conn1).toBe(conn2);
    expect(mockCreatePool).toHaveBeenCalledTimes(1);
  });

  test("createPool receives correct config", () => {
    createMySQLConnection({
      url: "mysql://localhost:3306/mydb",
    });
    expect(mockCreatePool).toHaveBeenCalledWith({
      uri: "mysql://localhost:3306/mydb",
      connectionLimit: 10,
      idleTimeout: 30000,
      supportBigNumbers: true,
      bigNumberStrings: true,
    });
  });

  test("custom poolSize and idleTimeoutMs are passed through", () => {
    createMySQLConnection({
      url: "mysql://localhost:3306/mydb",
      poolSize: 5,
      idleTimeoutMs: 60000,
    });
    expect(mockCreatePool).toHaveBeenCalledWith({
      uri: "mysql://localhost:3306/mydb",
      connectionLimit: 5,
      idleTimeout: 60000,
      supportBigNumbers: true,
      bigNumberStrings: true,
    });
  });

  test("query sets read-only session before executing", async () => {
    const conn = createMySQLConnection({
      url: "mysql://localhost:3306/mydb",
    });
    await conn.query("SELECT count(*) AS count FROM users");

    // First call: SET SESSION TRANSACTION READ ONLY
    expect(mockExecute).toHaveBeenCalledWith("SET SESSION TRANSACTION READ ONLY");
    // Second call: SET SESSION MAX_EXECUTION_TIME
    expect(mockExecute).toHaveBeenCalledWith("SET SESSION MAX_EXECUTION_TIME = 30000");
  });

  test("query returns { columns, rows }", async () => {
    const conn = createMySQLConnection({
      url: "mysql://localhost:3306/mydb",
    });
    const result = await conn.query("SELECT count(*) AS count FROM users");
    expect(result.columns).toEqual(["count"]);
    expect(result.rows).toEqual([{ count: 42 }]);
  });

  test("query uses default 30s timeout when none provided", async () => {
    const conn = createMySQLConnection({
      url: "mysql://localhost:3306/mydb",
    });
    await conn.query("SELECT 1");
    expect(mockExecute).toHaveBeenCalledWith("SET SESSION MAX_EXECUTION_TIME = 30000");
  });

  test("query passes custom timeout in milliseconds", async () => {
    const conn = createMySQLConnection({
      url: "mysql://localhost:3306/mydb",
    });
    await conn.query("SELECT 1", 15000);
    expect(mockExecute).toHaveBeenCalledWith("SET SESSION MAX_EXECUTION_TIME = 15000");
  });

  test("query floors non-integer timeout", async () => {
    const conn = createMySQLConnection({
      url: "mysql://localhost:3306/mydb",
    });
    await conn.query("SELECT 1", 1500.7);
    expect(mockExecute).toHaveBeenCalledWith("SET SESSION MAX_EXECUTION_TIME = 1500");
  });

  test("query uses default 30s timeout for NaN", async () => {
    const conn = createMySQLConnection({
      url: "mysql://localhost:3306/mydb",
    });
    await conn.query("SELECT 1", NaN);
    expect(mockExecute).toHaveBeenCalledWith("SET SESSION MAX_EXECUTION_TIME = 30000");
  });

  test("query uses default 30s timeout for Infinity", async () => {
    const conn = createMySQLConnection({
      url: "mysql://localhost:3306/mydb",
    });
    await conn.query("SELECT 1", Infinity);
    expect(mockExecute).toHaveBeenCalledWith("SET SESSION MAX_EXECUTION_TIME = 30000");
  });

  test("query clamps negative timeout to 0", async () => {
    const conn = createMySQLConnection({
      url: "mysql://localhost:3306/mydb",
    });
    await conn.query("SELECT 1", -100);
    expect(mockExecute).toHaveBeenCalledWith("SET SESSION MAX_EXECUTION_TIME = 0");
  });

  test("query releases connection on success", async () => {
    const conn = createMySQLConnection({
      url: "mysql://localhost:3306/mydb",
    });
    await conn.query("SELECT 1");
    expect(mockRelease).toHaveBeenCalled();
  });

  test("query releases connection on failure", async () => {
    mockExecute.mockImplementation((sql?: string) => {
      if (typeof sql === "string" && sql.startsWith("SET ")) {
        return Promise.resolve([[], []]);
      }
      return Promise.reject(new Error("Query failed"));
    });
    const conn = createMySQLConnection({
      url: "mysql://localhost:3306/mydb",
    });
    await expect(conn.query("SELECT 1")).rejects.toThrow(/MySQL query failed/);
    expect(mockRelease).toHaveBeenCalled();
  });

  test("query wraps MySQL errors", async () => {
    mockExecute.mockImplementation(() =>
      Promise.reject(new Error("Connection refused")),
    );
    const conn = createMySQLConnection({
      url: "mysql://localhost:3306/mydb",
    });
    await expect(conn.query("SELECT 1")).rejects.toThrow(
      /MySQL query failed: Connection refused/,
    );
  });

  test("query wraps non-Error thrown values", async () => {
    mockExecute.mockImplementation(() => Promise.reject("raw string error"));
    const conn = createMySQLConnection({
      url: "mysql://localhost:3306/mydb",
    });
    await expect(conn.query("SELECT 1")).rejects.toThrow(
      /MySQL query failed: raw string error/,
    );
  });

  test("close delegates to pool.end()", async () => {
    const conn = createMySQLConnection({
      url: "mysql://localhost:3306/mydb",
    });
    await conn.close();
    expect(mockEnd).toHaveBeenCalled();
  });

  test("close does not throw when pool.end() rejects", async () => {
    mockEnd.mockImplementation(() =>
      Promise.reject(new Error("already closed")),
    );
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const conn = createMySQLConnection({
      url: "mysql://localhost:3306/mydb",
    });
    await conn.close(); // should not throw
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

describe("healthCheck", () => {
  test("returns healthy when ping succeeds", async () => {
    const plugin = mysqlPlugin({
      url: "mysql://localhost:3306/mydb",
    });
    const result = await plugin.healthCheck!();
    expect(result.healthy).toBe(true);
    expect(typeof result.latencyMs).toBe("number");
  });

  test("returns unhealthy when ping fails", async () => {
    mockExecute.mockImplementation(() =>
      Promise.reject(new Error("Connection refused")),
    );
    const plugin = mysqlPlugin({
      url: "mysql://localhost:3306/mydb",
    });
    const result = await plugin.healthCheck!();
    expect(result.healthy).toBe(false);
    expect(result.message).toContain("Connection refused");
    expect(typeof result.latencyMs).toBe("number");
  });

  test("closes connection after successful health check", async () => {
    const plugin = mysqlPlugin({
      url: "mysql://localhost:3306/mydb",
    });
    await plugin.healthCheck!();
    expect(mockEnd).toHaveBeenCalled();
  });

  test("closes connection after failed health check", async () => {
    mockExecute.mockImplementation(() =>
      Promise.reject(new Error("Connection refused")),
    );
    const plugin = mysqlPlugin({
      url: "mysql://localhost:3306/mydb",
    });
    await plugin.healthCheck!();
    expect(mockEnd).toHaveBeenCalled();
  });

  test("returns unhealthy (not throws) when connection construction fails", async () => {
    mockCreatePool.mockImplementation(() => {
      throw new Error("pool init failed");
    });
    const plugin = mysqlPlugin({
      url: "mysql://localhost:3306/mydb",
    });
    const result = await plugin.healthCheck!();
    expect(result.healthy).toBe(false);
    expect(result.message).toContain("pool init failed");
  });
});

// ---------------------------------------------------------------------------
// Initialize
// ---------------------------------------------------------------------------

describe("initialize", () => {
  test("logs hostname only (no credentials)", async () => {
    const plugin = mysqlPlugin({
      url: "mysql://admin:secret@db.prod.example.com:3306/mydb",
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
    const msg = logged.find((m) => m.includes("MySQL datasource plugin initialized"));
    expect(msg).toBeDefined();
    expect(msg).toContain("db.prod.example.com");
    expect(msg).not.toContain("secret");
    expect(msg).not.toContain("admin");
  });
});
