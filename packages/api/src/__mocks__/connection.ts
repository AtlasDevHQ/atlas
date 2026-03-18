/**
 * Shared mock factory for `@atlas/api/lib/db/connection`.
 *
 * 36+ test files independently mock this module. This factory centralises
 * the default shape so that ConnectionRegistry API changes only need
 * updating here. Tests that need custom behaviour (e.g. mockHealthCheck,
 * mockGetOrgPoolMetrics) pass overrides to `createConnectionMock()`.
 *
 * Usage:
 *   import { createConnectionMock } from "@atlas/api/src/__mocks__/connection";
 *   mock.module("@atlas/api/lib/db/connection", () => createConnectionMock());
 *
 * With overrides:
 *   mock.module("@atlas/api/lib/db/connection", () =>
 *     createConnectionMock({
 *       connections: { healthCheck: myMockFn },
 *       resolveDatasourceUrl: () => "postgresql://...",
 *     }),
 *   );
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

  return {
    getDB: getDBOverride ?? (() => dbConn),
    connections: {
      get: () => dbConn,
      getDefault: () => dbConn,
      getDBType: () => "postgres" as const,
      getTargetHost: () => "localhost",
      getValidator: () => undefined,
      getParserDialect: () => undefined,
      getForbiddenPatterns: () => [] as string[],
      list: () => ["default"],
      has: () => true,
      isOrgPoolingEnabled: () => false,
      getForOrg: () => dbConn,
      recordQuery: () => {},
      recordSuccess: () => {},
      recordError: () => {},
      ...connectionsOverrides,
    },
    detectDBType: () => "postgres" as const,
    extractTargetHost: () => "localhost",
    ConnectionRegistry: class {},
    ConnectionNotRegisteredError: class extends Error {
      constructor(id: string) {
        super(`Connection "${id}" is not registered.`);
        this.name = "ConnectionNotRegisteredError";
      }
    },
    NoDatasourceConfiguredError: class extends Error {
      constructor() {
        super("No analytics datasource configured.");
        this.name = "NoDatasourceConfiguredError";
      }
    },
    PoolCapacityExceededError: class extends Error {
      constructor(current: number, requested: number, max: number) {
        super(
          `Cannot create org pool: would use ${current + requested} connection slots, exceeding maxTotalConnections (${max}).`,
        );
        this.name = "PoolCapacityExceededError";
      }
    },
    ...topLevelOverrides,
  };
}
