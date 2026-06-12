import { parseAsStringEnum } from "nuqs";
import { PAID_TIERS } from "@/lib/billing/plan-intent";

/**
 * URL state for the billing page (#3418).
 *
 * `checkout` is stamped by the post-Stripe return URLs:
 *   - `success` / `cancelled` — Stripe Checkout (first subscription);
 *     `success` drives the "finalizing your subscription" poll until the
 *     webhook lands the new tier.
 *   - `changed` — an immediate plan change on an existing subscription
 *     (portal `subscription_update_confirm` or direct update); polls
 *     until the target tier appears.
 *   - `scheduled` — a downgrade scheduled for period end; static notice,
 *     nothing to poll for.
 *
 * `plan` preselects a plan-picker card (pricing-page intent or deep
 * link) AND names the target tier the `changed` poll waits for.
 */
export const billingSearchParams = {
  checkout: parseAsStringEnum(["success", "cancelled", "changed", "scheduled"]),
  plan: parseAsStringEnum([...PAID_TIERS]),
};
