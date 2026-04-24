/**
 * Admin session management routes.
 *
 * Mounted under /api/v1/admin/sessions via admin.route().
 * Org-scoped: all queries are filtered to members of the caller's active organization.
 */

import { Effect } from "effect";
import { createRoute, z } from "@hono/zod-openapi";
import { createLogger } from "@atlas/api/lib/logger";
import { runEffect } from "@atlas/api/lib/effect/hono";
import { AuthContext } from "@atlas/api/lib/effect/services";
import { internalQuery, queryEffect } from "@atlas/api/lib/db/internal";
import { detectAuthMode } from "@atlas/api/lib/auth/detect";
import { logAdminAction, ADMIN_ACTIONS } from "@atlas/api/lib/audit";
import { errorMessage, causeToError } from "@atlas/api/lib/audit/error-scrub";
import { ErrorSchema, AuthErrorSchema, parsePagination, escapeIlike } from "./shared-schemas";
import { createAdminRouter, requireOrgContext } from "./admin-router";

const log = createLogger("admin-sessions");

// Identifier upper bound for route params — better-auth session / user ids
// are ~32-64 chars in practice. Capping prevents adversarial inputs from
// bloating `admin_action_log.metadata` on the `found: false` emission paths.
const ID_MAX_LEN = 255;

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const listSessionsRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Admin — Sessions"],
  summary: "List sessions",
  description:
    "Returns paginated sessions with user info. Supports search by email or IP. Scoped to active organization.",
  responses: {
    200: {
      description: "Session list",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Not available — requires managed auth", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const getSessionStatsRoute = createRoute({
  method: "get",
  path: "/stats",
  tags: ["Admin — Sessions"],
  summary: "Session statistics",
  description:
    "Returns total, active, and unique user session counts. Scoped to active organization.",
  responses: {
    200: {
      description: "Session stats",
      content: {
        "application/json": {
          schema: z.object({ total: z.number(), active: z.number(), uniqueUsers: z.number() }),
        },
      },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Not available — requires managed auth", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const deleteSessionRoute = createRoute({
  method: "delete",
  path: "/{id}",
  tags: ["Admin — Sessions"],
  summary: "Revoke session",
  description: "Revokes a single session by ID. Must belong to a member of the active organization.",
  request: {
    params: z.object({
      id: z.string().min(1).max(ID_MAX_LEN).openapi({ param: { name: "id", in: "path" }, example: "sess_abc123" }),
    }),
  },
  responses: {
    200: {
      description: "Session revoked",
      content: { "application/json": { schema: z.object({ success: z.boolean() }) } },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Session not found or not available", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const deleteUserSessionsRoute = createRoute({
  method: "delete",
  path: "/user/{userId}",
  tags: ["Admin — Sessions"],
  summary: "Revoke all user sessions",
  description: "Revokes all sessions for a specific user. User must be a member of the active organization.",
  request: {
    params: z.object({
      userId: z.string().min(1).max(ID_MAX_LEN).openapi({ param: { name: "userId", in: "path" }, example: "user_abc123" }),
    }),
  },
  responses: {
    200: {
      description: "Sessions revoked",
      content: { "application/json": { schema: z.object({ success: z.boolean(), count: z.number() }) } },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "No sessions found or not available", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const adminSessions = createAdminRouter();
adminSessions.use(requireOrgContext());

// GET / — list sessions scoped to active org
adminSessions.openapi(listSessionsRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { orgId } = yield* AuthContext;
    const { requestId } = c.get("orgContext");

    if (detectAuthMode() !== "managed") {
      return c.json({ error: "not_available", message: "Session management requires managed auth mode.", requestId }, 404);
    }

    const { limit, offset } = parsePagination(c);
    const search = c.req.query("search");

    const conditions: string[] = [`m."organizationId" = $1`];
    const params: unknown[] = [orgId];
    let paramIdx = 2;

    if (search) {
      conditions.push(`(u.email ILIKE $${paramIdx} OR s."ipAddress" ILIKE $${paramIdx})`);
      params.push(`%${escapeIlike(search)}%`);
      paramIdx++;
    }

    const where = `WHERE ${conditions.join(" AND ")}`;

    const [rows, countResult] = yield* Effect.promise(() => Promise.all([
      internalQuery<{
        id: string;
        userId: string;
        userEmail: string | null;
        createdAt: string;
        updatedAt: string;
        expiresAt: string;
        ipAddress: string | null;
        userAgent: string | null;
      }>(
        `SELECT s.id, s."userId" AS "userId", u.email AS "userEmail",
                s."createdAt" AS "createdAt", s."updatedAt" AS "updatedAt",
                s."expiresAt" AS "expiresAt",
                s."ipAddress" AS "ipAddress", s."userAgent" AS "userAgent"
         FROM session s
         LEFT JOIN "user" u ON s."userId" = u.id
         JOIN member m ON m."userId" = s."userId"
         ${where}
         ORDER BY s."updatedAt" DESC
         LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
        [...params, limit, offset],
      ),
      internalQuery<{ count: string }>(
        `SELECT COUNT(*) AS count
         FROM session s
         LEFT JOIN "user" u ON s."userId" = u.id
         JOIN member m ON m."userId" = s."userId"
         ${where}`,
        params,
      ),
    ]));

    return c.json({
      sessions: rows.map((r) => ({
        id: r.id,
        userId: r.userId,
        userEmail: r.userEmail,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        expiresAt: r.expiresAt,
        ipAddress: r.ipAddress,
        userAgent: r.userAgent,
      })),
      total: parseInt(String(countResult[0]?.count ?? "0"), 10),
      limit,
      offset,
    }, 200);
  }), { label: "list sessions" });
});

// GET /stats — session statistics scoped to active org
adminSessions.openapi(getSessionStatsRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { orgId } = yield* AuthContext;
    const { requestId } = c.get("orgContext");

    if (detectAuthMode() !== "managed") {
      return c.json({ error: "not_available", message: "Session management requires managed auth mode.", requestId }, 404);
    }

    const [totalResult, activeResult, uniqueUsersResult] = yield* Effect.promise(() => Promise.all([
      internalQuery<{ count: string }>(
        `SELECT COUNT(*) AS count
         FROM session s
         JOIN member m ON m."userId" = s."userId"
         WHERE m."organizationId" = $1`,
        [orgId],
      ),
      internalQuery<{ count: string }>(
        `SELECT COUNT(*) AS count
         FROM session s
         JOIN member m ON m."userId" = s."userId"
         WHERE s."expiresAt" > NOW() AND m."organizationId" = $1`,
        [orgId],
      ),
      internalQuery<{ count: string }>(
        `SELECT COUNT(DISTINCT s."userId") AS count
         FROM session s
         JOIN member m ON m."userId" = s."userId"
         WHERE s."expiresAt" > NOW() AND m."organizationId" = $1`,
        [orgId],
      ),
    ]));

    return c.json({
      total: parseInt(String(totalResult[0]?.count ?? "0"), 10),
      active: parseInt(String(activeResult[0]?.count ?? "0"), 10),
      uniqueUsers: parseInt(String(uniqueUsersResult[0]?.count ?? "0"), 10),
    }, 200);
  }), { label: "get session stats" });
});

// DELETE /:id — revoke a single session (must belong to org member)
adminSessions.openapi(deleteSessionRoute, async (c) => {
  const { id: sessionId } = c.req.valid("param");
  const ipAddress = c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null;

  return runEffect(c, Effect.gen(function* () {
    const { orgId, user } = yield* AuthContext;
    const { requestId } = c.get("orgContext");

    if (detectAuthMode() !== "managed") {
      return c.json({ error: "not_available", message: "Session management requires managed auth mode.", requestId }, 404);
    }

    // Pre-fetch so the audit row records `targetUserId` — once the DELETE
    // runs the row is gone and the audit entry would be left with only the
    // opaque `sessionId`. Scoped to the active org with the same filter as
    // the DELETE to prevent probing sessions outside the caller's workspace.
    const prior = yield* queryEffect<{ id: string; userId: string }>(
      `SELECT s.id, s."userId" AS "userId"
       FROM session s
       JOIN member m ON m."userId" = s."userId"
       WHERE s.id = $1 AND m."organizationId" = $2`,
      [sessionId, orgId],
    );

    if (prior.length === 0) {
      // Attempt still recorded — an admin targeting a missing / out-of-org
      // session is a forensic signal, not a failure state.
      logAdminAction({
        actionType: ADMIN_ACTIONS.user.sessionRevoke,
        targetType: "user",
        targetId: sessionId,
        ipAddress,
        metadata: { sessionId, found: false },
      });
      return c.json({ error: "not_found", message: "Session not found.", requestId }, 404);
    }

    const targetUserId = prior[0]!.userId;
    const wasCurrentUser = targetUserId === user?.id;

    const deleted = yield* queryEffect<{ id: string }>(
      `DELETE FROM session s
       USING member m
       WHERE s.id = $1
         AND m."userId" = s."userId"
         AND m."organizationId" = $2
       RETURNING s.id`,
      [sessionId, orgId],
    );
    if (deleted.length === 0) {
      // Race: the row vanished between the pre-fetch and the DELETE. Carry
      // forward the `targetUserId` we already captured — dropping it would
      // discard forensic context we paid for.
      logAdminAction({
        actionType: ADMIN_ACTIONS.user.sessionRevoke,
        targetType: "user",
        targetId: sessionId,
        ipAddress,
        metadata: { sessionId, targetUserId, found: false, race: true },
      });
      return c.json({ error: "not_found", message: "Session not found.", requestId }, 404);
    }

    log.info({ requestId, sessionId, actorId: user?.id }, "Session revoked");
    logAdminAction({
      actionType: ADMIN_ACTIONS.user.sessionRevoke,
      targetType: "user",
      targetId: sessionId,
      ipAddress,
      metadata: { sessionId, targetUserId, wasCurrentUser },
    });
    return c.json({ success: true }, 200);
  }).pipe(
    // Pure-interrupt causes (fiber cancelled — client disconnect, shutdown)
    // leave the outcome indeterminate and are intentionally not audited, in
    // line with F-23's SCIM precedent. All other failures (typed + defect)
    // emit a status:"failure" row. `Effect.ignoreLogged` guards against a
    // future regression that makes logAdminAction throw — the original 500
    // still flows through to the caller instead of being masked.
    Effect.tapErrorCause((cause) => {
      const err = causeToError(cause);
      if (err === undefined) return Effect.void;
      return Effect.sync(() =>
        logAdminAction({
          actionType: ADMIN_ACTIONS.user.sessionRevoke,
          targetType: "user",
          targetId: sessionId,
          status: "failure",
          ipAddress,
          metadata: { sessionId, error: errorMessage(err) },
        }),
      ).pipe(Effect.ignoreLogged);
    }),
  ), { label: "revoke session" });
});

// DELETE /user/:userId — revoke all sessions for a user (must be org member)
adminSessions.openapi(deleteUserSessionsRoute, async (c) => {
  const { userId } = c.req.valid("param");
  const ipAddress = c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null;

  return runEffect(c, Effect.gen(function* () {
    const { orgId, user } = yield* AuthContext;
    const { requestId } = c.get("orgContext");

    if (detectAuthMode() !== "managed") {
      return c.json({ error: "not_available", message: "Session management requires managed auth mode.", requestId }, 404);
    }

    // Only delete sessions where the user is a member of the active org
    const deleted = yield* queryEffect<{ id: string }>(
      `DELETE FROM session s
       USING member m
       WHERE s."userId" = $1
         AND m."userId" = s."userId"
         AND m."organizationId" = $2
       RETURNING s.id`,
      [userId, orgId],
    );
    if (deleted.length === 0) {
      // Still record the attempt — a 0-count bulk revoke is a forensic
      // signal (admin probed for sessions that weren't there).
      logAdminAction({
        actionType: ADMIN_ACTIONS.user.sessionRevokeAll,
        targetType: "user",
        targetId: userId,
        ipAddress,
        metadata: { targetUserId: userId, count: 0 },
      });
      return c.json({ error: "not_found", message: "No sessions found for this user.", requestId }, 404);
    }

    const count = deleted.length;
    log.info({ requestId, targetUserId: userId, count, actorId: user?.id }, "All user sessions revoked");
    logAdminAction({
      actionType: ADMIN_ACTIONS.user.sessionRevokeAll,
      targetType: "user",
      targetId: userId,
      ipAddress,
      metadata: { targetUserId: userId, count },
    });
    return c.json({ success: true, count }, 200);
  }).pipe(
    // Same interrupt / ignoreLogged rationale as the single-session path.
    Effect.tapErrorCause((cause) => {
      const err = causeToError(cause);
      if (err === undefined) return Effect.void;
      return Effect.sync(() =>
        logAdminAction({
          actionType: ADMIN_ACTIONS.user.sessionRevokeAll,
          targetType: "user",
          targetId: userId,
          status: "failure",
          ipAddress,
          metadata: { targetUserId: userId, error: errorMessage(err) },
        }),
      ).pipe(Effect.ignoreLogged);
    }),
  ), { label: "revoke user sessions" });
});

export { adminSessions };
