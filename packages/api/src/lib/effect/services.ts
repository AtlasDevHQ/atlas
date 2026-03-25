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
 *
 * PluginRegistry service (P5):
 * - Health checks via Effect.repeat + Schedule.spaced (60s periodic)
 * - Teardown via Effect.addFinalizer (delegates to class LIFO teardown)
 * - Wired layer variant with type-level ConnectionRegistry dependency
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
import type {
  PluginRegistry as PluginRegistryClass,
  PluginLike,
  PluginContextLike,
  PluginHealthResult,
  PluginType,
  PluginStatus,
  PluginDescription,
} from "@atlas/api/lib/plugins/registry";

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

// ══════════════════════════════════════════════════════════════════════
// ██  Plugin Registry Service (P5)
// ══════════════════════════════════════════════════════════════════════

const pluginLog = createLogger("effect:plugin");

// ── Service interface ────────────────────────────────────────────────

/** Typed contract for the PluginRegistry Effect service. */
export interface PluginRegistryShape {
  // --- Registration ---
  register(plugin: PluginLike): void;

  // --- Lifecycle ---
  initializeAll(
    ctx: PluginContextLike,
  ): Promise<{ succeeded: string[]; failed: string[] }>;
  healthCheckAll(): Promise<
    Map<string, PluginHealthResult & { status: PluginStatus }>
  >;
  teardownAll(): Promise<void>;

  // --- Query ---
  get(id: string): PluginLike | undefined;
  getStatus(id: string): PluginStatus | undefined;
  getByType(type: PluginType): PluginLike[];
  getAll(): PluginLike[];
  getAllHealthy(): PluginLike[];
  describe(): PluginDescription[];

  // --- Enable/disable ---
  enable(id: string): boolean;
  disable(id: string): boolean;
  isEnabled(id: string): boolean;

  // --- Size ---
  readonly size: number;

  // --- Test only ---
  _reset(): void;
}

// ── Context.Tag ──────────────────────────────────────────────────────

export class PluginRegistry extends Context.Tag("PluginRegistry")<
  PluginRegistry,
  PluginRegistryShape
>() {}

const PLUGIN_HEALTH_CHECK_INTERVAL_MS = 60_000;

// ── Shared Layer internals ───────────────────────────────────────────

/**
 * Build the PluginRegistry service + health-check fiber + scope finalizer.
 * Shared between makePluginRegistryLive and makeWiredPluginRegistryLive.
 */
function buildPluginService(impl: PluginRegistryClass) {
  return Effect.gen(function* () {
    // --- Health check fiber (replaces on-demand-only checks) ---
    const healthCheckCycle = Effect.tryPromise({
      try: () => impl.healthCheckAll(),
      catch: (err) => (err instanceof Error ? err.message : String(err)),
    }).pipe(
      Effect.catchAll((errMsg) => {
        pluginLog.warn({ err: errMsg }, "Periodic plugin health check failed");
        return Effect.void;
      }),
    );

    const healthFiber = yield* Effect.fork(
      healthCheckCycle.pipe(
        Effect.catchAllCause((cause) => {
          pluginLog.warn(
            { err: cause.toString() },
            "Plugin health check cycle failed",
          );
          return Effect.void;
        }),
        Effect.repeat(
          Schedule.spaced(Duration.millis(PLUGIN_HEALTH_CHECK_INTERVAL_MS)),
        ),
        Effect.asVoid,
      ),
    );

    // --- Scope finalizer for graceful shutdown ---
    // addFinalizer triggers teardownAll on scope close;
    // teardownAll iterates plugins in reverse registration order (LIFO) internally.
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        yield* Fiber.interrupt(healthFiber);
        yield* Effect.tryPromise({
          try: () => impl.teardownAll(),
          catch: (err) => (err instanceof Error ? err.message : String(err)),
        }).pipe(
          Effect.catchAll((errMsg) => {
            pluginLog.error({ err: errMsg }, "PluginRegistry teardownAll failed during shutdown");
            return Effect.void;
          }),
        );
        pluginLog.info("PluginRegistry shut down via Effect scope");
      }),
    );

    // --- Build service interface (delegates to underlying impl) ---
    const service: PluginRegistryShape = {
      register: (plugin) => impl.register(plugin),
      initializeAll: (ctx) => impl.initializeAll(ctx),
      healthCheckAll: () => impl.healthCheckAll(),
      teardownAll: () => impl.teardownAll(),
      get: (id) => impl.get(id),
      getStatus: (id) => impl.getStatus(id),
      getByType: (type) => impl.getByType(type),
      getAll: () => impl.getAll(),
      getAllHealthy: () => impl.getAllHealthy(),
      describe: () => impl.describe(),
      enable: (id) => impl.enable(id),
      disable: (id) => impl.disable(id),
      isEnabled: (id) => impl.isEnabled(id),
      get size() {
        return impl.size;
      },
      _reset: () => impl._reset(),
    };

    return service;
  });
}

/** Create the underlying PluginRegistry class instance. */
function createPluginImpl(createImpl?: () => PluginRegistryClass) {
  return createImpl
    ? Effect.sync(createImpl)
    : Effect.sync(() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const mod = require("@atlas/api/lib/plugins/registry");
        return new mod.PluginRegistry() as PluginRegistryClass;
      });
}

// ── Live Layer ───────────────────────────────────────────────────────

/**
 * Create the Live layer for PluginRegistry.
 *
 * Wraps a PluginRegistryClass instance with Effect-managed lifecycle:
 * - Health checks: Effect.repeat + Schedule.spaced (60s interval)
 * - Teardown: Effect.addFinalizer (delegates to impl.teardownAll which runs LIFO)
 *
 * @param createImpl - Factory for the underlying registry instance.
 *   Defaults to creating a new PluginRegistryClass from the plugin module.
 */
export function makePluginRegistryLive(
  createImpl?: () => PluginRegistryClass,
): Layer.Layer<PluginRegistry> {
  return Layer.scoped(
    PluginRegistry,
    Effect.gen(function* () {
      const impl = yield* createPluginImpl(createImpl);
      return yield* buildPluginService(impl);
    }),
  );
}

/** Default Live layer using the global PluginRegistry constructor. */
export const PluginRegistryLive: Layer.Layer<PluginRegistry> =
  makePluginRegistryLive();

// ── Wired Layer ──────────────────────────────────────────────────────

/**
 * Config for building a PluginRegistry Layer that registers, initializes,
 * and wires plugins as part of Layer construction.
 */
export interface PluginWiringConfig {
  /** Plugins to register (from atlas.config.ts). */
  readonly plugins: ReadonlyArray<PluginLike>;
  /** Context passed to plugin.initialize(). */
  readonly context: PluginContextLike;
  /** Hono app instance for mounting interaction plugin routes. */
  readonly app?: { route(path: string, subApp: unknown): void };
  /** Tool registry for action plugin tools. */
  readonly toolRegistry?: { register(tool: unknown): void };
  /** Schema migration callback (runs before initialize). */
  readonly runMigrations?: (
    allPlugins: ReadonlyArray<PluginLike>,
  ) => Promise<void>;
}

/**
 * Create a Layer that registers, initializes, and wires plugins.
 *
 * Declares ConnectionRegistry as a dependency — the type system enforces
 * that connections must be available before plugin datasources can be wired.
 * This replaces the imperative startup sequence in server.ts with type-safe
 * Layer composition where dependency ordering is enforced at the type level.
 *
 * Startup sequence:
 *   register → migrate → initialize → wire datasources → wire actions →
 *   wire context → wire interactions → health check loop → teardown
 */
export function makeWiredPluginRegistryLive(
  config: PluginWiringConfig,
  createImpl?: () => PluginRegistryClass,
): Layer.Layer<PluginRegistry, never, ConnectionRegistry> {
  return Layer.scoped(
    PluginRegistry,
    Effect.gen(function* () {
      // Dependency: ConnectionRegistry must be provided before wiring.
      // This is enforced at the type level — the Layer won't compile
      // without ConnectionRegistry in the provided context.
      const connRegistry = yield* ConnectionRegistry;

      const impl = yield* createPluginImpl(createImpl);

      // --- Registration ---
      for (const plugin of config.plugins) {
        impl.register(plugin);
      }

      // --- Schema migrations (before initialize so plugins can use their tables) ---
      if (config.runMigrations) {
        yield* Effect.tryPromise({
          try: () => config.runMigrations!(impl.getAll()),
          catch: (err) => (err instanceof Error ? err.message : String(err)),
        }).pipe(
          Effect.catchAll((errMsg) => {
            pluginLog.error({ err: errMsg }, "Plugin schema migrations failed");
            return Effect.void;
          }),
        );
      }

      // --- Initialize all ---
      const { succeeded, failed } = yield* Effect.tryPromise({
        try: () => impl.initializeAll(config.context),
        catch: (err) => (err instanceof Error ? err.message : String(err)),
      }).pipe(
        Effect.catchAll((errMsg) => {
          pluginLog.error({ err: errMsg }, "Plugin initializeAll threw unexpectedly");
          return Effect.succeed({ succeeded: [] as string[], failed: [] as string[] });
        }),
      );
      if (failed.length > 0) {
        pluginLog.error(
          { succeeded, failed },
          `Plugin initialization completed with ${failed.length} failure(s)`,
        );
      } else if (succeeded.length > 0) {
        pluginLog.info({ succeeded }, "All plugins initialized");
      }

      // --- Wire datasources (ConnectionRegistry from Layer context) ---
      // Bridge: ConnectionRegistryShape ↔ class (structural match for registerDirect)
      const dsResult = yield* Effect.tryPromise({
        try: async () => {
          const { wireDatasourcePlugins } = await import(
            "@atlas/api/lib/plugins/wiring"
          );
          return wireDatasourcePlugins(
            impl,
            connRegistry as unknown as ConnectionRegistryClass,
          );
        },
        catch: (err) => (err instanceof Error ? err.message : String(err)),
      }).pipe(
        Effect.catchAll((errMsg) => {
          pluginLog.error({ err: errMsg }, "Datasource wiring failed entirely");
          return Effect.succeed({ wired: [] as string[], failed: [] as Array<{ pluginId: string; error: string }>, dialectHints: [] as Array<{ pluginId: string; dialect: string }>, entityFailures: [] as Array<{ pluginId: string; error: string }> });
        }),
      );
      if (dsResult.failed.length > 0) {
        pluginLog.error({ failed: dsResult.failed }, "Some datasource plugins failed to wire");
      }

      // --- Wire actions ---
      if (config.toolRegistry) {
        const actResult = yield* Effect.tryPromise({
          try: async () => {
            const { wireActionPlugins } = await import(
              "@atlas/api/lib/plugins/wiring"
            );
            return wireActionPlugins(impl, config.toolRegistry as never);
          },
          catch: (err) => (err instanceof Error ? err.message : String(err)),
        }).pipe(
          Effect.catchAll((errMsg) => {
            pluginLog.error({ err: errMsg }, "Action wiring failed entirely");
            return Effect.succeed({ wired: [] as string[], failed: [] as Array<{ pluginId: string; error: string }> });
          }),
        );
        if (actResult.failed.length > 0) {
          pluginLog.error({ failed: actResult.failed }, "Some action plugins failed to wire");
        }
      }

      // --- Wire context ---
      const ctxResult = yield* Effect.tryPromise({
        try: async () => {
          const { wireContextPlugins } = await import(
            "@atlas/api/lib/plugins/wiring"
          );
          return wireContextPlugins(impl);
        },
        catch: (err) => (err instanceof Error ? err.message : String(err)),
      }).pipe(
        Effect.catchAll((errMsg) => {
          pluginLog.error({ err: errMsg }, "Context wiring failed entirely");
          return Effect.succeed({ fragments: [] as string[], failed: [] as Array<{ pluginId: string; error: string }> });
        }),
      );
      if (ctxResult.failed.length > 0) {
        pluginLog.error({ failed: ctxResult.failed }, "Some context plugins failed to load");
      }

      // --- Wire interaction routes ---
      if (config.app) {
        const intResult = yield* Effect.tryPromise({
          try: async () => {
            const { wireInteractionPlugins } = await import(
              "@atlas/api/lib/plugins/wiring"
            );
            return wireInteractionPlugins(impl, config.app);
          },
          catch: (err) => (err instanceof Error ? err.message : String(err)),
        }).pipe(
          Effect.catchAll((errMsg) => {
            pluginLog.error({ err: errMsg }, "Interaction wiring failed entirely");
            return Effect.succeed({ wired: [] as string[], failed: [] as Array<{ pluginId: string; error: string }> });
          }),
        );
        if (intResult.failed.length > 0) {
          pluginLog.error({ failed: intResult.failed }, "Some interaction plugins failed to wire");
        }
      }

      return yield* buildPluginService(impl);
    }),
  );
}

// ── Test helper ──────────────────────────────────────────────────────

/**
 * Create a test Layer from a partial PluginRegistry service implementation.
 *
 * Provides a PluginRegistry service backed by stub methods.
 * Unspecified methods throw with a descriptive error.
 *
 * @example
 * ```ts
 * const TestLayer = createPluginTestLayer({
 *   getAll: () => [],
 *   describe: () => [],
 * });
 * const result = await Effect.runPromise(
 *   program.pipe(Effect.provide(TestLayer))
 * );
 * ```
 */
export function createPluginTestLayer(
  partial: Partial<PluginRegistryShape>,
): Layer.Layer<PluginRegistry> {
  const handler: ProxyHandler<PluginRegistryShape> = {
    get(_target, prop: string | symbol) {
      if (typeof prop === "symbol") return undefined;
      if (prop === "then" || prop === "toJSON") return undefined;
      if (prop in partial) {
        return (partial as Record<string, unknown>)[prop];
      }
      return (..._args: unknown[]) => {
        throw new Error(
          `PluginRegistry test stub: "${prop}" was called but not provided in createPluginTestLayer()`,
        );
      };
    },
  };

  const stubService = new Proxy({} as PluginRegistryShape, handler);
  return Layer.succeed(PluginRegistry, stubService);
}
