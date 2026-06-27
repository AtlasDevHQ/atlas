// ---------------------------------------------------------------------------
// Plan limit status — returned by enforcement and billing endpoints
// ---------------------------------------------------------------------------

/**
 * Overage status levels for a workspace's usage against its plan limits.
 *
 * Metered soft-cap progression, denominated in dollars (#3990, #4038):
 * - `ok` (0–79%): within the included usage credit, no signal.
 * - `warning` (80–99%): approaching the included credit.
 * - `metered` (100% → ceiling): over the included credit but still served —
 *   every dollar past the credit accrues at provider cost (zero markup). The
 *   billing page surfaces the accrued "in overage, $X.XX so far" figure. A
 *   paying workspace is metered, not cut off, for ordinary overage.
 * - `hard_limit` (≥ ceiling): the cutoff. Under the `continue` spend policy the
 *   ceiling is the abuse ceiling (a conservative multiple of the credit) that
 *   bounds runaway spend; under `cutoff` it clamps to the credit (100%). The
 *   request is cut off with a 429 here and only here.
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
 * Usage status for the metered usage dimension, denominated in dollars (#4038).
 *
 * Included in billing API responses and enforcement warnings so clients
 * can display usage bars, warnings, and upgrade CTAs.
 */
export interface PlanLimitStatus {
  /**
   * Which metric this status applies to. `usd` — the at-cost usage spend
   * measured against the included dollar credit (Structure B, #4038).
   */
  metric: "usd";
  /** Current usage for the billing period, in USD (summed at-cost provider spend). */
  currentUsage: number;
  /** Included usage credit for the billing period, in USD (`$/seat × seats`). */
  limit: number;
  /** Usage as a percentage of the credit. 0 = no usage, 100 = at the credit. No upper bound. */
  usagePercent: number;
  /** Overage status level. */
  status: OverageStatus;
}
