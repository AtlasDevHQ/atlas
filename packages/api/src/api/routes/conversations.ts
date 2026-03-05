/**
 * Conversations REST routes — list, get, and delete conversations.
 *
 * Middleware stack follows the same auth → rate limit → withRequestContext
 * pattern as chat.ts and query.ts.
 */

import { Hono } from "hono";
import { z } from "zod";
import { createLogger, withRequestContext } from "@atlas/api/lib/logger";
import type { AuthResult } from "@atlas/api/lib/auth/types";
import {
  authenticateRequest,
  checkRateLimit,
  getClientIP,
} from "@atlas/api/lib/auth/middleware";
import { hasInternalDB } from "@atlas/api/lib/db/internal";
import {
  listConversations,
  getConversation,
  deleteConversation,
  starConversation,
  type CrudFailReason,
} from "@atlas/api/lib/conversations";

const log = createLogger("conversations");

// ---------------------------------------------------------------------------
// Zod schemas — exported for OpenAPI spec generation
// ---------------------------------------------------------------------------

export const ConversationSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().nullable(),
  title: z.string().nullable(),
  surface: z.enum(["web", "api", "mcp", "slack"]),
  connectionId: z.string().nullable(),
  starred: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const StarConversationBodySchema = z.object({
  starred: z.boolean(),
});

export const MessageSchema = z.object({
  id: z.string().uuid(),
  conversationId: z.string().uuid(),
  role: z.enum(["user", "assistant", "system", "tool"]),
  content: z.unknown(),
  createdAt: z.string().datetime(),
});

export const ConversationWithMessagesSchema = ConversationSchema.extend({
  messages: z.array(MessageSchema),
});

export const ListConversationsResponseSchema = z.object({
  conversations: z.array(ConversationSchema),
  total: z.number().int().nonnegative(),
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Map a CrudFailReason to { body, status } for JSON responses. */
function crudFailResponse(reason: CrudFailReason) {
  switch (reason) {
    case "no_db":
      return { body: { error: "not_available", message: "Conversation history is not available (no internal database configured)." }, status: 404 as const };
    case "not_found":
      return { body: { error: "not_found", message: "Conversation not found." }, status: 404 as const };
    case "error":
      return { body: { error: "internal_error", message: "A database error occurred. Please try again." }, status: 500 as const };
    default: {
      const _exhaustive: never = reason;
      return { body: { error: "internal_error", message: `Unexpected failure: ${_exhaustive}` }, status: 500 as const };
    }
  }
}

const conversations = new Hono();

// ---------------------------------------------------------------------------
// Shared auth + rate-limit preamble
// ---------------------------------------------------------------------------

async function authPreamble(req: Request, requestId: string) {
  let authResult: AuthResult;
  try {
    authResult = await authenticateRequest(req);
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err : new Error(String(err)), requestId },
      "Auth dispatch failed",
    );
    return { error: { error: "auth_error", message: "Authentication system error" }, status: 500 as const };
  }
  if (!authResult.authenticated) {
    log.warn({ requestId, status: authResult.status }, "Authentication failed");
    return { error: { error: "auth_error", message: authResult.error }, status: authResult.status as 401 | 403 | 500 };
  }

  const ip = getClientIP(req);
  const rateLimitKey = authResult.user?.id ?? (ip ? `ip:${ip}` : "anon");
  const rateCheck = checkRateLimit(rateLimitKey);
  if (!rateCheck.allowed) {
    const retryAfterSeconds = Math.ceil((rateCheck.retryAfterMs ?? 60000) / 1000);
    return {
      error: { error: "rate_limited", message: "Too many requests. Please wait before trying again.", retryAfterSeconds },
      status: 429 as const,
      headers: { "Retry-After": String(retryAfterSeconds) },
    };
  }

  return { authResult };
}

// ---------------------------------------------------------------------------
// GET / — list conversations
// ---------------------------------------------------------------------------

conversations.get("/", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  if (!hasInternalDB()) {
    return c.json({ error: "not_available", message: "Conversation history is not available (no internal database configured)." }, 404);
  }

  const preamble = await authPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: preamble.headers });
  }
  const { authResult } = preamble;

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    const rawLimit = parseInt(c.req.query("limit") ?? "20", 10);
    const rawOffset = parseInt(c.req.query("offset") ?? "0", 10);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 100) : 20;
    const offset = Number.isFinite(rawOffset) && rawOffset >= 0 ? rawOffset : 0;
    const starredParam = c.req.query("starred");
    const starred = starredParam === "true" ? true : starredParam === "false" ? false : undefined;
    const result = await listConversations({
      userId: authResult.user?.id,
      starred,
      limit,
      offset,
    });
    return c.json(result);
  });
});

// ---------------------------------------------------------------------------
// GET /:id — get conversation with messages
// ---------------------------------------------------------------------------

conversations.get("/:id", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  if (!hasInternalDB()) {
    return c.json({ error: "not_available", message: "Conversation history is not available (no internal database configured)." }, 404);
  }

  const preamble = await authPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: preamble.headers });
  }
  const { authResult } = preamble;

  const id = c.req.param("id");
  if (!UUID_RE.test(id)) {
    return c.json({ error: "invalid_request", message: "Invalid conversation ID format." }, 400);
  }

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    const result = await getConversation(id, authResult.user?.id);
    if (!result.ok) {
      const fail = crudFailResponse(result.reason);
      return c.json(fail.body, fail.status);
    }
    return c.json(result.data);
  });
});

// ---------------------------------------------------------------------------
// PATCH /:id/star — star or unstar a conversation
// ---------------------------------------------------------------------------

conversations.patch("/:id/star", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  if (!hasInternalDB()) {
    return c.json({ error: "not_available", message: "Conversation history is not available (no internal database configured)." }, 404);
  }

  const preamble = await authPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: preamble.headers });
  }
  const { authResult } = preamble;

  const id = c.req.param("id");
  if (!UUID_RE.test(id)) {
    return c.json({ error: "invalid_request", message: "Invalid conversation ID format." }, 400);
  }

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    let body: unknown;
    try {
      body = await req.json();
    } catch (err) {
      log.debug({ err: err instanceof Error ? err.message : String(err) }, "Invalid JSON body in PATCH star");
      return c.json({ error: "invalid_request", message: "Invalid JSON body." }, 400);
    }

    const parsed = StarConversationBodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "invalid_request", message: "Body must contain { starred: boolean }." }, 400);
    }

    const result = await starConversation(id, parsed.data.starred, authResult.user?.id);
    if (!result.ok) {
      const fail = crudFailResponse(result.reason);
      return c.json(fail.body, fail.status);
    }
    return c.json({ id, starred: parsed.data.starred });
  });
});

// ---------------------------------------------------------------------------
// DELETE /:id — delete conversation
// ---------------------------------------------------------------------------

conversations.delete("/:id", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  if (!hasInternalDB()) {
    return c.json({ error: "not_available", message: "Conversation history is not available (no internal database configured)." }, 404);
  }

  const preamble = await authPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: preamble.headers });
  }
  const { authResult } = preamble;

  const id = c.req.param("id");
  if (!UUID_RE.test(id)) {
    return c.json({ error: "invalid_request", message: "Invalid conversation ID format." }, 400);
  }

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    const result = await deleteConversation(id, authResult.user?.id);
    if (!result.ok) {
      const fail = crudFailResponse(result.reason);
      return c.json(fail.body, fail.status);
    }
    return c.body(null, 204);
  });
});

export { conversations };
