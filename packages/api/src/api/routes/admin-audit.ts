/**
 * Admin audit log routes.
 *
 * Mounted under /api/v1/admin/audit via admin.route().
 * Org-scoped: all queries filter on audit_log.org_id matching the caller's
 * active organization. Includes list, export (CSV), stats, facets, and
 * five analytics endpoints (volume, slow, frequent, errors, users).
 */

import { Effect } from "effect";
import { createRoute, z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { createLogger } from "@atlas/api/lib/logger";
import { runEffect } from "@atlas/api/lib/effect/hono";
import { AuthContext } from "@atlas/api/lib/effect/services";
import { internalQuery } from "@atlas/api/lib/db/internal";
import { ErrorSchema, AuthErrorSchema, parsePagination, escapeIlike } from "./shared-schemas";
import { createAdminRouter, requireOrgContext } from "./admin-router";

const log = createLogger("admin-audit");

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

type AuditFilterResult =
  | { ok: true; conditions: string[]; params: unknown[]; paramIdx: number }
  | { ok: false; error: string; message: string; status: 400 };

/**
 * Build WHERE conditions for audit list + export endpoints.
 * The orgId condition is always first ($1).
 */
function buildAuditFilters(
  orgId: string,
  query: (key: string) => string | undefined,
): AuditFilterResult {
  const conditions: string[] = ["a.deleted_at IS NULL", "a.org_id = $1"];
  const params: unknown[] = [orgId];
  let paramIdx = 2;

  const user = query("user");
  if (user) {
    conditions.push(`a.user_id = $${paramIdx++}`);
    params.push(user);
  }

  const success = query("success");
  if (success === "true" || success === "false") {
    conditions.push(`a.success = $${paramIdx++}`);
    params.push(success === "true");
  }

  const from = query("from");
  if (from) {
    if (isNaN(Date.parse(from))) {
      return { ok: false, error: "invalid_request", message: `Invalid 'from' date format: "${from}". Use ISO 8601 (e.g. 2026-01-01).`, status: 400 };
    }
    conditions.push(`a.timestamp >= $${paramIdx++}`);
    params.push(from);
  }

  const to = query("to");
  if (to) {
    if (isNaN(Date.parse(to))) {
      return { ok: false, error: "invalid_request", message: `Invalid 'to' date format: "${to}". Use ISO 8601 (e.g. 2026-03-03).`, status: 400 };
    }
    conditions.push(`a.timestamp <= $${paramIdx++}`);
    params.push(to);
  }

  const connection = query("connection");
  if (connection) {
    conditions.push(`a.source_id = $${paramIdx++}`);
    params.push(connection);
  }

  const table = query("table");
  if (table) {
    conditions.push(`a.tables_accessed ? $${paramIdx++}`);
    params.push(table.toLowerCase());
  }

  const column = query("column");
  if (column) {
    conditions.push(`a.columns_accessed ? $${paramIdx++}`);
    params.push(column.toLowerCase());
  }

  const search = query("search");
  if (search) {
    const term = `%${escapeIlike(search)}%`;
    conditions.push(`(a.sql ILIKE $${paramIdx} OR u.email ILIKE $${paramIdx} OR a.error ILIKE $${paramIdx})`);
    params.push(term);
    paramIdx++;
  }

  return { ok: true, conditions, params, paramIdx };
}

/** Build org-scoped WHERE clause from optional date range query params. */
function analyticsDateRange(
  orgId: string,
  queryFn: (name: string) => string | undefined,
) {
  const conditions: string[] = ["deleted_at IS NULL", "org_id = $1"];
  const params: unknown[] = [orgId];
  let idx = 2;

  const from = queryFn("from");
  if (from) {
    if (isNaN(Date.parse(from))) return { error: `Invalid 'from' date format. Use ISO 8601 (e.g. 2026-01-01).` } as const;
    conditions.push(`timestamp >= $${idx++}`);
    params.push(from);
  }

  const to = queryFn("to");
  if (to) {
    if (isNaN(Date.parse(to))) return { error: `Invalid 'to' date format. Use ISO 8601 (e.g. 2026-01-01).` } as const;
    conditions.push(`timestamp <= $${idx++}`);
    params.push(to);
  }

  const where = `WHERE ${conditions.join(" AND ")}`;
  return { where, params, nextIdx: idx } as const;
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const listAuditRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Admin — Audit"],
  summary: "Query audit log",
  description: "Returns paginated audit log entries. Scoped to active organization.",
  responses: {
    200: { description: "Audit log entries", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    400: { description: "Invalid filter", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Internal database not configured", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const exportAuditRoute = createRoute({
  method: "get",
  path: "/export",
  tags: ["Admin — Audit"],
  summary: "Export audit log as CSV",
  description: "Exports audit log entries as a CSV file (up to 10,000 rows). Scoped to active organization.",
  responses: {
    200: { description: "CSV file", content: { "text/csv": { schema: z.string() } } },
    400: { description: "Invalid filter", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Internal database not configured", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const getAuditStatsRoute = createRoute({
  method: "get",
  path: "/stats",
  tags: ["Admin — Audit"],
  summary: "Audit statistics",
  description: "Returns aggregate audit stats. Scoped to active organization.",
  responses: {
    200: { description: "Audit statistics", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Internal database not configured", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const getAuditFacetsRoute = createRoute({
  method: "get",
  path: "/facets",
  tags: ["Admin — Audit"],
  summary: "Audit filter facets",
  description: "Returns distinct tables and columns for filter dropdowns. Scoped to active organization.",
  responses: {
    200: { description: "Facet values", content: { "application/json": { schema: z.object({ tables: z.array(z.string()), columns: z.array(z.string()) }) } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Internal database not configured", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const auditVolumeRoute = createRoute({
  method: "get",
  path: "/analytics/volume",
  tags: ["Admin — Audit Analytics"],
  summary: "Query volume over time",
  description: "Returns queries per day. Scoped to active organization.",
  responses: {
    200: { description: "Volume data", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    400: { description: "Invalid date format", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Internal database not configured", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const auditSlowRoute = createRoute({
  method: "get",
  path: "/analytics/slow",
  tags: ["Admin — Audit Analytics"],
  summary: "Slowest queries",
  description: "Returns top 20 queries by average duration. Scoped to active organization.",
  responses: {
    200: { description: "Slow query data", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    400: { description: "Invalid date format", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Internal database not configured", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const auditFrequentRoute = createRoute({
  method: "get",
  path: "/analytics/frequent",
  tags: ["Admin — Audit Analytics"],
  summary: "Most frequent queries",
  description: "Returns top 20 queries by execution count. Scoped to active organization.",
  responses: {
    200: { description: "Frequent query data", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    400: { description: "Invalid date format", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Internal database not configured", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const auditErrorsRoute = createRoute({
  method: "get",
  path: "/analytics/errors",
  tags: ["Admin — Audit Analytics"],
  summary: "Error distribution",
  description: "Returns error count grouped by error message. Scoped to active organization.",
  responses: {
    200: { description: "Error analytics data", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    400: { description: "Invalid date format", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Internal database not configured", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const auditUsersRoute = createRoute({
  method: "get",
  path: "/analytics/users",
  tags: ["Admin — Audit Analytics"],
  summary: "Per-user stats",
  description: "Returns per-user query stats. Scoped to active organization.",
  responses: {
    200: { description: "User analytics data", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    400: { description: "Invalid date format", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Internal database not configured", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const adminAudit = createAdminRouter();
adminAudit.use(requireOrgContext());

// GET / — paginated audit log
adminAudit.openapi(listAuditRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { orgId } = yield* AuthContext;
    const { limit, offset } = parsePagination(c);

    const filters = buildAuditFilters(orgId!, (k) => c.req.query(k));
    if (!filters.ok) {
      return c.json({ error: filters.error, message: filters.message, requestId: c.get("requestId") as string }, filters.status);
    }
    const { conditions, params, paramIdx } = filters;
    const whereClause = `WHERE ${conditions.join(" AND ")}`;

    const [countResult, rows] = yield* Effect.promise(() => Promise.all([
      internalQuery<{ count: string }>(
        `SELECT COUNT(*) as count FROM audit_log a LEFT JOIN "user" u ON a.user_id = u.id ${whereClause}`,
        params,
      ),
      internalQuery<{
        id: string; timestamp: string; user_id: string | null; sql: string;
        duration_ms: number; row_count: number | null; success: boolean;
        error: string | null; source_id: string | null; source_type: string | null;
        target_host: string | null; user_label: string | null; auth_mode: string;
        user_email: string | null; tables_accessed: string[] | null;
        columns_accessed: string[] | null;
      }>(
        `SELECT a.*, u.email AS user_email
         FROM audit_log a
         LEFT JOIN "user" u ON a.user_id = u.id
         ${whereClause} ORDER BY a.timestamp DESC LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
        [...params, limit, offset],
      ),
    ]));

    return c.json({
      rows,
      total: parseInt(String(countResult[0]?.count ?? "0"), 10),
      limit,
      offset,
    }, 200);
  }), { label: "query audit log" });
});

// GET /export — CSV export
adminAudit.openapi(exportAuditRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { orgId } = yield* AuthContext;

    const filters = buildAuditFilters(orgId!, (k) => c.req.query(k));
    if (!filters.ok) {
      return c.json({ error: filters.error, message: filters.message, requestId: c.get("requestId") as string }, filters.status);
    }
    const { conditions, params, paramIdx } = filters;
    const whereClause = `WHERE ${conditions.join(" AND ")}`;
    const exportLimit = 10000;

    const [countResult, rows] = yield* Effect.promise(() => Promise.all([
      internalQuery<{ count: string }>(
        `SELECT COUNT(*) as count FROM audit_log a LEFT JOIN "user" u ON a.user_id = u.id ${whereClause}`,
        params,
      ),
      internalQuery<{
        id: string; timestamp: string; user_id: string | null; sql: string;
        duration_ms: number; row_count: number | null; success: boolean;
        error: string | null; source_id: string | null; user_email: string | null;
        tables_accessed: string[] | null; columns_accessed: string[] | null;
      }>(
        `SELECT a.id, a.timestamp, a.user_id, a.sql, a.duration_ms, a.row_count, a.success, a.error, a.source_id, a.tables_accessed, a.columns_accessed, u.email AS user_email
         FROM audit_log a
         LEFT JOIN "user" u ON a.user_id = u.id
         ${whereClause} ORDER BY a.timestamp DESC LIMIT $${paramIdx}`,
        [...params, exportLimit],
      ),
    ]));

    const totalAvailable = parseInt(String(countResult[0]?.count ?? "0"), 10);
    const csvHeader = "id,timestamp,user,sql,duration_ms,row_count,success,error,connection,tables_accessed,columns_accessed\n";
    const csvRows = rows.map((r) => [
      csvField(r.id), csvField(r.timestamp),
      csvField(r.user_email ?? r.user_id ?? ""),
      csvField(r.sql), String(r.duration_ms), String(r.row_count ?? ""),
      String(r.success), csvField(r.error), csvField(r.source_id),
      csvField(r.tables_accessed ? r.tables_accessed.join("; ") : null),
      csvField(r.columns_accessed ? r.columns_accessed.join("; ") : null),
    ].join(","));

    const csv = csvHeader + csvRows.join("\n");
    const filename = `audit-log-${new Date().toISOString().slice(0, 10)}.csv`;
    const truncated = totalAvailable > exportLimit;

    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        ...(truncated && {
          "X-Export-Truncated": "true",
          "X-Export-Total": String(totalAvailable),
          "X-Export-Limit": String(exportLimit),
        }),
      },
    });
  }), { label: "export audit log" });
});

// GET /stats — aggregate stats
adminAudit.openapi(getAuditStatsRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { orgId } = yield* AuthContext;

    const [totalResult, dailyResult] = yield* Effect.promise(() => Promise.all([
      internalQuery<{ total: string; errors: string }>(
        `SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE NOT success) as errors FROM audit_log WHERE deleted_at IS NULL AND org_id = $1`,
        [orgId!],
      ),
      internalQuery<{ day: string; count: string }>(
        `SELECT DATE(timestamp) as day, COUNT(*) as count FROM audit_log WHERE deleted_at IS NULL AND org_id = $1 AND timestamp >= NOW() - INTERVAL '7 days' GROUP BY DATE(timestamp) ORDER BY day DESC`,
        [orgId!],
      ),
    ]));

    const total = parseInt(String(totalResult[0]?.total ?? "0"), 10);
    const errors = parseInt(String(totalResult[0]?.errors ?? "0"), 10);

    return c.json({
      totalQueries: total,
      totalErrors: errors,
      errorRate: total > 0 ? (errors / total) * 100 : 0,
      queriesPerDay: dailyResult.map((r) => ({
        day: r.day,
        count: parseInt(String(r.count), 10),
      })),
    }, 200);
  }), { label: "query audit stats" });
});

// GET /facets — filter dropdown values
adminAudit.openapi(getAuditFacetsRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { orgId } = yield* AuthContext;

    const [tableResult, columnResult] = yield* Effect.promise(() => Promise.allSettled([
      internalQuery<{ val: string }>(
        `SELECT DISTINCT jsonb_array_elements_text(tables_accessed) AS val FROM audit_log WHERE deleted_at IS NULL AND org_id = $1 AND tables_accessed IS NOT NULL AND jsonb_typeof(tables_accessed) = 'array' ORDER BY val LIMIT 200`,
        [orgId!],
      ),
      internalQuery<{ val: string }>(
        `SELECT DISTINCT jsonb_array_elements_text(columns_accessed) AS val FROM audit_log WHERE deleted_at IS NULL AND org_id = $1 AND columns_accessed IS NOT NULL AND jsonb_typeof(columns_accessed) = 'array' ORDER BY val LIMIT 200`,
        [orgId!],
      ),
    ]));

    if (tableResult.status === "rejected") {
      log.warn({ err: tableResult.reason instanceof Error ? tableResult.reason : new Error(String(tableResult.reason)) }, "Failed to load table facets");
    }
    if (columnResult.status === "rejected") {
      log.warn({ err: columnResult.reason instanceof Error ? columnResult.reason : new Error(String(columnResult.reason)) }, "Failed to load column facets");
    }

    const warnings: string[] = [];
    if (tableResult.status === "rejected") warnings.push("Failed to load table filter values");
    if (columnResult.status === "rejected") warnings.push("Failed to load column filter values");

    return c.json({
      tables: tableResult.status === "fulfilled" ? tableResult.value.map((r) => r.val) : [],
      columns: columnResult.status === "fulfilled" ? columnResult.value.map((r) => r.val) : [],
      ...(warnings.length > 0 && { warnings }),
    }, 200);
  }), { label: "query audit facets" });
});

// GET /analytics/volume — queries per day
adminAudit.openapi(auditVolumeRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { orgId } = yield* AuthContext;
    const range = analyticsDateRange(orgId!, (k) => c.req.query(k));
    if ("error" in range) {
      throw new HTTPException(400, { res: Response.json({ error: "invalid_request", message: range.error, requestId: c.get("requestId") as string }, { status: 400 }) });
    }

    const rows = yield* Effect.promise(() => internalQuery<{ day: string; count: string; errors: string }>(
      `SELECT DATE(timestamp) as day, COUNT(*) as count, COUNT(*) FILTER (WHERE NOT success) as errors
       FROM audit_log ${range.where}
       GROUP BY DATE(timestamp) ORDER BY day`,
      range.params,
    ));

    return c.json({
      volume: rows.map((r) => ({
        day: r.day,
        count: parseInt(String(r.count), 10),
        errors: parseInt(String(r.errors), 10),
      })),
    }, 200);
  }), { label: "query volume analytics" });
});

// GET /analytics/slow — top 20 by avg duration
adminAudit.openapi(auditSlowRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { orgId } = yield* AuthContext;
    const range = analyticsDateRange(orgId!, (k) => c.req.query(k));
    if ("error" in range) {
      throw new HTTPException(400, { res: Response.json({ error: "invalid_request", message: range.error, requestId: c.get("requestId") as string }, { status: 400 }) });
    }

    const rows = yield* Effect.promise(() => internalQuery<{
      query: string; avg_duration: string; max_duration: string; count: string;
    }>(
      `SELECT LEFT(sql, 200) as query, ROUND(AVG(duration_ms)) as avg_duration,
              MAX(duration_ms) as max_duration, COUNT(*) as count
       FROM audit_log ${range.where}
       GROUP BY LEFT(sql, 200) ORDER BY AVG(duration_ms) DESC LIMIT 20`,
      range.params,
    ));

    return c.json({
      queries: rows.map((r) => ({
        query: r.query,
        avgDuration: parseInt(String(r.avg_duration), 10),
        maxDuration: parseInt(String(r.max_duration), 10),
        count: parseInt(String(r.count), 10),
      })),
    }, 200);
  }), { label: "query slow analytics" });
});

// GET /analytics/frequent — top 20 by count
adminAudit.openapi(auditFrequentRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { orgId } = yield* AuthContext;
    const range = analyticsDateRange(orgId!, (k) => c.req.query(k));
    if ("error" in range) {
      throw new HTTPException(400, { res: Response.json({ error: "invalid_request", message: range.error, requestId: c.get("requestId") as string }, { status: 400 }) });
    }

    const rows = yield* Effect.promise(() => internalQuery<{
      query: string; count: string; avg_duration: string; error_count: string;
    }>(
      `SELECT LEFT(sql, 200) as query, COUNT(*) as count,
              ROUND(AVG(duration_ms)) as avg_duration,
              COUNT(*) FILTER (WHERE NOT success) as error_count
       FROM audit_log ${range.where}
       GROUP BY LEFT(sql, 200) ORDER BY COUNT(*) DESC LIMIT 20`,
      range.params,
    ));

    return c.json({
      queries: rows.map((r) => ({
        query: r.query,
        count: parseInt(String(r.count), 10),
        avgDuration: parseInt(String(r.avg_duration), 10),
        errorCount: parseInt(String(r.error_count), 10),
      })),
    }, 200);
  }), { label: "query frequency analytics" });
});

// GET /analytics/errors — error distribution
adminAudit.openapi(auditErrorsRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { orgId } = yield* AuthContext;
    const range = analyticsDateRange(orgId!, (k) => c.req.query(k));
    if ("error" in range) {
      throw new HTTPException(400, { res: Response.json({ error: "invalid_request", message: range.error, requestId: c.get("requestId") as string }, { status: 400 }) });
    }

    const errorCondition = `${range.where} AND NOT success`;
    const rows = yield* Effect.promise(() => internalQuery<{ error: string; count: string }>(
      `SELECT COALESCE(LEFT(error, 150), 'Unknown error') as error, COUNT(*) as count
       FROM audit_log ${errorCondition}
       GROUP BY COALESCE(LEFT(error, 150), 'Unknown error')
       ORDER BY COUNT(*) DESC LIMIT 20`,
      range.params,
    ));

    return c.json({
      errors: rows.map((r) => ({
        error: r.error,
        count: parseInt(String(r.count), 10),
      })),
    }, 200);
  }), { label: "query error analytics" });
});

// GET /analytics/users — per-user stats
adminAudit.openapi(auditUsersRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { orgId } = yield* AuthContext;
    const range = analyticsDateRange(orgId!, (k) => c.req.query(k));
    if ("error" in range) {
      throw new HTTPException(400, { res: Response.json({ error: "invalid_request", message: range.error, requestId: c.get("requestId") as string }, { status: 400 }) });
    }

    const rows = yield* Effect.promise(() => internalQuery<{
      user_id: string; user_email: string | null; count: string;
      avg_duration: string; error_count: string;
    }>(
      `SELECT COALESCE(a.user_id, 'anonymous') as user_id, u.email as user_email,
              COUNT(*) as count, ROUND(AVG(a.duration_ms)) as avg_duration,
              COUNT(*) FILTER (WHERE NOT a.success) as error_count
       FROM audit_log a
       LEFT JOIN "user" u ON a.user_id = u.id
       ${range.where}
       GROUP BY COALESCE(a.user_id, 'anonymous'), u.email
       ORDER BY COUNT(*) DESC LIMIT 50`,
      range.params,
    ));

    return c.json({
      users: rows.map((r) => {
        const count = parseInt(String(r.count), 10);
        const errorCount = parseInt(String(r.error_count), 10);
        return {
          userId: r.user_id,
          userEmail: r.user_email,
          count,
          avgDuration: parseInt(String(r.avg_duration), 10),
          errorCount,
          errorRate: count > 0 ? errorCount / count : 0,
        };
      }),
    }, 200);
  }), { label: "query user analytics" });
});

export { adminAudit };
