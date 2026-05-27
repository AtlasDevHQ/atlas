/**
 * Invitation helpers shared between Better Auth's `organizationHooks` and
 * the platform-admin cross-org invite route at
 * `POST /api/v1/platform/invitations`.
 *
 * The native `createInvitation` endpoint gates the caller on target-org
 * membership — a `platform_admin` who isn't a member can't satisfy it.
 * The platform route re-implements the create flow with the gate
 * bypassed, so the seat-limit, audit, and email logic lives here for
 * both call sites to share. Hooks stay in `server.ts` as thin wrappers
 * — extracting them here keeps the create-flow invariants colocated and
 * unit-testable.
 */

import { APIError } from "better-auth/api";
import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import { checkResourceLimit } from "@atlas/api/lib/billing/enforcement";
import { renderInvitationEmail } from "@atlas/api/lib/email/templates";
import { createLogger, withRequestContext } from "@atlas/api/lib/logger";
import { logAdminAction, ADMIN_ACTIONS } from "@atlas/api/lib/audit";
import { errorMessage } from "@atlas/api/lib/audit/error-scrub";
import { createAtlasUser } from "@atlas/api/lib/auth/types";
import { getWebOrigin } from "@atlas/api/lib/web-origin";

const log = createLogger("auth:invitations");

/**
 * Best-effort branding lookup so the invite email matches the workspace's
 * white-label. Throws on DB error — callers catch and fall back. Returns
 * null when no row exists or the internal DB is not configured (e.g. a
 * self-hosted deploy without DATABASE_URL).
 */
async function loadInviteBranding(orgId: string): Promise<{
  logoUrl: string | null;
  logoText: string | null;
  primaryColor: string | null;
  faviconUrl: string | null;
  hideAtlasBranding: boolean;
} | null> {
  if (!hasInternalDB()) return null;
  const rows = await internalQuery<{
    logo_url: string | null;
    logo_text: string | null;
    primary_color: string | null;
    favicon_url: string | null;
    hide_atlas_branding: boolean;
  }>(
    `SELECT logo_url, logo_text, primary_color, favicon_url, hide_atlas_branding
     FROM workspace_branding WHERE org_id = $1 LIMIT 1`,
    [orgId],
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    logoUrl: r.logo_url,
    logoText: r.logo_text,
    primaryColor: r.primary_color,
    faviconUrl: r.favicon_url,
    hideAtlasBranding: r.hide_atlas_branding,
  };
}

/**
 * True for Postgres pool/connection transport errors that warrant a
 * fail-open on read-only checks (so a transient pool restart doesn't
 * block legitimate writes). Programmer errors (bad SQL, schema drift)
 * fall through and escalate.
 */
export function isTransportError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as Error & { code?: string }).code;
  if (code && /^(ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EPIPE|EHOSTUNREACH|57P01|57P02|57P03|08\d{3})$/i.test(code)) {
    return true;
  }
  return /connection terminated|pool ended|client has already been released|connection.*closed|connect ETIMEDOUT/i.test(err.message);
}

/**
 * Roles a platform-admin invite may grant. Mirrors the `roles: { owner,
 * admin, member }` map configured on the Better Auth `organization()`
 * plugin in `server.ts`. Native `auth.api.createInvitation` validates
 * against the same set; the cross-org route can't go through Better Auth
 * (caller isn't a target-org member), so it has to enforce the allow-list
 * itself before INSERT — otherwise a typo like `"owenr"` would land in
 * `member.role` on accept.
 */
export const ALLOWED_INVITATION_ROLES = ["member", "admin", "owner"] as const;
export type InvitationRole = (typeof ALLOWED_INVITATION_ROLES)[number];

/**
 * Defense-in-depth role gate for invitations. Normalizes single-string AND
 * array role inputs and rejects any `platform_admin` value.
 *
 * Throws `APIError("BAD_REQUEST")` on rejection.
 */
export function assertInvitationRoleAllowed(role: unknown): void {
  const rawRoles = Array.isArray(role) ? role : [role];
  const roles = rawRoles.map((r) => String(r ?? "").trim().toLowerCase());
  if (roles.includes("platform_admin")) {
    throw new APIError("BAD_REQUEST", {
      message:
        "Invitations cannot grant platform_admin. Use the platform-admin grant flow.",
    });
  }
}

/**
 * Allow-list role gate for the cross-org platform route. Stricter than
 * `assertInvitationRoleAllowed` (which only denies `platform_admin`):
 * here we additionally require the role to be in
 * `ALLOWED_INVITATION_ROLES`. The native Better Auth path uses its own
 * configured-roles map for this — the cross-org route bypasses Better
 * Auth's `createInvitation` and so must replicate the check explicitly.
 *
 * Throws `APIError("BAD_REQUEST")` on rejection.
 */
export function assertPlatformInvitationRole(role: unknown): void {
  assertInvitationRoleAllowed(role);
  const rawRoles = Array.isArray(role) ? role : [role];
  const roles = rawRoles.map((r) => String(r ?? "").trim().toLowerCase());
  const allowed = new Set<string>(ALLOWED_INVITATION_ROLES);
  for (const r of roles) {
    if (!allowed.has(r)) {
      throw new APIError("BAD_REQUEST", {
        message: `Invalid role "${r}". Must be one of: ${ALLOWED_INVITATION_ROLES.join(", ")}.`,
      });
    }
  }
}

/**
 * Seat-limit gate. Counts current members + pending invitations against
 * the target org's plan cap and throws `APIError("TOO_MANY_REQUESTS")` on
 * over-limit. TOCTOU is acceptable here — invitation creation is
 * low-frequency and the next call catches any overshoot.
 *
 * Fails open on Postgres transport errors so a pool restart doesn't block
 * legitimate invites; escalates on programmer/SQL errors so they surface
 * in dashboards instead of silently leaking seats.
 */
export async function enforceInvitationSeatLimit(orgId: string): Promise<void> {
  try {
    const rows = await internalQuery<{ count: number }>(
      `SELECT (
        (SELECT COUNT(*)::int FROM member WHERE "organizationId" = $1) +
        (SELECT COUNT(*)::int FROM invitation WHERE "organizationId" = $1 AND status = 'pending' AND "expiresAt" > now())
      ) as count`,
      [orgId],
    );
    const seatCount = rows[0]?.count ?? 0;
    const resourceCheck = await checkResourceLimit(orgId, "seats", seatCount);
    if (!resourceCheck.allowed) {
      throw new APIError("TOO_MANY_REQUESTS", {
        message: resourceCheck.errorMessage ?? "Workspace seat limit reached.",
      });
    }
  } catch (err) {
    if (err instanceof APIError) throw err;
    if (isTransportError(err)) {
      log.error(
        { orgId, err: errorMessage(err) },
        "Seat-limit check failed on transport error — allowing invitation",
      );
      return;
    }
    log.error(
      { orgId, err: errorMessage(err) },
      "Seat-limit check threw unexpectedly",
    );
    throw new APIError("INTERNAL_SERVER_ERROR", {
      message: "Could not verify seat limit. Please retry.",
    });
  }
}

/**
 * Render + send the invitation email. Throws `APIError("INTERNAL_SERVER_ERROR")`
 * on dispatch failure so the caller surfaces a real error to the operator
 * instead of a silent half-success — the recipient never gets the email
 * and the admin assumes the system is being slow.
 *
 * Mirrors the contract of Better Auth's `sendInvitationEmail` callback so
 * both the hook wiring and the platform route call into the same path.
 */
export async function dispatchInvitationEmail(args: {
  invitationId: string;
  role: string | string[];
  email: string;
  organization: { id: string; name: string };
  inviter: { user: { name?: string | null; email: string } };
}): Promise<void> {
  // The accept-invitation page lives in the web app, NOT the API. In SaaS,
  // api.useatlas.dev and app.useatlas.dev are different hosts — using the
  // API URL here puts the recipient on a 404 page. `getWebOrigin()` resolves
  // the web-app origin from CORS/trusted-origin config; fall back to the
  // API URL chain only for self-hosted single-origin deploys where both
  // surfaces share a host.
  const baseUrl =
    getWebOrigin()
    ?? process.env.NEXT_PUBLIC_ATLAS_API_URL
    ?? process.env.BETTER_AUTH_URL
    ?? "http://localhost:3000";
  const acceptUrl = `${baseUrl}/accept-invitation/${args.invitationId}`;

  // Best-effort branding lookup. `log.warn` (not debug) because silent
  // unbranded delivery defeats the white-label feature an enterprise
  // customer is paying for.
  let branding: Awaited<ReturnType<typeof loadInviteBranding>> = null;
  try {
    branding = await loadInviteBranding(args.organization.id);
  } catch (err) {
    log.warn(
      { err: errorMessage(err), orgId: args.organization.id },
      "Invite branding lookup failed — falling back to Atlas defaults",
    );
  }

  const role = Array.isArray(args.role)
    ? args.role.join(", ")
    : String(args.role ?? "member");

  const { subject, html } = renderInvitationEmail({
    orgName: args.organization.name,
    inviterName: args.inviter.user.name || args.inviter.user.email,
    role,
    acceptUrl,
    branding,
  });

  let result: Awaited<ReturnType<typeof import("@atlas/api/lib/email/delivery").sendEmail>>;
  try {
    const { sendEmail } = await import("@atlas/api/lib/email/delivery");
    result = await sendEmail(
      { to: args.email, subject, html },
      args.organization.id,
    );
  } catch (err) {
    log.error(
      {
        email: args.email,
        orgName: args.organization.name,
        invitationId: args.invitationId,
        err: errorMessage(err),
      },
      "Invitation email dispatch threw",
    );
    throw new APIError("INTERNAL_SERVER_ERROR", {
      message: "Could not send invitation email — check email-provider config and retry.",
    });
  }
  if (!result.success) {
    log.error(
      {
        email: args.email,
        orgName: args.organization.name,
        invitationId: args.invitationId,
        provider: result.provider,
        err: result.error,
      },
      "Invitation email failed to send",
    );
    throw new APIError("INTERNAL_SERVER_ERROR", {
      message: result.error
        ? `Could not send invitation email: ${result.error}`
        : "Could not send invitation email — check email-provider config and retry.",
    });
  }
}

/**
 * Audit a successful invitation creation and trigger the inviter's
 * onboarding "invite team" nudge. Synthesizes a transient
 * `withRequestContext` because Better Auth's hooks fire outside Atlas's
 * AsyncLocalStorage — `logAdminAction` would otherwise resolve the actor
 * to "unknown". The platform route reuses this for parity (its handler
 * already runs inside `runEffect`, but routing through the same helper
 * keeps the audit row shape identical across both call sites).
 *
 * Email may be empty for passkey-only accounts and certain social-
 * provider edge cases (Apple private relay, GitHub `noreply.github.com`
 * redaction) — fall back to a user-id label so `createAtlasUser`'s
 * non-empty-label check doesn't throw after the invitation row is
 * already persisted.
 */
export async function recordInvitationCreated(args: {
  invitationId: string;
  invitedEmail: string;
  role: string;
  inviter: { id: string; email: string | null | undefined };
  orgId: string;
}): Promise<void> {
  const inviterUser = createAtlasUser(
    args.inviter.id,
    "managed",
    args.inviter.email || `user:${args.inviter.id}`,
    { activeOrganizationId: args.orgId },
  );
  withRequestContext(
    { requestId: `invite:${args.invitationId}`, user: inviterUser },
    () => {
      logAdminAction({
        actionType: ADMIN_ACTIONS.user.invite,
        targetType: "user",
        targetId: args.invitationId,
        metadata: {
          email: args.invitedEmail,
          role: args.role,
          orgId: args.orgId,
        },
      });
    },
  );

  // Fire the "invite team" onboarding nudge. Wrapped in try/catch so a
  // hook failure can't fail the invite path.
  try {
    const { onTeamMemberInvited } = await import("@atlas/api/lib/email/hooks");
    onTeamMemberInvited({
      userId: args.inviter.id,
      email: args.inviter.email ?? "",
      orgId: args.orgId,
    });
  } catch (err) {
    log.warn(
      { err: errorMessage(err), inviterId: args.inviter.id, orgId: args.orgId },
      "Onboarding milestone trigger failed — invite still created, nudge may persist",
    );
  }
}

/**
 * Audit a successful invitation cancellation ("revoke" in the UI;
 * "cancel" in the Better Auth API + audit constant). Same actor
 * synthesis pattern as `recordInvitationCreated` — `withRequestContext`
 * binds the AsyncLocalStorage that Better Auth's hooks fire outside of,
 * and `activeOrganizationId: orgId` attributes the audit row to the
 * TARGET workspace (matters for cross-org platform-admin cancels where
 * the caller's active org diverges from the cancelled row's org).
 *
 * `previousStatus` is a parameter rather than a constant because the
 * cross-org platform route can DELETE any-status row (Better Auth's
 * native cancelInvitation gates on `status = 'pending'`; the platform
 * bypass route doesn't). The hook call site can pass `"pending"`
 * directly — Better Auth's native gate guarantees it.
 *
 * Email may be empty for passkey-only accounts — fall back to a user-id
 * label so `createAtlasUser`'s non-empty-label check doesn't throw
 * after the DELETE has already happened. (Only reachable from the hook
 * path; the route call site passes the already-validated `user.label`.)
 */
export async function recordInvitationCancelled(args: {
  invitationId: string;
  invitedEmail: string;
  role: string;
  previousStatus: string;
  orgId: string;
  cancelledBy: { id: string; email: string | null | undefined };
}): Promise<void> {
  const actor = createAtlasUser(
    args.cancelledBy.id,
    "managed",
    args.cancelledBy.email || `user:${args.cancelledBy.id}`,
    { activeOrganizationId: args.orgId },
  );
  withRequestContext(
    { requestId: `cancel-invite:${args.invitationId}`, user: actor },
    () => {
      logAdminAction({
        actionType: ADMIN_ACTIONS.user.revokeInvitation,
        targetType: "user",
        targetId: args.invitationId,
        metadata: {
          invitedEmail: args.invitedEmail,
          role: args.role,
          previousStatus: args.previousStatus,
          orgId: args.orgId,
        },
      });
    },
  );
}
