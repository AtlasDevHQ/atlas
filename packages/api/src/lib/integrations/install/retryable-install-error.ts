/**
 * `retryableInstallError` — the shared mid-fan-out failure wrapper for the four
 * knowledge connectors that create one collection per vendor object (Zendesk
 * per brand, Help Scout per site, Front per knowledge base, Freshdesk per
 * category).
 *
 * Each of those handlers writes its collections in a loop, so a failure on item
 * N leaves items 1..N-1 installed. The wrapper's job is to say so: the install
 * is idempotent, so retrying re-runs the whole batch and simply updates what
 * already landed.
 *
 * **A plan/billing denial is NOT wrapped.** `FeatureEntitlementError` (403
 * `plan_upgrade_required`) and `BillingCheckFailedError` (503) are
 * `Data.TaggedError`s whose `_tag` is what `classifyError` maps to an HTTP
 * response. Flattening them into a plain `Error` would erase the tag — the
 * request would land on the unmapped-error arm as a **500 `internal_error`**,
 * and the message would tell the admin that "retrying the install is safe" when
 * retrying a cap denial fails identically every time (#4235). They are returned
 * unchanged so the caller's `throw` re-raises the original tagged error.
 *
 * Single-homed because all four copies were byte-identical apart from the noun,
 * and the passthrough above is exactly the kind of rule that must not exist in
 * four places.
 *
 * @module
 */

import {
  BillingCheckFailedError,
  FeatureEntitlementError,
} from "@atlas/api/lib/effect/errors";

/**
 * True when `err` already carries its own HTTP envelope and must reach the
 * route untouched. Exported so a handler's `catch` can also skip the "rolling
 * back — retrying is safe" log line for these.
 */
export function isPlanDenial(err: unknown): boolean {
  return err instanceof FeatureEntitlementError || err instanceof BillingCheckFailedError;
}

/**
 * Wrap a mid-fan-out install failure with retry guidance — or pass a plan
 * denial straight through (see the module docblock).
 *
 * @param slug - The collection whose write failed.
 * @param err - The originating error.
 * @param itemNoun - What this connector fans out over ("brand", "site", …),
 *   used only in the retry-guidance sentence.
 */
export function retryableInstallError(slug: string, err: unknown, itemNoun: string): unknown {
  if (isPlanDenial(err)) return err;
  return new Error(
    `Failed to install the "${slug}" collection: ${err instanceof Error ? err.message : String(err)}. Retrying the install is safe — already-installed ${itemNoun} collections are simply updated in place.`,
    { cause: err },
  );
}
