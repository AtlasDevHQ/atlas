/**
 * Admin abuse prevention routes.
 *
 * Mounted under /api/v1/admin/abuse. All routes require admin role.
 * Provides listing of flagged workspaces, reinstatement, and threshold config.
 */

import { createRoute, z } from "@hono/zod-openapi";
import { createLogger } from "@atlas/api/lib/logger";
import {
  listFlaggedWorkspaces,
  reinstateWorkspace,
  getAbuseEvents,
  getAbuseConfig,
} from "@atlas/api/lib/security/abuse";
import { ErrorSchema, AuthErrorSchema } from "./shared-schemas";
import { createAdminRouter } from "./admin-router";

const log = createLogger("admin-abuse");

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const AbuseEventSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  level: z.enum(["none", "warning", "throttled", "suspended"]),
  trigger: z.enum(["query_rate", "error_rate", "unique_tables", "manual"]),
  message: z.string(),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
  actor: z.string(),
});

const AbuseStatusSchema = z.object({
  workspaceId: z.string(),
  workspaceName: z.string().nullable(),
  level: z.enum(["none", "warning", "throttled", "suspended"]),
  trigger: z.enum(["query_rate", "error_rate", "unique_tables", "manual"]).nullable(),
  message: z.string().nullable(),
  updatedAt: z.string(),
  events: z.array(AbuseEventSchema),
});

const ListResponseSchema = z.object({
  workspaces: z.array(AbuseStatusSchema),
  total: z.number(),
});

const ReinstateResponseSchema = z.object({
  success: z.boolean(),
  workspaceId: z.string(),
  message: z.string(),
});

const ConfigResponseSchema = z.object({
  queryRateLimit: z.number(),
  queryRateWindowSeconds: z.number(),
  errorRateThreshold: z.number(),
  uniqueTablesLimit: z.number(),
  throttleDelayMs: z.number(),
});

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const listFlaggedRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Admin — Abuse Prevention"],
  summary: "List flagged workspaces",
  description: "SaaS only. Returns all workspaces with active abuse flags (warning, throttled, or suspended).",
  responses: {
    200: {
      description: "Flagged workspaces",
      content: { "application/json": { schema: ListResponseSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    403: {
      description: "Forbidden — admin role required",
      content: { "application/json": { schema: AuthErrorSchema } },
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

const reinstateRoute = createRoute({
  method: "post",
  path: "/:workspaceId/reinstate",
  tags: ["Admin — Abuse Prevention"],
  summary: "Reinstate a suspended workspace",
  description: "SaaS only. Manually re-enable a workspace that was suspended or throttled due to abuse detection.",
  request: {
    params: z.object({
      workspaceId: z.string(),
    }),
  },
  responses: {
    200: {
      description: "Workspace reinstated",
      content: { "application/json": { schema: ReinstateResponseSchema } },
    },
    400: {
      description: "Workspace not flagged",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    403: {
      description: "Forbidden — admin role required",
      content: { "application/json": { schema: AuthErrorSchema } },
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

const getConfigRoute = createRoute({
  method: "get",
  path: "/config",
  tags: ["Admin — Abuse Prevention"],
  summary: "Current abuse threshold configuration",
  description: "SaaS only. Returns the current abuse detection thresholds (from env vars or defaults).",
  responses: {
    200: {
      description: "Threshold configuration",
      content: { "application/json": { schema: ConfigResponseSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    403: {
      description: "Forbidden — admin role required",
      content: { "application/json": { schema: AuthErrorSchema } },
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

const adminAbuse = createAdminRouter();

// GET / — list flagged workspaces
adminAbuse.openapi(listFlaggedRoute, async (c) => {
  const requestId = c.get("requestId");

  try {
    const workspaces = listFlaggedWorkspaces();

    // Enrich with recent events from DB
    const enriched = await Promise.all(
      workspaces.map(async (ws) => {
        const events = await getAbuseEvents(ws.workspaceId, 10);
        return { ...ws, events };
      }),
    );

    return c.json({ workspaces: enriched, total: enriched.length }, 200);
  } catch (err) {
    log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId }, "Failed to list flagged workspaces");
    return c.json({ error: "internal_error", message: "Failed to list flagged workspaces.", requestId }, 500);
  }
});

// POST /:workspaceId/reinstate — reinstate a workspace
adminAbuse.openapi(reinstateRoute, async (c) => {
  const requestId = c.get("requestId");
  const authResult = c.get("authResult");
  const { workspaceId } = c.req.valid("param");
  const actorId = authResult.user?.id ?? "unknown";

  try {
    const success = reinstateWorkspace(workspaceId, actorId);
    if (!success) {
      return c.json(
        { error: "not_flagged", message: "Workspace is not currently flagged for abuse.", requestId },
        400,
      );
    }

    return c.json({
      success: true,
      workspaceId,
      message: "Workspace reinstated successfully.",
    }, 200);
  } catch (err) {
    log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId, workspaceId }, "Failed to reinstate workspace");
    return c.json({ error: "internal_error", message: "Failed to reinstate workspace.", requestId }, 500);
  }
});

// GET /config — current threshold configuration
adminAbuse.openapi(getConfigRoute, async (c) => {
  const requestId = c.get("requestId");

  try {
    return c.json(getAbuseConfig(), 200);
  } catch (err) {
    log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId }, "Failed to read abuse config");
    return c.json({ error: "internal_error", message: "Failed to read abuse configuration.", requestId }, 500);
  }
});

export { adminAbuse };
