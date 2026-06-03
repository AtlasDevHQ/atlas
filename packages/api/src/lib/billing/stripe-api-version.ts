/**
 * Pinned Stripe API version for all `new Stripe(...)` clients in Atlas.
 *
 * The Stripe Node SDK pins a default API version per release and sends it as the
 * `Stripe-Version` header when `apiVersion` is omitted. Bumping the SDK can therefore
 * silently change the request/webhook schema on the billing path — e.g. v21 defaulted
 * to `2026-03-25.dahlia`, v22.2 to `2026-05-27.dahlia`. We pin it explicitly so the
 * adopted version is a deliberate, reviewed decision rather than a side effect of a
 * dependency bump (see #3129).
 *
 * This is typed against the SDK's `LatestApiVersion` at each `new Stripe(...)` call
 * site, so a future SDK bump that changes the default surfaces here as a compile error —
 * forcing a conscious re-validation before the new version reaches prod billing.
 */
export const STRIPE_API_VERSION = "2026-05-27.dahlia";
