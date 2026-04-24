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
import { createLogger, getRequestContext } from "@atlas/api/lib/logger";
import { logAdminAction, logAdminActionAwait, ADMIN_ACTIONS } from "@atlas/api/lib/audit";
import { errorMessage } from "@atlas/api/lib/audit/error-scrub";
import { AUDIT_PURGE_SCHEDULER_ACTOR } from "./purge-scheduler";

const log = createLogger("ee:audit-retention");

/**
 * Dedup gate for library-layer audit emissions. The HTTP route handler
 * at `packages/api/src/api/routes/admin-audit-retention.ts` emits richer
 * `audit_retention.*` rows (previous values, ipAddress, read-before-write
 * failure paths) via its own `emitAudit` helper on every mutation. If the
 * library also emitted under HTTP, every admin action would produce two
 * rows. We therefore emit from the library only when there is NO
 * authenticated user in the request context — i.e. the caller is the
 * scheduler or a programmatic (CLI, direct service call) path that has
 * no route-level audit attached. If the route layer is ever refactored
 * to stop emitting, the library-layer row must become the sole emission:
 * update this gate together with that change.
 */
function isHttpContext(): boolean {
  return !!getRequestContext()?.user;
}

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

/**
 * Per-org admin-action-log delete result. F-36 uses direct hard-delete
 * (no soft-delete stage) against the admin trail — the default 7-year
 * retention window is long enough that a recovery gap adds little safety
 * relative to the volume. Shape mirrors `HardDeleteResult` but per-org.
 */
export interface AdminActionPurgeResult {
  orgId: string;
  deletedCount: number;
}

/**
 * Load-bearing compliance label for `user.erase` audit metadata. The three
 * values distinguish the origination path so DSR reporting can split
 * "user hit a self-serve erasure button" from "we processed a formal DSR
 * letter" from "a future automation purged an inactive account." A typo
 * would silently erode the split; `INITIATED_BY_VALUES` pins the set.
 */
export const INITIATED_BY_VALUES = ["self_request", "dsr_request", "scheduled_retention"] as const;
export type AnonymizeInitiatedBy = typeof INITIATED_BY_VALUES[number];

export interface AnonymizeResult {
  /** Count of `admin_action_log` rows scrubbed on this run. */
  anonymizedRowCount: number;
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

    // Library-layer self-audit for non-HTTP callers. The HTTP route path
    // emits its own richer row (previousValues, ipAddress); suppressing
    // here prevents a double-audit when Route → setRetentionPolicy.
    if (!isHttpContext()) {
      logAdminAction({
        actionType: ADMIN_ACTIONS.audit_retention.policyUpdate,
        targetType: "audit_retention",
        targetId: orgId,
        scope: "platform",
        systemActor: AUDIT_PURGE_SCHEDULER_ACTOR,
        metadata: {
          retentionDays: input.retentionDays,
          hardDeleteDelayDays: hardDeleteDelay,
          via: "library",
        },
      });
    }

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
    // Per-org breakdown (only orgs that actually lost rows) for the
    // durable audit metadata. A single cross-org cycle row without this
    // list leaves a reviewer unable to answer "which tenants lost data
    // on this tick?" — pino log.info lines below carry it but those are
    // not the forensic store.
    const affectedOrgs: Array<{ orgId: string; deletedCount: number }> = [];

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
        affectedOrgs.push({ orgId: config.org_id, deletedCount: count });
        log.info(
          { orgId: config.org_id, hardDeletedCount: count, delayDays: config.hard_delete_delay_days },
          "Audit log entries permanently deleted",
        );
      }
    }

    // Library-layer self-audit. Emitted only when count > 0 (zero-row
    // hard-deletes would flood the admin_action_log on every scheduler
    // tick; the outer purge_cycle row already proves the scheduler is
    // alive at count === 0). Suppressed under HTTP context — the manual
    // hard-delete route emits `audit_retention.manual_hard_delete`, a
    // distinct action type so forensic queries can tell a scheduled
    // erasure from an admin-triggered one.
    if (totalDeleted > 0 && !isHttpContext()) {
      logAdminAction({
        actionType: ADMIN_ACTIONS.audit_retention.hardDelete,
        targetType: "audit_retention",
        targetId: orgId ?? "all",
        scope: "platform",
        systemActor: AUDIT_PURGE_SCHEDULER_ACTOR,
        metadata: {
          deletedCount: totalDeleted,
          orgCount: affectedOrgs.length,
          affectedOrgs,
        },
      });
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

// ── Admin action log retention (F-36) ──────────────────────────────────
//
// Parallel to the audit-log retention above but governing `admin_action_log`
// and `admin_action_retention_config`. Two surface-area additions:
//
//   purgeAdminActionExpired(orgId?) — direct hard-delete of rows past the
//     retention window per configured org. No soft-delete stage — the
//     default 7-year window is long enough that a recovery gap adds
//     little relative to volume (see design doc D1 / D2).
//
//   anonymizeUserAdminActions(userId, initiatedBy) — GDPR / CCPA erasure.
//     Scrubs `actor_id` + `actor_email` to NULL and stamps `anonymized_at
//     = now()` on every row where `actor_id = userId`. The row survives
//     so the sequence of actions is preserved without the identifier.
//
// Design doc: .claude/research/design/admin-action-log-retention.md

/**
 * Hard-delete `admin_action_log` rows past the retention window for every
 * configured org (or a single org when `orgId` is provided).
 *
 * Per-config errors are isolated: one org's DB failure cannot erase the
 * forensic record of other orgs' successful deletes on the same cycle.
 * Partial progress is reflected in the `failedOrgs` metadata on the
 * self-audit row so a compliance reviewer sees exactly which configs
 * succeeded and which errored.
 *
 * Emits `admin_action_retention.hard_delete` under the reserved
 * `system:audit-purge-scheduler` actor when the total deleted count is > 0,
 * mirroring the F-27 zero-row suppression on `hardDeleteExpired`.
 */
export const purgeAdminActionExpired = (orgId?: string): Effect.Effect<AdminActionPurgeResult[], EnterpriseError | Error> =>
  Effect.gen(function* () {
    yield* requireEnterpriseEffect("audit-retention");
    if (!hasInternalDB()) return [];

    const pool = getInternalDB();

    // Fetch applicable retention configs — mirrors audit-log path. A DB
    // failure here cannot be isolated (nothing to iterate yet), so a
    // typed failure surfaces to the scheduler's catchAll which emits the
    // cycle failure-row.
    const configs = orgId
      ? yield* Effect.tryPromise({
          try: () => internalQuery<RetentionConfigRow>(
            `SELECT org_id, retention_days FROM admin_action_retention_config WHERE org_id = $1 AND retention_days IS NOT NULL`,
            [orgId],
          ),
          catch: (err) => err instanceof Error ? err : new Error(String(err)),
        })
      : yield* Effect.tryPromise({
          try: () => internalQuery<RetentionConfigRow>(
            `SELECT org_id, retention_days FROM admin_action_retention_config WHERE retention_days IS NOT NULL`,
          ),
          catch: (err) => err instanceof Error ? err : new Error(String(err)),
        });

    const results: AdminActionPurgeResult[] = [];
    const affectedOrgs: Array<{ orgId: string; deletedCount: number }> = [];
    const failedOrgs: Array<{ orgId: string; error: string }> = [];
    let totalDeleted = 0;

    for (const config of configs) {
      // Defensive skip: the SELECT already filters retention_days IS NOT
      // NULL. A config row without a window shouldn't arrive here, but if
      // a future callsite bypasses the SELECT filter, an unlimited-retention
      // row would trip the `($2 || ' days')::interval` cast on NULL. Warn +
      // skip so the scheduler stays safe.
      if (config.retention_days === null) {
        log.warn({ orgId: config.org_id }, "admin_action_retention_config.retention_days unexpectedly null — skipping");
        continue;
      }

      // Platform-scope config row keys on reserved literal 'platform' —
      // delete only the platform-scoped rows on that config. Per-org
      // configs delete the rows for that org_id. The scope split stops a
      // workspace policy from accidentally reaching platform rows.
      const isPlatformConfig = config.org_id === "platform";
      const scopeFilter = isPlatformConfig
        ? `scope = 'platform'`
        : `scope = 'workspace' AND org_id = $1`;
      const scopeParams = isPlatformConfig ? [] : [config.org_id];

      // Single statement: DELETE + metadata UPDATE in one transactional CTE.
      // Prior shape ran two queries — a partial failure could commit the
      // delete without recording last_purge_at, which is the admin-UI lie
      // the Phase 2 surface must not inherit. The `meta` CTE writes the
      // count back to admin_action_retention_config atomically.
      const result = yield* Effect.either(Effect.tryPromise({
        try: () => pool.query(
          `WITH deleted AS (
             DELETE FROM admin_action_log
             WHERE ${scopeFilter}
               AND timestamp < now() - ($${scopeParams.length + 1} || ' days')::interval
             RETURNING 1
           ),
           cnt AS (SELECT COUNT(*)::int AS n FROM deleted),
           meta AS (
             UPDATE admin_action_retention_config
             SET last_purge_at = now(), last_purge_count = (SELECT n FROM cnt)
             WHERE org_id = $${scopeParams.length + 2}
             RETURNING 1
           )
           SELECT n AS cnt FROM cnt`,
          [...scopeParams, config.retention_days, config.org_id],
        ),
        catch: (err) => err instanceof Error ? err : new Error(String(err)),
      }));

      if (result._tag === "Left") {
        // Preserve partial progress: earlier orgs' delete counts stay in
        // `results` and `affectedOrgs`. A combined failure would erase
        // those forensic rows on the first error. The scrubbed error is
        // captured for the self-audit row's metadata.
        const scrubbed = errorMessage(result.left);
        failedOrgs.push({ orgId: config.org_id, error: scrubbed });
        log.warn(
          { orgId: config.org_id, err: scrubbed },
          "admin_action_log purge failed for org — continuing with remaining configs",
        );
        continue;
      }

      const count = Number((result.right.rows[0] as Record<string, unknown>)?.cnt ?? 0);
      totalDeleted += count;
      results.push({ orgId: config.org_id, deletedCount: count });

      if (count > 0) {
        affectedOrgs.push({ orgId: config.org_id, deletedCount: count });
        log.info(
          { orgId: config.org_id, deletedCount: count, retentionDays: config.retention_days },
          "admin_action_log entries permanently deleted",
        );
      }
    }

    // Self-audit row. Follows the F-27 convention: suppressed at zero
    // (the outer scheduler cycle row proves liveness), suppressed under
    // HTTP (route-layer emission is the richer source when the Phase 2
    // admin UI lands). Emission also fires when any per-org failures
    // occurred, regardless of totalDeleted — a failure during erasure of
    // scheduled retention is itself a forensic signal that must land.
    const shouldEmit = (totalDeleted > 0 || failedOrgs.length > 0) && !isHttpContext();
    if (shouldEmit) {
      logAdminAction({
        actionType: ADMIN_ACTIONS.admin_action_retention.hardDelete,
        targetType: "admin_action_retention",
        targetId: orgId ?? "all",
        scope: "platform",
        status: failedOrgs.length > 0 && totalDeleted === 0 ? "failure" : "success",
        systemActor: AUDIT_PURGE_SCHEDULER_ACTOR,
        metadata: {
          deletedCount: totalDeleted,
          orgCount: affectedOrgs.length,
          affectedOrgs,
          ...(failedOrgs.length > 0 && { failedOrgs }),
        },
      });
    }

    return results;
  });

/**
 * GDPR / CCPA erasure of a single user's identifiers from `admin_action_log`.
 *
 * Scrubs `actor_id` + `actor_email` to NULL and stamps `anonymized_at =
 * now()` on every row where `actor_id = userId`. The row itself survives
 * so the sequence of actions is preserved without the identifier. The
 * `anonymized_at IS NULL` guard on the WHERE clause makes the operation
 * idempotent — a second run does not refresh the first-scrub timestamp.
 *
 * Emits a `user.erase` audit row on every run, even at zero rows: the
 * regulator-facing contract is "we processed the request," and a zero-row
 * result means "this user never wrote to admin_action_log," which is
 * still forensic evidence the request was handled.
 *
 * **Emission is unconditional on HTTP context.** Every other library-layer
 * emission in this file (policyUpdate, hardDelete, admin-action hardDelete)
 * gates on `!isHttpContext()` to dedup with a F-26 / Phase-2 route-layer
 * emission. Erasure is different: there is no planned route-layer
 * `user.erase` emission — the Phase 2 "Erase user" admin route MUST call
 * this function and NOT emit its own row. If that contract changes, this
 * call becomes double-audit; the docstring of the function is the contract
 * declaration so a future maintainer doesn't accidentally split the row.
 *
 * **Durability:** unlike the fire-and-forget `logAdminAction` used by
 * `hardDeleteExpired`, erasure uses `logAdminActionAwait` so the compliance
 * row is synchronously committed. A failure to write the audit row
 * surfaces as an Effect error to the caller — "scrub + no audit row" is
 * not a valid final state under the regulator-facing contract.
 */
export const anonymizeUserAdminActions = (
  userId: string,
  initiatedBy: AnonymizeInitiatedBy,
): Effect.Effect<AnonymizeResult, RetentionError | EnterpriseError | Error> =>
  Effect.gen(function* () {
    yield* requireEnterpriseEffect("audit-retention");
    yield* requireInternalDBEffect("admin action log erasure");

    // Input validation: empty / whitespace userId would scan every row
    // matching `actor_id = ''` (empty-string matches nothing in practice,
    // but whitespace-only values could poison the audit trail by writing
    // meaningless `user.erase` rows keyed on blank user ids).
    if (typeof userId !== "string" || userId.trim() === "") {
      return yield* Effect.fail(new RetentionError({
        message: `Invalid userId: must be a non-empty string.`,
        code: "validation",
      }));
    }

    // Belt-and-brace the compile-time type with a runtime check. The
    // initiatedBy label drives DSR reporting — a typo via an `as any`
    // cast at the callsite would silently erode the forensic split.
    if (!INITIATED_BY_VALUES.includes(initiatedBy)) {
      return yield* Effect.fail(new RetentionError({
        message: `Invalid initiatedBy "${String(initiatedBy)}". Expected one of: ${INITIATED_BY_VALUES.join(", ")}.`,
        code: "validation",
      }));
    }

    const pool = getInternalDB();

    const result = yield* Effect.tryPromise({
      try: () => pool.query(
        `WITH updated AS (
           UPDATE admin_action_log
           SET actor_id = NULL,
               actor_email = NULL,
               anonymized_at = now()
           WHERE actor_id = $1
             AND anonymized_at IS NULL
           RETURNING 1
         ) SELECT COUNT(*)::int AS cnt FROM updated`,
        [userId],
      ),
      catch: (err) => err instanceof Error ? err : new Error(String(err)),
    });

    const anonymizedRowCount = Number((result.rows[0] as Record<string, unknown>)?.cnt ?? 0);

    log.info(
      { targetUserId: userId, anonymizedRowCount, initiatedBy },
      "admin_action_log rows anonymized (right-to-erasure)",
    );

    // Emit `user.erase` unconditionally (zero rows included). The erasure
    // request was processed — the audit trail records that it happened
    // regardless of whether there was anything to scrub. Awaited so a
    // DB failure on the audit INSERT surfaces to the caller instead of
    // leaving a "scrubbed without audit row" final state.
    yield* Effect.tryPromise({
      try: () => logAdminActionAwait({
        actionType: ADMIN_ACTIONS.user.erase,
        targetType: "user",
        targetId: userId,
        scope: "platform",
        systemActor: AUDIT_PURGE_SCHEDULER_ACTOR,
        metadata: {
          targetUserId: userId,
          anonymizedRowCount,
          initiatedBy,
        },
      }),
      catch: (err) => err instanceof Error ? err : new Error(String(err)),
    });

    return { anonymizedRowCount };
  });
