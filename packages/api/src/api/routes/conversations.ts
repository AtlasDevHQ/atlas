/**
 * Conversations REST routes — list, get, delete, star, share/unshare.
 *
 * Authenticated routes follow the same auth → rate limit → withRequestContext
 * pattern as chat.ts and query.ts. The public shared-conversation route
 * (`publicConversations`) has its own in-memory rate limiter and no auth.
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
  shareConversation,
  unshareConversation,
  getShareStatus,
  getSharedConversation,
  cleanupExpiredShares,
  type CrudFailReason,
  type SharedConversationFailReason,
} from "@atlas/api/lib/conversations";
import type { ShareExpiryKey } from "@useatlas/types/share";
import { SHARE_MODES, SHARE_EXPIRY_OPTIONS } from "@useatlas/types/share";

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

const EXPIRY_KEYS = Object.keys(SHARE_EXPIRY_OPTIONS) as [ShareExpiryKey, ...ShareExpiryKey[]];

export const ShareConversationBodySchema = z.object({
  expiresIn: z.enum(EXPIRY_KEYS).optional(),
  shareMode: z.enum(SHARE_MODES).optional(),
}).optional();

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
// GET /:id/share — get share status
// ---------------------------------------------------------------------------

conversations.get("/:id/share", async (c) => {
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
    const result = await getShareStatus(id, authResult.user?.id);
    if (!result.ok) {
      if (result.reason === "error") {
        log.error({ requestId, conversationId: id }, "Share status fetch failed due to DB error");
      }
      const fail = crudFailResponse(result.reason);
      return c.json(fail.body, fail.status);
    }
    if (!result.data.shared) {
      return c.json({ shared: false as const });
    }
    const baseUrl = new URL(req.url).origin;
    return c.json({
      shared: true as const,
      token: result.data.token,
      url: `${baseUrl}/shared/${result.data.token}`,
      expiresAt: result.data.expiresAt,
      shareMode: result.data.shareMode,
    });
  });
});

// ---------------------------------------------------------------------------
// POST /:id/share — generate share link
// ---------------------------------------------------------------------------

conversations.post("/:id/share", async (c) => {
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
    let body: unknown = undefined;
    try {
      const text = await req.text();
      if (text) body = JSON.parse(text);
    } catch (err) {
      log.debug({ err: err instanceof Error ? err.message : String(err) }, "Invalid JSON body in POST share");
      return c.json({ error: "invalid_request", message: "Invalid JSON body." }, 400);
    }

    const parsed = ShareConversationBodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "invalid_request", message: "Invalid share options." }, 400);
    }

    const opts = parsed.data;
    const result = await shareConversation(id, authResult.user?.id, {
      expiresIn: opts?.expiresIn,
      shareMode: opts?.shareMode,
    });
    if (!result.ok) {
      const fail = crudFailResponse(result.reason);
      return c.json(fail.body, fail.status);
    }
    const baseUrl = new URL(req.url).origin;
    return c.json({
      token: result.data.token,
      url: `${baseUrl}/shared/${result.data.token}`,
      expiresAt: result.data.expiresAt,
      shareMode: result.data.shareMode,
    });
  });
});

// ---------------------------------------------------------------------------
// DELETE /:id/share — revoke share link
// ---------------------------------------------------------------------------

conversations.delete("/:id/share", async (c) => {
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
    const result = await unshareConversation(id, authResult.user?.id);
    if (!result.ok) {
      const fail = crudFailResponse(result.reason);
      return c.json(fail.body, fail.status);
    }
    return c.body(null, 204);
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

// ---------------------------------------------------------------------------
// Public shared conversation route (no auth required)
// ---------------------------------------------------------------------------

const SHARE_TOKEN_RE = /^[A-Za-z0-9_-]{20,64}$/;

export const ShareStatusResponseSchema = z.discriminatedUnion("shared", [
  z.object({ shared: z.literal(false) }),
  z.object({
    shared: z.literal(true),
    token: z.string(),
    url: z.string(),
    expiresAt: z.string().nullable(),
    shareMode: z.enum(SHARE_MODES),
  }),
]);

export const SharedConversationMessageSchema = z.object({
  role: z.enum(["user", "assistant", "system", "tool"]),
  content: z.unknown(),
  createdAt: z.string().datetime(),
});

export const SharedConversationResponseSchema = z.object({
  title: z.string().nullable(),
  surface: z.enum(["web", "api", "mcp", "slack"]),
  createdAt: z.string().datetime(),
  shareMode: z.enum(SHARE_MODES),
  messages: z.array(SharedConversationMessageSchema),
});

// ---------------------------------------------------------------------------
// In-memory rate limiter for public route
// ---------------------------------------------------------------------------

const PUBLIC_RATE_WINDOW_MS = 60_000;
const PUBLIC_RATE_MAX = 60;

const publicRateMap = new Map<string, { count: number; resetAt: number }>();

/** Evict expired entries to prevent unbounded growth. Runs periodically. */
function sweepPublicRateMap() {
  const now = Date.now();
  for (const [key, entry] of publicRateMap) {
    if (now > entry.resetAt) publicRateMap.delete(key);
  }
}

// Sweep every 60 seconds
const _sweepInterval = setInterval(sweepPublicRateMap, PUBLIC_RATE_WINDOW_MS);
// Don't prevent process exit
if (typeof _sweepInterval === "object" && "unref" in _sweepInterval) _sweepInterval.unref();

// Clean up expired share tokens every 60 minutes
const SHARE_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
let shareCleanupConsecutiveFailures = 0;
const _shareCleanupInterval = setInterval(async () => {
  try {
    const count = await cleanupExpiredShares();
    if (count >= 0) {
      shareCleanupConsecutiveFailures = 0;
    } else {
      shareCleanupConsecutiveFailures++;
      if (shareCleanupConsecutiveFailures >= 5) {
        log.error({ consecutiveFailures: shareCleanupConsecutiveFailures },
          "Share cleanup has failed repeatedly — expired tokens may remain accessible");
      }
    }
  } catch (err) {
    shareCleanupConsecutiveFailures++;
    log.error({ err: err instanceof Error ? err.message : String(err) },
      "Unexpected error in share cleanup interval");
  }
}, SHARE_CLEANUP_INTERVAL_MS);
if (typeof _shareCleanupInterval === "object" && "unref" in _shareCleanupInterval) _shareCleanupInterval.unref();

function checkPublicRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = publicRateMap.get(ip);
  if (!entry || now > entry.resetAt) {
    publicRateMap.set(ip, { count: 1, resetAt: now + PUBLIC_RATE_WINDOW_MS });
    return true;
  }
  entry.count++;
  return entry.count <= PUBLIC_RATE_MAX;
}

const publicConversations = new Hono();

/** Map a SharedConversationFailReason to a JSON response. */
function sharedConversationFailResponse(reason: SharedConversationFailReason) {
  switch (reason) {
    case "expired":
      return { body: { error: "expired", message: "This share link has expired." }, status: 410 as const };
    case "no_db":
      return { body: { error: "not_available", message: "Sharing is not available." }, status: 404 as const };
    case "not_found":
      return { body: { error: "not_found", message: "Conversation not found." }, status: 404 as const };
    case "error":
      return { body: { error: "internal_error", message: "A server error occurred. Please try again." }, status: 500 as const };
    default: {
      const _exhaustive: never = reason;
      return { body: { error: "internal_error", message: `Unexpected failure: ${_exhaustive}` }, status: 500 as const };
    }
  }
}

publicConversations.get("/:token", async (c) => {
  const requestId = crypto.randomUUID();

  if (!hasInternalDB()) {
    return c.json({ error: "not_available", message: "Sharing is not available." }, 404);
  }

  const ip = getClientIP(c.req.raw);
  if (!ip) {
    log.warn({ requestId }, "Public conversation request with no client IP");
  }
  const rateLimitKey = ip ?? `unknown-${requestId}`;
  if (!checkPublicRateLimit(rateLimitKey)) {
    log.warn({ requestId, ip }, "Public conversation rate limited");
    return c.json({ error: "rate_limited", message: "Too many requests. Please wait before trying again." }, 429);
  }

  const token = c.req.param("token");
  if (!SHARE_TOKEN_RE.test(token)) {
    return c.json({ error: "not_found", message: "Conversation not found." }, 404);
  }

  const result = await getSharedConversation(token);
  if (!result.ok) {
    const fail = sharedConversationFailResponse(result.reason);
    if (result.reason === "error") {
      log.error({ requestId, token }, "Public conversation fetch failed due to DB error");
    }
    return c.json(fail.body, fail.status);
  }

  // Org-scoped shares require the requester to be authenticated
  if (result.data.shareMode === "org") {
    let authResult: AuthResult;
    try {
      authResult = await authenticateRequest(c.req.raw);
    } catch (err) {
      log.error(
        { err: err instanceof Error ? err.message : String(err), requestId, token },
        "Auth check failed for org-scoped share",
      );
      return c.json({ error: "internal_error", message: "Authentication check failed. Please try again." }, 500);
    }
    if (!authResult.authenticated) {
      return c.json({ error: "auth_required", message: "This shared conversation requires authentication." }, 403);
    }
  }

  // Strip internal IDs — only expose conversation content
  const { title, surface, createdAt, messages, shareMode } = result.data;
  return c.json({
    title,
    surface,
    createdAt,
    shareMode,
    messages: messages.map((m) => ({
      role: m.role,
      content: m.content,
      createdAt: m.createdAt,
    })),
  });
});

export { conversations, publicConversations };
