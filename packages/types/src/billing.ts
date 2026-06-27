// ---------------------------------------------------------------------------
// Plan limit status — returned by enforcement and billing endpoints
// ---------------------------------------------------------------------------

/**
 * Overage status levels for a workspace's usage against its plan limits.
 *
 * Metered soft-cap progression (#3990):
 * - `ok` (0–79%): within budget, no signal.
 * - `warning` (80–99%): approaching the included budget.
 * - `metered` (100% → `AbuseCeiling`): over the included budget but still
 *   served — every token past 100% accrues billable overage at the plan's
 *   `overagePerMillionTokens` rate. The billing page surfaces the accrued
 *   "in overage, $X.XX so far" figure. This REPLACES the old 110% hard block:
 *   a paying workspace is metered, not cut off, for ordinary overage.
 * - `hard_limit` (≥ `AbuseCeiling`): the abuse ceiling, NOT the budget limit.
 *   A configurable, conservative multiple of the budget that bounds runaway /
 *   abusive spend; the request is cut off with a 429 here and only here.
 *
 * `soft_limit` is retained in the union for wire/back-compat (older API or web
 * bundles may still emit or parse it) but the current classifier never returns
 * it — the 100%+ band is `metered`.
 */
export type OverageStatus =
  | "ok"
  | "warning"
  | "soft_limit"
  | "metered"
  | "hard_limit";

/**
 * Usage status for a single metered dimension (queries or tokens).
 *
 * Included in billing API responses and enforcement headers so clients
 * can display usage bars, warnings, and upgrade CTAs.
 */
export interface PlanLimitStatus {
  /** Which metric this status applies to. */
  metric: "tokens";
  /** Current usage count for the billing period. */
  currentUsage: number;
  /** Plan limit for the billing period. -1 = unlimited. */
  limit: number;
  /** Usage as a percentage of the limit. 0 = no usage, 100 = at limit. No upper bound. */
  usagePercent: number;
  /** Overage status level. */
  status: OverageStatus;
}
