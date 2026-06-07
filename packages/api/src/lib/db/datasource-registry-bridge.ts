/**
 * `datasource-registry-bridge` — shared (workspace_plugins row, decrypted
 * config) → `ConnectionRegistry.register` glue used by both boot-time
 * `loadSavedConnections` (`db/internal.ts`) and the runtime
 * `WorkspaceInstaller.installDatasource` facade (`lib/effect/workspace-
 * installer.ts`).
 *
 * The boot path and the post-install path used to diverge: boot ran the
 * resolver inline inside `loadSavedConnections`, the route ran its own
 * `connections.register(id, { url, schema, description })` directly off
 * the request body. Post-#2744 both go through this helper so the
 * per-`db_type` register convention lives in exactly one place. If a
 * new dbType ships (or a tunable like `maxConnections` becomes
 * catalog-declared), only this file needs to change.
 *
 * Resolver runs unconditionally; native-dbType filter runs after. This
 * means a plugin-managed row (`clickhouse` / `snowflake` / `bigquery` /
 * `duckdb` / `salesforce`) missing a required catalog field will throw
 * from the resolver BEFORE reaching the native filter — only well-formed
 * plugin rows reach the filter and return `false`. The trade-off is
 * intentional: surfacing config violations loud at boot beats silently
 * skipping rows that the catalog declared as required.
 *
 * Pure-ish: the only side effect is the registry mutation. No DB I/O,
 * no logging — callers handle errors and emit the appropriate breadcrumb.
 *
 * @see docs/adr/0007-unified-install-pipeline.md
 */

import { connections } from "@atlas/api/lib/db/connection";
import type { ConnectionPluginMeta, DBConnection } from "@atlas/api/lib/db/connection";
import {
  type DatasourcePoolConfig,
  type DatasourceWorkspacePluginRow,
  resolveDatasourcePoolConfig,
} from "@atlas/api/lib/db/datasource-pool-resolver";

/**
 * Structural shape of a datasource plugin's `connection` object, matched
 * against `PluginRegistry` entries by `dbType`. Declared locally (not imported
 * from `@useatlas/plugin-sdk`) so core `@atlas/api` stays decoupled from the
 * plugin packages — the same convention `lib/plugins/wiring.ts` uses, preserving
 * the core→plugin decoupling the adapter-to-plugin extraction established.
 */
interface DatasourceConnectionShape {
  dbType: string;
  /** Build a connection from a runtime (DB-stored) config — see SDK `AtlasDatasourcePlugin`. */
  createFromConfig?(
    config: Readonly<Record<string, unknown>>,
  ): Promise<{ query(sql: string, timeoutMs?: number): Promise<unknown>; close(): Promise<void> }>
    | { query(sql: string, timeoutMs?: number): Promise<unknown>; close(): Promise<void> };
  validate?: (query: string) => { valid: boolean; reason?: string } | Promise<{ valid: boolean; reason?: string }>;
  parserDialect?: string;
  forbiddenPatterns?: RegExp[];
}

/** Narrow a registry plugin to its datasource `connection` shape, or undefined if it isn't one. */
function getDatasourceConnection(plugin: unknown): DatasourceConnectionShape | undefined {
  const c = (plugin as { connection?: unknown } | null)?.connection;
  if (c && typeof c === "object" && typeof (c as { dbType?: unknown }).dbType === "string") {
    return c as DatasourceConnectionShape;
  }
  return undefined;
}

/** Best-effort host for audit logging from a plugin pool config's URL (no credentials). */
function pluginTargetHost(poolConfig: DatasourcePoolConfig): string {
  const url = (poolConfig as { url?: unknown }).url;
  if (typeof url === "string") {
    try {
      return new URL(url).hostname || "(plugin)";
    } catch {
      // intentionally ignored: targetHost is a best-effort audit label, not a
      // routing/security value — a malformed URL falls back to "(plugin)".
      return "(plugin)";
    }
  }
  return "(plugin)";
}

/**
 * Register a DB-stored datasource of a PLUGIN type (clickhouse / snowflake /
 * bigquery / duckdb / salesforce / elasticsearch). Looks up the plugin in the
 * registry by `dbType`, builds a per-(workspace, install_id) connection via the
 * plugin's `connection.createFromConfig(decryptedConfig)`, and registers it
 * with the plugin's validator / dialect / forbidden patterns so SQL validation
 * stays correct.
 *
 * Throws (caught + logged per-row by `loadSavedConnections` at boot; surfaced
 * to the admin on the install path) when no plugin is registered for the
 * dbType, or the plugin doesn't implement `createFromConfig`.
 */
async function registerPluginDatasourceInstall(
  row: DatasourceWorkspacePluginRow,
  poolConfig: DatasourcePoolConfig,
  decryptedConfig: Readonly<Record<string, unknown>>,
): Promise<boolean> {
  // Lazy import keeps the plugin registry out of this module's static import
  // graph — several tests partial-mock this bridge's imports.
  const { plugins } = await import("@atlas/api/lib/plugins/registry");
  // Use getAll() (not getByType, which filters to status==="healthy"): the
  // plugin is consulted purely as an ADAPTER via createFromConfig, independent
  // of whether a static config-defined connection of its dbType is healthy.
  const conn = plugins
    .getAll()
    .map(getDatasourceConnection)
    .find((c): c is DatasourceConnectionShape => c != null && c.dbType === poolConfig.dbType);

  if (!conn || typeof conn.createFromConfig !== "function") {
    throw new Error(
      `No datasource plugin registered for type "${poolConfig.dbType}". Add the ` +
        `corresponding plugin (e.g. clickhousePlugin()) to the plugins array in ` +
        `atlas.config.ts, listed before any datasources that use it.`,
    );
  }

  const already = connections.hasDirectForWorkspace(row.workspaceId, row.installId);
  const built = await conn.createFromConfig(decryptedConfig);
  const meta: ConnectionPluginMeta = {
    ...(conn.parserDialect ? { parserDialect: conn.parserDialect } : {}),
    ...(conn.forbiddenPatterns ? { forbiddenPatterns: conn.forbiddenPatterns } : {}),
  };
  connections.registerDirectForWorkspace(
    row.workspaceId,
    row.installId,
    // Single structural assertion (DBConnection is a superset of the plugin's
    // {query,close} shape) — mirrors lib/plugins/wiring.ts; no `unknown` launder.
    built as DBConnection,
    poolConfig.dbType,
    (poolConfig as { description?: string }).description,
    conn.validate,
    meta,
    pluginTargetHost(poolConfig),
  );
  return !already;
}

/**
 * Resolve `(row, decryptedConfig)` and register the resulting native pool
 * with the `ConnectionRegistry`.
 *
 * Returns:
 *   - `true`  — a fresh registration was performed (the per-(workspace,
 *               install_id) config and/or the bare install_id row was new)
 *   - `false` — either the dbType is plugin-managed (filter short-circuit) or
 *               BOTH the per-(workspace, install_id) config and the bare
 *               install_id were already registered (full idempotent re-register)
 *
 * Throws on any resolver violation (missing required field, invalid
 * schema identifier, unknown catalog slug). Resolver runs before the
 * native filter — a plugin-managed row with malformed config throws
 * here, never reaching the short-circuit branch.
 *
 * The native-only filter matches the prior in-line check in
 * `loadSavedConnections` — without it, `connections.register` would
 * reject every plugin-managed dbType at the URL-scheme check and the
 * boot loop would log a noisy warning per row.
 */
export async function registerDatasourceInstall(
  row: DatasourceWorkspacePluginRow,
  decryptedConfig: Readonly<Record<string, unknown>>,
): Promise<boolean> {
  const poolConfig: DatasourcePoolConfig = resolveDatasourcePoolConfig(row, decryptedConfig);

  // Plugin-managed dbTypes can't be cloned by the core `createConnection`
  // switch — build a live per-(workspace, install_id) connection from the
  // registered plugin's `createFromConfig` instead (#3253 seam).
  if (poolConfig.dbType !== "postgres" && poolConfig.dbType !== "mysql") {
    return registerPluginDatasourceInstall(row, poolConfig, decryptedConfig);
  }

  const config = {
    url: poolConfig.url,
    ...(poolConfig.description !== undefined ? { description: poolConfig.description } : {}),
    ...(poolConfig.dbType === "postgres" && poolConfig.schema
      ? { schema: poolConfig.schema }
      : {}),
  };

  // Per-(workspace, install_id) config registration — the routing source of
  // truth that retires the `DISTINCT ON (install_id)` multi-tenant collision
  // (#2783). `getForOrg(workspaceId, installId)` clones an org pool from THIS
  // config, so two workspaces sharing an install_id route to their own DBs.
  // Config-only + upsert (no live pool to tear down), so it's registered
  // unconditionally — a datasource config update replaces the base config used
  // for SUBSEQUENT org-pool clones here. The update path drains the existing
  // clone first via `unregisterDatasourceInstall` →
  // `connections.drainWorkspacePool`, so the next query re-clones from this new
  // config without waiting for LRU eviction / restart (#3109).
  const compositeExisted = connections.hasForWorkspace(row.workspaceId, row.installId);
  connections.registerForWorkspace(row.workspaceId, row.installId, config);

  // Bare install-id registration keeps install-id-keyed readers
  // (getDBType / getTargetHost / validators) and self-hosted
  // `connections.get(installId)` working. Idempotent on the bare id so a
  // healthy pre-registered pool isn't torn down — the route layer
  // pre-`healthCheck`'s a fresh pool before writing the DB row, and boot's
  // `loadSavedConnections` registers the first workspace's row. Two workspaces
  // sharing an install_id collapse onto one bare row by design (it backs only
  // install-id-keyed metadata, not routing — routing uses the per-workspace
  // config above).
  const bareExisted = connections.has(row.installId);
  if (!bareExisted) {
    connections.register(row.installId, config);
  }

  // Fresh if either registration newly landed — the boot loader counts these.
  return !compositeExisted || !bareExisted;
}

/**
 * Unregister an install from the `ConnectionRegistry`. Returns `false`
 * when nothing was registered (plugin-managed pool, or a soft-archived row
 * that never landed in the registry). Mirrors {@link registerDatasourceInstall}
 * so the install / uninstall paths in `WorkspaceInstaller` stay symmetric.
 *
 * Symmetric with the dual-registration in {@link registerDatasourceInstall}:
 *  1. Removes the per-(workspace, install_id) routing config — `getForOrg`
 *     resolves it with priority over the bare entry, so leaving it would let
 *     an uninstalled datasource keep routing to a stale URL (#2783).
 *  2. Drains the live org-pool clone for this (workspace, install_id) so a
 *     config update / uninstall propagates immediately instead of serving the
 *     OLD config until LRU eviction / restart (#3109). Step 1 drops the routing
 *     config; this drops the live pool, keeping them symmetric.
 *  3. Closes + drops a DB-stored plugin connection (clickhouse / snowflake / …)
 *     held in `workspacePluginEntries` for this (workspace, install_id) — the
 *     plugin counterpart to step 1+2's native teardown (#3253).
 *  4. Removes the shared bare `entries` row ONLY when no OTHER workspace still
 *     owns the install_id (`hasWorkspacePoolsFor`). A sibling sharing the
 *     install_id keeps the bare row so its install-id-keyed metadata
 *     (getDBType / getTargetHost / validators) keeps resolving.
 *
 * The registry's own `unregister` throws if the id isn't present; we guard
 * with `has()` so the soft-archive path (status → archived) is a no-op for the
 * BARE row when the install never populated it (plugin datasources never do —
 * their teardown is step 3's `unregisterDirectForWorkspace`).
 */
export function unregisterDatasourceInstall(workspaceId: string, installId: string): boolean {
  const removedWorkspace = connections.unregisterForWorkspace(workspaceId, installId);
  // Eagerly tear down the live org-pool clone for this (workspace, install_id)
  // so a config update / uninstall takes effect on the next query — without
  // this the cloned pool keeps the prior config until LRU/restart (#3109).
  connections.drainWorkspacePool(workspaceId, installId);
  // Close + drop a DB-stored plugin connection (clickhouse / snowflake / …) for
  // this (workspace, install_id) — the plugin counterpart to the native
  // unregisterForWorkspace + drain above (#3253 seam).
  const removedPlugin = connections.unregisterDirectForWorkspace(workspaceId, installId);
  // Drop the shared bare row only once the last workspace owning this
  // install_id is gone — siblings keep their install-id-keyed metadata.
  const removedBare =
    !connections.hasWorkspacePoolsFor(installId) &&
    connections.has(installId) &&
    connections.unregister(installId);
  return removedWorkspace || removedPlugin || removedBare;
}
