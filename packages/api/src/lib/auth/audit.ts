/**
 * Query audit logger.
 *
 * Logs every SQL query to pino (always) and to the internal Postgres
 * audit_log table (when DATABASE_URL is set). Fire-and-forget DB writes —
 * two layers of protection: internalExecute() returns a promise whose
 * rejections are swallowed (async errors), and the surrounding try/catch
 * in logQueryAudit covers synchronous throws from getInternalDB() (e.g.
 * pool not initialized). Either way, audit failures never propagate to
 * the caller.
 *
 * Dual-truncation strategy:
 * - Pino log entries truncate SQL to 500 chars (PINO_SQL_LIMIT) to keep
 *   structured log output concise and avoid overwhelming log aggregators.
 * - DB audit_log inserts truncate SQL to 2000 chars (DB_SQL_LIMIT) to
 *   preserve enough context for forensic review while respecting column limits.
 */

import { createLogger, getRequestContext } from "@atlas/api/lib/logger";
import { hasInternalDB, internalExecute } from "@atlas/api/lib/db/internal";
import { SENSITIVE_PATTERNS } from "@atlas/api/lib/security";
import type { DBType } from "@atlas/api/lib/db/connection";

const log = createLogger("audit");

const PINO_SQL_LIMIT = 500;
const DB_SQL_LIMIT = 2000;

export type AuditEntry =
  | { sql: string; durationMs: number; rowCount: number; success: true; sourceId?: string; sourceType?: DBType; targetHost?: string }
  | { sql: string; durationMs: number; rowCount: null; success: false; error?: string; sourceId?: string; sourceType?: DBType; targetHost?: string };

function scrubError(error: string | undefined): string | undefined {
  if (!error) return undefined;
  if (SENSITIVE_PATTERNS.test(error)) return "[scrubbed]";
  return error;
}

export function logQueryAudit(entry: AuditEntry): void {
  const ctx = getRequestContext();
  const userId = ctx?.user?.id ?? null;
  const userLabel = ctx?.user?.label ?? null;
  const authMode = ctx?.user?.mode ?? "none";
  const scrubbedError = scrubError(entry.success ? undefined : entry.error);

  // Always log to pino (SQL truncated to 500 chars)
  const logFn = entry.success ? log.info.bind(log) : log.warn.bind(log);
  logFn(
    {
      sql: entry.sql.slice(0, PINO_SQL_LIMIT),
      durationMs: entry.durationMs,
      rowCount: entry.rowCount,
      success: entry.success,
      ...(scrubbedError && { error: scrubbedError }),
      userId,
      userLabel,
      authMode,
      ...(entry.sourceId && { sourceId: entry.sourceId }),
      ...(entry.sourceType && { sourceType: entry.sourceType }),
      ...(entry.targetHost && { targetHost: entry.targetHost }),
    },
    entry.success ? "query_success" : "query_failure",
  );

  // Insert into audit_log when internal DB is available (SQL truncated to 2000 chars)
  if (hasInternalDB()) {
    try {
      internalExecute(
        `INSERT INTO audit_log (user_id, user_label, auth_mode, sql, duration_ms, row_count, success, error, source_id, source_type, target_host)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          userId,
          userLabel,
          authMode,
          entry.sql.slice(0, DB_SQL_LIMIT),
          entry.durationMs,
          entry.rowCount,
          entry.success,
          scrubbedError ?? null,
          entry.sourceId ?? null,
          entry.sourceType ?? null,
          entry.targetHost ?? null,
        ],
      );
    } catch (err) {
      log.warn({ err }, "audit_log insert failed");
    }
  }
}
