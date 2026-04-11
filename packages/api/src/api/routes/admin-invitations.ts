/**
 * Admin invitation management routes.
 *
 * Registered directly on the admin router via registerInvitationRoutes().
 * Org-scoped: all queries filter on invitations.org_id matching the caller's
 * active organization.
 */

import { createRoute, z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { createLogger } from "@atlas/api/lib/logger";
import { logAdminAction, ADMIN_ACTIONS } from "@atlas/api/lib/audit";
import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import { detectAuthMode } from "@atlas/api/lib/auth/detect";
import type { AtlasRole } from "@atlas/api/lib/auth/types";
import { ATLAS_ROLES } from "@atlas/api/lib/auth/types";
import { runHandler } from "@atlas/api/lib/effect/hono";
import { checkResourceLimit } from "@atlas/api/lib/billing/enforcement";
import { ErrorSchema, AuthErrorSchema } from "./shared-schemas";

const log = createLogger("admin-invitations");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const INVITE_EXPIRY_DAYS = 7;

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isValidRole(role: unknown): role is AtlasRole {
  return typeof role === "string" && (ATLAS_ROLES as readonly string[]).includes(role);
}

function resolveBaseUrl(req: Request): string {
  return (
    req.headers.get("origin") ??
    process.env.ATLAS_CORS_ORIGIN ??
    "http://localhost:3000"
  );
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const inviteUserRoute = createRoute({
  method: "post",
  path: "/users/invite",
  tags: ["Admin — Invitations"],
  summary: "Create invitation",
  description: "Creates an invitation for a new user. Optionally sends an email via Resend. Scoped to active organization.",
  responses: {
    200: { description: "Invitation created", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    400: { description: "Invalid request", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Not available — requires managed auth", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "User or invitation already exists", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const listInvitationsRoute = createRoute({
  method: "get",
  path: "/users/invitations",
  tags: ["Admin — Invitations"],
  summary: "List invitations",
  description: "Returns invitations with optional status filter. Scoped to active organization.",
  responses: {
    200: { description: "Invitation list", content: { "application/json": { schema: z.object({ invitations: z.array(z.unknown()) }) } } },
    400: { description: "No active organization", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Not available — requires managed auth", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const revokeInvitationRoute = createRoute({
  method: "delete",
  path: "/users/invitations/{id}",
  tags: ["Admin — Invitations"],
  summary: "Revoke invitation",
  description: "Revokes a pending invitation. Must belong to the active organization.",
  request: {
    params: z.object({
      id: z.string().min(1).openapi({ param: { name: "id", in: "path" }, example: "inv_abc123" }),
    }),
  },
  responses: {
    200: { description: "Invitation revoked", content: { "application/json": { schema: z.object({ success: z.boolean() }) } } },
    400: { description: "No active organization", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Invitation not found or not available", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// ---------------------------------------------------------------------------
// Registration function
// ---------------------------------------------------------------------------

/**
 * Register invitation routes on the admin router.
 * Uses the same auth pattern as other admin.ts handlers (adminAuthAndContext).
 * The `adminAuthAndContext` function is provided by the caller to avoid circular deps.
 */
export function registerInvitationRoutes(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- generic admin router type
  admin: OpenAPIHono<any>,
  adminAuthAndContext?: (c: { req: { raw: Request }; get(key: string): unknown }) => Promise<{ authResult: { authenticated: true; user?: { id?: string; role?: string; activeOrganizationId?: string } }; requestId: string }>,
) {
  // If no adminAuthAndContext provided, the handlers assume auth was already done by middleware
  const getAuthCtx = adminAuthAndContext ?? (async (c: { get(key: string): unknown }) => ({
    authResult: { authenticated: true as const, user: undefined },
    requestId: c.get("requestId") as string,
  }));

  // POST /users/invite — create invitation scoped to active org
  admin.openapi(inviteUserRoute, async (c) => runHandler(c, "invite user", async () => {
    const { authResult, requestId } = await getAuthCtx(c);
    const orgId = authResult.user?.activeOrganizationId;

    if (!hasInternalDB() || detectAuthMode() !== "managed") {
      return c.json({ error: "not_available", message: "User invitations require managed auth mode.", requestId }, 404);
    }

    if (!orgId) {
      return c.json({ error: "bad_request", message: "No active organization. Set an active org first.", requestId }, 400);
    }

    const body = await c.req.json().catch((err: unknown) => {
      log.warn({ err: err instanceof Error ? err.message : String(err), requestId }, "Failed to parse JSON body in invite request");
      return null;
    });

    if (!body || typeof body !== "object") {
      return c.json({ error: "invalid_request", message: "Request body is required.", requestId }, 400);
    }

    const email = typeof body.email === "string" ? body.email.toLowerCase().trim() : "";
    const role = body.role;

    if (!email || !isValidEmail(email)) {
      return c.json({ error: "invalid_request", message: "A valid email address is required.", requestId }, 400);
    }

    if (!isValidRole(role)) {
      return c.json({ error: "invalid_request", message: `Invalid role. Must be one of: ${ATLAS_ROLES.join(", ")}`, requestId }, 400);
    }

    // Enforce plan member limit before proceeding.
    // Count includes current members + pending invitations to prevent over-provisioning.
    // Note: TOCTOU race is acceptable — admin invitation is low-frequency.
    const memberCountRows = await internalQuery<{ count: number }>(
      `SELECT (
        (SELECT COUNT(*)::int FROM member WHERE "organizationId" = $1) +
        (SELECT COUNT(*)::int FROM invitation WHERE "organizationId" = $1 AND status = 'pending' AND "expiresAt" > now())
      ) as count`,
      [orgId],
    );
    const memberCount = memberCountRows[0]?.count ?? 0;
    const resourceCheck = await checkResourceLimit(orgId, "seats", memberCount);
    if (!resourceCheck.allowed) {
      return c.json({ error: "plan_limit_exceeded", message: resourceCheck.errorMessage, requestId }, 429);
    }

    // Check for existing user and pending invitation (scoped to org) in parallel
    const [existing, pending] = await Promise.all([
      internalQuery<{ id: string }>(
        `SELECT id FROM "user" WHERE email = $1 LIMIT 1`,
        [email],
      ),
      internalQuery<{ id: string }>(
        `SELECT id FROM invitations WHERE email = $1 AND org_id = $2 AND status = 'pending' AND expires_at > now() LIMIT 1`,
        [email, orgId],
      ),
    ]);

    if (existing.length > 0) {
      return c.json({ error: "conflict", message: "A user with this email already exists.", requestId }, 409);
    }
    if (pending.length > 0) {
      return c.json({ error: "conflict", message: "A pending invitation for this email already exists.", requestId }, 409);
    }

    // Create invitation with org_id
    const token = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + INVITE_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

    const rows = await internalQuery<{ id: string; created_at: string }>(
      `INSERT INTO invitations (email, role, token, invited_by, expires_at, org_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, created_at`,
      [email, role, token, authResult.user?.id ?? null, expiresAt.toISOString(), orgId],
    );

    const invitation = rows[0];
    if (!invitation) {
      log.error({ email, role, requestId }, "INSERT RETURNING returned no rows");
      return c.json({ error: "internal_error", message: "Failed to create invitation.", requestId }, 500);
    }

    const baseUrl = resolveBaseUrl(c.req.raw);
    const inviteUrl = `${baseUrl}/?invite=${token}`;

    // Attempt email delivery via the platform email provider
    let emailSent = false;
    let emailError: string | undefined;
    try {
      const { sendEmail } = await import("@atlas/api/lib/email/delivery");
      const result = await sendEmail({
        to: email,
        subject: "You've been invited to Atlas",
        html: `<p>You've been invited to join Atlas as <strong>${role}</strong>.</p>
<p><a href="${inviteUrl}">Accept invitation</a></p>
<p>This invitation expires on ${expiresAt.toLocaleDateString()}.</p>
<p>If you didn't expect this invitation, you can safely ignore this email.</p>`,
      });
      emailSent = result.success;
      if (!result.success) {
        emailError = result.error ?? "Email delivery failed";
        log.error({ email, provider: result.provider, error: result.error }, "Failed to send invite email");
      }
    } catch (err) {
      emailError = err instanceof Error ? err.message : "Network error";
      log.error({ err: err instanceof Error ? err.message : String(err), email }, "Invite email delivery failed");
    }

    log.info({ requestId, invitationId: invitation.id, email, role, emailSent, orgId, actorId: authResult.user?.id }, "User invited");

    logAdminAction({
      actionType: ADMIN_ACTIONS.user.invite,
      targetType: "user",
      targetId: invitation.id,
      ipAddress: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null,
      metadata: { email, role },
    });

    return c.json({
      id: invitation.id,
      email,
      role,
      token,
      inviteUrl,
      emailSent,
      ...(emailError ? { emailError } : {}),
      expiresAt: expiresAt.toISOString(),
      createdAt: invitation.created_at,
    }, 200);
  }));

  // GET /users/invitations — list invitations scoped to active org
  admin.openapi(listInvitationsRoute, async (c) => runHandler(c, "list invitations", async () => {
    const { authResult, requestId } = await getAuthCtx(c);
    const orgId = authResult.user?.activeOrganizationId;

    if (!hasInternalDB() || detectAuthMode() !== "managed") {
      return c.json({ error: "not_available", message: "User invitations require managed auth mode.", requestId }, 404);
    }

    if (!orgId) {
      return c.json({ error: "bad_request", message: "No active organization. Set an active org first.", requestId }, 400);
    }

    const status = c.req.query("status");
    const validStatuses = ["pending", "accepted", "revoked", "expired"];

    const conditions: string[] = ["i.org_id = $1"];
    const params: unknown[] = [orgId];

    if (status && validStatuses.includes(status)) {
      if (status === "expired") {
        conditions.push(`i.status = 'pending' AND i.expires_at <= now()`);
      } else {
        conditions.push(`i.status = $${params.length + 1}`);
        params.push(status);
      }
    }

    const where = `WHERE ${conditions.join(" AND ")}`;

    const rows = await internalQuery<{
      id: string; email: string; role: string; status: string;
      invited_by: string | null; invited_by_email: string | null;
      expires_at: string; accepted_at: string | null; created_at: string;
    }>(
      `SELECT i.id, i.email, i.role, i.status, i.invited_by, u.email AS invited_by_email,
              i.expires_at, i.accepted_at, i.created_at
       FROM invitations i
       LEFT JOIN "user" u ON i.invited_by = u.id
       ${where}
       ORDER BY i.created_at DESC LIMIT 100`,
      params,
    );

    const now = new Date();
    const invitations = rows.map((inv) => ({
      ...inv,
      status: inv.status === "pending" && new Date(inv.expires_at) < now ? "expired" : inv.status,
    }));

    return c.json({ invitations }, 200);
  }));

  // DELETE /users/invitations/:id — revoke invitation (must belong to active org)
  admin.openapi(revokeInvitationRoute, async (c) => runHandler(c, "revoke invitation", async () => {
    const { id: invitationId } = c.req.valid("param");
    const { authResult, requestId } = await getAuthCtx(c);
    const orgId = authResult.user?.activeOrganizationId;

    if (!hasInternalDB() || detectAuthMode() !== "managed") {
      return c.json({ error: "not_available", message: "User invitations require managed auth mode.", requestId }, 404);
    }

    if (!orgId) {
      return c.json({ error: "bad_request", message: "No active organization. Set an active org first.", requestId }, 400);
    }

    const result = await internalQuery<{ id: string }>(
      `UPDATE invitations SET status = 'revoked' WHERE id = $1 AND org_id = $2 AND status = 'pending' RETURNING id`,
      [invitationId, orgId],
    );

    if (result.length === 0) {
      return c.json({ error: "not_found", message: "Invitation not found or already resolved.", requestId }, 404);
    }

    log.info({ requestId, invitationId, orgId, actorId: authResult.user?.id }, "Invitation revoked");
    return c.json({ success: true }, 200);
  }));
}
