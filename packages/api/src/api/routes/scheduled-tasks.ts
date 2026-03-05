/**
 * Scheduled tasks REST routes — CRUD + trigger + run history.
 *
 * Gated behind ATLAS_SCHEDULER_ENABLED=true (conditional mount in index.ts).
 * Follows the same auth → rate limit → withRequestContext pattern as conversations.ts.
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
  createScheduledTask,
  getScheduledTask,
  listScheduledTasks,
  updateScheduledTask,
  deleteScheduledTask,
  listTaskRuns,
  validateCronExpression,
  type CrudFailReason,
} from "@atlas/api/lib/scheduled-tasks";
import { DELIVERY_CHANNELS } from "@atlas/api/lib/scheduled-task-types";
import { ACTION_APPROVAL_MODES } from "@atlas/api/lib/action-types";

const log = createLogger("scheduled-tasks-routes");

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const RecipientSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("email"), address: z.string().email() }),
  z.object({ type: z.literal("slack"), channel: z.string().min(1), teamId: z.string().optional() }),
  z.object({ type: z.literal("webhook"), url: z.string().url(), headers: z.record(z.string(), z.string()).optional() }),
]);

export const CreateScheduledTaskSchema = z.object({
  name: z.string().min(1).max(200),
  question: z.string().min(1).max(2000),
  cronExpression: z.string().min(1),
  deliveryChannel: z.enum(DELIVERY_CHANNELS).default("webhook"),
  recipients: z.array(RecipientSchema).default([]),
  connectionId: z.string().nullable().optional(),
  approvalMode: z.enum(ACTION_APPROVAL_MODES).default("auto"),
});

export const UpdateScheduledTaskSchema = z.object({
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

function crudFailResponse(reason: CrudFailReason) {
  switch (reason) {
    case "no_db":
      return { body: { error: "not_available", message: "Scheduled tasks require an internal database." }, status: 404 as const };
    case "not_found":
      return { body: { error: "not_found", message: "Scheduled task not found." }, status: 404 as const };
    case "error":
      return { body: { error: "internal_error", message: "A database error occurred. Please try again." }, status: 500 as const };
    default: {
      const _exhaustive: never = reason;
      return { body: { error: "internal_error", message: `Unexpected failure: ${_exhaustive}` }, status: 500 as const };
    }
  }
}

const scheduledTasks = new Hono();

// ---------------------------------------------------------------------------
// Shared auth preamble
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
// GET / — list scheduled tasks
// ---------------------------------------------------------------------------

scheduledTasks.get("/", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  if (!hasInternalDB()) {
    return c.json({ error: "not_available", message: "Scheduled tasks require an internal database." }, 404);
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
    const enabledParam = c.req.query("enabled");
    const enabled = enabledParam === "true" ? true : enabledParam === "false" ? false : undefined;

    const result = await listScheduledTasks({
      ownerId: authResult.user?.id,
      enabled,
      limit,
      offset,
    });
    return c.json(result);
  });
});

// ---------------------------------------------------------------------------
// POST / — create scheduled task
// ---------------------------------------------------------------------------

scheduledTasks.post("/", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  if (!hasInternalDB()) {
    return c.json({ error: "not_available", message: "Scheduled tasks require an internal database." }, 404);
  }

  const preamble = await authPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: preamble.headers });
  }
  const { authResult } = preamble;

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return c.json({ error: "invalid_request", message: "Invalid JSON body." }, 400);
    }

    const parsed = CreateScheduledTaskSchema.safeParse(body);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      return c.json({ error: "invalid_request", message: issues }, 400);
    }

    // Validate cron expression
    const cronCheck = validateCronExpression(parsed.data.cronExpression);
    if (!cronCheck.valid) {
      return c.json({ error: "invalid_request", message: `Invalid cron expression: ${cronCheck.error}` }, 400);
    }

    const result = await createScheduledTask({
      ownerId: authResult.user?.id ?? "anonymous",
      name: parsed.data.name,
      question: parsed.data.question,
      cronExpression: parsed.data.cronExpression,
      deliveryChannel: parsed.data.deliveryChannel,
      recipients: parsed.data.recipients,
      connectionId: parsed.data.connectionId ?? null,
      approvalMode: parsed.data.approvalMode,
    });

    if (!result.ok) {
      const fail = crudFailResponse(result.reason);
      return c.json(fail.body, fail.status);
    }

    return c.json(result.data, 201);
  });
});

// ---------------------------------------------------------------------------
// POST /tick — serverless scheduler tick (Vercel Cron)
// ---------------------------------------------------------------------------

scheduledTasks.post("/tick", async (c) => {
  const req = c.req.raw;

  if (!hasInternalDB()) {
    return c.json({ error: "not_available", message: "Scheduled tasks require an internal database." }, 404);
  }

  // Auth: check CRON_SECRET (Vercel-native) or ATLAS_SCHEDULER_SECRET (generic)
  const secret = process.env.CRON_SECRET ?? process.env.ATLAS_SCHEDULER_SECRET;
  const { getConfig } = await import("@atlas/api/lib/config");
  const config = getConfig();

  if (secret) {
    const authHeader = req.headers.get("authorization");
    if (authHeader !== `Bearer ${secret}`) {
      return c.json({ error: "unauthorized", message: "Invalid or missing cron secret." }, 401);
    }
  } else if (config?.scheduler?.backend === "vercel") {
    return c.json(
      { error: "misconfigured", message: "Vercel backend requires CRON_SECRET or ATLAS_SCHEDULER_SECRET to be set." },
      500,
    );
  } else if (process.env.NODE_ENV === "production") {
    return c.json(
      { error: "misconfigured", message: "CRON_SECRET or ATLAS_SCHEDULER_SECRET must be set in production." },
      500,
    );
  } else {
    log.warn("POST /tick called without secret — allowing because NODE_ENV is not 'production'");
  }

  try {
    const { runTick } = await import("@atlas/api/lib/scheduler/engine");
    const result = await runTick();
    if (result.error) {
      return c.json(result, 500);
    }
    return c.json(result);
  } catch (err) {
    log.error({ err: err instanceof Error ? err : new Error(String(err)) }, "Tick execution failed");
    return c.json({ error: "internal_error", message: "Tick execution failed." }, 500);
  }
});

// ---------------------------------------------------------------------------
// GET /:id — get scheduled task with recent runs
// ---------------------------------------------------------------------------

scheduledTasks.get("/:id", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  if (!hasInternalDB()) {
    return c.json({ error: "not_available", message: "Scheduled tasks require an internal database." }, 404);
  }

  const preamble = await authPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: preamble.headers });
  }
  const { authResult } = preamble;

  const id = c.req.param("id");
  if (!UUID_RE.test(id)) {
    return c.json({ error: "invalid_request", message: "Invalid task ID format." }, 400);
  }

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    const result = await getScheduledTask(id, authResult.user?.id);
    if (!result.ok) {
      const fail = crudFailResponse(result.reason);
      return c.json(fail.body, fail.status);
    }

    const runs = await listTaskRuns(id, { limit: 10 });
    return c.json({ ...result.data, recentRuns: runs });
  });
});

// ---------------------------------------------------------------------------
// PUT /:id — update scheduled task
// ---------------------------------------------------------------------------

scheduledTasks.put("/:id", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  if (!hasInternalDB()) {
    return c.json({ error: "not_available", message: "Scheduled tasks require an internal database." }, 404);
  }

  const preamble = await authPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: preamble.headers });
  }
  const { authResult } = preamble;

  const id = c.req.param("id");
  if (!UUID_RE.test(id)) {
    return c.json({ error: "invalid_request", message: "Invalid task ID format." }, 400);
  }

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return c.json({ error: "invalid_request", message: "Invalid JSON body." }, 400);
    }

    const parsed = UpdateScheduledTaskSchema.safeParse(body);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      return c.json({ error: "invalid_request", message: issues }, 400);
    }

    // Validate cron if provided
    if (parsed.data.cronExpression) {
      const cronCheck = validateCronExpression(parsed.data.cronExpression);
      if (!cronCheck.valid) {
        return c.json({ error: "invalid_request", message: `Invalid cron expression: ${cronCheck.error}` }, 400);
      }
    }

    const result = await updateScheduledTask(id, authResult.user?.id ?? "anonymous", parsed.data);
    if (!result.ok) {
      const fail = crudFailResponse(result.reason);
      return c.json(fail.body, fail.status);
    }

    // Fetch updated task to return
    const updated = await getScheduledTask(id, authResult.user?.id);
    if (!updated.ok) {
      return c.json({ ok: true });
    }
    return c.json(updated.data);
  });
});

// ---------------------------------------------------------------------------
// DELETE /:id — soft delete (disable)
// ---------------------------------------------------------------------------

scheduledTasks.delete("/:id", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  if (!hasInternalDB()) {
    return c.json({ error: "not_available", message: "Scheduled tasks require an internal database." }, 404);
  }

  const preamble = await authPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: preamble.headers });
  }
  const { authResult } = preamble;

  const id = c.req.param("id");
  if (!UUID_RE.test(id)) {
    return c.json({ error: "invalid_request", message: "Invalid task ID format." }, 400);
  }

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    const result = await deleteScheduledTask(id, authResult.user?.id);
    if (!result.ok) {
      const fail = crudFailResponse(result.reason);
      return c.json(fail.body, fail.status);
    }
    return c.body(null, 204);
  });
});

// ---------------------------------------------------------------------------
// POST /:id/run — trigger immediate execution
// ---------------------------------------------------------------------------

scheduledTasks.post("/:id/run", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  if (!hasInternalDB()) {
    return c.json({ error: "not_available", message: "Scheduled tasks require an internal database." }, 404);
  }

  const preamble = await authPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: preamble.headers });
  }
  const { authResult } = preamble;

  const id = c.req.param("id");
  if (!UUID_RE.test(id)) {
    return c.json({ error: "invalid_request", message: "Invalid task ID format." }, 400);
  }

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    const task = await getScheduledTask(id, authResult.user?.id);
    if (!task.ok) {
      const fail = crudFailResponse(task.reason);
      return c.json(fail.body, fail.status);
    }

    try {
      const { triggerTask } = await import("@atlas/api/lib/scheduler/engine");
      await triggerTask(id);
      return c.json({ message: "Task triggered successfully.", taskId: id });
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err), taskId: id }, "Trigger failed");
      return c.json({ error: "internal_error", message: "Failed to trigger task execution." }, 500);
    }
  });
});

// ---------------------------------------------------------------------------
// GET /:id/runs — list past runs
// ---------------------------------------------------------------------------

scheduledTasks.get("/:id/runs", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  if (!hasInternalDB()) {
    return c.json({ error: "not_available", message: "Scheduled tasks require an internal database." }, 404);
  }

  const preamble = await authPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: preamble.headers });
  }
  const { authResult } = preamble;

  const id = c.req.param("id");
  if (!UUID_RE.test(id)) {
    return c.json({ error: "invalid_request", message: "Invalid task ID format." }, 400);
  }

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    // Verify task ownership
    const task = await getScheduledTask(id, authResult.user?.id);
    if (!task.ok) {
      const fail = crudFailResponse(task.reason);
      return c.json(fail.body, fail.status);
    }

    const rawLimit = parseInt(c.req.query("limit") ?? "20", 10);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 100) : 20;
    const runs = await listTaskRuns(id, { limit });
    return c.json({ runs });
  });
});

export { scheduledTasks };
