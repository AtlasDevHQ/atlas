/**
 * Tests for ConnectionRegistry health check features.
 */
import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { resolve } from "path";

// Mock pg
mock.module("pg", () => ({
  Pool: class MockPool {
    async query() { return { rows: [], fields: [] }; }
    async connect() {
      return { async query() { return { rows: [], fields: [] }; }, release() {} };
    }
    async end() {}
  },
}));

mock.module("mysql2/promise", () => ({
  createPool: () => ({
    async getConnection() {
      return { async execute() { return [[], []]; }, release() {} };
    },
    async end() {},
  }),
}));

// Note: DuckDB mock removed — adapter is now a plugin.

// Cache-busting import
const connModPath = resolve(__dirname, "../connection.ts");
const connMod = await import(`${connModPath}?t=${Date.now()}`);
const ConnectionRegistry = connMod.ConnectionRegistry as typeof import("../connection").ConnectionRegistry;
const extractTargetHost = connMod.extractTargetHost as typeof import("../connection").extractTargetHost;
type DBConnection = import("../connection").DBConnection;

describe("ConnectionRegistry health checks", () => {
  let registry: InstanceType<typeof ConnectionRegistry>;

  beforeEach(() => {
    registry = new ConnectionRegistry();
  });

  afterEach(() => {
    registry._reset();
  });

  function mockConn(opts?: { failQuery?: boolean }): DBConnection {
    return {
      async query() {
        if (opts?.failQuery) throw new Error("connection refused");
        return { columns: ["?column?"], rows: [{ "?column?": 1 }] };
      },
      async close() {},
    };
  }

  it("healthy on successful health check", async () => {
    await registry.registerDirect("test", mockConn(), "postgres");
    const result = await registry.healthCheck("test");
    expect(result.status).toBe("healthy");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.checkedAt).toBeInstanceOf(Date);
  });

  it("degraded after 1 failure", async () => {
    await registry.registerDirect("test", mockConn({ failQuery: true }), "postgres");
    const result = await registry.healthCheck("test");
    expect(result.status).toBe("degraded");
    expect(result.message).toContain("connection refused");
  });

  it("unhealthy after 3 failures spanning > 5 minutes", async () => {
    const conn = mockConn({ failQuery: true });
    await registry.registerDirect("test", conn, "postgres");

    // Simulate 3 failures over 5+ minutes
    await registry.healthCheck("test"); // failure 1

    // Manipulate the entry's firstFailureAt to simulate time passing
    // Access private field via any cast
    const entries = (registry as unknown as { entries: Map<string, { firstFailureAt: number | null; consecutiveFailures: number }> }).entries;
    const entry = entries.get("test")!;
    entry.firstFailureAt = Date.now() - (5 * 60 * 1000 + 1000); // 5min + 1s ago
    entry.consecutiveFailures = 2; // already had 2 failures

    const result = await registry.healthCheck("test"); // failure 3
    expect(result.status).toBe("unhealthy");
  });

  it("recovers from unhealthy to healthy on success", async () => {
    let shouldFail = true;
    const conn: DBConnection = {
      async query() {
        if (shouldFail) throw new Error("down");
        return { columns: ["?column?"], rows: [{ "?column?": 1 }] };
      },
      async close() {},
    };

    await registry.registerDirect("test", conn, "postgres");

    // Make it unhealthy
    const entries = (registry as unknown as { entries: Map<string, { firstFailureAt: number | null; consecutiveFailures: number }> }).entries;
    await registry.healthCheck("test");
    const entry = entries.get("test")!;
    entry.firstFailureAt = Date.now() - (5 * 60 * 1000 + 1000);
    entry.consecutiveFailures = 2;
    const unhealthy = await registry.healthCheck("test");
    expect(unhealthy.status).toBe("unhealthy");

    // Now recover
    shouldFail = false;
    const recovered = await registry.healthCheck("test");
    expect(recovered.status).toBe("healthy");
  });

  it("describe() includes health status", async () => {
    await registry.registerDirect("test", mockConn(), "postgres", "Test DB");
    await registry.healthCheck("test");

    const meta = registry.describe();
    expect(meta).toHaveLength(1);
    expect(meta[0].health).toBeDefined();
    expect(meta[0].health!.status).toBe("healthy");
  });

  it("describe() omits health when no check has been run", async () => {
    await registry.registerDirect("test", mockConn(), "postgres");
    const meta = registry.describe();
    expect(meta[0].health).toBeUndefined();
  });

  it("_reset() stops health checks", () => {
    registry.startHealthChecks(60000);
    registry._reset();
    // Should not throw — interval is already cleared
    registry.stopHealthChecks();
  });

  it("startHealthChecks is idempotent", () => {
    registry.startHealthChecks(60000);
    registry.startHealthChecks(60000); // should not create a second interval
    registry.stopHealthChecks();
  });

  it("getTargetHost returns host for registered connection", () => {
    registry.register("pg", {
      url: "postgresql://user:pass@db-host.example.com:5432/mydb",
    });
    expect(registry.getTargetHost("pg")).toBe("db-host.example.com");
  });

  it("getTargetHost returns (unknown) for unregistered connection", () => {
    expect(registry.getTargetHost("nonexistent")).toBe("(unknown)");
  });
});

describe("extractTargetHost", () => {
  it("extracts hostname from postgresql URL", () => {
    expect(extractTargetHost("postgresql://user:pass@db.example.com:5432/mydb")).toBe("db.example.com");
  });

  it("extracts hostname from mysql URL", () => {
    expect(extractTargetHost("mysql://user:pass@mysql.host:3306/db")).toBe("mysql.host");
  });

  it("extracts hostname from clickhouse URL", () => {
    expect(extractTargetHost("clickhouse://user:pass@ch.host:8123/default")).toBe("ch.host");
  });

  it("extracts hostname from snowflake URL", () => {
    expect(extractTargetHost("snowflake://user:pass@account123/db/schema")).toBe("account123");
  });

  it("extracts hostname from duckdb URL", () => {
    // duckdb://:memory: doesn't have a parseable hostname
    expect(extractTargetHost("duckdb://:memory:")).toBe("(unknown)");
  });

  it("returns (unknown) for unparseable URL", () => {
    expect(extractTargetHost("not-a-url")).toBe("(unknown)");
  });

  it("never exposes credentials", () => {
    const host = extractTargetHost("postgresql://admin:s3cret@db.example.com:5432/production");
    expect(host).toBe("db.example.com");
    expect(host).not.toContain("admin");
    expect(host).not.toContain("s3cret");
  });
});
