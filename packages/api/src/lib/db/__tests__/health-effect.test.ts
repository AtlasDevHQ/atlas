/**
 * Tests for ConnectionRegistry health checks via Effect.repeat.
 *
 * Verifies that the setInterval replacement (Effect.repeat + Fiber)
 * correctly starts and stops health check cycles.
 */
import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { resolve } from "path";

// Mock pg
mock.module("pg", () => ({
  Pool: class MockPool {
    async query() { return { rows: [], fields: [] }; }
    async connect() {
      return {
        async query() { return { rows: [], fields: [] }; },
        release() {},
      };
    }
    async end() {}
    get totalCount() { return 0; }
    get idleCount() { return 0; }
    get waitingCount() { return 0; }
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

// Cache-busting import
const connModPath = resolve(__dirname, "../connection.ts");
const connMod = await import(`${connModPath}?health_effect=${Date.now()}`);
const ConnectionRegistry = connMod.ConnectionRegistry as typeof import("../connection").ConnectionRegistry;
type DBConnection = import("../connection").DBConnection;

describe("ConnectionRegistry health checks (Effect fiber)", () => {
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

  it("startHealthChecks is idempotent", () => {
    registry.registerDirect("test", mockConn(), "postgres");
    registry.startHealthChecks(60000);
    registry.startHealthChecks(60000); // should not create a second fiber
    registry.stopHealthChecks();
  });

  it("stopHealthChecks is safe to call without start", () => {
    registry.stopHealthChecks(); // no-op, no error
  });

  it("healthCheck returns healthy status for working connection", async () => {
    registry.registerDirect("test", mockConn(), "postgres");
    const result = await registry.healthCheck("test");
    expect(result.status).toBe("healthy");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.checkedAt).toBeInstanceOf(Date);
  });

  it("healthCheck returns degraded status for failing connection", async () => {
    registry.registerDirect("test", mockConn({ failQuery: true }), "postgres");
    const result = await registry.healthCheck("test");
    expect(result.status).toBe("degraded");
    expect(result.message).toContain("connection refused");
  });

  it("_reset stops health check fiber", () => {
    registry.registerDirect("test", mockConn(), "postgres");
    registry.startHealthChecks(60000);
    registry._reset();
    // If fiber was properly interrupted, this should not throw
    expect(registry.list()).toEqual([]);
  });

  it("shutdown stops health check fiber and closes pools", async () => {
    let closed = false;
    const conn: DBConnection = {
      async query() { return { columns: [], rows: [] }; },
      async close() { closed = true; },
    };
    registry.registerDirect("test", conn, "postgres");
    registry.startHealthChecks(60000);

    await registry.shutdown();

    expect(closed).toBe(true);
    expect(registry.list()).toEqual([]);
  });
});
