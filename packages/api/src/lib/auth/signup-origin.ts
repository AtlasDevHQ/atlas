/**
 * Signup-origin context — a tiny AsyncLocalStorage that lets a server-side
 * caller of Better Auth's `signUpEmail` tag the in-flight signup with the
 * acquisition channel it originated from, so the `user.create.after` hook
 * (which fires INSIDE `signUpEmail`, outside Atlas's normal request context)
 * can react to it.
 *
 * Why this exists: the self-serve MCP trial path (`provisionTrialWorkspace`,
 * ADR-0018, #3653) emits its own `MCP_SIGNUP` CRM lead so the channel is
 * attributable. But that path runs the *same* Better Auth signup as the web,
 * whose `user.create.after` hook already enqueues a generic `signup`/`SIGNUP`
 * lead. Two `crm_outbox` rows for one email is a problem: `atlasFirstSource`
 * is sticky first-touch and the outbox dispatches same-email rows strictly in
 * `created_at` order, so the earlier-created `SIGNUP` row would steal the
 * first-source from `MCP_SIGNUP`. The provisioner therefore wraps its
 * `signUpEmail` call in `runWithSignupOrigin("mcp", …)`, and
 * `dispatchSignupCrmLead` skips the auto-enqueue when the origin is `"mcp"` —
 * leaving `MCP_SIGNUP` as the sole row, which wins first-touch.
 *
 * This is the same "bind the ALS that Better Auth hooks fire outside of"
 * pattern used in `lib/auth/invitations.ts`. It is deliberately NOT persisted
 * anywhere (ADR-0018 rejects an acquisition/`origin` column on the trial
 * grant); it lives only for the duration of the signup call.
 */

import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Acquisition channel a server-side signup originated from. Web HTTP signups
 * never set this (they don't call the server-side `signUpEmail` seam through
 * this wrapper), so the absence of a value means "ordinary web signup".
 */
export type SignupOrigin = "mcp";

const signupOriginStore = new AsyncLocalStorage<SignupOrigin>();

/**
 * Run `fn` with the given signup origin bound for the duration of its async
 * execution. AsyncLocalStorage propagates the value across the `await` chain
 * inside `signUpEmail`, so Better Auth's `user.create.after` hook observes it
 * via {@link getSignupOrigin}. Returns whatever `fn` resolves to.
 */
export function runWithSignupOrigin<T>(
  origin: SignupOrigin,
  fn: () => T,
): T {
  return signupOriginStore.run(origin, fn);
}

/**
 * The signup origin bound by the nearest enclosing {@link runWithSignupOrigin},
 * or `undefined` when none is active (the ordinary web-signup case).
 */
export function getSignupOrigin(): SignupOrigin | undefined {
  return signupOriginStore.getStore();
}
