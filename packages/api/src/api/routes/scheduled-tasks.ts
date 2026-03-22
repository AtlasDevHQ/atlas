/**
 * Scheduled tasks REST routes — CRUD + trigger + run history.
 *
 * Gated behind ATLAS_SCHEDULER_ENABLED=true (conditional mount in index.ts).
 * Follows the same auth → rate limit → withRequestContext pattern as conversations.ts.
 */

import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { createLogger, withRequestContext } from "@atlas/api/lib/logger";
import { hasInternalDB } from "@atlas/api/lib/db/internal";
import {
  createScheduledTask,
  getScheduledTask,
  listScheduledTasks,
  updateScheduledTask,
  deleteScheduledTask,
  listTaskRuns,
  listAllRuns,
  validateCronExpression,
  type CrudFailReason,
} from "@atlas/api/lib/scheduled-tasks";
import { DELIVERY_CHANNELS, RUN_STATUSES, type RunStatus } from "@atlas/api/lib/scheduled-task-types";
import { ACTION_APPROVAL_MODES } from "@atlas/api/lib/action-types";
import { authPreamble } from "./auth-preamble";
import { ErrorSchema } from "./shared-schemas";

const log = createLogger("scheduled-tasks-routes");

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const RecipientSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("email"), address: z.string().email() }),
  z.object({ type: z.literal("slack"), channel: z.string().min(1), teamId: z.string().optional() }),
  z.object({ type: z.literal("webhook"), url: z.string().url(), headers: z.record(z.string(), z.string()).optional() }),
]);

const CreateScheduledTaskSchema = z.object({
  name: z.string().min(1).max(200),
  question: z.string().min(1).max(2000),
  cronExpression: z.string().min(1),
  deliveryChannel: z.enum(DELIVERY_CHANNELS).default("webhook"),
  recipients: z.array(RecipientSchema).default([]),
  connectionId: z.string().nullable().optional(),
  approvalMode: z.enum(ACTION_APPROVAL_MODES).default("auto"),
});

const UpdateScheduledTaskSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  question: z.string().min(1).max(2000).optional(),
  cronExpression: z.string().min(1).optional(),
  deliveryChannel: z.enum(DELIVERY_CHANNELS).optional(),
  recipients: z.array(RecipientSchema).optional(),
  connectionId: z.string().nullable().optional(),
  approvalMode: z.enum(ACTION_APPROVAL_MODES).optional(),
  enabled: z.boolean().optional(),
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;


function crudFailResponse(reason: CrudFailReason, requestId?: string) {
  switch (reason) {
    case "no_db":
      return { body: { error: "not_available", message: "Scheduled tasks require an internal database." }, status: 404 as const };
    case "not_found":
      return { body: { error: "not_found", message: "Scheduled task not found." }, status: 404 as const };
    case "error":
      return { body: { error: "internal_error", message: "A database error occurred. Please try again.", ...(requestId && { requestId }) }, status: 500 as const };
    default: {
      const _exhaustive: never = reason;
      return { body: { error: "internal_error", message: `Unexpected failure: ${_exhaustive}`, ...(requestId && { requestId }) }, status: 500 as const };
    }
  }
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const listTasksRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Scheduled Tasks"],
  summary: "List scheduled tasks",
  description:
    "Returns scheduled tasks owned by the authenticated user. Requires ATLAS_SCHEDULER_ENABLED=true and an internal database.",
  request: {
    query: z.object({
      limit: z.string().optional().openapi({
        param: { name: "limit", in: "query" },
        description: "Maximum number of items to return (1-100, default 20).",
      }),
      offset: z.string().optional().openapi({
        param: { name: "offset", in: "query" },
        description: "Number of items to skip (default 0).",
      }),
      enabled: z.string().optional().openapi({
        param: { name: "enabled", in: "query" },
        description: "Filter by enabled status.",
      }),
    }),
  },
  responses: {
    200: {
      description: "Paginated list of scheduled tasks",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    403: { description: "Forbidden — insufficient permissions", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    404: { description: "Scheduled tasks not available", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const createTaskRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Scheduled Tasks"],
  summary: "Create a scheduled task",
  description: "Creates a recurring query task with a cron schedule and delivery channel.",
  request: {
    body: {
      content: { "application/json": { schema: CreateScheduledTaskSchema } },
      required: true,
    },
  },
  responses: {
    201: { description: "Scheduled task created", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    400: { description: "Invalid request body or cron expression", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    403: { description: "Forbidden — insufficient permissions", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    404: { description: "Feature not available", content: { "application/json": { schema: ErrorSchema } } },
    422: { description: "Validation error", content: { "application/json": { schema: ErrorSchema.extend({ details: z.array(z.unknown()).optional() }) } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const tickRoute = createRoute({
  method: "post",
  path: "/tick",
  tags: ["Scheduled Tasks"],
  summary: "Trigger scheduler tick",
  description:
    "Serverless scheduler tick endpoint for Vercel Cron or external cron services. " +
    "Checks for due tasks and executes them. Requires CRON_SECRET or ATLAS_SCHEDULER_SECRET.",
  responses: {
    200: { description: "Tick completed", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    401: { description: "Invalid or missing cron secret", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Feature not available (no internal database configured)", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Tick execution failed", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const listAllRunsRoute = createRoute({
  method: "get",
  path: "/runs",
  tags: ["Scheduled Tasks"],
  summary: "List all task runs",
  description: "Returns cross-task run history with filtering by task, status, and date range.",
  request: {
    query: z.object({
      limit: z.string().optional().openapi({ param: { name: "limit", in: "query" }, description: "Maximum number of runs (1-100, default 20)." }),
      offset: z.string().optional().openapi({ param: { name: "offset", in: "query" }, description: "Number of items to skip (default 0)." }),
      task_id: z.string().optional().openapi({ param: { name: "task_id", in: "query" }, description: "Filter by task ID." }),
      status: z.string().optional().openapi({ param: { name: "status", in: "query" }, description: "Filter by run status." }),
      date_from: z.string().optional().openapi({ param: { name: "date_from", in: "query" }, description: "Filter from date (YYYY-MM-DD)." }),
      date_to: z.string().optional().openapi({ param: { name: "date_to", in: "query" }, description: "Filter to date (YYYY-MM-DD)." }),
    }),
  },
  responses: {
    200: { description: "List of task runs", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    401: { description: "Authentication required", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    403: { description: "Forbidden — insufficient permissions", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    404: { description: "Not available", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const getTaskRoute = createRoute({
  method: "get",
  path: "/{id}",
  tags: ["Scheduled Tasks"],
  summary: "Get scheduled task",
  description: "Returns a scheduled task with its 10 most recent runs.",
  request: {
    params: z.object({
      id: z.string().openapi({ param: { name: "id", in: "path" }, example: "00000000-0000-0000-0000-000000000000" }),
    }),
  },
  responses: {
    200: { description: "Scheduled task with recent runs", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    400: { description: "Invalid task ID format", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    403: { description: "Forbidden — insufficient permissions", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    404: { description: "Task not found", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const updateTaskRoute = createRoute({
  method: "put",
  path: "/{id}",
  tags: ["Scheduled Tasks"],
  summary: "Update a scheduled task",
  description: "Updates a scheduled task. All fields are optional.",
  request: {
    params: z.object({
      id: z.string().openapi({ param: { name: "id", in: "path" }, example: "00000000-0000-0000-0000-000000000000" }),
    }),
    body: {
      content: { "application/json": { schema: UpdateScheduledTaskSchema } },
      required: true,
    },
  },
  responses: {
    200: { description: "Updated scheduled task", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    400: { description: "Invalid request body or cron expression", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    403: { description: "Forbidden — insufficient permissions", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    404: { description: "Task not found", content: { "application/json": { schema: ErrorSchema } } },
    422: { description: "Validation error", content: { "application/json": { schema: ErrorSchema.extend({ details: z.array(z.unknown()).optional() }) } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const deleteTaskRoute = createRoute({
  method: "delete",
  path: "/{id}",
  tags: ["Scheduled Tasks"],
  summary: "Delete a scheduled task",
  description: "Soft-deletes (disables) a scheduled task.",
  request: {
    params: z.object({
      id: z.string().openapi({ param: { name: "id", in: "path" }, example: "00000000-0000-0000-0000-000000000000" }),
    }),
  },
  responses: {
    204: { description: "Task deleted successfully" },
    400: { description: "Invalid task ID format", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    403: { description: "Forbidden — insufficient permissions", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    404: { description: "Task not found", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const triggerTaskRoute = createRoute({
  method: "post",
  path: "/{id}/run",
  tags: ["Scheduled Tasks"],
  summary: "Trigger immediate execution",
  description: "Triggers an immediate execution of a scheduled task.",
  request: {
    params: z.object({
      id: z.string().openapi({ param: { name: "id", in: "path" }, example: "00000000-0000-0000-0000-000000000000" }),
    }),
  },
  responses: {
    200: {
      description: "Task triggered",
      content: {
        "application/json": {
          schema: z.object({ message: z.string(), taskId: z.string() }),
        },
      },
    },
    400: { description: "Invalid task ID format", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    403: { description: "Forbidden — insufficient permissions", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    404: { description: "Task not found", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const previewTaskRoute = createRoute({
  method: "post",
  path: "/{id}/preview",
  tags: ["Scheduled Tasks"],
  summary: "Preview delivery format",
  description: "Dry-run delivery format with mock data.",
  request: {
    params: z.object({
      id: z.string().openapi({ param: { name: "id", in: "path" }, example: "00000000-0000-0000-0000-000000000000" }),
    }),
  },
  responses: {
    200: { description: "Delivery preview", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    400: { description: "Invalid task ID format", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    403: { description: "Forbidden — insufficient permissions", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    404: { description: "Task not found", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const listTaskRunsRoute = createRoute({
  method: "get",
  path: "/{id}/runs",
  tags: ["Scheduled Tasks"],
  summary: "List task runs",
  description: "Returns past execution runs for a scheduled task.",
  request: {
    params: z.object({
      id: z.string().openapi({ param: { name: "id", in: "path" }, example: "00000000-0000-0000-0000-000000000000" }),
    }),
    query: z.object({
      limit: z.string().optional().openapi({
        param: { name: "limit", in: "query" },
        description: "Maximum number of runs to return (1-100, default 20).",
      }),
    }),
  },
  responses: {
    200: {
      description: "List of task runs",
      content: {
        "application/json": {
          schema: z.object({ runs: z.array(z.record(z.string(), z.unknown())) }),
        },
      },
    },
    400: { description: "Invalid task ID format", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    403: { description: "Forbidden — insufficient permissions", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    404: { description: "Task not found", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const scheduledTasks = new OpenAPIHono();

// Normalize JSON parse errors. Only catch SyntaxError (malformed JSON); let
// other 400s (e.g. Zod query/path param validation) propagate with their message.
scheduledTasks.onError((err, c) => {
  if (err instanceof HTTPException && err.status === 400) {
    if (err.cause instanceof SyntaxError) {
      log.warn("Malformed JSON body in request");
      return c.json({ error: "invalid_request", message: "Invalid JSON body." }, 400);
    }
    return c.json({ error: "invalid_request", message: err.message || "Bad request." }, 400);
  }
  throw err;
});

// ---------------------------------------------------------------------------
// GET / — list scheduled tasks
// ---------------------------------------------------------------------------

scheduledTasks.openapi(listTasksRoute, async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  if (!hasInternalDB()) {
    return c.json({ error: "not_available", message: "Scheduled tasks require an internal database.", requestId }, 404);
  }

  const preamble = await authPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, preamble.status, preamble.headers) as never;
  }
  const { authResult } = preamble;

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    const rawLimit = parseInt(c.req.query("limit") ?? "20", 10);
    const rawOffset = parseInt(c.req.query("offset") ?? "0", 10);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 100) : 20;
    const offset = Number.isFinite(rawOffset) && rawOffset >= 0 ? rawOffset : 0;
    const enabledParam = c.req.query("enabled");
    const enabled = enabledParam === "true" ? true : enabledParam === "false" ? false : undefined;

    const result = await listScheduledTasks({
      ownerId: authResult.user?.id,
      enabled,
      limit,
      offset,
    });
    return c.json(result, 200);
  });
});

// ---------------------------------------------------------------------------
// POST / — create scheduled task
// ---------------------------------------------------------------------------

scheduledTasks.openapi(
  createTaskRoute,
  async (c) => {
    const req = c.req.raw;
    const requestId = crypto.randomUUID();

    if (!hasInternalDB()) {
      return c.json({ error: "not_available", message: "Scheduled tasks require an internal database.", requestId }, 404);
    }

    const preamble = await authPreamble(req, requestId);
    if ("error" in preamble) {
      return c.json(preamble.error, preamble.status, preamble.headers) as never;
    }
    const { authResult } = preamble;

    return withRequestContext({ requestId, user: authResult.user }, async () => {
      const parsed = c.req.valid("json");

      // Validate cron expression
      const cronCheck = validateCronExpression(parsed.cronExpression);
      if (!cronCheck.valid) {
        return c.json({ error: "invalid_request", message: `Invalid cron expression: ${cronCheck.error}` }, 400);
      }

      const result = await createScheduledTask({
        ownerId: authResult.user?.id ?? "anonymous",
        name: parsed.name,
        question: parsed.question,
        cronExpression: parsed.cronExpression,
        deliveryChannel: parsed.deliveryChannel,
        recipients: parsed.recipients,
        connectionId: parsed.connectionId ?? null,
        approvalMode: parsed.approvalMode,
      });

      if (!result.ok) {
        const fail = crudFailResponse(result.reason, requestId);
        return c.json(fail.body, fail.status);
      }

      return c.json(result.data, 201);
    });
  },
  (result, c) => {
    if (!result.success) {
      return c.json(
        { error: "validation_error", message: "Invalid request body.", details: result.error.issues },
        422,
      );
    }
  },
);

// ---------------------------------------------------------------------------
// POST /tick — serverless scheduler tick (Vercel Cron)
// ---------------------------------------------------------------------------

scheduledTasks.openapi(tickRoute, async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  if (!hasInternalDB()) {
    return c.json({ error: "not_available", message: "Scheduled tasks require an internal database.", requestId }, 404);
  }

  // Auth: check CRON_SECRET (Vercel-native) or ATLAS_SCHEDULER_SECRET (generic)
  const secret = process.env.CRON_SECRET ?? process.env.ATLAS_SCHEDULER_SECRET;
  const { getConfig } = await import("@atlas/api/lib/config");
  const config = getConfig();

  if (secret) {
    const authHeader = req.headers.get("authorization");
    if (authHeader !== `Bearer ${secret}`) {
      return c.json({ error: "unauthorized", message: "Invalid or missing cron secret.", requestId }, 401);
    }
  } else if (config?.scheduler?.backend === "vercel") {
    return c.json(
      { error: "misconfigured", message: "Vercel backend requires CRON_SECRET or ATLAS_SCHEDULER_SECRET to be set.", requestId },
      500,
    );
  } else if (process.env.NODE_ENV === "production") {
    return c.json(
      { error: "misconfigured", message: "CRON_SECRET or ATLAS_SCHEDULER_SECRET must be set in production.", requestId },
      500,
    );
  } else {
    log.warn("POST /tick called without secret — allowing because NODE_ENV is not 'production'");
  }

  try {
    const { runTick } = await import("@atlas/api/lib/scheduler/engine");
    const result = await runTick();
    if (result.error) {
      return c.json({ error: "tick_failed", message: result.error, requestId }, 500);
    }
    return c.json(result, 200);
  } catch (err) {
    log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId }, "Tick execution failed");
    return c.json({ error: "internal_error", message: "Tick execution failed.", requestId }, 500);
  }
});

// ---------------------------------------------------------------------------
// GET /runs — cross-task run history
// ---------------------------------------------------------------------------

scheduledTasks.openapi(listAllRunsRoute, async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  if (!hasInternalDB()) {
    return c.json({ error: "not_available", message: "Scheduled tasks require an internal database.", requestId }, 404);
  }

  const preamble = await authPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, preamble.status, preamble.headers) as never;
  }
  const { authResult } = preamble;

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    const rawLimit = parseInt(c.req.query("limit") ?? "20", 10);
    const rawOffset = parseInt(c.req.query("offset") ?? "0", 10);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 100) : 20;
    const offset = Number.isFinite(rawOffset) && rawOffset >= 0 ? rawOffset : 0;

    const taskIdParam = c.req.query("task_id") || undefined;
    const taskId = taskIdParam && UUID_RE.test(taskIdParam) ? taskIdParam : undefined;
    const statusParam = c.req.query("status");
    const status = statusParam && (RUN_STATUSES as readonly string[]).includes(statusParam)
      ? (statusParam as RunStatus)
      : undefined;
    const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
    const dateFromParam = c.req.query("date_from") || undefined;
    const dateToParam = c.req.query("date_to") || undefined;
    const dateFrom = dateFromParam && ISO_DATE_RE.test(dateFromParam) ? dateFromParam : undefined;
    const dateTo = dateToParam && ISO_DATE_RE.test(dateToParam) ? dateToParam : undefined;

    const result = await listAllRuns({ taskId, status, dateFrom, dateTo, limit, offset });
    return c.json(result, 200);
  });
});

// ---------------------------------------------------------------------------
// GET /:id — get scheduled task with recent runs
// ---------------------------------------------------------------------------

scheduledTasks.openapi(getTaskRoute, async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  if (!hasInternalDB()) {
    return c.json({ error: "not_available", message: "Scheduled tasks require an internal database.", requestId }, 404);
  }

  const preamble = await authPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, preamble.status, preamble.headers) as never;
  }
  const { authResult } = preamble;

  const { id } = c.req.valid("param");
  if (!UUID_RE.test(id)) {
    return c.json({ error: "invalid_request", message: "Invalid task ID format." }, 400);
  }

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    const result = await getScheduledTask(id, authResult.user?.id);
    if (!result.ok) {
      const fail = crudFailResponse(result.reason, requestId);
      return c.json(fail.body, fail.status);
    }

    const runs = await listTaskRuns(id, { limit: 10 });
    return c.json({ ...result.data, recentRuns: runs }, 200);
  });
});

// ---------------------------------------------------------------------------
// PUT /:id — update scheduled task
// ---------------------------------------------------------------------------

scheduledTasks.openapi(
  updateTaskRoute,
  async (c) => {
    const req = c.req.raw;
    const requestId = crypto.randomUUID();

    if (!hasInternalDB()) {
      return c.json({ error: "not_available", message: "Scheduled tasks require an internal database.", requestId }, 404);
    }

    const preamble = await authPreamble(req, requestId);
    if ("error" in preamble) {
      return c.json(preamble.error, preamble.status, preamble.headers) as never;
    }
    const { authResult } = preamble;

    const { id } = c.req.valid("param");
    if (!UUID_RE.test(id)) {
      return c.json({ error: "invalid_request", message: "Invalid task ID format." }, 400);
    }

    return withRequestContext({ requestId, user: authResult.user }, async () => {
      const parsed = c.req.valid("json");

      // Validate cron if provided
      if (parsed.cronExpression) {
        const cronCheck = validateCronExpression(parsed.cronExpression);
        if (!cronCheck.valid) {
          return c.json({ error: "invalid_request", message: `Invalid cron expression: ${cronCheck.error}` }, 400);
        }
      }

      const result = await updateScheduledTask(id, authResult.user?.id ?? "anonymous", parsed);
      if (!result.ok) {
        const fail = crudFailResponse(result.reason, requestId);
        return c.json(fail.body, fail.status);
      }

      // Fetch updated task to return
      const updated = await getScheduledTask(id, authResult.user?.id);
      if (!updated.ok) {
        return c.json({ ok: true }, 200);
      }
      return c.json(updated.data, 200);
    });
  },
  (result, c) => {
    if (!result.success) {
      return c.json(
        { error: "validation_error", message: "Invalid request body.", details: result.error.issues },
        422,
      );
    }
  },
);

// ---------------------------------------------------------------------------
// DELETE /:id — soft delete (disable)
// ---------------------------------------------------------------------------

scheduledTasks.openapi(deleteTaskRoute, async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  if (!hasInternalDB()) {
    return c.json({ error: "not_available", message: "Scheduled tasks require an internal database.", requestId }, 404);
  }

  const preamble = await authPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, preamble.status, preamble.headers) as never;
  }
  const { authResult } = preamble;

  const { id } = c.req.valid("param");
  if (!UUID_RE.test(id)) {
    return c.json({ error: "invalid_request", message: "Invalid task ID format." }, 400);
  }

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    const result = await deleteScheduledTask(id, authResult.user?.id);
    if (!result.ok) {
      const fail = crudFailResponse(result.reason, requestId);
      return c.json(fail.body, fail.status);
    }
    return c.body(null, 204);
  });
});

// ---------------------------------------------------------------------------
// POST /:id/run — trigger immediate execution
// ---------------------------------------------------------------------------

scheduledTasks.openapi(triggerTaskRoute, async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  if (!hasInternalDB()) {
    return c.json({ error: "not_available", message: "Scheduled tasks require an internal database.", requestId }, 404);
  }

  const preamble = await authPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, preamble.status, preamble.headers) as never;
  }
  const { authResult } = preamble;

  const { id } = c.req.valid("param");
  if (!UUID_RE.test(id)) {
    return c.json({ error: "invalid_request", message: "Invalid task ID format." }, 400);
  }

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    const task = await getScheduledTask(id, authResult.user?.id);
    if (!task.ok) {
      const fail = crudFailResponse(task.reason, requestId);
      return c.json(fail.body, fail.status);
    }

    try {
      const { triggerTask } = await import("@atlas/api/lib/scheduler/engine");
      await triggerTask(id);
      return c.json({ message: "Task triggered successfully.", taskId: id }, 200);
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err), taskId: id }, "Trigger failed");
      return c.json({ error: "internal_error", message: "Failed to trigger task execution.", requestId }, 500);
    }
  });
});

// ---------------------------------------------------------------------------
// POST /:id/preview — dry-run delivery format with mock data
// ---------------------------------------------------------------------------

scheduledTasks.openapi(previewTaskRoute, async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  if (!hasInternalDB()) {
    return c.json({ error: "not_available", message: "Scheduled tasks require an internal database.", requestId }, 404);
  }

  const preamble = await authPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, preamble.status, preamble.headers) as never;
  }
  const { authResult } = preamble;

  const { id } = c.req.valid("param");
  if (!UUID_RE.test(id)) {
    return c.json({ error: "invalid_request", message: "Invalid task ID format." }, 400);
  }

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    const task = await getScheduledTask(id, authResult.user?.id);
    if (!task.ok) {
      const fail = crudFailResponse(task.reason, requestId);
      return c.json(fail.body, fail.status);
    }

    try {
      const { generateDeliveryPreview } = await import("@atlas/api/lib/scheduler/preview");
      const preview = generateDeliveryPreview(task.data);
      return c.json(preview, 200);
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err), taskId: id }, "Preview generation failed");
      return c.json({ error: "internal_error", message: "Failed to generate delivery preview.", requestId }, 500);
    }
  });
});

// ---------------------------------------------------------------------------
// GET /:id/runs — list past runs
// ---------------------------------------------------------------------------

scheduledTasks.openapi(listTaskRunsRoute, async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  if (!hasInternalDB()) {
    return c.json({ error: "not_available", message: "Scheduled tasks require an internal database.", requestId }, 404);
  }

  const preamble = await authPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, preamble.status, preamble.headers) as never;
  }
  const { authResult } = preamble;

  const { id } = c.req.valid("param");
  if (!UUID_RE.test(id)) {
    return c.json({ error: "invalid_request", message: "Invalid task ID format." }, 400);
  }

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    // Verify task ownership
    const task = await getScheduledTask(id, authResult.user?.id);
    if (!task.ok) {
      const fail = crudFailResponse(task.reason, requestId);
      return c.json(fail.body, fail.status);
    }

    const rawLimit = parseInt(c.req.query("limit") ?? "20", 10);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 100) : 20;
    const runs = await listTaskRuns(id, { limit });
    return c.json({ runs }, 200);
  });
});

export { scheduledTasks };
