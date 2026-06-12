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
 * `user.role === "platform_admin"` (cross-tenant, lives only on user.role
 * post-#2890) short-circuits to allow before the member lookup, mirroring
 * `resolveEffectiveRole`.
 *
 * Fails CLOSED: a member-table lookup error denies (billing actions are
 * high-privilege; a transient DB blip must never authorize a checkout or
 * portal session against someone else's org). Both the no-membership and
 * the error paths log — a denial here is either an authz probe or a
 * client-side wiring bug, and both should be visible.
 */

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
}): Promise<boolean> {
  const { user, referenceId, action } = data;

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
      "Member lookup failed during subscription authorizeReference — denying (fail closed)",
    );
    return false;
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
