/**
 * MFA-required gate for admin and platform_admin sessions.
 *
 * Backs the `/privacy` §9 + `/dpa` Annex II "MFA-required admin access"
 * commitment (#1925). Once a user with role `admin` or `platform_admin`
 * has authenticated, this middleware refuses to serve any route until
 * they have enrolled a TOTP second factor — except the enrollment surface
 * itself and sign-out, so the user can complete enrollment or back out.
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
 * Member-role users are NEVER gated here. The enrollment surface is
 * available to them voluntarily; the policy in this milestone is admin-only.
 */

import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { createLogger } from "@atlas/api/lib/logger";
import type { AuthEnv } from "@atlas/api/api/routes/middleware";

const log = createLogger("middleware:mfa");

/** User-level roles that must have a verified second factor on file. */
const ENFORCED_ROLES = new Set(["admin", "platform_admin"]);

/**
 * URL prefixes that bypass the gate so the user can finish enrollment
 * (or sign out and choose a different account). The enrollment surface
 * is the admin TOTP routes plus the page that hosts them; sign-out is
 * Better Auth's own endpoint.
 *
 * Anything else returns 403 until `user.twoFactorEnabled` is true.
 */
const ENROLLMENT_BYPASS_PREFIXES = [
  // Better Auth's own two-factor endpoints (enable/verify/disable/regenerate).
  "/api/auth/two-factor/",
  // Sign-out — let the user back out of an account they cannot finish
  // enrolling on (e.g. lost authenticator).
  "/api/auth/sign-out",
] as const;

/**
 * Where the web app should send the user to complete enrollment. Surfaced
 * in the 403 body so clients don't have to hard-code the path.
 */
export const ENROLLMENT_URL = "/admin/settings/security";

/**
 * Whether the request URL falls under a bypass prefix. We match on
 * pathname only; query strings are irrelevant for the gate.
 */
function isEnrollmentRequest(url: string): boolean {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    // Malformed URL — fail closed.
    return false;
  }
  return ENROLLMENT_BYPASS_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

/**
 * Read `twoFactorEnabled` off the auth result. Better Auth's two-factor
 * plugin adds the field to the `user` table; managed.ts spreads the
 * session user object into `claims`, so the field lands here without
 * any extra wiring.
 *
 * Treat `undefined` as not-enabled — the safer default.
 */
function isTwoFactorEnabled(c: Context<AuthEnv>): boolean {
  const authResult = c.get("authResult");
  const claims = authResult.user?.claims;
  if (!claims) return false;
  const value = claims.twoFactorEnabled;
  return value === true;
}

/**
 * Middleware — gates admin/platform_admin sessions on enrolled MFA.
 *
 * Place AFTER {@link adminAuth} / {@link platformAdminAuth} on a router
 * that should require MFA. Member-role users will never be gated even
 * if you accidentally apply this to a non-admin router (defensive role
 * check), but the intended use is admin-only routers.
 */
export const mfaRequired = createMiddleware<AuthEnv>(async (c, next) => {
  const authResult = c.get("authResult");
  const requestId = c.get("requestId");

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
  // The deploy-mode guard in platformAdminAuth already prevents `mode:"none"`
  // from being a SaaS escape hatch.
  if (authResult.mode !== "managed") {
    await next();
    return;
  }

  const role = authResult.user?.role;
  if (!role || !ENFORCED_ROLES.has(role)) {
    // Non-admin user reached an MFA-gated router — let the normal admin
    // gate produce the 403; this middleware doesn't second-guess role.
    await next();
    return;
  }

  if (isEnrollmentRequest(c.req.url)) {
    await next();
    return;
  }

  if (isTwoFactorEnabled(c)) {
    await next();
    return;
  }

  log.warn(
    { requestId, userId: authResult.user?.id, role },
    "Admin request blocked — MFA enrollment required",
  );
  return c.json(
    {
      error: "mfa_enrollment_required",
      message:
        "Two-factor authentication is required for admin accounts. Enroll a TOTP authenticator to continue.",
      enrollmentUrl: ENROLLMENT_URL,
      requestId,
    },
    403,
  );
});
