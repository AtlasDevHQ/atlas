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
export function registerDatasourceInstall(
  row: DatasourceWorkspacePluginRow,
  decryptedConfig: Readonly<Record<string, unknown>>,
): boolean {
  const poolConfig: DatasourcePoolConfig = resolveDatasourcePoolConfig(row, decryptedConfig);

  if (poolConfig.dbType !== "postgres" && poolConfig.dbType !== "mysql") {
    return false;
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
  // for SUBSEQUENT org-pool clones here (an org pool already cloned into
  // `orgEntries` keeps the prior config until it's evicted/restarted — see
  // #3109 for eager org-pool drain on update).
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
 *  2. Removes the shared bare `entries` row ONLY when no OTHER workspace still
 *     owns the install_id (`hasWorkspacePoolsFor`). A sibling sharing the
 *     install_id keeps the bare row so its install-id-keyed metadata
 *     (getDBType / getTargetHost / validators) keeps resolving.
 *
 * The registry's own `unregister` throws if the id isn't present; we guard
 * with `has()` so the soft-archive path (status → archived) is a no-op when
 * the row was never pooled (e.g. clickhouse).
 */
export function unregisterDatasourceInstall(workspaceId: string, installId: string): boolean {
  const removedWorkspace = connections.unregisterForWorkspace(workspaceId, installId);
  // Drop the shared bare row only once the last workspace owning this
  // install_id is gone — siblings keep their install-id-keyed metadata.
  const removedBare =
    !connections.hasWorkspacePoolsFor(installId) &&
    connections.has(installId) &&
    connections.unregister(installId);
  return removedWorkspace || removedBare;
}
