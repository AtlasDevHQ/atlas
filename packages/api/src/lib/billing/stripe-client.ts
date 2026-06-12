/**
 * Shared Stripe client accessor (#3425).
 *
 * Single construction point for the Stripe SDK client so every caller —
 * the @better-auth/stripe plugin wiring in `lib/auth/server.ts` and the
 * workspace billing teardown in `lib/billing/workspace-teardown.ts` —
 * uses the same secret key and the same pinned `apiVersion`
 * ({@link STRIPE_API_VERSION}). Constructing ad-hoc clients elsewhere
 * risks drifting the wire schema on the billing path (see #3129).
 *
 * Returns `null` when `STRIPE_SECRET_KEY` is unset (self-hosted /
 * no-Stripe deployments) so callers can no-op cleanly. The instance is
 * cached per secret key — tests that swap the env var get a fresh client.
 */
import Stripe from "stripe";
import { STRIPE_API_VERSION } from "./stripe-api-version";

let cachedClient: Stripe | null = null;
let cachedKey: string | null = null;

export function getStripeClient(): Stripe | null {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  if (cachedClient && cachedKey === key) return cachedClient;
  cachedClient = new Stripe(key, { apiVersion: STRIPE_API_VERSION });
  cachedKey = key;
  return cachedClient;
}

/** Test-only: drop the cached client so env changes take effect. */
export function _resetStripeClientCache(): void {
  cachedClient = null;
  cachedKey = null;
}
