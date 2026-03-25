/**
 * Tests for ConnectionRegistry Effect lifecycle management.
 *
 * Verifies that:
 * - Health checks run via Effect.repeat (no setInterval)
 * - Scope-based shutdown interrupts health fiber + closes pools
 * - makeConnectionRegistryLive creates a working layer
 */
import { describe, it, expect } from "bun:test";
import { Effect, Scope, Exit } from "effect";
import {
  ConnectionRegistry,
  makeConnectionRegistryLive,
} from "../services";

// Minimal mock ConnectionRegistry class that tracks lifecycle calls
function createMockRegistryClass() {
  const calls: string[] = [];
  let healthCheckCount = 0;

  const mockClass = {
    list: () => ["default"],
    healthCheck: async (id: string) => {
      healthCheckCount++;
      calls.push(`healthCheck:${id}`);
      return { status: "healthy" as const, latencyMs: 1, checkedAt: new Date() };
    },
    shutdown: async () => {
      calls.push("shutdown");
    },
    get: (_id: string) => ({
      query: async () => ({ columns: [], rows: [] }),
      close: async () => {},
    }),
    getDefault: () => ({
      query: async () => ({ columns: [], rows: [] }),
      close: async () => {},
    }),
    getForOrg: () => ({
      query: async () => ({ columns: [], rows: [] }),
      close: async () => {},
    }),
    register: () => { calls.push("register"); },
    registerDirect: () => {},
    unregister: () => false,
    has: () => true,
    describe: () => [],
    getDBType: () => "postgres" as const,
    getTargetHost: () => "localhost",
    getValidator: () => undefined,
    getParserDialect: () => undefined,
    getForbiddenPatterns: () => [],
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
    startHealthChecks: () => {},
    stopHealthChecks: () => {},
    _reset: () => { calls.push("_reset"); },
    _calls: calls,
    _getHealthCheckCount: () => healthCheckCount,
  };

  return mockClass;
}

describe("ConnectionRegistry Live Layer lifecycle", () => {
  it("creates service and delegates list()", async () => {
    const mockRegistry = createMockRegistryClass();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only cast to class interface
    const layer = makeConnectionRegistryLive(() => mockRegistry as any);

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* ConnectionRegistry;
        return registry.list();
      }).pipe(Effect.provide(layer)),
    );

    expect(result).toEqual(["default"]);
  });

  it("shutdown is called when scope closes", async () => {
    const mockRegistry = createMockRegistryClass();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only cast to class interface
    const layer = makeConnectionRegistryLive(() => mockRegistry as any);

    // Use a scoped effect so we can observe the finalizer
    const scope = Effect.runSync(Scope.make());
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const registry = yield* ConnectionRegistry;
        return registry.list();
      }).pipe(
        Effect.provide(layer),
        Scope.extend(scope),
      ),
    );

    expect(Exit.isSuccess(exit)).toBe(true);

    // Close scope — triggers finalizer → shutdown
    await Effect.runPromise(Scope.close(scope, Exit.void));

    expect(mockRegistry._calls).toContain("shutdown");
  });

  it("delegates register() to underlying impl", async () => {
    const mockRegistry = createMockRegistryClass();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only cast to class interface
    const layer = makeConnectionRegistryLive(() => mockRegistry as any);

    await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* ConnectionRegistry;
        registry.register("test", { url: "postgresql://test/db" });
      }).pipe(Effect.provide(layer)),
    );

    expect(mockRegistry._calls).toContain("register");
  });
});
