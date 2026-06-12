"use client";

/**
 * Self-serve plan checkout / plan change via the Better Auth Stripe
 * plugin (#3418).
 *
 * `authClient.subscription.upgrade` covers both journeys:
 *   - First subscription → the plugin creates a Stripe Checkout session
 *     and returns its URL (we redirect; the session's success URL routes
 *     back through the plugin's /subscription/success sync endpoint to
 *     `/admin/billing?checkout=success`).
 *   - Existing subscription → the plugin returns a Billing Portal
 *     `subscription_update_confirm` URL, or applies the change directly
 *     and returns the `returnUrl`. Downgrades pass
 *     `scheduleAtPeriodEnd: true` so the cheaper plan lands at the period
 *     boundary via a Subscription Schedule instead of mid-cycle.
 *
 * Always org-scoped (`customerType: "organization"`); the server's
 * `authorizeReference` requires an admin/owner of the active org.
 * Success/cancel URLs are absolute against the WEB origin — the API may
 * live on another host, and the plugin resolves relative URLs against its
 * own baseURL (the API origin). The web origin must therefore be listed
 * in BETTER_AUTH_TRUSTED_ORIGINS (already required for cross-origin auth).
 */

import { useState } from "react";
import { authClient } from "@/lib/auth/client";

function checkoutErrorMessage(error: { code?: string; message?: string } | null | undefined): string {
  switch (error?.code) {
    case "UNAUTHORIZED":
      return "Only workspace admins and owners can change the plan.";
    case "ALREADY_SUBSCRIBED_PLAN":
      return "This workspace is already on that plan.";
    case "SUBSCRIPTION_PLAN_NOT_FOUND":
      return "That plan is not available on this deployment. Please contact support.";
    case "EMAIL_VERIFICATION_REQUIRED":
      return "Verify your email address before subscribing.";
    default:
      return error?.message || "Could not start checkout. Please try again.";
  }
}

export function usePlanCheckout(): {
  /** Start checkout (no subscription) or a plan change (subscribed). */
  startCheckout: (opts: { plan: string; scheduleAtPeriodEnd?: boolean }) => Promise<void>;
  /** The plan a request is currently in flight for, or null. */
  pendingPlan: string | null;
  error: string | null;
  clearError: () => void;
} {
  const [pendingPlan, setPendingPlan] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function startCheckout(opts: { plan: string; scheduleAtPeriodEnd?: boolean }): Promise<void> {
    setPendingPlan(opts.plan);
    setError(null);
    try {
      const upgrade = authClient.subscription?.upgrade;
      if (!upgrade) {
        setError("Checkout is unavailable in this build. Please contact support.");
        setPendingPlan(null);
        return;
      }
      const origin = window.location.origin;
      // successUrl/cancelUrl serve the FIRST-subscription Checkout journey;
      // returnUrl serves the change-plan journey (portal confirm / direct
      // update). The latter previously returned bare — no ?checkout param —
      // so the page rendered the stale tier with no lag handling at all
      // (internal review on #3442). `changed` polls for the target tier
      // (carried in ?plan=); `scheduled` is a static period-end notice.
      const changedState = opts.scheduleAtPeriodEnd ? "scheduled" : "changed";
      const res = await upgrade({
        plan: opts.plan,
        customerType: "organization",
        successUrl: `${origin}/admin/billing?checkout=success`,
        cancelUrl: `${origin}/admin/billing?checkout=cancelled`,
        returnUrl: `${origin}/admin/billing?checkout=${changedState}&plan=${opts.plan}`,
        scheduleAtPeriodEnd: opts.scheduleAtPeriodEnd ?? false,
        disableRedirect: true,
      });
      const url = res?.data?.url;
      if (url) {
        window.location.assign(url);
        // Keep pendingPlan set while the browser navigates; if navigation
        // is blocked (popup blocker, intercepted test env) re-enable the
        // grid after 10s instead of leaving it disabled forever.
        setTimeout(() => setPendingPlan(null), 10_000);
        return;
      }
      console.warn("Plan checkout: no URL returned", res?.error ?? res?.data);
      setError(checkoutErrorMessage(res?.error));
      setPendingPlan(null);
    } catch (err) {
      console.warn(
        "Plan checkout request failed:",
        err instanceof Error ? err.message : String(err),
      );
      setError("Could not reach the billing service. Check your connection and try again.");
      setPendingPlan(null);
    }
  }

  return { startCheckout, pendingPlan, error, clearError: () => setError(null) };
}
