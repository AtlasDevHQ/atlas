/**
 * Admin action audit logger.
 *
 * Logs every admin mutation to pino (always) and to the internal Postgres
 * admin_action_log table (when DATABASE_URL is set). Fire-and-forget DB
 * writes — two layers of protection:
 *
 * 1. internalExecute() returns a promise whose rejections are swallowed
 *    (async errors — the .catch prevents unhandled rejection crashes).
 * 2. The surrounding try/catch covers synchronous throws from getInternalDB()
 *    (e.g. pool not initialized).
 *
 * Either way, audit failures never propagate to the caller.
 */

import { createLogger, getRequestContext } from "@atlas/api/lib/logger";
import { hasInternalDB, internalExecute } from "@atlas/api/lib/db/internal";
import type { AdminActionType, AdminTargetType } from "./actions";

const log = createLogger("admin-audit");

export interface AdminActionEntry {
  /** The action type from ADMIN_ACTIONS catalog. */
  actionType: AdminActionType;
  /** The target entity type (domain prefix, e.g. "workspace", "connection"). */
  targetType: AdminTargetType;
  /** The ID of the target entity. */
  targetId: string;
  /** Whether the action succeeded or failed. Defaults to "success". */
  status?: "success" | "failure";
  /** Action-specific details stored as JSONB. */
  metadata?: Record<string, unknown>;
  /** "platform" or "workspace". Defaults to "workspace". */
  scope?: "platform" | "workspace";
  /** Client IP address (extracted from request headers by caller). */
  ipAddress?: string | null;
}

/**
 * Log an admin action to pino and the internal DB.
 *
 * Auto-pulls actor_id, actor_email, org_id, and request_id from
 * the AsyncLocalStorage request context. The caller provides the
 * action-specific fields.
 *
 * This function NEVER throws — it is safe to call fire-and-forget.
 */
export function logAdminAction(entry: AdminActionEntry): void {
  const ctx = getRequestContext();
  const actorId = ctx?.user?.id ?? "unknown";
  const actorEmail = ctx?.user?.label ?? "unknown";
  const orgId = ctx?.user?.activeOrganizationId ?? null;
  const requestId = ctx?.requestId ?? "unknown";
  const scope = entry.scope ?? "workspace";
  const status = entry.status ?? "success";

  // Always log to pino
  const logFn = status === "success" ? log.info.bind(log) : log.warn.bind(log);
  logFn(
    {
      actionType: entry.actionType,
      targetType: entry.targetType,
      targetId: entry.targetId,
      scope,
      status,
      actorId,
      actorEmail,
      orgId,
      requestId,
      ...(entry.metadata && { metadata: entry.metadata }),
      ...(entry.ipAddress && { ipAddress: entry.ipAddress }),
    },
    `admin_action: ${entry.actionType}`,
  );

  // Insert into admin_action_log when internal DB is available.
  // internalExecute() is fire-and-forget (returns void, handles its own
  // async errors via circuit breaker). The try/catch here guards against
  // synchronous throws from pool initialization.
  if (hasInternalDB()) {
    try {
      internalExecute(
        `INSERT INTO admin_action_log
           (actor_id, actor_email, scope, org_id, action_type, target_type, target_id, status, metadata, ip_address, request_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          actorId,
          actorEmail,
          scope,
          orgId,
          entry.actionType,
          entry.targetType,
          entry.targetId,
          status,
          entry.metadata ? JSON.stringify(entry.metadata) : null,
          entry.ipAddress ?? null,
          requestId,
        ],
      );
    } catch (err: unknown) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "admin_action_log insert failed",
      );
    }
  }
}
