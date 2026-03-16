/**
 * Tests for tenant-scoped (org-scoped) connection pooling.
 *
 * Verifies that each org gets isolated pool instances, LRU eviction works,
 * metrics are tracked per-org, and drain/shutdown clean up org pools.
 */
import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { resolve } from "path";

// Mock pg
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

function mockConn(opts?: { failQuery?: boolean }): DBConnection {
  return {
    async query() {
      if (opts?.failQuery) throw new Error("connection refused");
      return { columns: ["?column?"], rows: [{ "?column?": 1 }] };
    },
    async close() {},
    getPoolStats() {
      return { totalSize: 5, activeCount: 2, idleCount: 3, waitingCount: 0 };
    },
  };
}

describe("ConnectionRegistry org-scoped pools", () => {
  let registry: InstanceType<typeof ConnectionRegistry>;

  beforeEach(() => {
    registry = new ConnectionRegistry();
  });

  afterEach(() => {
    registry._reset();
  });

  describe("getForOrg", () => {
    it("creates an isolated pool for each org", () => {
      registry.register("default", { url: "postgresql://localhost/test" });
      const baseConn = registry.get("default");

      const conn1 = registry.getForOrg("org-1", "default");
      expect(conn1).toBeDefined();
      expect(conn1).not.toBe(baseConn); // org pool is distinct from base

      const conn2 = registry.getForOrg("org-2", "default");
      expect(conn2).toBeDefined();
      expect(conn2).not.toBe(conn1); // different orgs get different pools

      // Same org returns cached pool — no new creation
      const conn1Again = registry.getForOrg("org-1", "default");
      expect(conn1Again).toBe(conn1);
    });

    it("returns base connection for plugin-managed (no config) connections", () => {
      const conn = mockConn();
      registry.registerDirect("plugin-conn", conn, "postgres");

      const orgConn = registry.getForOrg("org-1", "plugin-conn");
      // Plugin connections are returned directly, no org-scoped clone
      expect(orgConn).toBe(conn);
    });

    it("throws for non-existent base connection", () => {
      expect(() => registry.getForOrg("org-1", "nonexistent")).toThrow("not registered");
    });

    it("lazy-initializes default connection when orgId is used", () => {
      process.env.ATLAS_DATASOURCE_URL = "postgresql://localhost/test";
      try {
        // Don't register "default" — getForOrg should trigger lazy init
        const conn = registry.getForOrg("org-1");
        expect(conn).toBeDefined();
      } finally {
        delete process.env.ATLAS_DATASOURCE_URL;
      }
    });

    it("uses org pool config for pool size", () => {
      registry.setOrgPoolConfig({ maxConnections: 3, idleTimeoutMs: 15000 });
      registry.register("default", { url: "postgresql://localhost/test", maxConnections: 20 });

      // The org pool is created with the org-specific limits, not the base's
      const conn = registry.getForOrg("org-1", "default");
      expect(conn).toBeDefined();
      // We can't directly inspect the pg Pool config, but we verified it's a distinct connection
      expect(registry.hasOrgPool("org-1", "default")).toBe(true);
    });
  });

  describe("LRU eviction", () => {
    it("evicts the least recently used org when maxOrgs is exceeded", () => {
      registry.setOrgPoolConfig({ maxOrgs: 2, maxConnections: 5, idleTimeoutMs: 30000, warmupProbes: 0, drainThreshold: 5 });
      registry.register("default", { url: "postgresql://localhost/test" });

      registry.getForOrg("org-1", "default");
      registry.getForOrg("org-2", "default");
      // org-1 was accessed first, so it's the LRU

      // Access org-1 again to make it more recent
      registry.getForOrg("org-1", "default");

      // Adding org-3 should evict org-2 (LRU)
      registry.getForOrg("org-3", "default");

      expect(registry.hasOrgPool("org-1", "default")).toBe(true);
      expect(registry.hasOrgPool("org-2", "default")).toBe(false); // evicted
      expect(registry.hasOrgPool("org-3", "default")).toBe(true);
    });
  });

  describe("org pool metrics", () => {
    it("tracks metrics per org pool", () => {
      registry.register("default", { url: "postgresql://localhost/test" });
      registry.getForOrg("org-1", "default");
      registry.getForOrg("org-2", "default");

      registry.recordQuery("default", 100, "org-1");
      registry.recordQuery("default", 200, "org-1");
      registry.recordQuery("default", 50, "org-2");

      const org1Metrics = registry.getOrgPoolMetrics("org-1");
      expect(org1Metrics).toHaveLength(1);
      expect(org1Metrics[0].orgId).toBe("org-1");
      expect(org1Metrics[0].totalQueries).toBe(2);
      expect(org1Metrics[0].avgQueryTimeMs).toBe(150);

      const org2Metrics = registry.getOrgPoolMetrics("org-2");
      expect(org2Metrics).toHaveLength(1);
      expect(org2Metrics[0].totalQueries).toBe(1);
    });

    it("returns all org metrics when orgId is omitted", () => {
      registry.register("default", { url: "postgresql://localhost/test" });
      registry.getForOrg("org-1", "default");
      registry.getForOrg("org-2", "default");

      const all = registry.getOrgPoolMetrics();
      expect(all).toHaveLength(2);
      expect(all.map((m) => m.orgId).toSorted()).toEqual(["org-1", "org-2"]);
    });

    it("records errors and consecutive failures per org", () => {
      const origEnv = process.env.ATLAS_POOL_DRAIN_THRESHOLD;
      process.env.ATLAS_POOL_DRAIN_THRESHOLD = "100";
      try {
        registry.setOrgPoolConfig({ drainThreshold: 100, maxConnections: 5, idleTimeoutMs: 30000, maxOrgs: 50, warmupProbes: 0 });
        registry.register("default", { url: "postgresql://localhost/test" });
        registry.getForOrg("org-1", "default");

        registry.recordError("default", "org-1");
        registry.recordError("default", "org-1");

        const metrics = registry.getOrgPoolMetrics("org-1");
        expect(metrics[0].totalErrors).toBe(2);
        expect(metrics[0].consecutiveFailures).toBe(2);

        // Success resets consecutive failures
        registry.recordSuccess("default", "org-1");
        const after = registry.getOrgPoolMetrics("org-1");
        expect(after[0].consecutiveFailures).toBe(0);
        expect(after[0].totalErrors).toBe(2); // total doesn't reset
      } finally {
        process.env.ATLAS_POOL_DRAIN_THRESHOLD = origEnv;
      }
    });

    it("does not affect base pool metrics when recording org metrics", () => {
      const origEnv = process.env.ATLAS_POOL_DRAIN_THRESHOLD;
      process.env.ATLAS_POOL_DRAIN_THRESHOLD = "100";
      try {
        registry.register("default", { url: "postgresql://localhost/test" });
        registry.getForOrg("org-1", "default");

        // Record against org pool
        registry.recordQuery("default", 100, "org-1");

        // Base pool should be unaffected
        const baseMetrics = registry.getPoolMetrics("default");
        expect(baseMetrics.totalQueries).toBe(0);

        // Org pool should have the query
        const orgMetrics = registry.getOrgPoolMetrics("org-1");
        expect(orgMetrics[0].totalQueries).toBe(1);
      } finally {
        process.env.ATLAS_POOL_DRAIN_THRESHOLD = origEnv;
      }
    });
  });

  describe("auto-drain for org pools", () => {
    it("triggers drain when consecutive errors exceed threshold", () => {
      registry.setOrgPoolConfig({ drainThreshold: 3, maxConnections: 5, idleTimeoutMs: 30000, maxOrgs: 50, warmupProbes: 0 });
      registry.register("default", { url: "postgresql://localhost/test" });

      const connBefore = registry.getForOrg("org-1", "default");

      registry.recordError("default", "org-1");
      registry.recordError("default", "org-1");
      registry.recordError("default", "org-1"); // triggers drain

      // Conn should be a new instance after drain
      const connAfter = registry.getForOrg("org-1", "default");
      expect(connAfter).not.toBe(connBefore);
    });
  });

  describe("drainOrg", () => {
    it("drains all pools for a specific org", async () => {
      registry.register("default", { url: "postgresql://localhost/test" });
      registry.register("warehouse", { url: "postgresql://localhost/warehouse" });
      registry.getForOrg("org-1", "default");
      registry.getForOrg("org-1", "warehouse");
      registry.getForOrg("org-2", "default");

      const result = await registry.drainOrg("org-1");
      expect(result.drained).toBe(2);

      expect(registry.hasOrgPool("org-1", "default")).toBe(false);
      expect(registry.hasOrgPool("org-1", "warehouse")).toBe(false);
      expect(registry.hasOrgPool("org-2", "default")).toBe(true); // unaffected
    });

    it("returns 0 when org has no pools", async () => {
      const result = await registry.drainOrg("nonexistent-org");
      expect(result.drained).toBe(0);
    });
  });

  describe("listOrgs and listOrgConnections", () => {
    it("lists active orgs", () => {
      registry.register("default", { url: "postgresql://localhost/test" });
      registry.getForOrg("org-1", "default");
      registry.getForOrg("org-2", "default");

      const orgs = registry.listOrgs();
      expect(orgs.toSorted()).toEqual(["org-1", "org-2"]);
    });

    it("lists connections for a specific org", () => {
      registry.register("default", { url: "postgresql://localhost/test" });
      registry.register("warehouse", { url: "postgresql://localhost/warehouse" });
      registry.getForOrg("org-1", "default");
      registry.getForOrg("org-1", "warehouse");

      const conns = registry.listOrgConnections("org-1");
      expect(conns.toSorted()).toEqual(["default", "warehouse"]);
    });
  });

  describe("shutdown and reset", () => {
    it("shutdown closes all org pools", async () => {
      registry.register("default", { url: "postgresql://localhost/test" });
      registry.getForOrg("org-1", "default");
      registry.getForOrg("org-2", "default");

      await registry.shutdown();
      expect(registry.listOrgs()).toHaveLength(0);
    });

    it("_reset clears all org pools", () => {
      registry.register("default", { url: "postgresql://localhost/test" });
      registry.getForOrg("org-1", "default");

      registry._reset();
      expect(registry.listOrgs()).toHaveLength(0);
      expect(registry.hasOrgPool("org-1", "default")).toBe(false);
    });
  });

  describe("org pool config", () => {
    it("setOrgPoolConfig updates settings and enables pooling", () => {
      expect(registry.isOrgPoolingEnabled()).toBe(false);
      registry.setOrgPoolConfig({ maxConnections: 3, maxOrgs: 10 });
      const config = registry.getOrgPoolConfig();
      expect(config.maxConnections).toBe(3);
      expect(config.maxOrgs).toBe(10);
      expect(config.enabled).toBe(true);
      // Defaults for unset fields
      expect(config.idleTimeoutMs).toBe(30000);
      expect(config.warmupProbes).toBe(2);
      expect(config.drainThreshold).toBe(5);
    });

    it("setOrgPoolConfig rejects invalid values", () => {
      expect(() => registry.setOrgPoolConfig({ maxConnections: 0 })).toThrow("must be >= 1");
      expect(() => registry.setOrgPoolConfig({ maxOrgs: -1 })).toThrow("must be >= 1");
      expect(() => registry.setOrgPoolConfig({ drainThreshold: 0 })).toThrow("must be >= 1");
    });

    it("isOrgPoolingEnabled is false by default", () => {
      expect(registry.isOrgPoolingEnabled()).toBe(false);
    });
  });

  describe("backward compatibility", () => {
    it("base pool methods work unchanged without orgId", () => {
      registry.register("default", { url: "postgresql://localhost/test" });

      // Base pool works as before
      const conn = registry.get("default");
      expect(conn).toBeDefined();

      registry.recordQuery("default", 100);
      registry.recordSuccess("default");

      const metrics = registry.getPoolMetrics("default");
      expect(metrics.totalQueries).toBe(1);
    });

    it("recordError without orgId operates on base pool", () => {
      const origEnv = process.env.ATLAS_POOL_DRAIN_THRESHOLD;
      process.env.ATLAS_POOL_DRAIN_THRESHOLD = "100";
      try {
        registry.register("default", { url: "postgresql://localhost/test" });
        registry.recordError("default");
        const metrics = registry.getPoolMetrics("default");
        expect(metrics.totalErrors).toBe(1);
      } finally {
        process.env.ATLAS_POOL_DRAIN_THRESHOLD = origEnv;
      }
    });
  });
});
