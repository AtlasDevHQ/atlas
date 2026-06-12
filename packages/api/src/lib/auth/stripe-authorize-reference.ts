/**
 * `subscription.authorizeReference` predicate for the @better-auth/stripe
 * plugin (#3416).
 *
 * Atlas subscriptions are org-scoped: every plugin call passes
 * `customerType: "organization"`, so `referenceId` is an organization id
 * and the plugin requires this predicate before any subscription action
 * touches that org. The plugin invokes it from `referenceMiddleware` and
 * maps a `false` return to 401 `UNAUTHORIZED`.
 *
 * Role policy, per action:
 *   - `upgrade-subscription` / `cancel-subscription` / `restore-subscription`
 *     / `billing-portal` — money-moving actions: caller must hold an
 *     `admin` or `owner` member row in the referenced org (the same pair
 *     every other tenant-admin gate checks — see `effective-role.ts`).
 *   - `list-subscription` — read-only: any member of the referenced org.
 *
 * Calls that are not org-scoped are denied outright: the plugin defaults
 * to `customerType: "user"` when the request omits it, and in that mode a
 * request can carry `referenceId=<orgId>` while the plugin charges/stores
 * the USER's Stripe customer — an org-shaped subscription billed to the
 * wrong customer. Atlas has no user-scoped subscriptions, so requiring
 * `customerType === "organization"` fails that mismatch closed (Codex
 * review on #3440).
 *
 * `user.role === "platform_admin"` (cross-tenant, lives only on user.role
 * post-#2890) short-circuits to allow before the member lookup, mirroring
 * `resolveEffectiveRole`.
 *
 * Fails CLOSED, in two distinct ways:
 *   - Authz-shaped denials (wrong customerType, no membership, role too
 *     low, no internal DB) return `false` → the plugin's 401.
 *   - A member-table lookup ERROR throws 503 instead: per the
 *     error-handling rule ("`catch { return false }` on a security check
 *     is a bug — return 500, not a false negative"), a transient DB blip
 *     must surface as a retryable server error, not masquerade as "not
 *     authorized" to a legitimate billing admin. It still never
 *     authorizes anything.
 * Both denial paths log — a denial here is either an authz probe or a
 * client-side wiring bug, and both should be visible.
 */

import { APIError } from "better-auth/api";
import type { AuthorizeReferenceAction } from "@better-auth/stripe";
import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("billing:authorize-reference");

/** Member roles allowed to perform money-moving subscription actions. */
const BILLING_ADMIN_ROLES = new Set(["admin", "owner"]);

export async function authorizeStripeReference(data: {
  user: { id: string; role?: string | null };
  referenceId: string;
  action: AuthorizeReferenceAction;
  /** `customerType` from the request body/query. Must be "organization". */
  customerType: unknown;
}): Promise<boolean> {
  const { user, referenceId, action, customerType } = data;

  // Atlas subscriptions are org-scoped only. A user-mode call (default when
  // customerType is omitted) carrying an org referenceId would bill the
  // user's Stripe customer against an org reference — deny before any role
  // logic, including platform_admin.
  if (customerType !== "organization") {
    log.warn(
      { userId: user.id, referenceId, action, customerType: String(customerType) },
      "Subscription %s denied — Atlas subscriptions are org-scoped; request must pass customerType \"organization\"",
      action,
    );
    return false;
  }

  // Cross-tenant operator — outranks any per-org role.
  if (user.role === "platform_admin") return true;

  // Org-scoped subscriptions need the member table; without an internal DB
  // there is no org membership to verify, so deny rather than guess.
  if (!hasInternalDB()) {
    log.error(
      { userId: user.id, referenceId, action },
      "authorizeReference called without an internal DB — denying (org-scoped billing requires managed auth)",
    );
    return false;
  }

  let role: string | undefined;
  try {
    const rows = await internalQuery<{ role: string }>(
      `SELECT role FROM member WHERE "userId" = $1 AND "organizationId" = $2 LIMIT 1`,
      [user.id, referenceId],
    );
    role = rows[0]?.role;
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err), userId: user.id, referenceId, action },
      "Member lookup failed during subscription authorizeReference — failing the request (503), not the authz check",
    );
    // NOT `return false`: that would convert a transient DB error into a
    // 401 for a legitimate billing admin. 503 is retryable and still
    // authorizes nothing.
    throw new APIError("SERVICE_UNAVAILABLE", {
      message: "Billing authorization is temporarily unavailable. Please retry.",
    });
  }

  if (!role) {
    log.warn(
      { userId: user.id, referenceId, action },
      "Subscription %s denied — caller is not a member of the referenced org",
      action,
    );
    return false;
  }

  if (action === "list-subscription") return true;

  if (BILLING_ADMIN_ROLES.has(role)) return true;

  log.warn(
    { userId: user.id, referenceId, action, role },
    "Subscription %s denied — member role %s lacks billing privileges (admin/owner required)",
    action,
    role,
  );
  return false;
}
