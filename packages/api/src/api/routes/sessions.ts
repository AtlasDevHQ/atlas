/**
 * User self-service session routes.
 *
 * Mounted at /api/v1/sessions. Authenticated users can list and revoke
 * their own sessions (not other users'). Admin session management is
 * handled separately in the admin routes.
 */

import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { Effect } from "effect";
import { runEffect } from "@atlas/api/lib/effect/hono";
import { RequestContext, AuthContext } from "@atlas/api/lib/effect/services";
import { validationHook } from "./validation-hook";
import { z } from "zod";
import { createLogger } from "@atlas/api/lib/logger";
import { hasInternalDB, queryEffect } from "@atlas/api/lib/db/internal";
import { detectAuthMode } from "@atlas/api/lib/auth/detect";
import { ErrorSchema } from "./shared-schemas";
import { standardAuth, requestContext, type AuthEnv } from "./middleware";

const log = createLogger("sessions-routes");

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------


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

const sessions = new OpenAPIHono<AuthEnv>({ defaultHook: validationHook });

sessions.use(standardAuth);
sessions.use(requestContext);

// GET / — list the current user's sessions
sessions.openapi(listSessionsRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;
    const { user } = yield* AuthContext;

    if (!hasInternalDB() || detectAuthMode() !== "managed" || !user) {
      return c.json({ error: "not_available", message: "Session management requires managed auth mode.", requestId }, 404);
    }

    const userId = user.id;

    const rows = yield* queryEffect<{
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
  }), { label: "list sessions" });
});

// DELETE /:id — revoke one of the current user's sessions
sessions.openapi(revokeSessionRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;
    const { user } = yield* AuthContext;

    if (!hasInternalDB() || detectAuthMode() !== "managed" || !user) {
      return c.json({ error: "not_available", message: "Session management requires managed auth mode.", requestId }, 404);
    }

    const userId = user.id;
    const { id: sessionId } = c.req.valid("param");

    // Atomic delete scoped to the current user — returns empty if
    // the session doesn't exist or belongs to another user.
    const deleted = yield* queryEffect<{ id: string }>(
      `DELETE FROM session WHERE id = $1 AND "userId" = $2 RETURNING id`,
      [sessionId, userId],
    );
    if (deleted.length === 0) {
      // Distinguish "not found" from "wrong user" for a clear error message
      const exists = yield* queryEffect<{ userId: string }>(
        `SELECT "userId" FROM session WHERE id = $1`,
        [sessionId],
      );
      if (exists.length === 0) {
        return c.json({ error: "not_found", message: "Session not found." }, 404);
      }
      return c.json({ error: "forbidden", message: "Cannot revoke another user's session.", requestId }, 403);
    }

    log.info({ requestId, sessionId, userId }, "User revoked own session");
    return c.json({ success: true }, 200);
  }), { label: "revoke session" });
});

export { sessions };
