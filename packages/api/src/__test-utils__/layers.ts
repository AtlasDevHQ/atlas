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
import { createConnectionTestLayer } from "../__mocks__/connection";

// ── Re-exports for convenience ──────────────────────────────────────

export {
  createConnectionTestLayer,
  createRequestContextTestLayer,
  createAuthContextTestLayer,
  createPluginTestLayer,
  ConnectionRegistry,
  RequestContext,
  AuthContext,
  PluginRegistry,
  type ConnectionRegistryShape,
  type RequestContextShape,
  type AuthContextShape,
  type PluginRegistryShape,
};

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
