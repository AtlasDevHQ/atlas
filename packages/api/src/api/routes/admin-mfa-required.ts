/**
 * MFA-required gate for managed-mode admin sessions.
 *
 * Delivers the admin-MFA promise from `/privacy` §9 + `/dpa` Annex II
 * (#1925). When a user with role `admin`, `owner`, or `platform_admin`
 * authenticates against an admin router, this middleware refuses to
 * serve any route until they have enrolled at least one strong second
 * factor — either TOTP via Better Auth's `twoFactor` plugin, or a WebAuthn
 * passkey via `@better-auth/passkey`.
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
 * The middleware is mounted on routers built via `createAdminRouter()` /
 * `createPlatformRouter()` (see `admin-router.ts`). It is therefore in
 * front of every admin sub-router that uses those factories: connections,
 * audit, sandbox, integrations, plugins, etc.
 *
 * **Three deliberate carve-outs:**
 *
 * 1. **Better Auth (`/api/auth/*`).** Mounted on a separate sub-app at
 *    `/api/auth` in `api/index.ts`, so the two-factor enrollment endpoints
 *    (`/api/auth/two-factor/enable`, `/api/auth/two-factor/verify-totp`,
 *    `/api/auth/two-factor/generate-backup-codes`) and `/api/auth/sign-out`
 *    never traverse this middleware. Admins without an enrolled second
 *    factor reach those endpoints regardless of role.
 *
 * 2. **The parent admin router itself (`admin.ts`).** That router is built
 *    as a raw `OpenAPIHono` instance with its own per-handler auth via
 *    `adminAuthAndContext()`, NOT through `createAdminRouter()`. So the
 *    self-service routes registered directly on it — `/me/password-status`,
 *    `/me/password`, `/settings`, semantic editor routes — are NOT gated
 *    by `mfaRequired`. The web's `usePasswordStatus` hook depends on this
 *    carve-out: AdminLayout must be able to check password status before
 *    the user has enrolled a second factor.
 *
 * 3. **The Next.js security page (`/admin/settings/security`).** Rendered
 *    by the frontend, not by the API admin router, so it is reachable
 *    independent of this middleware.
 *
 * Member-role users are NEVER gated. The enrollment surface is available
 * to them voluntarily; the policy is admin-only.
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
 * Decide whether the session has any acceptable second factor enrolled.
 *
 * Two sources, both injected into `claims` by `managed.ts`:
 *   - `twoFactorEnabled: boolean` — TOTP (Better Auth `twoFactor` plugin).
 *     Rides on the `user` table, lands in claims via `...sessionUser` spread.
 *   - `passkeyCount: number` — count of WebAuthn credentials, looked up
 *     from the `passkey` table by `resolvePasskeyCount` (managed.ts).
 *
 * Defensive narrowing on both fields: only the strict boolean `true` opens
 * the TOTP path, only a positive `number` opens the passkey path. A future
 * Better Auth shape change that returns `"true"` / `"1"` / wrapped objects
 * must continue to fail closed — admitting an unenrolled admin is a worse
 * outcome than gating one extra retry.
 */
function isMfaEnrolled(c: Context<AuthEnv>): boolean {
  const claims = c.get("authResult")?.user?.claims;
  if (!claims) return false;
  if (claims.twoFactorEnabled === true) return true;
  const count = claims.passkeyCount;
  return typeof count === "number" && count > 0;
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

  if (isMfaEnrolled(c)) {
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
        "Two-factor authentication is required for admin accounts. Enroll an authenticator app or passkey to continue.",
      enrollmentUrl: ENROLLMENT_URL,
      requestId,
    },
    403,
  );
});
