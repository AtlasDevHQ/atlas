/**
 * Conversations REST routes — list, get, delete, star, share/unshare.
 *
 * Authenticated routes use `standardAuth` + `requestContext` middleware from
 * `./middleware`. The public shared-conversation route (`publicConversations`)
 * has its own in-memory rate limiter and no auth.
 */

import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { Effect } from "effect";
import { runEffect } from "@atlas/api/lib/effect/hono";
import { RequestContext, AuthContext } from "@atlas/api/lib/effect/services";
import { z } from "zod";
import { HTTPException } from "hono/http-exception";
import { createLogger, hashShareToken } from "@atlas/api/lib/logger";
import { validationHook } from "./validation-hook";
import type { AuthResult } from "@atlas/api/lib/auth/types";
import {
  authenticateRequest,
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
import { ANSWER_STYLE_NAMES } from "@atlas/api/lib/answer-styles";
import { readSessionMemorySlots, resetSessionMemory } from "@atlas/api/lib/durable-state";
import { SessionMemorySlotSchema } from "@useatlas/schemas";
import type { ShareExpiryKey } from "@useatlas/types/share";
import { SHARE_MODES, SHARE_EXPIRY_OPTIONS } from "@useatlas/types/share";
import { standardAuth, requestContext, type AuthEnv } from "./middleware";
import { ErrorSchema, AuthErrorSchema, parsePagination } from "./shared-schemas";
import {
  createPublicRateLimiter,
  warnIfTrustProxyMissingForPublicShare,
  PUBLIC_RATE_LIMIT_CONSTANTS,
} from "@atlas/api/lib/public-rate-limit";

const log = createLogger("conversations");

// ---------------------------------------------------------------------------
// Zod schemas — exported for OpenAPI spec generation
// ---------------------------------------------------------------------------

const ConversationSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().nullable(),
  title: z.string().nullable(),
  surface: z.enum(["web", "api", "mcp", "slack"]),
  connectionId: z.string().nullable(),
  /**
   * Connection group (content scope) the conversation resolves against —
   * decoupled from `connectionId` so per-turn execution overrides do not
   * shift the entity / dashboard overlay. Nullable for legacy
   * conversations created before the multi-environment slice (#2345).
   */
  connectionGroupId: z.string().nullable(),
  /**
   * Three-state Auto/Pin/All routing picker state (#2518). `null` on a
   * persisted row is read as `"pin"` by the runtime. Optional + nullable so
   * pre-#2518 rows and external SDK consumers need not supply it. Mirrors the
   * `Conversation` wire type — runtime already serializes this via
   * `rowToConversation`; the spec was missing it (drift, #3071).
   */
  routingMode: z.enum(["auto", "pin", "all"]).nullable().optional(),
  /**
   * Per-conversation REST datasource exclude-set (#3066). Excluded
   * `install_id`s the agent must NOT query for this conversation. Empty
   * (`[]`, the column default) = every in-scope REST datasource is
   * queryable. Optional (NOT nullable) — the column is `NOT NULL DEFAULT
   * '{}'` and `rowToConversation` always serializes a `string[]` (or `[]`),
   * so the response is never null (unlike the genuinely-nullable
   * `routingMode`). Mirrors the `Conversation` wire type.
   */
  restExcludedDatasourceIds: z.array(z.string()).optional(),
  /**
   * Per-conversation REST-only focus (#3067). The single `install_id` the
   * conversation targets exclusively (suspending `executeSQL`), or `null`
   * when not focused. Genuinely nullable (the column is plain nullable
   * `text`); optional so pre-#3067 rows / SDK consumers need not supply it.
   * Mirrors the `Conversation` wire type.
   */
  restFocusDatasourceId: z.string().nullable().optional(),
  /**
   * Per-conversation Group reach (#3895, ADR-0022). `null` = All sources
   * (every visible Connection group reachable); a `connectionGroupId` value =
   * Focus → that group (hard/exclusive — only it is reachable). The cross-group
   * axis ABOVE member routing (`routingMode`); independent of the REST-scope
   * fields. Genuinely nullable; optional so pre-#3895 rows / SDK consumers need
   * not supply it. Mirrors the `Conversation` wire type — `GET /conversations/:id`
   * carries it so the picker restores the persisted reach on open.
   */
  groupReach: z.string().nullable().optional(),
  /**
   * Per-conversation answer style (#4302, PRD #4292) — the editorial voice
   * of the agent's answers (lib/answer-styles.ts registry). `null` = no
   * explicit choice: prompt assembly resolves the live default — the
   * workspace default (`ATLAS_DEFAULT_ANSWER_STYLE`, #4303) when set, else
   * the surface default (`analyst` for web). Genuinely nullable; optional
   * so pre-#4302 rows / SDK consumers need not supply it. Mirrors the
   * `Conversation` wire type — `GET /conversations/:id` carries it so the
   * header picker restores the persisted style on reopen. `conversational`
   * is a legal persisted value (accepted from API/SDK callers), though the
   * web picker doesn't offer it and chat platforms apply that voice
   * per-turn, leaving their rows NULL.
   */
  answerStyle: z.enum(ANSWER_STYLE_NAMES).nullable().optional(),
  starred: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const StarConversationBodySchema = z.object({
  starred: z.boolean(),
});

const MessageSchema = z.object({
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

const ShareConversationBodySchema = z.object({
  expiresIn: z.enum(EXPIRY_KEYS).optional(),
  shareMode: z.enum(SHARE_MODES).optional(),
}).optional();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Map a CrudFailReason to { body, status } for JSON responses. */
function crudFailResponse(reason: CrudFailReason, requestId?: string) {
  switch (reason) {
    case "no_db":
      return { body: { error: "not_available", message: "Conversation history is not available (no internal database configured)." }, status: 404 as const };
    case "not_found":
      return { body: { error: "not_found", message: "Conversation not found." }, status: 404 as const };
    case "error":
      return { body: { error: "internal_error", message: "A database error occurred. Please try again.", ...(requestId && { requestId }) }, status: 500 as const };
    default: {
      const _exhaustive: never = reason;
      return { body: { error: "internal_error", message: `Unexpected failure: ${String(_exhaustive)}`, ...(requestId && { requestId }) }, status: 500 as const };
    }
  }
}

// ---------------------------------------------------------------------------
// Shared path param schemas
// ---------------------------------------------------------------------------

const IdParamSchema = z.object({
  id: z.string().openapi({ param: { name: "id", in: "path" }, example: "550e8400-e29b-41d4-a716-446655440000" }),
});

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const listConversationsRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Conversations"],
  summary: "List conversations",
  description:
    "Returns a paginated list of conversations for the authenticated user. Requires an internal database (DATABASE_URL).",
  request: {
    query: z.object({
      limit: z.string().optional().openapi({ param: { name: "limit", in: "query" }, example: "20" }),
      offset: z.string().optional().openapi({ param: { name: "offset", in: "query" }, example: "0" }),
      starred: z.string().optional().openapi({ param: { name: "starred", in: "query" }, example: "true" }),
    }),
  },
  responses: {
    200: {
      description: "Paginated list of conversations",
      content: { "application/json": { schema: ListConversationsResponseSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    403: {
      description: "Forbidden — insufficient permissions",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    404: {
      description: "Not available (no internal database configured)",
      content: { "application/json": { schema: ErrorSchema } },
    },
    429: {
      description: "Rate limit exceeded",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const getConversationRoute = createRoute({
  method: "get",
  path: "/{id}",
  tags: ["Conversations"],
  summary: "Get conversation with messages",
  description:
    "Returns a single conversation with all its messages. Enforces ownership when auth is enabled.",
  request: {
    params: IdParamSchema,
  },
  responses: {
    200: {
      description: "Conversation with messages",
      content: { "application/json": { schema: ConversationWithMessagesSchema } },
    },
    400: {
      description: "Invalid conversation ID format",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    403: {
      description: "Forbidden — insufficient permissions",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    404: {
      description: "Conversation not found or not available",
      content: { "application/json": { schema: ErrorSchema } },
    },
    429: {
      description: "Rate limit exceeded",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const starConversationRoute = createRoute({
  method: "patch",
  path: "/{id}/star",
  tags: ["Conversations"],
  summary: "Star or unstar a conversation",
  description: "Sets the starred status of a conversation.",
  request: {
    params: IdParamSchema,
    body: {
      content: { "application/json": { schema: StarConversationBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Star status updated",
      content: {
        "application/json": {
          schema: z.object({ id: z.string(), starred: z.boolean() }),
        },
      },
    },
    400: {
      description: "Invalid conversation ID or request body",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    403: {
      description: "Forbidden — insufficient permissions",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    404: {
      description: "Conversation not found or not available",
      content: { "application/json": { schema: ErrorSchema } },
    },
    429: {
      description: "Rate limit exceeded",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const getShareStatusRoute = createRoute({
  method: "get",
  path: "/{id}/share",
  tags: ["Conversations"],
  summary: "Get conversation share status",
  description:
    "Returns whether a conversation is currently shared and its share link details.",
  request: {
    params: IdParamSchema,
  },
  responses: {
    200: {
      description: "Share status",
      content: {
        "application/json": {
          schema: z.record(z.string(), z.unknown()),
        },
      },
    },
    400: {
      description: "Invalid conversation ID format",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    403: {
      description: "Forbidden — insufficient permissions",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    404: {
      description: "Conversation not found or not available",
      content: { "application/json": { schema: ErrorSchema } },
    },
    429: {
      description: "Rate limit exceeded",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

// Body is optional and parsed manually in the handler via safeParse — not declared
// in the route schema to avoid framework-level validation on empty/missing bodies.
const shareConversationRoute = createRoute({
  method: "post",
  path: "/{id}/share",
  tags: ["Conversations"],
  summary: "Generate share link",
  description:
    "Creates a shareable link for a conversation. Optionally specify expiry duration and share mode (public or org-only).",
  request: {
    params: IdParamSchema,
  },
  responses: {
    200: {
      description: "Share link created",
      content: {
        "application/json": {
          schema: z.record(z.string(), z.unknown()),
        },
      },
    },
    400: {
      description: "Invalid conversation ID or share options",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    403: {
      description: "Forbidden — insufficient permissions",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    404: {
      description: "Conversation not found or not available",
      content: { "application/json": { schema: ErrorSchema } },
    },
    429: {
      description: "Rate limit exceeded",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const unshareConversationRoute = createRoute({
  method: "delete",
  path: "/{id}/share",
  tags: ["Conversations"],
  summary: "Revoke share link",
  description: "Revokes the share link for a conversation, making it private again.",
  request: {
    params: IdParamSchema,
  },
  responses: {
    204: {
      description: "Share link revoked",
    },
    400: {
      description: "Invalid conversation ID format",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    403: {
      description: "Forbidden — insufficient permissions",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    404: {
      description: "Conversation not found or not available",
      content: { "application/json": { schema: ErrorSchema } },
    },
    429: {
      description: "Rate limit exceeded",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const deleteConversationRoute = createRoute({
  method: "delete",
  path: "/{id}",
  tags: ["Conversations"],
  summary: "Delete a conversation",
  description:
    "Deletes a conversation and all its messages. Enforces ownership when auth is enabled.",
  request: {
    params: IdParamSchema,
  },
  responses: {
    204: {
      description: "Conversation deleted successfully",
    },
    400: {
      description: "Invalid conversation ID format",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    403: {
      description: "Forbidden — insufficient permissions",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    404: {
      description: "Conversation not found or not available",
      content: { "application/json": { schema: ErrorSchema } },
    },
    429: {
      description: "Rate limit exceeded",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

// ---------------------------------------------------------------------------
// Durable working-memory read/reset (#3758, ADR-0020) — the in-conversation
// affordance. Scoped to the caller (their own conversation). Unlike the other
// conversation routes, no-internal-DB is NOT a 404 here: the read returns an
// empty slot list and the reset is a no-op (`cleared: 0`), so the in-chat
// control degrades silently when durable memory isn't wired (acceptance: Noop =
// empty read / no-op reset, no error).
// ---------------------------------------------------------------------------

const getConversationMemoryRoute = createRoute({
  method: "get",
  path: "/{id}/memory",
  tags: ["Conversations"],
  summary: "Get a conversation's durable working memory",
  description:
    "Returns the durable working-memory slots the agent has accumulated for this conversation. Scoped to the caller. With no internal database the list is empty — never an error.",
  request: { params: IdParamSchema },
  responses: {
    200: {
      description: "Working-memory slots",
      content: { "application/json": { schema: z.object({ slots: z.array(SessionMemorySlotSchema) }) } },
    },
    400: { description: "Invalid conversation ID format", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const resetConversationMemoryRoute = createRoute({
  method: "delete",
  path: "/{id}/memory",
  tags: ["Conversations"],
  summary: "Reset a conversation's durable working memory",
  description:
    "Clears the durable working-memory slots for this conversation so a sticky remembered fact can be corrected without leaving the chat. Idempotent and scoped to the caller. With no internal database this is a no-op (cleared: 0) — never an error.",
  request: { params: IdParamSchema },
  responses: {
    200: {
      description: "Slots cleared (count)",
      content: { "application/json": { schema: z.object({ cleared: z.number().int().nonnegative() }) } },
    },
    400: { description: "Invalid conversation ID format", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const conversations = new OpenAPIHono<AuthEnv>({
  defaultHook: validationHook,
});

conversations.use(standardAuth);
conversations.use(requestContext);

// JSON parse error handler — only for truly malformed request bodies
// (e.g. unparseable JSON). Zod validation failures are handled by the
// defaultHook above which uses the `target` field for accurate messages.
conversations.onError((err, c) => {
  if (err instanceof HTTPException) {
    if (err.res) return err.res;
    if (err.status === 400) return c.json({ error: "invalid_request", message: "Invalid JSON body." }, 400);
  }
  throw err;
});

// ---------------------------------------------------------------------------
// GET / — list conversations
// ---------------------------------------------------------------------------

conversations.openapi(listConversationsRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    if (!hasInternalDB()) {
      return c.json({ error: "not_available", message: "Conversation history is not available (no internal database configured)." }, 404);
    }

    const { user } = yield* AuthContext;

    const { limit, offset } = parsePagination(c, { limit: 20, maxLimit: 100 });
    const starredParam = c.req.valid("query").starred;
    const starred = starredParam === "true" ? true : starredParam === "false" ? false : undefined;
    const items = yield* Effect.promise(() => listConversations({
      userId: user?.id,
      orgId: user?.activeOrganizationId,
      starred,
      limit,
      offset,
    }));
    return c.json(items, 200);
  }), { label: "list conversations" });
});

// ---------------------------------------------------------------------------
// GET /:id — get conversation with messages
// ---------------------------------------------------------------------------

conversations.openapi(getConversationRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    if (!hasInternalDB()) {
      return c.json({ error: "not_available", message: "Conversation history is not available (no internal database configured)." }, 404);
    }

    const { requestId } = yield* RequestContext;
    const { user } = yield* AuthContext;

    const { id } = c.req.valid("param");
    if (!UUID_RE.test(id)) {
      return c.json({ error: "invalid_request", message: "Invalid conversation ID format." }, 400);
    }

    const conv = yield* Effect.promise(() => getConversation(id, user?.id, user?.activeOrganizationId));
    if (!conv.ok) {
      const fail = crudFailResponse(conv.reason, requestId);
      return c.json(fail.body, fail.status);
    }
    return c.json(conv.data, 200);
  }), { label: "get conversation" });
});

// ---------------------------------------------------------------------------
// PATCH /:id/star — star or unstar a conversation
// ---------------------------------------------------------------------------

conversations.openapi(starConversationRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    if (!hasInternalDB()) {
      return c.json({ error: "not_available", message: "Conversation history is not available (no internal database configured)." }, 404);
    }

    const { requestId } = yield* RequestContext;
    const { user } = yield* AuthContext;

    const { id } = c.req.valid("param");
    if (!UUID_RE.test(id)) {
      return c.json({ error: "invalid_request", message: "Invalid conversation ID format." }, 400);
    }

    const parsed = c.req.valid("json");

    const starResult = yield* Effect.promise(() => starConversation(id, parsed.starred, user?.id, user?.activeOrganizationId));
    if (!starResult.ok) {
      const fail = crudFailResponse(starResult.reason, requestId);
      return c.json(fail.body, fail.status);
    }
    return c.json({ id, starred: parsed.starred }, 200);
  }), { label: "star conversation" });
});

// ---------------------------------------------------------------------------
// GET /:id/share — get share status
// ---------------------------------------------------------------------------

conversations.openapi(getShareStatusRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    if (!hasInternalDB()) {
      return c.json({ error: "not_available", message: "Conversation history is not available (no internal database configured)." }, 404);
    }

    const { requestId } = yield* RequestContext;
    const { user } = yield* AuthContext;

    const { id } = c.req.valid("param");
    if (!UUID_RE.test(id)) {
      return c.json({ error: "invalid_request", message: "Invalid conversation ID format." }, 400);
    }

    const shareResult = yield* Effect.promise(() => getShareStatus(id, user?.id, user?.activeOrganizationId));
    if (!shareResult.ok) {
      if (shareResult.reason === "error") {
        log.error({ requestId, conversationId: id }, "Share status fetch failed due to DB error");
      }
      const fail = crudFailResponse(shareResult.reason, requestId);
      return c.json(fail.body, fail.status);
    }
    if (!shareResult.data.shared) {
      return c.json({ shared: false as const }, 200);
    }
    const baseUrl = new URL(c.req.raw.url).origin;
    return c.json({
      shared: true as const,
      token: shareResult.data.token,
      url: `${baseUrl}/shared/${shareResult.data.token}`,
      expiresAt: shareResult.data.expiresAt,
      shareMode: shareResult.data.shareMode,
    }, 200);
  }), { label: "get share status" });
});

// ---------------------------------------------------------------------------
// POST /:id/share — generate share link
// ---------------------------------------------------------------------------

conversations.openapi(shareConversationRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    if (!hasInternalDB()) {
      return c.json({ error: "not_available", message: "Conversation history is not available (no internal database configured)." }, 404);
    }

    const { requestId } = yield* RequestContext;
    const { user } = yield* AuthContext;

    const { id } = c.req.valid("param");
    if (!UUID_RE.test(id)) {
      return c.json({ error: "invalid_request", message: "Invalid conversation ID format." }, 400);
    }

    const bodyResult = yield* Effect.tryPromise({
      try: async () => {
        const text = await c.req.raw.text();
        return text ? JSON.parse(text) as unknown : undefined;
      },
      catch: (err) => err instanceof Error ? err : new Error(String(err)),
    }).pipe(Effect.either);
    if (bodyResult._tag === "Left") {
      log.debug({ err: bodyResult.left.message }, "Invalid JSON body in POST share");
      return c.json({ error: "invalid_request", message: "Invalid JSON body." }, 400);
    }
    const body: unknown = bodyResult.right;

    const parsed = ShareConversationBodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "invalid_request", message: "Invalid share options." }, 400);
    }

    const opts = parsed.data;
    const shareResult = yield* Effect.promise(() => shareConversation(id, user?.id, {
      orgId: user?.activeOrganizationId,
      expiresIn: opts?.expiresIn,
      shareMode: opts?.shareMode,
    }));
    if (!shareResult.ok) {
      if (shareResult.reason === "invalid_org_scope") {
        return c.json({
          error: "invalid_request",
          message: "Cannot create an org-scoped share for a conversation with no organization.",
        }, 400);
      }
      const fail = crudFailResponse(shareResult.reason, requestId);
      return c.json(fail.body, fail.status);
    }
    const baseUrl = new URL(c.req.raw.url).origin;
    return c.json({
      token: shareResult.data.token,
      url: `${baseUrl}/shared/${shareResult.data.token}`,
      expiresAt: shareResult.data.expiresAt,
      shareMode: shareResult.data.shareMode,
    }, 200);
  }), { label: "share conversation" });
});

// ---------------------------------------------------------------------------
// DELETE /:id/share — revoke share link
// ---------------------------------------------------------------------------

conversations.openapi(unshareConversationRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    if (!hasInternalDB()) {
      return c.json({ error: "not_available", message: "Conversation history is not available (no internal database configured)." }, 404);
    }

    const { requestId } = yield* RequestContext;
    const { user } = yield* AuthContext;

    const { id } = c.req.valid("param");
    if (!UUID_RE.test(id)) {
      return c.json({ error: "invalid_request", message: "Invalid conversation ID format." }, 400);
    }

    const unshareResult = yield* Effect.promise(() => unshareConversation(id, user?.id, user?.activeOrganizationId));
    if (!unshareResult.ok) {
      const fail = crudFailResponse(unshareResult.reason, requestId);
      return c.json(fail.body, fail.status);
    }
    return c.body(null, 204);
  }), { label: "unshare conversation" });
});

// ---------------------------------------------------------------------------
// DELETE /:id — delete conversation
// ---------------------------------------------------------------------------

conversations.openapi(deleteConversationRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    if (!hasInternalDB()) {
      return c.json({ error: "not_available", message: "Conversation history is not available (no internal database configured)." }, 404);
    }

    const { requestId } = yield* RequestContext;
    const { user } = yield* AuthContext;

    const { id } = c.req.valid("param");
    if (!UUID_RE.test(id)) {
      return c.json({ error: "invalid_request", message: "Invalid conversation ID format." }, 400);
    }

    const delResult = yield* Effect.promise(() => deleteConversation(id, user?.id, user?.activeOrganizationId));
    if (!delResult.ok) {
      const fail = crudFailResponse(delResult.reason, requestId);
      return c.json(fail.body, fail.status);
    }
    return c.body(null, 204);
  }), { label: "delete conversation" });
});

// ---------------------------------------------------------------------------
// GET /:id/memory — read this conversation's durable working memory
// ---------------------------------------------------------------------------

conversations.openapi(getConversationMemoryRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { user } = yield* AuthContext;
    const { id } = c.req.valid("param");
    if (!UUID_RE.test(id)) {
      return c.json({ error: "invalid_request", message: "Invalid conversation ID format." }, 400);
    }
    // Owner-scoped: the helper JOINs to `conversations` and matches the
    // caller's userId when present (+ org), so a conversation they don't own
    // returns []. (With auth off — no userId — the scope falls back to the
    // soft-delete guard, mirroring the unscoped conversations CRUD helpers.) No
    // internal DB → [] (the helper short-circuits) — empty, not an error.
    const slots = yield* Effect.promise(() =>
      readSessionMemorySlots({ conversationId: id, userId: user?.id, orgId: user?.activeOrganizationId }),
    );
    return c.json({ slots }, 200);
  }), { label: "read conversation memory" });
});

// ---------------------------------------------------------------------------
// DELETE /:id/memory — reset this conversation's durable working memory
// ---------------------------------------------------------------------------

conversations.openapi(resetConversationMemoryRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { user } = yield* AuthContext;
    const { id } = c.req.valid("param");
    if (!UUID_RE.test(id)) {
      return c.json({ error: "invalid_request", message: "Invalid conversation ID format." }, 400);
    }
    // Idempotent + owner-scoped: clears the caller's own conversation slots so a
    // sticky remembered fact can be corrected in-chat. Awaited (not the
    // fire-and-forget commit path) so the next turn loads + threads nothing. No
    // internal DB → 0 cleared, a clean no-op.
    const cleared = yield* Effect.promise(() =>
      resetSessionMemory({ conversationId: id, userId: user?.id, orgId: user?.activeOrganizationId }),
    );
    return c.json({ cleared }, 200);
  }), { label: "reset conversation memory" });
});

// ---------------------------------------------------------------------------
// Public shared conversation route (no auth required)
// ---------------------------------------------------------------------------

const SHARE_TOKEN_RE = /^[A-Za-z0-9_-]{20,64}$/;

// ---------------------------------------------------------------------------
// In-memory rate limiter for public route
// ---------------------------------------------------------------------------

const PUBLIC_RATE_MAX = 60;

const publicRateLimiter = createPublicRateLimiter({ maxRpm: PUBLIC_RATE_MAX });

/**
 * Evict expired entries to prevent unbounded growth. Called periodically
 * by the SchedulerLayer fiber in lib/effect/layers.ts.
 */
export function conversationRateSweepTick(): void {
  publicRateLimiter.cleanup();
}

/** @internal — test-only. Drop all conversation rate-limit state between tests. */
export function _resetConversationRateLimit(): void {
  publicRateLimiter.reset();
}

/** Interval for conversation rate sweep. Exported for SchedulerLayer. */
export const CONVERSATION_RATE_SWEEP_INTERVAL_MS = PUBLIC_RATE_LIMIT_CONSTANTS.WINDOW_MS;

/** Interval for share token cleanup. Exported for SchedulerLayer. */
export const SHARE_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

let shareCleanupConsecutiveFailures = 0;

/**
 * Clean up expired share tokens. Called periodically by the SchedulerLayer
 * fiber in lib/effect/layers.ts. Tracks consecutive failures and logs when
 * they reach 5.
 */
export async function shareCleanupTick(): Promise<void> {
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
    log.error({ err: err instanceof Error ? err.message : String(err), consecutiveFailures: shareCleanupConsecutiveFailures },
      "Unexpected error in share cleanup tick");
    throw err; // re-throw so Effect.catchAll in layers.ts also logs it
  }
}

// Fire once per process if ATLAS_TRUST_PROXY is unset and a public-share route
// has been exercised — surfaces the env-var miss instead of letting the
// limiter silently fall back to the anonymous bucket.
warnIfTrustProxyMissingForPublicShare();

// ---------------------------------------------------------------------------
// Public router + route definition
// ---------------------------------------------------------------------------

const getSharedConversationRoute = createRoute({
  method: "get",
  path: "/{token}",
  tags: ["Conversations"],
  summary: "View a shared conversation",
  description:
    "Returns the content of a shared conversation. No authentication required for public shares. Org-scoped shares require authentication. Rate limited per IP.",
  request: {
    params: z.object({
      token: z.string().openapi({ param: { name: "token", in: "path" }, example: "abc123def456ghi789jk" }),
    }),
  },
  responses: {
    200: {
      description: "Shared conversation content",
      content: {
        "application/json": {
          schema: z.record(z.string(), z.unknown()),
        },
      },
    },
    403: {
      description: "Org-scoped share requires authentication",
      content: { "application/json": { schema: ErrorSchema } },
    },
    404: {
      description: "Conversation not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
    410: {
      description: "Share link has expired",
      content: { "application/json": { schema: ErrorSchema } },
    },
    429: {
      description: "Rate limit exceeded",
      content: { "application/json": { schema: ErrorSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const publicConversations = new OpenAPIHono({ defaultHook: validationHook });

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
      return { body: { error: "internal_error", message: `Unexpected failure: ${String(_exhaustive)}` }, status: 500 as const };
    }
  }
}

publicConversations.openapi(getSharedConversationRoute, async (c) => {
  const requestId = crypto.randomUUID();

  if (!hasInternalDB()) {
    return c.json({ error: "not_available", message: "Sharing is not available." }, 404);
  }

  const ip = getClientIP(c.req.raw);
  if (!publicRateLimiter.check(ip)) {
    // `ip === null` means the request landed in the shared anonymous bucket —
    // surface that in logs so operators can correlate 429 spikes with a
    // missing ATLAS_TRUST_PROXY rather than per-IP traffic.
    log.warn({ requestId, ip, anonymous: ip === null }, "Public conversation rate limited");
    return c.json({ error: "rate_limited", message: "Too many requests. Please wait before trying again.", requestId }, 429);
  }

  const { token } = c.req.valid("param");
  if (!SHARE_TOKEN_RE.test(token)) {
    return c.json({ error: "not_found", message: "Conversation not found." }, 404);
  }

  const tokenHash = hashShareToken(token);
  const result = await getSharedConversation(token);
  if (!result.ok) {
    const fail = sharedConversationFailResponse(result.reason);
    if (result.reason === "error") {
      log.error({ requestId, tokenHash }, "Public conversation fetch failed due to DB error");
    }
    return c.json(fail.body, fail.status);
  }

  // Org-scoped shares require the requester to be authenticated AND a member
  // of the conversation's owning workspace. Without this membership check an
  // authenticated caller from any other org could read the share — see #1727.
  if (result.data.shareMode === "org") {
    let authResult: AuthResult;
    try {
      authResult = await authenticateRequest(c.req.raw);
    } catch (err) {
      log.error(
        { err: err instanceof Error ? err.message : String(err), requestId, tokenHash },
        "Auth check failed for org-scoped share",
      );
      return c.json({ error: "internal_error", message: "Authentication check failed. Please try again.", requestId }, 500);
    }
    if (!authResult.authenticated) {
      return c.json({ error: "auth_required", message: "This shared conversation requires authentication.", requestId }, 403);
    }
    // Verify authenticated user belongs to the conversation's org. Fail closed
    // when the conversation row has no orgId: the schema allows NULL org_id with
    // share_mode='org' (createShareLink does not stamp orgId), so a truthy-check
    // here would silently fall through and reintroduce the #1727 leak.
    if (!result.data.orgId || authResult.user?.activeOrganizationId !== result.data.orgId) {
      log.warn(
        {
          requestId,
          tokenHash,
          hasOrgId: Boolean(result.data.orgId),
          actorUserId: authResult.user?.id,
          actorOrgId: authResult.user?.activeOrganizationId,
        },
        "Org-scoped share access denied — requester is not a member of the conversation's org",
      );
      return c.json({ error: "forbidden", message: "You do not have access to this conversation.", requestId }, 403);
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
  }, 200);
});

export { conversations, publicConversations };
