/**
 * Platform-admin cross-org invitation routes.
 *
 * Mounted at /api/v1/platform/invitations. Lets a `platform_admin` invite
 * a user into any organization they don't belong to — Better Auth's native
 * `createInvitation` enforces an org-membership gate on the caller that a
 * platform admin can't satisfy.
 *
 * The route re-implements the create flow with the membership check
 * bypassed. The platform_admin gate IS the bypass: `createPlatformRouter`
 * enforces `role === "platform_admin"` before any handler runs. Seat-limit,
 * audit, and email all route through the shared helpers in
 * `lib/auth/invitations.ts` so the row shape and side effects match what
 * Better Auth's hook path produces.
 */

import { createRoute, z } from "@hono/zod-openapi";
import { Effect } from "effect";
import crypto from "node:crypto";
import { createPlatformRouter } from "./admin-router";
import { runEffect } from "@atlas/api/lib/effect/hono";
import { AuthContext, RequestContext } from "@atlas/api/lib/effect/services";
import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import {
  ALLOWED_INVITATION_ROLES,
  assertPlatformInvitationRole,
  dispatchInvitationEmail,
  enforceInvitationSeatLimit,
  recordInvitationCreated,
} from "@atlas/api/lib/auth/invitations";
import { errorMessage } from "@atlas/api/lib/audit/error-scrub";
import { createLogger } from "@atlas/api/lib/logger";
import { ErrorSchema, AuthErrorSchema } from "./shared-schemas";
import { APIError } from "better-auth/api";

const log = createLogger("platform-invitations");

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const InviteBodySchema = z.object({
  organizationId: z.string().min(1).openapi({ description: "Target organization ID. The caller does NOT need to be a member." }),
  email: z.string().email().openapi({ description: "Recipient email address." }),
  role: z.string().min(1).openapi({
    description: `Role to grant on acceptance. Must be one of: ${ALLOWED_INVITATION_ROLES.join(", ")}.`,
  }),
});

const InvitationSchema = z.object({
  id: z.string(),
  email: z.string(),
  role: z.string(),
  organizationId: z.string(),
  inviterId: z.string(),
  status: z.string(),
  expiresAt: z.string(),
  createdAt: z.string(),
});

// ---------------------------------------------------------------------------
// Route definition
// ---------------------------------------------------------------------------

const createInvitationRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Platform Admin"],
  summary: "Create a cross-org invitation",
  description:
    "Lets a platform_admin invite a user into any organization, regardless of membership. Calls the same seat-limit, audit, and email helpers as the native Better Auth flow.",
  request: {
    body: {
      content: { "application/json": { schema: InviteBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Invitation created",
      content: { "application/json": { schema: InvitationSchema } },
    },
    400: { description: "Bad request", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Platform admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Internal database not configured", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "User already a member or already invited", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Seat limit reached", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * 32-char alphanumeric ID matching Better Auth's `generateId` shape.
 * Reimplemented here because that subpath isn't exported from the
 * published package. Same character set (a-z, A-Z, 0-9) and length so
 * platform-created rows are indistinguishable from native-flow rows in
 * monitoring / log greps.
 *
 * Uses `crypto.randomInt` (rejection-sampled, uniform) rather than
 * `randomBytes % 62`: 62 doesn't divide 256, so a modulo form biases
 * the first few characters of the alphabet.
 */
function generateInvitationId(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let out = "";
  for (let i = 0; i < 32; i++) {
    out += alphabet[crypto.randomInt(0, alphabet.length)];
  }
  return out;
}

/**
 * Cap on pending invitations per organization. Mirrors the default
 * `invitationLimit` Better Auth's `organization()` plugin enforces
 * inside its native `createInvitation`. The cross-org route bypasses
 * that path, so the cap is enforced here explicitly — otherwise a
 * platform admin could push any target org past the cap. Overridable
 * via `ATLAS_INVITATION_LIMIT_PER_ORG` for self-hosted operators
 * doing large bulk-onboarding.
 */
const PENDING_INVITATION_LIMIT_PER_ORG = (() => {
  const raw = process.env.ATLAS_INVITATION_LIMIT_PER_ORG;
  if (!raw) return 100;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 100;
})();

type OrgRow = { id: string; name: string; workspace_status: string | null; [key: string]: unknown };
type MemberRow = { id: string; userId: string; role: string; [key: string]: unknown };
type InvitationRow = {
  id: string;
  email: string;
  role: string;
  organizationId: string;
  inviterId: string;
  status: string;
  expiresAt: string;
  createdAt: string;
  [key: string]: unknown;
};

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const platformInvitations = createPlatformRouter();

platformInvitations.openapi(createInvitationRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;
    const { user } = yield* AuthContext;

    if (!hasInternalDB()) {
      return c.json(
        { error: "not_available", message: "No internal database configured.", requestId },
        404,
      );
    }

    if (!user) {
      // Type-narrowing guard. `createPlatformRouter`'s auth middleware
      // populates `user`; this branch can't realistically run.
      return c.json(
        { error: "unauthenticated", message: "Authentication required.", requestId },
        401,
      );
    }

    const { organizationId, email: rawEmail, role } = c.req.valid("json");
    const email = rawEmail.toLowerCase();

    // Role gate — denies `platform_admin` AND any role outside the
    // configured org-plugin allow-list (`owner|admin|member`). Native
    // `auth.api.createInvitation` validates against its own roles map;
    // we bypass that path, so the allow-list check is enforced here
    // before INSERT so a typo like `"owenr"` can't land in `member.role`
    // on accept. 400 before any DB I/O.
    try {
      assertPlatformInvitationRole(role);
    } catch (err) {
      if (err instanceof APIError) {
        return c.json(
          { error: "bad_request", message: err.body?.message ?? "Invalid role.", requestId },
          400,
        );
      }
      throw err;
    }

    // Verify the target org exists and is active. A 404 here beats the
    // bewildering foreign-key-violation noise an unguarded INSERT would
    // emit if the FE shipped a stale `organizationId`. Suspended /
    // deleted workspaces 409 — the accept flow is undefined for those
    // states and the recipient would see a confusing error after click.
    const orgs = yield* Effect.promise(() =>
      internalQuery<OrgRow>(
        `SELECT id, name, workspace_status FROM organization WHERE id = $1`,
        [organizationId],
      ),
    );
    if (orgs.length === 0) {
      return c.json(
        { error: "not_found", message: "Organization not found.", requestId },
        404,
      );
    }
    const org = orgs[0];
    const orgStatus = org.workspace_status ?? "active";
    if (orgStatus !== "active") {
      return c.json(
        {
          error: "workspace_inactive",
          message: `Target workspace is ${orgStatus}. Restore it before issuing invitations.`,
          requestId,
        },
        409,
      );
    }

    // Existing-member dedup — Better Auth's native path runs the same
    // check, so a pre-existing member of the target org doesn't get a
    // phantom pending-invite row.
    const existingMembers = yield* Effect.promise(() =>
      internalQuery<{ id: string }>(
        `SELECT m.id FROM member m
         JOIN "user" u ON m."userId" = u.id
         WHERE m."organizationId" = $1 AND lower(u.email) = $2
         LIMIT 1`,
        [organizationId, email],
      ),
    );
    if (existingMembers.length > 0) {
      return c.json(
        {
          error: "already_member",
          message: "This user is already a member of the target organization.",
          requestId,
        },
        409,
      );
    }

    // Pending-invitation dedup. Match Better Auth's behavior — if a
    // pending row already exists for this email + org, refuse rather than
    // creating a duplicate. Resend is a separate flow (the native
    // endpoint takes `resend: true`); platform admins can cancel the
    // existing row via the org admin UI and re-issue.
    const pending = yield* Effect.promise(() =>
      internalQuery<InvitationRow>(
        `SELECT id, email, role, "organizationId", "inviterId", status, "expiresAt", "createdAt"
         FROM invitation
         WHERE "organizationId" = $1
           AND lower(email) = $2
           AND status = 'pending'
           AND "expiresAt" > now()
         LIMIT 1`,
        [organizationId, email],
      ),
    );
    if (pending.length > 0) {
      return c.json(
        {
          error: "already_invited",
          message: "A pending invitation for this email already exists in the target organization.",
          requestId,
        },
        409,
      );
    }

    // Pending-invitation cap. Better Auth's org plugin defaults
    // `invitationLimit` to 100 pending invites per org; the native
    // `createInvitation` enforces it. The cross-org route bypasses that
    // path so we enforce the same cap here — otherwise a platform admin
    // can run target orgs unboundedly past the cap. Counts only
    // unexpired pending rows so cancelled / accepted / expired rows
    // don't artificially block.
    const pendingCountRows = yield* Effect.promise(() =>
      internalQuery<{ count: number }>(
        `SELECT COUNT(*)::int as count FROM invitation
         WHERE "organizationId" = $1 AND status = 'pending' AND "expiresAt" > now()`,
        [organizationId],
      ),
    );
    const pendingCount = pendingCountRows[0]?.count ?? 0;
    if (pendingCount >= PENDING_INVITATION_LIMIT_PER_ORG) {
      return c.json(
        {
          error: "invitation_limit",
          message: `This organization has reached the pending-invitation cap (${PENDING_INVITATION_LIMIT_PER_ORG}). Cancel or accept existing invitations before issuing more.`,
          requestId,
        },
        429,
      );
    }

    // Seat-limit gate against the TARGET org's plan (not the caller's).
    // `Effect.tryPromise` (not `Effect.promise`) so the helper's thrown
    // `APIError` shows up as a recoverable failure we can branch on,
    // rather than a defect that bubbles past the runHandler envelope as
    // a generic 500.
    const seatLimit = yield* Effect.tryPromise({
      try: () => enforceInvitationSeatLimit(organizationId),
      catch: (err) => err instanceof Error ? err : new Error(String(err)),
    }).pipe(Effect.either);
    if (seatLimit._tag === "Left") {
      const err = seatLimit.left;
      if (err instanceof APIError) {
        const status = err.status === "TOO_MANY_REQUESTS" ? 429 : 500;
        return c.json(
          {
            error: status === 429 ? "seat_limit" : "internal_error",
            message: err.body?.message ?? "Seat-limit check failed.",
            requestId,
          },
          status,
        );
      }
      log.error({ err: errorMessage(err), organizationId, requestId }, "Seat-limit check threw unexpectedly");
      return c.json(
        { error: "internal_error", message: "Could not verify seat limit. Please retry.", requestId },
        500,
      );
    }

    // Resolve `inviterId` to a CURRENT MEMBER of the target org. Better
    // Auth's invitation-read path rejects any row whose `inviterId` is
    // not a member of `organizationId` — a platform admin who isn't a
    // member would otherwise create rows the recipient can't accept
    // (the link surfaces as "invitation unavailable").
    //
    // Preference order: (1) caller, if they happen to be a target-org
    // member; (2) an owner; (3) an admin; (4) any member. The audit row
    // still records the real `platform_admin` actor (`user.id`) — only
    // the `invitation.inviterId` column gets the resolved member so the
    // accept flow stays unbroken. Empty result means the org has no
    // members at all, which is structurally impossible for a created
    // org (`afterCreateOrganization` always seeds the owner-member);
    // we 500 rather than guess at an inviter.
    const inviterMembers = yield* Effect.promise(() =>
      internalQuery<MemberRow>(
        `SELECT id, "userId", role FROM member
         WHERE "organizationId" = $1
         ORDER BY
           ("userId" = $2) DESC,
           CASE role
             WHEN 'owner' THEN 0
             WHEN 'admin' THEN 1
             ELSE 2
           END,
           "createdAt"
         LIMIT 1`,
        [organizationId, user.id],
      ),
    );
    if (inviterMembers.length === 0) {
      // `afterCreateOrganization` seeds the owner-member so a brand-new
      // org always has at least one. We can still land here if an
      // operator script or migration emptied the membership table while
      // the org row stayed — treat that as a 409 (actionable: add a
      // member first) rather than 500 (server confused), since the
      // operator's next step is concrete.
      log.error(
        { organizationId, requestId },
        "Target org has no members — cannot resolve invitation inviterId",
      );
      return c.json(
        {
          error: "no_members",
          message: "Target organization has no members. Add a member before issuing invitations.",
          requestId,
        },
        409,
      );
    }
    const inviterIdForRow = inviterMembers[0].userId;

    // 48h expiry matches Better Auth's native default — recipient can
    // still accept if they pick up the email a day later.
    const invitationId = generateInvitationId();
    const expiresInMs = 1000 * 60 * 60 * 48;
    const expiresAt = new Date(Date.now() + expiresInMs);
    const createdAt = new Date();

    const insertedRows = yield* Effect.promise(() =>
      internalQuery<InvitationRow>(
        `INSERT INTO invitation (id, email, role, "organizationId", "inviterId", status, "expiresAt", "createdAt")
         VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7)
         RETURNING id, email, role, "organizationId", "inviterId", status, "expiresAt", "createdAt"`,
        [invitationId, email, role, organizationId, inviterIdForRow, expiresAt, createdAt],
      ),
    );
    if (insertedRows.length === 0) {
      // Defensive — INSERT ... RETURNING is expected to always emit a row.
      return c.json(
        { error: "internal_error", message: "Invitation creation returned no row.", requestId },
        500,
      );
    }
    const inserted = insertedRows[0];

    // Look up the inviter's name so the email reads "Alex invited
    // you..." rather than "alex@example.com invited you...". Falls
    // back to the AuthContext label (email) on miss — never blocks
    // the invite.
    const inviterRows = yield* Effect.promise(() =>
      internalQuery<{ name: string | null; email: string }>(
        `SELECT name, email FROM "user" WHERE id = $1 LIMIT 1`,
        [user.id],
      ),
    );
    const inviterName = inviterRows[0]?.name ?? null;
    const inviterEmail = inviterRows[0]?.email ?? user.label;

    // Send the email. On failure we DELETE the just-inserted row so we
    // don't strand the target org with a pending invite the platform
    // admin can't see or cancel via the org-scoped UI (they're not a
    // member). Differs from Better Auth's native flow, which leaves the
    // row in place because the inviter IS a member and can cancel via
    // the org admin UI — that escape hatch doesn't exist for cross-org
    // invites. Rollback errors are logged but the original 500 response
    // is preserved (the inserted-row leak is a smaller harm than
    // dropping the user-visible failure on the floor).
    const emailDispatch = yield* Effect.tryPromise({
      try: () =>
        dispatchInvitationEmail({
          invitationId: inserted.id,
          role: inserted.role,
          email: inserted.email,
          organization: { id: org.id, name: org.name },
          inviter: { user: { name: inviterName, email: inviterEmail } },
        }),
      catch: (err) => err instanceof Error ? err : new Error(String(err)),
    }).pipe(Effect.either);
    if (emailDispatch._tag === "Left") {
      const err = emailDispatch.left;
      const rollback = yield* Effect.tryPromise({
        try: () =>
          internalQuery(
            `DELETE FROM invitation WHERE id = $1`,
            [inserted.id],
          ),
        catch: (e) => e instanceof Error ? e : new Error(String(e)),
      }).pipe(Effect.either);
      if (rollback._tag === "Left") {
        log.error(
          {
            err: errorMessage(rollback.left),
            invitationId: inserted.id,
            organizationId,
            requestId,
          },
          "Failed to roll back invitation row after email dispatch failure — orphan row remains",
        );
      }
      if (err instanceof APIError) {
        return c.json(
          { error: "email_failed", message: err.body?.message ?? "Failed to send invitation email.", requestId },
          500,
        );
      }
      log.error({ err: errorMessage(err), invitationId: inserted.id, requestId }, "Email dispatch threw unexpectedly");
      return c.json(
        { error: "email_failed", message: "Failed to send invitation email.", requestId },
        500,
      );
    }

    // Audit row + onboarding milestone. Captures the target `orgId`
    // (not the caller's active org) so platform-admin actions attribute
    // to the right workspace. `tryPromise` (not `promise`) because the
    // invite has *already succeeded* by this point — an audit-write
    // throw must not void the 200 response and re-deliver the email on
    // retry. Logged and continued.
    const auditResult = yield* Effect.tryPromise({
      try: () =>
        recordInvitationCreated({
          invitationId: inserted.id,
          invitedEmail: inserted.email,
          role: inserted.role,
          inviter: { id: user.id, email: inviterEmail },
          orgId: org.id,
        }),
      catch: (err) => err instanceof Error ? err : new Error(String(err)),
    }).pipe(Effect.either);
    if (auditResult._tag === "Left") {
      log.error(
        {
          err: errorMessage(auditResult.left),
          invitationId: inserted.id,
          organizationId,
          requestId,
        },
        "Audit / onboarding-milestone failed — invitation succeeded, audit row may be missing",
      );
    }

    return c.json(
      {
        id: inserted.id,
        email: inserted.email,
        role: inserted.role,
        organizationId: inserted.organizationId,
        inviterId: inserted.inviterId,
        status: inserted.status,
        expiresAt: String(inserted.expiresAt),
        createdAt: String(inserted.createdAt),
      },
      200,
    );
  }), { label: "platform create invitation" });
});
