/**
 * Workspace admin action audit log routes.
 *
 * Mounted at /api/v1/admin/admin-actions. Provides a paginated list of
 * admin action log entries scoped to the caller's active organization,
 * with filtering and CSV export.
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
import { buildActionFilters, type ActionFilterParams } from "@atlas/api/lib/audit/filters";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Quote a value for safe CSV output (RFC 4180). */
function csvField(val: string | null | undefined): string {
  const s = val ?? "";
  if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

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

const ActionFilterQuerySchema = PaginationQuerySchema.extend({
  actor: z.string().optional().openapi({ description: "Filter by actor email (partial match)" }),
  actionType: z.string().optional().openapi({ description: "Filter by action type (exact match)" }),
  targetType: z.string().optional().openapi({ description: "Filter by target type (exact match)" }),
  from: z.string().optional().openapi({ description: "Filter actions on or after this date (ISO 8601)" }),
  to: z.string().optional().openapi({ description: "Filter actions on or before this date (ISO 8601)" }),
  search: z.string().optional().openapi({ description: "Free-text search in metadata JSONB" }),
});

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const listActionsRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Admin"],
  summary: "List workspace admin action log",
  description: "Returns a paginated, filterable list of admin action log entries scoped to the caller's active organization.",
  request: { query: ActionFilterQuerySchema },
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
    400: { description: "Invalid filter parameter", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Internal database not configured", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const exportActionsRoute = createRoute({
  method: "get",
  path: "/export",
  tags: ["Admin"],
  summary: "Export workspace admin action log as CSV",
  description: "Exports workspace admin action log entries as a CSV file (up to 10,000 rows). Scoped to the caller's active organization.",
  request: { query: ActionFilterQuerySchema.omit({ limit: true, offset: true }) },
  responses: {
    200: { description: "CSV file", content: { "text/csv": { schema: z.string() } } },
    400: { description: "Invalid filter parameter", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Internal database not configured", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// ---------------------------------------------------------------------------
// Shared query helpers
// ---------------------------------------------------------------------------

interface ActionRow {
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
  [key: string]: unknown;
}

function mapActionRow(row: ActionRow) {
  return {
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
  };
}

function extractFilterParams(queryFn: (key: string) => string | undefined): ActionFilterParams {
  return {
    actor: queryFn("actor"),
    actionType: queryFn("actionType"),
    targetType: queryFn("targetType"),
    from: queryFn("from"),
    to: queryFn("to"),
    search: queryFn("search"),
  };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const adminActions = createAdminRouter();
adminActions.use(requireOrgContext());

adminActions.openapi(listActionsRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { orgId, requestId } = c.get("orgContext");

    const { limit, offset } = parsePagination(c, { limit: 50, maxLimit: 200 });
    const filterParams = extractFilterParams((k) => c.req.query(k));

    // Base conditions: org-scoped + workspace only. Filters start at $2.
    const baseConditions = ["org_id = $1", "scope = 'workspace'"];
    const baseParams: unknown[] = [orgId];

    const filters = buildActionFilters(2, filterParams);
    if (!filters.ok) {
      return c.json({ error: filters.error, message: filters.message, requestId }, filters.status);
    }

    const { conditions: filterConditions, params: filterParamsArr, paramIdx } = filters;
    const allConditions = [...baseConditions, ...filterConditions];
    const allParams = [...baseParams, ...filterParamsArr];
    const whereClause = `WHERE ${allConditions.join(" AND ")}`;

    const [rows, countRows] = yield* Effect.promise(() => Promise.all([
      internalQuery<ActionRow>(
        `SELECT id, timestamp, actor_id, actor_email, scope, org_id, action_type, target_type, target_id, status, metadata, ip_address, request_id
         FROM admin_action_log
         ${whereClause}
         ORDER BY timestamp DESC
         LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
        [...allParams, limit, offset],
      ),
      internalQuery<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM admin_action_log ${whereClause}`,
        allParams,
      ),
    ]));

    const actions = rows.map(mapActionRow);

    return c.json({
      actions,
      total: countRows[0]?.count ?? 0,
      limit,
      offset,
    }, 200);
  }), { label: "list workspace admin actions" });
});

// GET /export — CSV export
adminActions.openapi(exportActionsRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { orgId, requestId } = c.get("orgContext");

    const filterParams = extractFilterParams((k) => c.req.query(k));

    const baseConditions = ["org_id = $1", "scope = 'workspace'"];
    const baseParams: unknown[] = [orgId];

    const filters = buildActionFilters(2, filterParams);
    if (!filters.ok) {
      return c.json({ error: filters.error, message: filters.message, requestId }, filters.status);
    }

    const { conditions: filterConditions, params: filterParamsArr, paramIdx } = filters;
    const allConditions = [...baseConditions, ...filterConditions];
    const allParams = [...baseParams, ...filterParamsArr];
    const whereClause = `WHERE ${allConditions.join(" AND ")}`;
    const exportLimit = 10000;

    const [countRows, rows] = yield* Effect.promise(() => Promise.all([
      internalQuery<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM admin_action_log ${whereClause}`,
        allParams,
      ),
      internalQuery<ActionRow>(
        `SELECT id, timestamp, actor_id, actor_email, scope, org_id, action_type, target_type, target_id, status, metadata, ip_address, request_id
         FROM admin_action_log
         ${whereClause}
         ORDER BY timestamp DESC
         LIMIT $${paramIdx}`,
        [...allParams, exportLimit],
      ),
    ]));

    const totalAvailable = countRows[0]?.count ?? 0;
    const csvHeader = "timestamp,actor_email,action_type,target_type,target_id,scope,org_id,status,metadata,ip_address,request_id\n";
    const csvRows = rows.map((r) => [
      csvField(r.timestamp),
      csvField(r.actor_email),
      csvField(r.action_type),
      csvField(r.target_type),
      csvField(r.target_id),
      csvField(r.scope),
      csvField(r.org_id),
      csvField(r.status),
      csvField(r.metadata ? JSON.stringify(r.metadata) : null),
      csvField(r.ip_address),
      csvField(r.request_id),
    ].join(","));

    const csv = csvHeader + csvRows.join("\n");
    const filename = `admin-actions-${new Date().toISOString().slice(0, 10)}.csv`;
    const truncated = totalAvailable > exportLimit;

    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        ...(truncated && {
          "X-Truncated": "true",
          "X-Total-Count": String(totalAvailable),
        }),
      },
    });
  }), { label: "export workspace admin actions" });
});

export { adminActions };
