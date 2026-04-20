/**
 * SLA monitoring and alerting types.
 *
 * Used by platform admin console for per-workspace uptime,
 * query latency, error rate tracking, and alerting.
 */

import type { Percentage } from "./percentage";

// ---------------------------------------------------------------------------
// Metric types
// ---------------------------------------------------------------------------

/** Aggregated SLA metrics for a single workspace. */
export interface WorkspaceSLASummary {
  workspaceId: string;
  workspaceName: string;
  latencyP50Ms: number;
  latencyP95Ms: number;
  latencyP99Ms: number;
  /** Error rate on a 0–100 scale, branded `Percentage` (#1685). */
  errorRatePct: Percentage;
  /** Uptime on a 0–100 scale, branded `Percentage`. */
  uptimePct: Percentage;
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

export const SLA_ALERT_TYPES = ["latency_p99", "error_rate"] as const;
export type SLAAlertType = (typeof SLA_ALERT_TYPES)[number];

export interface SLAAlert {
  id: string;
  workspaceId: string;
  workspaceName: string;
  type: SLAAlertType;
  status: SLAAlertStatus;
  /** Current metric value that triggered the alert (ms for latency, % for error rate). */
  currentValue: number;
  /** Threshold that was exceeded (same unit as currentValue). */
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
  /** P99 latency threshold in milliseconds. */
  latencyP99Ms: number;
  /**
   * Error rate threshold on a 0–100 scale, branded `Percentage` (#1685).
   * Opposite convention from `AbuseThresholdConfig.errorRateThreshold`
   * (which is a `Ratio`) — the SLA surface kept the legacy percentage
   * format, and the brand makes the cross-module mixup a typecheck
   * failure instead of a runtime boundary bug.
   */
  errorRatePct: Percentage;
}
