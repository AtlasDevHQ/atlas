/**
 * Tests for getRegionAwareConnection() — region-aware connection routing.
 *
 * Verifies that enterprise residency module is called when available,
 * regional datasource URLs are used, and fallback to global connection works.
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

// Mock the EE residency module — default: no region configured
type RegionResult = { databaseUrl: string; datasourceUrl?: string; region: string } | null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock function type needs to be wide for reassignment
let mockResolveRegionDatabaseUrl: (...args: any[]) => Promise<RegionResult> = mock(() => Promise.resolve(null));

mock.module("@atlas/ee/platform/residency", () => ({
  resolveRegionDatabaseUrl: (...args: unknown[]) => mockResolveRegionDatabaseUrl(...args),
}));

// Mock config so getConfig() returns a valid config
mock.module("@atlas/api/lib/config", () => ({
  getConfig: () => ({
    datasources: { default: { url: "postgresql://localhost/test" } },
  }),
  defineConfig: (c: unknown) => c,
}));

// Mock semantic to avoid whitelist file-system reads
mock.module("@atlas/api/lib/semantic", () => ({
  _resetWhitelists: () => {},
  getWhitelistedTables: () => [],
  getOrgWhitelistedTables: () => [],
}));

// Cache-busting import
const connModPath = resolve(__dirname, "../connection.ts");
const connMod = await import(`${connModPath}?t=${Date.now()}`);
const { getRegionAwareConnection } = connMod as typeof import("../connection");
type ConnectionRegistryInstance = InstanceType<typeof import("../connection").ConnectionRegistry>;

describe("getRegionAwareConnection", () => {
  let connections: ConnectionRegistryInstance;

  beforeEach(() => {
    // Access the module-level singleton to register connections
    connections = (connMod as { connections: ConnectionRegistryInstance }).connections;
    connections._reset();
    connections.register("default", { url: "postgresql://localhost/test" });
    mockResolveRegionDatabaseUrl = mock(() => Promise.resolve(null));
  });

  afterEach(() => {
    connections._reset();
  });

  it("falls back to default connection when no region is configured", async () => {
    const { db, resolvedConnId } = await getRegionAwareConnection("org-1", "default");
    expect(db).toBeDefined();
    expect(resolvedConnId).toBe("default");
    expect(connections.hasOrgPool("org-1", "default")).toBe(true);
  });

  it("uses regional datasource when resolveRegionDatabaseUrl returns a URL", async () => {
    mockResolveRegionDatabaseUrl = mock(() =>
      Promise.resolve({
        databaseUrl: "postgresql://us-east-1.internal/db",
        datasourceUrl: "postgresql://us-east-1.rds/analytics",
        region: "us-east-1",
      }),
    );

    const { db, resolvedConnId } = await getRegionAwareConnection("org-1", "default");
    expect(db).toBeDefined();
    expect(resolvedConnId).toBe("region:us-east-1");

    // Should have registered the region connection
    expect(connections.has("region:us-east-1")).toBe(true);

    // Org pool should be keyed with region
    expect(connections.hasOrgPool("org-1", "region:us-east-1", "us-east-1")).toBe(true);

    // Metrics should include region
    const metrics = connections.getOrgPoolMetrics("org-1");
    expect(metrics).toHaveLength(1);
    expect(metrics[0].region).toBe("us-east-1");
  });

  it("reuses existing region connection on subsequent calls", async () => {
    mockResolveRegionDatabaseUrl = mock(() =>
      Promise.resolve({
        databaseUrl: "postgresql://eu-west-1.internal/db",
        datasourceUrl: "postgresql://eu-west-1.rds/analytics",
        region: "eu-west-1",
      }),
    );

    const result1 = await getRegionAwareConnection("org-1", "default");
    const result2 = await getRegionAwareConnection("org-1", "default");

    // Same pool instance returned
    expect(result1.db).toBe(result2.db);

    // resolveRegionDatabaseUrl called twice but register only once
    expect(connections.has("region:eu-west-1")).toBe(true);
  });

  it("falls back to default when resolveRegionDatabaseUrl returns null datasourceUrl", async () => {
    mockResolveRegionDatabaseUrl = mock(() =>
      Promise.resolve({
        databaseUrl: "postgresql://us-east-1.internal/db",
        // No datasourceUrl — region has internal DB but no analytics datasource override
        region: "us-east-1",
      }),
    );

    const { db, resolvedConnId } = await getRegionAwareConnection("org-1", "default");
    expect(db).toBeDefined();
    expect(resolvedConnId).toBe("default");

    // Should NOT have registered a region connection
    expect(connections.has("region:us-east-1")).toBe(false);

    // Should use the default pool
    expect(connections.hasOrgPool("org-1", "default")).toBe(true);
  });

  it("different orgs in different regions get separate pools", async () => {
    // org-1 → us-east-1
    mockResolveRegionDatabaseUrl = mock((orgId: string) => {
      if (orgId === "org-1") {
        return Promise.resolve({
          databaseUrl: "postgresql://us-east-1.internal/db",
          datasourceUrl: "postgresql://us-east-1.rds/analytics",
          region: "us-east-1",
        });
      }
      return Promise.resolve({
        databaseUrl: "postgresql://eu-west-1.internal/db",
        datasourceUrl: "postgresql://eu-west-1.rds/analytics",
        region: "eu-west-1",
      });
    });

    const result1 = await getRegionAwareConnection("org-1", "default");
    const result2 = await getRegionAwareConnection("org-2", "default");

    expect(result1.db).toBeDefined();
    expect(result2.db).toBeDefined();
    expect(result1.db).not.toBe(result2.db);

    const metrics = connections.getOrgPoolMetrics();
    expect(metrics).toHaveLength(2);
    const regions = metrics.map((m) => m.region).toSorted();
    expect(regions).toEqual(["eu-west-1", "us-east-1"]);
  });
});
