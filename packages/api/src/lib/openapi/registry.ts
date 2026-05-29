/**
 * `OpenApiDatasourceRegistry` — the parallel REST-datasource registry the PRD
 * (#2868 §"Option B — parallel adapter, not subordinate") calls for: an Effect
 * `Context.Tag` analogous to `ConnectionRegistry`, but resolving probed-spec
 * snapshots + credentials from `workspace_plugins WHERE pillar='datasource'`
 * (catalog `openapi-generic`) rather than SQL pools. `ConnectionRegistry` keeps
 * its remit (SQL pools); this owns REST.
 *
 * The resolution itself lives in `workspace-datasource.ts` as a plain async
 * function (`resolveWorkspaceRestDatasources`) so the non-Effect agent loop and
 * the value-injected tools can call it directly with a `deps` seam. This Tag is
 * the Effect-facing handle for call sites already inside an Effect context, and
 * the testing seam (`createOpenApiDatasourceTestLayer`) that lets a consumer's
 * test inject fixture datasources via `Layer.provide` instead of `mock.module()`
 * (AC6).
 */

import { Context, Effect, Layer } from "effect";
import type { RestDatasource } from "./datasource";
import {
  resolveWorkspaceRestDatasources,
  type ResolveWorkspaceDeps,
} from "./workspace-datasource";

export interface OpenApiDatasourceRegistryShape {
  /**
   * Resolve every installed REST datasource for a workspace. Never fails — a
   * per-install resolution error is logged and skipped upstream, so the Effect
   * succeeds with the resolvable subset (`[]` when none).
   */
  readonly resolveForWorkspace: (
    workspaceId: string,
  ) => Effect.Effect<ReadonlyArray<RestDatasource>>;
}

export class OpenApiDatasourceRegistry extends Context.Tag("OpenApiDatasourceRegistry")<
  OpenApiDatasourceRegistry,
  OpenApiDatasourceRegistryShape
>() {}

/**
 * Production layer: delegates to the DB-backed `resolveWorkspaceRestDatasources`.
 * `Effect.promise` is safe because the resolver is fail-soft (never rejects).
 */
export const OpenApiDatasourceRegistryLive: Layer.Layer<OpenApiDatasourceRegistry> =
  Layer.succeed(OpenApiDatasourceRegistry, {
    resolveForWorkspace: (workspaceId) =>
      Effect.promise(() => resolveWorkspaceRestDatasources(workspaceId)),
  } satisfies OpenApiDatasourceRegistryShape);

/**
 * Build a layer that resolves from an injected `deps` seam (e.g. a fixture
 * query) instead of the live DB — for Effect consumers under test that still
 * want the real resolution logic exercised against a fake `workspace_plugins`
 * query.
 */
export function createOpenApiDatasourceRegistryLayer(
  deps: ResolveWorkspaceDeps,
): Layer.Layer<OpenApiDatasourceRegistry> {
  return Layer.succeed(OpenApiDatasourceRegistry, {
    resolveForWorkspace: (workspaceId) =>
      Effect.promise(() => resolveWorkspaceRestDatasources(workspaceId, deps)),
  } satisfies OpenApiDatasourceRegistryShape);
}

/**
 * Test layer: returns canned datasources per workspace id, bypassing resolution
 * entirely. Pass a map (workspaceId → datasources) or a resolver function. The
 * Effect-test seam AC6 requires — consumers `Layer.provide` this instead of
 * `mock.module()`-ing the resolver.
 *
 * @example
 * ```ts
 * const layer = createOpenApiDatasourceTestLayer({ "org-1": [twentyMock] });
 * await Effect.runPromise(
 *   OpenApiDatasourceRegistry.pipe(
 *     Effect.flatMap((r) => r.resolveForWorkspace("org-1")),
 *     Effect.provide(layer),
 *   ),
 * );
 * ```
 */
export function createOpenApiDatasourceTestLayer(
  byWorkspace:
    | Record<string, ReadonlyArray<RestDatasource>>
    | ((workspaceId: string) => ReadonlyArray<RestDatasource>),
): Layer.Layer<OpenApiDatasourceRegistry> {
  const resolve = (workspaceId: string): ReadonlyArray<RestDatasource> =>
    typeof byWorkspace === "function" ? byWorkspace(workspaceId) : byWorkspace[workspaceId] ?? [];
  return Layer.succeed(OpenApiDatasourceRegistry, {
    resolveForWorkspace: (workspaceId) => Effect.succeed(resolve(workspaceId)),
  } satisfies OpenApiDatasourceRegistryShape);
}
