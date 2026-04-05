/**
 * Shared mock factory for `@atlas/api/lib/db/connection`.
 *
 * 36+ test files independently mock this module. This factory centralises
 * the default shape so that ConnectionRegistry API changes only need
 * updating here. Tests that need custom behaviour (e.g. mockHealthCheck,
 * mockGetOrgPoolMetrics) pass overrides to `createConnectionMock()`.
 *
 * Usage (mock.module — legacy):
 *   import { createConnectionMock } from "@atlas/api/src/__mocks__/connection";
 *   mock.module("@atlas/api/lib/db/connection", () => createConnectionMock());
 *
 * Usage (Effect Layer — preferred for new tests):
 *   import { createConnectionTestLayer } from "@atlas/api/src/__mocks__/connection";
 *   const TestLayer = createConnectionTestLayer({ get: () => mockConn });
 *   const result = await Effect.runPromise(program.pipe(Effect.provide(TestLayer)));
 *
 * @module
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- intentionally generic mock function type for test overrides
type AnyFn = (...args: any[]) => any;

/** Shape of the `connections` object on the mock. */
export interface ConnectionsOverrides {
  get?: AnyFn;
  getDefault?: AnyFn;
  getDBType?: AnyFn;
  getTargetHost?: AnyFn;
  getValidator?: AnyFn;
  getParserDialect?: AnyFn;
  getForbiddenPatterns?: AnyFn;
  list?: AnyFn;
  describe?: AnyFn;
  has?: AnyFn;
  _reset?: AnyFn;
  healthCheck?: AnyFn;
  register?: AnyFn;
  unregister?: AnyFn;
  recordQuery?: AnyFn;
  recordError?: AnyFn;
  recordSuccess?: AnyFn;
  isOrgPoolingEnabled?: AnyFn;
  getForOrg?: AnyFn;
  getOrgPoolMetrics?: AnyFn;
  getOrgPoolConfig?: AnyFn;
  listOrgs?: AnyFn;
  drainOrg?: AnyFn;
  [key: string]: unknown;
}

export interface ConnectionMockOverrides {
  /** Override individual methods on `connections`. */
  connections?: ConnectionsOverrides;
  /** Override `getDB` return value or function. */
  getDB?: AnyFn;
  /** Any additional top-level exports to add/override. */
  [key: string]: unknown;
}

/**
 * Returns a fresh mock object compatible with
 * `mock.module("@atlas/api/lib/db/connection", () => ...)`.
 *
 * Each call creates new objects so tests don't leak state.
 */
export function createConnectionMock(overrides?: ConnectionMockOverrides) {
  const mockDBConnection = {
    query: async () => ({ columns: [] as string[], rows: [] as Record<string, unknown>[] }),
    close: async () => {},
  };

  const {
    connections: connectionsOverrides,
    getDB: getDBOverride,
    ...topLevelOverrides
  } = overrides ?? {};

  const dbConn = getDBOverride ? undefined : mockDBConnection;

  const connections = {
    get: () => dbConn,
    getDefault: () => dbConn,
    getDBType: () => "postgres" as const,
    getTargetHost: () => "localhost",
    getValidator: () => undefined,
    getParserDialect: () => undefined,
    getForbiddenPatterns: () => [] as RegExp[],
    list: () => ["default"],
    has: () => true,
    isOrgPoolingEnabled: () => false,
    getForOrg: () => dbConn,
    recordQuery: () => {},
    recordSuccess: () => {},
    recordError: () => {},
    ...connectionsOverrides,
  };

  return {
    getDB: getDBOverride ?? (() => dbConn),
    connections,
    // getRegionAwareConnection delegates to connections.getForOrg so tests
    // that mock getForOrg still see their mock called through the async path.
    getRegionAwareConnection: async (orgId: string, connId?: string) => ({
      db: connections.getForOrg(orgId, connId ?? "default"),
      resolvedConnId: connId ?? "default",
    }),
    resolveDatasourceUrl: () => process.env.ATLAS_DATASOURCE_URL || undefined,
    detectDBType: () => "postgres" as const,
    extractTargetHost: () => "localhost",
    ConnectionRegistry: class {},
    ConnectionNotRegisteredError: class extends Error {
      readonly id: string;
      readonly _tag = "ConnectionNotRegisteredError";
      constructor(args: { message: string; id: string }) {
        super(args.message);
        this.name = "ConnectionNotRegisteredError";
        this.id = args.id;
      }
    },
    NoDatasourceConfiguredError: class extends Error {
      readonly _tag = "NoDatasourceConfiguredError";
      constructor(args: { message: string }) {
        super(args.message);
        this.name = "NoDatasourceConfiguredError";
      }
    },
    PoolCapacityExceededError: class extends Error {
      readonly currentSlots: number;
      readonly requestedSlots: number;
      readonly maxTotalConnections: number;
      readonly _tag = "PoolCapacityExceededError";
      constructor(args: { message: string; currentSlots: number; requestedSlots: number; maxTotalConnections: number }) {
        super(args.message);
        this.name = "PoolCapacityExceededError";
        this.currentSlots = args.currentSlots;
        this.requestedSlots = args.requestedSlots;
        this.maxTotalConnections = args.maxTotalConnections;
      }
    },
    ...topLevelOverrides,
  };
}

// ── Effect Layer helper ─────────────────────────────────────────────

/**
 * Create a test Layer for the ConnectionRegistry Effect service.
 *
 * Provides a ConnectionRegistryShape backed by stub methods.
 * Unspecified methods throw with a descriptive error so tests fail
 * loudly when touching unexpected service methods.
 *
 * @example
 * ```ts
 * import { createConnectionTestLayer } from "@atlas/api/src/__mocks__/connection";
 * import { ConnectionRegistry } from "@atlas/api/lib/effect/services";
 *
 * const TestLayer = createConnectionTestLayer({
 *   get: () => mockConn,
 *   list: () => ["default"],
 * });
 *
 * const result = await Effect.runPromise(
 *   Effect.gen(function* () {
 *     const registry = yield* ConnectionRegistry;
 *     return registry.list();
 *   }).pipe(Effect.provide(TestLayer)),
 * );
 * ```
 */
export function createConnectionTestLayer(
  overrides?: ConnectionsOverrides & { [key: string]: unknown },
) {
  // Lazy import to avoid pulling Effect into every test that uses createConnectionMock
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createTestLayer } = require("@atlas/api/lib/effect/services") as typeof import("@atlas/api/lib/effect/services");
  const mockDBConnection = {
    query: async () => ({ columns: [] as string[], rows: [] as Record<string, unknown>[] }),
    close: async () => {},
  };
  return createTestLayer({
    get: () => mockDBConnection,
    getDefault: () => mockDBConnection,
    getForOrg: () => mockDBConnection,
    register: () => {},
    registerDirect: () => {},
    unregister: () => false,
    has: () => true,
    list: () => ["default"],
    describe: () => [],
    getDBType: () => "postgres" as const,
    getTargetHost: () => "localhost",
    getValidator: () => undefined,
    getParserDialect: () => undefined,
    getForbiddenPatterns: () => [],
    healthCheck: async () => ({ status: "healthy" as const, latencyMs: 1, checkedAt: new Date() }),
    drain: async () => ({ drained: true, message: "test" }),
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
    ...overrides,
  });
}
