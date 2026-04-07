/**
 * Platform admin action log routes.
 *
 * Mounted at /api/v1/platform/actions. Provides a paginated list of all
 * admin action log entries across the platform.
 */

import { createRoute, z } from "@hono/zod-openapi";
import { createPlatformRouter } from "./admin-router";
import { Effect } from "effect";
import { runEffect } from "@atlas/api/lib/effect/hono";
import { RequestContext } from "@atlas/api/lib/effect/services";
import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import {
  ErrorSchema,
  AuthErrorSchema,
  PaginationQuerySchema,
  parsePagination,
} from "./shared-schemas";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const AdminActionSchema = z.object({
  id: z.string(),
  timestamp: z.string(),
  actorId: z.string(),
  actorEmail: z.string(),
  scope: z.enum(["platform", "workspace"]),
  orgId: z.string().nullable(),
  actionType: z.string(),
  targetType: z.string(),
  targetId: z.string(),
  status: z.enum(["success", "failure"]),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  ipAddress: z.string().nullable(),
  requestId: z.string(),
});

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const listActionsRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Platform Admin"],
  summary: "List admin action log",
  description: "SaaS only. Returns a paginated list of all admin action log entries across the platform.",
  request: { query: PaginationQuerySchema },
  responses: {
    200: {
      description: "Admin action log entries",
      content: {
        "application/json": {
          schema: z.object({
            actions: z.array(AdminActionSchema),
            total: z.number(),
            limit: z.number(),
            offset: z.number(),
          }),
        },
      },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Platform admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Internal database not configured", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const platformActions = createPlatformRouter();

platformActions.openapi(listActionsRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;

    if (!hasInternalDB()) {
      return c.json({ error: "not_configured", message: "Internal database not configured.", requestId }, 404);
    }

    const { limit, offset } = parsePagination(c, { limit: 50, maxLimit: 200 });

    const [rows, countRows] = yield* Effect.promise(() => Promise.all([
      internalQuery<{
        id: string;
        timestamp: string;
        actor_id: string;
        actor_email: string;
        scope: "platform" | "workspace";
        org_id: string | null;
        action_type: string;
        target_type: string;
        target_id: string;
        status: "success" | "failure";
        metadata: Record<string, unknown> | null;
        ip_address: string | null;
        request_id: string;
      }>(
        `SELECT id, timestamp, actor_id, actor_email, scope, org_id, action_type, target_type, target_id, status, metadata, ip_address, request_id
         FROM admin_action_log
         ORDER BY timestamp DESC
         LIMIT $1 OFFSET $2`,
        [limit, offset],
      ),
      internalQuery<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM admin_action_log`,
      ),
    ]));

    const actions = rows.map((row) => ({
      id: row.id,
      timestamp: row.timestamp,
      actorId: row.actor_id,
      actorEmail: row.actor_email,
      scope: row.scope,
      orgId: row.org_id,
      actionType: row.action_type,
      targetType: row.target_type,
      targetId: row.target_id,
      status: row.status,
      metadata: row.metadata,
      ipAddress: row.ip_address,
      requestId: row.request_id,
    }));

    return c.json({
      actions,
      total: countRows[0]?.count ?? 0,
      limit,
      offset,
    }, 200);
  }), { label: "list admin actions" });
});

export { platformActions };
