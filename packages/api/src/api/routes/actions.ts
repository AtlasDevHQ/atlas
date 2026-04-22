/**
 * Action approval REST routes — list, get, approve, deny, rollback.
 *
 * Middleware stack follows the same auth → rate limit → withRequestContext
 * pattern as conversations.ts.
 */

import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { Effect } from "effect";
import { runEffect } from "@atlas/api/lib/effect/hono";
import { RequestContext, AuthContext } from "@atlas/api/lib/effect/services";
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
import {
  bulkApproveActions,
  bulkDenyActions,
  BULK_ACTIONS_MAX,
} from "@atlas/api/lib/tools/actions/bulk";
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

const BulkActionsResponseSchema = z.object({
  updated: z.array(z.string()),
  notFound: z.array(z.string()),
  forbidden: z.array(z.string()),
  errors: z.array(z.object({ id: z.string(), error: z.string() })),
});

const BULK_REASON_MAX = 1000;

const BulkActionsRequestSchema = z.object({
  ids: z
    .array(z.string().uuid("Each id must be a UUID"))
    .min(1, "ids must be a non-empty array")
    .max(BULK_ACTIONS_MAX, `Maximum ${BULK_ACTIONS_MAX} ids per bulk operation`),
  action: z.enum(["approve", "deny"]),
  reason: z.string().max(BULK_REASON_MAX).optional(),
});

const bulkActionsRoute = createRoute({
  method: "post",
  path: "/bulk",
  tags: ["Actions"],
  summary: "Bulk approve or deny pending actions",
  description:
    "Resolves many pending actions in a single request. Each id is pre-classified as eligible, " +
    "not found, or forbidden; eligible ids are then approved or denied. Rows that race a " +
    "conflicting resolution land in `errors`. Maximum 100 ids per request. Permission rules match " +
    "the single-action endpoints: admin-only actions cannot be resolved by the requester.",
  request: {
    body: {
      content: {
        "application/json": {
          schema: BulkActionsRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: "Bulk result — each id appears in exactly one bucket",
      content: { "application/json": { schema: BulkActionsResponseSchema } },
    },
    400: {
      description: "Invalid request body",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Authentication required",
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

actions.openapi(listActionsRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;
    const { user } = yield* AuthContext;

    if (!hasInternalDB()) {
      return c.json({ error: "not_available", message: "Action tracking is not available (no internal database configured).", requestId }, 404);
    }

    const rawStatus = c.req.query("status") ?? "pending";
    const status: ActionStatus | undefined = (ACTION_STATUSES as readonly string[]).includes(rawStatus)
      ? (rawStatus as ActionStatus)
      : undefined;
    const { limit } = parsePagination(c, { limit: 50, maxLimit: 100 });

    const items = yield* Effect.promise(() => listPendingActions({
      status,
      userId: user?.id,
      orgId: user?.activeOrganizationId,
      limit,
    }));
    return c.json({ actions: items }, 200);
  }), { label: "list actions" });
});

// ---------------------------------------------------------------------------
// GET /:id — get single action
// ---------------------------------------------------------------------------

actions.openapi(getActionRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;
    const { user } = yield* AuthContext;

    if (!hasInternalDB()) {
      return c.json({ error: "not_available", message: "Action tracking is not available (no internal database configured).", requestId }, 404);
    }

    const { id } = c.req.valid("param");
    if (!UUID_RE.test(id)) {
      return c.json({ error: "invalid_request", message: "Invalid action ID format." }, 400);
    }

    const action = yield* Effect.promise(() => getAction(id, user?.activeOrganizationId));
    if (!action || action.requested_by !== user?.id) {
      return c.json({ error: "not_found", message: "Action not found." }, 404);
    }
    return c.json(action, 200);
  }), { label: "retrieve action" });
});

// ---------------------------------------------------------------------------
// POST /:id/approve — approve a pending action
// ---------------------------------------------------------------------------

actions.openapi(approveActionRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;
    const { user } = yield* AuthContext;

    if (!hasInternalDB()) {
      return c.json({ error: "not_available", message: "Action tracking is not available (no internal database configured).", requestId }, 404);
    }

    const { id } = c.req.valid("param");
    if (!UUID_RE.test(id)) {
      return c.json({ error: "invalid_request", message: "Invalid action ID format." }, 400);
    }

    const approverId = user?.id ?? "anonymous";
    const orgId = user?.activeOrganizationId;

    // Look up action and executor — scoped to caller's active org so cross-org
    // access surfaces as 404 rather than 403 (don't leak existence).
    const action = yield* Effect.promise(() => getAction(id, orgId));
    if (!action) {
      return c.json({ error: "not_found", message: "Action not found." }, 404);
    }

    const cfg = getActionConfig(action.action_type);

    if (!canApprove(user, cfg.approval, cfg.requiredRole)) {
      return c.json({ error: "forbidden", message: "Insufficient role to approve this action.", requestId }, 403);
    }

    // Enforce admin-only separation of duties: requester cannot approve their own admin-only action
    if (cfg.approval === "admin-only" && user?.id === action.requested_by) {
      return c.json({ error: "forbidden", message: "admin-only actions cannot be approved by the requester", requestId }, 403);
    }

    const executor = getActionExecutor(id);

    const approveResult = yield* Effect.promise(() => approveAction(id, approverId, executor, orgId));
    if (!approveResult) {
      return c.json({ error: "conflict", message: "Action has already been resolved." }, 409);
    }
    return c.json(approveResult, 200);
  }), { label: "approve action" });
});

// ---------------------------------------------------------------------------
// POST /:id/deny — deny a pending action
// ---------------------------------------------------------------------------

actions.openapi(
  denyActionRoute,
  async (c) => {
    return runEffect(c, Effect.gen(function* () {
      const { requestId } = yield* RequestContext;
      const { user } = yield* AuthContext;

      if (!hasInternalDB()) {
        return c.json({ error: "not_available", message: "Action tracking is not available (no internal database configured).", requestId }, 404);
      }

      const { id } = c.req.valid("param");
      if (!UUID_RE.test(id)) {
        return c.json({ error: "invalid_request", message: "Invalid action ID format." }, 400);
      }

      const denierId = user?.id ?? "anonymous";
      const orgId = user?.activeOrganizationId;

      // Look up action for permission enforcement — org-scoped (cross-org → 404).
      const action = yield* Effect.promise(() => getAction(id, orgId));
      if (!action) {
        return c.json({ error: "not_found", message: "Action not found." }, 404);
      }

      const cfg = getActionConfig(action.action_type);

      // Deny requires the same minimum role as approve — consistent permission model for all action operations.
      if (!canApprove(user, cfg.approval, cfg.requiredRole)) {
        return c.json({ error: "forbidden", message: "Insufficient role to deny this action.", requestId }, 403);
      }

      // Enforce admin-only separation of duties: requester cannot deny their own admin-only action
      if (cfg.approval === "admin-only" && user?.id === action.requested_by) {
        return c.json({ error: "forbidden", message: "admin-only actions cannot be denied by the requester", requestId }, 403);
      }

      // Body is optional — extract reason if provided
      let reason: string | undefined;
      const contentType = c.req.header("content-type") ?? "";
      if (contentType.includes("application/json")) {
        const bodyResult = yield* Effect.tryPromise({
          try: () => c.req.json(),
          catch: (err) => err instanceof Error ? err : new Error(String(err)),
        }).pipe(Effect.either);
        if (bodyResult._tag === "Left") {
          const err = bodyResult.left;
          log.warn({ err: err.message, requestId }, "Failed to parse deny action request body");
          return c.json({ error: "invalid_request", message: "Invalid JSON body." }, 400);
        }
        const body = bodyResult.right;
        if (body && typeof body.reason === "string") {
          reason = body.reason;
        }
      }

      const denyResult = yield* Effect.promise(() => denyAction(id, denierId, reason, orgId));
      if (!denyResult) {
        return c.json({ error: "conflict", message: "Action has already been resolved." }, 409);
      }
      return c.json(denyResult, 200);
    }), { label: "deny action" });
  },
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
// POST /bulk — mounted before /:id/* so Hono matches the literal segment.
// ---------------------------------------------------------------------------

actions.openapi(
  bulkActionsRoute,
  async (c) => {
    return runEffect(c, Effect.gen(function* () {
      const { requestId } = yield* RequestContext;
      const { user } = yield* AuthContext;

      if (!hasInternalDB()) {
        return c.json(
          {
            error: "not_available",
            message: "Action tracking is not available (no internal database configured).",
            requestId,
          },
          404,
        );
      }

      const { ids, action, reason } = c.req.valid("json");
      const orgId = user?.activeOrganizationId ?? null;

      const result = action === "approve"
        ? yield* Effect.tryPromise({
            try: () => bulkApproveActions({ ids, user, orgId, requestId }),
            catch: (err) => (err instanceof Error ? err : new Error(String(err))),
          })
        : yield* Effect.tryPromise({
            try: () => bulkDenyActions({ ids, user, orgId, reason, requestId }),
            catch: (err) => (err instanceof Error ? err : new Error(String(err))),
          });

      return c.json(result, 200);
    }), { label: "bulk actions" });
  },
  (result, c) => {
    if (!result.success) {
      return c.json(
        {
          error: "validation_error",
          message: "Invalid request body.",
          details: result.error.issues,
        },
        400,
      );
    }
  },
);

// ---------------------------------------------------------------------------
// POST /:id/rollback — rollback an executed action
// ---------------------------------------------------------------------------

actions.openapi(rollbackActionRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;
    const { user } = yield* AuthContext;

    if (!hasInternalDB()) {
      return c.json({ error: "not_available", message: "Action tracking is not available (no internal database configured).", requestId }, 404);
    }

    const { id } = c.req.valid("param");
    if (!UUID_RE.test(id)) {
      return c.json({ error: "invalid_request", message: "Invalid action ID format." }, 400);
    }

    const orgId = user?.activeOrganizationId;
    const action = yield* Effect.promise(() => getAction(id, orgId));
    if (!action) {
      return c.json({ error: "not_found", message: "Action not found." }, 404);
    }

    const cfg = getActionConfig(action.action_type);

    if (!canApprove(user, cfg.approval, cfg.requiredRole)) {
      return c.json({ error: "forbidden", message: "Insufficient role to rollback this action.", requestId }, 403);
    }

    if (!action.rollback_info) {
      return c.json({ error: "conflict", message: "Action does not have rollback information." }, 409);
    }

    const rollbackerId = user?.id ?? "anonymous";
    const rollbackResult = yield* Effect.promise(() => rollbackAction(id, rollbackerId, orgId));
    if (!rollbackResult) {
      return c.json({ error: "conflict", message: "Action cannot be rolled back. It may have been rolled back already or changed state." }, 409);
    }
    if (rollbackResult.error) {
      return c.json({ ...rollbackResult, warning: "Rollback status updated but the rollback handler reported an error. The side-effect may not have been reversed." }, 200);
    }
    return c.json(rollbackResult, 200);
  }), { label: "rollback action" });
});

export { actions };
