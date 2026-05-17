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
import { recordQueryEvent } from "@atlas/api/lib/security/abuse";
import type { DBType } from "@atlas/api/lib/db/connection";

const log = createLogger("audit");

const PINO_SQL_LIMIT = 500;
const DB_SQL_LIMIT = 2000;

/**
 * Common audit-row fields not in the success-vs-failure discriminator.
 *
 * `id` and `parentAuditId` were added for cross-environment audit
 * linkage (#2519, PRD #2515 slice 4). On a fanned-out turn the caller
 * generates the parent's UUID, passes it as `id` on the parent row, and
 * then passes it as `parentAuditId` on every child row. Both default to
 * undefined — single-env executions emit a single row with no linkage
 * and `id` defaulted by the database (`gen_random_uuid()` via the
 * column default).
 */
interface AuditEntryCommon {
  sql: string;
  durationMs: number;
  sourceId?: string;
  sourceType?: DBType;
  targetHost?: string;
  tablesAccessed?: string[];
  columnsAccessed?: string[];
  /** Optional pre-generated row id. Used to stamp the parent of a fanout (#2519). */
  id?: string;
  /** Parent audit row id for fanned-out children. NULL on parent + single-env rows (#2519). */
  parentAuditId?: string;
}

export type AuditEntry =
  | (AuditEntryCommon & { rowCount: number; success: true })
  | (AuditEntryCommon & { rowCount: number | null; success: false; error?: string });

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
  const actor = ctx?.actor;
  const actorKind = actor?.kind ?? null;
  // The mcp branch is the only one carrying clientId / toolName — the
  // discriminated union in `lib/logger.ts` makes this guard a type
  // narrow rather than an ad-hoc truthy check.
  const clientId = actor?.kind === "mcp" ? actor.clientId ?? null : null;
  const toolName = actor?.kind === "mcp" ? actor.toolName : null;
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
      ...(actorKind && { actorKind }),
      ...(clientId && { clientId }),
      ...(toolName && { toolName }),
      ...(entry.sourceId && { sourceId: entry.sourceId }),
      ...(entry.sourceType && { sourceType: entry.sourceType }),
      ...(entry.targetHost && { targetHost: entry.targetHost }),
      ...(entry.tablesAccessed?.length && { tablesAccessed: entry.tablesAccessed }),
      ...(entry.columnsAccessed?.length && { columnsAccessed: entry.columnsAccessed }),
    },
    entry.success ? "query_success" : "query_failure",
  );

  // Record query event for abuse detection (per-workspace anomaly tracking)
  const orgId = ctx?.user?.activeOrganizationId;
  if (orgId) {
    recordQueryEvent(orgId, {
      success: entry.success,
      tablesAccessed: entry.tablesAccessed,
    });
  }

  // Insert into audit_log when internal DB is available (SQL truncated to 2000 chars).
  //
  // `id` and `parent_audit_id` participate in cross-environment fanout
  // linkage (#2519). Single-env executions leave both NULL so PG fills
  // `id` from its `gen_random_uuid()` default and `parent_audit_id`
  // stays NULL — every existing audit consumer keeps seeing the row
  // shape it expected. Fanout writes a parent row with a
  // caller-supplied `id` and `parent_audit_id = NULL`, then writes one
  // child row per member with `parent_audit_id = <parent id>`.
  if (hasInternalDB()) {
    try {
      // Build the INSERT dynamically so we only thread `id` when the
      // caller supplied one (parent of a fanout). For every other row
      // PG fills `id` from the column default and we never name it.
      const cols = [
        "user_id",
        "user_label",
        "auth_mode",
        "sql",
        "duration_ms",
        "row_count",
        "success",
        "error",
        "source_id",
        "source_type",
        "target_host",
        "tables_accessed",
        "columns_accessed",
        "org_id",
        "actor_kind",
        "client_id",
        "tool_name",
        "parent_audit_id",
      ];
      const params: unknown[] = [
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
        entry.tablesAccessed?.length ? JSON.stringify(entry.tablesAccessed) : null,
        entry.columnsAccessed?.length ? JSON.stringify(entry.columnsAccessed) : null,
        ctx?.user?.activeOrganizationId ?? null,
        actorKind,
        clientId,
        toolName,
        entry.parentAuditId ?? null,
      ];
      if (entry.id) {
        cols.push("id");
        params.push(entry.id);
      }
      const placeholders = params.map((_, i) => `$${i + 1}`).join(", ");
      internalExecute(
        `INSERT INTO audit_log (${cols.join(", ")}) VALUES (${placeholders})`,
        params,
      );
    } catch (err) {
      log.warn({ err }, "audit_log insert failed");
    }
  }
}
