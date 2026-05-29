/**
 * Orphan plugin-task reconcile (#2944).
 *
 * Plugin uninstall (`DELETE /api/v1/admin/marketplace/:id`) is deliberately
 * NON-atomic: the `workspace_plugins` row DELETE commits first, then the
 * plugin-owned `scheduled_tasks` cleanup runs as a separate, best-effort
 * statement (see `admin-marketplace.ts` — "best-effort cleanup over a
 * multi-statement transaction because making the cleanup load-bearing would
 * block uninstall on internal-DB hiccups"). If that cleanup rejects AFTER the
 * install row is gone, the plugin's tasks are orphaned — `plugin_id` set, but
 * no live `workspace_plugins` row — and the scheduler keeps firing them.
 *
 * The uninstall path already logs a failure audit + `log.error` for the
 * single request that failed. The gap #2944 closes is the lack of a recurring
 * signal for orphan *accumulation* across all workspaces (and across BOTH
 * uninstall paths — the marketplace DELETE handler, and `WorkspaceInstaller`
 * disconnects, which never cleaned `scheduled_tasks` at all). A failed
 * cleanup that drops its audit row on an internal-DB circuit-open would
 * otherwise leave no durable trace.
 *
 * This module is that recurring counterpart. Forked as a periodic scheduler
 * fiber in `makeSchedulerLive`, every tick:
 *
 *   1. COUNTS orphaned plugin tasks — always — and surfaces the count as a
 *      per-tick OpenTelemetry span attribute (the wrap site in `layers.ts`)
 *      plus a structured `log.warn` when the count is > 0. This is the
 *      operator-facing drift signal, emitted the same way the per-tick
 *      cleanup spans (#2945) and the uninstall failure log already are — a
 *      stdout-scraping or trace-querying operator sees orphan accumulation
 *      without a dedicated admin route.
 *   2. Optionally DELETES the confirmed orphans, scoped by EXACTLY the same
 *      `(plugin_id, org_id)` predicate the uninstall path uses — but only
 *      when `ATLAS_ORPHAN_TASK_RECONCILE=true`. The default is measure-only:
 *      auto-deleting on a timer could mask a transient `workspace_plugins`
 *      read blip, and the original design deliberately favors best-effort
 *      over load-bearing cleanup, so the destructive sweep is opt-in.
 *
 * ## What counts as an orphan
 *
 * A `scheduled_tasks` row where `plugin_id IS NOT NULL` and there is NO
 * `workspace_plugins` row with `(catalog_id = plugin_id, workspace_id =
 * org_id)`. Per migration 0044, `scheduled_tasks.plugin_id` stores the
 * plugin's `catalog_id` (NOT the per-install `workspace_plugins.id`, which
 * gets a fresh value on every reinstall), and `workspace_plugins.workspace_id`
 * is the same value as `scheduled_tasks.org_id` (both the workspace/org id).
 *
 * A plugin task with a NULL `org_id` can never match a live install
 * (`workspace_plugins.workspace_id` is NOT NULL), so it is COUNTED as an
 * orphan. The destructive sweep, however, SKIPS NULL-org rows — the uninstall
 * predicate (`... AND org_id = $2`) can't target a NULL org either (SQL
 * `NULL = $2` never matches), so deleting them here would clean up state the
 * uninstall path itself would never touch. Measure broadly, delete
 * conservatively.
 */

import { createLogger } from "@atlas/api/lib/logger";
import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";

const log = createLogger("orphan-task-reconcile");

/**
 * How often the reconcile fiber ticks. Orphan accumulation is rare (only a
 * failed uninstall produces one) and slow, so an hourly cadence is ample —
 * frequent enough that drift surfaces the same day, infrequent enough that
 * the (cheap, indexed) scan is negligible. Exported so `layers.ts` references
 * the same value the fiber is documented around.
 */
export const ORPHAN_TASK_RECONCILE_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Minimal query surface shared with `internalQuery` so callers (and tests)
 * can inject a pool adapter. Matches `internalQuery`'s signature exactly, so
 * the production wiring passes `internalQuery` directly.
 */
export type OrphanReconcileQuery = <T extends Record<string, unknown>>(
  sql: string,
  params?: unknown[],
) => Promise<T[]>;

/** Point-in-time count of orphaned plugin scheduled tasks. */
export interface OrphanTaskReport {
  /** Total orphaned `scheduled_tasks` rows (`plugin_id` set, no live install). */
  readonly orphanedTasks: number;
  /**
   * Distinct `(plugin_id, org_id)` pairs with orphans — i.e. how many
   * uninstalls left tasks behind. Coarse: computed via a `plugin_id || ':' ||
   * org_id` key. `plugin_id` is a catalog id (`catalog:<slug>` — a
   * fixed-position colon over a colon-free slug) and `org_id` is colon-free
   * (enforced at write — see the `orgId` guard in `db/connection.ts`), so the
   * concatenation is unambiguous and the DISTINCT count is exact. It's a
   * coarse metric, not a correctness-critical value.
   */
  readonly orphanedInstalls: number;
}

/** Result of one reconcile tick — the report plus what the sweep did. */
export interface OrphanReconcileResult extends OrphanTaskReport {
  /** Whether the destructive sweep ran this tick (`ATLAS_ORPHAN_TASK_RECONCILE=true`). */
  readonly reconcileEnabled: boolean;
  /** Rows the sweep deleted (0 when measure-only, or nothing to delete). */
  readonly deleted: number;
}

/**
 * `true` when the destructive reconcile sweep is enabled. Read at call time
 * (never at module top-level) so test discipline + per-process env overrides
 * hold. Default OFF — the signal is always emitted; only the DELETE is gated.
 */
export function isOrphanTaskReconcileEnabled(): boolean {
  return process.env.ATLAS_ORPHAN_TASK_RECONCILE === "true";
}

// The orphan predicate, shared verbatim between the count and the delete so
// the two can never drift. A task is an orphan iff it is plugin-owned and no
// live install row matches on BOTH catalog_id and workspace_id — the exact
// pair the uninstall cleanup scopes by.
const ORPHAN_PREDICATE = `st.plugin_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM workspace_plugins wp
      WHERE wp.catalog_id = st.plugin_id
        AND wp.workspace_id = st.org_id
    )`;

const COUNT_ORPHANED_TASKS_SQL = `
  SELECT
    COUNT(*)::int AS orphaned_tasks,
    COUNT(DISTINCT (st.plugin_id || ':' || COALESCE(st.org_id, '')))::int AS orphaned_installs
  FROM scheduled_tasks st
  WHERE ${ORPHAN_PREDICATE}
`;

// The sweep adds `org_id IS NOT NULL` to the count predicate: a NULL-org
// plugin task is an orphan we report but never auto-delete (see module doc).
const DELETE_ORPHANED_TASKS_SQL = `
  DELETE FROM scheduled_tasks st
  WHERE st.org_id IS NOT NULL
    AND ${ORPHAN_PREDICATE}
  RETURNING id
`;

/**
 * Count orphaned plugin scheduled tasks. Read-only, single SELECT. `query`
 * defaults to the internal pool; tests inject an adapter.
 */
export async function countOrphanedPluginTasks(
  query: OrphanReconcileQuery = internalQuery,
): Promise<OrphanTaskReport> {
  const rows = await query<{ orphaned_tasks: number; orphaned_installs: number }>(
    COUNT_ORPHANED_TASKS_SQL,
  );
  const row = rows[0];
  // A COUNT(*) aggregate always returns exactly one row with numeric columns
  // (0/0 when nothing matches). A missing row or a non-numeric column means a
  // structural failure — driver returned nothing, column-alias drift, etc.
  // Surface it as an error (the fiber wrap in `layers.ts` records it on the
  // span + logs, keeping the loop alive) rather than coalescing to a
  // false-healthy `0 orphans`, which is indistinguishable from a clean scan.
  if (
    !row ||
    typeof row.orphaned_tasks !== "number" ||
    typeof row.orphaned_installs !== "number"
  ) {
    throw new Error(
      "Orphan-task count query returned an unexpected shape (expected one row with numeric orphaned_tasks/orphaned_installs)",
    );
  }
  return {
    orphanedTasks: row.orphaned_tasks,
    orphanedInstalls: row.orphaned_installs,
  };
}

/**
 * Delete confirmed orphan plugin tasks (org-scoped only — see module doc).
 * Returns the number of rows deleted. Idempotent: the `NOT EXISTS` is
 * re-evaluated at delete time, so concurrent ticks (multi-pod) and a
 * reinstall-between-count-and-delete race are both safe — only still-orphaned
 * rows are removed.
 */
export async function deleteOrphanedPluginTasks(
  query: OrphanReconcileQuery = internalQuery,
): Promise<number> {
  const rows = await query<{ id: string }>(DELETE_ORPHANED_TASKS_SQL);
  return rows.length;
}

/** Minimal structured-logger surface the tick needs — satisfied by the pino
 * logger in production and a recording fake in tests. */
export interface ReconcileLogger {
  warn: (obj: Record<string, unknown>, msg: string) => void;
  debug: (obj: Record<string, unknown>, msg: string) => void;
}

/**
 * Injectable dependencies for one reconcile tick. The production tick
 * (`runOrphanTaskReconcileTick`) wires the real internal-DB pool + env flag +
 * logger; tests inject fakes so the orchestration (no-op gate, count, gated
 * delete, drift signal) is exercised without a live DB or `mock.module`.
 */
export interface OrphanReconcileDeps {
  readonly hasInternalDB: () => boolean;
  readonly query: OrphanReconcileQuery;
  readonly reconcileEnabled: () => boolean;
  readonly log: ReconcileLogger;
}

/**
 * The canonical zero/no-op result: no orphans, sweep not run. Returned when
 * the tick can't do work (no internal DB). Centralized so the only
 * internally-consistent "did nothing" shape — `reconcileEnabled: false` paired
 * with `deleted: 0` — lives in one place rather than being hand-written at
 * each no-op site (`OrphanReconcileResult` is a flat record, so the
 * `reconcileEnabled`/`deleted` pairing is an invariant held by construction).
 */
function emptyReconcileResult(): OrphanReconcileResult {
  return { orphanedTasks: 0, orphanedInstalls: 0, reconcileEnabled: false, deleted: 0 };
}

/**
 * One reconcile tick: count (always) → optionally delete (when enabled) →
 * emit the drift signal. Returns the result so the `withEffectSpan` wrap in
 * `layers.ts` can attach the counts as span attributes.
 *
 * No-ops to a zero report when the internal DB is not configured (self-hosted
 * without `DATABASE_URL` has no `scheduled_tasks` / `workspace_plugins`
 * tables). DB errors propagate — the fiber wrap in `layers.ts` records the
 * failure on the span and recovers, keeping the loop alive while the trace
 * shows ERROR (never a false-healthy zero).
 */
export async function reconcileOrphanTasks(
  deps: OrphanReconcileDeps,
): Promise<OrphanReconcileResult> {
  if (!deps.hasInternalDB()) {
    return emptyReconcileResult();
  }

  const reconcileEnabled = deps.reconcileEnabled();
  const report = await countOrphanedPluginTasks(deps.query);

  let deleted = 0;
  if (reconcileEnabled && report.orphanedTasks > 0) {
    deleted = await deleteOrphanedPluginTasks(deps.query);
  }

  if (report.orphanedTasks > 0) {
    deps.log.warn(
      {
        orphanedTasks: report.orphanedTasks,
        orphanedInstalls: report.orphanedInstalls,
        reconcileEnabled,
        deleted,
        event: "plugin_task.orphan_detected",
      },
      reconcileEnabled
        ? `Orphaned plugin scheduled tasks detected and reconciled (${deleted} deleted) — a plugin uninstall left tasks with no live workspace_plugins row`
        : "Orphaned plugin scheduled tasks detected — a plugin uninstall left tasks with no live workspace_plugins row. Set ATLAS_ORPHAN_TASK_RECONCILE=true to auto-purge, or clean manually.",
    );
  } else {
    deps.log.debug({ event: "plugin_task.orphan_scan" }, "Orphan plugin-task scan: none found");
  }

  return { ...report, reconcileEnabled, deleted };
}

/**
 * Production entry point for the scheduler fiber: `reconcileOrphanTasks` wired
 * to the real internal-DB pool, the `ATLAS_ORPHAN_TASK_RECONCILE` flag, and
 * the module logger.
 */
export function runOrphanTaskReconcileTick(): Promise<OrphanReconcileResult> {
  return reconcileOrphanTasks({
    hasInternalDB,
    query: internalQuery,
    reconcileEnabled: isOrphanTaskReconcileEnabled,
    log,
  });
}
