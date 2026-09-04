/**
 * Tests for the ConnectionRegistry Effect service (Context.Tag + Layer).
 *
 * Verifies that the service can be created, provided via Layer, and
 * accessed in Effect programs. Uses createTestLayer for DI.
 *
 * Also carries the `createTestLayer` drop-in-for-`mock.module` cases,
 * formerly `service-bridge.test.ts` — same Tag, same factory, same file-level
 * setup, so they were two files asserting one thing.
 */
import { describe, it, expect } from "bun:test";
import { Effect } from "effect";
import { ConnectionRegistry, createTestLayer } from "../services";
import type { ConnectionRegistryShape } from "../services";

describe("ConnectionRegistry Effect Service", () => {
  const mockConn = {
    query: async () => ({ columns: ["id"], rows: [{ id: 1 }] }),
    close: async () => {},
  };

  it("resolves service from test layer", async () => {
    const TestLayer = createTestLayer({
      list: () => ["default", "analytics"],
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* ConnectionRegistry;
        return registry.list();
      }).pipe(Effect.provide(TestLayer)),
    );

    expect(result).toEqual(["default", "analytics"]);
  });

  it("get() returns mock connection", async () => {
    const TestLayer = createTestLayer({
      get: () => mockConn,
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* ConnectionRegistry;
        const conn = registry.get("default");
        return conn.query("SELECT 1");
      }).pipe(Effect.provide(TestLayer)),
    );

    expect(result.columns).toEqual(["id"]);
    expect(result.rows).toEqual([{ id: 1 }]);
  });

  it("getDefault() delegates to test layer", async () => {
    const TestLayer = createTestLayer({
      getDefault: () => mockConn,
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* ConnectionRegistry;
        const conn = registry.getDefault();
        return conn.query("SELECT 1");
      }).pipe(Effect.provide(TestLayer)),
    );

    expect(result.rows).toEqual([{ id: 1 }]);
  });

  it("unstubbed method throws descriptive error", async () => {
    const TestLayer = createTestLayer({
      list: () => ["default"],
    });

    const result = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const registry = yield* ConnectionRegistry;
        // getDBType is not provided — should throw
        registry.getDBType("default");
      }).pipe(Effect.provide(TestLayer)),
    );

    expect(result._tag).toBe("Failure");
  });

  it("describe() returns connection metadata", async () => {
    const metadata = [
      { id: "default", dbType: "postgres" as const, description: "Primary" },
      { id: "analytics", dbType: "postgres" as const },
    ];

    const TestLayer = createTestLayer({
      describe: () => metadata,
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* ConnectionRegistry;
        return registry.describe();
      }).pipe(Effect.provide(TestLayer)),
    );

    expect(result).toHaveLength(2);
    expect(result[0].id).toBe("default");
  });

  it("register + has round-trip works through layer", async () => {
    const registered = new Set<string>();
    const TestLayer = createTestLayer({
      register: (id: string) => { registered.add(id); },
      has: (id: string) => registered.has(id),
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* ConnectionRegistry;
        registry.register("new-source", { url: "postgresql://test/db" });
        return registry.has("new-source");
      }).pipe(Effect.provide(TestLayer)),
    );

    expect(result).toBe(true);
  });

  it("supports full service interface type", () => {
    // Type-level test: ensure ConnectionRegistryShape is complete
    const shape: ConnectionRegistryShape = {
      get: () => mockConn,
      getDefault: () => mockConn,
      getForOrg: () => mockConn,
      register: () => {},
      registerDirect: () => {},
      unregister: () => false,
      has: () => true,
      list: () => [],
      describe: () => [],
      getDBType: () => "postgres",
      getTargetHost: () => "localhost",
      getValidator: () => undefined,
      getParserDialect: () => undefined,
      getForbiddenPatterns: () => [],
      healthCheck: async () => ({ status: "healthy" as const, latencyMs: 0, checkedAt: new Date() }),
      drain: async () => ({ drained: true, message: "ok" }),
      drainOrg: async () => ({ drained: 0 }),
      warmup: async () => {},
      recordQuery: () => {},
      recordError: () => {},
      recordSuccess: () => {},
      getPoolMetrics: () => ({ connectionId: "default", dbType: "postgres", pool: null, totalQueries: 0, totalErrors: 0, avgQueryTimeMs: 0, consecutiveFailures: 0, lastDrainAt: null }),
      getAllPoolMetrics: () => [],
      getOrgPoolMetrics: () => [],
      setOrgPoolConfig: () => {},
      isOrgPoolingEnabled: () => false,
      getOrgPoolConfig: () => ({ enabled: false, maxConnections: 5, idleTimeoutMs: 30000, maxOrgs: 50, warmupProbes: 2, drainThreshold: 5 }),
      getPoolWarnings: () => [],
      listOrgs: () => [],
      listOrgConnections: () => [],
      hasOrgPool: () => false,
      setMaxTotalConnections: () => {},
      shutdown: async () => {},
      _reset: () => {},
    };
    expect(shape).toBeDefined();
  });

  it("overrides work with all service methods", async () => {
    const drainResult = { drained: true, message: "Pool drained and recreated" };
    const TestLayer = createTestLayer({
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
      }).pipe(Effect.provide(TestLayer)),
    );

    expect(result.drain).toEqual(drainResult);
    expect(result.metrics.totalQueries).toBe(100);
    expect(result.metrics.pool?.activeCount).toBe(3);
  });

  it("org-scoped operations work through layer", async () => {
    const TestLayer = createTestLayer({
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
      }).pipe(Effect.provide(TestLayer)),
    );

    expect(result.orgs).toEqual(["org-1", "org-2"]);
    expect(result.hasPool).toBe(true);
  });

  it("one layer instance serves multiple independent programs", async () => {
    // Two programs run concurrently against the SAME layer value: a factory
    // that captured per-run state would surface here and nowhere else.
    const connLayer = createTestLayer({
      get: () => mockConn,
      getDefault: () => mockConn,
      list: () => ["default"],
    });

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
    expect(queryResult.rows).toEqual([{ id: 1 }]);
  });
});
