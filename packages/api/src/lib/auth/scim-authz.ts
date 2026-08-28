/**
 * Authorization predicate for issuing SCIM provisioning credentials.
 *
 * Extracted from `auth/server.ts` (#5493) for the same wall-off reason
 * `oauth-audiences.ts` was: the admin route that now owns this check should
 * not pull the ~4k-line Better Auth static graph into its import path just
 * to ask "may this user mint a SCIM token?". `server.ts` re-exports both
 * symbols, so existing importers are unaffected.
 *
 * ── Why the check moved out of the plugin ──────────────────────────────
 *
 * Until @better-auth/scim 1.7 this predicate ran inside the plugin's
 * `beforeSCIMTokenGenerated` hook, because minting lived on Better Auth's
 * catch-all at `POST /api/auth/scim/generate-token` — a PUBLIC route, which
 * is what made GHSA-j8v8-g9cx-5qf4 exploitable. The hook WAS the role gate,
 * not defence in depth.
 *
 * 1.7 withdraws that route and exposes minting as a server-only endpoint, so
 * the hook is gone and the operation is unreachable over the wire. The gate
 * now sits on the Atlas admin route that wraps it
 * (`api/routes/admin-scim.ts`), in front of an endpoint that is already
 * unreachable — so it is genuinely defence in depth now, layered on
 * `createAdminRouter()`'s own admin check.
 */

import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import { createLogger } from "@atlas/api/lib/logger";
import { errorMessage } from "@atlas/api/lib/audit/error-scrub";

const log = createLogger("scim-authz");

/**
 * Raw-role predicate.
 *
 * Hardcoded literal (not imported from `@useatlas/types/auth:ADMIN_ROLES`)
 * because this logic is template-synced to create-atlas; see the same
 * pattern in `api/routes/middleware.ts`.
 */
export function canMintSCIMToken(role: unknown): boolean {
  return role === "admin" || role === "owner" || role === "platform_admin";
}

/**
 * Effective authorization for SCIM credential issuance (#2890).
 *
 * A raw `user.role` check alone is not enough: post-#2890 `user.role` only
 * ever carries `platform_admin`, and tenant admin-ness lives in
 * `member.role`. Checking only the raw role would deny every org
 * owner/admin — exactly the people who set SCIM up. So resolve the
 * EFFECTIVE grant: `platform_admin` via `user.role`, OR an `admin`/`owner`
 * member row in any of the user's orgs.
 *
 * Fails CLOSED on a member-table lookup error — issuing an IdP provisioning
 * credential is high-privilege, so a transient DB blip denies rather than
 * grants. Without an internal DB (single-tenant self-hosted, no member
 * table) it falls back to the raw-role predicate.
 */
export async function canGenerateSCIMToken(role: unknown, userId: string | undefined): Promise<boolean> {
  if (role === "platform_admin") return true;
  if (!userId || !hasInternalDB()) return canMintSCIMToken(role);
  try {
    const rows = await internalQuery<{ ok: number }>(
      `SELECT 1 AS ok FROM member WHERE "userId" = $1 AND role IN ('admin', 'owner') LIMIT 1`,
      [userId],
    );
    return rows.length > 0;
  } catch (err) {
    log.warn(
      { err: errorMessage(err), userId },
      "SCIM token authorization member lookup failed — denying (fail closed)",
    );
    return false;
  }
}
