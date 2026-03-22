// ---------------------------------------------------------------------------
// Plan limit status — returned by enforcement and billing endpoints
// ---------------------------------------------------------------------------

/** Overage status levels for a workspace's usage against its plan limits. */
export type OverageStatus = "ok" | "warning" | "soft_limit" | "hard_limit";

/**
 * Usage status for a single metered dimension (queries or tokens).
 *
 * Included in billing API responses and enforcement headers so clients
 * can display usage bars, warnings, and upgrade CTAs.
 */
export interface PlanLimitStatus {
  /** Which metric this status applies to. */
  metric: "queries" | "tokens";
  /** Current usage count for the billing period. */
  currentUsage: number;
  /** Plan limit for the billing period. -1 = unlimited. */
  limit: number;
  /** Usage as a percentage of the limit (0–999). */
  usagePercent: number;
  /** Overage status level. */
  status: OverageStatus;
}
