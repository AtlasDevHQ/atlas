/**
 * Enterprise audit log retention — configurable retention policies,
 * soft-delete purging, hard-delete cleanup, and compliance export.
 *
 * All mutating operations call `requireEnterpriseEffect("audit-retention")`.
 * Read operations (get policy) are gated too so non-enterprise users
 * don't see partial config states.
 *
 * All exported functions return Effect — callers use `yield*` in Effect.gen.
 *
 * Purge flow:
 *   1. `purgeExpiredEntries(orgId?)` — soft-deletes (sets deleted_at)
 *      entries older than the retention window
 *   2. `hardDeleteExpired()` — permanently removes entries where
 *      deleted_at is older than the hard-delete delay
 */

import { Data, Effect } from "effect";
import { requireEnterpriseEffect, EnterpriseError } from "../index";
import { requireInternalDBEffect } from "../lib/db-guard";
import {
  hasInternalDB,
  internalQuery,
  getInternalDB,
} from "@atlas/api/lib/db/internal";
import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("ee:audit-retention");

// ── Types ────────────────────────────────────────────────────────────

export interface AuditRetentionPolicy {
  orgId: string;
  /** Number of days to retain audit entries. null = unlimited. */
  retentionDays: number | null;
  /** Days after soft-delete before hard-delete. Default 30. */
  hardDeleteDelayDays: number;
  updatedAt: string;
  updatedBy: string | null;
  lastPurgeAt: string | null;
  lastPurgeCount: number | null;
}

export interface SetRetentionPolicyInput {
  retentionDays: number | null;
  hardDeleteDelayDays?: number;
}

export interface PurgeResult {
  orgId: string;
  softDeletedCount: number;
}

export interface HardDeleteResult {
  deletedCount: number;
}

export interface ExportOptions {
  orgId: string;
  format: "csv" | "json";
  startDate?: string;
  endDate?: string;
}

/** Internal row shape from the audit_retention_config table. */
interface RetentionConfigRow {
  id: string;
  org_id: string;
  retention_days: number | null;
  hard_delete_delay_days: number;
  updated_at: string;
  updated_by: string | null;
  last_purge_at: string | null;
  last_purge_count: number | null;
  [key: string]: unknown;
}

/** Audit log row shape for export. */
interface AuditExportRow {
  id: string;
  timestamp: string;
  user_id: string | null;
  user_label: string | null;
  auth_mode: string;
  sql: string;
  duration_ms: number;
  row_count: number | null;
  success: boolean;
  error: string | null;
  source_id: string | null;
  source_type: string | null;
  target_host: string | null;
  tables_accessed: string | null;
  columns_accessed: string | null;
  org_id: string | null;
  user_email: string | null;
  [key: string]: unknown;
}

// ── Constants ────────────────────────────────────────────────────────

/** Minimum allowed retention period in days. */
export const MIN_RETENTION_DAYS = 7;

/** Default hard-delete delay in days after soft-delete. */
export const DEFAULT_HARD_DELETE_DELAY_DAYS = 30;

/** Maximum export rows per request. */
const MAX_EXPORT_ROWS = 50_000;

// ── Typed errors ─────────────────────────────────────────────────────

export type RetentionErrorCode = "validation" | "not_found";

export class RetentionError extends Data.TaggedError("RetentionError")<{
  message: string;
  code: RetentionErrorCode;
}> {}

// ── Row mapping ──────────────────────────────────────────────────────

function rowToPolicy(row: RetentionConfigRow): AuditRetentionPolicy {
  return {
    orgId: row.org_id,
    retentionDays: row.retention_days,
    hardDeleteDelayDays: row.hard_delete_delay_days,
    updatedAt: String(row.updated_at),
    updatedBy: row.updated_by,
    lastPurgeAt: row.last_purge_at ? String(row.last_purge_at) : null,
    lastPurgeCount: row.last_purge_count,
  };
}

// ── Policy CRUD ──────────────────────────────────────────────────────

/**
 * Get the audit retention policy for an organization.
 * Returns null if no policy is configured (unlimited retention).
 */
export const getRetentionPolicy = (orgId: string): Effect.Effect<AuditRetentionPolicy | null, EnterpriseError> =>
  Effect.gen(function* () {
    yield* requireEnterpriseEffect("audit-retention");
    if (!hasInternalDB()) return null;

    const rows = yield* Effect.promise(() => internalQuery<RetentionConfigRow>(
      `SELECT id, org_id, retention_days, hard_delete_delay_days, updated_at, updated_by, last_purge_at, last_purge_count
       FROM audit_retention_config
       WHERE org_id = $1`,
      [orgId],
    ));

    if (rows.length === 0) return null;
    return rowToPolicy(rows[0]);
  });

/**
 * Set or update the audit retention policy for an organization.
 * Validates retention_days >= MIN_RETENTION_DAYS (or null for unlimited).
 */
export const setRetentionPolicy = (
  orgId: string,
  input: SetRetentionPolicyInput,
  updatedBy: string | null,
): Effect.Effect<AuditRetentionPolicy, RetentionError | EnterpriseError | Error> =>
  Effect.gen(function* () {
    yield* requireEnterpriseEffect("audit-retention");
    yield* requireInternalDBEffect("audit retention configuration");

    // Validate retention days
    if (input.retentionDays !== null) {
      if (!Number.isInteger(input.retentionDays) || input.retentionDays < MIN_RETENTION_DAYS) {
        return yield* Effect.fail(new RetentionError({ message: `Retention period must be at least ${MIN_RETENTION_DAYS} days or null (unlimited). Got: ${input.retentionDays}.`, code: "validation" }));
      }
    }

    const hardDeleteDelay = input.hardDeleteDelayDays ?? DEFAULT_HARD_DELETE_DELAY_DAYS;
    if (!Number.isInteger(hardDeleteDelay) || hardDeleteDelay < 0) {
      return yield* Effect.fail(new RetentionError({ message: `Hard delete delay must be a non-negative integer. Got: ${hardDeleteDelay}.`, code: "validation" }));
    }

    const rows = yield* Effect.promise(() => internalQuery<RetentionConfigRow>(
      `INSERT INTO audit_retention_config (org_id, retention_days, hard_delete_delay_days, updated_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (org_id) DO UPDATE SET
         retention_days = EXCLUDED.retention_days,
         hard_delete_delay_days = EXCLUDED.hard_delete_delay_days,
         updated_at = now(),
         updated_by = EXCLUDED.updated_by
       RETURNING id, org_id, retention_days, hard_delete_delay_days, updated_at, updated_by, last_purge_at, last_purge_count`,
      [orgId, input.retentionDays, hardDeleteDelay, updatedBy],
    ));

    if (!rows[0]) return yield* Effect.die(new Error("Failed to upsert audit retention config — no row returned."));

    log.info(
      { orgId, retentionDays: input.retentionDays, hardDeleteDelayDays: hardDeleteDelay },
      "Audit retention policy updated",
    );

    return rowToPolicy(rows[0]);
  });

// ── Purge operations ─────────────────────────────────────────────────

/**
 * Soft-delete audit log entries past the retention window.
 *
 * If orgId is provided, only purges that org's entries.
 * If orgId is null, purges all orgs that have a retention policy.
 *
 * Returns the count of soft-deleted entries per org.
 */
export const purgeExpiredEntries = (orgId?: string): Effect.Effect<PurgeResult[], EnterpriseError> =>
  Effect.gen(function* () {
    yield* requireEnterpriseEffect("audit-retention");
    if (!hasInternalDB()) return [];

    const pool = getInternalDB();
    const results: PurgeResult[] = [];

    // Get all applicable retention configs
    let configs: RetentionConfigRow[];
    if (orgId) {
      configs = yield* Effect.promise(() => internalQuery<RetentionConfigRow>(
        `SELECT org_id, retention_days FROM audit_retention_config WHERE org_id = $1 AND retention_days IS NOT NULL`,
        [orgId],
      ));
    } else {
      configs = yield* Effect.promise(() => internalQuery<RetentionConfigRow>(
        `SELECT org_id, retention_days FROM audit_retention_config WHERE retention_days IS NOT NULL`,
      ));
    }

    for (const config of configs) {
      if (config.retention_days === null) continue;

      const result = yield* Effect.promise(() => pool.query(
        `WITH updated AS (
           UPDATE audit_log
           SET deleted_at = now()
           WHERE org_id = $1
             AND deleted_at IS NULL
             AND timestamp < now() - ($2 || ' days')::interval
           RETURNING 1
         ) SELECT COUNT(*)::int AS cnt FROM updated`,
        [config.org_id, config.retention_days],
      ));

      const count = Number((result.rows[0] as Record<string, unknown>)?.cnt ?? 0);
      results.push({ orgId: config.org_id, softDeletedCount: count });

      // Update last purge metadata
      yield* Effect.promise(() => pool.query(
        `UPDATE audit_retention_config SET last_purge_at = now(), last_purge_count = $1 WHERE org_id = $2`,
        [count, config.org_id],
      ));

      if (count > 0) {
        log.info(
          { orgId: config.org_id, softDeletedCount: count, retentionDays: config.retention_days },
          "Audit log entries soft-deleted",
        );
      }
    }

    return results;
  });

/**
 * Permanently delete audit log entries that were soft-deleted
 * longer ago than the hard-delete delay.
 *
 * Processes all orgs with retention configs.
 */
export const hardDeleteExpired = (orgId?: string): Effect.Effect<HardDeleteResult, EnterpriseError> =>
  Effect.gen(function* () {
    yield* requireEnterpriseEffect("audit-retention");
    if (!hasInternalDB()) return { deletedCount: 0 };

    const pool = getInternalDB();

    // Get retention configs — scoped to orgId when provided, all orgs for scheduler
    const configs = orgId
      ? yield* Effect.promise(() => internalQuery<RetentionConfigRow>(
          `SELECT org_id, hard_delete_delay_days FROM audit_retention_config WHERE org_id = $1`,
          [orgId],
        ))
      : yield* Effect.promise(() => internalQuery<RetentionConfigRow>(
          `SELECT org_id, hard_delete_delay_days FROM audit_retention_config`,
        ));

    let totalDeleted = 0;

    for (const config of configs) {
      const result = yield* Effect.promise(() => pool.query(
        `WITH deleted AS (
           DELETE FROM audit_log
           WHERE org_id = $1
             AND deleted_at IS NOT NULL
             AND deleted_at < now() - ($2 || ' days')::interval
           RETURNING 1
         ) SELECT COUNT(*)::int AS cnt FROM deleted`,
        [config.org_id, config.hard_delete_delay_days],
      ));

      const count = Number((result.rows[0] as Record<string, unknown>)?.cnt ?? 0);
      totalDeleted += count;

      if (count > 0) {
        log.info(
          { orgId: config.org_id, hardDeletedCount: count, delayDays: config.hard_delete_delay_days },
          "Audit log entries permanently deleted",
        );
      }
    }

    return { deletedCount: totalDeleted };
  });

// ── Export ────────────────────────────────────────────────────────────

/** Quote a value for safe CSV output (RFC 4180). */
function csvField(val: string | null | undefined): string {
  const s = val ?? "";
  if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/**
 * Export audit log entries in CSV or JSON format.
 *
 * - Filters by org_id, date range
 * - Excludes soft-deleted entries
 * - Limits to MAX_EXPORT_ROWS
 * - Returns the serialized content and metadata
 */
export const exportAuditLog = (options: ExportOptions): Effect.Effect<{
  content: string;
  format: "csv" | "json";
  rowCount: number;
  totalAvailable: number;
  truncated: boolean;
}, RetentionError | EnterpriseError | Error> =>
  Effect.gen(function* () {
    yield* requireEnterpriseEffect("audit-retention");
    yield* requireInternalDBEffect("audit log export");

    const conditions: string[] = ["a.org_id = $1", "(a.deleted_at IS NULL)"];
    const params: unknown[] = [options.orgId];
    let paramIdx = 2;

    if (options.startDate) {
      if (isNaN(Date.parse(options.startDate))) {
        return yield* Effect.fail(new RetentionError({ message: `Invalid start_date format: "${options.startDate}". Use ISO 8601 (e.g. 2026-01-01).`, code: "validation" }));
      }
      conditions.push(`a.timestamp >= $${paramIdx++}`);
      params.push(options.startDate);
    }

    if (options.endDate) {
      if (isNaN(Date.parse(options.endDate))) {
        return yield* Effect.fail(new RetentionError({ message: `Invalid end_date format: "${options.endDate}". Use ISO 8601 (e.g. 2026-03-01).`, code: "validation" }));
      }
      conditions.push(`a.timestamp <= $${paramIdx++}`);
      params.push(options.endDate);
    }

    const whereClause = `WHERE ${conditions.join(" AND ")}`;

    // Count total matching
    const countResult = yield* Effect.promise(() => internalQuery<{ count: string }>(
      `SELECT COUNT(*) as count FROM audit_log a ${whereClause}`,
      params,
    ));
    const totalAvailable = parseInt(String(countResult[0]?.count ?? "0"), 10);

    // Fetch rows
    const rows = yield* Effect.promise(() => internalQuery<AuditExportRow>(
      `SELECT a.id, a.timestamp, a.user_id, a.user_label, a.auth_mode, a.sql,
              a.duration_ms, a.row_count, a.success, a.error,
              a.source_id, a.source_type, a.target_host,
              a.tables_accessed, a.columns_accessed, a.org_id,
              u.email AS user_email
       FROM audit_log a
       LEFT JOIN "user" u ON a.user_id = u.id
       ${whereClause}
       ORDER BY a.timestamp DESC
       LIMIT $${paramIdx}`,
      [...params, MAX_EXPORT_ROWS],
    ));

    const truncated = totalAvailable > MAX_EXPORT_ROWS;

    if (options.format === "json") {
      const jsonEntries = rows.map((r) => ({
        id: r.id,
        timestamp: r.timestamp,
        userId: r.user_id,
        userEmail: r.user_email,
        userLabel: r.user_label,
        authMode: r.auth_mode,
        sql: r.sql,
        durationMs: r.duration_ms,
        rowCount: r.row_count,
        success: r.success,
        error: r.error,
        sourceId: r.source_id,
        sourceType: r.source_type,
        targetHost: r.target_host,
        tablesAccessed: r.tables_accessed,
        columnsAccessed: r.columns_accessed,
        orgId: r.org_id,
      }));

      return {
        content: JSON.stringify({ entries: jsonEntries, exportedAt: new Date().toISOString(), totalAvailable, truncated }, null, 2),
        format: "json" as const,
        rowCount: rows.length,
        totalAvailable,
        truncated,
      };
    }

    // CSV format
    const csvHeader = "id,timestamp,user_id,user_email,user_label,auth_mode,sql,duration_ms,row_count,success,error,source_id,source_type,target_host,tables_accessed,columns_accessed,org_id\n";
    const csvRows = rows.map((r) => {
      const fields = [
        csvField(r.id),
        csvField(r.timestamp),
        csvField(r.user_id),
        csvField(r.user_email),
        csvField(r.user_label),
        csvField(r.auth_mode),
        csvField(r.sql),
        String(r.duration_ms),
        String(r.row_count ?? ""),
        String(r.success),
        csvField(r.error),
        csvField(r.source_id),
        csvField(r.source_type),
        csvField(r.target_host),
        csvField(typeof r.tables_accessed === "string" ? r.tables_accessed : r.tables_accessed ? JSON.stringify(r.tables_accessed) : null),
        csvField(typeof r.columns_accessed === "string" ? r.columns_accessed : r.columns_accessed ? JSON.stringify(r.columns_accessed) : null),
        csvField(r.org_id),
      ];
      return fields.join(",");
    });

    return {
      content: csvHeader + csvRows.join("\n"),
      format: "csv" as const,
      rowCount: rows.length,
      totalAvailable,
      truncated,
    };
  });
