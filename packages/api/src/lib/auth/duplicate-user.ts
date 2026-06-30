/**
 * Duplicate-email signup rejection recognizer (#4125 fault D).
 *
 * Better Auth handles an already-registered address two ways, by config
 * (`sign-up.mjs` `shouldReturnGenericDuplicateResponse = requireEmailVerification
 * || autoSignIn === false`): when `requireEmailVerification` is **false** (Atlas
 * staging/dev), `signUpEmail` THROWS a typed `APIError` (`UNPROCESSABLE_ENTITY`,
 * body code `USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL`) out of the call — the case
 * THIS recognizer handles. When it is **true** (SaaS prod), Better Auth instead
 * returns an enumeration-safe synthetic 200 carrying a generated, never-persisted
 * `user.id` (shaped like a real signup) — that path is handled separately by the
 * provisioner's `userExists` check, NOT here. Before this recognizer, the MCP
 * `start_trial` provisioner (`ee/onboarding/provision-trial.ts`) caught the throw,
 * found it wasn't a business-email / plus-addressing deny, and rethrew it raw — so
 * a second `start_trial` on a registered email surfaced as the generic
 * `internal_error` ("Trial provisioning failed unexpectedly. Please retry.")
 * instead of the actionable "already registered — sign in on the web" envelope. A
 * duplicate is a *permanent, actionable* condition, not a transient failure.
 *
 * This recognizer lets the provisioner map the duplicate-user throw to the
 * existing `signup_failed` code — the same envelope the synthetic-id duplicate
 * path also maps to. It mirrors the recognizer idiom in
 * {@link file://./business-email.ts} (`isBusinessEmailRejection`,
 * `isPlusAddressingRejection`): match on the Better Auth error *code*, never a
 * message string, so it survives copy/wording drift and minor version upgrades. (It
 * does NOT survive a Better Auth *code rename* — the literals below are not
 * compile-bound to `@better-auth/core`'s `APIErrorCode`, which is a transitive,
 * not direct, dependency; a rename would silently stop matching. That is an
 * accepted trade vs. pulling in a new dependency edge for this one check.)
 *
 * Two codes are recognized: `USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL` — the one
 * the email/password sign-up route throws today (`better-auth` `sign-up.mjs`) —
 * and the plainer `USER_ALREADY_EXISTS`, which Better Auth *defines* in
 * `BASE_ERROR_CODES` for the same condition; it has no throw site in the current
 * dist, so it is recognized purely defensively in case a route ever emits it.
 */

import { APIError } from "better-auth/api";

/**
 * Better Auth `BASE_ERROR_CODES` keys that signal a duplicate-email signup
 * rejection. Both denote "an account already exists for this email"; the
 * email/password sign-up route throws the first today, while the second is
 * defined-but-unthrown in the current dist and recognized defensively.
 */
export const DUPLICATE_USER_REJECTION_CODES: ReadonlySet<string> = new Set([
  "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL",
  "USER_ALREADY_EXISTS",
]);

/**
 * Recognize a duplicate-email signup rejection on a caught error. Used by the
 * MCP `start_trial` provisioner (#4125) to map the shared-signup-path failure
 * to its actionable `signup_failed` envelope rather than the generic
 * `internal_error`. Matches on the stable Better Auth error `code` carried in
 * the `APIError` body — not a message string.
 */
export function isDuplicateUserRejection(err: unknown): boolean {
  if (!(err instanceof APIError)) return false;
  const body = err.body as { code?: unknown } | undefined;
  return (
    typeof body?.code === "string" && DUPLICATE_USER_REJECTION_CODES.has(body.code)
  );
}
