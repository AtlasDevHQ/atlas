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

import { Context, Effect, Layer, Duration, Schedule } from "effect";
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

// ── Shared Noop-layer helper (#2594) ────────────────────────────────
//
// Every enterprise Noop layer that fails self-hosted methods with
// `EnterpriseError` previously open-coded the same 7-line block (lazy
// `require()` of the error class + a `notAvailable` factory closure).
// The lazy require is load-bearing — services.ts is reached early in
// the dep graph and an eager static import of `lib/effect/errors` has
// caused `mock.module()` ordering surprises (see
// feedback_bun_test_async_mock_module). This helper preserves the
// laziness, just dedups the boilerplate.
function makeNotAvailable(message: string): () => import("@atlas/api/lib/effect/errors").EnterpriseError {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EnterpriseError } = require("@atlas/api/lib/effect/errors") as {
    EnterpriseError: new (message?: string) => import("@atlas/api/lib/effect/errors").EnterpriseError;
  };
  return () => new EnterpriseError(message);
}

// ── Service interface ────────────────────────────────────────────────

/** Typed contract for the ConnectionRegistry Effect service. */
export interface ConnectionRegistryShape {
  // --- Query operations ---
  get(id: string): DBConnection;
  getDefault(): DBConnection;
  getForOrg(orgId: string, connectionId?: string, region?: string): DBConnection;

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
  hasOrgPool(orgId: string, connectionId?: string, region?: string): boolean;

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

      // Shutdown finalizer — registered BEFORE the forkScoped health
      // fiber below. Effect scope finalizers run LIFO; `forkScoped`
      // registers an implicit fiber-interrupt finalizer at its fork
      // point, so this ordering guarantees the health fiber is
      // interrupted (and `Fiber.interrupt` awaits cleanup completion)
      // BEFORE `impl.shutdown()` tears down pools. Registered the
      // other way around, the shutdown would race a concurrent health
      // cycle against pools being torn down (Codex P2 on #2864).
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          yield* Effect.promise(() => impl.shutdown());
          log.info("ConnectionRegistry shut down via Effect scope");
        }),
      );

      // forkScoped, not fork — the bare `fork` API links the child fiber
      // to the parent fiber's lifetime, and the parent here is this gen
      // which returns the service shape immediately. With `Effect.fork`
      // the periodic health-check never runs because the child is
      // interrupted at gen completion (verified by repro; diagnosed in
      // #2864 on the outbox flusher). forkScoped binds to the
      // Layer scope, so the fiber lives until layer shutdown.
      yield* Effect.forkScoped(
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

      // --- Build service interface ---
      const service: ConnectionRegistryShape = {
        // Query operations — delegate directly
        get: (id) => impl.get(id),
        getDefault: () => impl.getDefault(),
        getForOrg: (orgId, connectionId, region) => impl.getForOrg(orgId, connectionId, region),

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
        hasOrgPool: (orgId, connectionId, region) => impl.hasOrgPool(orgId, connectionId, region),

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

    // Teardown finalizer — registered BEFORE the forkScoped health
    // fiber below. Scope finalizers are LIFO; this ordering guarantees
    // the health fiber is interrupted (awaiting cleanup completion)
    // BEFORE `impl.teardownAll()` dismantles plugins. The reverse order
    // would let a concurrent health cycle mutate plugin statuses or
    // probe plugins mid-teardown (Codex P2 on #2864). `teardownAll`
    // iterates plugins LIFO internally, which is a separate concern.
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
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

    // forkScoped, not fork — see ConnectionRegistry's healthFiber for rationale.
    yield* Effect.forkScoped(
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

// ══════════════════════════════════════════════════════════════════════
// ██  Request Context Service (P8)
// ══════════════════════════════════════════════════════════════════════

type AtlasMode = import("@useatlas/types/auth").AtlasMode;

/**
 * Per-request context available to all Effect programs running within
 * a route handler. Bridges from Hono's `c.get("requestId")`.
 */
export interface RequestContextShape {
  readonly requestId: string;
  readonly startTime: number;
  /** Resolved mode — `developer` (shows draft/unpublished content, admin-only) or `published` (end-user surface). */
  readonly atlasMode: AtlasMode;
}

export class RequestContext extends Context.Tag("RequestContext")<
  RequestContext,
  RequestContextShape
>() {}

/**
 * Create a RequestContext Layer from concrete values.
 * Used by runHandler to bridge Hono context → Effect Context.
 */
export function makeRequestContextLayer(
  requestId: string,
  startTime?: number,
  atlasMode?: AtlasMode,
): Layer.Layer<RequestContext> {
  return Layer.succeed(RequestContext, {
    requestId,
    startTime: startTime ?? Date.now(),
    atlasMode: atlasMode ?? "published",
  });
}

/** Create a test Layer for RequestContext. */
export function createRequestContextTestLayer(
  partial: Partial<RequestContextShape> = {},
): Layer.Layer<RequestContext> {
  return Layer.succeed(RequestContext, {
    requestId: partial.requestId ?? "test-request-id",
    startTime: partial.startTime ?? Date.now(),
    atlasMode: partial.atlasMode ?? "published",
  });
}

// ══════════════════════════════════════════════════════════════════════
// ██  Auth Context Service (P8)
// ══════════════════════════════════════════════════════════════════════

type AtlasUser = import("@useatlas/types/auth").AtlasUser;
type AuthMode = import("@useatlas/types/auth").AuthMode;

/**
 * Authenticated user context available to Effect programs.
 * Bridges from Hono's `c.get("authResult")`.
 *
 * Only provided when the request is authenticated (`authResult.authenticated === true`).
 * Programs that `yield* AuthContext` will fail with a missing-service error
 * if auth middleware has not run — this is the compile-time guarantee that
 * replaces the runtime `c.get("authResult")` check.
 */
export interface AuthContextShape {
  readonly mode: AuthMode;
  /** Authenticated user. Undefined only in "none" auth mode (local dev). */
  readonly user: AtlasUser | undefined;
  /** Convenience: active org ID from user, or undefined. */
  readonly orgId: string | undefined;
  /** See `lib/auth/trust-device-cookie.ts`. */
  readonly trustDeviceIdentifier: string | undefined;
}

export class AuthContext extends Context.Tag("AuthContext")<
  AuthContext,
  AuthContextShape
>() {}

/**
 * Create an AuthContext Layer from an authenticated AuthResult.
 * Used by runHandler to bridge Hono context → Effect Context.
 */
export function makeAuthContextLayer(
  mode: AuthMode,
  user: AtlasUser | undefined,
  trustDeviceIdentifier?: string,
): Layer.Layer<AuthContext> {
  return Layer.succeed(AuthContext, {
    mode,
    user,
    orgId: user?.activeOrganizationId,
    trustDeviceIdentifier,
  });
}

/** Create a test Layer for AuthContext. */
export function createAuthContextTestLayer(
  partial: Partial<AuthContextShape> = {},
): Layer.Layer<AuthContext> {
  return Layer.succeed(AuthContext, {
    mode: partial.mode ?? "none",
    user: partial.user,
    orgId: partial.orgId ?? partial.user?.activeOrganizationId,
    trustDeviceIdentifier: partial.trustDeviceIdentifier,
  });
}

// ══════════════════════════════════════════════════════════════════════
// ██  Enterprise subsystem Tags (#2563 slice 1/11 of #2017)
// ══════════════════════════════════════════════════════════════════════
//
// Sixteen Context.Tags that invert the core → ee dependency. Each Tag
// defines a minimal contract for an enterprise subsystem that core code
// currently reaches via dynamic `await import("@atlas/ee/...")`. The
// no-op default Layer below each Tag returns the "feature disabled"
// shape so a self-hosted build (no EE) gets correct behavior without any
// flag checks at call sites.
//
// Subsequent slices (#2564–#2572) replace call-site dynamic imports with
// `yield* TagName` and add the real `Layer.effect` implementation to
// `ee/src/layers.ts`. Once #2573 (closeout) lands, the only `@atlas/ee`
// import in core is the single conditional `await import("@atlas/ee/layers")`
// inside `buildAppLayer()`.
//
// Shapes here are deliberately conservative — each Tag exposes just
// enough surface to gate the corresponding EE feature without committing
// to a precise return-type vocabulary. Slices 2–10 may widen a shape
// when they move the first real call site; widening is a non-breaking
// change for a no-op default that already returns the "feature disabled"
// sentinel.
//
// ── `available` flag convention (#2589) ──────────────────────────────
//
// A Tag exposes `readonly available: boolean` ONLY when at least one
// non-test consumer must branch on EE-loaded vs not — typically to
// surface a 404 `not_available` envelope, a distinct success-shape
// body, or to short-circuit a method that would otherwise hit the DB
// to learn the same thing. Tags that meet that bar today (drift-check:
// grep services.ts for the boolean-form field declaration — 10 interface
// fields match, plus the convention sentence above): ResidencyResolver,
// ModelRouter, MaskingPolicy, ApprovalGate, SlaMetrics, BackupsManager,
// AuditRetention, IpAllowlistPolicy, SCIMProvenance, Domains. `SaasCrm`
// also carries `available`, but as a discriminated-union discriminant
// (`available: false | true`), so the boolean-form grep does not match
// it.
//
// MaskingPolicy / ApprovalGate / AuditRetention / ResidencyResolver are
// the four consumer-side fail-closed sites (see `enterprise-layer.ts`):
// they branch on `available === false` to surface a 503
// `enterprise_load_failed` when EE is enabled but failed to load.
//
// Every other EE Tag (ComplianceReports, AuditPurgeScheduler, SSOPolicy,
// RolesPolicy, Branding, ProactiveGate) omits the flag — its route
// handlers just call the methods and the Noop's typed-error failure
// (mapped to 403 by the Hono bridge via `EnterpriseError`) is the
// "feature unavailable" signal.
// `DeployModeResolver` is the lone sentinel-returning Tag
// (`"saas" | "self-hosted"` is the value, not a boolean flag).
//
// New Tags MUST default to omitting `available`. Add it only when a
// concrete route needs the branch — and document the route in the
// Tag's JSDoc so the next reviewer can confirm the flag is still
// load-bearing. Domain-specific flags (`xyzActive: boolean`) are NOT
// permitted — fold them into `available` or surface the distinction
// through a method's return value.

// ── ResidencyResolver (#2564 — slice 2/11 of #2017) ──────────────────
//
// Inverts `await import("@atlas/ee/platform/residency")` across
// `lib/db/connection.ts`, `api/routes/platform-residency.ts`, and
// `api/routes/shared-residency.ts`. The Tag exposes the module's public
// surface as Effect-returning methods (plus an `available` discriminator
// for routes that need to render an "unavailable" branch). The no-op
// default returns the "feature disabled" shape so self-hosted builds
// without EE branch cleanly; EE's `ee/src/layers.ts` overlays the real
// `Layer.effect`. `ResidencyError` lives in `lib/residency/errors.ts`
// so this contract can be typed without pulling in `@atlas/ee`.

type ResidencyRegionRoute = {
  readonly databaseUrl: string;
  readonly datasourceUrl?: string;
  readonly region: string;
};
type RegionStatus = import("@useatlas/types").RegionStatus;
type WorkspaceRegion = import("@useatlas/types").WorkspaceRegion;
type ResidencyConfigRegions = import("@atlas/api/lib/config").ResidencyConfig["regions"];
type ResidencyError = import("@atlas/api/lib/residency/errors").ResidencyError;

export interface ResidencyResolverShape {
  /** False when EE residency is not loaded — routes should surface "not_available". */
  readonly available: boolean;
  /** Region-route lookup used by `connection.ts` to overlay per-region datasources. */
  readonly resolveRegionDatabaseUrl: (
    workspaceId: string,
  ) => Effect.Effect<ResidencyRegionRoute | null>;
  /** Configured regions with workspace counts. Fails with `ResidencyError("not_configured")` when no-op. */
  readonly listRegions: () => Effect.Effect<RegionStatus[], ResidencyError>;
  /** Default region. Throws `ResidencyError("not_configured")` synchronously when no-op. */
  readonly getDefaultRegion: () => string;
  /** Region-id → config map. Throws `ResidencyError("not_configured")` synchronously when no-op. */
  readonly getConfiguredRegions: () => ResidencyConfigRegions;
  /** Assign a region to a workspace. Region is immutable once set. */
  readonly assignWorkspaceRegion: (
    workspaceId: string,
    region: string,
  ) => Effect.Effect<WorkspaceRegion, ResidencyError | Error>;
  /** Get a workspace's region assignment, or null if unassigned. */
  readonly getWorkspaceRegionAssignment: (
    workspaceId: string,
  ) => Effect.Effect<WorkspaceRegion | null, ResidencyError | Error>;
  /** All workspace region assignments (admin view). */
  readonly listWorkspaceRegions: () => Effect.Effect<WorkspaceRegion[], ResidencyError | Error>;
  /** True when `region` is a configured region. */
  readonly isConfiguredRegion: (region: string) => boolean;
}
export class ResidencyResolver extends Context.Tag("ResidencyResolver")<
  ResidencyResolver,
  ResidencyResolverShape
>() {}

/**
 * No-op default: residency is unavailable. Effect-returning methods
 * fail with `ResidencyError("not_configured")` or return null/empty
 * sentinels — whichever matches the prior "EE module missing" behavior
 * at the call site. Synchronous getters throw the same error so the
 * existing `try { mod.getDefaultRegion() } catch (err instanceof mod.ResidencyError)`
 * branch in routes still fires unchanged.
 *
 * Lazy-requires the error class to keep this module free of a hard
 * import on `lib/residency/errors` — services.ts is reached very early
 * in the dep graph and an eager import there has bitten us before with
 * mock.module() ordering surprises (see feedback_bun_test_async_mock_module).
 */
export const NoopResidencyResolverLayer: Layer.Layer<ResidencyResolver> =
  Layer.sync(ResidencyResolver, () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { ResidencyError: ResidencyErrorClass } = require("@atlas/api/lib/residency/errors") as {
      ResidencyError: new (args: { message: string; code: "not_configured" }) => ResidencyError;
    };
    const notConfigured = () =>
      new ResidencyErrorClass({
        message:
          "Data residency is not configured. Add a 'residency' section to atlas.config.ts with region definitions.",
        code: "not_configured",
      });
    return {
      available: false,
      resolveRegionDatabaseUrl: () => Effect.succeed(null),
      listRegions: () => Effect.fail(notConfigured()),
      getDefaultRegion: () => {
        throw notConfigured();
      },
      getConfiguredRegions: () => {
        throw notConfigured();
      },
      assignWorkspaceRegion: () => Effect.fail(notConfigured()),
      getWorkspaceRegionAssignment: () => Effect.succeed(null),
      listWorkspaceRegions: () => Effect.succeed([]),
      isConfiguredRegion: () => false,
    } satisfies ResidencyResolverShape;
  });

// ── ModelRouter (#2565 — slice 3/11 of #2017) ────────────────────────
//
// Inverts every `@atlas/ee/platform/model-routing` reference in
// `packages/api/src/`: the dynamic import in `lib/agent.ts`, the
// `EeModule` probe in `lib/scheduler/byot-catalog-refresh.ts`, the
// static admin-route imports in `api/routes/admin-model-config.ts`,
// and the type-only `WorkspaceCredentials` reaches in
// `lib/providers.ts` + `lib/effect/ai.ts`. EE overlays the real
// implementation; the no-op default returns `available: false` +
// null-shaped methods so self-hosted falls back to the env-var
// `getModel()` provider without dynamic imports.
//
// `WorkspaceCredentials` + `RawWorkspaceModelConfig` live in
// `lib/auth/credentials.ts`; `ModelConfigError` +
// `ModelConfigDecryptError` live in `lib/model-routing/errors.ts`.

type WorkspaceModelConfig = import("@useatlas/types").WorkspaceModelConfig;
type SetWorkspaceModelConfigRequest = import("@useatlas/types").SetWorkspaceModelConfigRequest;
type TestModelConfigRequest = import("@useatlas/types").TestModelConfigRequest;
type RawWorkspaceModelConfig = import("@atlas/api/lib/auth/credentials").RawWorkspaceModelConfig;
type ModelConfigError = import("@atlas/api/lib/model-routing/errors").ModelConfigError;
type ModelConfigDecryptError = import("@atlas/api/lib/model-routing/errors").ModelConfigDecryptError;
type EnterpriseError = import("@atlas/api/lib/effect/errors").EnterpriseError;
type BedrockCredentialBundle = import("@useatlas/types").BedrockCredentialBundle;
type GatewayCatalogModel = import("@useatlas/types").GatewayCatalogModel;

export interface ModelRouterShape {
  /** False when EE model-routing is not loaded — admin routes surface "not_available", agent loop falls back to platform default. */
  readonly available: boolean;
  /** Wire-safe (masked api key) workspace config for admin reads + agent reconcile. */
  readonly getWorkspaceModelConfig: (
    orgId: string,
  ) => Effect.Effect<WorkspaceModelConfig | null, EnterpriseError | Error>;
  /** Decrypted workspace config for provider resolution. WARNING: plaintext credentials. */
  readonly getWorkspaceModelConfigRaw: (
    orgId: string,
  ) => Effect.Effect<RawWorkspaceModelConfig | null, ModelConfigDecryptError | Error>;
  /** Create/update a workspace model config. */
  readonly setWorkspaceModelConfig: (
    orgId: string,
    request: SetWorkspaceModelConfigRequest,
  ) => Effect.Effect<WorkspaceModelConfig, EnterpriseError | ModelConfigError | Error>;
  /** Delete the workspace config (returns whether a row was removed). */
  readonly deleteWorkspaceModelConfig: (
    orgId: string,
  ) => Effect.Effect<boolean, EnterpriseError | Error>;
  /** Probe a candidate provider+key against the upstream catalog. */
  readonly testModelConfig: (
    request: TestModelConfigRequest,
  ) => Effect.Effect<
    { success: boolean; message: string; modelName?: string },
    EnterpriseError | ModelConfigError | Error
  >;
  /**
   * Refresh the workspace's `model_status` against the latest catalog and
   * surface any deprecation. Called from the admin reconcile button and
   * the BYOT catalog refresh scheduler. Signature mirrors the EE function
   * (`orgId`, `savedModelId`, `savedProvider`, `freshCatalog`) so the
   * no-op layer can return the "healthy / no suggestion" sentinel.
   */
  readonly reconcileModelDeprecation: (
    orgId: string,
    savedModelId: string,
    savedProvider: string,
    freshCatalog: GatewayCatalogModel[],
  ) => Effect.Effect<{ status: "healthy" | "deprecated"; suggestion: string | null }, Error>;
  /**
   * Parse a Bedrock cred JSON bundle. Used by the scheduler's per-row
   * refresh path; returns null when the JSON shape doesn't validate.
   */
  readonly parseBedrockCredentialBundle: (apiKey: string) => BedrockCredentialBundle | null;
}
export class ModelRouter extends Context.Tag("ModelRouter")<
  ModelRouter,
  ModelRouterShape
>() {}

/**
 * No-op default: BYOT model routing unavailable. Agent loop's
 * workspace-config branch sees `available: false` and falls back to
 * the env-var `getModel()` path. Admin routes branch on `available`
 * to surface "feature unavailable".
 *
 * Lazy-requires the `EnterpriseError` class so this module stays free
 * of eager imports on `lib/effect/errors` (services.ts is reached early
 * in the dep graph; eager imports have caused mock.module() ordering
 * surprises before — see feedback_bun_test_async_mock_module).
 */
export const NoopModelRouterLayer: Layer.Layer<ModelRouter> = Layer.sync(
  ModelRouter,
  () => {

    const notAvailable = makeNotAvailable("Model routing requires enterprise features to be enabled.");
    return {
      available: false,
      getWorkspaceModelConfig: () => Effect.succeed(null),
      getWorkspaceModelConfigRaw: () => Effect.succeed(null),
      setWorkspaceModelConfig: () => Effect.fail(notAvailable()),
      // Was `Effect.succeed(false)` pre-#2594 — surfaced as 404
      // "Config not found" via admin route, falsely telling the admin
      // their config was already gone. Fail loudly so 403 envelope
      // makes the EE-not-installed state explicit.
      deleteWorkspaceModelConfig: () => Effect.fail(notAvailable()),
      testModelConfig: () => Effect.fail(notAvailable()),
      reconcileModelDeprecation: () =>
        Effect.succeed({ status: "healthy" as const, suggestion: null }),
      parseBedrockCredentialBundle: () => null,
    } satisfies ModelRouterShape;
  },
);

// ── MaskingPolicy (#2566 — slice 4/11 of #2017) ──────────────────────
//
// Inverts every `@atlas/ee/compliance/masking` reference in
// `packages/api/src/`: the two `applyMasking` dynamic imports in
// `lib/tools/sql.ts` and the PII-classification CRUD imports in
// `api/routes/admin-compliance.ts`. EE overlays the real implementation;
// the no-op default fails open (passes rows through unchanged), matching
// the pre-#2566 behavior when the EE module wasn't installed.
//
// `ComplianceError` lives in `lib/compliance/errors.ts` so the Tag's
// failure channels stay typed without pulling in `@atlas/ee`.

type PIIColumnClassification = import("@useatlas/types").PIIColumnClassification;
type UpdatePIIClassificationRequest = import("@useatlas/types").UpdatePIIClassificationRequest;
type ComplianceError = import("@atlas/api/lib/compliance/errors").ComplianceError;

export interface MaskingContext {
  readonly columns: string[];
  readonly rows: Record<string, unknown>[];
  readonly tablesAccessed: string[];
  readonly orgId: string;
  readonly userRole: string | undefined;
  readonly connectionId?: string | null;
}

export interface MaskingPolicyShape {
  /**
   * False when EE compliance is not loaded — `sql.ts:applyMaskingViaTag`
   * (the consumer-side fail-closed check from #2593) reads this to
   * surface 503 `enterprise_load_failed` instead of returning unmasked
   * rows on a SaaS install where `ATLAS_ENTERPRISE_ENABLED=true` but the
   * EE layer didn't bind. Self-hosted with `available: false` is the
   * expected pass-through (no PII classifications configured, so the
   * fail-open behaviour is harmless). Departs from the #2589 default of
   * omitting `available` because the 503-vs-pass distinction is the
   * different-response-shape branch the codified rule permits.
   */
  readonly available: boolean;
  /** Apply PII masking. No-op returns `ctx.rows` unchanged (fail open). */
  readonly applyMasking: (
    ctx: MaskingContext,
  ) => Effect.Effect<Record<string, unknown>[]>;
  readonly listPIIClassifications: (
    orgId: string,
    connectionGroupId?: string,
  ) => Effect.Effect<PIIColumnClassification[], ComplianceError | Error>;
  readonly updatePIIClassification: (
    orgId: string,
    classificationId: string,
    updates: UpdatePIIClassificationRequest,
  ) => Effect.Effect<PIIColumnClassification, ComplianceError | Error>;
  readonly deletePIIClassification: (
    orgId: string,
    classificationId: string,
  ) => Effect.Effect<void, ComplianceError | Error>;
  /** Per-org cache buster; safe no-op when EE is missing. */
  readonly invalidateClassificationCache: (orgId: string) => void;
}
export class MaskingPolicy extends Context.Tag("MaskingPolicy")<
  MaskingPolicy,
  MaskingPolicyShape
>() {}
export const NoopMaskingPolicyLayer: Layer.Layer<MaskingPolicy> = Layer.sync(
  MaskingPolicy,
  () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { ComplianceError: ComplianceErrorClass } = require("@atlas/api/lib/compliance/errors") as {
      ComplianceError: new (args: { message: string; code: "not_found" }) => ComplianceError;
    };
    const notFound = (id: string) =>
      new ComplianceErrorClass({
        message: `PII classification "${id}" not found.`,
        code: "not_found",
      });
    return {
      available: false,
      // MUST preserve reference identity — callers in `tools/sql.ts`
      // compute `maskingApplied = maskedRows !== result.rows`, and a
      // fresh-array no-op (`[...ctx.rows]`) misreports `true` on every
      // self-hosted query against a classified table. EE's real
      // `applyMasking` returns `ctx.rows` directly on no-rules early-out
      // paths for the same reason.
      applyMasking: (ctx) => Effect.succeed(ctx.rows),
      listPIIClassifications: () => Effect.succeed([]),
      updatePIIClassification: (_orgId, id) => Effect.fail(notFound(id)),
      deletePIIClassification: (_orgId, id) => Effect.fail(notFound(id)),
      invalidateClassificationCache: () => {},
    } satisfies MaskingPolicyShape;
  },
);

// ── ComplianceReports (#2566 — slice 4/11 of #2017) ──────────────────
//
// Inverts the static `import { generateDataAccessReport, ... } from "@atlas/ee/compliance/reports"`
// in `api/routes/admin-compliance.ts`. EE generates SOC2/HIPAA reports;
// core's no-op fails with `ReportError("not_available")` so the admin
// surface routes through `domainError` to a 404 envelope.

type DataAccessReport = import("@useatlas/types").DataAccessReport;
type UserActivityReport = import("@useatlas/types").UserActivityReport;
type ComplianceReportFilters = import("@useatlas/types").ComplianceReportFilters;
type ReportError = import("@atlas/api/lib/compliance/errors").ReportError;
type EnterpriseErrorForReports = import("@atlas/api/lib/effect/errors").EnterpriseError;

export interface ComplianceReportsShape {
  readonly generateDataAccessReport: (
    orgId: string,
    filters: ComplianceReportFilters,
  ) => Effect.Effect<DataAccessReport, ReportError | EnterpriseErrorForReports | Error>;
  readonly generateUserActivityReport: (
    orgId: string,
    filters: ComplianceReportFilters,
  ) => Effect.Effect<UserActivityReport, ReportError | EnterpriseErrorForReports | Error>;
  readonly dataAccessReportToCSV: (report: DataAccessReport) => string;
  readonly userActivityReportToCSV: (report: UserActivityReport) => string;
}
export class ComplianceReports extends Context.Tag("ComplianceReports")<
  ComplianceReports,
  ComplianceReportsShape
>() {}
export const NoopComplianceReportsLayer: Layer.Layer<ComplianceReports> =
  Layer.sync(ComplianceReports, () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { ReportError: ReportErrorClass } = require("@atlas/api/lib/compliance/errors") as {
      ReportError: new (args: { message: string; code: "not_available" }) => ReportError;
    };
    const notAvailable = () =>
      new ReportErrorClass({
        message: "Compliance reports require enterprise features to be enabled.",
        code: "not_available",
      });
    return {
      generateDataAccessReport: () => Effect.fail(notAvailable()),
      generateUserActivityReport: () => Effect.fail(notAvailable()),
      // CSV converters are pure formatters — return empty CSV headers so a
      // caller that bypasses the `available` gate doesn't crash on the
      // pure-function path.
      dataAccessReportToCSV: () => "",
      userActivityReportToCSV: () => "",
    } satisfies ComplianceReportsShape;
  });

// ── ApprovalGate (#2567 — slice 5/11 of #2017) ───────────────────────
//
// Inverts every `@atlas/ee/governance/approval` reference in
// `packages/api/src/`: the four dynamic imports in `lib/tools/sql.ts`
// (checkApprovalRequired + createApprovalRequest + hasApprovedRequest,
// fired twice — once on the live path, once on the cached path) and
// the static admin-route imports in `api/routes/admin-approval.ts`.
// EE overlays the real implementation; the no-op default returns
// `{ required: false }` so self-hosted bypasses the gate, matching the
// pre-#2567 behavior when the EE module wasn't installed.
//
// `ApprovalError` lives in `lib/governance/errors.ts` so the Tag's
// failure channels stay typed without pulling in `@atlas/ee`.

type ApprovalRule = import("@useatlas/types").ApprovalRule;
type ApprovalRequest = import("@useatlas/types").ApprovalRequest;
type ApprovalStatus = import("@useatlas/types").ApprovalStatus;
type ApprovalRequestSurface = import("@useatlas/types").ApprovalRequestSurface;
type CreateApprovalRuleRequest = import("@useatlas/types").CreateApprovalRuleRequest;
type UpdateApprovalRuleRequest = import("@useatlas/types").UpdateApprovalRuleRequest;
type ApprovalError = import("@atlas/api/lib/governance/errors").ApprovalError;
type EnterpriseErrorForApproval = import("@atlas/api/lib/effect/errors").EnterpriseError;

export interface ApprovalMatchResult {
  readonly required: boolean;
  readonly matchedRules: ApprovalRule[];
  readonly identityMissing?: boolean;
}

export interface CreateApprovalRequestInput {
  readonly orgId: string;
  readonly ruleId: string;
  readonly ruleName: string;
  readonly requesterId: string;
  readonly requesterEmail: string | null;
  readonly querySql: string;
  readonly explanation: string | null;
  readonly connectionId: string | null;
  readonly connectionGroupId?: string | null;
  readonly tablesAccessed: string[];
  readonly columnsAccessed: string[];
  readonly surface?: ApprovalRequestSurface | null;
}

export interface ApprovalGateShape {
  /**
   * False when EE governance is not loaded — sql.ts's consumer-side
   * fail-closed check (#2593) uses this to surface 503
   * `enterprise_load_failed` instead of bypassing the gate on SaaS
   * (`ATLAS_ENTERPRISE_ENABLED=true`) when the EE layer didn't bind.
   * Self-hosted with `available: false` is the expected no-op path —
   * no rules to match, queries pass through.
   */
  readonly available: boolean;
  /** Decide whether a query needs approval. No-op returns `{ required: false, matchedRules: [] }`. */
  readonly checkApprovalRequired: (
    orgId: string | undefined,
    tablesAccessed: string[],
    columnsAccessed: string[],
    options?: {
      requesterId?: string | undefined;
      surface?: ApprovalRequestSurface | undefined;
    },
  ) => Effect.Effect<ApprovalMatchResult, never>;
  /** Has the requester already had an identical query approved? */
  readonly hasApprovedRequest: (
    orgId: string,
    requesterId: string,
    querySql: string,
    connectionId?: string,
  ) => Effect.Effect<boolean, never>;
  /** Queue a new approval request. */
  readonly createApprovalRequest: (
    input: CreateApprovalRequestInput,
  ) => Effect.Effect<ApprovalRequest, ApprovalError | EnterpriseErrorForApproval | Error>;
  /** List rules; admin queue. */
  readonly listApprovalRules: (
    orgId: string,
  ) => Effect.Effect<ApprovalRule[], EnterpriseErrorForApproval>;
  readonly createApprovalRule: (
    orgId: string,
    input: CreateApprovalRuleRequest,
  ) => Effect.Effect<ApprovalRule, ApprovalError | EnterpriseErrorForApproval | Error>;
  readonly updateApprovalRule: (
    orgId: string,
    ruleId: string,
    input: UpdateApprovalRuleRequest,
  ) => Effect.Effect<ApprovalRule, ApprovalError | EnterpriseErrorForApproval | Error>;
  readonly deleteApprovalRule: (
    orgId: string,
    ruleId: string,
  ) => Effect.Effect<boolean, EnterpriseErrorForApproval>;
  readonly listApprovalRequests: (
    orgId: string,
    status?: ApprovalStatus,
    limit?: number,
    offset?: number,
  ) => Effect.Effect<ApprovalRequest[], EnterpriseErrorForApproval>;
  readonly getApprovalRequest: (
    orgId: string,
    requestId: string,
  ) => Effect.Effect<ApprovalRequest | null, ApprovalError | EnterpriseErrorForApproval>;
  readonly reviewApprovalRequest: (
    orgId: string,
    requestId: string,
    reviewerId: string,
    reviewerEmail: string | null,
    action: "approve" | "deny",
    comment?: string,
  ) => Effect.Effect<ApprovalRequest, ApprovalError | EnterpriseErrorForApproval | Error>;
  readonly expireStaleRequests: (orgId: string) => Effect.Effect<number, Error>;
  readonly getPendingCount: (orgId: string) => Effect.Effect<number, never>;
}
export class ApprovalGate extends Context.Tag("ApprovalGate")<
  ApprovalGate,
  ApprovalGateShape
>() {}
export const NoopApprovalGateLayer: Layer.Layer<ApprovalGate> = Layer.sync(
  ApprovalGate,
  () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { ApprovalError: ApprovalErrorClass } = require("@atlas/api/lib/governance/errors") as {
      ApprovalError: new (args: { message: string; code: "not_found" }) => ApprovalError;
    };
    const notFound = (id: string) =>
      new ApprovalErrorClass({
        message: `Approval request "${id}" not found.`,
        code: "not_found",
      });

    const notAvailable = makeNotAvailable("Approval workflows require enterprise features to be enabled.");
    return {
      available: false,
      checkApprovalRequired: () =>
        Effect.succeed({ required: false, matchedRules: [] }),
      hasApprovedRequest: () => Effect.succeed(false),
      // `createApprovalRequest` is reached when checkApprovalRequired
      // returned `required: true`. The no-op never returns `required:
      // true`, so this is a defensive impl — fail with EnterpriseError
      // (not Effect.die) so any regression that lands here surfaces
      // through the typed error channel and route-layer catchAll (→ 403)
      // instead of bypassing both as an unrecoverable defect (→ 500).
      createApprovalRequest: () => Effect.fail(notAvailable()),
      listApprovalRules: () => Effect.succeed([]),
      createApprovalRule: (_orgId, _input) =>
        Effect.fail(notFound("__no_op__")),
      updateApprovalRule: (_orgId, ruleId) =>
        Effect.fail(notFound(ruleId)),
      // Was `Effect.succeed(false)` pre-#2594 — silently lied that
      // there was nothing to delete. Fail loudly via 403 envelope.
      deleteApprovalRule: () => Effect.fail(notAvailable()),
      listApprovalRequests: () => Effect.succeed([]),
      getApprovalRequest: () => Effect.succeed(null),
      reviewApprovalRequest: (_orgId, requestId) =>
        Effect.fail(notFound(requestId)),
      expireStaleRequests: () => Effect.succeed(0),
      getPendingCount: () => Effect.succeed(0),
    } satisfies ApprovalGateShape;
  },
);

// ── SlaMetrics (#2568 — slice 6/11 of #2017) ─────────────────────────
//
// Inverts every `@atlas/ee/sla/*` reference in `packages/api/src/`:
// the two `recordQueryMetric` dynamic imports in `lib/tools/sql.ts`,
// and the `SLAModule` lazy-loader in `api/routes/platform-sla.ts`. EE
// overlays the real implementation; the no-op default drops metrics
// on the floor (matches pre-#2568 behavior when the EE module wasn't
// installed) and returns `available: false` so admin platform-SLA
// routes surface the existing 404 envelope.

type WorkspaceSLASummary = import("@useatlas/types").WorkspaceSLASummary;
type WorkspaceSLADetail = import("@useatlas/types").WorkspaceSLADetail;
type SLAAlert = import("@useatlas/types").SLAAlert;
type SLAAlertStatus = import("@useatlas/types").SLAAlertStatus;
type SLAThresholds = import("@useatlas/types").SLAThresholds;

export interface SlaMetricsShape {
  /** False when EE SLA metrics aren't loaded — `platform-sla.ts` returns 404 `not_available` for both read and write routes. */
  readonly available: boolean;
  /** Fire-and-forget per-query metric write. No-op is a noop on the floor. */
  readonly recordQueryMetric: (
    workspaceId: string,
    latencyMs: number,
    isError: boolean,
  ) => Effect.Effect<void>;
  readonly getAllWorkspaceSLA: (hoursBack?: number) => Effect.Effect<WorkspaceSLASummary[], Error>;
  readonly getWorkspaceSLADetail: (
    workspaceId: string,
    hoursBack?: number,
  ) => Effect.Effect<WorkspaceSLADetail, Error>;
  readonly getThresholds: (workspaceId?: string) => Effect.Effect<SLAThresholds, Error>;
  readonly updateThresholds: (thresholds: SLAThresholds) => Effect.Effect<void, Error>;
  readonly getAlerts: (
    status?: SLAAlertStatus,
    limit?: number,
  ) => Effect.Effect<SLAAlert[], Error>;
  readonly acknowledgeAlert: (alertId: string, actorId: string) => Effect.Effect<boolean, Error>;
  readonly evaluateAlerts: () => Effect.Effect<SLAAlert[], Error>;
}
export class SlaMetrics extends Context.Tag("SlaMetrics")<
  SlaMetrics,
  SlaMetricsShape
>() {}
// `Effect.fail(new EnterpriseError(...))` rather than `Effect.die(...)` on
// the methods that have no sensible self-hosted return — defects bypass
// `Effect.catchAll` and the typed error channel, so a route that catches
// would still see a 500 with no `requestId`-correlated log. The `Error`
// channel in the shape already accommodates EnterpriseError.
export const NoopSlaMetricsLayer: Layer.Layer<SlaMetrics> = Layer.sync(
  SlaMetrics,
  () => {

    const notAvailable = makeNotAvailable("SLA monitoring requires enterprise features to be enabled.");
    return {
      available: false,
      recordQueryMetric: () => Effect.void,
      getAllWorkspaceSLA: () => Effect.succeed([]),
      getWorkspaceSLADetail: () => Effect.fail(notAvailable()),
      getThresholds: () => Effect.fail(notAvailable()),
      updateThresholds: () => Effect.fail(notAvailable()),
      getAlerts: () => Effect.succeed([]),
      // Was `Effect.succeed(false)` pre-#2594 — silently reported
      // "alert not found" when EE was missing. Fail loudly.
      acknowledgeAlert: () => Effect.fail(notAvailable()),
      evaluateAlerts: () => Effect.succeed([]),
    } satisfies SlaMetricsShape;
  },
);

// ── BackupsManager (#2568 — slice 6/11 of #2017) ─────────────────────
//
// Inverts the `BackupsModule` lazy-loader in
// `api/routes/platform-backups.ts`. EE orchestrates automated backups;
// the no-op reports `available: false` so the admin route surfaces a
// 404 envelope (the existing "not_available" branch).

export type BackupConfigShape = {
  readonly schedule: string;
  readonly retention_days: number;
  readonly storage_path: string;
};

export type BackupRowShape = {
  readonly id: string;
  readonly created_at: string;
  readonly size_bytes: string | null;
  readonly status: string;
  readonly storage_path: string;
  readonly retention_expires_at: string;
  readonly error_message: string | null;
  /** Depth of the last verification ('full-restore' | 'header-only') or null if never verified. */
  readonly verify_level: string | null;
  // NOTE: `expected_table_count` (the EE `BackupRow`'s verification baseline,
  // #2989) is intentionally NOT surfaced here. It's a verification-internal
  // detail consumed only by `verifyByRestore` via the direct engine import —
  // the route reads backups through this Tag and the wire `BackupEntry`, both
  // of which render verification *depth* (`verify_level`) and *outcome*
  // (`status` + `error_message`), never the raw expected count. Keep it off
  // this boundary and out of `@useatlas/types` unless a consumer needs it.
};

export type CreateBackupResult = {
  readonly id: string;
  readonly storagePath: string;
  readonly sizeBytes: number;
  readonly status: string;
};

export interface BackupsManagerShape {
  /** False when EE backups aren't loaded — `platform-backups.ts` returns 404 `not_available` for config + history reads and run-now writes. */
  readonly available: boolean;
  readonly getBackupConfig: () => Effect.Effect<BackupConfigShape, Error>;
  readonly updateBackupConfig: (config: {
    schedule?: string;
    retentionDays?: number;
    storagePath?: string;
  }) => Effect.Effect<void, Error>;
  readonly createBackup: () => Effect.Effect<CreateBackupResult, Error>;
  readonly listBackups: (limit?: number) => Effect.Effect<BackupRowShape[], Error>;
  readonly getBackupById: (id: string) => Effect.Effect<BackupRowShape | null, Error>;
  readonly purgeExpiredBackups: () => Effect.Effect<number, Error>;
  readonly verifyBackup: (
    backupId: string,
  ) => Effect.Effect<
    { verified: boolean; message: string; level: "full-restore" | "header-only" },
    Error
  >;
  readonly requestRestore: (
    backupId: string,
  ) => Effect.Effect<{ confirmationToken: string; message: string }, Error>;
  readonly executeRestore: (
    confirmationToken: string,
  ) => Effect.Effect<
    { restored: boolean; preRestoreBackupId: string; message: string },
    Error
  >;
}
export class BackupsManager extends Context.Tag("BackupsManager")<
  BackupsManager,
  BackupsManagerShape
>() {}
export const NoopBackupsManagerLayer: Layer.Layer<BackupsManager> = Layer.sync(
  BackupsManager,
  () => {

    const notAvailable = makeNotAvailable("Automated backups require enterprise features to be enabled.");
    return {
    available: false,
    getBackupConfig: () => Effect.fail(notAvailable()),
    updateBackupConfig: () => Effect.fail(notAvailable()),
    createBackup: () => Effect.fail(notAvailable()),
    listBackups: () => Effect.succeed([]),
    getBackupById: () => Effect.succeed(null),
    purgeExpiredBackups: () => Effect.succeed(0),
    verifyBackup: () => Effect.fail(notAvailable()),
    requestRestore: () => Effect.fail(notAvailable()),
    executeRestore: () => Effect.fail(notAvailable()),
    } satisfies BackupsManagerShape;
  },
);

// ── AuditRetention (#2569 — slice 7/11 of #2017; split in #2587) ─────
//
// Inverts every `@atlas/ee/audit/retention` reference in
// `packages/api/src/`: the 10+ dynamic imports across
// `api/routes/admin-audit-retention.ts` + `admin-action-retention.ts`
// plus the static `RetentionError` import. EE overlays the real
// implementation; the no-op default returns `available: false` and
// fails methods with `EnterpriseError` so the routes' existing
// `domainError(RetentionError)` mapping renders the 4xx envelope.
//
// `RetentionError` lives in `lib/audit/retention-errors.ts` so the
// Tag's failure channel stays typed without pulling in `@atlas/ee`.
//
// #2587 — Split the original bundled Tag into CRUD vs scheduler
// lifecycle. `AuditRetention` here covers the 10 CRUD methods (read +
// write policies, export, soft/hard-purge, GDPR anonymize). The
// scheduler `start*`/`stop*` pair lives in `AuditPurgeScheduler` below,
// returns `Effect<void, Error>` so tests can observe failures, and
// breaks the circular `require("./purge-scheduler")` workaround in
// `ee/src/audit/retention.ts` (#2587 acceptance criteria).

type AuditRetentionPolicy = import("@useatlas/types").AuditRetentionPolicy;
type AnonymizeInitiatedBy = import("@useatlas/types").AnonymizeInitiatedBy;
type RetentionError = import("@atlas/api/lib/audit/retention-errors").RetentionError;
type EnterpriseErrorForRetention = import("@atlas/api/lib/effect/errors").EnterpriseError;

export interface SetRetentionPolicyInput {
  readonly retentionDays: number | null;
  readonly hardDeleteDelayDays?: number;
}

export interface PurgeResult {
  readonly orgId: string;
  readonly softDeletedCount: number;
}

export interface HardDeleteResult {
  readonly deletedCount: number;
}

export interface AdminActionPurgeResult {
  readonly orgId: string;
  readonly deletedCount: number;
}

export interface AnonymizeResult {
  readonly anonymizedRowCount: number;
}

export interface AuditExportOptions {
  readonly orgId: string;
  readonly format: "csv" | "json";
  readonly startDate?: string;
  readonly endDate?: string;
}

export type AuditExportResult =
  | { readonly format: "csv"; readonly content: string; readonly rowCount: number; readonly truncated: boolean; readonly totalAvailable: number }
  | { readonly format: "json"; readonly content: string; readonly rowCount: number; readonly truncated: boolean; readonly totalAvailable: number };

export interface AuditRetentionShape {
  /**
   * False when EE retention isn't loaded — `admin-{audit,action}-retention.ts`
   * (consumer-side fail-closed, #2593) wrap every method call in a guard
   * that surfaces 503 `enterprise_load_failed` on SaaS
   * (`ATLAS_ENTERPRISE_ENABLED=true`) when the EE layer didn't bind.
   * Without the guard, pure-read methods like `getRetentionPolicy` would
   * return `null` ("no policy configured"), masking the fact that a
   * configured policy in the DB couldn't be read. Self-hosted with
   * `available: false` keeps the existing pass-through — destructive ops
   * still fail loudly via the noop's `EnterpriseError`, but the read
   * path can short-circuit before the call. Departs from #2589's "drop"
   * default because this is exactly the different-response-shape branch
   * the codified rule permits (503 vs 403).
   */
  readonly available: boolean;
  // Audit-log retention
  readonly getRetentionPolicy: (
    orgId: string,
  ) => Effect.Effect<AuditRetentionPolicy | null, EnterpriseErrorForRetention>;
  readonly setRetentionPolicy: (
    orgId: string,
    input: SetRetentionPolicyInput,
    updatedBy: string | null,
  ) => Effect.Effect<AuditRetentionPolicy, RetentionError | EnterpriseErrorForRetention | Error>;
  readonly purgeExpiredEntries: (
    orgId?: string,
  ) => Effect.Effect<PurgeResult[], EnterpriseErrorForRetention>;
  readonly hardDeleteExpired: (
    orgId?: string,
  ) => Effect.Effect<HardDeleteResult, EnterpriseErrorForRetention>;
  readonly exportAuditLog: (
    options: AuditExportOptions,
  ) => Effect.Effect<AuditExportResult, RetentionError | EnterpriseErrorForRetention | Error>;
  // Admin-action retention
  readonly getAdminActionRetentionPolicy: (
    orgId: string,
  ) => Effect.Effect<AuditRetentionPolicy | null, EnterpriseErrorForRetention | Error>;
  readonly setAdminActionRetentionPolicy: (
    orgId: string,
    input: SetRetentionPolicyInput,
    updatedBy: string | null,
  ) => Effect.Effect<AuditRetentionPolicy, RetentionError | EnterpriseErrorForRetention | Error>;
  readonly purgeAdminActionExpired: (
    orgId?: string,
  ) => Effect.Effect<AdminActionPurgeResult[], EnterpriseErrorForRetention | Error>;
  readonly anonymizeUserAdminActions: (
    userId: string,
    initiatedBy: AnonymizeInitiatedBy,
  ) => Effect.Effect<AnonymizeResult, RetentionError | EnterpriseErrorForRetention | Error>;
  readonly previewAdminActionErasure: (
    userId: string,
  ) => Effect.Effect<{ anonymizableRowCount: number }, RetentionError | EnterpriseErrorForRetention | Error>;
}
export class AuditRetention extends Context.Tag("AuditRetention")<
  AuditRetention,
  AuditRetentionShape
>() {}
export const NoopAuditRetentionLayer: Layer.Layer<AuditRetention> = Layer.sync(
  AuditRetention,
  () => {
    const notAvailable = makeNotAvailable("Audit retention requires enterprise features to be enabled.");
    return {
      available: false,
      // Pure reads — "no policy configured" is honest on self-hosted.
      getRetentionPolicy: () => Effect.succeed(null),
      getAdminActionRetentionPolicy: () => Effect.succeed(null),
      // Destructive ops fail loudly so a misconfigured install doesn't
      // silently report fake success (the GDPR `anonymizeUserAdminActions`
      // pretend-succeed was the most consequential of the original bugs).
      setRetentionPolicy: () => Effect.fail(notAvailable()),
      purgeExpiredEntries: () => Effect.fail(notAvailable()),
      hardDeleteExpired: () => Effect.fail(notAvailable()),
      exportAuditLog: () => Effect.fail(notAvailable()),
      setAdminActionRetentionPolicy: () => Effect.fail(notAvailable()),
      purgeAdminActionExpired: () => Effect.fail(notAvailable()),
      anonymizeUserAdminActions: () => Effect.fail(notAvailable()),
      previewAdminActionErasure: () => Effect.fail(notAvailable()),
    } satisfies AuditRetentionShape;
  },
);

// ── AuditPurgeScheduler (#2587 — split out of AuditRetention) ────────
//
// Lifecycle-only Tag for the daily purge cron worker. Originally a pair
// of `() => void` methods bolted onto `AuditRetention`, which forced
// `ee/src/audit/retention.ts` to `require("./purge-scheduler")` from a
// top-level const (with `eslint-disable` for the require) to dodge the
// static cycle between the CRUD module and the scheduler module that
// imports CRUD's purge helpers.
//
// Splitting into a separate Tag removes both smells:
//   1. The two modules are independent Tags, so EE binds each at the
//      `layers.ts` aggregator level — the runtime `require()` workaround
//      goes away.
//   2. `start*` / `stop*` now return `Effect<void, Error>`, so the
//      scheduler boot path in `makeSchedulerLive` can `yield*` them and
//      a future regression that throws (e.g. failed `setInterval` on a
//      hostile runtime) is observable in tests instead of silently
//      swallowed by `() => void`.
//
// The no-op default fails both methods with `EnterpriseError` —
// `makeSchedulerLive` wraps the start call in `Effect.catchAll` so the
// self-hosted boot path still completes cleanly (the catch turns the
// fail-closed signal back into a log line + void), while preserving
// the test observability the closeout audit asked for.

export interface AuditPurgeSchedulerShape {
  readonly startAuditPurgeScheduler: (
    intervalMs?: number,
  ) => Effect.Effect<void, EnterpriseErrorForRetention | Error>;
  readonly stopAuditPurgeScheduler: () => Effect.Effect<
    void,
    EnterpriseErrorForRetention | Error
  >;
}
export class AuditPurgeScheduler extends Context.Tag("AuditPurgeScheduler")<
  AuditPurgeScheduler,
  AuditPurgeSchedulerShape
>() {}
export const NoopAuditPurgeSchedulerLayer: Layer.Layer<AuditPurgeScheduler> =
  Layer.sync(AuditPurgeScheduler, () => {
    const notAvailable = makeNotAvailable(
      "Audit purge scheduler requires enterprise features to be enabled.",
    );
    return {
      startAuditPurgeScheduler: () => Effect.fail(notAvailable()),
      stopAuditPurgeScheduler: () => Effect.fail(notAvailable()),
    } satisfies AuditPurgeSchedulerShape;
  });

// ── IpAllowlistPolicy (#2570 — slice 8/11 of #2017) ──────────────────
//
// Inverts every `@atlas/ee/auth/ip-allowlist` reference in
// `packages/api/src/`: the dynamic-import lazy-loader in
// `admin-ip-allowlist.ts` (whose explicit "circular-dep workaround"
// comment is what motivated the Tag inversion in the first place), plus
// the four dynamic-import call sites in `admin-auth`, `auth-preamble`,
// `chat`, and `lib/auth/middleware.ts`. EE overlays the real impl; the
// no-op default always allows (matches pre-#2570 behavior when EE
// wasn't loaded).
//
// `IPAllowlistError` lives in `lib/auth/auth-errors.ts` so the Tag's
// failure channel stays typed without pulling in `@atlas/ee`.

type IPAllowlistError = import("@atlas/api/lib/auth/auth-errors").IPAllowlistError;
type EnterpriseErrorForAuth = import("@atlas/api/lib/effect/errors").EnterpriseError;

export interface IPAllowlistEntryShape {
  readonly id: string;
  readonly orgId: string;
  readonly cidr: string;
  readonly description: string | null;
  readonly createdAt: string;
  readonly createdBy: string | null;
}

export interface IpAllowlistPolicyShape {
  /** False when EE isn't loaded — `checkIPAllowlist` falls through to allow. */
  readonly available: boolean;
  /** Always-allow when no-op. Mirrors EE's nullable-`clientIP` signature. */
  readonly checkIPAllowlist: (
    orgId: string,
    clientIP: string | null,
  ) => Effect.Effect<{ allowed: boolean }, Error>;
  readonly listIPAllowlistEntries: (
    orgId: string,
  ) => Effect.Effect<IPAllowlistEntryShape[], EnterpriseErrorForAuth>;
  readonly addIPAllowlistEntry: (
    orgId: string,
    cidr: string,
    description: string | null,
    createdBy: string | null,
  ) => Effect.Effect<IPAllowlistEntryShape, IPAllowlistError | EnterpriseErrorForAuth | Error>;
  readonly removeIPAllowlistEntry: (
    orgId: string,
    entryId: string,
  ) => Effect.Effect<boolean, EnterpriseErrorForAuth>;
  /** Per-org cache buster — safe no-op when EE is missing. */
  readonly invalidateCache: (orgId: string) => void;
}
export class IpAllowlistPolicy extends Context.Tag("IpAllowlistPolicy")<
  IpAllowlistPolicy,
  IpAllowlistPolicyShape
>() {}
export const NoopIpAllowlistPolicyLayer: Layer.Layer<IpAllowlistPolicy> = Layer.sync(
  IpAllowlistPolicy,
  () => {

    const notAvailable = makeNotAvailable("IP allowlist requires enterprise features to be enabled.");
    return {
      available: false,
      checkIPAllowlist: () => Effect.succeed({ allowed: true }),
      listIPAllowlistEntries: () => Effect.succeed([]),
      // Defensive: only reachable if the admin route bypasses the
      // `available` check. Fail with EnterpriseError (not Effect.die)
      // so the route-layer catchAll surfaces a 403 instead of an
      // unrecoverable 500 defect — matches the pattern across the other
      // Noop layers post-#2594.
      addIPAllowlistEntry: () => Effect.fail(notAvailable()),
      // SECURITY: was `Effect.succeed(false)` pre-#2594 — route
      // mapped to 404 "entry not found", falsely telling admin the
      // IP was removed. Entry stayed in DB; IP retained access.
      removeIPAllowlistEntry: () => Effect.fail(notAvailable()),
      invalidateCache: () => {},
    } satisfies IpAllowlistPolicyShape;
  },
);

// ── SSOPolicy (#2570 — slice 8/11 of #2017) ──────────────────────────
//
// Inverts `@atlas/ee/auth/sso` references in `packages/api/src/`: the
// static helper imports (`isSSOEnforcedForDomain`, `extractEmailDomain`)
// in `lib/auth/middleware.ts` and the full admin surface in
// `api/routes/admin-sso.ts`. EE overlays the real impl; the no-op
// reports `available: false` so the admin surface 404s and middleware
// skips SSO enforcement.
//
// `extractEmailDomain` is a pure helper — kept inline on the Tag for
// symmetry with `isSSOEnforcedForDomain` so middleware reaches both
// through one yield.

type SSOError = import("@atlas/api/lib/auth/auth-errors").SSOError;
type SSOEnforcementError = import("@atlas/api/lib/auth/auth-errors").SSOEnforcementError;
type SSOProvider = import("@useatlas/types").SSOProvider;
type CreateSSOProviderRequest = import("@useatlas/types").CreateSSOProviderRequest;
type UpdateSSOProviderRequest = import("@useatlas/types").UpdateSSOProviderRequest;

export interface SSOPolicyShape {
  readonly extractEmailDomain: (email: string) => string | null;
  /**
   * Mirror EE's wire shape: returns `null` on missing internal DB,
   * `{ enforced: false }` when no SSO provider matches the domain,
   * and `{ enforced: true, provider, ssoRedirectUrl }` otherwise. The
   * middleware's `ssoRedirectUrl` consumption depends on this exact
   * shape — do not narrow the union further.
   */
  readonly isSSOEnforcedForDomain: (
    emailDomain: string,
  ) => Effect.Effect<
    { enforced: boolean; provider?: SSOProvider; ssoRedirectUrl?: string } | null
  >;
  readonly isSSOEnforced: (
    orgId: string,
  ) => Effect.Effect<
    { enforced: boolean; provider?: SSOProvider; ssoRedirectUrl?: string } | null,
    SSOEnforcementError | EnterpriseErrorForAuth | Error
  >;
  readonly setSSOEnforcement: (
    orgId: string,
    enforced: boolean,
  ) => Effect.Effect<{ enforced: boolean; orgId: string }, SSOEnforcementError | EnterpriseErrorForAuth | Error>;
  readonly listSSOProviders: (orgId: string) => Effect.Effect<SSOProvider[], EnterpriseErrorForAuth>;
  readonly getSSOProvider: (
    orgId: string,
    providerId: string,
  ) => Effect.Effect<SSOProvider | null, EnterpriseErrorForAuth>;
  readonly createSSOProvider: (
    orgId: string,
    request: CreateSSOProviderRequest,
  ) => Effect.Effect<SSOProvider, SSOError | EnterpriseErrorForAuth | Error>;
  readonly updateSSOProvider: (
    orgId: string,
    providerId: string,
    request: UpdateSSOProviderRequest,
  ) => Effect.Effect<SSOProvider, SSOError | EnterpriseErrorForAuth | Error>;
  readonly deleteSSOProvider: (
    orgId: string,
    providerId: string,
  ) => Effect.Effect<boolean, EnterpriseErrorForAuth>;
  readonly verifyDomain: (
    providerId: string,
    orgId: string,
  ) => Effect.Effect<{ status: string; message: string }, SSOError | EnterpriseErrorForAuth | Error>;
  readonly checkDomainAvailability: (
    domain: string,
    orgId: string,
  ) => Effect.Effect<{ available: boolean; reason?: string }, SSOError | EnterpriseErrorForAuth | Error>;
  readonly testSSOProvider: (
    orgId: string,
    providerId: string,
  ) => Effect.Effect<
    import("@useatlas/types").SSOTestResult,
    SSOError | EnterpriseErrorForAuth
  >;
  readonly findProviderByDomain: (
    emailDomain: string,
  ) => Effect.Effect<SSOProvider | null>;
  /** Strip secrets from a provider (pure helper). */
  readonly redactProvider: (provider: SSOProvider) => SSOProvider;
  /** Summarize a provider for list endpoints (pure helper). */
  readonly summarizeProvider: (provider: SSOProvider) => Omit<SSOProvider, "config">;
}
export class SSOPolicy extends Context.Tag("SSOPolicy")<
  SSOPolicy,
  SSOPolicyShape
>() {}
export const NoopSSOPolicyLayer: Layer.Layer<SSOPolicy> = Layer.sync(
  SSOPolicy,
  () => {

    const notAvailable = makeNotAvailable("SSO requires enterprise features to be enabled.");
    // Pure-helper inline copy of EE's `extractEmailDomain`. Pre-#2570
    // middleware called the EE static export; now it reaches it through
    // the Tag. The no-op needs the same parse so a self-hosted middleware
    // path can still classify emails without booting EE.
    const extractEmailDomain = (email: string): string | null => {
      if (typeof email !== "string") return null;
      const at = email.lastIndexOf("@");
      if (at <= 0 || at === email.length - 1) return null;
      return email.slice(at + 1).toLowerCase();
    };
    return {
      extractEmailDomain,
      isSSOEnforcedForDomain: () => Effect.succeed({ enforced: false }),
      isSSOEnforced: () => Effect.succeed({ enforced: false }),
      setSSOEnforcement: () => Effect.fail(notAvailable()),
      listSSOProviders: () => Effect.succeed([]),
      getSSOProvider: () => Effect.succeed(null),
      createSSOProvider: () => Effect.fail(notAvailable()),
      updateSSOProvider: () => Effect.fail(notAvailable()),
      // SECURITY: was `Effect.succeed(false)` pre-#2594 — route
      // returned 404, admin assumed provider gone. Provider stayed
      // in DB, still routing SSO logins. Fail loudly.
      deleteSSOProvider: () => Effect.fail(notAvailable()),
      verifyDomain: () => Effect.fail(notAvailable()),
      checkDomainAvailability: () => Effect.fail(notAvailable()),
      testSSOProvider: () => Effect.fail(notAvailable()) as never,
      findProviderByDomain: () => Effect.succeed(null),
      // Pure helpers — identity passthrough on the no-op since there's
      // never a real provider in the self-hosted path.
      redactProvider: (provider) => provider,
      summarizeProvider: (provider) => {
        const { config: _config, ...rest } = provider;
        return rest;
      },
    } satisfies SSOPolicyShape;
  },
);

// ── SCIMProvenance (#2570 — slice 8/11 of #2017) ─────────────────────
//
// Inverts `@atlas/ee/auth/scim` references in `packages/api/src/`: the
// static `isEnterpriseEnabled` gate in `lib/auth/scim-provenance.ts`
// (gate moves to Layer composition) and the full admin surface in
// `api/routes/admin-scim.ts`. EE overlays the real impl; the no-op
// reports `available: false` and returns empty lists.

type SCIMError = import("@atlas/api/lib/auth/auth-errors").SCIMError;
type SCIMConnectionShape = {
  readonly id: string;
  readonly providerId: string;
  readonly organizationId: string | null;
};
type SCIMSyncStatusShape = {
  readonly connections: number;
  readonly provisionedUsers: number;
  readonly lastSyncAt: string | null;
};
type SCIMGroupMappingShape = {
  readonly id: string;
  readonly orgId: string;
  readonly scimGroupName: string;
  readonly roleName: string;
  readonly createdAt: string;
};

export interface SCIMProvenanceShape {
  /** False when EE SCIM is not loaded — `isSCIMProvisioned` short-circuits to "non-SCIM" without hitting the DB. */
  readonly available: boolean;
  readonly listConnections: (
    orgId: string,
  ) => Effect.Effect<SCIMConnectionShape[], EnterpriseErrorForAuth>;
  readonly deleteConnection: (
    orgId: string,
    connectionId: string,
  ) => Effect.Effect<boolean, EnterpriseErrorForAuth>;
  readonly getSyncStatus: (
    orgId: string,
  ) => Effect.Effect<SCIMSyncStatusShape, EnterpriseErrorForAuth>;
  readonly listGroupMappings: (
    orgId: string,
  ) => Effect.Effect<SCIMGroupMappingShape[], EnterpriseErrorForAuth>;
  readonly createGroupMapping: (
    orgId: string,
    scimGroupName: string,
    atlasRole: string,
  ) => Effect.Effect<SCIMGroupMappingShape, SCIMError | EnterpriseErrorForAuth | Error>;
  readonly deleteGroupMapping: (
    orgId: string,
    mappingId: string,
  ) => Effect.Effect<boolean, EnterpriseErrorForAuth>;
  readonly resolveGroupToRole: (
    orgId: string,
    scimGroupName: string,
  ) => Effect.Effect<string | null, Error>;
}
export class SCIMProvenance extends Context.Tag("SCIMProvenance")<
  SCIMProvenance,
  SCIMProvenanceShape
>() {}
export const NoopSCIMProvenanceLayer: Layer.Layer<SCIMProvenance> = Layer.sync(
  SCIMProvenance,
  () => {

    const notAvailable = makeNotAvailable("SCIM provisioning requires enterprise features to be enabled.");
    return {
      available: false,
      listConnections: () => Effect.succeed([]),
      // Was `Effect.succeed(false)` pre-#2594 — route returned 404
      // so admin assumed the SCIM connection was deleted. Connection
      // stayed in DB; SCIM kept provisioning. Fail loudly.
      deleteConnection: () => Effect.fail(notAvailable()),
      getSyncStatus: () =>
        Effect.succeed({
          connections: 0,
          provisionedUsers: 0,
          lastSyncAt: null,
        }),
      listGroupMappings: () => Effect.succeed([]),
      createGroupMapping: () => Effect.fail(notAvailable()),
      // Same destructive-noop pattern as deleteConnection — fail loudly.
      deleteGroupMapping: () => Effect.fail(notAvailable()),
      resolveGroupToRole: () => Effect.succeed(null),
    } satisfies SCIMProvenanceShape;
  },
);

// ── RolesPolicy (#2571 — slice 9/11 of #2017) ────────────────────────
//
// Inverts every `@atlas/ee/auth/roles` reference in `packages/api/src/`:
// the `loadCheckPermission` lazy-import + `enforcePermission` chokepoint
// in `api/routes/admin-router.ts`, the `checkPermission` call surface
// used by `api/routes/admin.ts`, and the full custom-role CRUD imported
// by `api/routes/admin-roles.ts`. Permission flag types (`Permission`,
// `PERMISSIONS`, `isValidPermission`) already live in
// `lib/auth/permissions.ts` post-#2563 — this Tag wires the EE-side
// CRUD + permission resolution into a Layer.
//
// Fail-closed semantics: the no-op default returns
// `Effect.fail(EnterpriseError(...))` for the CRUD surface and emits
// the legacy F-53 503 `permissions_unavailable` shape from
// `checkPermission` when EE isn't loaded. This preserves the existing
// `loadCheckPermission` sentinel behaviour — an admin route can no
// longer collapse a fail-closed branch into a misleading 403.
//
// `RoleError` lives in `lib/auth/roles-errors.ts` so the Tag's failure
// channel stays typed without pulling in `@atlas/ee`.

type RolePermission = import("@atlas/api/lib/auth/permissions").Permission;
type AtlasUserForRoles = import("@atlas/api/lib/auth/types").AtlasUser;
type RoleError = import("@atlas/api/lib/auth/roles-errors").RoleError;
type EnterpriseErrorForRoles = import("@atlas/api/lib/effect/errors").EnterpriseError;

/** Persisted custom role row shape — mirrors `ee/src/auth/roles.ts:CustomRole`. */
export interface CustomRole {
  id: string;
  orgId: string;
  name: string;
  description: string;
  permissions: RolePermission[];
  isBuiltin: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateRoleInput {
  readonly name: string;
  readonly description?: string;
  readonly permissions: string[];
}

export interface UpdateRoleInput {
  readonly description?: string;
  readonly permissions?: string[];
}

export interface RoleMember {
  readonly userId: string;
  readonly role: string;
  readonly createdAt: string;
}

export interface AssignRoleResult {
  readonly userId: string;
  readonly role: string;
}

/**
 * Permission-check response — shape preserved from EE's pre-#2571
 * `checkPermission`: either `null` (allowed) or a JSON-ready body +
 * HTTP status pair the Hono middleware renders directly.
 */
export type PermissionCheckResult =
  | { readonly body: Record<string, unknown>; readonly status: 403 | 503 }
  | null;

export interface RolesPolicyShape {
  // ── Permission check (no enterprise gate — falls back to legacy mapping) ──
  /**
   * Returns `null` when the user holds `permission`, or a 403/503 body
   * to surface to the caller. The 503 path is the F-53 fail-closed
   * branch (EE absent / loader failure) — keeps the legacy
   * `permissions_unavailable` envelope so admin tooling sees the same
   * shape it always has.
   */
  readonly checkPermission: (
    user: AtlasUserForRoles | undefined,
    permission: RolePermission,
    requestId: string,
  ) => Effect.Effect<PermissionCheckResult>;

  // ── Custom role CRUD (enterprise-gated inside the EE impl) ──
  readonly listRoles: (
    orgId: string,
  ) => Effect.Effect<CustomRole[], EnterpriseErrorForRoles | Error>;
  readonly getRole: (
    orgId: string,
    roleId: string,
  ) => Effect.Effect<CustomRole | null, EnterpriseErrorForRoles>;
  readonly getRoleByName: (
    orgId: string,
    name: string,
  ) => Effect.Effect<CustomRole | null, EnterpriseErrorForRoles>;
  readonly createRole: (
    orgId: string,
    input: CreateRoleInput,
  ) => Effect.Effect<CustomRole, RoleError | EnterpriseErrorForRoles | Error>;
  readonly updateRole: (
    orgId: string,
    roleId: string,
    input: UpdateRoleInput,
  ) => Effect.Effect<CustomRole, RoleError | EnterpriseErrorForRoles | Error>;
  readonly deleteRole: (
    orgId: string,
    roleId: string,
  ) => Effect.Effect<boolean, RoleError | EnterpriseErrorForRoles | Error>;
  readonly listRoleMembers: (
    orgId: string,
    roleId: string,
  ) => Effect.Effect<RoleMember[], RoleError | EnterpriseErrorForRoles>;
  readonly assignRole: (
    orgId: string,
    userId: string,
    roleName: string,
  ) => Effect.Effect<AssignRoleResult, RoleError | EnterpriseErrorForRoles | Error>;
}
export class RolesPolicy extends Context.Tag("RolesPolicy")<
  RolesPolicy,
  RolesPolicyShape
>() {}

/**
 * No-op default for self-hosted (EE not loaded) + the failure-mode
 * fallback when EE's `RolesPolicyLive` can't bind.
 *
 * `checkPermission` delegates to the **real** `checkPermission` in
 * `lib/auth/permission-resolve.ts` — both core (no EE) and EE-installed
 * resolutions ultimately fall through to `LEGACY_ROLE_PERMISSIONS`
 * (admin/owner/platform_admin → all flags; member → query pair). This
 * preserves the pre-#2571 contract where self-hosted admins authored
 * with role `admin` reach every admin route.
 *
 * Fail-closed semantics: if `permission-resolve.ts` fails to load
 * (genuine module-load break), the Hono bridge catches the
 * `Effect.runPromise` defect at the `requirePermission` call site and
 * emits the 503 `permissions_unavailable` envelope — same shape as the
 * pre-#2571 `loadCheckPermission` sentinel.
 *
 * CRUD methods reject with `EnterpriseError` because the custom-role
 * surface is enterprise-only — the route handler's
 * `domainError(RoleError)` mapping handles `RoleError`, and the Hono
 * bridge maps `EnterpriseError` → 403 for the rest.
 */
export const NoopRolesPolicyLayer: Layer.Layer<RolesPolicy> = Layer.sync(
  RolesPolicy,
  () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { EnterpriseError: EnterpriseErrorClass } = require("@atlas/api/lib/effect/errors") as {
      EnterpriseError: new (message?: string) => EnterpriseErrorForRoles;
    };
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { checkPermissionLegacy } = require("@atlas/api/lib/auth/permission-resolve") as typeof import("@atlas/api/lib/auth/permission-resolve");
    const notAvailable = (feature: string) =>
      new EnterpriseErrorClass(
        `Custom roles (${feature}) require enterprise features to be enabled.`,
      );
    return {
      // `checkPermission` deliberately delegates to the legacy resolver
      // — every admin route depends on this surface, and the no-op MUST
      // continue to authorize admin/owner/platform_admin on self-hosted
      // installs. EE's `RolesPolicyLive` re-binds to the full
      // `checkPermission` so workspaces with seeded roles get granular
      // resolution. (See `lib/auth/permission-resolve.ts`.)
      checkPermission: checkPermissionLegacy,
      // All custom-role CRUD methods consistently fail with EnterpriseError
      // on self-hosted. Pre-#2594 the reads silently returned empty arrays
      // and the writes failed — UI dead-end (admin sees "no roles yet,
      // click create" → click → 403). Failing both sides surfaces a single
      // coherent gate the UI renders as the enterprise-upsell envelope.
      listRoles: () => Effect.fail(notAvailable("listRoles")),
      getRole: () => Effect.fail(notAvailable("getRole")),
      getRoleByName: () => Effect.fail(notAvailable("getRoleByName")),
      createRole: () => Effect.fail(notAvailable("createRole")),
      updateRole: () => Effect.fail(notAvailable("updateRole")),
      deleteRole: () => Effect.fail(notAvailable("deleteRole")),
      listRoleMembers: () => Effect.fail(notAvailable("listRoleMembers")),
      assignRole: () => Effect.fail(notAvailable("assignRole")),
    } satisfies RolesPolicyShape;
  },
);

// ── Branding (#2572 — slice 10/11 of #2017) ──────────────────────────
//
// Inverts every `@atlas/ee/branding/white-label` reference in
// `packages/api/src/`: the static imports in `api/routes/admin-branding.ts`
// + `public-branding.ts`. EE serves per-workspace white-label config;
// the no-op default returns `null` (read fallthrough — frontend renders
// Atlas defaults) and fails writes with `EnterpriseError` so the routes'
// existing `domainError(BrandingError)` + `EnterpriseError → 403`
// mapping renders the upsell envelope.
//
// `BrandingError` lives in `lib/branding/branding-errors.ts` so the
// Tag's failure channel stays typed without pulling in `@atlas/ee`.

type WorkspaceBranding = import("@useatlas/types").WorkspaceBranding;
type SetWorkspaceBrandingInput =
  import("@useatlas/types").SetWorkspaceBrandingInput;
type BrandingError =
  import("@atlas/api/lib/branding/branding-errors").BrandingError;
type EnterpriseErrorForBranding =
  import("@atlas/api/lib/effect/errors").EnterpriseError;

export interface BrandingShape {
  /** Admin endpoint — enterprise-gated. */
  readonly getWorkspaceBranding: (
    orgId: string,
  ) => Effect.Effect<WorkspaceBranding | null, EnterpriseErrorForBranding>;
  /** Public endpoint — skips the enterprise gate so existing branding
   * keeps rendering when a license lapses. */
  readonly getWorkspaceBrandingPublic: (
    orgId: string,
  ) => Effect.Effect<WorkspaceBranding | null>;
  readonly setWorkspaceBranding: (
    orgId: string,
    input: SetWorkspaceBrandingInput,
  ) => Effect.Effect<
    WorkspaceBranding,
    BrandingError | EnterpriseErrorForBranding | Error
  >;
  readonly deleteWorkspaceBranding: (
    orgId: string,
  ) => Effect.Effect<boolean, EnterpriseErrorForBranding | Error>;
}
export class Branding extends Context.Tag("Branding")<
  Branding,
  BrandingShape
>() {}
export const NoopBrandingLayer: Layer.Layer<Branding> = Layer.sync(
  Branding,
  () => {
    const notAvailable = makeNotAvailable("Workspace branding requires enterprise features to be enabled.",);
    return {
      getWorkspaceBranding: () => Effect.fail(notAvailable()),
      getWorkspaceBrandingPublic: () => Effect.succeed(null),
      setWorkspaceBranding: () => Effect.fail(notAvailable()),
      deleteWorkspaceBranding: () => Effect.fail(notAvailable()),
    } satisfies BrandingShape;
  },
);

// ── Domains (#2572 — slice 10/11 of #2017) ───────────────────────────
//
// Inverts every `@atlas/ee/platform/domains` reference in
// `packages/api/src/`: the `loadDomains()` dynamic-import in
// `api/routes/shared-domains.ts` (consumed by `admin-domains.ts`). EE
// manages custom-domain mappings; the no-op default reports `available:
// false` and fails writes with `EnterpriseError` so the admin page
// continues to render its enterprise-upsell envelope.
//
// `DomainError` lives in `lib/platform/domains-errors.ts` so the Tag's
// failure channel stays typed without pulling in `@atlas/ee`.

type CustomDomain = import("@useatlas/types").CustomDomain;
type DomainError =
  import("@atlas/api/lib/platform/domains-errors").DomainError;
type EnterpriseErrorForDomains =
  import("@atlas/api/lib/effect/errors").EnterpriseError;

export interface DomainsShape {
  /** False when EE custom domains aren't loaded — `admin-domains.ts` + `platform-domains.ts` return 404 `not_available` for the management surface. */
  readonly available: boolean;
  readonly registerDomain: (
    workspaceId: string,
    domain: string,
  ) => Effect.Effect<CustomDomain, DomainError | EnterpriseErrorForDomains | Error>;
  readonly verifyDomain: (
    domainId: string,
  ) => Effect.Effect<CustomDomain, DomainError | EnterpriseErrorForDomains | Error>;
  readonly verifyDomainDnsTxt: (
    domainId: string,
  ) => Effect.Effect<CustomDomain, DomainError | EnterpriseErrorForDomains | Error>;
  readonly listDomains: (
    workspaceId: string,
  ) => Effect.Effect<CustomDomain[], DomainError | EnterpriseErrorForDomains | Error>;
  readonly listAllDomains: () => Effect.Effect<
    CustomDomain[],
    DomainError | EnterpriseErrorForDomains | Error
  >;
  readonly deleteDomain: (
    domainId: string,
  ) => Effect.Effect<void, DomainError | EnterpriseErrorForDomains | Error>;
  readonly checkDomainAvailability: (
    domain: string,
    workspaceId: string,
  ) => Effect.Effect<
    { available: boolean; reason?: string },
    DomainError | EnterpriseErrorForDomains | Error
  >;
  readonly hasVerifiedCustomDomain: (
    workspaceId: string,
    domain: string,
  ) => Effect.Effect<boolean, Error>;
  readonly resolveWorkspaceByHost: (
    hostname: string,
  ) => Effect.Effect<string | null>;
  /** Redact the verification token from a CustomDomain before returning
   * to API consumers. Synchronous — no Effect wrapping. */
  readonly redactDomain: (
    domain: CustomDomain,
    includeToken?: boolean,
  ) => CustomDomain;
}
export class Domains extends Context.Tag("Domains")<
  Domains,
  DomainsShape
>() {}
export const NoopDomainsLayer: Layer.Layer<Domains> = Layer.sync(
  Domains,
  () => {
    const notAvailable = makeNotAvailable("Custom domains require enterprise features to be enabled.",);
    return {
      available: false,
      registerDomain: () => Effect.fail(notAvailable()),
      verifyDomain: () => Effect.fail(notAvailable()),
      verifyDomainDnsTxt: () => Effect.fail(notAvailable()),
      listDomains: () => Effect.succeed([]),
      listAllDomains: () => Effect.succeed([]),
      deleteDomain: () => Effect.fail(notAvailable()),
      checkDomainAvailability: () =>
        Effect.succeed({
          available: false,
          reason: "Custom domains are not available.",
        }),
      hasVerifiedCustomDomain: () => Effect.succeed(false),
      resolveWorkspaceByHost: () => Effect.succeed(null),
      redactDomain: (d) => d,
    } satisfies DomainsShape;
  },
);

// ── ProactiveGate (#2572 — slice 10/11 of #2017) ─────────────────────
//
// Replaces `requireEnterpriseEffect("proactive-chat")` in the four
// `admin-proactive-*` routes. EE gates the proactive chat surface
// (PRD #2291 — 1.5.0 paid tier); the no-op default fails with
// `EnterpriseError` so non-enterprise tenants see 403
// `enterprise_required` and the admin page routes through
// `EnterpriseUpsell` / `<FeatureGate feature="Proactive Chat">`.

type EnterpriseErrorForProactive =
  import("@atlas/api/lib/effect/errors").EnterpriseError;

export interface ProactiveGateShape {
  /** Effect-style guard. `Effect.void` when enterprise is enabled,
   * `Effect.fail(EnterpriseError)` otherwise. The route layer's
   * `classifyError` maps that to a 403 `enterprise_required` envelope.
   *
   * Re-reads the enterprise flag on every call (Effect wrapper closes
   * over the EE-side `isEnterpriseEnabled()`) so a runtime flip
   * propagates without restart. */
  readonly requireEnabled: () => Effect.Effect<
    void,
    EnterpriseErrorForProactive
  >;
}
export class ProactiveGate extends Context.Tag("ProactiveGate")<
  ProactiveGate,
  ProactiveGateShape
>() {}
export const NoopProactiveGateLayer: Layer.Layer<ProactiveGate> = Layer.sync(
  ProactiveGate,
  () => {
    const notAvailable = makeNotAvailable("Proactive chat requires enterprise features to be enabled.");
    return {
      requireEnabled: () => Effect.fail(notAvailable()),
    } satisfies ProactiveGateShape;
  },
);

// ── DeployModeResolver (#2572 — slice 10/11 of #2017) ────────────────
//
// Replaces `await import("@atlas/ee/deploy-mode")` in `lib/config.ts`.
// Resolution logic moved to `lib/effect/deploy-mode.ts` in core
// (`resolveDeployMode`); EE re-exports for back-compat. The Tag still
// exists because some non-config callers (e.g. agent-loop telemetry,
// SaaS guards) may eventually want to yield it. The no-op default
// always reports `"self-hosted"` (the correct answer when EE is not
// loaded — `"saas"` mode requires enterprise).

export interface DeployModeResolverShape {
  readonly resolve: () => "saas" | "self-hosted";
}
export class DeployModeResolver extends Context.Tag("DeployModeResolver")<
  DeployModeResolver,
  DeployModeResolverShape
>() {}
export const NoopDeployModeResolverLayer: Layer.Layer<DeployModeResolver> =
  Layer.succeed(DeployModeResolver, {
    resolve: () => "self-hosted",
  } satisfies DeployModeResolverShape);

// ── SaasCrm ──────────────────────────────────────────────────────────
//
// SaaS-only CRM dispatch (Twenty). Self-hosted gets the Noop layer.

/**
 * Inputs to `SaasCrm.upsertLead`. Mirrors the discriminated union in
 * `plugins/twenty/src/lead-normalizer.ts:AtlasLeadEvent`. Drift between the
 * two is caught at compile time by the `_leadUnionsAreMirrors` bridge in
 * `ee/src/saas-crm/index.ts` (the EE layer is the only place allowed to
 * depend on both unions) — an exact-type-equality assertion that fails
 * `tsgo` if the unions diverge in any way (a variant added on one side, or
 * a field's shape changed on just one side). The normalizer's
 * exhaustiveness switch is the runtime backstop: were a divergence to slip
 * past the bridge, the next dispatch dead-letters with `Unknown lead source`
 * rather than silently swallowing.
 *
 * Adding a variant: extend BOTH this union AND `AtlasLeadEvent`, or the
 * bridge goes red. The two-place duplication exists because the runtime queue
 * (`lib/lead-outbox/`) and the route layer (the `SaasCrm` Tag's
 * `upsertLead` contract surface) intentionally stay free of any
 * `@useatlas/twenty` import — the EE dispatcher is the only allowed
 * cross-boundary consumer. The one-shot operator backfill at
 * `lib/db/migrations/scripts/backfill-crm-leads.ts` is the documented
 * carve-out: it imports `normalizeLead` to render dry-run previews,
 * and `@useatlas/twenty` is therefore a runtime dep of `@atlas/api`.
 * Promote to `@useatlas/types` when a second consumer of the union
 * itself (not the normalizer) appears.
 */
export type SaasCrmLeadInput =
  | {
      readonly source: "demo";
      readonly email: string;
      readonly ip?: string | null;
      readonly userAgent?: string | null;
    }
  | {
      readonly source: "sales-form";
      readonly email: string;
      /** Full name as typed by the prospect — split into first/last at the seam. */
      readonly name: string;
      readonly company: string;
      readonly planInterest: string;
      /** Free-text message body — becomes the attached Twenty Note's body. */
      readonly message: string;
      readonly ip?: string | null;
      readonly userAgent?: string | null;
    }
  | {
      readonly source: "signup";
      readonly email: string;
      /**
       * Better Auth `user.name` — optional because email-only signup is
       * allowed. Split into first/last at the normalizer seam.
       */
      readonly name?: string;
    }
  | {
      /**
       * Stripe → Twenty conversion stamping (#2737). Fired from the
       * `onSubscriptionComplete` Better Auth hook after a paying
       * checkout. The dispatcher stamps `customFields.atlasStripeCustomerId`
       * on the Twenty Person matching `email`; if no Person exists,
       * `upsertPerson` creates one with `atlasFirstSource = "CONVERSION"`
       * so the stamp is never lost.
       */
      readonly source: "conversion";
      readonly email: string;
      /** Stripe `customer.id` (`cus_…`). */
      readonly stripeCustomerId: string;
    };

/**
 * Inputs to `SaasCrm.stampConversion`. Derived from the `conversion`
 * variant of `SaasCrmLeadInput` so a future field addition (e.g.
 * `paidPlanInterval`) only needs to touch the union — this interface
 * tracks automatically. Kept as a distinct type so the call site (the
 * Stripe webhook hook) stays a flat call —
 * `crm.stampConversion({ email, stripeCustomerId })` — without needing
 * to construct a discriminated union literal.
 */
export type SaasCrmStampConversionInput = Omit<
  Extract<SaasCrmLeadInput, { source: "conversion" }>,
  "source"
>;

/**
 * Discriminated SaasCrm shape — `available` is the operator-pipeline
 * health flag; `dispatcher` is the per-row outbox dispatcher and
 * survives operator-probe failure (#2849 codex I2) because the
 * dispatcher routes per-row: customer-workspace rows have their own
 * credentials in `twenty_integrations` and have nothing to do with the
 * operator's `TWENTY_API_KEY`.
 *
 * `available === false` ⇒ operator pipeline unavailable (POST /contact
 *   returns 404; upsertLead/stampConversion are no-ops). The
 *   `dispatcher` may still be present when only the operator boot
 *   probe failed — in that case operator-pipeline rows in `crm_outbox`
 *   dead-letter with a permanent message, but per-tenant rows route
 *   normally. `dispatcher` is `null` only when there is no way to
 *   dispatch anything (self-hosted with no EE, or no internal DB).
 * `available === true`  ⇒ both operator + tenant dispatch healthy;
 *   `dispatcher` is non-null and the flusher mounts.
 *
 * `upsertLead` is shared across both — even an `available: false` layer
 * accepts the call as a no-op so callers don't need to branch.
 */
export type SaasCrmShape =
  | {
      /**
       * `POST /api/v1/contact` reads this to return 404 `not_available`
       * on self-hosted (or when the SaaS layer failed boot verification)
       * rather than the standard 403 envelope.
       *
       * Flips to `false` on any of:
       *  - self-hosted (`@atlas/ee` not loaded → `NoopSaasCrmLayer`);
       *  - `@useatlas/twenty` credentials unresolvable at boot;
       *  - Twenty metadata probe returns 401/403/404 (deterministic
       *    misconfiguration);
       *  - any of `REQUIRED_PERSON_FIELDS` is missing on the Twenty
       *    Person object (`atlasFirstSource` / `atlasLastSource` /
       *    `atlasStripeCustomerId` — #2737). Missing custom fields
       *    would dead-letter every dispatch on a 422 schema mismatch,
       *    so the boot-time guard disables the layer instead.
       *  - `resolveOperatorWorkspaceId` boot SELECT throws a non-
       *    "table missing" pg error (#2849 codex C2). Fail-loud rather
       *    than silently masking already-stamped rows with the sentinel.
       *
       * NOTE: `available: false` no longer implies "no dispatcher".
       * See `dispatcher` below — per-tenant rows can still flush when
       * only the operator probe is broken.
       */
      readonly available: false;
      readonly upsertLead: (input: SaasCrmLeadInput) => Effect.Effect<void, Error>;
      /**
       * Stripe → Twenty conversion stamping (#2737). Noop on
       * self-hosted / EE-disabled — same fail-soft pattern as
       * `upsertLead`.
       */
      readonly stampConversion: (
        input: SaasCrmStampConversionInput,
      ) => Effect.Effect<void, Error>;
      /**
       * Outbox dispatcher when only the operator probe failed (EE on +
       * InternalDB present + operator creds/probe/workspace-resolve
       * broken). Tenant rows route normally via per-row
       * `twenty_integrations` lookup; operator-pipeline rows
       * (workspace_id matches resolved operator id or sentinel)
       * dead-letter with `{ kind: "permanent" }` and an actionable
       * message pointing the operator at the failed boot log.
       *
       * `null` only when there is no way to dispatch anything at all:
       * self-hosted (no EE) or no internal DB. The flusher uses
       * `dispatcher !== null` as the mount gate (#2849 codex I2).
       */
      readonly dispatcher:
        | ((
            row: import("@atlas/api/lib/lead-outbox").ClaimedOutboxRow,
            persist: import("@atlas/api/lib/lead-outbox").OutboxPersistHelpers,
          ) => Promise<import("@atlas/api/lib/lead-outbox").DispatchOutcome>)
        | null;
    }
  | {
      readonly available: true;
      /**
       * Enqueue a lead row into `crm_outbox` for durable dispatch by
       * the scheduler-backed flusher. Returns `Effect.void` on success;
       * fails with the raw `Error` when the Postgres write fails so the
       * caller can decide whether to surface a 5xx (sales form — every
       * lost lead is a missed revenue conversation) or swallow with a
       * structured log (demo — user already has a sandbox link).
       */
      readonly upsertLead: (input: SaasCrmLeadInput) => Effect.Effect<void, Error>;
      /**
       * Enqueue a `stamp-conversion` row into `crm_outbox` for durable
       * dispatch (#2737). The Stripe webhook handler calls this from
       * `onSubscriptionComplete` and returns immediately so webhook ack
       * latency stays unchanged. The flusher's per-row dispatcher
       * routes the row through the same `upsertPerson` codepath as
       * other lead variants — the `conversion` normalizer attaches
       * `atlasStripeCustomerId` to the Person on every write path.
       */
      readonly stampConversion: (
        input: SaasCrmStampConversionInput,
      ) => Effect.Effect<void, Error>;
      /**
       * Per-row dispatcher the scheduler-backed flusher calls inside
       * `flushBatch`. Defined here (not in `@atlas/ee`) so
       * `lib/effect/layers.ts:makeSchedulerLive` can `yield* SaasCrm`
       * to fetch it without importing from `@atlas/ee` (the `core →
       * ee` boundary is enforced by `check-ee-imports.sh`).
       */
      readonly dispatcher: (
        row: import("@atlas/api/lib/lead-outbox").ClaimedOutboxRow,
        persist: import("@atlas/api/lib/lead-outbox").OutboxPersistHelpers,
      ) => Promise<import("@atlas/api/lib/lead-outbox").DispatchOutcome>;
    };

export class SaasCrm extends Context.Tag("SaasCrm")<SaasCrm, SaasCrmShape>() {}

/**
 * No-op default: SaaS CRM dispatch unavailable.
 *
 * `stampConversion` warns on every call — a Stripe → Twenty conversion
 * landing while SaasCrm is unavailable means a paying-customer Person
 * record was not stamped, which is a revenue record-keeping gap an
 * operator wants observable per-call (not just at boot). `upsertLead`
 * stays silent because demo / signup volume is high enough that per-call
 * warning would be log spam; operators should rely on the boot-time
 * `saas_crm.openapi_unreachable` / `saas_crm.custom_fields_missing`
 * structured logs for unavailable-layer alerting, plus the `crm_outbox`
 * table row-count for visibility into the demo / signup path.
 */
const saasCrmLog = createLogger("effect:saas-crm");
export const NoopSaasCrmLayer: Layer.Layer<SaasCrm> = Layer.succeed(SaasCrm, {
  available: false,
  upsertLead: () => Effect.void,
  stampConversion: (input) =>
    Effect.sync(() => {
      saasCrmLog.warn(
        {
          email: input.email,
          stripeCustomerId: input.stripeCustomerId,
          event: "saas_crm.stamp_skipped_unavailable",
        },
        "SaasCrm.stampConversion called while available=false — Stripe conversion not stamped on Twenty Person. " +
          "Check boot logs for the original 'saas_crm.openapi_*' event that flipped the layer to unavailable.",
      );
    }),
  // No EE → no per-tenant dispatcher either. The flusher gate
  // (`saasCrm.dispatcher !== null`) skips wiring entirely.
  dispatcher: null,
} satisfies SaasCrmShape);

// ── Aggregate no-op default Layer ────────────────────────────────────
//
// Merged into `buildAppLayer()` so every enterprise Tag has a default
// implementation. When EE is enabled, `EELayer` from `@atlas/ee/layers`
// is merged on top — later Layers override earlier ones for the same
// Tag, so EE's `Layer.effect` impls win.

export const NoopEnterpriseDefaultsLayer: Layer.Layer<
  | ResidencyResolver
  | ModelRouter
  | MaskingPolicy
  | ComplianceReports
  | ApprovalGate
  | SlaMetrics
  | BackupsManager
  | AuditRetention
  | AuditPurgeScheduler
  | IpAllowlistPolicy
  | SSOPolicy
  | SCIMProvenance
  | RolesPolicy
  | Branding
  | Domains
  | ProactiveGate
  | DeployModeResolver
  | SaasCrm
> = Layer.mergeAll(
  NoopResidencyResolverLayer,
  NoopModelRouterLayer,
  NoopMaskingPolicyLayer,
  NoopComplianceReportsLayer,
  NoopApprovalGateLayer,
  NoopSlaMetricsLayer,
  NoopBackupsManagerLayer,
  NoopAuditRetentionLayer,
  NoopAuditPurgeSchedulerLayer,
  NoopIpAllowlistPolicyLayer,
  NoopSSOPolicyLayer,
  NoopSCIMProvenanceLayer,
  NoopRolesPolicyLayer,
  NoopBrandingLayer,
  NoopDomainsLayer,
  NoopProactiveGateLayer,
  NoopDeployModeResolverLayer,
  NoopSaasCrmLayer,
);

// ══════════════════════════════════════════════════════════════════════
// ██  WorkspaceInstaller (#2742 — slice 4 of 1.5.3)
// ══════════════════════════════════════════════════════════════════════
//
// Write-side facade for integration install / uninstall / updateConfig
// across the chat + action pillars. Per ADR-0007 the facade orchestrates
// the existing per-Platform install handlers from
// `lib/integrations/install/`; it does NOT unify credential stores
// (deferred). Datasource installs (`pillar = 'datasource'`) pivot in
// slice 6 (#2744) once the `connections` table cutover lands.
//
// The Tag, Shape, Live Layer, tagged errors, and test-layer factory live
// in `./workspace-installer` because the file carries enough surface
// (per-input-kind dispatch, catalog-schema validation, two-store teardown
// sequencing) that inlining would crowd this services barrel. Re-exported
// here so consumers can keep reaching for `@atlas/api/lib/effect/services`
// as the discovery seam for every backend service Tag.

export {
  WorkspaceInstaller,
  WorkspaceInstallerLive,
  createWorkspaceInstallerTestLayer,
  INTEGRATION_CREDENTIALS_SLUGS,
  type WorkspaceInstallerShape,
  type WorkspaceInstallRow,
  type InstallInput,
  type InstallResult,
  type InstallError,
} from "./workspace-installer";

// ══════════════════════════════════════════════════════════════════════
// ██  PillarCatalogQuery (#2741 — slice 3 of 1.5.3)
// ══════════════════════════════════════════════════════════════════════
//
// Read-side facade over `plugin_catalog` × `workspace_plugins` that
// applies the install-status state machine per row. The Tag, Shape,
// Live Layer, and test-layer factory live in `./pillar-catalog-query`
// because the file carries enough surface (SQL projection helpers,
// state-machine bridge, two row mapper functions) that inlining would
// crowd this services barrel. Re-exported here so consumers can keep
// reaching for "@atlas/api/lib/effect/services" as the discovery seam
// for every backend service Tag.
//
// New rows on the catalog wire shape land in #2741 (`pillar`,
// `implementation_status`). Slice 8 consumes `pillar` for the
// admin-UI section split; slice 9 consumes `implementation_status` for
// the coming-soon badge.

export {
  PillarCatalogQuery,
  PillarCatalogQueryLive,
  createPillarCatalogQueryTestLayer,
  projectCatalogWithInstalls,
  type PillarCatalogQueryShape,
  type CatalogEntry,
  type CatalogEntryWithState,
  type WorkspaceInstall,
  type WorkspacePlanContext,
} from "./pillar-catalog-query";
