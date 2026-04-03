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
import { internalQuery } from "@atlas/api/lib/db/internal";
import { detectAuthMode } from "@atlas/api/lib/auth/detect";
import { ErrorSchema, AuthErrorSchema, parsePagination, escapeIlike } from "./shared-schemas";
import { createAdminRouter, requireOrgContext } from "./admin-router";

const log = createLogger("admin-sessions");

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
      id: z.string().min(1).openapi({ param: { name: "id", in: "path" }, example: "sess_abc123" }),
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
      userId: z.string().min(1).openapi({ param: { name: "userId", in: "path" }, example: "user_abc123" }),
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
  return runEffect(c, Effect.gen(function* () {
    const { orgId, user } = yield* AuthContext;
    const { requestId } = c.get("orgContext");
    const { id: sessionId } = c.req.valid("param");

    if (detectAuthMode() !== "managed") {
      return c.json({ error: "not_available", message: "Session management requires managed auth mode.", requestId }, 404);
    }

    // Only delete if the session belongs to a member of the active org
    const deleted = yield* Effect.promise(() => internalQuery<{ id: string }>(
      `DELETE FROM session s
       USING member m
       WHERE s.id = $1
         AND m."userId" = s."userId"
         AND m."organizationId" = $2
       RETURNING s.id`,
      [sessionId, orgId],
    ));
    if (deleted.length === 0) {
      return c.json({ error: "not_found", message: "Session not found.", requestId }, 404);
    }

    log.info({ requestId, sessionId, actorId: user?.id }, "Session revoked");
    return c.json({ success: true }, 200);
  }), { label: "revoke session" });
});

// DELETE /user/:userId — revoke all sessions for a user (must be org member)
adminSessions.openapi(deleteUserSessionsRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { orgId, user } = yield* AuthContext;
    const { requestId } = c.get("orgContext");
    const { userId } = c.req.valid("param");

    if (detectAuthMode() !== "managed") {
      return c.json({ error: "not_available", message: "Session management requires managed auth mode.", requestId }, 404);
    }

    // Only delete sessions where the user is a member of the active org
    const deleted = yield* Effect.promise(() => internalQuery<{ id: string }>(
      `DELETE FROM session s
       USING member m
       WHERE s."userId" = $1
         AND m."userId" = s."userId"
         AND m."organizationId" = $2
       RETURNING s.id`,
      [userId, orgId],
    ));
    if (deleted.length === 0) {
      return c.json({ error: "not_found", message: "No sessions found for this user.", requestId }, 404);
    }

    const count = deleted.length;
    log.info({ requestId, targetUserId: userId, count, actorId: user?.id }, "All user sessions revoked");
    return c.json({ success: true, count }, 200);
  }), { label: "revoke user sessions" });
});

export { adminSessions };
