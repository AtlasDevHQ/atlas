/**
 * Sign-out wrapper that forgets the regional routing hint (ADR-0024 §3, #4090).
 *
 * The `atlas_region` cookie is a non-httpOnly, ~1-year hint the login
 * front-door's `resolve-region` reads as a tiebreaker. If it outlives a
 * sign-out it pins the *next* sign-in on this browser — a different user on a
 * shared machine, a multi-region user, or someone whose account migrated
 * regions — to the prior session's region. Clearing it on every sign-out lets
 * the next returning user resolve their own region from scratch.
 *
 * `resolveRegion` no longer lets a stale cookie misroute or fabricate a region
 * (the fan-out is authoritative), so this is defense-in-depth — but it keeps
 * the routing hint honest rather than leaving a dead session's region behind.
 *
 * The clear runs first and unconditionally: `atlas_region` is a client-only
 * cookie, so forgetting the hint must not hinge on the server round-trip
 * succeeding, and a stale hint is worse than none. The caller still owns the
 * sign-out result (navigation, error surfacing) and its own error handling — we
 * delegate to the provided thunk and return its value untouched.
 */

import { clearRegionSignal } from "@/lib/api-url";

/**
 * Forget the `atlas_region` routing hint, then run the caller's sign-out.
 * Generic over the thunk's return so each call site keeps the Better Auth
 * result shape it already branches on (e.g. AuthGuard's `{ error }` check).
 */
export async function signOutForgettingRegion<T>(signOut: () => Promise<T>): Promise<T> {
  clearRegionSignal();
  return signOut();
}
