import { parseAsStringEnum } from "nuqs";

/**
 * URL state for the billing page (#3418).
 *
 * `checkout` is stamped by the Stripe Checkout return URLs
 * (`?checkout=success` / `?checkout=cancelled`) — `success` drives the
 * "finalizing your subscription" poll until the webhook lands the new
 * tier; `cancelled` shows a dismissable notice.
 *
 * `plan` preselects a plan-picker card. Set by the pricing page intent
 * (`/signup?plan=…`, carried via `lib/billing/plan-intent`) or shared
 * directly as a deep link.
 */
export const billingSearchParams = {
  checkout: parseAsStringEnum(["success", "cancelled"]),
  plan: parseAsStringEnum(["starter", "pro", "business"]),
};
