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
} from "@atlas/api/lib/action-types";
import type { AtlasRole } from "@atlas/api/lib/auth/types";
import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import { createLogger, getRequestContext } from "@atlas/api/lib/logger";
import { getConfig, type ActionsConfig, type PerActionConfig } from "@atlas/api/lib/config";
import { parseRole } from "@atlas/api/lib/auth/permissions";
import { logActionAudit } from "./audit";

const log = createLogger("action-handler");

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
// Config resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the effective approval mode for an action type.
 * Priority: per-action override > config defaults > action's defaultApproval > "manual".
 */
// Note: timeout and maxPerConversation are resolved here but not yet enforced — reserved for future implementation
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
};

async function updateActionStatus(
  id: string,
  updates: Partial<Pick<ActionLogEntry, "status" | "resolved_at" | "executed_at" | "approved_by" | "result" | "error">>,
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
      params.push(colName === "result" ? JSON.stringify(value) : value);
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
      const result = await executeFn(request.payload);
      const latencyMs = Date.now() - startMs;

      await updateActionStatus(request.id, {
        status: "auto_approved",
        resolved_at: new Date().toISOString(),
        executed_at: new Date().toISOString(),
        approved_by: "system:auto",
        result,
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

      return { status: "error", actionId: request.id, error: errorMsg };
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
      const startMs = Date.now();
      try {
        const result = await resolveFn(entry.payload);
        const latencyMs = Date.now() - startMs;

        const execRows = await internalQuery(
          `UPDATE action_log SET status = 'executed', executed_at = now(), result = $1 WHERE id = $2 RETURNING *`,
          [JSON.stringify(result), actionId],
        ) as unknown as ActionLogEntry[];
        const updated = execRows[0] ?? { ...entry, status: "executed" as ActionStatus, executed_at: new Date().toISOString(), result };
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
    const startMs = Date.now();
    try {
      const result = await resolveFn(entry.payload);
      const latencyMs = Date.now() - startMs;
      const executed: ActionLogEntry = {
        ...approved,
        status: "executed",
        executed_at: new Date().toISOString(),
        result,
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
// Test helpers
// ---------------------------------------------------------------------------

export function _resetActionStore(): void {
  memoryStore.clear();
  executorRegistry.clear();
}
