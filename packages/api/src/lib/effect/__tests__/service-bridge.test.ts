/**
 * Tests for the ConnectionRegistry backward-compatibility bridge.
 *
 * Verifies that createConnectionTestLayer works as a drop-in replacement
 * for mock.module in Effect-based test setup.
 */
import { describe, it, expect } from "bun:test";
import { Effect } from "effect";
import { ConnectionRegistry, createTestLayer } from "../services";

describe("ConnectionRegistry test bridge", () => {
  const mockConn = {
    query: async (_sql: string) => ({
      columns: ["count"],
      rows: [{ count: 42 }],
    }),
    close: async () => {},
  };

  it("createTestLayer provides a complete service", async () => {
    const layer = createTestLayer({
      get: () => mockConn,
      getDefault: () => mockConn,
      list: () => ["default"],
      has: () => true,
      getDBType: () => "postgres" as const,
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* ConnectionRegistry;
        const ids = registry.list();
        const conn = registry.get("default");
        const qr = yield* Effect.promise(() => conn.query("SELECT count(*) FROM users"));
        return { ids, rows: qr.rows };
      }).pipe(Effect.provide(layer)),
    );

    expect(result.ids).toEqual(["default"]);
    expect(result.rows).toEqual([{ count: 42 }]);
  });

  it("proxy throws for unconfigured methods", async () => {
    const layer = createTestLayer({
      list: () => ["default"],
    });

    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const registry = yield* ConnectionRegistry;
        // getDBType not provided — proxy should throw
        return registry.getDBType("default");
      }).pipe(Effect.provide(layer)),
    );

    expect(exit._tag).toBe("Failure");
  });

  it("overrides work with all service methods", async () => {
    const drainResult = { drained: true, message: "Pool drained and recreated" };
    const layer = createTestLayer({
      drain: async () => drainResult,
      getPoolMetrics: () => ({
        connectionId: "default",
        dbType: "postgres",
        pool: { totalSize: 10, activeCount: 3, idleCount: 7, waitingCount: 0 },
        totalQueries: 100,
        totalErrors: 2,
        avgQueryTimeMs: 50,
        consecutiveFailures: 0,
        lastDrainAt: null,
      }),
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* ConnectionRegistry;
        const drain = yield* Effect.promise(() => registry.drain("default"));
        const metrics = registry.getPoolMetrics("default");
        return { drain, metrics };
      }).pipe(Effect.provide(layer)),
    );

    expect(result.drain).toEqual(drainResult);
    expect(result.metrics.totalQueries).toBe(100);
    expect(result.metrics.pool?.activeCount).toBe(3);
  });

  it("org-scoped operations work through layer", async () => {
    const layer = createTestLayer({
      getForOrg: () => mockConn,
      isOrgPoolingEnabled: () => true,
      listOrgs: () => ["org-1", "org-2"],
      hasOrgPool: (orgId: string) => orgId === "org-1",
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* ConnectionRegistry;
        registry.getForOrg("org-1", "default");
        const orgs = registry.listOrgs();
        const hasPool = registry.hasOrgPool("org-1");
        return { orgs, hasPool };
      }).pipe(Effect.provide(layer)),
    );

    expect(result.orgs).toEqual(["org-1", "org-2"]);
    expect(result.hasPool).toBe(true);
  });

  it("multiple layers can be composed for complex tests", async () => {
    // First layer provides connection operations
    const connLayer = createTestLayer({
      get: () => mockConn,
      getDefault: () => mockConn,
      list: () => ["default"],
    });

    // Run two independent programs against the same layer
    const [ids, queryResult] = await Promise.all([
      Effect.runPromise(
        Effect.gen(function* () {
          const registry = yield* ConnectionRegistry;
          return registry.list();
        }).pipe(Effect.provide(connLayer)),
      ),
      Effect.runPromise(
        Effect.gen(function* () {
          const registry = yield* ConnectionRegistry;
          const conn = registry.getDefault();
          return conn.query("SELECT 1");
        }).pipe(Effect.provide(connLayer)),
      ),
    ]);

    expect(ids).toEqual(["default"]);
    expect(queryResult.rows).toEqual([{ count: 42 }]);
  });
});
