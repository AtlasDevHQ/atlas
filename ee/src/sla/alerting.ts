/**
 * SLA alerting — threshold evaluation and alert state management.
 *
 * Evaluates workspace metrics against configurable thresholds, creates
 * and resolves alerts, and delivers notifications via webhook.
 *
 * Access-gated via platformAdminAuth middleware (platform_admin role required).
 */

import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import { createLogger } from "@atlas/api/lib/logger";
import type { SLAAlert, SLAAlertStatus, SLAAlertType, SLAThresholds } from "@useatlas/types";

const log = createLogger("ee:sla-alerting");

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

/**
 * Get the effective thresholds for a workspace. Falls back to the
 * `_default` row if no workspace-specific overrides exist, then to
 * env vars (`ATLAS_SLA_LATENCY_P99_MS`, `ATLAS_SLA_ERROR_RATE_PCT`)
 * with hardcoded defaults.
 */
export async function getThresholds(workspaceId?: string): Promise<SLAThresholds> {


  if (!hasInternalDB()) {
    throw new Error("Internal database not configured — SLA thresholds require DATABASE_URL");
  }

  if (workspaceId) {
    const rows = await internalQuery<{
      latency_p99_ms: number;
      error_rate_pct: number;
    }>(
      `SELECT latency_p99_ms, error_rate_pct
       FROM sla_thresholds WHERE workspace_id = $1`,
      [workspaceId],
    );
    if (rows.length > 0) {
      return {
        latencyP99Ms: rows[0].latency_p99_ms,
        errorRatePct: rows[0].error_rate_pct,
      };
    }
  }

  const defaults = await internalQuery<{
    latency_p99_ms: number;
    error_rate_pct: number;
  }>(`SELECT latency_p99_ms, error_rate_pct FROM sla_thresholds WHERE workspace_id = '_default'`);

  if (defaults.length > 0) {
    return {
      latencyP99Ms: defaults[0].latency_p99_ms,
      errorRatePct: defaults[0].error_rate_pct,
    };
  }

  return defaultThresholds();
}

function defaultThresholds(): SLAThresholds {
  const latency = parseFloat(process.env.ATLAS_SLA_LATENCY_P99_MS ?? "");
  const errorRate = parseFloat(process.env.ATLAS_SLA_ERROR_RATE_PCT ?? "");
  return {
    latencyP99Ms: isNaN(latency) ? 5000 : latency,
    errorRatePct: isNaN(errorRate) ? 5 : errorRate,
  };
}

/**
 * Update the default SLA thresholds.
 */
export async function updateThresholds(thresholds: SLAThresholds): Promise<void> {


  if (!hasInternalDB()) {
    throw new Error("Internal database not configured");
  }

  await internalQuery(
    `INSERT INTO sla_thresholds (workspace_id, latency_p99_ms, error_rate_pct, updated_at)
     VALUES ('_default', $1, $2, now())
     ON CONFLICT (workspace_id) DO UPDATE SET
       latency_p99_ms = $1,
       error_rate_pct = $2,
       updated_at = now()`,
    [thresholds.latencyP99Ms, thresholds.errorRatePct],
  );
}

// ---------------------------------------------------------------------------
// Alert queries
// ---------------------------------------------------------------------------

/**
 * Get all alerts, optionally filtered by status.
 */
export async function getAlerts(
  status?: SLAAlertStatus,
  limit = 100,
): Promise<SLAAlert[]> {


  if (!hasInternalDB()) {
    throw new Error("Internal database not configured — SLA alerts require DATABASE_URL");
  }

  const rows = await internalQuery<{
    id: string;
    workspace_id: string;
    workspace_name: string;
    alert_type: SLAAlertType;
    status: SLAAlertStatus;
    current_value: number;
    threshold: number;
    message: string;
    fired_at: string;
    resolved_at: string | null;
    acknowledged_at: string | null;
    acknowledged_by: string | null;
  }>(
    status
      ? `SELECT a.id, a.workspace_id, COALESCE(o.name, a.workspace_id) AS workspace_name,
              a.alert_type, a.status, a.current_value, a.threshold, a.message,
              a.fired_at::text, a.resolved_at::text, a.acknowledged_at::text, a.acknowledged_by
         FROM sla_alerts a
         LEFT JOIN organization o ON o.id = a.workspace_id
         WHERE a.status = $1
         ORDER BY a.fired_at DESC LIMIT $2`
      : `SELECT a.id, a.workspace_id, COALESCE(o.name, a.workspace_id) AS workspace_name,
              a.alert_type, a.status, a.current_value, a.threshold, a.message,
              a.fired_at::text, a.resolved_at::text, a.acknowledged_at::text, a.acknowledged_by
         FROM sla_alerts a
         LEFT JOIN organization o ON o.id = a.workspace_id
         ORDER BY a.fired_at DESC LIMIT $1`,
    status ? [status, limit] : [limit],
  );

  return rows.map(toAlert);
}

/**
 * Acknowledge an alert.
 */
export async function acknowledgeAlert(alertId: string, actorId: string): Promise<boolean> {


  if (!hasInternalDB()) {
    throw new Error("Internal database not configured — cannot acknowledge SLA alerts");
  }

  const rows = await internalQuery<{ id: string }>(
    `UPDATE sla_alerts
     SET status = 'acknowledged', acknowledged_at = now(), acknowledged_by = $2
     WHERE id = $1 AND status = 'firing'
     RETURNING id`,
    [alertId, actorId],
  );

  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Alert evaluation — called periodically or on-demand
// ---------------------------------------------------------------------------

/**
 * Evaluate all workspaces against thresholds and create/resolve alerts.
 * Returns newly fired alerts. Notifications are dispatched internally
 * via webhook (if configured).
 */
export async function evaluateAlerts(): Promise<SLAAlert[]> {


  if (!hasInternalDB()) {
    throw new Error("Internal database not configured — SLA evaluation requires DATABASE_URL");
  }

  const thresholds = await getThresholds();
  const newAlerts: SLAAlert[] = [];

  // Get recent metrics per workspace (last hour)
  const wsMetrics = await internalQuery<{
    workspace_id: string;
    workspace_name: string;
    latency_p99: number | null;
    error_rate: number;
    total_queries: string;
  }>(
    `SELECT
       m.workspace_id,
       COALESCE(o.name, m.workspace_id) AS workspace_name,
       PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY m.latency_ms) AS latency_p99,
       CASE WHEN COUNT(*) > 0
            THEN (COUNT(*) FILTER (WHERE m.is_error)::float / COUNT(*)::float) * 100
            ELSE 0
       END AS error_rate,
       COUNT(*)::text AS total_queries
     FROM sla_metrics m
     LEFT JOIN organization o ON o.id = m.workspace_id
     WHERE m.recorded_at > now() - interval '1 hour'
     GROUP BY m.workspace_id, o.name`,
  );

  for (const ws of wsMetrics) {
    try {
      const totalQueries = parseInt(ws.total_queries, 10);
      if (totalQueries === 0) continue;

      // Check latency P99
      if (ws.latency_p99 !== null && ws.latency_p99 > thresholds.latencyP99Ms) {
        const alert = await createAlertIfNotFiring(
          ws.workspace_id,
          ws.workspace_name,
          "latency_p99",
          ws.latency_p99,
          thresholds.latencyP99Ms,
          `Workspace "${ws.workspace_name}" p99 latency ${Math.round(ws.latency_p99)}ms exceeds threshold ${thresholds.latencyP99Ms}ms`,
        );
        if (alert) newAlerts.push(alert);
      } else {
        await resolveAlertsForType(ws.workspace_id, "latency_p99");
      }

      // Check error rate
      if (ws.error_rate > thresholds.errorRatePct) {
        const alert = await createAlertIfNotFiring(
          ws.workspace_id,
          ws.workspace_name,
          "error_rate",
          ws.error_rate,
          thresholds.errorRatePct,
          `Workspace "${ws.workspace_name}" error rate ${ws.error_rate.toFixed(1)}% exceeds threshold ${thresholds.errorRatePct}%`,
        );
        if (alert) newAlerts.push(alert);
      } else {
        await resolveAlertsForType(ws.workspace_id, "error_rate");
      }
    } catch (err) {
      log.error(
        { err: err instanceof Error ? err.message : String(err), workspaceId: ws.workspace_id },
        "Failed to evaluate SLA for workspace — skipping",
      );
    }
  }

  if (newAlerts.length > 0) {
    log.info({ count: newAlerts.length }, "New SLA alerts fired");
    // Attempt webhook delivery (non-critical)
    for (const alert of newAlerts) {
      try {
        await deliverAlert(alert);
      } catch (err) {
        log.error(
          { err: err instanceof Error ? err.message : String(err), alertId: alert.id },
          "Failed to deliver SLA alert notification — alert was created but notification was not sent",
        );
      }
    }
  }

  return newAlerts;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createAlertIfNotFiring(
  workspaceId: string,
  workspaceName: string,
  alertType: SLAAlertType,
  currentValue: number,
  threshold: number,
  message: string,
): Promise<SLAAlert | null> {
  // Check if there's already a firing alert for this workspace + type
  const existing = await internalQuery<{ id: string }>(
    `SELECT id FROM sla_alerts
     WHERE workspace_id = $1 AND alert_type = $2 AND status = 'firing'
     LIMIT 1`,
    [workspaceId, alertType],
  );

  if (existing.length > 0) return null;

  const rows = await internalQuery<{
    id: string;
    fired_at: string;
  }>(
    `INSERT INTO sla_alerts (workspace_id, alert_type, status, current_value, threshold, message)
     VALUES ($1, $2, 'firing', $3, $4, $5)
     RETURNING id, fired_at::text`,
    [workspaceId, alertType, currentValue, threshold, message],
  );

  if (rows.length === 0) return null;

  return {
    id: rows[0].id,
    workspaceId,
    workspaceName,
    type: alertType,
    status: "firing",
    currentValue,
    threshold,
    message,
    firedAt: rows[0].fired_at,
    resolvedAt: null,
    acknowledgedAt: null,
    acknowledgedBy: null,
  };
}

async function resolveAlertsForType(workspaceId: string, alertType: SLAAlertType): Promise<void> {
  await internalQuery(
    `UPDATE sla_alerts SET status = 'resolved', resolved_at = now()
     WHERE workspace_id = $1 AND alert_type = $2 AND status = 'firing'`,
    [workspaceId, alertType],
  );
}

function toAlert(row: {
  id: string;
  workspace_id: string;
  workspace_name: string;
  alert_type: SLAAlertType;
  status: SLAAlertStatus;
  current_value: number;
  threshold: number;
  message: string;
  fired_at: string;
  resolved_at: string | null;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
}): SLAAlert {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    workspaceName: row.workspace_name,
    type: row.alert_type,
    status: row.status,
    currentValue: row.current_value,
    threshold: row.threshold,
    message: row.message,
    firedAt: row.fired_at,
    resolvedAt: row.resolved_at,
    acknowledgedAt: row.acknowledged_at,
    acknowledgedBy: row.acknowledged_by,
  };
}

/**
 * Deliver alert notification via webhook or email (best-effort).
 * Sends an HTTP POST with a JSON payload to the configured webhook URL.
 */
async function deliverAlert(alert: SLAAlert): Promise<void> {
  const webhookUrl = process.env.ATLAS_SLA_WEBHOOK_URL;
  if (!webhookUrl) return;

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "sla.alert.fired",
      alert,
      timestamp: new Date().toISOString(),
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "(unreadable body)");
    log.error(
      { status: response.status, alertId: alert.id, responseBody: body.slice(0, 500) },
      "SLA alert webhook delivery failed — alert notification was not delivered",
    );
  }
}
