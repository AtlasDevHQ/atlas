import { describe, test, expect, mock, beforeEach, spyOn } from "bun:test";

// Mock @clickhouse/client before any imports that use it
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockQuery = mock((): Promise<any> =>
  Promise.resolve({
    json: () =>
      Promise.resolve({
        meta: [{ name: "count" }],
        data: [{ count: 42 }],
      }),
  }),
);
const mockClose = mock(() => Promise.resolve());
const mockCreateClient = mock(() => ({
  query: mockQuery,
  close: mockClose,
}));

mock.module("@clickhouse/client", () => ({
  createClient: mockCreateClient,
}));

import { definePlugin, isDatasourcePlugin } from "@useatlas/plugin-sdk";
import {
  clickhousePlugin,
  buildClickHousePlugin,
  rewriteClickHouseUrl,
  extractHost,
} from "../index";
import { createClickHouseConnection } from "../connection";

beforeEach(() => {
  mockQuery.mockClear();
  mockClose.mockClear();
  mockCreateClient.mockClear();

  // Re-stub the default return value after clearing
  mockQuery.mockImplementation(() =>
    Promise.resolve({
      json: () =>
        Promise.resolve({
          meta: [{ name: "count" }],
          data: [{ count: 42 }],
        }),
    }),
  );
  mockClose.mockImplementation(() => Promise.resolve());
  mockCreateClient.mockImplementation(() => ({
    query: mockQuery,
    close: mockClose,
  }));
});

// ---------------------------------------------------------------------------
// URL rewriting
// ---------------------------------------------------------------------------

describe("rewriteClickHouseUrl", () => {
  test("rewrites clickhouse:// to http://", () => {
    expect(rewriteClickHouseUrl("clickhouse://localhost:8123/default")).toBe(
      "http://localhost:8123/default",
    );
  });

  test("rewrites clickhouses:// to https://", () => {
    expect(rewriteClickHouseUrl("clickhouses://ch.example.com:8443/db")).toBe(
      "https://ch.example.com:8443/db",
    );
  });

  test("passes through non-clickhouse URLs unchanged", () => {
    expect(rewriteClickHouseUrl("http://localhost:8123")).toBe(
      "http://localhost:8123",
    );
  });

  test("passes through https:// URLs unchanged", () => {
    expect(rewriteClickHouseUrl("https://ch.example.com:8443/db")).toBe(
      "https://ch.example.com:8443/db",
    );
  });
});

// ---------------------------------------------------------------------------
// extractHost (safe logging — no credentials)
// ---------------------------------------------------------------------------

describe("extractHost", () => {
  test("extracts hostname from clickhouse:// URL", () => {
    expect(extractHost("clickhouse://localhost:8123/default")).toBe("localhost");
  });

  test("strips credentials from URL", () => {
    expect(extractHost("clickhouse://admin:s3cret@ch.prod.example.com:8123/db")).toBe(
      "ch.prod.example.com",
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
  test("accepts valid clickhouse:// URL", () => {
    const plugin = clickhousePlugin({
      url: "clickhouse://localhost:8123/default",
    });
    expect(plugin.id).toBe("clickhouse-datasource");
    expect(plugin.type).toBe("datasource");
    expect(plugin.config?.url).toBe("clickhouse://localhost:8123/default");
  });

  test("accepts valid clickhouses:// URL", () => {
    const plugin = clickhousePlugin({
      url: "clickhouses://ch.example.com:8443/analytics",
    });
    expect(plugin.config?.url).toBe(
      "clickhouses://ch.example.com:8443/analytics",
    );
  });

  test("accepts optional database field", () => {
    const plugin = clickhousePlugin({
      url: "clickhouse://localhost:8123/default",
      database: "analytics",
    });
    expect(plugin.config?.database).toBe("analytics");
  });

  test("rejects empty URL", () => {
    expect(() => clickhousePlugin({ url: "" })).toThrow(
      /URL must not be empty/,
    );
  });

  test("rejects non-clickhouse URL scheme", () => {
    expect(() =>
      clickhousePlugin({ url: "postgresql://localhost:5432/db" }),
    ).toThrow(/URL must start with clickhouse:\/\/ or clickhouses:\/\//);
  });

  test("rejects missing URL", () => {
    // @ts-expect-error — intentionally passing invalid config
    expect(() => clickhousePlugin({})).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Plugin shape validation (definePlugin + createPlugin)
// ---------------------------------------------------------------------------

describe("plugin shape", () => {
  const validConfig = { url: "clickhouse://localhost:8123/default" };

  test("createPlugin factory returns a valid plugin", () => {
    const plugin = clickhousePlugin(validConfig);
    expect(plugin.id).toBe("clickhouse-datasource");
    expect(plugin.type).toBe("datasource");
    expect(plugin.version).toBe("0.1.0");
    expect(plugin.name).toBe("ClickHouse DataSource");
  });

  test("definePlugin accepts the built plugin", () => {
    const plugin = buildClickHousePlugin(validConfig);
    const validated = definePlugin(plugin);
    expect(validated).toBe(plugin);
  });

  test("isDatasourcePlugin type guard passes", () => {
    const plugin = clickhousePlugin(validConfig);
    expect(isDatasourcePlugin(plugin)).toBe(true);
  });

  test("connection.dbType is 'clickhouse'", () => {
    const plugin = clickhousePlugin(validConfig);
    expect(plugin.connection.dbType).toBe("clickhouse");
  });

  test("entities is an empty array", () => {
    const plugin = clickhousePlugin(validConfig);
    expect(plugin.entities).toEqual([]);
  });

  test("dialect provides ClickHouse-specific guidance", () => {
    const plugin = clickhousePlugin(validConfig);
    expect(plugin.dialect).toContain("ClickHouse SQL dialect");
    expect(plugin.dialect).toContain("toStartOfMonth");
    expect(plugin.dialect).toContain("countIf");
  });

  test("dialect does not tell the LLM to add FORMAT clauses", () => {
    const plugin = clickhousePlugin(validConfig);
    expect(plugin.dialect).toContain("Do not add FORMAT clauses");
    expect(plugin.dialect).not.toContain("Use FORMAT JSON");
  });
});

// ---------------------------------------------------------------------------
// Connection factory
// ---------------------------------------------------------------------------

describe("connection factory", () => {
  test("connection.create() returns a PluginDBConnection", async () => {
    const plugin = clickhousePlugin({
      url: "clickhouse://localhost:8123/default",
    });
    const conn = await plugin.connection.create();
    expect(typeof conn.query).toBe("function");
    expect(typeof conn.close).toBe("function");
  });

  test("createClient receives the rewritten HTTP URL", () => {
    createClickHouseConnection({
      url: "clickhouse://ch.example.com:8123/analytics",
    });
    expect(mockCreateClient).toHaveBeenCalledWith({
      url: "http://ch.example.com:8123/analytics",
    });
  });

  test("createClient receives the rewritten HTTPS URL for clickhouses://", () => {
    createClickHouseConnection({
      url: "clickhouses://ch.example.com:8443/analytics",
    });
    expect(mockCreateClient).toHaveBeenCalledWith({
      url: "https://ch.example.com:8443/analytics",
    });
  });

  test("database override is passed to createClient", () => {
    createClickHouseConnection({
      url: "clickhouse://localhost:8123/default",
      database: "analytics",
    });
    expect(mockCreateClient).toHaveBeenCalledWith({
      url: "http://localhost:8123/default",
      database: "analytics",
    });
  });

  test("query returns { columns, rows }", async () => {
    const conn = createClickHouseConnection({
      url: "clickhouse://localhost:8123/default",
    });
    const result = await conn.query("SELECT count() AS count FROM system.one");
    expect(result.columns).toEqual(["count"]);
    expect(result.rows).toEqual([{ count: 42 }]);
  });

  test("query uses default 30s timeout when none provided", async () => {
    const conn = createClickHouseConnection({
      url: "clickhouse://localhost:8123/default",
    });
    await conn.query("SELECT 1");
    expect(mockQuery).toHaveBeenCalledWith({
      query: "SELECT 1",
      format: "JSON",
      clickhouse_settings: {
        max_execution_time: 30,
        readonly: 1,
      },
    });
  });

  test("query passes custom timeout settings", async () => {
    const conn = createClickHouseConnection({
      url: "clickhouse://localhost:8123/default",
    });
    await conn.query("SELECT 1", 15000);
    expect(mockQuery).toHaveBeenCalledWith({
      query: "SELECT 1",
      format: "JSON",
      clickhouse_settings: {
        max_execution_time: 15,
        readonly: 1,
      },
    });
  });

  test("query rounds timeout up to nearest second", async () => {
    const conn = createClickHouseConnection({
      url: "clickhouse://localhost:8123/default",
    });
    await conn.query("SELECT 1", 1500);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        clickhouse_settings: expect.objectContaining({
          max_execution_time: 2,
        }),
      }),
    );
  });

  test("query wraps ClickHouse errors", async () => {
    mockQuery.mockImplementation(() =>
      Promise.reject(new Error("Connection refused")),
    );
    const conn = createClickHouseConnection({
      url: "clickhouse://localhost:8123/default",
    });
    await expect(conn.query("SELECT 1")).rejects.toThrow(
      /ClickHouse query failed: Connection refused/,
    );
  });

  test("query wraps non-Error thrown values", async () => {
    mockQuery.mockImplementation(() => Promise.reject("raw string error"));
    const conn = createClickHouseConnection({
      url: "clickhouse://localhost:8123/default",
    });
    await expect(conn.query("SELECT 1")).rejects.toThrow(
      /ClickHouse query failed: raw string error/,
    );
  });

  test("query wraps result.json() failures with same prefix", async () => {
    mockQuery.mockImplementation(() =>
      Promise.resolve({ json: () => Promise.reject(new Error("JSON parse error")) }),
    );
    const conn = createClickHouseConnection({
      url: "clickhouse://localhost:8123/default",
    });
    await expect(conn.query("SELECT 1")).rejects.toThrow(
      /ClickHouse query failed: JSON parse error/,
    );
  });

  test("query rejects on missing meta field", async () => {
    mockQuery.mockImplementation(() =>
      Promise.resolve({ json: () => Promise.resolve({ data: [] }) }),
    );
    const conn = createClickHouseConnection({
      url: "clickhouse://localhost:8123/default",
    });
    await expect(conn.query("SELECT 1")).rejects.toThrow(/missing or invalid 'meta' field/);
  });

  test("query rejects on missing data field", async () => {
    mockQuery.mockImplementation(() =>
      Promise.resolve({
        json: () => Promise.resolve({ meta: [{ name: "x" }] }),
      }),
    );
    const conn = createClickHouseConnection({
      url: "clickhouse://localhost:8123/default",
    });
    await expect(conn.query("SELECT 1")).rejects.toThrow(/missing or invalid 'data' field/);
  });

  test("close delegates to client.close()", async () => {
    const conn = createClickHouseConnection({
      url: "clickhouse://localhost:8123/default",
    });
    await conn.close();
    expect(mockClose).toHaveBeenCalled();
  });

  test("close does not throw when client.close() rejects", async () => {
    mockClose.mockImplementation(() =>
      Promise.reject(new Error("already closed")),
    );
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const conn = createClickHouseConnection({
      url: "clickhouse://localhost:8123/default",
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
    const plugin = clickhousePlugin({
      url: "clickhouse://localhost:8123/default",
    });
    const result = await plugin.healthCheck!();
    expect(result.healthy).toBe(true);
    expect(typeof result.latencyMs).toBe("number");
  });

  test("returns unhealthy when ping fails", async () => {
    mockQuery.mockImplementation(() =>
      Promise.reject(new Error("Connection refused")),
    );
    const plugin = clickhousePlugin({
      url: "clickhouse://localhost:8123/default",
    });
    const result = await plugin.healthCheck!();
    expect(result.healthy).toBe(false);
    expect(result.message).toContain("Connection refused");
    expect(typeof result.latencyMs).toBe("number");
  });

  test("closes connection after successful health check", async () => {
    const plugin = clickhousePlugin({
      url: "clickhouse://localhost:8123/default",
    });
    await plugin.healthCheck!();
    expect(mockClose).toHaveBeenCalled();
  });

  test("closes connection after failed health check", async () => {
    mockQuery.mockImplementation(() =>
      Promise.reject(new Error("Connection refused")),
    );
    const plugin = clickhousePlugin({
      url: "clickhouse://localhost:8123/default",
    });
    await plugin.healthCheck!();
    expect(mockClose).toHaveBeenCalled();
  });

  test("returns unhealthy (not throws) when connection construction fails", async () => {
    mockCreateClient.mockImplementation(() => {
      throw new Error("client init failed");
    });
    const plugin = clickhousePlugin({
      url: "clickhouse://localhost:8123/default",
    });
    const result = await plugin.healthCheck!();
    expect(result.healthy).toBe(false);
    expect(result.message).toContain("client init failed");
  });
});

// ---------------------------------------------------------------------------
// Initialize
// ---------------------------------------------------------------------------

describe("initialize", () => {
  test("logs hostname only (no credentials)", async () => {
    const plugin = clickhousePlugin({
      url: "clickhouse://admin:secret@ch.prod.example.com:8123/db",
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
    const msg = logged.find((m) => m.includes("ClickHouse datasource plugin initialized"));
    expect(msg).toBeDefined();
    expect(msg).toContain("ch.prod.example.com");
    expect(msg).not.toContain("secret");
    expect(msg).not.toContain("admin");
  });
});
