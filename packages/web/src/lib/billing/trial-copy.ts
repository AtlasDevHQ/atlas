/**
 * Trial-state helpers for the billing page (#3434).
 *
 * The single web-side statement of "which date is the trial clock" and
 * "is it expired", shared by the hero stat and the plan card so the two
 * can't disagree. The date itself is server-computed
 * (`plan.trialEndsAtEffective` — trial_ends_at with enforcement's
 * createdAt + TRIAL_DAYS fallback); this module only picks the field and
 * compares it to the clock.
 */

import type { BillingPlan } from "@useatlas/schemas";

export type TrialPlanFields = Pick<
  BillingPlan,
  "tier" | "trialEndsAt" | "trialEndsAtEffective"
>;

/**
 * The trial clock to render: the server-computed effective end, falling
 * back to the raw `trialEndsAt` for an older API that doesn't send it.
 * Null for non-trial tiers and when neither field is present.
 */
export function effectiveTrialEnd(plan: TrialPlanFields): string | null {
  if (plan.tier !== "trial") return null;
  return plan.trialEndsAtEffective ?? plan.trialEndsAt;
}

/**
 * Whether the trial clock has run out. An unparseable date fails closed
 * into "expired" (matching TrialCountdownBanner) so the user sees the
 * upgrade nudge rather than optimistic copy. A null clock is "not
 * expired" — there is nothing to compare.
 */
export function isTrialEndPast(endsAt: string | null, now: number = Date.now()): boolean {
  if (!endsAt) return false;
  const endMs = Date.parse(endsAt);
  return !Number.isFinite(endMs) || endMs < now;
}
