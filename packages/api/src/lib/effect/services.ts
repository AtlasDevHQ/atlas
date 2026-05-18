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
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { EnterpriseError: EnterpriseErrorClass } = require("@atlas/api/lib/effect/errors") as {
      EnterpriseError: new (message?: string) => EnterpriseError;
    };
    const notAvailable = () => new EnterpriseErrorClass("Model routing requires enterprise features to be enabled.");
    return {
      available: false,
      getWorkspaceModelConfig: () => Effect.succeed(null),
      getWorkspaceModelConfigRaw: () => Effect.succeed(null),
      setWorkspaceModelConfig: () => Effect.fail(notAvailable()),
      deleteWorkspaceModelConfig: () => Effect.succeed(false),
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
  /** False when EE compliance is not loaded — `applyMasking` becomes identity. */
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
      applyMasking: (ctx) => Effect.succeed([...ctx.rows]),
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
  readonly available: boolean;
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
      available: false,
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
  /** False when EE approval workflows aren't loaded — gate bypasses entirely. */
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
    return {
      available: false,
      checkApprovalRequired: () =>
        Effect.succeed({ required: false, matchedRules: [] }),
      hasApprovedRequest: () => Effect.succeed(false),
      // `createApprovalRequest` is only reached when checkApprovalRequired
      // returns `required: true`. With the no-op gate that's never the
      // case, so this is a defensive impl — die so a regression that
      // routes through here is loud rather than silent.
      createApprovalRequest: () =>
        Effect.die("createApprovalRequest called against no-op ApprovalGate"),
      listApprovalRules: () => Effect.succeed([]),
      createApprovalRule: (_orgId, _input) =>
        Effect.fail(notFound("__no_op__")),
      updateApprovalRule: (_orgId, ruleId) =>
        Effect.fail(notFound(ruleId)),
      deleteApprovalRule: () => Effect.succeed(false),
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
export const NoopSlaMetricsLayer: Layer.Layer<SlaMetrics> = Layer.succeed(
  SlaMetrics,
  {
    available: false,
    recordQueryMetric: () => Effect.void,
    getAllWorkspaceSLA: () => Effect.succeed([]),
    getWorkspaceSLADetail: () =>
      Effect.die("SLA monitoring requires enterprise features to be enabled."),
    getThresholds: () =>
      Effect.die("SLA monitoring requires enterprise features to be enabled."),
    updateThresholds: () =>
      Effect.die("SLA monitoring requires enterprise features to be enabled."),
    getAlerts: () => Effect.succeed([]),
    acknowledgeAlert: () => Effect.succeed(false),
    evaluateAlerts: () => Effect.succeed([]),
  } satisfies SlaMetricsShape,
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
};

export type CreateBackupResult = {
  readonly id: string;
  readonly storagePath: string;
  readonly sizeBytes: number;
  readonly status: string;
};

export interface BackupsManagerShape {
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
  ) => Effect.Effect<{ verified: boolean; message: string }, Error>;
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
export const NoopBackupsManagerLayer: Layer.Layer<BackupsManager> = Layer.succeed(
  BackupsManager,
  {
    available: false,
    getBackupConfig: () => Effect.die("Backups not configured."),
    updateBackupConfig: () => Effect.die("Backups not configured."),
    createBackup: () => Effect.die("Backups not configured."),
    listBackups: () => Effect.succeed([]),
    getBackupById: () => Effect.succeed(null),
    purgeExpiredBackups: () => Effect.succeed(0),
    verifyBackup: () => Effect.die("Backups not configured."),
    requestRestore: () => Effect.die("Backups not configured."),
    executeRestore: () => Effect.die("Backups not configured."),
  } satisfies BackupsManagerShape,
);

// ── AuditRetention (#2569 — slice 7/11 of #2017) ─────────────────────
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
  // Purge scheduler lifecycle — replaces the
  // `await import("@atlas/ee/audit/purge-scheduler")` site in
  // `makeSchedulerLive` (#2569). No-op when EE isn't loaded; the
  // scheduler layer calls both without a feature flag.
  readonly startAuditPurgeScheduler: (intervalMs?: number) => void;
  readonly stopAuditPurgeScheduler: () => void;
}
export class AuditRetention extends Context.Tag("AuditRetention")<
  AuditRetention,
  AuditRetentionShape
>() {}
export const NoopAuditRetentionLayer: Layer.Layer<AuditRetention> = Layer.sync(
  AuditRetention,
  () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { EnterpriseError: EnterpriseErrorClass } = require("@atlas/api/lib/effect/errors") as {
      EnterpriseError: new (message?: string) => EnterpriseErrorForRetention;
    };
    const notAvailable = () =>
      new EnterpriseErrorClass("Audit retention requires enterprise features to be enabled.");
    return {
      available: false,
      getRetentionPolicy: () => Effect.succeed(null),
      setRetentionPolicy: () => Effect.fail(notAvailable()),
      purgeExpiredEntries: () => Effect.succeed([]),
      hardDeleteExpired: () => Effect.succeed({ deletedCount: 0 }),
      exportAuditLog: () => Effect.fail(notAvailable()),
      getAdminActionRetentionPolicy: () => Effect.succeed(null),
      setAdminActionRetentionPolicy: () => Effect.fail(notAvailable()),
      purgeAdminActionExpired: () => Effect.succeed([]),
      anonymizeUserAdminActions: () =>
        Effect.succeed({ anonymizedRowCount: 0 }),
      previewAdminActionErasure: () =>
        Effect.succeed({ anonymizableRowCount: 0 }),
      startAuditPurgeScheduler: () => {},
      stopAuditPurgeScheduler: () => {},
    } satisfies AuditRetentionShape;
  },
);

// ── IpAllowlistPolicy (#2572) ────────────────────────────────────────
//
// Replaces `await import("@atlas/ee/auth/ip-allowlist")` in
// `api/routes/middleware.ts` + chat / auth-preamble / admin-auth /
// admin-ip-allowlist. EE checks client IP against per-org allowlist;
// core's no-op always allows.

export interface IpAllowlistPolicyShape {
  readonly checkAllowed: (
    ip: string,
    orgId: string,
  ) => Promise<{ readonly allowed: boolean; readonly reason?: string }>;
}
export class IpAllowlistPolicy extends Context.Tag("IpAllowlistPolicy")<
  IpAllowlistPolicy,
  IpAllowlistPolicyShape
>() {}
export const NoopIpAllowlistPolicyLayer: Layer.Layer<IpAllowlistPolicy> =
  Layer.succeed(IpAllowlistPolicy, {
    checkAllowed: async () => ({ allowed: true }),
  } satisfies IpAllowlistPolicyShape);

// ── SSOPolicy (slice TBD) ────────────────────────────────────────────
//
// Replaces `import { ... } from "@atlas/ee/auth/sso"` in
// `api/routes/admin-sso.ts`. EE manages SSO providers; core's no-op
// reports the feature unavailable.

export interface SSOPolicyShape {
  readonly available: boolean;
}
export class SSOPolicy extends Context.Tag("SSOPolicy")<
  SSOPolicy,
  SSOPolicyShape
>() {}
export const NoopSSOPolicyLayer: Layer.Layer<SSOPolicy> = Layer.succeed(
  SSOPolicy,
  {
    available: false,
  } satisfies SSOPolicyShape,
);

// ── SCIMProvenance (slice TBD) ───────────────────────────────────────
//
// Replaces `import { ... } from "@atlas/ee/auth/scim"` in
// `api/routes/admin-scim.ts`. EE tracks SCIM-managed user provenance;
// core's no-op reports nothing is SCIM-managed.

export interface SCIMProvenanceShape {
  readonly isManaged: (userId: string) => Promise<boolean>;
}
export class SCIMProvenance extends Context.Tag("SCIMProvenance")<
  SCIMProvenance,
  SCIMProvenanceShape
>() {}
export const NoopSCIMProvenanceLayer: Layer.Layer<SCIMProvenance> = Layer.succeed(
  SCIMProvenance,
  {
    isManaged: async () => false,
  } satisfies SCIMProvenanceShape,
);

// ── RolesPolicy (slice TBD) ──────────────────────────────────────────
//
// Replaces `(await import("@atlas/ee/auth/roles")).checkPermission` in
// `api/routes/admin-router.ts`. EE resolves user permissions via the
// `custom_roles` table; core's no-op falls back to `LEGACY_ROLE_PERMISSIONS`
// which EE already implements in `ee/src/auth/roles.ts` —
// `RolesPolicy`'s shape will be the typed Permission flag set already
// hosted in `@atlas/api/lib/auth/permissions`.

export interface RolesPolicyShape {
  /** True when EE has wired the custom-role surface; false → legacy mapping. */
  readonly customRolesActive: boolean;
}
export class RolesPolicy extends Context.Tag("RolesPolicy")<
  RolesPolicy,
  RolesPolicyShape
>() {}
export const NoopRolesPolicyLayer: Layer.Layer<RolesPolicy> = Layer.succeed(
  RolesPolicy,
  {
    customRolesActive: false,
  } satisfies RolesPolicyShape,
);

// ── Branding (slice TBD) ─────────────────────────────────────────────
//
// Replaces `import { ... } from "@atlas/ee/branding/white-label"` in
// `api/routes/admin-branding.ts` + `public-branding.ts`. EE serves
// per-workspace white-label config; core's no-op returns `null` so
// the public surface falls back to Atlas branding.

export interface BrandingShape {
  readonly getWorkspaceBrandingPublic: (
    orgId: string,
  ) => Promise<unknown | null>;
}
export class Branding extends Context.Tag("Branding")<
  Branding,
  BrandingShape
>() {}
export const NoopBrandingLayer: Layer.Layer<Branding> = Layer.succeed(Branding, {
  getWorkspaceBrandingPublic: async () => null,
} satisfies BrandingShape);

// ── Domains (slice TBD) ──────────────────────────────────────────────
//
// Replaces `await import("@atlas/ee/platform/domains")` in
// `api/routes/shared-domains.ts` + `admin-domains.ts`. EE manages
// custom-domain mappings; core's no-op reports none configured.

export interface DomainsShape {
  readonly available: boolean;
}
export class Domains extends Context.Tag("Domains")<
  Domains,
  DomainsShape
>() {}
export const NoopDomainsLayer: Layer.Layer<Domains> = Layer.succeed(Domains, {
  available: false,
} satisfies DomainsShape);

// ── ProactiveGate (slice TBD) ────────────────────────────────────────
//
// Replaces `requireEnterpriseEffect("proactive")` + the
// `admin-proactive-*` route guards. EE gates the proactive chat
// surface; core's no-op reports unavailable so the feature is hidden.

export interface ProactiveGateShape {
  readonly enabled: boolean;
}
export class ProactiveGate extends Context.Tag("ProactiveGate")<
  ProactiveGate,
  ProactiveGateShape
>() {}
export const NoopProactiveGateLayer: Layer.Layer<ProactiveGate> = Layer.succeed(
  ProactiveGate,
  {
    enabled: false,
  } satisfies ProactiveGateShape,
);

// ── DeployModeResolver (slice TBD) ───────────────────────────────────
//
// Replaces `await import("@atlas/ee/deploy-mode")` in `lib/config.ts`.
// EE resolves `"saas" | "self-hosted"` from env + internal-DB presence;
// core's no-op always reports `"self-hosted"` (the correct answer when
// EE is not loaded — `"saas"` mode requires enterprise).

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
  | IpAllowlistPolicy
  | SSOPolicy
  | SCIMProvenance
  | RolesPolicy
  | Branding
  | Domains
  | ProactiveGate
  | DeployModeResolver
> = Layer.mergeAll(
  NoopResidencyResolverLayer,
  NoopModelRouterLayer,
  NoopMaskingPolicyLayer,
  NoopComplianceReportsLayer,
  NoopApprovalGateLayer,
  NoopSlaMetricsLayer,
  NoopBackupsManagerLayer,
  NoopAuditRetentionLayer,
  NoopIpAllowlistPolicyLayer,
  NoopSSOPolicyLayer,
  NoopSCIMProvenanceLayer,
  NoopRolesPolicyLayer,
  NoopBrandingLayer,
  NoopDomainsLayer,
  NoopProactiveGateLayer,
  NoopDeployModeResolverLayer,
);
