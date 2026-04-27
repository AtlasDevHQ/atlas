/**
 * MFA-required gate for managed-mode admin sessions.
 *
 * Delivers the admin-MFA promise from `/privacy` §9 + `/dpa` Annex II
 * (#1925). When a user with role `admin`, `owner`, or `platform_admin`
 * authenticates against an admin router, this middleware refuses to
 * serve any route until they have enrolled a TOTP second factor.
 *
 * Apply downstream of {@link adminAuth} or {@link platformAdminAuth}: this
 * middleware reads `c.get("authResult")` and never re-authenticates.
 *
 * The 403 response shape is stable so the web app can detect the gate
 * and route the user into enrollment without parsing strings:
 *
 *   { error: "mfa_enrollment_required",
 *     message: "...",
 *     enrollmentUrl: "/admin/settings/security",
 *     requestId }
 *
 * ### What is NOT gated by this middleware
 *
 * The middleware is mounted on `/api/v1/admin/*` and `/api/v1/platform/*`
 * via `createAdminRouter()` / `createPlatformRouter()`. Better Auth's
 * own routes — `/api/auth/two-factor/*` (enrollment) and `/api/auth/sign-out`
 * — are mounted on a separate sub-app at `/api/auth` (`api/index.ts`)
 * and therefore never traverse this middleware. Admins without an
 * enrolled second factor reach those endpoints regardless of role: the
 * gate sits in front of admin-data routes, not in front of Better Auth.
 *
 * The Next.js page at `/admin/settings/security` is rendered by the
 * frontend, not the API admin router, so it is also not gated here.
 *
 * Member-role users are NEVER gated. The enrollment surface is available
 * to them voluntarily; the policy in this milestone is admin-only.
 */

import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { createLogger } from "@atlas/api/lib/logger";
import type { AuthEnv } from "@atlas/api/api/routes/middleware";

const log = createLogger("middleware:mfa");

/**
 * User-level roles that must have a verified second factor on file.
 *
 * Mirrors `ADMIN_ROLE_SET` in `middleware.ts`: every role that
 * `adminAuth` admits to admin routes must also be gated, otherwise the
 * `/privacy` §9 + `/dpa` Annex II promise is false for that role. Org
 * owners receive `effectiveRole = "owner"` from `managed.ts:resolveEffectiveRole`
 * (org-level role outranks user-level), so missing `owner` here would
 * silently exempt every workspace owner — exactly the gap reviewers
 * called out before merge.
 */
const ENFORCED_ROLES = new Set(["admin", "owner", "platform_admin"]);

/**
 * Where the web app should send the user to complete enrollment.
 * Surfaced in the 403 body so clients don't have to hard-code the path.
 */
export const ENROLLMENT_URL = "/admin/settings/security";

/** Wire-format error code in the 403 body. Public API — exported for tests. */
export const MFA_ENROLLMENT_REQUIRED = "mfa_enrollment_required";

/**
 * Read `twoFactorEnabled` off the auth result. Better Auth's two-factor
 * plugin adds the field to the `user` table; `managed.ts` spreads the
 * session user object into `claims` (see `claims = { ...sessionUser, sub }`),
 * so the field lands here without any extra wiring.
 *
 * Treat anything other than the strict boolean `true` as not-enabled —
 * the safer default. A `1` / `"true"` / wrapped object from a future
 * Better Auth shape change must continue to fail closed.
 */
function isTwoFactorEnabled(c: Context<AuthEnv>): boolean {
  const authResult = c.get("authResult");
  const claims = authResult?.user?.claims;
  if (!claims) return false;
  return claims.twoFactorEnabled === true;
}

/**
 * Middleware — gates admin/owner/platform_admin sessions on enrolled MFA.
 *
 * Place AFTER {@link adminAuth} / {@link platformAdminAuth} on a router
 * that should require MFA. Member-role users will never be gated even
 * if you accidentally apply this to a non-admin router (defensive role
 * check), but the intended use is admin-only routers.
 */
export const mfaRequired = createMiddleware<AuthEnv>(async (c, next) => {
  const authResult = c.get("authResult");
  const requestId = c.get("requestId");

  // Defensive: this middleware MUST run after `adminAuth` / `platformAdminAuth`.
  // If somebody reorders middleware or mounts `mfaRequired` on a router that
  // never set `authResult`, fail closed loudly rather than throwing a bare
  // TypeError that would surface as an opaque 500 with no requestId trail.
  if (!authResult) {
    log.error(
      { requestId, path: c.req.path },
      "mfaRequired ran without authResult — middleware ordering is broken; mfaRequired must follow adminAuth/platformAdminAuth",
    );
    return c.json(
      {
        error: "auth_misconfigured",
        message: "Authorization layer misconfigured.",
        requestId,
      },
      500,
    );
  }

  // MFA only applies to interactive Better Auth sessions ("managed" mode).
  //   - "none"          local-dev no-auth carve-out — no user to gate
  //   - "simple-key"    programmatic API key — no interactive login that
  //                     could collect a TOTP, MFA is not the right primitive
  //   - "byot"          bring-your-own JWT — MFA was enforced upstream by
  //                     the identity provider that issued the token; we
  //                     trust the issuer
  //   - "managed"       Better Auth session via /api/auth/* — MFA enforced
  //                     here, which is the only flow where it can be
  //
  // The deploy-mode guard in `platformAdminAuth` already prevents
  // `mode:"none"` from being a SaaS escape hatch.
  if (authResult.mode !== "managed") {
    await next();
    return;
  }

  const role = authResult.user?.role;
  if (!role || !ENFORCED_ROLES.has(role)) {
    // Non-enforced role reached an MFA-gated router. Let the normal admin
    // gate decide whether to 403 — this middleware doesn't second-guess role.
    await next();
    return;
  }

  if (isTwoFactorEnabled(c)) {
    await next();
    return;
  }

  // Expected enforcement event, not a warning condition. `info` keeps the
  // signal-to-noise reasonable on SaaS deploys where unenrolled admin
  // sessions can replay this gate hundreds of times before enrollment.
  // SREs should track `mfa_gate.blocked` as a metric, not as a log volume.
  log.info(
    { requestId, userId: authResult.user?.id, role, path: c.req.path },
    "mfa_gate.blocked",
  );
  return c.json(
    {
      error: MFA_ENROLLMENT_REQUIRED,
      message:
        "Two-factor authentication is required for admin accounts. Enroll a TOTP authenticator to continue.",
      enrollmentUrl: ENROLLMENT_URL,
      requestId,
    },
    403,
  );
});
