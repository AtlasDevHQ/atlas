/**
 * Action approval REST routes — list, get, approve, deny, rollback.
 *
 * Middleware stack follows the same auth → rate limit → withRequestContext
 * pattern as conversations.ts.
 */

import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { withErrorHandler } from "@atlas/api/lib/routes/error-handler";
import { validationHook } from "./validation-hook";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { createLogger } from "@atlas/api/lib/logger";
import { hasInternalDB } from "@atlas/api/lib/db/internal";
import {
  getAction,
  approveAction,
  denyAction,
  rollbackAction,
  listPendingActions,
  getActionExecutor,
  getActionConfig,
} from "@atlas/api/lib/tools/actions/handler";
import { ACTION_STATUSES, type ActionStatus } from "@atlas/api/lib/action-types";
import { canApprove } from "@atlas/api/lib/auth/permissions";
import { ErrorSchema, parsePagination } from "./shared-schemas";
import { standardAuth, requestContext, type AuthEnv } from "./middleware";

const log = createLogger("actions");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const listActionsRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Actions"],
  summary: "List actions",
  description:
    "Returns actions filtered by status. Requires ATLAS_ACTIONS_ENABLED=true and an internal database.",
  request: {
    query: z.object({
      status: z.string().optional().openapi({
        param: { name: "status", in: "query" },
        description: "Filter by action status (default: pending).",
        example: "pending",
      }),
      limit: z.string().optional().openapi({
        param: { name: "limit", in: "query" },
        description: "Maximum number of actions to return (1-100, default 50).",
        example: "50",
      }),
    }),
  },
  responses: {
    200: {
      description: "List of actions",
      content: {
        "application/json": {
          schema: z.object({ actions: z.array(z.record(z.string(), z.unknown())) }),
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
      description: "Actions not available (no internal database or feature disabled)",
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

const getActionRoute = createRoute({
  method: "get",
  path: "/{id}",
  tags: ["Actions"],
  summary: "Get action by ID",
  description: "Returns a single action. Only returns actions requested by the authenticated user.",
  request: {
    params: z.object({
      id: z.string().openapi({ param: { name: "id", in: "path" }, example: "00000000-0000-0000-0000-000000000000" }),
    }),
  },
  responses: {
    200: {
      description: "Action details",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    400: {
      description: "Invalid action ID format",
      content: { "application/json": { schema: ErrorSchema } },
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
      description: "Action not found",
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

const approveActionRoute = createRoute({
  method: "post",
  path: "/{id}/approve",
  tags: ["Actions"],
  summary: "Approve a pending action",
  description:
    "Approves a pending action and triggers execution. Returns the updated action with results. " +
    "For admin-only approval mode, the requester cannot approve their own action (separation of duties).",
  request: {
    params: z.object({
      id: z.string().openapi({ param: { name: "id", in: "path" }, example: "00000000-0000-0000-0000-000000000000" }),
    }),
  },
  responses: {
    200: {
      description: "Action approved and execution result",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    400: {
      description: "Invalid action ID format",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    403: {
      description: "Forbidden — insufficient permissions",
      content: { "application/json": { schema: ErrorSchema } },
    },
    404: {
      description: "Action not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
    409: {
      description: "Action has already been resolved",
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

const denyActionRoute = createRoute({
  method: "post",
  path: "/{id}/deny",
  tags: ["Actions"],
  summary: "Deny a pending action",
  description:
    "Denies a pending action. Optionally provide a reason in the request body. " +
    "For admin-only approval mode, the requester cannot deny their own action.",
  request: {
    params: z.object({
      id: z.string().openapi({ param: { name: "id", in: "path" }, example: "00000000-0000-0000-0000-000000000000" }),
    }),
    body: {
      content: {
        "application/json": {
          schema: z.object({ reason: z.string().optional() }),
        },
      },
      required: false,
    },
  },
  responses: {
    200: {
      description: "Action denied",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    400: {
      description: "Invalid action ID or request body",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    403: {
      description: "Forbidden — insufficient permissions",
      content: { "application/json": { schema: ErrorSchema } },
    },
    404: {
      description: "Action not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
    409: {
      description: "Action has already been resolved",
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

const rollbackActionRoute = createRoute({
  method: "post",
  path: "/{id}/rollback",
  tags: ["Actions"],
  summary: "Rollback an executed action",
  description:
    "Rolls back an executed action using stored rollback information. Requires the same approval permissions as the original action.",
  request: {
    params: z.object({
      id: z.string().openapi({ param: { name: "id", in: "path" }, example: "00000000-0000-0000-0000-000000000000" }),
    }),
  },
  responses: {
    200: {
      description: "Action rolled back",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    400: {
      description: "Invalid action ID format",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    403: {
      description: "Forbidden — insufficient permissions",
      content: { "application/json": { schema: ErrorSchema } },
    },
    404: {
      description: "Action not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
    409: {
      description: "Action cannot be rolled back",
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

const actions = new OpenAPIHono<AuthEnv>({ defaultHook: validationHook });

actions.use(standardAuth);
actions.use(requestContext);

// Normalize JSON parse errors. Only catch SyntaxError (malformed JSON); let
// other 400s (e.g. Zod query/path param validation) propagate with their message.
actions.onError((err, c) => {
  if (err instanceof HTTPException) {
    if (err.res) return err.res;
    if (err.status === 400) {
      if (err.cause instanceof SyntaxError) {
        log.warn("Malformed JSON body in request");
        return c.json({ error: "invalid_request", message: "Invalid JSON body." }, 400);
      }
      return c.json({ error: "invalid_request", message: err.message || "Bad request." }, 400);
    }
  }
  throw err;
});

// ---------------------------------------------------------------------------
// GET / — list actions (default: pending)
// ---------------------------------------------------------------------------

actions.openapi(listActionsRoute, withErrorHandler("list actions", async (c) => {
  const requestId = c.get("requestId");
  const authResult = c.get("authResult");

  if (!hasInternalDB()) {
    return c.json({ error: "not_available", message: "Action tracking is not available (no internal database configured).", requestId }, 404);
  }

  const rawStatus = c.req.query("status") ?? "pending";
  const status: ActionStatus | undefined = (ACTION_STATUSES as readonly string[]).includes(rawStatus)
    ? (rawStatus as ActionStatus)
    : undefined;
  const { limit } = parsePagination(c, { limit: 50, maxLimit: 100 });

  const result = await listPendingActions({
    status,
    userId: authResult.user?.id,
    limit,
  });
  return c.json({ actions: result }, 200);
}));

// ---------------------------------------------------------------------------
// GET /:id — get single action
// ---------------------------------------------------------------------------

actions.openapi(getActionRoute, withErrorHandler("retrieve action", async (c) => {
  const requestId = c.get("requestId");
  const authResult = c.get("authResult");

  if (!hasInternalDB()) {
    return c.json({ error: "not_available", message: "Action tracking is not available (no internal database configured).", requestId }, 404);
  }

  const { id } = c.req.valid("param");
  if (!UUID_RE.test(id)) {
    return c.json({ error: "invalid_request", message: "Invalid action ID format." }, 400);
  }

  const action = await getAction(id);
  if (!action || action.requested_by !== authResult.user?.id) {
    return c.json({ error: "not_found", message: "Action not found." }, 404);
  }
  return c.json(action, 200);
}));

// ---------------------------------------------------------------------------
// POST /:id/approve — approve a pending action
// ---------------------------------------------------------------------------

actions.openapi(approveActionRoute, withErrorHandler("approve action", async (c) => {
  const requestId = c.get("requestId");
  const authResult = c.get("authResult");

  if (!hasInternalDB()) {
    return c.json({ error: "not_available", message: "Action tracking is not available (no internal database configured).", requestId }, 404);
  }

  const { id } = c.req.valid("param");
  if (!UUID_RE.test(id)) {
    return c.json({ error: "invalid_request", message: "Invalid action ID format." }, 400);
  }

  const approverId = authResult.user?.id ?? "anonymous";

  // Look up action and executor
  const action = await getAction(id);
  if (!action) {
    return c.json({ error: "not_found", message: "Action not found." }, 404);
  }

  const cfg = getActionConfig(action.action_type);

  if (!canApprove(authResult.user, cfg.approval, cfg.requiredRole)) {
    return c.json({ error: "forbidden", message: "Insufficient role to approve this action.", requestId }, 403);
  }

  // Enforce admin-only separation of duties: requester cannot approve their own admin-only action
  if (cfg.approval === "admin-only" && authResult.user?.id === action.requested_by) {
    return c.json({ error: "forbidden", message: "admin-only actions cannot be approved by the requester", requestId }, 403);
  }

  const executor = getActionExecutor(id);

  const result = await approveAction(id, approverId, executor);
  if (!result) {
    return c.json({ error: "conflict", message: "Action has already been resolved." }, 409);
  }
  return c.json(result, 200);
}));

// ---------------------------------------------------------------------------
// POST /:id/deny — deny a pending action
// ---------------------------------------------------------------------------

actions.openapi(
  denyActionRoute,
  withErrorHandler("deny action", async (c) => {
    const requestId = c.get("requestId");
    const authResult = c.get("authResult");

    if (!hasInternalDB()) {
      return c.json({ error: "not_available", message: "Action tracking is not available (no internal database configured).", requestId }, 404);
    }

    const { id } = c.req.valid("param");
    if (!UUID_RE.test(id)) {
      return c.json({ error: "invalid_request", message: "Invalid action ID format." }, 400);
    }

    const denierId = authResult.user?.id ?? "anonymous";

    // Look up action for permission enforcement
    const action = await getAction(id);
    if (!action) {
      return c.json({ error: "not_found", message: "Action not found." }, 404);
    }

    const cfg = getActionConfig(action.action_type);

    // Deny requires the same minimum role as approve — consistent permission model for all action operations.
    if (!canApprove(authResult.user, cfg.approval, cfg.requiredRole)) {
      return c.json({ error: "forbidden", message: "Insufficient role to deny this action.", requestId }, 403);
    }

    // Enforce admin-only separation of duties: requester cannot deny their own admin-only action
    if (cfg.approval === "admin-only" && authResult.user?.id === action.requested_by) {
      return c.json({ error: "forbidden", message: "admin-only actions cannot be denied by the requester", requestId }, 403);
    }

    // Body is optional — extract reason if provided
    let reason: string | undefined;
    const contentType = c.req.header("content-type") ?? "";
    if (contentType.includes("application/json")) {
      try {
        const body = await c.req.json();
        if (body && typeof body.reason === "string") {
          reason = body.reason;
        }
      } catch (err) {
        log.warn({ err: err instanceof Error ? err.message : String(err), requestId }, "Failed to parse deny action request body");
        return c.json({ error: "invalid_request", message: "Invalid JSON body." }, 400);
      }
    }

    const result = await denyAction(id, denierId, reason);
    if (!result) {
      return c.json({ error: "conflict", message: "Action has already been resolved." }, 409);
    }
    return c.json(result, 200);
  }),
  (result, c) => {
    if (!result.success) {
      return c.json(
        { error: "validation_error", message: "Invalid request body.", details: result.error.issues },
        400,
      );
    }
  },
);

// ---------------------------------------------------------------------------
// POST /:id/rollback — rollback an executed action
// ---------------------------------------------------------------------------

actions.openapi(rollbackActionRoute, withErrorHandler("rollback action", async (c) => {
  const requestId = c.get("requestId");
  const authResult = c.get("authResult");

  if (!hasInternalDB()) {
    return c.json({ error: "not_available", message: "Action tracking is not available (no internal database configured).", requestId }, 404);
  }

  const { id } = c.req.valid("param");
  if (!UUID_RE.test(id)) {
    return c.json({ error: "invalid_request", message: "Invalid action ID format." }, 400);
  }

  const action = await getAction(id);
  if (!action) {
    return c.json({ error: "not_found", message: "Action not found." }, 404);
  }

  const cfg = getActionConfig(action.action_type);

  if (!canApprove(authResult.user, cfg.approval, cfg.requiredRole)) {
    return c.json({ error: "forbidden", message: "Insufficient role to rollback this action.", requestId }, 403);
  }

  if (!action.rollback_info) {
    return c.json({ error: "conflict", message: "Action does not have rollback information." }, 409);
  }

  const rollbackerId = authResult.user?.id ?? "anonymous";
  const result = await rollbackAction(id, rollbackerId);
  if (!result) {
    return c.json({ error: "conflict", message: "Action cannot be rolled back. It may have been rolled back already or changed state." }, 409);
  }
  if (result.error) {
    return c.json({ ...result, warning: "Rollback status updated but the rollback handler reported an error. The side-effect may not have been reversed." }, 200);
  }
  return c.json(result, 200);
}));

export { actions };
