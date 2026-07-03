/**
 * Native (pg/mysql) profiler dispatch + live-connection assembly — ONE home
 * (#4197).
 *
 * Before this module, the pg-vs-mysql dialect dispatch was duplicated at three
 * sites (`effect/semantic-generator.ts`'s `resolveProfiler`, `mcp-lifecycle.ts`'s
 * native branch, the wizard byproduct in `profiling-connection.ts`), and the
 * native `LiveDatasourceConnection` shape was hand-built twice (mcp-lifecycle +
 * the wizard byproduct). A dialect added to the native set — or a fix to the
 * schema-default rule — had to be made in every copy or silently diverge.
 *
 * Kept LIGHT on purpose: runtime imports are the native profilers only (which
 * lazy-load their own drivers), so consumers like `profiling-connection.ts` can
 * import this statically without dragging the heavy `mcp-lifecycle` graph
 * (workspace-installer, Effect layers) into their module-load path. The
 * `LiveDatasourceConnection` import from `mcp-lifecycle` is type-only (erased).
 */

import {
  listPostgresObjects,
  listMySQLObjects,
  profilePostgres,
  profileMySQL,
  type NativeListObjectsOptions,
  type NativeProfileOptions,
} from "@atlas/api/lib/profiler";
import type { DatabaseObject, ProfilingResult } from "@useatlas/types";
import type { McpNativeDbType } from "./provisionable-types";
import type { LiveDatasourceConnection } from "./mcp-lifecycle";

/** The native introspection pair for one dialect — same options shape as the unified profiler seam. */
export interface NativeProfiler {
  readonly listObjects: (opts: NativeListObjectsOptions) => Promise<DatabaseObject[]>;
  readonly profile: (opts: NativeProfileOptions) => Promise<ProfilingResult>;
}

/**
 * THE pg-vs-mysql dispatch. Every consumer that needs a native profiler resolves
 * it here; a new native dialect is a one-line addition instead of a ternary hunt.
 */
export function nativeProfilerFor(dbType: McpNativeDbType): NativeProfiler {
  return dbType === "mysql"
    ? { listObjects: listMySQLObjects, profile: profileMySQL }
    : { listObjects: listPostgresObjects, profile: profilePostgres };
}

export interface BuildNativeLiveConnectionOptions {
  readonly dbType: McpNativeDbType;
  /**
   * Decrypted connection URL, consumed by the native profilers (which own their
   * throwaway pools). SECURITY: captured in closures only — never surfaced on
   * the returned connection.
   */
  readonly url: string;
  /**
   * The install's CONFIGURED schema scope (`workspace_plugins` config), if any.
   * Applied when the caller passes none; Postgres falls back to `"public"`
   * (its canonical search-path). MySQL ignores schema entirely (forwarded but
   * inert per the `NativeListObjectsOptions` contract — the mysql profilers
   * never read it).
   */
  readonly configuredSchema?: string;
  /** The install's connection-group scope (`null` for an ungrouped install). */
  readonly connectionGroupId: string | null;
  /** Query surface — routed by the caller (registry pool), NOT rebuilt from the URL. */
  readonly query: LiveDatasourceConnection["query"];
}

/**
 * Assemble a native `LiveDatasourceConnection`: introspection
 * (`listObjects`/`profile`) bound to the decrypted URL via
 * {@link nativeProfilerFor}, `query` delegated to the caller's registry pool.
 * Shared by `resolveLiveConnection`'s native branch and the wizard env-var
 * byproduct — previously two hand-rolled copies of this exact shape.
 *
 * `close()` is a no-op: the query pool is registry-managed (not torn down by
 * the caller) and the native profilers own their throwaway pools.
 */
export function buildNativeLiveConnection(
  opts: BuildNativeLiveConnectionOptions,
): LiveDatasourceConnection {
  const { dbType, url, configuredSchema, connectionGroupId, query } = opts;
  const { listObjects, profile } = nativeProfilerFor(dbType);
  const effectiveSchema = (callerSchema?: string): string | undefined =>
    callerSchema ?? configuredSchema ?? (dbType === "postgres" ? "public" : undefined);

  return {
    dbType,
    connectionGroupId,
    query,
    listObjects: (options) => {
      const schema = effectiveSchema(options?.schema);
      return listObjects({
        url,
        ...(schema !== undefined ? { schema } : {}),
        ...(options?.logger !== undefined ? { logger: options.logger } : {}),
      });
    },
    profile: (options) => {
      const schema = effectiveSchema(options.schema);
      return profile({
        url,
        ...(schema !== undefined ? { schema } : {}),
        ...(options.selectedTables !== undefined ? { selectedTables: options.selectedTables } : {}),
        ...(options.prefetchedObjects !== undefined ? { prefetchedObjects: options.prefetchedObjects } : {}),
        ...(options.progress !== undefined ? { progress: options.progress } : {}),
        ...(options.logger !== undefined ? { logger: options.logger } : {}),
      });
    },
    close: async () => {
      // Registry-managed query pool + profiler-owned throwaway pools — nothing
      // for the caller to tear down.
    },
  };
}
