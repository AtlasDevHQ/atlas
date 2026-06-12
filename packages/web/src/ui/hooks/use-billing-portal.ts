"use client";

/**
 * Stripe Customer Portal access via the Better Auth Stripe plugin (#3417).
 *
 * Replaces the deleted hand-rolled `POST /api/v1/billing/portal` route:
 * `authClient.subscription.billingPortal` hits the plugin's org-aware
 * `/api/auth/subscription/billing-portal`, which reads the plugin-owned
 * `organization.stripeCustomerId` and enforces `authorizeReference`
 * (admin/owner of the active org). Shared by /admin/billing and
 * /admin/usage so the two "Manage plan" buttons can't drift.
 *
 * `opening` stays true through the redirect on success — resetting it
 * before `location.assign` completes would flash the button re-enabled.
 */

import { useState } from "react";
import { authClient } from "@/lib/auth/client";

/**
 * Better Auth error codes this hook maps to actionable copy. The portal
 * is created lazily by Stripe checkout, so CUSTOMER_NOT_FOUND is the
 * expected state for a workspace that has never subscribed — by design
 * the UI routes those users to checkout, not the portal (#3418).
 */
function portalErrorMessage(error: { code?: string; message?: string } | null | undefined): string {
  switch (error?.code) {
    case "CUSTOMER_NOT_FOUND":
      return "This workspace has no billing profile yet. Subscribe to a plan first.";
    case "UNAUTHORIZED":
      return "Only workspace admins and owners can open the billing portal.";
    default:
      return error?.message || "Could not open the billing portal. Please try again.";
  }
}

export function useBillingPortal(): {
  openPortal: () => Promise<void>;
  opening: boolean;
  error: string | null;
  clearError: () => void;
} {
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function openPortal(): Promise<void> {
    setOpening(true);
    setError(null);
    try {
      const billingPortal = authClient.subscription?.billingPortal;
      if (!billingPortal) {
        // Better Auth client API drift — surface precisely rather than TypeError.
        setError("Billing portal is unavailable in this build. Please contact support.");
        setOpening(false);
        return;
      }
      const res = await billingPortal({
        customerType: "organization",
        returnUrl: window.location.href,
        disableRedirect: true,
      });
      const url = res?.data?.url;
      if (url) {
        window.location.assign(url);
        return; // keep `opening` true until the browser navigates
      }
      console.warn("Billing portal: no URL returned", res?.error ?? res?.data);
      setError(portalErrorMessage(res?.error));
      setOpening(false);
    } catch (err) {
      console.warn(
        "Billing portal request failed:",
        err instanceof Error ? err.message : String(err),
      );
      setError("Could not reach the billing service. Check your connection and try again.");
      setOpening(false);
    }
  }

  return { openPortal, opening, error, clearError: () => setError(null) };
}
