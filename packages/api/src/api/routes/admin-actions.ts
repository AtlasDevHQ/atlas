/**
 * Workspace admin action audit log routes.
 *
 * Mounted at /api/v1/admin/admin-actions. Provides a paginated list of
 * admin action log entries scoped to the caller's active organization.
 * Only workspace-scoped actions (or actions explicitly tied to the org)
 * are returned — platform-scoped actions are excluded.
 */

import { createRoute, z } from "@hono/zod-openapi";
import { Effect } from "effect";
import { runEffect } from "@atlas/api/lib/effect/hono";
import { internalQuery } from "@atlas/api/lib/db/internal";
import { createAdminRouter, requireOrgContext } from "./admin-router";
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
  tags: ["Admin"],
  summary: "List workspace admin action log",
  description: "Returns a paginated list of admin action log entries scoped to the caller's active organization.",
  request: { query: PaginationQuerySchema },
  responses: {
    200: {
      description: "Admin action log entries for this workspace",
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
    400: { description: "No active organization", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Internal database not configured", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const adminActions = createAdminRouter();
adminActions.use(requireOrgContext());

adminActions.openapi(listActionsRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { orgId } = c.get("orgContext");

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
         WHERE org_id = $1 AND scope = 'workspace'
         ORDER BY timestamp DESC
         LIMIT $2 OFFSET $3`,
        [orgId, limit, offset],
      ),
      internalQuery<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM admin_action_log WHERE org_id = $1 AND scope = 'workspace'`,
        [orgId],
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
  }), { label: "list workspace admin actions" });
});

export { adminActions };
