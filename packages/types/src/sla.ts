/**
 * SLA monitoring and alerting types.
 *
 * Used by platform admin console for per-workspace uptime,
 * query latency, error rate tracking, and alerting.
 */

// ---------------------------------------------------------------------------
// Metric types
// ---------------------------------------------------------------------------

export const SLA_METRIC_TYPES = ["latency_p50", "latency_p95", "latency_p99", "error_rate", "uptime"] as const;
export type SLAMetricType = (typeof SLA_METRIC_TYPES)[number];

/** Aggregated SLA metrics for a single workspace. */
export interface WorkspaceSLASummary {
  workspaceId: string;
  workspaceName: string;
  latencyP50Ms: number;
  latencyP95Ms: number;
  latencyP99Ms: number;
  errorRatePct: number;
  uptimePct: number;
  totalQueries: number;
  failedQueries: number;
  lastQueryAt: string | null;
}

/** A single metric data point for time-series charts. */
export interface SLAMetricPoint {
  timestamp: string;
  value: number;
}

/** Per-workspace detail view with time-series data. */
export interface WorkspaceSLADetail {
  summary: WorkspaceSLASummary;
  latencyTimeline: SLAMetricPoint[];
  errorTimeline: SLAMetricPoint[];
}

// ---------------------------------------------------------------------------
// Alert types
// ---------------------------------------------------------------------------

export const SLA_ALERT_STATUSES = ["firing", "resolved", "acknowledged"] as const;
export type SLAAlertStatus = (typeof SLA_ALERT_STATUSES)[number];

export const SLA_ALERT_TYPES = ["latency_p99", "error_rate", "downtime"] as const;
export type SLAAlertType = (typeof SLA_ALERT_TYPES)[number];

export interface SLAAlert {
  id: string;
  workspaceId: string;
  workspaceName: string;
  type: SLAAlertType;
  status: SLAAlertStatus;
  currentValue: number;
  threshold: number;
  message: string;
  firedAt: string;
  resolvedAt: string | null;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
}

// ---------------------------------------------------------------------------
// Threshold configuration
// ---------------------------------------------------------------------------

export interface SLAThresholds {
  latencyP99Ms: number;
  errorRatePct: number;
  downtimeMinutes: number;
}
