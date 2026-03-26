/**
 * Platform SLA monitoring routes — per-workspace uptime, latency, error rate.
 *
 * Mounted at /api/v1/platform/sla. All routes require `platform_admin` role.
 *
 * Provides:
 * - GET    /              — all workspaces SLA summary (?hours=N)
 * - GET    /:workspaceId  — per-workspace detail with timelines (?hours=N)
 * - GET    /alerts        — active and recent alerts (?status=, ?limit=)
 * - GET    /thresholds    — current alert thresholds
 * - PUT    /thresholds    — configure alert thresholds
 * - POST   /alerts/:alertId/acknowledge — acknowledge a firing alert
 * - POST   /evaluate      — trigger alert evaluation on demand
 */

import { createRoute, z } from "@hono/zod-openapi";
import { Effect } from "effect";
import { createLogger } from "@atlas/api/lib/logger";
import { runEffect } from "@atlas/api/lib/effect/hono";
import {
  RequestContext,
  AuthContext,
} from "@atlas/api/lib/effect/services";
import {
  SLA_ALERT_STATUSES,
  SLA_ALERT_TYPES,
} from "@useatlas/types";
import { ErrorSchema, AuthErrorSchema, parsePagination } from "./shared-schemas";
import { createPlatformRouter } from "./admin-router";

const log = createLogger("platform-sla");

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const SLAMetricPointSchema = z.object({
  timestamp: z.string(),
  value: z.number(),
});

const WorkspaceSLASummarySchema = z.object({
  workspaceId: z.string(),
  workspaceName: z.string(),
  latencyP50Ms: z.number().min(0),
  latencyP95Ms: z.number().min(0),
  latencyP99Ms: z.number().min(0),
  errorRatePct: z.number().min(0).max(100),
  uptimePct: z.number().min(0).max(100),
  totalQueries: z.number().min(0),
  failedQueries: z.number().min(0),
  lastQueryAt: z.string().nullable(),
});

const WorkspaceSLADetailSchema = z.object({
  summary: WorkspaceSLASummarySchema,
  latencyTimeline: z.array(SLAMetricPointSchema),
  errorTimeline: z.array(SLAMetricPointSchema),
});

const SLAAlertSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  workspaceName: z.string(),
  type: z.enum(SLA_ALERT_TYPES),
  status: z.enum(SLA_ALERT_STATUSES),
  currentValue: z.number(),
  threshold: z.number(),
  message: z.string(),
  firedAt: z.string(),
  resolvedAt: z.string().nullable(),
  acknowledgedAt: z.string().nullable(),
  acknowledgedBy: z.string().nullable(),
});

const SLAThresholdsSchema = z.object({
  latencyP99Ms: z.number().min(0).openapi({ description: "P99 latency threshold in ms", example: 5000 }),
  errorRatePct: z.number().min(0).max(100).openapi({ description: "Error rate threshold in percent", example: 5 }),
});

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const listSLARoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Platform Admin — SLA"],
  summary: "All workspaces SLA summary",
  description: "SaaS only. Returns SLA metrics (latency percentiles, error rate, uptime) for all workspaces over the given time window.",
  responses: {
    200: {
      description: "Workspaces SLA summary",
      content: { "application/json": { schema: z.object({ workspaces: z.array(WorkspaceSLASummarySchema), hoursBack: z.number() }) } },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Platform admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Enterprise feature not enabled or no internal DB", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const getWorkspaceSLARoute = createRoute({
  method: "get",
  path: "/:workspaceId",
  tags: ["Platform Admin — SLA"],
  summary: "Per-workspace SLA detail",
  description: "SaaS only. Returns detailed SLA metrics with latency and error rate time-series for a single workspace.",
  responses: {
    200: {
      description: "Workspace SLA detail",
      content: { "application/json": { schema: WorkspaceSLADetailSchema } },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Platform admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Enterprise feature not enabled or no internal DB", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const listAlertsRoute = createRoute({
  method: "get",
  path: "/alerts",
  tags: ["Platform Admin — SLA"],
  summary: "SLA alerts",
  description: "SaaS only. Returns active and recent SLA alerts. Optionally filter by status.",
  responses: {
    200: {
      description: "SLA alerts list",
      content: { "application/json": { schema: z.object({ alerts: z.array(SLAAlertSchema) }) } },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Platform admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Enterprise feature not enabled", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const updateThresholdsRoute = createRoute({
  method: "put",
  path: "/thresholds",
  tags: ["Platform Admin — SLA"],
  summary: "Update alert thresholds",
  description: "SaaS only. Configure the default SLA alert thresholds.",
  request: { body: { required: true, content: { "application/json": { schema: SLAThresholdsSchema } } } },
  responses: {
    200: {
      description: "Thresholds updated",
      content: { "application/json": { schema: z.object({ message: z.string(), thresholds: SLAThresholdsSchema }) } },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Platform admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Enterprise feature not enabled", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const getThresholdsRoute = createRoute({
  method: "get",
  path: "/thresholds",
  tags: ["Platform Admin — SLA"],
  summary: "Get alert thresholds",
  description: "SaaS only. Returns the current default SLA alert thresholds.",
  responses: {
    200: {
      description: "Current thresholds",
      content: { "application/json": { schema: SLAThresholdsSchema } },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Platform admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Enterprise feature not enabled", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const acknowledgeAlertRoute = createRoute({
  method: "post",
  path: "/alerts/:alertId/acknowledge",
  tags: ["Platform Admin — SLA"],
  summary: "Acknowledge an alert",
  description: "SaaS only. Acknowledge a firing SLA alert.",
  responses: {
    200: {
      description: "Alert acknowledged",
      content: { "application/json": { schema: z.object({ message: z.string(), alertId: z.string() }) } },
    },
    400: { description: "Alert not in firing state", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Platform admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Enterprise feature not enabled", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const evaluateAlertsRoute = createRoute({
  method: "post",
  path: "/evaluate",
  tags: ["Platform Admin — SLA"],
  summary: "Evaluate alerts now",
  description: "SaaS only. Trigger alert evaluation against current metrics and thresholds.",
  responses: {
    200: {
      description: "Evaluation results",
      content: { "application/json": { schema: z.object({ newAlerts: z.array(SLAAlertSchema) }) } },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Platform admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Enterprise feature not enabled", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// ---------------------------------------------------------------------------
// Lazy import — ee module may not be installed
// ---------------------------------------------------------------------------

type SLAModule = typeof import("@atlas/ee/sla/index");

async function loadSLA(): Promise<SLAModule | null> {
  try {
    return await import("@atlas/ee/sla/index");
  } catch (err) {
    // MODULE_NOT_FOUND is expected when ee package is not installed
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "MODULE_NOT_FOUND") {
      return null;
    }
    // Unexpected errors (syntax errors, init failures) should surface
    log.error(
      { err: err instanceof Error ? err : new Error(String(err)) },
      "Failed to load SLA module — unexpected error",
    );
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const platformSLA = createPlatformRouter();

// ── List all workspaces SLA ──────────────────────────────────────────

platformSLA.openapi(listSLARoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;

    const sla = yield* Effect.promise(() => loadSLA());
    if (!sla) {
      return c.json({ error: "not_available", message: "SLA monitoring requires enterprise features to be enabled.", requestId }, 404);
    }

    const hoursBack = Math.min(Math.max(parseInt(c.req.query("hours") ?? "24", 10) || 24, 1), 720);

    const workspaces = yield* Effect.promise(() => sla.getAllWorkspaceSLA(hoursBack));
    return c.json({ workspaces, hoursBack }, 200);
  }), { label: "fetch SLA summary" });
});

// ── Get workspace SLA detail ─────────────────────────────────────────

platformSLA.openapi(getWorkspaceSLARoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;

    const sla = yield* Effect.promise(() => loadSLA());
    if (!sla) {
      return c.json({ error: "not_available", message: "SLA monitoring requires enterprise features to be enabled.", requestId }, 404);
    }

    const workspaceId = c.req.param("workspaceId");
    const hoursBack = Math.min(Math.max(parseInt(c.req.query("hours") ?? "24", 10) || 24, 1), 720);

    const detail = yield* Effect.promise(() => sla.getWorkspaceSLADetail(workspaceId, hoursBack));
    return c.json(detail, 200);
  }), { label: "fetch workspace SLA detail" });
});

// ── List alerts ──────────────────────────────────────────────────────

platformSLA.openapi(listAlertsRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;

    const sla = yield* Effect.promise(() => loadSLA());
    if (!sla) {
      return c.json({ error: "not_available", message: "SLA monitoring requires enterprise features to be enabled.", requestId }, 404);
    }

    const statusParam = c.req.query("status");
    const validStatuses = new Set(SLA_ALERT_STATUSES);
    const status = statusParam && validStatuses.has(statusParam as "firing") ? (statusParam as "firing" | "resolved" | "acknowledged") : undefined;
    const { limit } = parsePagination(c, { limit: 100, maxLimit: 500 });

    const alerts = yield* Effect.promise(() => sla.getAlerts(status, limit));
    return c.json({ alerts }, 200);
  }), { label: "fetch SLA alerts" });
});

// ── Get thresholds ───────────────────────────────────────────────────

platformSLA.openapi(getThresholdsRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;

    const sla = yield* Effect.promise(() => loadSLA());
    if (!sla) {
      return c.json({ error: "not_available", message: "SLA monitoring requires enterprise features to be enabled.", requestId }, 404);
    }

    const thresholds = yield* Effect.promise(() => sla.getThresholds());
    return c.json(thresholds, 200);
  }), { label: "read SLA thresholds" });
});

// ── Update thresholds ────────────────────────────────────────────────

platformSLA.openapi(updateThresholdsRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;

    const sla = yield* Effect.promise(() => loadSLA());
    if (!sla) {
      return c.json({ error: "not_available", message: "SLA monitoring requires enterprise features to be enabled.", requestId }, 404);
    }

    const body = c.req.valid("json");

    yield* Effect.promise(() => sla.updateThresholds(body));
    log.info({ thresholds: body, requestId }, "SLA thresholds updated by platform admin");
    return c.json({ message: "Thresholds updated.", thresholds: body }, 200);
  }), { label: "update SLA thresholds" });
});

// ── Acknowledge alert ────────────────────────────────────────────────

platformSLA.openapi(acknowledgeAlertRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;
    const { user } = yield* AuthContext;

    const sla = yield* Effect.promise(() => loadSLA());
    if (!sla) {
      return c.json({ error: "not_available", message: "SLA monitoring requires enterprise features to be enabled.", requestId }, 404);
    }

    const alertId = c.req.param("alertId");
    if (!user?.id) {
      log.error({ requestId, alertId }, "SLA alert acknowledge attempted without authenticated user identity");
      return c.json({ error: "auth_error", message: "User identity could not be determined.", requestId }, 401);
    }
    const actorId = user.id;

    const acknowledged = yield* Effect.promise(() => sla.acknowledgeAlert(alertId, actorId));
    if (!acknowledged) {
      return c.json({ error: "not_firing", message: "Alert is not in firing state.", requestId }, 400);
    }
    log.info({ alertId, actorId, requestId }, "SLA alert acknowledged");
    return c.json({ message: "Alert acknowledged.", alertId }, 200);
  }), { label: "acknowledge SLA alert" });
});

// ── Evaluate alerts ──────────────────────────────────────────────────

platformSLA.openapi(evaluateAlertsRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;

    const sla = yield* Effect.promise(() => loadSLA());
    if (!sla) {
      return c.json({ error: "not_available", message: "SLA monitoring requires enterprise features to be enabled.", requestId }, 404);
    }

    const newAlerts = yield* Effect.promise(() => sla.evaluateAlerts());
    return c.json({ newAlerts }, 200);
  }), { label: "evaluate SLA alerts" });
});

export { platformSLA };
