/**
 * SLA metrics collection and querying.
 *
 * Records per-workspace query latency and error counts, then aggregates
 * them into SLA summary views (p50/p95/p99 latency, error rate, uptime).
 * Uptime is derived as the inverse of the error rate (successful queries /
 * total queries), not measured via health checks.
 *
 * Storage: internal DB `sla_metrics` table. Data is recorded on each query
 * execution and queried by the platform admin API.
 *
 * Access-gated via platformAdminAuth middleware (platform_admin role required).
 *
 * All exported functions return Effect — callers use `yield*` in Effect.gen.
 * `recordQueryMetric` returns Effect but is designed for fire-and-forget usage.
 */

import { Effect } from "effect";
import { requireInternalDB } from "../lib/db-guard";
import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import { createLogger } from "@atlas/api/lib/logger";
import type { WorkspaceSLASummary, WorkspaceSLADetail, SLAMetricPoint } from "@useatlas/types";

const log = createLogger("ee:sla-metrics");

// ---------------------------------------------------------------------------
// Table bootstrap — idempotent, runs on first use
// ---------------------------------------------------------------------------

let _tableReady = false;

const ensureTable = (): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    if (_tableReady) return;
    yield* Effect.try({
      try: () => requireInternalDB("SLA metrics"),
      catch: (err) => err instanceof Error ? err : new Error(String(err)),
    });

    yield* Effect.promise(() => internalQuery(
      `CREATE TABLE IF NOT EXISTS sla_metrics (
         id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
         workspace_id  TEXT NOT NULL,
         latency_ms    DOUBLE PRECISION NOT NULL,
         is_error      BOOLEAN NOT NULL DEFAULT false,
         recorded_at   TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
    ));
    // Index for workspace + time range queries
    yield* Effect.promise(() => internalQuery(
      `CREATE INDEX IF NOT EXISTS idx_sla_metrics_ws_time ON sla_metrics (workspace_id, recorded_at DESC)`,
    ));

    // Alerts table
    yield* Effect.promise(() => internalQuery(
      `CREATE TABLE IF NOT EXISTS sla_alerts (
         id               TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
         workspace_id     TEXT NOT NULL,
         alert_type       TEXT NOT NULL,
         status           TEXT NOT NULL DEFAULT 'firing',
         current_value    DOUBLE PRECISION NOT NULL,
         threshold        DOUBLE PRECISION NOT NULL,
         message          TEXT NOT NULL,
         fired_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
         resolved_at      TIMESTAMPTZ,
         acknowledged_at  TIMESTAMPTZ,
         acknowledged_by  TEXT
       )`,
    ));
    yield* Effect.promise(() => internalQuery(
      `CREATE INDEX IF NOT EXISTS idx_sla_alerts_ws ON sla_alerts (workspace_id, status)`,
    ));

    // Thresholds table — one row per workspace (or a default row with workspace_id = '_default')
    yield* Effect.promise(() => internalQuery(
      `CREATE TABLE IF NOT EXISTS sla_thresholds (
         workspace_id       TEXT PRIMARY KEY,
         latency_p99_ms     DOUBLE PRECISION NOT NULL DEFAULT 5000,
         error_rate_pct     DOUBLE PRECISION NOT NULL DEFAULT 5,
         updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
    ));

    // Insert default thresholds row if missing
    const rawLatency = parseFloat(process.env.ATLAS_SLA_LATENCY_P99_MS ?? "");
    const rawErrorRate = parseFloat(process.env.ATLAS_SLA_ERROR_RATE_PCT ?? "");
    const defaultLatency = isNaN(rawLatency) ? 5000 : rawLatency;
    const defaultErrorRate = isNaN(rawErrorRate) ? 5 : rawErrorRate;
    yield* Effect.promise(() => internalQuery(
      `INSERT INTO sla_thresholds (workspace_id, latency_p99_ms, error_rate_pct)
       VALUES ('_default', $1, $2)
       ON CONFLICT (workspace_id) DO NOTHING`,
      [defaultLatency, defaultErrorRate],
    ));

    _tableReady = true;
  });

/** @internal Reset table-ready flag — for testing only. */
export function _resetTableReady(): void {
  _tableReady = false;
}

// ---------------------------------------------------------------------------
// Recording — called on each query execution
// ---------------------------------------------------------------------------

/**
 * Record a single query execution metric. Fire-and-forget — errors are
 * logged but never thrown so this doesn't break the query path.
 *
 * Returns an Effect. Callers should use `void Effect.runPromise(recordQueryMetric(...))`
 * for fire-and-forget semantics.
 */
export const recordQueryMetric = (
  workspaceId: string,
  latencyMs: number,
  isError: boolean,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (!hasInternalDB()) return;

    yield* ensureTable();
    yield* Effect.promise(() => internalQuery(
      `INSERT INTO sla_metrics (workspace_id, latency_ms, is_error) VALUES ($1, $2, $3)`,
      [workspaceId, latencyMs, isError],
    ));
  }).pipe(
    Effect.catchAll((err) => {
      log.warn(
        { err: err instanceof Error ? err.message : String(err), workspaceId },
        "Failed to record SLA metric",
      );
      return Effect.void;
    }),
  );

// ---------------------------------------------------------------------------
// Querying — platform admin API
// ---------------------------------------------------------------------------

/**
 * Get SLA summary for all workspaces over the given time window.
 * Default window: last 24 hours.
 */
export const getAllWorkspaceSLA = (
  hoursBack = 24,
): Effect.Effect<WorkspaceSLASummary[], Error> =>
  Effect.gen(function* () {
    yield* ensureTable();

    const rows = yield* Effect.promise(() => internalQuery<{
      workspace_id: string;
      workspace_name: string;
      total_queries: string;
      failed_queries: string;
      latency_p50: number | null;
      latency_p95: number | null;
      latency_p99: number | null;
      last_query_at: string | null;
    }>(
      `SELECT
         m.workspace_id,
         COALESCE(o.name, m.workspace_id) AS workspace_name,
         COUNT(*)::text AS total_queries,
         COUNT(*) FILTER (WHERE m.is_error)::text AS failed_queries,
         PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY m.latency_ms) AS latency_p50,
         PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY m.latency_ms) AS latency_p95,
         PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY m.latency_ms) AS latency_p99,
         MAX(m.recorded_at)::text AS last_query_at
       FROM sla_metrics m
       LEFT JOIN organization o ON o.id = m.workspace_id
       WHERE m.recorded_at > now() - make_interval(hours => $1)
       GROUP BY m.workspace_id, o.name
       ORDER BY COUNT(*) DESC`,
      [hoursBack],
    ));

    return rows.map((r) => {
      const total = parseInt(r.total_queries, 10);
      const failed = parseInt(r.failed_queries, 10);
      return {
        workspaceId: r.workspace_id,
        workspaceName: r.workspace_name,
        latencyP50Ms: Math.round(r.latency_p50 ?? 0),
        latencyP95Ms: Math.round(r.latency_p95 ?? 0),
        latencyP99Ms: Math.round(r.latency_p99 ?? 0),
        errorRatePct: total > 0 ? Math.round((failed / total) * 10000) / 100 : 0,
        uptimePct: total > 0 ? Math.round(((total - failed) / total) * 10000) / 100 : 100,
        totalQueries: total,
        failedQueries: failed,
        lastQueryAt: r.last_query_at,
      };
    });
  });

/**
 * Get detailed SLA data for a single workspace including time-series.
 */
export const getWorkspaceSLADetail = (
  workspaceId: string,
  hoursBack = 24,
): Effect.Effect<WorkspaceSLADetail, Error> =>
  Effect.gen(function* () {
    yield* ensureTable();

    // Summary
    const summaryRows = yield* Effect.promise(() => internalQuery<{
      workspace_name: string;
      total_queries: string;
      failed_queries: string;
      latency_p50: number | null;
      latency_p95: number | null;
      latency_p99: number | null;
      last_query_at: string | null;
    }>(
      `SELECT
         COALESCE(o.name, $1) AS workspace_name,
         COUNT(*)::text AS total_queries,
         COUNT(*) FILTER (WHERE m.is_error)::text AS failed_queries,
         PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY m.latency_ms) AS latency_p50,
         PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY m.latency_ms) AS latency_p95,
         PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY m.latency_ms) AS latency_p99,
         MAX(m.recorded_at)::text AS last_query_at
       FROM sla_metrics m
       LEFT JOIN organization o ON o.id = m.workspace_id
       WHERE m.workspace_id = $1 AND m.recorded_at > now() - make_interval(hours => $2)
       GROUP BY o.name`,
      [workspaceId, hoursBack],
    ));

    const r = summaryRows[0];
    const total = r ? parseInt(r.total_queries, 10) : 0;
    const failed = r ? parseInt(r.failed_queries, 10) : 0;

    const summary: WorkspaceSLASummary = {
      workspaceId,
      workspaceName: r?.workspace_name ?? workspaceId,
      latencyP50Ms: Math.round(r?.latency_p50 ?? 0),
      latencyP95Ms: Math.round(r?.latency_p95 ?? 0),
      latencyP99Ms: Math.round(r?.latency_p99 ?? 0),
      errorRatePct: total > 0 ? Math.round((failed / total) * 10000) / 100 : 0,
      uptimePct: total > 0 ? Math.round(((total - failed) / total) * 10000) / 100 : 100,
      totalQueries: total,
      failedQueries: failed,
      lastQueryAt: r?.last_query_at ?? null,
    };

    // Time-series: latency p99 and error rate per hour (independent queries)
    const [latencyRows, errorRows] = yield* Effect.promise(() => Promise.all([
      internalQuery<{ bucket: string; value: number }>(
        `SELECT
           date_trunc('hour', recorded_at)::text AS bucket,
           PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY latency_ms) AS value
         FROM sla_metrics
         WHERE workspace_id = $1 AND recorded_at > now() - make_interval(hours => $2)
         GROUP BY bucket
         ORDER BY bucket`,
        [workspaceId, hoursBack],
      ),
      internalQuery<{ bucket: string; value: number }>(
        `SELECT
           date_trunc('hour', recorded_at)::text AS bucket,
           CASE WHEN COUNT(*) > 0
                THEN (COUNT(*) FILTER (WHERE is_error)::float / COUNT(*)::float) * 100
                ELSE 0
           END AS value
         FROM sla_metrics
         WHERE workspace_id = $1 AND recorded_at > now() - make_interval(hours => $2)
         GROUP BY bucket
         ORDER BY bucket`,
        [workspaceId, hoursBack],
      ),
    ]));

    const toPoints = (rows: Array<{ bucket: string; value: number }>): SLAMetricPoint[] =>
      rows.map((row) => ({ timestamp: row.bucket, value: Math.round(row.value * 100) / 100 }));

    return {
      summary,
      latencyTimeline: toPoints(latencyRows),
      errorTimeline: toPoints(errorRows),
    };
  });
