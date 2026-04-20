import type { PlanTier } from "./platform";

// ---------------------------------------------------------------------------
// Plan limit status — returned by enforcement and billing endpoints
// ---------------------------------------------------------------------------

/** Overage status levels for a workspace's usage against its plan limits. */
export const OVERAGE_STATUSES = ["ok", "warning", "soft_limit", "hard_limit"] as const;
export type OverageStatus = (typeof OVERAGE_STATUSES)[number];

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

// ---------------------------------------------------------------------------
// Billing status — workspace-scoped wire shape served by GET /api/v1/billing
// ---------------------------------------------------------------------------

/** Plan details surfaced on the billing page. */
export interface BillingPlan {
  tier: PlanTier;
  displayName: string;
  pricePerSeat: number;
  defaultModel: string;
  byot: boolean;
  trialEndsAt: string | null;
}

/** Plan limits (null = unlimited). */
export interface BillingLimits {
  tokenBudgetPerSeat: number | null;
  totalTokenBudget: number | null;
  maxSeats: number | null;
  maxConnections: number | null;
}

/** Current-period usage counters. */
export interface BillingUsage {
  queryCount: number;
  tokenCount: number;
  seatCount: number;
  tokenUsagePercent: number;
  tokenOverageStatus: OverageStatus;
  periodStart: string;
  periodEnd: string;
}

/** Seat limit / current count. */
export interface BillingSeatCount {
  count: number;
  max: number | null;
}

/** Connection limit / current count. */
export interface BillingConnectionCount {
  count: number;
  max: number | null;
}

/**
 * Active Stripe subscription summary, or `null` when the workspace has no
 * active or trialing subscription. `plan` and `status` come directly from
 * Stripe / Better Auth and are intentionally free-form strings: Stripe
 * controls the vocabulary and we don't want to fail parse on a new
 * Stripe status the TS union doesn't enumerate.
 */
export interface BillingSubscription {
  stripeSubscriptionId: string;
  plan: string;
  status: string;
}

export interface BillingStatus {
  workspaceId: string;
  plan: BillingPlan;
  limits: BillingLimits;
  usage: BillingUsage;
  seats: BillingSeatCount;
  connections: BillingConnectionCount;
  currentModel: string;
  overagePerMillionTokens: number;
  subscription: BillingSubscription | null;
}
