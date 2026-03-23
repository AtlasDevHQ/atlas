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

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { validationHook } from "./validation-hook";
import { createLogger } from "@atlas/api/lib/logger";
import {
  SLA_ALERT_STATUSES,
  SLA_ALERT_TYPES,
} from "@useatlas/types";
import { ErrorSchema, AuthErrorSchema } from "./shared-schemas";
import { platformAdminAuth, requestContext, type AuthEnv } from "./middleware";

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
  description: "Returns SLA metrics (latency percentiles, error rate, uptime) for all workspaces over the given time window.",
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
  description: "Returns detailed SLA metrics with latency and error rate time-series for a single workspace.",
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
  description: "Returns active and recent SLA alerts. Optionally filter by status.",
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
  description: "Configure the default SLA alert thresholds.",
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
  description: "Returns the current default SLA alert thresholds.",
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
  description: "Acknowledge a firing SLA alert.",
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
  description: "Trigger alert evaluation against current metrics and thresholds.",
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

const platformSLA = new OpenAPIHono<AuthEnv>({ defaultHook: validationHook });

platformSLA.use(platformAdminAuth);
platformSLA.use(requestContext);

// ── List all workspaces SLA ──────────────────────────────────────────

platformSLA.openapi(listSLARoute, async (c) => {
  const requestId = c.get("requestId");

  const sla = await loadSLA();
  if (!sla) {
    return c.json({ error: "not_available", message: "SLA monitoring requires enterprise features to be enabled.", requestId }, 404);
  }

  const hoursBack = Math.min(Math.max(parseInt(c.req.query("hours") ?? "24", 10) || 24, 1), 720);

  try {
    const workspaces = await sla.getAllWorkspaceSLA(hoursBack);
    return c.json({ workspaces, hoursBack }, 200);
  } catch (err) {
    log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId }, "Failed to fetch SLA summary");
    return c.json({ error: "internal_error", message: "Failed to load SLA metrics.", requestId }, 500);
  }
});

// ── Get workspace SLA detail ─────────────────────────────────────────

platformSLA.openapi(getWorkspaceSLARoute, async (c) => {
  const requestId = c.get("requestId");

  const sla = await loadSLA();
  if (!sla) {
    return c.json({ error: "not_available", message: "SLA monitoring requires enterprise features to be enabled.", requestId }, 404);
  }

  const workspaceId = c.req.param("workspaceId");
  const hoursBack = Math.min(Math.max(parseInt(c.req.query("hours") ?? "24", 10) || 24, 1), 720);

  try {
    const detail = await sla.getWorkspaceSLADetail(workspaceId, hoursBack);
    return c.json(detail, 200);
  } catch (err) {
    log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId, workspaceId }, "Failed to fetch workspace SLA detail");
    return c.json({ error: "internal_error", message: "Failed to load workspace SLA detail.", requestId }, 500);
  }
});

// ── List alerts ──────────────────────────────────────────────────────

platformSLA.openapi(listAlertsRoute, async (c) => {
  const requestId = c.get("requestId");

  const sla = await loadSLA();
  if (!sla) {
    return c.json({ error: "not_available", message: "SLA monitoring requires enterprise features to be enabled.", requestId }, 404);
  }

  const statusParam = c.req.query("status");
  const validStatuses = new Set(SLA_ALERT_STATUSES);
  const status = statusParam && validStatuses.has(statusParam as "firing") ? (statusParam as "firing" | "resolved" | "acknowledged") : undefined;
  const limit = Math.min(Math.max(parseInt(c.req.query("limit") ?? "100", 10) || 100, 1), 500);

  try {
    const alerts = await sla.getAlerts(status, limit);
    return c.json({ alerts }, 200);
  } catch (err) {
    log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId }, "Failed to fetch SLA alerts");
    return c.json({ error: "internal_error", message: "Failed to load SLA alerts.", requestId }, 500);
  }
});

// ── Get thresholds ───────────────────────────────────────────────────

platformSLA.openapi(getThresholdsRoute, async (c) => {
  const requestId = c.get("requestId");

  const sla = await loadSLA();
  if (!sla) {
    return c.json({ error: "not_available", message: "SLA monitoring requires enterprise features to be enabled.", requestId }, 404);
  }

  try {
    const thresholds = await sla.getThresholds();
    return c.json(thresholds, 200);
  } catch (err) {
    log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId }, "Failed to read SLA thresholds");
    return c.json({ error: "internal_error", message: "Failed to read SLA thresholds.", requestId }, 500);
  }
});

// ── Update thresholds ────────────────────────────────────────────────

platformSLA.openapi(updateThresholdsRoute, async (c) => {
  const requestId = c.get("requestId");

  const sla = await loadSLA();
  if (!sla) {
    return c.json({ error: "not_available", message: "SLA monitoring requires enterprise features to be enabled.", requestId }, 404);
  }

  const body = c.req.valid("json");

  try {
    await sla.updateThresholds(body);
    log.info({ thresholds: body, requestId }, "SLA thresholds updated by platform admin");
    return c.json({ message: "Thresholds updated.", thresholds: body }, 200);
  } catch (err) {
    log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId }, "Failed to update SLA thresholds");
    return c.json({ error: "internal_error", message: "Failed to update SLA thresholds.", requestId }, 500);
  }
});

// ── Acknowledge alert ────────────────────────────────────────────────

platformSLA.openapi(acknowledgeAlertRoute, async (c) => {
  const requestId = c.get("requestId");

  const sla = await loadSLA();
  if (!sla) {
    return c.json({ error: "not_available", message: "SLA monitoring requires enterprise features to be enabled.", requestId }, 404);
  }

  const alertId = c.req.param("alertId");
  const authResult = c.get("authResult");
  if (!authResult.user?.id) {
    log.error({ requestId, alertId }, "SLA alert acknowledge attempted without authenticated user identity");
    return c.json({ error: "auth_error", message: "User identity could not be determined.", requestId }, 401);
  }
  const actorId = authResult.user.id;

  try {
    const acknowledged = await sla.acknowledgeAlert(alertId, actorId);
    if (!acknowledged) {
      return c.json({ error: "not_firing", message: "Alert is not in firing state.", requestId }, 400);
    }
    log.info({ alertId, actorId, requestId }, "SLA alert acknowledged");
    return c.json({ message: "Alert acknowledged.", alertId }, 200);
  } catch (err) {
    log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId, alertId }, "Failed to acknowledge SLA alert");
    return c.json({ error: "internal_error", message: "Failed to acknowledge alert.", requestId }, 500);
  }
});

// ── Evaluate alerts ──────────────────────────────────────────────────

platformSLA.openapi(evaluateAlertsRoute, async (c) => {
  const requestId = c.get("requestId");

  const sla = await loadSLA();
  if (!sla) {
    return c.json({ error: "not_available", message: "SLA monitoring requires enterprise features to be enabled.", requestId }, 404);
  }

  try {
    const newAlerts = await sla.evaluateAlerts();
    return c.json({ newAlerts }, 200);
  } catch (err) {
    log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId }, "Failed to evaluate SLA alerts");
    return c.json({ error: "internal_error", message: "Failed to evaluate alerts.", requestId }, 500);
  }
});

export { platformSLA };
