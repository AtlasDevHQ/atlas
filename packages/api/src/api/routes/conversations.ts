/**
 * Conversations REST routes — list, get, delete, star, share/unshare.
 *
 * Authenticated routes follow the same auth → rate limit → withRequestContext
 * pattern as chat.ts and query.ts. The public shared-conversation route
 * (`publicConversations`) has its own in-memory rate limiter and no auth.
 */

import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { z } from "zod";
import { HTTPException } from "hono/http-exception";
import { createLogger, withRequestContext } from "@atlas/api/lib/logger";
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
  updateNotebookState,
  forkConversation,
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
import { authPreamble } from "./auth-preamble";
import { ErrorSchema, AuthErrorSchema } from "./shared-schemas";

const log = createLogger("conversations");

// ---------------------------------------------------------------------------
// Zod schemas — exported for OpenAPI spec generation
// ---------------------------------------------------------------------------

const ForkBranchWireSchema = z.object({
  conversationId: z.string(),
  forkPointCellId: z.string(),
  label: z.string(),
  createdAt: z.string(),
});

const NotebookStateWireSchema = z.object({
  version: z.number().int().min(1).max(10),
  cellOrder: z.array(z.string()).optional(),
  cellProps: z.record(z.string(), z.object({ collapsed: z.boolean().optional() })).optional(),
  branches: z.array(ForkBranchWireSchema).optional(),
  forkRootId: z.string().optional(),
  forkPointCellId: z.string().optional(),
});

const ConversationSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().nullable(),
  title: z.string().nullable(),
  surface: z.enum(["web", "api", "mcp", "slack"]),
  connectionId: z.string().nullable(),
  starred: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  notebookState: NotebookStateWireSchema.nullable().optional(),
});

export const StarConversationBodySchema = z.object({
  starred: z.boolean(),
});

export const NotebookStateBodySchema = NotebookStateWireSchema;

export const ForkConversationBodySchema = z.object({
  forkPointMessageId: z.string(),
  label: z.string().optional(),
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
      return { body: { error: "internal_error", message: `Unexpected failure: ${_exhaustive}`, ...(requestId && { requestId }) }, status: 500 as const };
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

const notebookStateRoute = createRoute({
  method: "patch",
  path: "/{id}/notebook-state",
  tags: ["Conversations"],
  summary: "Update notebook state",
  description:
    "Updates the notebook state of a conversation, including cell order, cell properties, and branch metadata.",
  request: {
    params: IdParamSchema,
    body: {
      content: { "application/json": { schema: NotebookStateBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Notebook state updated",
      content: {
        "application/json": {
          schema: z.object({ id: z.string(), notebookState: z.record(z.string(), z.unknown()) }),
        },
      },
    },
    400: {
      description: "Invalid conversation ID or notebook state body",
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

const forkConversationRoute = createRoute({
  method: "post",
  path: "/{id}/fork",
  tags: ["Conversations"],
  summary: "Fork a conversation at a specific message",
  description:
    "Creates a new conversation by forking an existing one at the specified message. " +
    "Messages up to and including the fork point are copied to the new conversation. " +
    "Branch metadata is saved to both the source and forked conversation's notebook state.",
  request: {
    params: IdParamSchema,
    body: {
      content: { "application/json": { schema: ForkConversationBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Fork created successfully",
      content: {
        "application/json": {
          schema: z.record(z.string(), z.unknown()),
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
// Router
// ---------------------------------------------------------------------------

const conversations = new OpenAPIHono({
  defaultHook: (result, c) => {
    if (!result.success) {
      const detail = result.error.issues.map((i) => i.message).join("; ");
      return c.json({ error: "invalid_request", message: detail || "Request validation failed." }, 400);
    }
  },
});

// JSON parse error handler for routes that accept request bodies
conversations.onError((err, c) => {
  if (err instanceof HTTPException && err.status === 400) {
    return c.json({ error: "invalid_request", message: "Invalid JSON body." }, 400);
  }
  throw err;
});

// ---------------------------------------------------------------------------
// GET / — list conversations
// ---------------------------------------------------------------------------

conversations.openapi(listConversationsRoute, async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  if (!hasInternalDB()) {
    return c.json({ error: "not_available", message: "Conversation history is not available (no internal database configured)." }, 404);
  }

  const preamble = await authPreamble(req, requestId);
  if ("error" in preamble) {
    // Auth/rate-limit failure — status not in route schema, use `as never`
    return c.json(preamble.error, preamble.status, preamble.headers) as never;
  }
  const { authResult } = preamble;

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    const rawLimit = parseInt(c.req.valid("query").limit ?? "20", 10);
    const rawOffset = parseInt(c.req.valid("query").offset ?? "0", 10);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 100) : 20;
    const offset = Number.isFinite(rawOffset) && rawOffset >= 0 ? rawOffset : 0;
    const starredParam = c.req.valid("query").starred;
    const starred = starredParam === "true" ? true : starredParam === "false" ? false : undefined;
    const result = await listConversations({
      userId: authResult.user?.id,
      orgId: authResult.user?.activeOrganizationId,
      starred,
      limit,
      offset,
    });
    return c.json(result, 200);
  });
});

// ---------------------------------------------------------------------------
// GET /:id — get conversation with messages
// ---------------------------------------------------------------------------

conversations.openapi(getConversationRoute, async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  if (!hasInternalDB()) {
    return c.json({ error: "not_available", message: "Conversation history is not available (no internal database configured)." }, 404);
  }

  const preamble = await authPreamble(req, requestId);
  if ("error" in preamble) {
    // Auth/rate-limit failure — status not in route schema, use `as never`
    return c.json(preamble.error, preamble.status, preamble.headers) as never;
  }
  const { authResult } = preamble;

  const { id } = c.req.valid("param");
  if (!UUID_RE.test(id)) {
    return c.json({ error: "invalid_request", message: "Invalid conversation ID format." }, 400);
  }

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    const result = await getConversation(id, authResult.user?.id);
    if (!result.ok) {
      const fail = crudFailResponse(result.reason, requestId);
      return c.json(fail.body, fail.status);
    }
    return c.json(result.data, 200);
  });
});

// ---------------------------------------------------------------------------
// PATCH /:id/star — star or unstar a conversation
// ---------------------------------------------------------------------------

conversations.openapi(starConversationRoute, async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  if (!hasInternalDB()) {
    return c.json({ error: "not_available", message: "Conversation history is not available (no internal database configured)." }, 404);
  }

  const preamble = await authPreamble(req, requestId);
  if ("error" in preamble) {
    // Auth/rate-limit failure — status not in route schema, use `as never`
    return c.json(preamble.error, preamble.status, preamble.headers) as never;
  }
  const { authResult } = preamble;

  const { id } = c.req.valid("param");
  if (!UUID_RE.test(id)) {
    return c.json({ error: "invalid_request", message: "Invalid conversation ID format." }, 400);
  }

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    const parsed = c.req.valid("json");

    const result = await starConversation(id, parsed.starred, authResult.user?.id);
    if (!result.ok) {
      const fail = crudFailResponse(result.reason, requestId);
      return c.json(fail.body, fail.status);
    }
    return c.json({ id, starred: parsed.starred }, 200);
  });
});

// ---------------------------------------------------------------------------
// PATCH /:id/notebook-state — update notebook state
// ---------------------------------------------------------------------------

conversations.openapi(notebookStateRoute, async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  if (!hasInternalDB()) {
    return c.json({ error: "not_available", message: "Conversation history is not available (no internal database configured)." }, 404);
  }

  const preamble = await authPreamble(req, requestId);
  if ("error" in preamble) {
    // Auth/rate-limit failure — status not in route schema, use `as never`
    return c.json(preamble.error, preamble.status, preamble.headers) as never;
  }
  const { authResult } = preamble;

  const { id } = c.req.valid("param");
  if (!UUID_RE.test(id)) {
    return c.json({ error: "invalid_request", message: "Invalid conversation ID format." }, 400);
  }

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    const parsed = c.req.valid("json");

    const result = await updateNotebookState(id, parsed, authResult.user?.id);
    if (!result.ok) {
      const fail = crudFailResponse(result.reason, requestId);
      return c.json(fail.body, fail.status);
    }
    return c.json({ id, notebookState: parsed }, 200);
  });
});

// ---------------------------------------------------------------------------
// POST /:id/fork — fork a conversation at a specific message
// ---------------------------------------------------------------------------

conversations.openapi(forkConversationRoute, async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  if (!hasInternalDB()) {
    return c.json({ error: "not_available", message: "Conversation history is not available (no internal database configured)." }, 404);
  }

  const preamble = await authPreamble(req, requestId);
  if ("error" in preamble) {
    // Auth/rate-limit failure — status not in route schema, use `as never`
    return c.json(preamble.error, preamble.status, preamble.headers) as never;
  }
  const { authResult } = preamble;

  const { id } = c.req.valid("param");
  if (!UUID_RE.test(id)) {
    return c.json({ error: "invalid_request", message: "Invalid conversation ID format." }, 400);
  }

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    const parsed = c.req.valid("json");

    const result = await forkConversation({
      sourceId: id,
      forkPointMessageId: parsed.forkPointMessageId,
      userId: authResult.user?.id,
      orgId: authResult.user?.activeOrganizationId,
    });
    if (!result.ok) {
      const fail = crudFailResponse(result.reason, requestId);
      return c.json(fail.body, fail.status);
    }

    // Update notebook_state on source and new conversation
    const label = parsed.label ?? `Fork from cell`;
    const branch = {
      conversationId: result.data.id,
      forkPointCellId: parsed.forkPointMessageId,
      label,
      createdAt: new Date().toISOString(),
    };

    // Read current notebook_state from source to preserve existing data
    const sourceConv = await getConversation(id, authResult.user?.id);
    if (!sourceConv.ok) {
      log.error({ requestId, conversationId: id, reason: sourceConv.reason }, "Failed to read source conversation for branch metadata");
      return c.json({
        id: result.data.id,
        messageCount: result.data.messageCount,
        branches: [branch],
        warning: "Fork created but branch metadata could not be saved to source conversation.",
      }, 200);
    }

    const existing = sourceConv.data.notebookState ?? { version: 3 };
    const existingBranches = existing.branches ?? [];

    const updatedSourceState = {
      ...existing,
      version: existing.version || 3,
      branches: [...existingBranches, branch],
    };

    const sourceRoot = existing.forkRootId;
    const forkChildState = {
      version: 3,
      forkRootId: sourceRoot ?? id,
      forkPointCellId: parsed.forkPointMessageId,
    };

    // Write both notebook_state updates in parallel
    const [sourceResult, forkResult] = await Promise.all([
      updateNotebookState(id, updatedSourceState, authResult.user?.id),
      updateNotebookState(result.data.id, forkChildState, authResult.user?.id),
    ]);

    let metadataWarning: string | undefined;
    if (!sourceResult.ok) {
      log.error({ requestId, conversationId: id, reason: sourceResult.reason }, "Failed to update source notebook_state after fork");
      metadataWarning = "Fork created but branch metadata could not be fully saved.";
    }
    if (!forkResult.ok) {
      log.error({ requestId, conversationId: result.data.id, reason: forkResult.reason }, "Failed to set fork metadata on new conversation");
      metadataWarning = "Fork created but branch metadata could not be fully saved.";
    }

    return c.json({
      id: result.data.id,
      messageCount: result.data.messageCount,
      branches: [...existingBranches, branch],
      ...(metadataWarning ? { warning: metadataWarning } : {}),
    }, 200);
  });
});

// ---------------------------------------------------------------------------
// GET /:id/share — get share status
// ---------------------------------------------------------------------------

conversations.openapi(getShareStatusRoute, async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  if (!hasInternalDB()) {
    return c.json({ error: "not_available", message: "Conversation history is not available (no internal database configured)." }, 404);
  }

  const preamble = await authPreamble(req, requestId);
  if ("error" in preamble) {
    // Auth/rate-limit failure — status not in route schema, use `as never`
    return c.json(preamble.error, preamble.status, preamble.headers) as never;
  }
  const { authResult } = preamble;

  const { id } = c.req.valid("param");
  if (!UUID_RE.test(id)) {
    return c.json({ error: "invalid_request", message: "Invalid conversation ID format." }, 400);
  }

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    const result = await getShareStatus(id, authResult.user?.id);
    if (!result.ok) {
      if (result.reason === "error") {
        log.error({ requestId, conversationId: id }, "Share status fetch failed due to DB error");
      }
      const fail = crudFailResponse(result.reason, requestId);
      return c.json(fail.body, fail.status);
    }
    if (!result.data.shared) {
      return c.json({ shared: false as const }, 200);
    }
    const baseUrl = new URL(req.url).origin;
    return c.json({
      shared: true as const,
      token: result.data.token,
      url: `${baseUrl}/shared/${result.data.token}`,
      expiresAt: result.data.expiresAt,
      shareMode: result.data.shareMode,
    }, 200);
  });
});

// ---------------------------------------------------------------------------
// POST /:id/share — generate share link
// ---------------------------------------------------------------------------

conversations.openapi(shareConversationRoute, async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  if (!hasInternalDB()) {
    return c.json({ error: "not_available", message: "Conversation history is not available (no internal database configured)." }, 404);
  }

  const preamble = await authPreamble(req, requestId);
  if ("error" in preamble) {
    // Auth/rate-limit failure — status not in route schema, use `as never`
    return c.json(preamble.error, preamble.status, preamble.headers) as never;
  }
  const { authResult } = preamble;

  const { id } = c.req.valid("param");
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
      const fail = crudFailResponse(result.reason, requestId);
      return c.json(fail.body, fail.status);
    }
    const baseUrl = new URL(req.url).origin;
    return c.json({
      token: result.data.token,
      url: `${baseUrl}/shared/${result.data.token}`,
      expiresAt: result.data.expiresAt,
      shareMode: result.data.shareMode,
    }, 200);
  });
});

// ---------------------------------------------------------------------------
// DELETE /:id/share — revoke share link
// ---------------------------------------------------------------------------

conversations.openapi(unshareConversationRoute, async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  if (!hasInternalDB()) {
    return c.json({ error: "not_available", message: "Conversation history is not available (no internal database configured)." }, 404);
  }

  const preamble = await authPreamble(req, requestId);
  if ("error" in preamble) {
    // Auth/rate-limit failure — status not in route schema, use `as never`
    return c.json(preamble.error, preamble.status, preamble.headers) as never;
  }
  const { authResult } = preamble;

  const { id } = c.req.valid("param");
  if (!UUID_RE.test(id)) {
    return c.json({ error: "invalid_request", message: "Invalid conversation ID format." }, 400);
  }

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    const result = await unshareConversation(id, authResult.user?.id);
    if (!result.ok) {
      const fail = crudFailResponse(result.reason, requestId);
      return c.json(fail.body, fail.status);
    }
    return c.body(null, 204);
  });
});

// ---------------------------------------------------------------------------
// DELETE /:id — delete conversation
// ---------------------------------------------------------------------------

conversations.openapi(deleteConversationRoute, async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  if (!hasInternalDB()) {
    return c.json({ error: "not_available", message: "Conversation history is not available (no internal database configured)." }, 404);
  }

  const preamble = await authPreamble(req, requestId);
  if ("error" in preamble) {
    // Auth/rate-limit failure — status not in route schema, use `as never`
    return c.json(preamble.error, preamble.status, preamble.headers) as never;
  }
  const { authResult } = preamble;

  const { id } = c.req.valid("param");
  if (!UUID_RE.test(id)) {
    return c.json({ error: "invalid_request", message: "Invalid conversation ID format." }, 400);
  }

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    const result = await deleteConversation(id, authResult.user?.id);
    if (!result.ok) {
      const fail = crudFailResponse(result.reason, requestId);
      return c.json(fail.body, fail.status);
    }
    return c.body(null, 204);
  });
});

// ---------------------------------------------------------------------------
// Public shared conversation route (no auth required)
// ---------------------------------------------------------------------------

const SHARE_TOKEN_RE = /^[A-Za-z0-9_-]{20,64}$/;

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

const publicConversations = new OpenAPIHono();

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

publicConversations.openapi(getSharedConversationRoute, async (c) => {
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
    return c.json({ error: "rate_limited", message: "Too many requests. Please wait before trying again.", requestId }, 429);
  }

  const { token } = c.req.valid("param");
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
      return c.json({ error: "internal_error", message: "Authentication check failed. Please try again.", requestId }, 500);
    }
    if (!authResult.authenticated) {
      return c.json({ error: "auth_required", message: "This shared conversation requires authentication.", requestId }, 403);
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
