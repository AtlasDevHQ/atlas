/**
 * Platform-admin cross-org invitation routes.
 *
 * Mounted at /api/v1/platform/invitations. Lets a `platform_admin` invite
 * a user into any organization they don't belong to — the native
 * `auth.api.createInvitation` endpoint enforces an org-membership gate on
 * the caller (see `better-auth/.../crud-invites.mjs:80`) which a platform
 * admin who isn't a member of the target org can't satisfy.
 *
 * The route re-implements the create flow with the membership check
 * bypassed. The platform_admin gate IS the bypass: `createPlatformRouter`
 * enforces `role === "platform_admin"` before any handler runs. Seat-limit,
 * audit, and email all route through the shared helpers in
 * `lib/auth/invitations.ts` so the row shape and side effects match what
 * Better Auth's hook path produces.
 *
 * Phase 2 of #2876. Phase 1 (#2875) shipped the pure-native flow.
 */

import { createRoute, z } from "@hono/zod-openapi";
import { Effect } from "effect";
import crypto from "node:crypto";
import { createPlatformRouter } from "./admin-router";
import { runEffect } from "@atlas/api/lib/effect/hono";
import { AuthContext, RequestContext } from "@atlas/api/lib/effect/services";
import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import {
  assertInvitationRoleAllowed,
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
  role: z.string().min(1).openapi({ description: "Role to grant on acceptance. Must NOT be `platform_admin`." }),
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
 * 32-char alphanumeric ID matching Better Auth's `generateId` shape
 * (`@better-auth/core/utils/id`). Reimplemented here because that subpath
 * is not exported from the published package. Same character set (a-z,
 * A-Z, 0-9) and same length so platform-created rows are
 * indistinguishable from native-flow rows in monitoring / log greps.
 */
function generateInvitationId(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const bytes = crypto.randomBytes(32);
  let out = "";
  for (let i = 0; i < 32; i++) {
    // 62 % 256 == 6, so a simple modulo skews the distribution slightly —
    // acceptable for an opaque invitation id (not a security token).
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}

type OrgRow = { id: string; name: string; [key: string]: unknown };
type MemberRow = { id: string; [key: string]: unknown };
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
      // platformAdminAuth + AuthContext should have populated this. Belt
      // and suspenders — keeps the type narrowed for the rest of the handler.
      return c.json(
        { error: "unauthenticated", message: "Authentication required.", requestId },
        401,
      );
    }

    const { organizationId, email: rawEmail, role } = c.req.valid("json");
    const email = rawEmail.toLowerCase();

    // Defense-in-depth role gate (also enforced inside the seat-limit
    // helper's caller, but we want a 400 before any DB I/O).
    try {
      assertInvitationRoleAllowed(role);
    } catch (err) {
      if (err instanceof APIError) {
        return c.json(
          { error: "bad_request", message: err.body?.message ?? "Invalid role.", requestId },
          400,
        );
      }
      throw err;
    }

    // Verify the target org exists. A 404 here beats the bewildering
    // foreign-key-violation noise that an unguarded INSERT would emit if
    // the FE shipped a stale `organizationId`.
    const orgs = yield* Effect.promise(() =>
      internalQuery<OrgRow>(`SELECT id, name FROM organization WHERE id = $1`, [organizationId]),
    );
    if (orgs.length === 0) {
      return c.json(
        { error: "not_found", message: "Organization not found.", requestId },
        404,
      );
    }
    const org = orgs[0];

    // Existing-member dedup. Mirrors Better Auth's
    // `findMemberByEmail({ email, organizationId })` lookup so a
    // pre-existing member of the target org doesn't get a phantom
    // pending-invite row.
    const existingMembers = yield* Effect.promise(() =>
      internalQuery<MemberRow>(
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

    // INSERT the invitation row. Match Better Auth's adapter shape:
    // 32-char alphanumeric id, status='pending', expiresAt=now+48h.
    const invitationId = generateInvitationId();
    const expiresInMs = 1000 * 60 * 60 * 48;
    const expiresAt = new Date(Date.now() + expiresInMs);
    const createdAt = new Date();

    const insertedRows = yield* Effect.promise(() =>
      internalQuery<InvitationRow>(
        `INSERT INTO invitation (id, email, role, "organizationId", "inviterId", status, "expiresAt", "createdAt")
         VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7)
         RETURNING id, email, role, "organizationId", "inviterId", status, "expiresAt", "createdAt"`,
        [invitationId, email, role, organizationId, user.id, expiresAt, createdAt],
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

    // Look up the inviter's name from the user table so the email reads
    // "Matt Sywulak invited you..." rather than "msywulak@useatlas.dev
    // invited you...". Falls back to the AuthContext label (email) on
    // miss — never blocks the invite.
    const inviterRows = yield* Effect.promise(() =>
      internalQuery<{ name: string | null; email: string }>(
        `SELECT name, email FROM "user" WHERE id = $1 LIMIT 1`,
        [user.id],
      ),
    );
    const inviterName = inviterRows[0]?.name ?? null;
    const inviterEmail = inviterRows[0]?.email ?? user.label;

    // Send the email. Throws on failure — we surface 500 and leave the
    // pending row, matching Better Auth's native-flow behavior (the row
    // is created BEFORE the email send in `crud-invites.mjs:199-213`).
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

    // Audit row + onboarding milestone. The audit captures the target
    // `orgId` (NOT the caller's active org) so platform-admin actions
    // attribute to the right workspace in the action log.
    yield* Effect.promise(() =>
      recordInvitationCreated({
        invitationId: inserted.id,
        invitedEmail: inserted.email,
        role: inserted.role,
        inviter: { id: user.id, email: inviterEmail },
        orgId: org.id,
      }),
    );

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
