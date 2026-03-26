/**
 * Compliance report generation engine.
 *
 * Two report types:
 * 1. Data Access Report — who queried what tables, when, how often
 * 2. User Activity Report — query counts, last login, tables accessed, role info
 *
 * Both reports query the internal DB (audit_log + user/session/member tables)
 * and are enterprise-gated via requireEnterprise("compliance").
 */

import { requireEnterprise } from "../index";
import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import { createLogger } from "@atlas/api/lib/logger";
import type {
  ComplianceReportFilters,
  DataAccessReport,
  DataAccessRow,
  UserActivityReport,
  UserActivityRow,
} from "@useatlas/types";

const log = createLogger("ee:compliance-reports");

// ── Validation ──────────────────────────────────────────────────

function validateFilters(filters: ComplianceReportFilters): void {
  if (isNaN(Date.parse(filters.startDate))) {
    throw new ReportError(`Invalid startDate: ${filters.startDate}`, "validation");
  }
  if (isNaN(Date.parse(filters.endDate))) {
    throw new ReportError(`Invalid endDate: ${filters.endDate}`, "validation");
  }
  if (new Date(filters.startDate) > new Date(filters.endDate)) {
    throw new ReportError("startDate must be before endDate", "validation");
  }
}

// ── Error type ──────────────────────────────────────────────────

export type ReportErrorCode = "validation" | "not_available";

export class ReportError extends Error {
  constructor(message: string, public readonly code: ReportErrorCode) {
    super(message);
    this.name = "ReportError";
  }
}

// ── Data Access Report ──────────────────────────────────────────

interface DataAccessQueryRow {
  table_name: string;
  user_id: string;
  user_email: string | null;
  query_count: string;
  all_columns: unknown;
  first_access: string;
  last_access: string;
  [key: string]: unknown;
}

export async function generateDataAccessReport(
  orgId: string,
  filters: ComplianceReportFilters,
): Promise<DataAccessReport> {
  requireEnterprise("compliance");
  if (!hasInternalDB()) {
    throw new ReportError("Internal database not available", "not_available");
  }
  validateFilters(filters);

  const conditions: string[] = ["a.org_id = $1", "a.success = true"];
  const params: unknown[] = [orgId];

  params.push(filters.startDate);
  conditions.push(`a.timestamp >= $${params.length}`);
  params.push(filters.endDate);
  conditions.push(`a.timestamp <= $${params.length}`);

  if (filters.userId) {
    params.push(filters.userId);
    conditions.push(`a.user_id = $${params.length}`);
  }
  if (filters.table) {
    params.push(filters.table);
    conditions.push(`a.tables_accessed @> to_jsonb($${params.length}::text)`);
  }

  const whereClause = conditions.join(" AND ");

  // Flatten tables_accessed JSONB array, group by table + user
  const rows = await internalQuery<DataAccessQueryRow>(`
    SELECT
      t.table_name,
      a.user_id,
      u.email AS user_email,
      COUNT(*)::text AS query_count,
      a.columns_accessed AS all_columns,
      MIN(a.timestamp)::text AS first_access,
      MAX(a.timestamp)::text AS last_access
    FROM audit_log a
    CROSS JOIN LATERAL jsonb_array_elements_text(
      CASE WHEN jsonb_typeof(a.tables_accessed) = 'array' THEN a.tables_accessed ELSE '[]'::jsonb END
    ) AS t(table_name)
    LEFT JOIN "user" u ON a.user_id = u.id
    WHERE ${whereClause}
    GROUP BY t.table_name, a.user_id, u.email, a.columns_accessed
    ORDER BY COUNT(*) DESC
    LIMIT 10000
  `, params);

  // Aggregate: merge rows per (table, user) since columns_accessed varies per query
  const aggregated = new Map<string, DataAccessRow>();
  for (const row of rows) {
    const key = `${row.table_name}::${row.user_id}`;
    const existing = aggregated.get(key);
    const cols = parseJsonbArray(row.all_columns);
    if (existing) {
      existing.queryCount += parseInt(row.query_count, 10);
      for (const c of cols) {
        if (!existing.uniqueColumns.includes(c)) existing.uniqueColumns.push(c);
      }
      if (row.first_access < existing.firstAccess) existing.firstAccess = row.first_access;
      if (row.last_access > existing.lastAccess) existing.lastAccess = row.last_access;
    } else {
      aggregated.set(key, {
        tableName: row.table_name,
        userId: row.user_id,
        userEmail: row.user_email,
        userRole: null, // filled below
        queryCount: parseInt(row.query_count, 10),
        uniqueColumns: cols,
        hasPII: false, // filled below
        firstAccess: row.first_access,
        lastAccess: row.last_access,
      });
    }
  }

  const result = [...aggregated.values()];

  // Enrich with role + PII status concurrently (independent queries)
  if (result.length > 0) {
    const userIds = [...new Set(result.map((r) => r.userId).filter(Boolean))];

    const [roleResult, piiResult] = await Promise.allSettled([
      // Role enrichment from member table
      userIds.length > 0
        ? internalQuery<{ user_id: string; role: string }>(
            `SELECT "userId" AS user_id, role FROM member WHERE "organizationId" = $1 AND "userId" IN (${userIds.map((_, i) => `$${i + 2}`).join(", ")})`,
            [orgId, ...userIds],
          )
        : Promise.resolve([]),
      // PII enrichment from pii_column_classifications
      internalQuery<{ table_name: string }>(
        `SELECT DISTINCT table_name FROM pii_column_classifications WHERE org_id = $1 AND dismissed = false`,
        [orgId],
      ),
    ]);

    if (roleResult.status === "fulfilled") {
      const roleMap = new Map(roleResult.value.map((r) => [r.user_id, r.role]));
      for (const row of result) {
        row.userRole = roleMap.get(row.userId) ?? null;
      }
    } else {
      log.warn(
        { err: roleResult.reason instanceof Error ? roleResult.reason.message : String(roleResult.reason) },
        "Could not fetch roles from member table",
      );
    }

    if (piiResult.status === "fulfilled") {
      const piiTables = new Set(piiResult.value.map((r) => r.table_name.toLowerCase()));
      for (const row of result) {
        row.hasPII = piiTables.has(row.tableName.toLowerCase());
      }
    } else {
      log.warn(
        { err: piiResult.reason instanceof Error ? piiResult.reason.message : String(piiResult.reason) },
        "Could not enrich PII status — table may not exist yet",
      );
    }
  }

  // Apply role filter (after enrichment)
  const filtered = filters.role
    ? result.filter((r) => r.userRole === filters.role)
    : result;

  // Build summary
  const uniqueUsers = new Set(filtered.map((r) => r.userId));
  const uniqueTables = new Set(filtered.map((r) => r.tableName));
  const totalQueries = filtered.reduce((sum, r) => sum + r.queryCount, 0);
  const piiTablesAccessed = filtered.filter((r) => r.hasPII).length > 0
    ? new Set(filtered.filter((r) => r.hasPII).map((r) => r.tableName)).size
    : 0;

  return {
    rows: filtered,
    summary: {
      totalQueries,
      uniqueUsers: uniqueUsers.size,
      uniqueTables: uniqueTables.size,
      piiTablesAccessed,
    },
    filters,
    generatedAt: new Date().toISOString(),
  };
}

// ── User Activity Report ────────────────────────────────────────

interface UserActivityQueryRow {
  user_id: string;
  user_email: string | null;
  total_queries: string;
  tables_list: unknown;
  last_active_at: string | null;
  [key: string]: unknown;
}

export async function generateUserActivityReport(
  orgId: string,
  filters: ComplianceReportFilters,
): Promise<UserActivityReport> {
  requireEnterprise("compliance");
  if (!hasInternalDB()) {
    throw new ReportError("Internal database not available", "not_available");
  }
  validateFilters(filters);

  const conditions: string[] = ["a.org_id = $1", "a.success = true"];
  const params: unknown[] = [orgId];

  params.push(filters.startDate);
  conditions.push(`a.timestamp >= $${params.length}`);
  params.push(filters.endDate);
  conditions.push(`a.timestamp <= $${params.length}`);

  if (filters.userId) {
    params.push(filters.userId);
    conditions.push(`a.user_id = $${params.length}`);
  }
  if (filters.table) {
    params.push(filters.table);
    conditions.push(`a.tables_accessed @> to_jsonb($${params.length}::text)`);
  }

  const whereClause = conditions.join(" AND ");

  const rows = await internalQuery<UserActivityQueryRow>(`
    SELECT
      a.user_id,
      u.email AS user_email,
      COUNT(*)::text AS total_queries,
      jsonb_agg(DISTINCT t.table_name) FILTER (WHERE t.table_name IS NOT NULL) AS tables_list,
      MAX(a.timestamp)::text AS last_active_at
    FROM audit_log a
    LEFT JOIN "user" u ON a.user_id = u.id
    LEFT JOIN LATERAL jsonb_array_elements_text(
      CASE WHEN jsonb_typeof(a.tables_accessed) = 'array' THEN a.tables_accessed ELSE '[]'::jsonb END
    ) AS t(table_name) ON true
    WHERE ${whereClause}
    GROUP BY a.user_id, u.email
    ORDER BY COUNT(*) DESC
    LIMIT 5000
  `, params);

  // Enrich with login + role data concurrently (independent queries)
  const userIds = rows.map((r) => r.user_id).filter(Boolean);
  const loginMap = new Map<string, string>();
  const roleMap = new Map<string, string>();

  if (userIds.length > 0) {
    const [loginResult, roleResult] = await Promise.allSettled([
      internalQuery<{ user_id: string; last_login: string }>(
        `SELECT "userId" AS user_id, MAX("createdAt")::text AS last_login
         FROM session WHERE "userId" IN (${userIds.map((_, i) => `$${i + 1}`).join(", ")})
         GROUP BY "userId"`,
        userIds,
      ),
      internalQuery<{ user_id: string; role: string }>(
        `SELECT "userId" AS user_id, role FROM member WHERE "organizationId" = $1 AND "userId" IN (${userIds.map((_, i) => `$${i + 2}`).join(", ")})`,
        [orgId, ...userIds],
      ),
    ]);

    if (loginResult.status === "fulfilled") {
      for (const r of loginResult.value) loginMap.set(r.user_id, r.last_login);
    } else {
      log.warn(
        { err: loginResult.reason instanceof Error ? loginResult.reason.message : String(loginResult.reason) },
        "Could not fetch login data from session table",
      );
    }

    if (roleResult.status === "fulfilled") {
      for (const r of roleResult.value) roleMap.set(r.user_id, r.role);
    } else {
      log.warn(
        { err: roleResult.reason instanceof Error ? roleResult.reason.message : String(roleResult.reason) },
        "Could not fetch roles from member table",
      );
    }
  }

  const activityRows: UserActivityRow[] = rows.map((row) => ({
    userId: row.user_id,
    userEmail: row.user_email,
    role: roleMap.get(row.user_id) ?? null,
    totalQueries: parseInt(row.total_queries, 10),
    tablesAccessed: parseJsonbArray(row.tables_list),
    lastActiveAt: row.last_active_at,
    lastLoginAt: loginMap.get(row.user_id) ?? null,
  }));

  // Apply role filter
  const filtered = filters.role
    ? activityRows.filter((r) => r.role === filters.role)
    : activityRows;

  const totalQueries = filtered.reduce((sum, r) => sum + r.totalQueries, 0);
  const activeUsers = filtered.filter((r) => r.totalQueries > 0).length;

  return {
    rows: filtered,
    summary: {
      totalUsers: filtered.length,
      activeUsers,
      totalQueries,
    },
    filters,
    generatedAt: new Date().toISOString(),
  };
}

// ── CSV export ──────────────────────────────────────────────────

const MAX_EXPORT_ROWS = 50_000;

function csvField(val: string | null | undefined): string {
  let s = val ?? "";
  // Guard against CSV formula injection in spreadsheet software
  if (/^[=+\-@\t\r]/.test(s)) {
    s = `'${s}`;
  }
  if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function dataAccessReportToCSV(report: DataAccessReport): string {
  const header = "table_name,user_id,user_email,user_role,query_count,unique_columns,has_pii,first_access,last_access\n";
  const rows = report.rows.slice(0, MAX_EXPORT_ROWS).map((r) =>
    [
      csvField(r.tableName),
      csvField(r.userId),
      csvField(r.userEmail),
      csvField(r.userRole),
      String(r.queryCount),
      csvField(r.uniqueColumns.join("; ")),
      r.hasPII ? "true" : "false",
      csvField(r.firstAccess),
      csvField(r.lastAccess),
    ].join(","),
  );
  return header + rows.join("\n");
}

export function userActivityReportToCSV(report: UserActivityReport): string {
  const header = "user_id,user_email,role,total_queries,tables_accessed,last_active_at,last_login_at\n";
  const rows = report.rows.slice(0, MAX_EXPORT_ROWS).map((r) =>
    [
      csvField(r.userId),
      csvField(r.userEmail),
      csvField(r.role),
      String(r.totalQueries),
      csvField(r.tablesAccessed.join("; ")),
      csvField(r.lastActiveAt),
      csvField(r.lastLoginAt),
    ].join(","),
  );
  return header + rows.join("\n");
}

// ── Helpers ─────────────────────────────────────────────────────

function parseJsonbArray(val: unknown): string[] {
  if (Array.isArray(val)) return val.filter((v): v is string => typeof v === "string");
  if (typeof val === "string") {
    try {
      const parsed = JSON.parse(val);
      if (Array.isArray(parsed)) return parsed.filter((v): v is string => typeof v === "string");
    } catch {
      // intentionally ignored: val is not JSON
    }
  }
  return [];
}
