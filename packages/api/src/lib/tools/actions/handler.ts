/**
 * Action framework handler.
 *
 * Core logic for the action approval workflow:
 * - handleAction: persist request → check approval mode → auto-execute or pend
 * - approveAction / denyAction: CAS via PostgreSQL WHERE status = 'pending' RETURNING *; in-memory path uses non-atomic check-then-update
 * - getAction / listPendingActions: read-only queries
 * - registerActionExecutor / getActionExecutor: deferred execution registry
 * - getActionConfig: resolve per-action config from atlas.config.ts / defaults
 */

import type {
  ActionLogEntry,
  ActionRequest,
  ActionToolResult,
  ActionApprovalMode,
  ActionStatus,
  RollbackInfo,
} from "@atlas/api/lib/action-types";
import type { AtlasRole } from "@atlas/api/lib/auth/types";
import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import { createLogger, getRequestContext } from "@atlas/api/lib/logger";
import { getConfig, type ActionsConfig, type PerActionConfig } from "@atlas/api/lib/config";
import { parseRole } from "@atlas/api/lib/auth/permissions";
import { logActionAudit } from "./audit";

const log = createLogger("action-handler");

// ---------------------------------------------------------------------------
// Timeout helper
// ---------------------------------------------------------------------------

export class ActionTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`Action timed out after ${timeoutMs}ms`);
    this.name = "ActionTimeoutError";
  }
}

function executeWithTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number | undefined,
): Promise<T> {
  if (timeoutMs == null) return fn();
  let timer: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ActionTimeoutError(timeoutMs)), timeoutMs);
  });
  return Promise.race([fn(), timeoutPromise]).finally(() => clearTimeout(timer!));
}

// ---------------------------------------------------------------------------
// In-memory fallback store (when DATABASE_URL is not set)
// ---------------------------------------------------------------------------

const memoryStore = new Map<string, ActionLogEntry>();

// ---------------------------------------------------------------------------
// Executor registry (for deferred approval)
// ---------------------------------------------------------------------------

type ActionExecutor = (payload: Record<string, unknown>) => Promise<unknown>;
const executorRegistry = new Map<string, ActionExecutor>();

export function registerActionExecutor(actionId: string, fn: ActionExecutor): void {
  executorRegistry.set(actionId, fn);
}

export function getActionExecutor(actionId: string): ActionExecutor | undefined {
  return executorRegistry.get(actionId);
}

// ---------------------------------------------------------------------------
// Rollback method registry
// ---------------------------------------------------------------------------

type RollbackMethodHandler = (params: Record<string, unknown>) => Promise<unknown>;
const rollbackMethodRegistry = new Map<string, RollbackMethodHandler>();

export function registerRollbackMethod(method: string, handler: RollbackMethodHandler): void {
  rollbackMethodRegistry.set(method, handler);
}

export function getRollbackMethod(method: string): RollbackMethodHandler | undefined {
  return rollbackMethodRegistry.get(method);
}

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the effective action config for an action type (approval, timeout, requiredRole).
 * Priority: per-action override > config defaults > action's defaultApproval > "manual".
 */
export function getActionConfig(
  actionType: string,
  defaultApproval?: ActionApprovalMode,
): { approval: ActionApprovalMode; requiredRole?: AtlasRole; timeout?: number; maxPerConversation?: number } {
  const config = getConfig();
  const actionsConfig = config?.actions as ActionsConfig | undefined;

  let approval: ActionApprovalMode = defaultApproval ?? "manual";
  let requiredRole: AtlasRole | undefined;
  let timeout: number | undefined;
  let maxPerConversation: number | undefined;

  // Layer 1: config defaults
  if (actionsConfig?.defaults) {
    if (actionsConfig.defaults.approval) approval = actionsConfig.defaults.approval;
    if (actionsConfig.defaults.timeout) timeout = actionsConfig.defaults.timeout;
    if (actionsConfig.defaults.maxPerConversation) maxPerConversation = actionsConfig.defaults.maxPerConversation;
  }

  // Layer 2: per-action override
  const perAction = actionsConfig?.[actionType] as PerActionConfig | undefined;
  if (perAction) {
    if (perAction.approval) approval = perAction.approval;
    if (perAction.requiredRole) {
      const validated = parseRole(perAction.requiredRole as string);
      if (validated) {
        requiredRole = validated;
      } else {
        log.warn({ actionType, value: perAction.requiredRole }, "Per-action requiredRole is not a valid Atlas role — ignoring override");
      }
    }
    if (typeof perAction.timeout === "number" && perAction.timeout > 0) {
      timeout = perAction.timeout;
    }
  }

  return { approval, requiredRole, timeout, maxPerConversation };
}

// ---------------------------------------------------------------------------
// Build action request helper
// ---------------------------------------------------------------------------

export function buildActionRequest(params: {
  actionType: string;
  target: string;
  summary: string;
  payload: Record<string, unknown>;
  reversible: boolean;
}): ActionRequest {
  return {
    id: crypto.randomUUID(),
    ...params,
  };
}

// ---------------------------------------------------------------------------
// Persist helpers
// ---------------------------------------------------------------------------

async function persistAction(entry: ActionLogEntry): Promise<void> {
  memoryStore.set(entry.id, entry);
  if (hasInternalDB()) {
    try {
      await internalQuery(
        `INSERT INTO action_log (id, requested_by, approved_by, auth_mode, action_type, target, summary, payload, status, result, error, rollback_info, conversation_id, request_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [
          entry.id,
          entry.requested_by,
          entry.approved_by,
          entry.auth_mode,
          entry.action_type,
          entry.target,
          entry.summary,
          JSON.stringify(entry.payload),
          entry.status,
          entry.result ? JSON.stringify(entry.result) : null,
          entry.error,
          entry.rollback_info ? JSON.stringify(entry.rollback_info) : null,
          entry.conversation_id,
          entry.request_id,
        ],
      );
    } catch (err) {
      log.error({ err, actionId: entry.id }, "Failed to persist action to DB — stored in memory only");
    }
  }
}

const COLUMN_MAP: Record<string, string> = {
  status: "status",
  resolved_at: "resolved_at",
  executed_at: "executed_at",
  approved_by: "approved_by",
  result: "result",
  error: "error",
  rollback_info: "rollback_info",
};

const JSON_COLUMNS: ReadonlySet<string> = new Set(["result", "rollback_info"]);

async function updateActionStatus(
  id: string,
  updates: Partial<Pick<ActionLogEntry, "status" | "resolved_at" | "executed_at" | "approved_by" | "result" | "error" | "rollback_info">>,
): Promise<void> {
  // Update memory store first
  const existing = memoryStore.get(id);
  if (existing) {
    memoryStore.set(id, { ...existing, ...updates });
  }

  const setClauses: string[] = [];
  const params: unknown[] = [];
  let paramIdx = 1;

  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      const colName = COLUMN_MAP[key];
      if (!colName) throw new Error(`Unknown action_log column key: ${key}`);
      setClauses.push(`${colName} = $${paramIdx}`);
      params.push(JSON_COLUMNS.has(colName) ? JSON.stringify(value) : value);
      paramIdx++;
    }
  }

  if (hasInternalDB() && setClauses.length > 0) {
    params.push(id);
    try {
      await internalQuery(
        `UPDATE action_log SET ${setClauses.join(", ")} WHERE id = $${paramIdx}`,
        params,
      );
    } catch (err) {
      log.error({ err, actionId: id }, "Failed to update action status in DB — memory store updated");
    }
  }
}

// ---------------------------------------------------------------------------
// Core handler
// ---------------------------------------------------------------------------

export interface HandleActionOptions {
  conversationId?: string;
}

/**
 * Main entry point: persist pending action → check approval mode → if auto: execute immediately.
 */
export async function handleAction(
  request: ActionRequest,
  executeFn: (payload: Record<string, unknown>) => Promise<unknown>,
  opts?: HandleActionOptions,
): Promise<ActionToolResult> {
  const ctx = getRequestContext();
  const userId = ctx?.user?.id;
  const authMode = ctx?.user?.mode ?? "none";
  const requestId = ctx?.requestId ?? null;
  const now = new Date().toISOString();

  const entry: ActionLogEntry = {
    id: request.id,
    requested_at: now,
    resolved_at: null,
    executed_at: null,
    requested_by: userId ?? null,
    approved_by: null,
    auth_mode: authMode,
    action_type: request.actionType,
    target: request.target,
    summary: request.summary,
    payload: request.payload,
    status: "pending",
    result: null,
    error: null,
    rollback_info: null,
    conversation_id: opts?.conversationId ?? null,
    request_id: requestId,
  };

  await persistAction(entry);
  logActionAudit({
    actionId: request.id,
    actionType: request.actionType,
    status: "pending",
    userId,
  });

  // Register executor for deferred approval (keyed by actionId so each request gets its own executor)
  registerActionExecutor(request.id, executeFn);

  // Resolve approval mode
  const actionConfig = getActionConfig(request.actionType);

  if (actionConfig.approval === "auto") {
    // Execute immediately
    const startMs = Date.now();
    try {
      const result = await executeWithTimeout(
        () => executeFn(request.payload),
        actionConfig.timeout,
      );
      const latencyMs = Date.now() - startMs;

      const rbInfo = extractRollbackInfo(result);
      await updateActionStatus(request.id, {
        status: "auto_approved",
        resolved_at: new Date().toISOString(),
        executed_at: new Date().toISOString(),
        approved_by: "system:auto",
        result,
        ...(rbInfo && { rollback_info: rbInfo }),
      });
      logActionAudit({
        actionId: request.id,
        actionType: request.actionType,
        status: "auto_approved",
        latencyMs,
        userId,
      });

      return { status: "auto_approved", actionId: request.id, result };
    } catch (err) {
      const latencyMs = Date.now() - startMs;

      if (err instanceof ActionTimeoutError) {
        await updateActionStatus(request.id, {
          status: "timed_out",
          resolved_at: new Date().toISOString(),
          error: err.message,
        });
        logActionAudit({
          actionId: request.id,
          actionType: request.actionType,
          status: "timed_out",
          latencyMs,
          timeoutMs: err.timeoutMs,
          userId,
        });
        return { status: "timed_out", actionId: request.id, error: err.message };
      }

      const errorMsg = err instanceof Error ? err.message : String(err);

      await updateActionStatus(request.id, {
        status: "failed",
        resolved_at: new Date().toISOString(),
        error: errorMsg,
      });
      logActionAudit({
        actionId: request.id,
        actionType: request.actionType,
        status: "failed",
        latencyMs,
        userId,
        error: errorMsg,
      });

      return { status: "failed", actionId: request.id, error: errorMsg };
    }
  }

  // Manual or admin-only: pend for approval
  return { status: "pending_approval", actionId: request.id, summary: request.summary };
}

// ---------------------------------------------------------------------------
// Approval / denial (CAS via PostgreSQL WHERE status = 'pending' RETURNING *; in-memory path uses non-atomic check-then-update)
// ---------------------------------------------------------------------------

/**
 * Approve a pending action. Returns the updated entry, or null if CAS failed
 * (action already resolved — 409 scenario).
 */
export async function approveAction(
  actionId: string,
  approverId: string,
  executeFn?: ActionExecutor,
): Promise<ActionLogEntry | null> {
  const resolveFn = executeFn ?? getActionExecutor(actionId);

  // CAS in DB (atomic via WHERE status = 'pending' RETURNING *)
  if (hasInternalDB()) {
    const rows = await internalQuery(
      `UPDATE action_log
       SET status = 'approved', resolved_at = now(), approved_by = $1
       WHERE id = $2 AND status = 'pending'
       RETURNING *`,
      [approverId, actionId],
    ) as unknown as ActionLogEntry[];
    if (rows.length === 0) return null;

    const entry = rows[0];
    memoryStore.set(actionId, entry);

    logActionAudit({
      actionId,
      actionType: entry.action_type,
      status: "approved",
      approverId,
    });

    // Execute the action
    if (resolveFn) {
      const { timeout } = getActionConfig(entry.action_type);
      const startMs = Date.now();
      try {
        const result = await executeWithTimeout(
          () => resolveFn(entry.payload),
          timeout,
        );
        const latencyMs = Date.now() - startMs;

        const rbInfo = extractRollbackInfo(result);
        const execRows = rbInfo
          ? await internalQuery(
              `UPDATE action_log SET status = 'executed', executed_at = now(), result = $1, rollback_info = $2 WHERE id = $3 RETURNING *`,
              [JSON.stringify(result), JSON.stringify(rbInfo), actionId],
            ) as unknown as ActionLogEntry[]
          : await internalQuery(
              `UPDATE action_log SET status = 'executed', executed_at = now(), result = $1 WHERE id = $2 RETURNING *`,
              [JSON.stringify(result), actionId],
            ) as unknown as ActionLogEntry[];
        const updated = execRows[0] ?? { ...entry, status: "executed" as ActionStatus, executed_at: new Date().toISOString(), result, ...(rbInfo && { rollback_info: rbInfo }) };
        memoryStore.set(actionId, updated);

        logActionAudit({
          actionId,
          actionType: entry.action_type,
          status: "executed",
          latencyMs,
          approverId,
        });

        return updated;
      } catch (err) {
        const latencyMs = Date.now() - startMs;

        if (err instanceof ActionTimeoutError) {
          const timedOut: ActionLogEntry = { ...entry, status: "timed_out" as ActionStatus, error: err.message };
          try {
            const timedOutRows = await internalQuery(
              `UPDATE action_log SET status = 'timed_out', error = $1 WHERE id = $2 RETURNING *`,
              [err.message, actionId],
            ) as unknown as ActionLogEntry[];
            if (timedOutRows[0]) Object.assign(timedOut, timedOutRows[0]);
          } catch (dbErr) {
            log.error({ err: dbErr, actionId }, "Failed to persist timed_out status to DB — memory store updated");
          }
          memoryStore.set(actionId, timedOut);

          logActionAudit({
            actionId,
            actionType: entry.action_type,
            status: "timed_out",
            latencyMs,
            timeoutMs: err.timeoutMs,
            approverId,
          });

          return timedOut;
        }

        const errorMsg = err instanceof Error ? err.message : String(err);

        const failRows = await internalQuery(
          `UPDATE action_log SET status = 'failed', error = $1 WHERE id = $2 RETURNING *`,
          [errorMsg, actionId],
        ) as unknown as ActionLogEntry[];
        const failed = failRows[0] ?? { ...entry, status: "failed" as ActionStatus, error: errorMsg };
        memoryStore.set(actionId, failed);

        logActionAudit({
          actionId,
          actionType: entry.action_type,
          status: "failed",
          latencyMs,
          approverId,
          error: errorMsg,
        });

        return failed;
      }
    }

    log.warn({ actionId, actionType: entry.action_type }, "Action approved but no executor available — will not execute");
    return entry;
  }

  // Memory-only fallback
  const entry = memoryStore.get(actionId);
  if (!entry || entry.status !== "pending") return null;

  const approved: ActionLogEntry = {
    ...entry,
    status: "approved",
    resolved_at: new Date().toISOString(),
    approved_by: approverId,
  };

  logActionAudit({
    actionId,
    actionType: entry.action_type,
    status: "approved",
    approverId,
  });

  if (resolveFn) {
    const { timeout } = getActionConfig(entry.action_type);
    const startMs = Date.now();
    try {
      const result = await executeWithTimeout(
        () => resolveFn(entry.payload),
        timeout,
      );
      const latencyMs = Date.now() - startMs;
      const rbInfo = extractRollbackInfo(result);
      const executed: ActionLogEntry = {
        ...approved,
        status: "executed",
        executed_at: new Date().toISOString(),
        result,
        ...(rbInfo && { rollback_info: rbInfo }),
      };
      memoryStore.set(actionId, executed);

      logActionAudit({
        actionId,
        actionType: entry.action_type,
        status: "executed",
        latencyMs,
        approverId,
      });

      return executed;
    } catch (err) {
      const latencyMs = Date.now() - startMs;

      if (err instanceof ActionTimeoutError) {
        const timedOut: ActionLogEntry = {
          ...approved,
          status: "timed_out",
          error: err.message,
        };
        memoryStore.set(actionId, timedOut);

        logActionAudit({
          actionId,
          actionType: entry.action_type,
          status: "timed_out",
          latencyMs,
          timeoutMs: err.timeoutMs,
          approverId,
        });

        return timedOut;
      }

      const errorMsg = err instanceof Error ? err.message : String(err);
      const failed: ActionLogEntry = {
        ...approved,
        status: "failed",
        error: errorMsg,
      };
      memoryStore.set(actionId, failed);

      logActionAudit({
        actionId,
        actionType: entry.action_type,
        status: "failed",
        latencyMs,
        approverId,
        error: errorMsg,
      });

      return failed;
    }
  }

  log.warn({ actionId, actionType: entry.action_type }, "Action approved but no executor available — will not execute");
  memoryStore.set(actionId, approved);
  return approved;
}

/**
 * Deny a pending action. Returns the updated entry, or null if CAS failed.
 */
export async function denyAction(
  actionId: string,
  denierId: string,
  reason?: string,
): Promise<ActionLogEntry | null> {
  if (hasInternalDB()) {
    const rows = await internalQuery(
      `UPDATE action_log
       -- approved_by is overloaded: stores approver for approved actions, denier for denied actions
       SET status = 'denied', resolved_at = now(), approved_by = $1, error = $2
       WHERE id = $3 AND status = 'pending'
       RETURNING *`,
      [denierId, reason ?? null, actionId],
    ) as unknown as ActionLogEntry[];
    if (rows.length === 0) return null;

    const entry = rows[0];
    memoryStore.set(actionId, entry);

    logActionAudit({
      actionId,
      actionType: entry.action_type,
      status: "denied",
      approverId: denierId,
    });

    return entry;
  }

  // Memory-only fallback
  const entry = memoryStore.get(actionId);
  if (!entry || entry.status !== "pending") return null;

  const denied: ActionLogEntry = {
    ...entry,
    status: "denied",
    resolved_at: new Date().toISOString(),
    approved_by: denierId, // approved_by is overloaded: stores approver for approved actions, denier for denied actions
    error: reason ?? null,
  };
  memoryStore.set(actionId, denied);

  logActionAudit({
    actionId,
    actionType: entry.action_type,
    status: "denied",
    approverId: denierId,
  });

  return denied;
}

// ---------------------------------------------------------------------------
// Read operations
// ---------------------------------------------------------------------------

export async function getAction(actionId: string): Promise<ActionLogEntry | null> {
  if (hasInternalDB()) {
    const rows = await internalQuery(
      `SELECT * FROM action_log WHERE id = $1`,
      [actionId],
    ) as unknown as ActionLogEntry[];
    return rows[0] ?? null;
  }
  return memoryStore.get(actionId) ?? null;
}

export interface ListActionsOptions {
  status?: ActionStatus;
  userId?: string;
  conversationId?: string;
  limit?: number;
}

/**
 * Despite the name, supports filtering by any ActionStatus via opts.status.
 * Defaults to "pending" when no status filter is provided.
 */
export async function listPendingActions(opts?: ListActionsOptions): Promise<ActionLogEntry[]> {
  const limit = Math.min(opts?.limit ?? 50, 100);

  if (hasInternalDB()) {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIdx = 1;

    if (opts?.status) {
      conditions.push(`status = $${paramIdx++}`);
      params.push(opts.status);
    } else {
      conditions.push(`status = $${paramIdx++}`);
      params.push("pending");
    }

    if (opts?.userId) {
      conditions.push(`requested_by = $${paramIdx++}`);
      params.push(opts.userId);
    }

    if (opts?.conversationId) {
      conditions.push(`conversation_id = $${paramIdx++}`);
      params.push(opts.conversationId);
    }

    params.push(limit);
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = await internalQuery(
      `SELECT * FROM action_log ${where} ORDER BY requested_at DESC LIMIT $${paramIdx}`,
      params,
    ) as unknown as ActionLogEntry[];
    return rows;
  }

  // Memory-only fallback
  const targetStatus = opts?.status ?? "pending";
  let results = Array.from(memoryStore.values())
    .filter((e) => e.status === targetStatus);

  if (opts?.userId) {
    results = results.filter((e) => e.requested_by === opts.userId);
  }
  if (opts?.conversationId) {
    results = results.filter((e) => e.conversation_id === opts.conversationId);
  }

  return results
    .sort((a, b) => b.requested_at.localeCompare(a.requested_at))
    .slice(0, limit);
}

// ---------------------------------------------------------------------------
// Rollback info extraction
// ---------------------------------------------------------------------------

/** Statuses from which an action can be rolled back. */
const ROLLBACKABLE_STATUSES: ReadonlySet<ActionStatus> = new Set(["executed", "auto_approved"]);

/** Extract RollbackInfo from an action execution result, if present. */
export function extractRollbackInfo(result: unknown): RollbackInfo | null {
  if (!result || typeof result !== "object") return null;
  const r = result as Record<string, unknown>;
  const info = r.rollbackInfo;
  if (!info || typeof info !== "object") return null;
  const ri = info as Record<string, unknown>;
  if (typeof ri.method !== "string") return null;
  if (!ri.params || typeof ri.params !== "object" || Array.isArray(ri.params)) return null;
  return { method: ri.method, params: ri.params as Record<string, unknown> };
}

// ---------------------------------------------------------------------------
// Rollback
// ---------------------------------------------------------------------------

/**
 * Roll back an executed action using its stored rollback_info.
 *
 * Rollback is best-effort: the status transitions to "rolled_back" via CAS,
 * then the rollback method handler is dispatched. If dispatch fails, the error
 * is logged and stored but the status remains "rolled_back".
 *
 * Returns the updated entry, or null if CAS failed (action not in rollbackable state).
 */
export async function rollbackAction(
  actionId: string,
  userId: string,
): Promise<ActionLogEntry | null> {
  const action = await getAction(actionId);
  if (!action) return null;

  if (!ROLLBACKABLE_STATUSES.has(action.status)) {
    return null;
  }

  if (!action.rollback_info) {
    return null;
  }

  const rollbackInfo = action.rollback_info;

  // CAS: transition to rolled_back
  if (hasInternalDB()) {
    const rows = await internalQuery(
      `UPDATE action_log
       SET status = 'rolled_back', resolved_at = now()
       WHERE id = $1 AND status IN ('executed', 'auto_approved')
       RETURNING *`,
      [actionId],
    ) as unknown as ActionLogEntry[];
    if (rows.length === 0) return null;

    const entry = rows[0];
    memoryStore.set(actionId, entry);

    logActionAudit({
      actionId,
      actionType: entry.action_type,
      status: "rolled_back",
      userId,
    });

    // Best-effort dispatch
    const handler = getRollbackMethod(rollbackInfo.method);
    if (handler) {
      try {
        await handler(rollbackInfo.params);
        log.info({ actionId, method: rollbackInfo.method }, "Rollback method executed successfully");
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        log.error({ actionId, method: rollbackInfo.method, err: errorMsg }, "Rollback method failed");
        try {
          await internalQuery(
            `UPDATE action_log SET error = $1 WHERE id = $2`,
            [errorMsg, actionId],
          );
          entry.error = errorMsg;
          memoryStore.set(actionId, entry);
        } catch (dbErr) {
          log.error({ err: dbErr, actionId }, "Failed to persist rollback error to DB");
        }

        logActionAudit({
          actionId,
          actionType: entry.action_type,
          status: "rolled_back",
          userId,
          error: errorMsg,
        });
      }
    } else {
      const noHandlerMsg = `No rollback handler registered for method: ${rollbackInfo.method}`;
      log.warn({ actionId, method: rollbackInfo.method }, "No rollback handler registered for method — status updated but rollback not dispatched");
      try {
        await internalQuery(
          `UPDATE action_log SET error = $1 WHERE id = $2`,
          [noHandlerMsg, actionId],
        );
      } catch (dbErr) {
        log.error({ err: dbErr, actionId }, "Failed to persist missing-handler error to DB");
      }
      entry.error = noHandlerMsg;
      memoryStore.set(actionId, entry);
    }

    return entry;
  }

  // Memory-only fallback
  const entry = memoryStore.get(actionId);
  if (!entry || !ROLLBACKABLE_STATUSES.has(entry.status)) return null;

  const rolledBack: ActionLogEntry = {
    ...entry,
    status: "rolled_back",
    resolved_at: new Date().toISOString(),
  };
  memoryStore.set(actionId, rolledBack);

  logActionAudit({
    actionId,
    actionType: entry.action_type,
    status: "rolled_back",
    userId,
  });

  // Best-effort dispatch
  const handler = getRollbackMethod(rollbackInfo.method);
  if (handler) {
    try {
      await handler(rollbackInfo.params);
      log.info({ actionId, method: rollbackInfo.method }, "Rollback method executed successfully");
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      log.error({ actionId, method: rollbackInfo.method, err: errorMsg }, "Rollback method failed");
      rolledBack.error = errorMsg;
      memoryStore.set(actionId, rolledBack);

      logActionAudit({
        actionId,
        actionType: entry.action_type,
        status: "rolled_back",
        userId,
        error: errorMsg,
      });
    }
  } else {
    const noHandlerMsg = `No rollback handler registered for method: ${rollbackInfo.method}`;
    log.warn({ actionId, method: rollbackInfo.method }, "No rollback handler registered for method — status updated but rollback not dispatched");
    rolledBack.error = noHandlerMsg;
    memoryStore.set(actionId, rolledBack);
  }

  return rolledBack;
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

export function _resetActionStore(): void {
  memoryStore.clear();
  executorRegistry.clear();
  rollbackMethodRegistry.clear();
}
