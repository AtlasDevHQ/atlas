/**
 * Subscription-state presentation helpers for the billing page (#3429).
 *
 * The single web-side statement of "how do we present this Stripe
 * subscription state" — shared by the plan card's status dot, badge, and
 * portal CTA so they can't disagree. The API now returns the subscription
 * for ALL statuses (past_due / unpaid / canceled included, not just
 * active/trialing — #3429), so the UI is responsible for presenting each
 * state instead of the previous "subscription === null → hide everything".
 *
 * Stripe owns the status vocabulary, so this module classifies by membership
 * rather than enumerating an exhaustive union — an unrecognized status falls
 * through to a neutral "active-ish" presentation rather than reading as
 * broken.
 */

import type { StatusKind } from "@/ui/components/admin/compact";
import type { BillingSubscription } from "@useatlas/schemas";

/**
 * Stripe statuses that mean the customer must act to fix payment. These get
 * a destructive badge + a "Fix payment" portal CTA — the portal is exactly
 * what they need to reach, and the old code hid it.
 */
const DELINQUENT_STATUSES = new Set(["past_due", "unpaid", "incomplete"]);

/** Stripe statuses for a subscription that has ended (no longer billing). */
const ENDED_STATUSES = new Set(["canceled", "incomplete_expired"]);

/** Healthy, currently-billing (or trialing) states. */
const HEALTHY_STATUSES = new Set(["active", "trialing"]);

export interface SubscriptionPresentation {
  /** Status dot kind for the plan-card Shell. */
  statusKind: StatusKind;
  /** shadcn Badge variant for the status pill. */
  badgeVariant: "default" | "secondary" | "outline" | "destructive";
  /** Whether to render the billing-portal button. */
  showPortal: boolean;
  /** Portal button copy — "Fix payment" when delinquent, else "Open billing portal". */
  portalLabel: string;
  /**
   * Delinquent (past_due / unpaid / incomplete) — the user must reach the
   * portal to restore service. Drives the warning notice + CTA emphasis.
   */
  isDelinquent: boolean;
  /** Trialing — healthy, must not read as "disconnected"/broken (#3429). */
  isTrialing: boolean;
  /** Subscription has ended (canceled). */
  isEnded: boolean;
}

/**
 * Derive how to present a subscription state. `subscription === null` means
 * the workspace has no subscription at all (never subscribed) — callers
 * handle that separately; this assumes a row is present.
 */
export function subscriptionPresentation(
  subscription: BillingSubscription,
): SubscriptionPresentation {
  const status = subscription.status;
  const isDelinquent = DELINQUENT_STATUSES.has(status);
  const isEnded = ENDED_STATUSES.has(status);
  const isTrialing = status === "trialing";
  const isHealthy = HEALTHY_STATUSES.has(status);

  const statusKind: StatusKind = isDelinquent
    ? "unhealthy"
    : isEnded
      ? "disconnected"
      : isHealthy
        ? "connected"
        : // Unknown Stripe status — present neutrally as connected rather
          // than flagging a healthy-but-unenumerated state as broken.
          "connected";

  const badgeVariant: SubscriptionPresentation["badgeVariant"] = isDelinquent
    ? "destructive"
    : isEnded
      ? "outline"
      : "secondary";

  return {
    statusKind,
    badgeVariant,
    // Portal is reachable whenever a subscription row exists (a
    // stripe_customer_id is implied). The delinquent customer needs it most.
    showPortal: true,
    portalLabel: isDelinquent ? "Fix payment" : "Open billing portal",
    isDelinquent,
    isTrialing,
    isEnded,
  };
}

/**
 * Whether the workspace has a subscription that should be treated as
 * "existing" by the plan picker (Change plan vs Choose a plan). A canceled /
 * expired subscription is visible (#3429) but is NOT a live plan to change —
 * the user needs to resubscribe, so the picker should offer "Subscribe", not
 * "Upgrade/Downgrade". `null` (never subscribed) is likewise not active.
 */
export function hasActiveSubscription(
  subscription: BillingSubscription | null,
): boolean {
  if (!subscription) return false;
  return !ENDED_STATUSES.has(subscription.status);
}

/**
 * Copy for a pending cancel-at-period-end notice, or null when the
 * subscription is not scheduled to cancel. `formatDate` is injected so this
 * stays pure and testable (the page passes its shared `formatDate`).
 */
export function cancelAtPeriodEndNotice(
  subscription: BillingSubscription,
  formatDate: (value: string) => string,
): string | null {
  if (!subscription.cancelAtPeriodEnd) return null;
  return subscription.periodEnd
    ? `Cancels at the end of the current period · access ends ${formatDate(subscription.periodEnd)}`
    : "Cancels at the end of the current billing period";
}
