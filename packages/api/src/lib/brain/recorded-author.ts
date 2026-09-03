/**
 * Who a brain write is recorded as being BY — one resolver, four consumers.
 *
 * A brain surface that records a human decision has to answer the same question
 * three ways, and the answer is not "the request's user id": on a no-auth
 * deployment there is no user id and a human is still deciding, and on an
 * unresolved principal there is neither.
 *
 * This lived as a byte-identical `recordedAuthor` in three route modules
 * (`admin-brain-enrollment`, `admin-brain-slack`, `admin-brain-vocabulary`).
 * #5635 needed a fourth for the publisher stamp, and a fourth copy of a
 * security-relevant mapping is where the copies start to disagree — so the
 * function moved here and the routes import it. The behaviour is unchanged
 * from all three.
 *
 * ## The three arms, and why each is what it is
 *
 * - **`authenticated`** — a user id, but only for `owner` or `admin`. A member
 *   who somehow reached a write surface is recorded as NULL rather than as
 *   themselves: naming them would file the decision under someone who was not
 *   entitled to make it, which is worse than not naming anyone. The role check
 *   is belt-and-braces behind the route's own authorization, not a substitute
 *   for it.
 * - **`unauthenticated-local`** — {@link LOCAL_OPERATOR}. A human on a
 *   deployment with no auth configured; there is no id to record and "a human
 *   did this here" is the true and useful statement.
 * - **`unresolved`** — NULL. The principal could not be established, so the
 *   sentinel would be a claim the request cannot support. ⚠️ Returning
 *   {@link LOCAL_OPERATOR} here instead is the specific bug this shape exists
 *   to prevent: it would apply the sentinel to every origin whose `userId`
 *   happens to be null, filing one workspace's decision under another's
 *   operator.
 */

import type { BrainPrincipalContext } from "@atlas/api/lib/brain/acl";
import type { AuthResult } from "@atlas/api/lib/auth/types";

/**
 * The stand-in recorded when a human decides on a deployment that has no user
 * table to name them from. Spelled once here; `brain_vocabulary_edge.approved_by`,
 * `brain_facts.published_by` and the proposal columns all store this literal.
 */
export const LOCAL_OPERATOR = "local-operator";

/**
 * The actor to record for a human decision, or `null` when the request cannot
 * name one. See the module header for why each arm is what it is.
 */
export function recordedAuthor(ctx: BrainPrincipalContext): string | null {
  switch (ctx.origin) {
    case "authenticated":
      return (ctx.role === "owner" || ctx.role === "admin") && ctx.userId ? ctx.userId : null;
    case "unauthenticated-local":
      return LOCAL_OPERATOR;
    case "unresolved":
      return null;
  }
}

/**
 * The actor to record for a human decision made on an ADMIN route, resolved
 * from the request's `AuthResult` rather than from a brain reader context.
 *
 * Same three outcomes as {@link recordedAuthor} and the same sentinel, reached
 * from the input an admin route actually holds. `resolveBrainReaderContext`
 * costs a database round trip to establish a role the admin middleware has
 * already established, and `/api/v1/admin/publish` is not a brain-scoped route
 * — it publishes six content-mode tables and only one of them records an
 * approver.
 *
 * The union's arms map exactly:
 *
 * - authenticated with a user   → that user's id
 * - authenticated in `none` mode → {@link LOCAL_OPERATOR}; auth is not
 *   configured, so a human is publishing and there is no id to name them by
 * - not authenticated            → `null`
 *
 * The third arm is unreachable behind `requireAdminAuth` and is mapped anyway,
 * because "unreachable today" is not a property a type should rely on a caller
 * to preserve, and NULL is the honest answer if it ever is reached.
 */
export function recordedAdminAuthor(auth: AuthResult): string | null {
  if (!auth.authenticated) return null;
  return auth.user?.id ?? LOCAL_OPERATOR;
}
