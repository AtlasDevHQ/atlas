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
import {
  type DatasourcePoolConfig,
  type DatasourceWorkspacePluginRow,
  resolveDatasourcePoolConfig,
} from "@atlas/api/lib/db/datasource-pool-resolver";

/**
 * Resolve `(row, decryptedConfig)` and register the resulting native pool
 * with the `ConnectionRegistry`.
 *
 * Returns:
 *   - `true`  — a fresh registration was performed
 *   - `false` — either the dbType is plugin-managed (filter short-circuit)
 *               or the install_id was already registered (idempotent re-register)
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
export function registerDatasourceInstall(
  row: DatasourceWorkspacePluginRow,
  decryptedConfig: Readonly<Record<string, unknown>>,
): boolean {
  const poolConfig: DatasourcePoolConfig = resolveDatasourcePoolConfig(row, decryptedConfig);

  if (poolConfig.dbType !== "postgres" && poolConfig.dbType !== "mysql") {
    return false;
  }

  // Idempotent re-register: if the install_id is already registered (boot
  // ran, or a prior `installDatasource` registered it), keep the existing
  // pool. The route layer pre-`healthCheck`'s a fresh pool before writing
  // the DB row, so by the time we reach the bridge the pool is already
  // healthy and re-registering would tear down its open connections.
  // `loadSavedConnections` already has the same skip; this guard means the
  // facade can call the bridge unconditionally after a successful install.
  if (connections.has(row.installId)) {
    return false;
  }

  connections.register(row.installId, {
    url: poolConfig.url,
    ...(poolConfig.description !== undefined ? { description: poolConfig.description } : {}),
    ...(poolConfig.dbType === "postgres" && poolConfig.schema
      ? { schema: poolConfig.schema }
      : {}),
  });
  return true;
}

/**
 * Unregister an install from the `ConnectionRegistry`. Returns `false`
 * when the install was not registered (plugin-managed pool, or a soft-
 * archived row that never landed in the registry). Mirrors
 * {@link registerDatasourceInstall} so the install / uninstall paths in
 * `WorkspaceInstaller` stay symmetric.
 *
 * The registry's own `unregister` throws if the id isn't present; we
 * guard with `has()` so the soft-archive path (status → archived) is a
 * no-op when the row was never pooled (e.g. clickhouse).
 */
export function unregisterDatasourceInstall(installId: string): boolean {
  if (!connections.has(installId)) return false;
  return connections.unregister(installId);
}
