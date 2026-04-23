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
import { hasInternalDB, internalExecute, internalQuery } from "@atlas/api/lib/db/internal";
import type { AdminActionType, AdminTargetType } from "./actions";

const log = createLogger("admin-audit");

const ADMIN_ACTION_LOG_INSERT_SQL = `INSERT INTO admin_action_log
  (actor_id, actor_email, scope, org_id, action_type, target_type, target_id, status, metadata, ip_address, request_id)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`;

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
  const resolved = resolveEntry(entry);
  emitPino(resolved);

  // Insert into admin_action_log when internal DB is available.
  // internalExecute() is fire-and-forget (returns void, handles its own
  // async errors via circuit breaker). The try/catch here guards against
  // synchronous throws from pool initialization.
  if (hasInternalDB()) {
    try {
      internalExecute(ADMIN_ACTION_LOG_INSERT_SQL, resolved.params);
    } catch (err: unknown) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "admin_action_log insert failed",
      );
    }
  }
}

/**
 * Synchronous variant for surfaces where the audit row is the security
 * control itself — e.g. the audit-retention surface, where a fire-and-forget
 * gap during a circuit-breaker open would let an attacker shrink retention
 * with no record. The Promise resolves only after the row is committed (or
 * the internal DB is absent, in which case the pino line is the trail).
 * Callers should treat a rejection as "audit row not committed — surface
 * an error to the admin so they retry."
 */
export async function logAdminActionAwait(entry: AdminActionEntry): Promise<void> {
  const resolved = resolveEntry(entry);
  emitPino(resolved);
  if (!hasInternalDB()) return;
  await internalQuery(ADMIN_ACTION_LOG_INSERT_SQL, resolved.params);
}

interface ResolvedEntry {
  readonly entry: AdminActionEntry;
  readonly actorId: string;
  readonly actorEmail: string;
  readonly orgId: string | null;
  readonly requestId: string;
  readonly scope: "platform" | "workspace";
  readonly status: "success" | "failure";
  readonly params: unknown[];
}

function resolveEntry(entry: AdminActionEntry): ResolvedEntry {
  const ctx = getRequestContext();
  const actorId = ctx?.user?.id ?? "unknown";
  const actorEmail = ctx?.user?.label ?? "unknown";
  const orgId = ctx?.user?.activeOrganizationId ?? null;
  const requestId = ctx?.requestId ?? "unknown";
  const scope = entry.scope ?? "workspace";
  const status = entry.status ?? "success";
  const params: unknown[] = [
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
  ];
  return { entry, actorId, actorEmail, orgId, requestId, scope, status, params };
}

function emitPino(resolved: ResolvedEntry): void {
  const logFn = resolved.status === "success" ? log.info.bind(log) : log.warn.bind(log);
  logFn(
    {
      actionType: resolved.entry.actionType,
      targetType: resolved.entry.targetType,
      targetId: resolved.entry.targetId,
      scope: resolved.scope,
      status: resolved.status,
      actorId: resolved.actorId,
      actorEmail: resolved.actorEmail,
      orgId: resolved.orgId,
      requestId: resolved.requestId,
      ...(resolved.entry.metadata && { metadata: resolved.entry.metadata }),
      ...(resolved.entry.ipAddress && { ipAddress: resolved.entry.ipAddress }),
    },
    `admin_action: ${resolved.entry.actionType}`,
  );
}
