/**
 * Tests for ConnectionRegistry pool warmup, drain, and metrics features.
 */
import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { resolve } from "path";

// Mock pg — include pool stats properties
mock.module("pg", () => ({
  Pool: class MockPool {
    totalCount = 2;
    idleCount = 1;
    waitingCount = 0;
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

// Cache-busting import
const connModPath = resolve(__dirname, "../connection.ts");
const connMod = await import(`${connModPath}?t=${Date.now()}`);
const ConnectionRegistry = connMod.ConnectionRegistry as typeof import("../connection").ConnectionRegistry;
type DBConnection = import("../connection").DBConnection;
type PoolStats = import("../connection").PoolStats;

describe("ConnectionRegistry pool warmup", () => {
  let registry: InstanceType<typeof ConnectionRegistry>;

  beforeEach(() => {
    registry = new ConnectionRegistry();
  });

  afterEach(() => {
    registry._reset();
  });

  function mockConn(opts?: { failQuery?: boolean; poolStats?: PoolStats }): DBConnection {
    return {
      async query() {
        if (opts?.failQuery) throw new Error("connection refused");
        return { columns: ["?column?"], rows: [{ "?column?": 1 }] };
      },
      async close() {},
      getPoolStats() {
        return opts?.poolStats ?? { totalSize: 5, activeCount: 2, idleCount: 3, waitingCount: 0 };
      },
    };
  }

  it("warmup runs SELECT 1 on all registered connections", async () => {
    let queryCount = 0;
    const conn: DBConnection = {
      async query() {
        queryCount++;
        return { columns: ["?column?"], rows: [{ "?column?": 1 }] };
      },
      async close() {},
    };
    registry.registerDirect("test", conn, "postgres");
    await registry.warmup(3);
    expect(queryCount).toBe(3);
  });

  it("warmup handles failures gracefully", async () => {
    registry.registerDirect("test", mockConn({ failQuery: true }), "postgres");
    // Should not throw
    await registry.warmup(2);
  });

  it("warmup with 0 count is a no-op", async () => {
    let queryCount = 0;
    const conn: DBConnection = {
      async query() { queryCount++; return { columns: [], rows: [] }; },
      async close() {},
    };
    registry.registerDirect("test", conn, "postgres");
    await registry.warmup(0);
    expect(queryCount).toBe(0);
  });
});

describe("ConnectionRegistry pool drain", () => {
  let registry: InstanceType<typeof ConnectionRegistry>;

  beforeEach(() => {
    registry = new ConnectionRegistry();
  });

  afterEach(() => {
    registry._reset();
  });

  it("drain recreates pool from config", async () => {
    registry.register("test", { url: "postgresql://localhost/test" });
    const result = await registry.drain("test");
    expect(result.drained).toBe(true);
    expect(result.message).toContain("recreated");
  });

  it("drain rejects plugin-managed connections", async () => {
    const conn: DBConnection = {
      async query() { return { columns: [], rows: [] }; },
      async close() {},
    };
    registry.registerDirect("plugin-conn", conn, "postgres");
    const result = await registry.drain("plugin-conn");
    expect(result.drained).toBe(false);
    expect(result.message).toContain("plugin");
  });

  it("drain respects cooldown period", async () => {
    registry.register("test", { url: "postgresql://localhost/test" });
    const first = await registry.drain("test");
    expect(first.drained).toBe(true);

    // Second drain should be blocked by cooldown
    const second = await registry.drain("test");
    expect(second.drained).toBe(false);
    expect(second.message).toContain("cooldown");
  });

  it("drain throws for unknown connection", async () => {
    expect(() => registry.drain("nonexistent")).toThrow("not registered");
  });

  it("auto-drain triggers after consecutive errors exceed threshold", () => {
    // Set a low threshold via env
    const origEnv = process.env.ATLAS_POOL_DRAIN_THRESHOLD;
    process.env.ATLAS_POOL_DRAIN_THRESHOLD = "3";
    try {
      registry.register("auto-drain", { url: "postgresql://localhost/test" });

      // Get initial conn reference
      const connBefore = registry.get("auto-drain");

      // Record errors up to threshold
      registry.recordError("auto-drain");
      registry.recordError("auto-drain");
      registry.recordError("auto-drain"); // triggers drain

      // Conn should be a new instance after drain
      const connAfter = registry.get("auto-drain");
      expect(connAfter).not.toBe(connBefore);
    } finally {
      process.env.ATLAS_POOL_DRAIN_THRESHOLD = origEnv;
    }
  });
});

describe("ConnectionRegistry pool metrics", () => {
  let registry: InstanceType<typeof ConnectionRegistry>;

  beforeEach(() => {
    registry = new ConnectionRegistry();
  });

  afterEach(() => {
    registry._reset();
  });

  it("getPoolMetrics returns initial zeros", () => {
    const conn: DBConnection = {
      async query() { return { columns: [], rows: [] }; },
      async close() {},
      getPoolStats() { return { totalSize: 10, activeCount: 0, idleCount: 10, waitingCount: 0 }; },
    };
    registry.registerDirect("test", conn, "postgres");
    const metrics = registry.getPoolMetrics("test");
    expect(metrics.connectionId).toBe("test");
    expect(metrics.dbType).toBe("postgres");
    expect(metrics.totalQueries).toBe(0);
    expect(metrics.totalErrors).toBe(0);
    expect(metrics.avgQueryTimeMs).toBe(0);
    expect(metrics.consecutiveFailures).toBe(0);
    expect(metrics.lastDrainAt).toBeNull();
    expect(metrics.pool).toEqual({ totalSize: 10, activeCount: 0, idleCount: 10, waitingCount: 0 });
  });

  it("recordQuery increments counters", () => {
    const conn: DBConnection = {
      async query() { return { columns: [], rows: [] }; },
      async close() {},
    };
    registry.registerDirect("test", conn, "postgres");
    registry.recordQuery("test", 100);
    registry.recordQuery("test", 200);
    const metrics = registry.getPoolMetrics("test");
    expect(metrics.totalQueries).toBe(2);
    expect(metrics.avgQueryTimeMs).toBe(150);
  });

  it("recordError increments error counters", () => {
    // High threshold to avoid auto-drain
    const origEnv = process.env.ATLAS_POOL_DRAIN_THRESHOLD;
    process.env.ATLAS_POOL_DRAIN_THRESHOLD = "100";
    try {
      const conn: DBConnection = {
        async query() { return { columns: [], rows: [] }; },
        async close() {},
      };
      registry.registerDirect("test", conn, "postgres");
      registry.recordError("test");
      registry.recordError("test");
      const metrics = registry.getPoolMetrics("test");
      expect(metrics.totalErrors).toBe(2);
      expect(metrics.consecutiveFailures).toBe(2);
    } finally {
      process.env.ATLAS_POOL_DRAIN_THRESHOLD = origEnv;
    }
  });

  it("recordSuccess resets consecutive failures", () => {
    const origEnv = process.env.ATLAS_POOL_DRAIN_THRESHOLD;
    process.env.ATLAS_POOL_DRAIN_THRESHOLD = "100";
    try {
      const conn: DBConnection = {
        async query() { return { columns: [], rows: [] }; },
        async close() {},
      };
      registry.registerDirect("test", conn, "postgres");
      registry.recordError("test");
      registry.recordError("test");
      registry.recordSuccess("test");
      const metrics = registry.getPoolMetrics("test");
      expect(metrics.consecutiveFailures).toBe(0);
      expect(metrics.totalErrors).toBe(2); // total doesn't reset
    } finally {
      process.env.ATLAS_POOL_DRAIN_THRESHOLD = origEnv;
    }
  });

  it("getAllPoolMetrics returns metrics for all connections", () => {
    const conn: DBConnection = {
      async query() { return { columns: [], rows: [] }; },
      async close() {},
    };
    registry.registerDirect("a", conn, "postgres");
    registry.registerDirect("b", conn, "mysql");
    const all = registry.getAllPoolMetrics();
    expect(all).toHaveLength(2);
    expect(all.map((m) => m.connectionId).toSorted()).toEqual(["a", "b"]);
  });

  it("pool stats are null for connections without getPoolStats", () => {
    const conn: DBConnection = {
      async query() { return { columns: [], rows: [] }; },
      async close() {},
    };
    registry.registerDirect("test", conn, "postgres");
    const metrics = registry.getPoolMetrics("test");
    expect(metrics.pool).toBeNull();
  });

  it("getPoolMetrics throws for unknown connection", () => {
    expect(() => registry.getPoolMetrics("nonexistent")).toThrow("not registered");
  });

  it("config-registered connection has pool stats from getPoolStats", () => {
    registry.register("pg-test", { url: "postgresql://localhost/test" });
    const metrics = registry.getPoolMetrics("pg-test");
    // Pool stats should be non-null for core adapters (pg)
    expect(metrics.pool).not.toBeNull();
    // Values depend on the mock — just verify the shape is correct
    expect(typeof metrics.pool!.totalSize).toBe("number");
    expect(typeof metrics.pool!.activeCount).toBe("number");
    expect(typeof metrics.pool!.idleCount).toBe("number");
    expect(typeof metrics.pool!.waitingCount).toBe("number");
  });
});
