/**
 * Scheduled tasks REST routes — CRUD + trigger + run history.
 *
 * Gated behind ATLAS_SCHEDULER_ENABLED=true (conditional mount in index.ts).
 * CRUD routes use `adminAuth` + `requireOrgContext` middleware (admin/owner
 * role required, org-scoped). The `/tick` endpoint uses its own cron-secret
 * auth and is registered on the outer app so it bypasses user-auth middleware.
 */

import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { Effect } from "effect";
import { runEffect } from "@atlas/api/lib/effect/hono";
import { RequestContext, AuthContext } from "@atlas/api/lib/effect/services";
import { validationHook } from "./validation-hook";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { createLogger } from "@atlas/api/lib/logger";
import { logAdminAction, ADMIN_ACTIONS } from "@atlas/api/lib/audit";
import { hasInternalDB } from "@atlas/api/lib/db/internal";
import { verifyGroupBelongsToOrg } from "@atlas/api/lib/conversations";
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
import type { TickResult } from "@atlas/api/lib/scheduler/engine";
import { isBlockedUrl } from "@atlas/api/lib/scheduler/delivery";
import { checkDeliverySenders } from "@atlas/api/lib/scheduler/sender-preflight";
import {
  DELIVERY_CHANNELS,
  RUN_STATUSES,
  type DeliveryChannel,
  type Recipient,
  type RunStatus,
} from "@atlas/api/lib/scheduled-task-types";
import { ACTION_APPROVAL_MODES } from "@atlas/api/lib/action-types";
import { type AuthEnv } from "./middleware";
import { ErrorSchema, parsePagination } from "./shared-schemas";
import { createAdminRouter, requireOrgContext } from "./admin-router";

const log = createLogger("scheduled-tasks-routes");

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const RecipientSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("email"), address: z.string().email() }),
  z.object({ type: z.literal("slack"), channel: z.string().min(1), teamId: z.string().optional() }),
  z.object({
    type: z.literal("webhook"),
    // #3340 — registration-time SSRF gate, mirroring the delivery-time
    // guardedFetch check. `isBlockedUrl` wraps the canonical
    // isSafeExternalUrl and honors the ATLAS_OPENAPI_ALLOW_INTERNAL_HOSTS
    // operator opt-out for self-hosted internal endpoints.
    url: z
      .string()
      .url()
      .refine((u) => !isBlockedUrl(u), {
        message:
          "Webhook URL must be a public HTTPS endpoint (private, loopback, link-local, and internal hosts are blocked).",
      }),
    headers: z.record(z.string(), z.string()).optional(),
  }),
]);

// #2512 — coerce empty-string `connectionGroupId` to `null` at the boundary.
// Without this the value reaches the DB INSERT and trips an FK violation
// that surfaces as a generic 500. The Zod transform lets the rest of the
// pipeline branch on "supplied a group id" vs "no group" cleanly.
const ConnectionGroupIdField = z
  .string()
  .nullable()
  .optional()
  .transform((v) => (v === "" ? null : v));

const CreateScheduledTaskSchema = z.object({
  name: z.string().min(1).max(200),
  question: z.string().min(1).max(2000),
  cronExpression: z.string().min(1),
  deliveryChannel: z.enum(DELIVERY_CHANNELS).default("webhook"),
  recipients: z.array(RecipientSchema).default([]),
  connectionGroupId: ConnectionGroupIdField,
  approvalMode: z.enum(ACTION_APPROVAL_MODES).default("auto"),
});

const UpdateScheduledTaskSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  question: z.string().min(1).max(2000).optional(),
  cronExpression: z.string().min(1).optional(),
  deliveryChannel: z.enum(DELIVERY_CHANNELS).optional(),
  recipients: z.array(RecipientSchema).optional(),
  connectionGroupId: ConnectionGroupIdField,
  approvalMode: z.enum(ACTION_APPROVAL_MODES).optional(),
  enabled: z.boolean().optional(),
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;


/**
 * Recipients the sender preflight should inspect — only those matching the
 * task's delivery channel, mirroring the filter `deliverResult` applies at
 * delivery time so a stale recipient of another channel can't produce a
 * spurious warning (#3379). Tolerates `undefined` inputs defensively: the
 * preflight is best-effort and must never turn a successful create/update
 * into a 500.
 */
function recipientsForChannel(
  recipients: Recipient[] | undefined,
  channel: DeliveryChannel | undefined,
): Recipient[] {
  if (!recipients || !channel) return [];
  return recipients.filter((r) => r.type === channel);
}

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
      return { body: { error: "internal_error", message: `Unexpected failure: ${String(_exhaustive)}`, ...(requestId && { requestId }) }, status: 500 as const };
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
    "Returns scheduled tasks for the active organization. Requires admin role, ATLAS_SCHEDULER_ENABLED=true, and an internal database.",
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
      connectionGroupId: z.string().optional().openapi({
        param: { name: "connectionGroupId", in: "query" },
        description: "Filter by connection group/environment scope.",
      }),
    }),
  },
  responses: {
    200: {
      description: "Paginated list of scheduled tasks",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
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
  description: "Creates a recurring query task with a cron schedule and delivery channel. Requires admin role.",
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
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
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
  description: "Returns cross-task run history with filtering by task, status, and date range. Requires admin role.",
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
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    404: { description: "Not available", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const getTaskRoute = createRoute({ method: "get", path: "/{id}", tags: ["Scheduled Tasks"], summary: "Get scheduled task", description: "Returns a scheduled task with its 10 most recent runs. Requires admin role.", request: { params: z.object({ id: z.string().openapi({ param: { name: "id", in: "path" }, example: "00000000-0000-0000-0000-000000000000" }) }) }, responses: { 200: { description: "Scheduled task with recent runs", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } }, 400: { description: "Invalid task ID format", content: { "application/json": { schema: ErrorSchema } } }, 401: { description: "Authentication required", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } }, 403: { description: "Forbidden — admin role required", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } }, 404: { description: "Task not found", content: { "application/json": { schema: ErrorSchema } } }, 429: { description: "Rate limit exceeded", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } }, 500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } } } });

const updateTaskRoute = createRoute({ method: "put", path: "/{id}", tags: ["Scheduled Tasks"], summary: "Update a scheduled task", description: "Updates a scheduled task. All fields are optional. `connectionGroupId` is the only field that touches the environment scope — the column is updated when present (including `null`, which clears it) and untouched when absent. No other field implicitly re-derives the environment. Requires admin role.", request: { params: z.object({ id: z.string().openapi({ param: { name: "id", in: "path" }, example: "00000000-0000-0000-0000-000000000000" }) }), body: { content: { "application/json": { schema: UpdateScheduledTaskSchema } }, required: true } }, responses: { 200: { description: "Updated scheduled task", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } }, 400: { description: "Invalid request body or cron expression", content: { "application/json": { schema: ErrorSchema } } }, 401: { description: "Authentication required", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } }, 403: { description: "Forbidden — admin role required", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } }, 404: { description: "Task not found", content: { "application/json": { schema: ErrorSchema } } }, 422: { description: "Validation error", content: { "application/json": { schema: ErrorSchema.extend({ details: z.array(z.unknown()).optional() }) } } }, 429: { description: "Rate limit exceeded", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } }, 500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } } } });

const deleteTaskRoute = createRoute({ method: "delete", path: "/{id}", tags: ["Scheduled Tasks"], summary: "Delete a scheduled task", description: "Soft-deletes (disables) a scheduled task. Requires admin role.", request: { params: z.object({ id: z.string().openapi({ param: { name: "id", in: "path" }, example: "00000000-0000-0000-0000-000000000000" }) }) }, responses: { 204: { description: "Task deleted successfully" }, 400: { description: "Invalid task ID format", content: { "application/json": { schema: ErrorSchema } } }, 401: { description: "Authentication required", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } }, 403: { description: "Forbidden — admin role required", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } }, 404: { description: "Task not found", content: { "application/json": { schema: ErrorSchema } } }, 429: { description: "Rate limit exceeded", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } }, 500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } } } });

const triggerTaskRoute = createRoute({ method: "post", path: "/{id}/run", tags: ["Scheduled Tasks"], summary: "Trigger immediate execution", description: "Triggers an immediate execution of a scheduled task. Requires admin role.", request: { params: z.object({ id: z.string().openapi({ param: { name: "id", in: "path" }, example: "00000000-0000-0000-0000-000000000000" }) }) }, responses: { 200: { description: "Task triggered", content: { "application/json": { schema: z.object({ message: z.string(), taskId: z.string() }) } } }, 400: { description: "Invalid task ID format", content: { "application/json": { schema: ErrorSchema } } }, 401: { description: "Authentication required", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } }, 403: { description: "Forbidden — admin role required", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } }, 404: { description: "Task not found", content: { "application/json": { schema: ErrorSchema } } }, 429: { description: "Rate limit exceeded", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } }, 500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } } } });

const previewTaskRoute = createRoute({ method: "post", path: "/{id}/preview", tags: ["Scheduled Tasks"], summary: "Preview delivery format", description: "Dry-run delivery format with mock data. Requires admin role.", request: { params: z.object({ id: z.string().openapi({ param: { name: "id", in: "path" }, example: "00000000-0000-0000-0000-000000000000" }) }) }, responses: { 200: { description: "Delivery preview", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } }, 400: { description: "Invalid task ID format", content: { "application/json": { schema: ErrorSchema } } }, 401: { description: "Authentication required", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } }, 403: { description: "Forbidden — admin role required", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } }, 404: { description: "Task not found", content: { "application/json": { schema: ErrorSchema } } }, 429: { description: "Rate limit exceeded", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } }, 500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } } } });

const listTaskRunsRoute = createRoute({ method: "get", path: "/{id}/runs", tags: ["Scheduled Tasks"], summary: "List task runs", description: "Returns past execution runs for a scheduled task. Requires admin role.", request: { params: z.object({ id: z.string().openapi({ param: { name: "id", in: "path" }, example: "00000000-0000-0000-0000-000000000000" }) }), query: z.object({ limit: z.string().optional().openapi({ param: { name: "limit", in: "query" }, description: "Maximum number of runs to return (1-100, default 20)." }) }) }, responses: { 200: { description: "List of task runs", content: { "application/json": { schema: z.object({ runs: z.array(z.record(z.string(), z.unknown())) }) } } }, 400: { description: "Invalid task ID format", content: { "application/json": { schema: ErrorSchema } } }, 401: { description: "Authentication required", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } }, 403: { description: "Forbidden — admin role required", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } }, 404: { description: "Task not found", content: { "application/json": { schema: ErrorSchema } } }, 429: { description: "Rate limit exceeded", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } }, 500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } } } });

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

// Outer app: tick route (cron-secret auth, no user-auth middleware)
const scheduledTasks = new OpenAPIHono<AuthEnv>({ defaultHook: validationHook });

// Inner app: admin-authenticated, org-scoped routes (adminAuth + requireOrgContext)
const authed = createAdminRouter();
authed.use(requireOrgContext());

// Tick also needs a JSON-parse error handler (outer app only — authed uses eeOnError via createAdminRouter)
scheduledTasks.onError((err, c) => {
  if (err instanceof HTTPException) {
    if (err.res) return err.res;
    if (err.status === 400) {
      return c.json({ error: "invalid_request", message: "Invalid JSON body." }, 400);
    }
  }
  throw err;
});

// ---------------------------------------------------------------------------
// GET / — list scheduled tasks
// ---------------------------------------------------------------------------

authed.openapi(listTasksRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { orgId } = yield* AuthContext;

    const { limit, offset } = parsePagination(c, { limit: 20, maxLimit: 100 });
    const enabledParam = c.req.query("enabled");
    const enabled = enabledParam === "true" ? true : enabledParam === "false" ? false : undefined;
    const connectionGroupId = c.req.query("connectionGroupId") ?? undefined;

    const items = yield* Effect.promise(() => listScheduledTasks({
      orgId,
      enabled,
      ...(connectionGroupId !== undefined ? { connectionGroupId } : {}),
      limit,
      offset,
    }));
    return c.json(items, 200);
  }), { label: "list scheduled tasks" });
});

// ---------------------------------------------------------------------------
// POST / — create scheduled task
// ---------------------------------------------------------------------------

authed.openapi(
  createTaskRoute,
  async (c) => {
    return runEffect(c, Effect.gen(function* () {
      const { requestId } = yield* RequestContext;
      const { orgId, user } = yield* AuthContext;

      const parsed = c.req.valid("json");

      // Validate cron expression
      const cronCheck = validateCronExpression(parsed.cronExpression);
      if (!cronCheck.valid) {
        return c.json({ error: "invalid_request", message: `Invalid cron expression: ${cronCheck.error}` }, 400);
      }

      // #2512 — connectionGroupId gates (parity with chat.ts + dashboards.ts).
      // The schema's `transform` already coerced `""` to `null`, so this is the
      // canonical place to enforce: (a) "must be bound to an environment" on
      // create (#2418's API-side counterpart — the form gate was form-only)
      // and (b) cross-org ownership (#2424 — third write path; the first two
      // are chat + dashboards). Both checks return a `400` with a stable
      // `error` discriminator the SDK can branch on.
      if (parsed.connectionGroupId === null || parsed.connectionGroupId === undefined) {
        return c.json(
          {
            error: "connection_group_required",
            message: "Scheduled tasks must be bound to an environment. Create one in Admin → Environments first.",
            requestId,
          },
          400,
        );
      }
      const verdict = yield* Effect.promise(() =>
        verifyGroupBelongsToOrg(parsed.connectionGroupId!, orgId),
      );
      if (verdict === "not_found") {
        return c.json(
          {
            error: "invalid_connection_group",
            message: "The requested environment is not available in this workspace.",
            requestId,
          },
          400,
        );
      }
      if (verdict === "error") {
        return c.json(
          {
            error: "internal_error",
            message: "Could not verify environment ownership. Please retry.",
            requestId,
          },
          500,
        );
      }

      const createOpts = {
        ownerId: user?.id ?? "anonymous",
        orgId,
        name: parsed.name,
        question: parsed.question,
        cronExpression: parsed.cronExpression,
        deliveryChannel: parsed.deliveryChannel,
        recipients: parsed.recipients,
        connectionGroupId: parsed.connectionGroupId,
        approvalMode: parsed.approvalMode,
      };
      const createResult = yield* Effect.promise(() => createScheduledTask(createOpts));

      if (!createResult.ok) {
        const fail = crudFailResponse(createResult.reason, requestId);
        return c.json(fail.body, fail.status);
      }

      logAdminAction({
        actionType: ADMIN_ACTIONS.schedule.create,
        targetType: "schedule",
        targetId: createResult.data.id,
        ipAddress: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null,
        metadata: { name: parsed.name },
      });

      // #3379 — sender preflight: warn (never block) when this deployment has
      // no working sender for the chosen channel. The task is created either
      // way; the admin can configure the sender afterwards.
      const warnings = yield* Effect.promise(() =>
        checkDeliverySenders(
          recipientsForChannel(parsed.recipients, parsed.deliveryChannel),
          orgId,
        ),
      );

      return c.json({ ...createResult.data, warnings }, 201);
    }), { label: "create scheduled task" });
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
  return runEffect(c, Effect.gen(function* () {
    const req = c.req.raw;
    const requestId = crypto.randomUUID();

    if (!hasInternalDB()) {
      return c.json({ error: "not_available", message: "Scheduled tasks require an internal database.", requestId }, 404);
    }

    // Auth: check CRON_SECRET (Vercel-native) or ATLAS_SCHEDULER_SECRET (generic)
    const secret = process.env.CRON_SECRET ?? process.env.ATLAS_SCHEDULER_SECRET;
    const { getConfig } = yield* Effect.promise(() => import("@atlas/api/lib/config"));
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

    const tickOutcome = yield* Effect.tryPromise({
      try: async () => {
        const { runTick } = await import("@atlas/api/lib/scheduler/engine");
        return runTick();
      },
      catch: (err) => err instanceof Error ? err : new Error(String(err)),
    }).pipe(Effect.catchAll((err) => {
      log.error({ err, requestId }, "Tick execution failed");
      return Effect.succeed({ error: "internal_error" as const, requestId });
    }));

    // F-29: emit one `schedule.tick` row per tick — success or failure,
    // zero tasks or many. The absence of a row over a cadence window is
    // the signal that the scheduler stopped firing (mirrors F-27's
    // purge-cycle convention). Uses the reserved `system:scheduler`
    // actor — validated against `SYSTEM_ACTOR_PATTERN` inside
    // `logAdminAction`, which logs loudly and drops the row on typos
    // rather than writing malformed audit data (see `lib/audit/admin.ts`).
    //
    // The outer `catchAll` replaces an unexpected throw with
    // `{ error: "internal_error", requestId }`; engine-reported failures
    // surface as `TickResult.error`. Both are failure shapes — one
    // inline `"error" in …` discriminant collapses them into a single
    // branch so the audit emission runs exactly once either way.
    if ("error" in tickOutcome && typeof tickOutcome.error === "string") {
      const errorLabel: string = tickOutcome.error;
      logAdminAction({
        actionType: ADMIN_ACTIONS.schedule.tick,
        targetType: "schedule",
        targetId: "scheduler",
        status: "failure",
        scope: "platform",
        systemActor: "system:scheduler",
        metadata: { tasksProcessed: 0, successes: 0, failures: 0, error: errorLabel },
      });
      if (errorLabel === "internal_error") {
        return c.json({ error: "internal_error", message: "Tick execution failed.", requestId }, 500);
      }
      return c.json({ error: "tick_failed", message: errorLabel, requestId }, 500);
    }

    // Success path — `tickOutcome` narrowed to `TickResult` with no
    // error string, so tasks* fields are safe to read.
    const successOutcome = tickOutcome as TickResult;
    logAdminAction({
      actionType: ADMIN_ACTIONS.schedule.tick,
      targetType: "schedule",
      targetId: "scheduler",
      scope: "platform",
      systemActor: "system:scheduler",
      metadata: {
        tasksProcessed: successOutcome.tasksDispatched,
        successes: successOutcome.tasksCompleted,
        failures: successOutcome.tasksFailed,
      },
    });
    return c.json(successOutcome, 200);
  }), { label: "scheduler tick" });
});

// ---------------------------------------------------------------------------
// GET /runs — cross-task run history
// ---------------------------------------------------------------------------

authed.openapi(listAllRunsRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { orgId } = yield* AuthContext;

    const { limit, offset } = parsePagination(c, { limit: 20, maxLimit: 100 });

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

    const runs = yield* Effect.promise(() => listAllRuns({ orgId, taskId, status, dateFrom, dateTo, limit, offset }));
    return c.json(runs, 200);
  }), { label: "list all runs" });
});

// ---------------------------------------------------------------------------
// GET /:id — get scheduled task with recent runs
// ---------------------------------------------------------------------------

authed.openapi(getTaskRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;
    const { orgId } = yield* AuthContext;

    const { id } = c.req.valid("param");
    if (!UUID_RE.test(id)) {
      return c.json({ error: "invalid_request", message: "Invalid task ID format." }, 400);
    }

    const taskResult = yield* Effect.promise(() => getScheduledTask(id, { orgId }));
    if (!taskResult.ok) {
      const fail = crudFailResponse(taskResult.reason, requestId);
      return c.json(fail.body, fail.status);
    }

    const runs = yield* Effect.promise(() => listTaskRuns(id, { limit: 10 }));
    return c.json({ ...taskResult.data, recentRuns: runs }, 200);
  }), { label: "get scheduled task" });
});

// ---------------------------------------------------------------------------
// PUT /:id — update scheduled task
// ---------------------------------------------------------------------------

authed.openapi(
  updateTaskRoute,
  async (c) => {
    return runEffect(c, Effect.gen(function* () {
      const { requestId } = yield* RequestContext;
      const { orgId } = yield* AuthContext;

      const { id } = c.req.valid("param");
      if (!UUID_RE.test(id)) {
        return c.json({ error: "invalid_request", message: "Invalid task ID format." }, 400);
      }

      const parsed = c.req.valid("json");

      // Validate cron if provided
      if (parsed.cronExpression) {
        const cronCheck = validateCronExpression(parsed.cronExpression);
        if (!cronCheck.valid) {
          return c.json({ error: "invalid_request", message: `Invalid cron expression: ${cronCheck.error}` }, 400);
        }
      }

      // #2512 — when the caller supplies a non-null `connectionGroupId`,
      // verify it belongs to the caller's org BEFORE handing off to the
      // DB layer (which would otherwise leak an FK violation as a generic
      // 500). The Zod transform already coerced `""` to `null`. Explicit
      // `null` is the legitimate "un-scope this task" PATCH and is left
      // alone here — un-scoping has its own consequences (scheduler falls
      // back to `getDB()`), but that's a separate policy call and is the
      // existing behavior documented on the route description.
      if (parsed.connectionGroupId) {
        const groupId = parsed.connectionGroupId;
        const verdict = yield* Effect.promise(() =>
          verifyGroupBelongsToOrg(groupId, orgId),
        );
        if (verdict === "not_found") {
          return c.json(
            {
              error: "invalid_connection_group",
              message: "The requested environment is not available in this workspace.",
              requestId,
            },
            400,
          );
        }
        if (verdict === "error") {
          return c.json(
            {
              error: "internal_error",
              message: "Could not verify environment ownership. Please retry.",
              requestId,
            },
            500,
          );
        }
      }

      const updateResult = yield* Effect.promise(() => updateScheduledTask(id, { orgId }, parsed));
      if (!updateResult.ok) {
        const fail = crudFailResponse(updateResult.reason, requestId);
        return c.json(fail.body, fail.status);
      }

      // Fetch updated task to return
      const updated = yield* Effect.promise(() => getScheduledTask(id, { orgId }));

      // Determine if this was a toggle (enabled field changed)
      const isToggle = parsed.enabled !== undefined && Object.keys(parsed).length === 1;
      if (isToggle) {
        logAdminAction({
          actionType: ADMIN_ACTIONS.schedule.toggle,
          targetType: "schedule",
          targetId: id,
          ipAddress: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null,
          metadata: { name: updated.ok ? updated.data.name : id, enabled: parsed.enabled },
        });
      } else {
        logAdminAction({
          actionType: ADMIN_ACTIONS.schedule.update,
          targetType: "schedule",
          targetId: id,
          ipAddress: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null,
          metadata: { name: updated.ok ? updated.data.name : id },
        });
      }

      if (!updated.ok) {
        // Update succeeded but the re-fetch failed — keep the legacy shape,
        // with an empty warnings array for response-shape consistency.
        return c.json({ ok: true, warnings: [] }, 200);
      }

      // #3379 — sender preflight on the task's EFFECTIVE post-update state.
      // The request body may omit recipients/deliveryChannel (partial PUT),
      // so prefer the parsed values when present and fall back to the stored
      // task. Warn, never block.
      const warnings = yield* Effect.promise(() =>
        checkDeliverySenders(
          recipientsForChannel(
            parsed.recipients ?? updated.data.recipients,
            parsed.deliveryChannel ?? updated.data.deliveryChannel,
          ),
          orgId,
        ),
      );
      return c.json({ ...updated.data, warnings }, 200);
    }), { label: "update scheduled task" });
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

authed.openapi(deleteTaskRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;
    const { orgId } = yield* AuthContext;

    const { id } = c.req.valid("param");
    if (!UUID_RE.test(id)) {
      return c.json({ error: "invalid_request", message: "Invalid task ID format." }, 400);
    }

    const delResult = yield* Effect.promise(() => deleteScheduledTask(id, { orgId }));
    if (!delResult.ok) {
      const fail = crudFailResponse(delResult.reason, requestId);
      return c.json(fail.body, fail.status);
    }

    logAdminAction({
      actionType: ADMIN_ACTIONS.schedule.delete,
      targetType: "schedule",
      targetId: id,
      ipAddress: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null,
      metadata: { taskId: id },
    });

    return c.body(null, 204);
  }), { label: "delete scheduled task" });
});

// ---------------------------------------------------------------------------
// POST /:id/run — trigger immediate execution
// ---------------------------------------------------------------------------

authed.openapi(triggerTaskRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;
    const { orgId } = yield* AuthContext;

    const { id } = c.req.valid("param");
    if (!UUID_RE.test(id)) {
      return c.json({ error: "invalid_request", message: "Invalid task ID format." }, 400);
    }

    const task = yield* Effect.promise(() => getScheduledTask(id, { orgId }));
    if (!task.ok) {
      const fail = crudFailResponse(task.reason, requestId);
      return c.json(fail.body, fail.status);
    }

    const { triggerTask } = yield* Effect.promise(() => import("@atlas/api/lib/scheduler/engine"));
    yield* Effect.promise(() => triggerTask(id));

    // Manual out-of-cadence trigger — high-impact (delivers data to recipients
    // outside the normal cron window). Emitted after the dispatch call so a
    // rejection short-circuits without a false audit row. See F-29.
    logAdminAction({
      actionType: ADMIN_ACTIONS.schedule.trigger,
      targetType: "schedule",
      targetId: id,
      ipAddress: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null,
      metadata: { taskId: id, taskName: task.data.name },
    });

    return c.json({ message: "Task triggered successfully.", taskId: id }, 200);
  }), { label: "trigger task execution" });
});

// ---------------------------------------------------------------------------
// POST /:id/preview — dry-run delivery format with mock data
// ---------------------------------------------------------------------------

authed.openapi(previewTaskRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;
    const { orgId } = yield* AuthContext;

    const { id } = c.req.valid("param");
    if (!UUID_RE.test(id)) {
      return c.json({ error: "invalid_request", message: "Invalid task ID format." }, 400);
    }

    const task = yield* Effect.promise(() => getScheduledTask(id, { orgId }));
    if (!task.ok) {
      const fail = crudFailResponse(task.reason, requestId);
      return c.json(fail.body, fail.status);
    }

    const { generateDeliveryPreview } = yield* Effect.promise(() => import("@atlas/api/lib/scheduler/preview"));
    const preview = generateDeliveryPreview(task.data);

    // Dry-run delivery preview — reveals recipient/channel shape to the
    // caller. Low-impact relative to `trigger`, but the access itself
    // warrants a forensic trail. `dryRun: true` distinguishes from
    // `schedule.trigger` when both land in the same log stream. See F-29.
    logAdminAction({
      actionType: ADMIN_ACTIONS.schedule.preview,
      targetType: "schedule",
      targetId: id,
      ipAddress: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null,
      metadata: { taskId: id, dryRun: true },
    });

    return c.json(preview, 200);
  }), { label: "generate delivery preview" });
});

// ---------------------------------------------------------------------------
// GET /:id/runs — list past runs
// ---------------------------------------------------------------------------

authed.openapi(listTaskRunsRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;
    const { orgId } = yield* AuthContext;

    const { id } = c.req.valid("param");
    if (!UUID_RE.test(id)) {
      return c.json({ error: "invalid_request", message: "Invalid task ID format." }, 400);
    }

    // Verify task belongs to this org
    const task = yield* Effect.promise(() => getScheduledTask(id, { orgId }));
    if (!task.ok) {
      const fail = crudFailResponse(task.reason, requestId);
      return c.json(fail.body, fail.status);
    }

    const { limit } = parsePagination(c, { limit: 20, maxLimit: 100 });
    const runs = yield* Effect.promise(() => listTaskRuns(id, { limit }));
    return c.json({ runs }, 200);
  }), { label: "list task runs" });
});

// Mount authenticated routes on the outer app
scheduledTasks.route("/", authed);

export { scheduledTasks };
