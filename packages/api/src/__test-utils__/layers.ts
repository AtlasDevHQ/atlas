/**
 * Effect Layer-based test utilities.
 *
 * Composable test Layers that replace mock.module() patterns for Effect-based
 * tests. Each layer provides a single service — compose them with Layer.merge
 * or use the pre-built scenario layers (TestAppLayer, TestAdminLayer, etc.).
 *
 * @example
 * ```ts
 * import { TestAdminLayer, runTest } from "@atlas/api/src/__test-utils__/layers";
 *
 * test("admin can list users", async () => {
 *   const result = await runTest(
 *     Effect.gen(function* () {
 *       const { orgId } = yield* AuthContext;
 *       const registry = yield* ConnectionRegistry;
 *       return { orgId, connections: registry.list() };
 *     }),
 *     TestAdminLayer,
 *   );
 *   expect(result.orgId).toBe("test-org");
 * });
 * ```
 *
 * @module
 */

import { Effect, Layer } from "effect";
import {
  ConnectionRegistry,
  type ConnectionRegistryShape,
  RequestContext,
  createRequestContextTestLayer,
  type RequestContextShape,
  AuthContext,
  createAuthContextTestLayer,
  type AuthContextShape,
  PluginRegistry,
  createPluginTestLayer,
  type PluginRegistryShape,
} from "@atlas/api/lib/effect/services";
import { PluginRegistry as PluginRegistryClass } from "@atlas/api/lib/plugins/registry";
import {
  AnswerMeter,
  createAnswerMeterTestLayer,
  type AnswerMeterShape,
} from "@atlas/api/lib/proactive/answer-meter";
import {
  PillarCatalogQuery,
  createPillarCatalogQueryTestLayer,
  type PillarCatalogQueryShape,
} from "@atlas/api/lib/effect/pillar-catalog-query";
import { _resetPool } from "@atlas/api/lib/db/internal";
import type { SqlClient } from "@effect/sql";
import { createConnectionTestLayer } from "../__mocks__/connection";

// ── Re-exports for convenience ──────────────────────────────────────

export {
  createConnectionTestLayer,
  createRequestContextTestLayer,
  createAuthContextTestLayer,
  createPluginTestLayer,
  createAnswerMeterTestLayer,
  createPillarCatalogQueryTestLayer,
  ConnectionRegistry,
  RequestContext,
  AuthContext,
  PluginRegistry,
  AnswerMeter,
  PillarCatalogQuery,
  type ConnectionRegistryShape,
  type RequestContextShape,
  type AuthContextShape,
  type PluginRegistryShape,
  type AnswerMeterShape,
  type PillarCatalogQueryShape,
};

// ── Plugin registry test layer (real instance) ──────────────────────

/**
 * Create a test Layer backed by a real, fresh PluginRegistry instance.
 *
 * Unlike `createPluginTestLayer` (Proxy stub — methods throw unless
 * provided in `partial`), this wraps an actual `PluginRegistry` class
 * so tests that call `register` / `initializeAll` / `enable` / etc. get
 * real behaviour. Each call creates a new instance, so files using this
 * layer cannot leak plugin state into sibling files sharing the bun
 * worker under `bun test --parallel` (1.5.4 / #2799).
 *
 * Tests that mutate the production global `plugins` singleton (because
 * the production code path reads it directly — `bootPluginsForMcp`,
 * `wireMcpToolPlugins` callers in `server.ts`) cannot use this layer
 * and must instead add an `afterAll` that calls `_reset()` on the
 * shared singletons. The Layer is for Effect-based call sites where
 * `yield* PluginRegistry` is feasible.
 *
 * @example
 * ```ts
 * const TestLayer = createPluginRegistryTestLayer();
 * await Effect.runPromise(
 *   Effect.gen(function* () {
 *     const registry = yield* PluginRegistry;
 *     registry.register(myPlugin);
 *     return registry.size;
 *   }).pipe(Effect.provide(TestLayer)),
 * );
 * ```
 */
export function createPluginRegistryTestLayer(
  seed?: (registry: PluginRegistryClass) => void,
): Layer.Layer<PluginRegistry> {
  return Layer.sync(PluginRegistry, () => {
    const impl = new PluginRegistryClass();
    seed?.(impl);
    const service: PluginRegistryShape = {
      register: (p) => impl.register(p),
      initializeAll: (ctx) => impl.initializeAll(ctx),
      healthCheckAll: () => impl.healthCheckAll(),
      teardownAll: () => impl.teardownAll(),
      refresh: (id) => impl.refresh(id),
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

// ── internalQuery() recording layer (pre-Effect route handlers) ─────

/**
 * Recording test harness returned by {@link createOpenApiDatasourceTestLayer}.
 * `layer` installs the fake SqlClient when built (and restores the slot when the
 * scope closes); `calls` is the ordered list of `(sql, params)` tuples the route
 * issued — the typed replacement for `bun:test`'s `mock.fn.mock.calls`.
 */
export interface InternalQueryRecorder {
  /**
   * A scoped Layer that, while built, routes the module-level `internalQuery()`
   * through the recording fake. Build it with a `ManagedRuntime` (or
   * `Layer.buildWithScope`) so the slot is restored on dispose even if a test
   * throws — no fake leaks into sibling files sharing the worker (#2799).
   */
  readonly layer: Layer.Layer<never>;
  /**
   * Every `(sql, params)` the route passed to `internalQuery()`, in order.
   * This is a LIVE view of the recorder's internal array — it grows as the
   * route runs and is truncated by {@link clear}, so assert against it only
   * after the request resolves. Snapshot with `[...db.calls]` if you need a
   * frozen point-in-time copy (`readonly` blocks your writes, not the fake's).
   */
  readonly calls: ReadonlyArray<readonly [string, readonly unknown[]]>;
  /** Drop recorded calls between tests (call in `beforeEach`). */
  readonly clear: () => void;
}

/**
 * Build a recording test Layer for Hono route handlers that call the
 * module-level `internalQuery()` helper directly (rather than `yield* InternalDB`).
 *
 * Routes like `admin-openapi-datasources` predate the Effect migration: they're
 * plain async handlers that call `internalQuery(sql, params)`, so the natural
 * test seam isn't the `InternalDB` Tag (nothing yields it) but the module-level
 * `_sqlClient` slot that `internalQuery()` prefers when set. This factory
 * installs a recording fake into that slot via the sanctioned `_resetPool` test
 * hook, wrapped in a SCOPED resource — so the real `internalQuery()` code path
 * runs end-to-end, replacing a wholesale `mock.module("@atlas/api/lib/db/internal")`
 * with a composable, leak-safe, type-checked layer per the CLAUDE.md "Effect
 * test layers preferred" rule.
 *
 * `query` decides what each statement returns (emulate `WHERE workspace_id = $1`
 * scoping, RETURNING rowcounts, etc.); `params` is the bound array so the callee
 * can branch on the authenticated org (`params[0]`) and id (`params[1]`).
 *
 * @example
 * ```ts
 * const db = createOpenApiDatasourceTestLayer((sql, params) =>
 *   sql.includes("LIMIT 1") && params[0] === OWNER ? [ownedRow] : [],
 * );
 * let rt: ManagedRuntime.ManagedRuntime<never, never>;
 * beforeAll(async () => { rt = ManagedRuntime.make(db.layer); await rt.runPromise(Effect.void); });
 * afterAll(async () => { await rt.dispose(); });
 * beforeEach(() => db.clear());
 * // …then assert against db.calls.find(([sql]) => sql.includes("UPDATE"))
 * ```
 */
export function createOpenApiDatasourceTestLayer(
  query: (sql: string, params: readonly unknown[]) => readonly unknown[],
): InternalQueryRecorder {
  const calls: Array<readonly [string, readonly unknown[]]> = [];

  // `internalQuery()` only ever calls `_sqlClient.unsafe(sql, params)` and awaits
  // the resulting Effect. A minimal recording stub of that one method is all the
  // route exercises — the rest of the broad SqlClient surface is never touched,
  // so narrowing through `unknown` is sound and confined to test infra. NB this
  // stub is route-shaped, not a general SqlClient: a SUT that reaches the other
  // `_sqlClient` consumers in internal.ts (`internalExecute` is also `.unsafe`,
  // but `cascadeWorkspaceDelete` uses `.withTransaction` + the tagged-template
  // form) would hit `undefined is not a function` — extend the stub before reuse.
  const recordingClient = {
    unsafe: (sql: string, params?: ReadonlyArray<unknown>) => {
      const bound = params ?? [];
      calls.push([sql, bound]);
      return Effect.succeed(query(sql, bound));
    },
  } as unknown as SqlClient.SqlClient;

  // Scoped: `_resetPool(null, null)` on release restores the slot to its
  // pre-test null, so a thrown test (or a file that forgets to dispose) can't
  // leak the fake into sibling files. Unit tests never boot the real Layer, so
  // null is the correct pre-state to restore.
  const layer = Layer.scopedDiscard(
    Effect.acquireRelease(
      Effect.sync(() => _resetPool(null, recordingClient)),
      () => Effect.sync(() => _resetPool(null, null)),
    ),
  );

  return {
    layer,
    calls,
    clear: () => {
      calls.length = 0;
    },
  };
}

// ── Default connection layer ────────────────────────────────────────

/**
 * Default ConnectionRegistry test layer with safe defaults.
 * Delegates to createConnectionTestLayer from __mocks__/connection.ts
 * (single source of truth for connection stub shape).
 */
function defaultConnectionLayer(
  overrides?: Partial<ConnectionRegistryShape>,
): Layer.Layer<ConnectionRegistry> {
  return createConnectionTestLayer(overrides);
}

// ── Pre-built scenario Layers ───────────────────────────────────────

/** All services provided by pre-built test layers. */
export type TestServices = ConnectionRegistry | RequestContext | AuthContext;

/**
 * Minimal test layer — ConnectionRegistry + RequestContext + AuthContext (none mode).
 * Suitable for tests that need services available but don't care about auth.
 */
export const TestAppLayer: Layer.Layer<TestServices> = Layer.mergeAll(
  defaultConnectionLayer(),
  createRequestContextTestLayer(),
  createAuthContextTestLayer(),
);

/**
 * Admin test layer — authenticated as admin with org context.
 * Extends TestAppLayer with admin role and an active organization.
 */
export const TestAdminLayer: Layer.Layer<TestServices> = Layer.mergeAll(
  defaultConnectionLayer(),
  createRequestContextTestLayer({ requestId: "test-admin-request" }),
  createAuthContextTestLayer({
    mode: "managed",
    user: {
      id: "test-admin",
      mode: "managed",
      label: "admin@test.com",
      role: "admin",
      activeOrganizationId: "test-org",
    },
    orgId: "test-org",
  }),
);

/**
 * Platform admin test layer — authenticated as platform_admin.
 * For testing platform-wide operations (cross-tenant).
 */
export const TestPlatformLayer: Layer.Layer<TestServices> = Layer.mergeAll(
  defaultConnectionLayer(),
  createRequestContextTestLayer({ requestId: "test-platform-request" }),
  createAuthContextTestLayer({
    mode: "managed",
    user: {
      id: "test-platform-admin",
      mode: "managed",
      label: "platform@test.com",
      role: "platform_admin",
      activeOrganizationId: "test-org",
    },
    orgId: "test-org",
  }),
);

// ── runTest helper ──────────────────────────────────────────────────

/**
 * Run an Effect program with test layers.
 *
 * Convenience wrapper that provides a test layer and runs the program.
 * Defaults to TestAppLayer if no layer is specified.
 *
 * @example
 * ```ts
 * const result = await runTest(
 *   Effect.gen(function* () {
 *     const { requestId } = yield* RequestContext;
 *     return requestId;
 *   }),
 * );
 * expect(result).toBe("test-request-id");
 * ```
 */
export function runTest<A, E>(
  program: Effect.Effect<A, E, TestServices>,
  layer?: Layer.Layer<TestServices>,
): Promise<A> {
  return Effect.runPromise(program.pipe(Effect.provide(layer ?? TestAppLayer)));
}

/**
 * Build a custom test layer by overriding specific services.
 *
 * Starts from TestAppLayer defaults and replaces the specified services.
 * Useful when you need custom connection behavior but standard auth.
 *
 * @example
 * ```ts
 * const layer = buildTestLayer({
 *   connection: { list: () => ["pg", "mysql"], getDBType: () => "mysql" },
 *   auth: { mode: "byot", orgId: "custom-org" },
 * });
 * ```
 */
export function buildTestLayer(overrides?: {
  connection?: Partial<ConnectionRegistryShape>;
  request?: Partial<RequestContextShape>;
  auth?: Partial<AuthContextShape>;
}): Layer.Layer<TestServices> {
  return Layer.mergeAll(
    defaultConnectionLayer(overrides?.connection),
    createRequestContextTestLayer(overrides?.request),
    createAuthContextTestLayer(overrides?.auth),
  );
}
