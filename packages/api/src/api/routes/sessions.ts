/**
 * User self-service session routes.
 *
 * Mounted at /api/v1/sessions. Authenticated users can list and revoke
 * their own sessions (not other users'). Admin session management is
 * handled separately in the admin routes.
 */

import { Hono } from "hono";
import { createLogger, withRequestContext } from "@atlas/api/lib/logger";
import {
  authenticateRequest,
  checkRateLimit,
  getClientIP,
} from "@atlas/api/lib/auth/middleware";
import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import { detectAuthMode } from "@atlas/api/lib/auth/detect";

const log = createLogger("sessions-routes");

const sessions = new Hono();

// GET / — list the current user's sessions
sessions.get("/", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  let authResult;
  try {
    authResult = await authenticateRequest(req);
  } catch (err) {
    log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId }, "Auth failed");
    return c.json({ error: "auth_error", message: "Authentication system error" }, 500);
  }
  if (!authResult.authenticated) {
    return c.json({ error: "auth_error", message: authResult.error }, authResult.status);
  }

  // Rate limiting
  const ip = getClientIP(req);
  const rateLimitKey = authResult.user?.id ?? (ip ? `ip:${ip}` : "anon");
  const rateCheck = checkRateLimit(rateLimitKey);
  if (!rateCheck.allowed) {
    const retryAfterSeconds = Math.ceil((rateCheck.retryAfterMs ?? 60000) / 1000);
    return c.json(
      { error: "rate_limited", message: "Too many requests.", retryAfterSeconds },
      { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
    );
  }

  const user = authResult.user;
  if (!hasInternalDB() || detectAuthMode() !== "managed" || !user) {
    return c.json({ error: "not_available", message: "Session management requires managed auth mode." }, 404);
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
      });
    } catch (err) {
      log.error({ err: err instanceof Error ? err : new Error(String(err)), userId }, "Failed to list user sessions");
      return c.json({ error: "internal_error", message: "Failed to list sessions." }, 500);
    }
  });
});

// DELETE /:id — revoke one of the current user's sessions
sessions.delete("/:id", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  let authResult;
  try {
    authResult = await authenticateRequest(req);
  } catch (err) {
    log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId }, "Auth failed");
    return c.json({ error: "auth_error", message: "Authentication system error" }, 500);
  }
  if (!authResult.authenticated) {
    return c.json({ error: "auth_error", message: authResult.error }, authResult.status);
  }

  const ip = getClientIP(req);
  const rateLimitKey = authResult.user?.id ?? (ip ? `ip:${ip}` : "anon");
  const rateCheck = checkRateLimit(rateLimitKey);
  if (!rateCheck.allowed) {
    const retryAfterSeconds = Math.ceil((rateCheck.retryAfterMs ?? 60000) / 1000);
    return c.json(
      { error: "rate_limited", message: "Too many requests.", retryAfterSeconds },
      { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
    );
  }

  const user = authResult.user;
  if (!hasInternalDB() || detectAuthMode() !== "managed" || !user) {
    return c.json({ error: "not_available", message: "Session management requires managed auth mode." }, 404);
  }

  return withRequestContext({ requestId, user }, async () => {
    const userId = user.id;
    const sessionId = c.req.param("id");

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
          return c.json({ error: "not_found", message: "Session not found." }, 404);
        }
        return c.json({ error: "forbidden", message: "Cannot revoke another user's session." }, 403);
      }

      log.info({ requestId, sessionId, userId }, "User revoked own session");
      return c.json({ success: true });
    } catch (err) {
      log.error({ err: err instanceof Error ? err : new Error(String(err)), sessionId, userId }, "Failed to revoke session");
      return c.json({ error: "internal_error", message: "Failed to revoke session." }, 500);
    }
  });
});

export { sessions };
