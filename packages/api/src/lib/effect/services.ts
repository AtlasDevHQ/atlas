/**
 * Effect Services for Atlas.
 *
 * Defines Context.Tag services that replace global singletons with
 * dependency-injected, scope-managed resources.
 *
 * ConnectionRegistry service (P4):
 * - Pool lifecycle via Effect.acquireRelease
 * - Health checks via Effect.repeat + Schedule.spaced (no setInterval)
 * - Drain cooldown managed by ConnectionRegistry class via Set + Effect.sleep
 * - Graceful shutdown via Effect.Scope (no manual ordering)
 */

import { Context, Effect, Layer, Duration, Schedule, Fiber } from "effect";
import type {
  ConnectionRegistry as ConnectionRegistryClass,
  DBConnection,
  DBType,
  ConnectionConfig,
  ConnectionMetadata,
  HealthCheckResult,
  ConnectionPluginMeta,
  OrgPoolSettings,
} from "@atlas/api/lib/db/connection";
import type { PoolMetrics, OrgPoolMetrics } from "@useatlas/types";
import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("effect:connection");

// ── Service interface ────────────────────────────────────────────────

/** Typed contract for the ConnectionRegistry Effect service. */
export interface ConnectionRegistryShape {
  // --- Query operations ---
  get(id: string): DBConnection;
  getDefault(): DBConnection;
  getForOrg(orgId: string, connectionId?: string): DBConnection;

  // --- Registration ---
  register(id: string, config: ConnectionConfig): void;
  registerDirect(
    id: string,
    conn: DBConnection,
    dbType: DBType,
    description?: string,
    validate?: (query: string) => { valid: boolean; reason?: string } | Promise<{ valid: boolean; reason?: string }>,
    meta?: ConnectionPluginMeta,
  ): void;
  unregister(id: string): boolean;
  has(id: string): boolean;

  // --- Metadata ---
  list(): string[];
  describe(): ConnectionMetadata[];
  getDBType(id: string): DBType;
  getTargetHost(id: string): string;
  getValidator(id: string): ((query: string) => { valid: boolean; reason?: string } | Promise<{ valid: boolean; reason?: string }>) | undefined;
  getParserDialect(id: string): string | undefined;
  getForbiddenPatterns(id: string): RegExp[];

  // --- Health ---
  healthCheck(id: string): Promise<HealthCheckResult>;

  // --- Pool management ---
  drain(id: string): Promise<{ drained: boolean; message: string }>;
  drainOrg(orgId: string): Promise<{ drained: number }>;
  warmup(count?: number): Promise<void>;

  // --- Metrics ---
  recordQuery(id: string, durationMs: number, orgId?: string): void;
  recordError(id: string, orgId?: string): void;
  recordSuccess(id: string, orgId?: string): void;
  getPoolMetrics(id: string): PoolMetrics;
  getAllPoolMetrics(): PoolMetrics[];
  getOrgPoolMetrics(orgId?: string): OrgPoolMetrics[];

  // --- Org pool config ---
  setOrgPoolConfig(config: Partial<Omit<OrgPoolSettings, "enabled">>): void;
  isOrgPoolingEnabled(): boolean;
  getOrgPoolConfig(): Readonly<OrgPoolSettings>;
  getPoolWarnings(): string[];
  listOrgs(): string[];
  listOrgConnections(orgId: string): string[];
  hasOrgPool(orgId: string, connectionId?: string): boolean;

  // --- Config ---
  setMaxTotalConnections(n: number): void;

  // --- Lifecycle (managed by Effect scope — callers should not call directly) ---
  shutdown(): Promise<void>;
  _reset(): void;
}

// ── Context.Tag ──────────────────────────────────────────────────────

export class ConnectionRegistry extends Context.Tag("ConnectionRegistry")<
  ConnectionRegistry,
  ConnectionRegistryShape
>() {}

const HEALTH_CHECK_INTERVAL_MS = 60_000;

// ── Live Layer ───────────────────────────────────────────────────────

/**
 * Create the Live layer for ConnectionRegistry.
 *
 * Wraps a ConnectionRegistryClass instance with Effect-managed lifecycle:
 * - Health checks: Effect.repeat + Schedule.spaced (replaces setInterval)
 * - Drain cooldown: Effect.Ref<Set<string>> + Effect.sleep (replaces Date.now)
 * - Shutdown: Effect.addFinalizer (replaces manual ordering)
 *
 * @param createImpl - Factory for the underlying registry instance.
 *   Defaults to creating a new ConnectionRegistryClass from the connection module.
 */
export function makeConnectionRegistryLive(
  createImpl?: () => ConnectionRegistryClass,
): Layer.Layer<ConnectionRegistry> {
  return Layer.scoped(
    ConnectionRegistry,
    Effect.gen(function* () {
      // Create underlying registry (lazy import to avoid circular deps)
      const impl = createImpl
        ? createImpl()
        : yield* Effect.sync(() => {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const mod = require("@atlas/api/lib/db/connection");
            return new mod.ConnectionRegistry() as ConnectionRegistryClass;
          });

      // --- Health check fiber ---
      const healthCheckAll = Effect.gen(function* () {
        const ids = impl.list();
        yield* Effect.forEach(
          ids,
          (id) =>
            Effect.tryPromise({
              try: () => impl.healthCheck(id),
              catch: (err) =>
                err instanceof Error ? err.message : String(err),
            }).pipe(
              Effect.catchAll((errMsg) => {
                log.warn({ connectionId: id, err: errMsg }, "Periodic health check failed");
                return Effect.void;
              }),
            ),
          { concurrency: "unbounded" },
        );
      });

      const healthFiber = yield* Effect.fork(
        healthCheckAll.pipe(
          // Catch expected failures but let defects (programming errors) crash the fiber.
          // The inner forEach already catches individual health check failures, so this
          // outer handler is a safety net for unexpected errors in the cycle itself.
          Effect.catchAllCause((cause) => {
            const msg = cause.toString();
            log.warn({ err: msg }, "Health check cycle failed");
            return Effect.void;
          }),
          Effect.repeat(Schedule.spaced(Duration.millis(HEALTH_CHECK_INTERVAL_MS))),
          Effect.asVoid,
        ),
      );

      // --- Scope finalizer for graceful shutdown ---
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          yield* Fiber.interrupt(healthFiber);
          yield* Effect.promise(() => impl.shutdown());
          log.info("ConnectionRegistry shut down via Effect scope");
        }),
      );

      // --- Build service interface ---
      const service: ConnectionRegistryShape = {
        // Query operations — delegate directly
        get: (id) => impl.get(id),
        getDefault: () => impl.getDefault(),
        getForOrg: (orgId, connectionId) => impl.getForOrg(orgId, connectionId),

        // Registration
        register: (id, config) => impl.register(id, config),
        registerDirect: (id, conn, dbType, description, validate, meta) =>
          impl.registerDirect(id, conn, dbType, description, validate, meta),
        unregister: (id) => impl.unregister(id),
        has: (id) => impl.has(id),

        // Metadata
        list: () => impl.list(),
        describe: () => impl.describe(),
        getDBType: (id) => impl.getDBType(id),
        getTargetHost: (id) => impl.getTargetHost(id),
        getValidator: (id) => impl.getValidator(id),
        getParserDialect: (id) => impl.getParserDialect(id),
        getForbiddenPatterns: (id) => impl.getForbiddenPatterns(id),

        // Health — managed by the fiber, but expose direct access too
        healthCheck: (id) => impl.healthCheck(id),

        // Pool management — drain cooldown is managed by the impl via Set + Effect.sleep
        drain: (id) => impl.drain(id),
        drainOrg: (orgId) => impl.drainOrg(orgId),
        warmup: (count) => impl.warmup(count),

        // Metrics
        recordQuery: (id, durationMs, orgId) => impl.recordQuery(id, durationMs, orgId),
        recordError: (id, orgId) => impl.recordError(id, orgId),
        recordSuccess: (id, orgId) => impl.recordSuccess(id, orgId),
        getPoolMetrics: (id) => impl.getPoolMetrics(id),
        getAllPoolMetrics: () => impl.getAllPoolMetrics(),
        getOrgPoolMetrics: (orgId) => impl.getOrgPoolMetrics(orgId),

        // Org pool config
        setOrgPoolConfig: (config) => impl.setOrgPoolConfig(config),
        isOrgPoolingEnabled: () => impl.isOrgPoolingEnabled(),
        getOrgPoolConfig: () => impl.getOrgPoolConfig(),
        getPoolWarnings: () => impl.getPoolWarnings(),
        listOrgs: () => impl.listOrgs(),
        listOrgConnections: (orgId) => impl.listOrgConnections(orgId),
        hasOrgPool: (orgId, connectionId) => impl.hasOrgPool(orgId, connectionId),

        // Config
        setMaxTotalConnections: (n) => impl.setMaxTotalConnections(n),

        // Lifecycle — exposed but managed by scope
        shutdown: () => impl.shutdown(),
        _reset: () => impl._reset(),
      };

      return service;
    }),
  );
}

/** Default Live layer using the global ConnectionRegistry constructor. */
export const ConnectionRegistryLive: Layer.Layer<ConnectionRegistry> =
  makeConnectionRegistryLive();

// ── Test helper ──────────────────────────────────────────────────────

/**
 * Create a test Layer from a partial service implementation.
 *
 * Provides a ConnectionRegistry service backed by stub methods.
 * Unspecified methods throw with a descriptive error.
 *
 * @example
 * ```ts
 * const TestLayer = createTestLayer({
 *   get: () => mockConn,
 *   getDefault: () => mockConn,
 *   list: () => ["default"],
 * });
 * const result = await Effect.runPromise(
 *   program.pipe(Effect.provide(TestLayer))
 * );
 * ```
 */
export function createTestLayer(
  partial: Partial<ConnectionRegistryShape>,
): Layer.Layer<ConnectionRegistry> {
  const handler: ProxyHandler<ConnectionRegistryShape> = {
    get(_target, prop: string | symbol) {
      // Ignore symbols (Symbol.toPrimitive, Symbol.toStringTag, etc.) and
      // well-known properties that runtimes/libraries probe for (then, toJSON)
      if (typeof prop === "symbol") return undefined;
      if (prop === "then" || prop === "toJSON") return undefined;
      if (prop in partial) {
        return (partial as Record<string, unknown>)[prop];
      }
      return (..._args: unknown[]) => {
        throw new Error(
          `ConnectionRegistry test stub: "${prop}" was called but not provided in createTestLayer()`,
        );
      };
    },
  };

  const stubService = new Proxy({} as ConnectionRegistryShape, handler);
  return Layer.succeed(ConnectionRegistry, stubService);
}
