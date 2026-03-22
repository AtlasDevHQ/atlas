/**
 * User self-service session routes.
 *
 * Mounted at /api/v1/sessions. Authenticated users can list and revoke
 * their own sessions (not other users'). Admin session management is
 * handled separately in the admin routes.
 */

import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { z } from "zod";
import { createLogger, withRequestContext } from "@atlas/api/lib/logger";
import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import { detectAuthMode } from "@atlas/api/lib/auth/detect";
import { authPreamble } from "./auth-preamble";

const log = createLogger("sessions-routes");

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const ErrorSchema = z.object({
  error: z.string(),
  message: z.string(),
  requestId: z.string().optional(),
});

const SessionSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  expiresAt: z.string(),
  ipAddress: z.string().nullable(),
  userAgent: z.string().nullable(),
});

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const listSessionsRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Sessions"],
  summary: "List current user's sessions",
  description:
    "Returns all sessions for the authenticated user. Requires managed auth mode and an internal database.",
  responses: {
    200: {
      description: "List of user sessions",
      content: {
        "application/json": {
          schema: z.object({ sessions: z.array(SessionSchema) }),
        },
      },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    403: {
      description: "Forbidden — insufficient permissions",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    404: {
      description: "Session management requires managed auth mode",
      content: { "application/json": { schema: ErrorSchema } },
    },
    429: {
      description: "Rate limit exceeded",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const revokeSessionRoute = createRoute({
  method: "delete",
  path: "/{id}",
  tags: ["Sessions"],
  summary: "Revoke a session",
  description:
    "Revokes one of the current user's sessions. Cannot revoke another user's session.",
  request: {
    params: z.object({
      id: z.string().openapi({ param: { name: "id", in: "path" }, example: "session-id" }),
    }),
  },
  responses: {
    200: {
      description: "Session revoked",
      content: {
        "application/json": {
          schema: z.object({ success: z.boolean() }),
        },
      },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    403: {
      description: "Cannot revoke another user's session",
      content: { "application/json": { schema: ErrorSchema } },
    },
    404: {
      description: "Session not found or not in managed auth mode",
      content: { "application/json": { schema: ErrorSchema } },
    },
    429: {
      description: "Rate limit exceeded",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const sessions = new OpenAPIHono();

// GET / — list the current user's sessions
sessions.openapi(listSessionsRoute, async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  const preamble = await authPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, preamble.status, preamble.headers) as never;
  }
  const { authResult } = preamble;

  const user = authResult.user;
  if (!hasInternalDB() || detectAuthMode() !== "managed" || !user) {
    return c.json({ error: "not_available", message: "Session management requires managed auth mode.", requestId }, 404) as never;
  }

  return withRequestContext({ requestId, user }, async () => {
    const userId = user.id;

    try {
      const rows = await internalQuery<{
        id: string;
        createdAt: string;
        updatedAt: string;
        expiresAt: string;
        ipAddress: string | null;
        userAgent: string | null;
      }>(
        `SELECT id, "createdAt", "updatedAt", "expiresAt", "ipAddress", "userAgent"
         FROM session
         WHERE "userId" = $1
         ORDER BY "updatedAt" DESC
         LIMIT 100`,
        [userId],
      );

      return c.json({
        sessions: rows.map((r) => ({
          id: r.id,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
          expiresAt: r.expiresAt,
          ipAddress: r.ipAddress,
          userAgent: r.userAgent,
        })),
      }, 200);
    } catch (err) {
      log.error({ err: err instanceof Error ? err : new Error(String(err)), userId }, "Failed to list user sessions");
      return c.json({ error: "internal_error", message: "Failed to list sessions.", requestId }, 500) as never;
    }
  });
});

// DELETE /:id — revoke one of the current user's sessions
sessions.openapi(revokeSessionRoute, async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  const preamble = await authPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, preamble.status, preamble.headers) as never;
  }
  const { authResult } = preamble;

  const user = authResult.user;
  if (!hasInternalDB() || detectAuthMode() !== "managed" || !user) {
    return c.json({ error: "not_available", message: "Session management requires managed auth mode.", requestId }, 404) as never;
  }

  return withRequestContext({ requestId, user }, async () => {
    const userId = user.id;
    const { id: sessionId } = c.req.valid("param");

    try {
      // Atomic delete scoped to the current user — returns empty if
      // the session doesn't exist or belongs to another user.
      const deleted = await internalQuery<{ id: string }>(
        `DELETE FROM session WHERE id = $1 AND "userId" = $2 RETURNING id`,
        [sessionId, userId],
      );
      if (deleted.length === 0) {
        // Distinguish "not found" from "wrong user" for a clear error message
        const exists = await internalQuery<{ userId: string }>(
          `SELECT "userId" FROM session WHERE id = $1`,
          [sessionId],
        );
        if (exists.length === 0) {
          return c.json({ error: "not_found", message: "Session not found." }, 404) as never;
        }
        return c.json({ error: "forbidden", message: "Cannot revoke another user's session.", requestId }, 403) as never;
      }

      log.info({ requestId, sessionId, userId }, "User revoked own session");
      return c.json({ success: true }, 200);
    } catch (err) {
      log.error({ err: err instanceof Error ? err : new Error(String(err)), sessionId, userId }, "Failed to revoke session");
      return c.json({ error: "internal_error", message: "Failed to revoke session.", requestId }, 500) as never;
    }
  });
});

export { sessions };
