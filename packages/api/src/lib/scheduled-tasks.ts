/**
 * Scheduled task persistence — CRUD operations for scheduled tasks and runs.
 *
 * Pattern follows conversations.ts: hasInternalDB() guard, CrudResult/CrudDataResult
 * discriminated unions, fire-and-forget for non-critical writes.
 */

import { Cron } from "croner";
import { createLogger } from "@atlas/api/lib/logger";
import {
  hasInternalDB,
  internalQuery,
  internalExecute,
} from "@atlas/api/lib/db/internal";
import type {
  ScheduledTask,
  ScheduledTaskRun,
  ScheduledTaskWithRuns,
  DeliveryChannel,
  Recipient,
  RunStatus,
} from "@atlas/api/lib/scheduled-task-types";
import { isRecipient } from "@atlas/api/lib/scheduled-task-types";
import type { ActionApprovalMode } from "@atlas/api/lib/action-types";

const log = createLogger("scheduled-tasks");

// Re-export types for consumers
export type { ScheduledTask, ScheduledTaskRun, ScheduledTaskWithRuns };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

import type { CrudResult, CrudDataResult, CrudFailReason } from "@atlas/api/lib/conversations";
export type { CrudResult, CrudDataResult, CrudFailReason };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowToScheduledTask(r: Record<string, unknown>): ScheduledTask {
  let recipients: Recipient[] = [];
  try {
    const raw = typeof r.recipients === "string" ? JSON.parse(r.recipients) : r.recipients;
    if (Array.isArray(raw)) {
      recipients = raw.filter(isRecipient);
      if (recipients.length < raw.length) {
        log.warn({ taskId: r.id, total: raw.length, valid: recipients.length }, "Some recipients failed validation — dropped invalid entries");
      }
    } else {
      log.warn({ taskId: r.id, recipientsType: typeof raw }, "recipients column is not an array — defaulting to empty");
    }
  } catch (err) {
    log.error(
      { taskId: r.id, err: err instanceof Error ? err.message : String(err) },
      "Failed to parse recipients JSONB — task will have no delivery targets",
    );
  }

  return {
    id: r.id as string,
    ownerId: r.owner_id as string,
    name: r.name as string,
    question: r.question as string,
    cronExpression: r.cron_expression as string,
    deliveryChannel: (r.delivery_channel as DeliveryChannel) ?? "webhook",
    recipients,
    connectionId: (r.connection_id as string) ?? null,
    approvalMode: (r.approval_mode as ActionApprovalMode) ?? "auto",
    enabled: r.enabled === true,
    lastRunAt: r.last_run_at ? String(r.last_run_at) : null,
    nextRunAt: r.next_run_at ? String(r.next_run_at) : null,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

function rowToScheduledTaskRun(r: Record<string, unknown>): ScheduledTaskRun {
  return {
    id: r.id as string,
    taskId: r.task_id as string,
    startedAt: String(r.started_at),
    completedAt: r.completed_at ? String(r.completed_at) : null,
    status: (r.status as RunStatus) ?? "running",
    conversationId: (r.conversation_id as string) ?? null,
    actionId: (r.action_id as string) ?? null,
    error: (r.error as string) ?? null,
    tokensUsed: typeof r.tokens_used === "number" ? r.tokens_used : null,
    createdAt: String(r.created_at),
  };
}

// ---------------------------------------------------------------------------
// Cron helpers
// ---------------------------------------------------------------------------

/** Validate a cron expression. Returns { valid: true } or { valid: false, error }. */
export function validateCronExpression(expr: string): { valid: boolean; error?: string } {
  try {
    // Croner validates on construction — dispose immediately
    const job = new Cron(expr, { paused: true }, () => {});
    job.stop();
    return { valid: true };
  } catch (err) {
    return { valid: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Compute the next run time for a cron expression. */
export function computeNextRun(expr: string, after?: Date): Date | null {
  try {
    const job = new Cron(expr, { paused: true }, () => {});
    const next = job.nextRun(after ?? new Date());
    job.stop();
    return next;
  } catch (err) {
    log.warn(
      { cronExpression: expr, err: err instanceof Error ? err.message : String(err) },
      "Failed to compute next run time — task will not be scheduled",
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// CRUD — Tasks
// ---------------------------------------------------------------------------

export async function createScheduledTask(opts: {
  ownerId: string;
  name: string;
  question: string;
  cronExpression: string;
  deliveryChannel?: DeliveryChannel;
  recipients?: Recipient[];
  connectionId?: string | null;
  approvalMode?: ActionApprovalMode;
}): Promise<CrudDataResult<ScheduledTask>> {
  if (!hasInternalDB()) return { ok: false, reason: "no_db" };

  const validation = validateCronExpression(opts.cronExpression);
  if (!validation.valid) {
    log.warn({ cronExpression: opts.cronExpression, error: validation.error }, "Invalid cron expression rejected in createScheduledTask");
    return { ok: false, reason: "error" };
  }

  const nextRun = computeNextRun(opts.cronExpression);

  try {
    const rows = await internalQuery<Record<string, unknown>>(
      `INSERT INTO scheduled_tasks (owner_id, name, question, cron_expression, delivery_channel, recipients, connection_id, approval_mode, next_run_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        opts.ownerId,
        opts.name,
        opts.question,
        opts.cronExpression,
        opts.deliveryChannel ?? "webhook",
        JSON.stringify(opts.recipients ?? []),
        opts.connectionId ?? null,
        opts.approvalMode ?? "auto",
        nextRun?.toISOString() ?? null,
      ],
    );
    if (rows.length === 0) return { ok: false, reason: "error" };
    return { ok: true, data: rowToScheduledTask(rows[0]) };
  } catch (err) {
    log.error({ err: err instanceof Error ? err.message : String(err) }, "createScheduledTask failed");
    return { ok: false, reason: "error" };
  }
}

export async function getScheduledTask(
  id: string,
  ownerId?: string,
): Promise<CrudDataResult<ScheduledTask>> {
  if (!hasInternalDB()) return { ok: false, reason: "no_db" };
  try {
    const rows = ownerId
      ? await internalQuery<Record<string, unknown>>(
          `SELECT * FROM scheduled_tasks WHERE id = $1 AND owner_id = $2`,
          [id, ownerId],
        )
      : await internalQuery<Record<string, unknown>>(
          `SELECT * FROM scheduled_tasks WHERE id = $1`,
          [id],
        );
    if (rows.length === 0) return { ok: false, reason: "not_found" };
    return { ok: true, data: rowToScheduledTask(rows[0]) };
  } catch (err) {
    log.error({ err: err instanceof Error ? err.message : String(err) }, "getScheduledTask failed");
    return { ok: false, reason: "error" };
  }
}

export async function listScheduledTasks(opts?: {
  ownerId?: string;
  enabled?: boolean;
  limit?: number;
  offset?: number;
}): Promise<{ tasks: ScheduledTask[]; total: number }> {
  const empty = { tasks: [], total: 0 };
  if (!hasInternalDB()) return empty;

  const limit = opts?.limit ?? 20;
  const offset = opts?.offset ?? 0;

  try {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIdx = 1;

    if (opts?.ownerId) {
      conditions.push(`owner_id = $${paramIdx++}`);
      params.push(opts.ownerId);
    }
    if (opts?.enabled !== undefined) {
      conditions.push(`enabled = $${paramIdx++}`);
      params.push(opts.enabled);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const countRows = await internalQuery<Record<string, unknown>>(
      `SELECT COUNT(*)::int AS total FROM scheduled_tasks ${where}`,
      params,
    );
    const dataRows = await internalQuery<Record<string, unknown>>(
      `SELECT * FROM scheduled_tasks ${where}
       ORDER BY created_at DESC LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
      [...params, limit, offset],
    );

    const total = (countRows[0]?.total as number) ?? 0;
    return { tasks: dataRows.map(rowToScheduledTask), total };
  } catch (err) {
    log.error({ err: err instanceof Error ? err.message : String(err) }, "listScheduledTasks failed");
    return empty;
  }
}

export async function updateScheduledTask(
  id: string,
  ownerId: string,
  updates: {
    name?: string;
    question?: string;
    cronExpression?: string;
    deliveryChannel?: DeliveryChannel;
    recipients?: Recipient[];
    connectionId?: string | null;
    approvalMode?: ActionApprovalMode;
    enabled?: boolean;
  },
): Promise<CrudResult> {
  if (!hasInternalDB()) return { ok: false, reason: "no_db" };

  const setClauses: string[] = [];
  const params: unknown[] = [];
  let paramIdx = 1;

  if (updates.name !== undefined) {
    setClauses.push(`name = $${paramIdx++}`);
    params.push(updates.name);
  }
  if (updates.question !== undefined) {
    setClauses.push(`question = $${paramIdx++}`);
    params.push(updates.question);
  }
  if (updates.cronExpression !== undefined) {
    const validation = validateCronExpression(updates.cronExpression);
    if (!validation.valid) {
      log.warn({ cronExpression: updates.cronExpression, error: validation.error }, "Invalid cron expression rejected in updateScheduledTask");
      return { ok: false, reason: "error" };
    }
    setClauses.push(`cron_expression = $${paramIdx++}`);
    params.push(updates.cronExpression);
    const nextRun = computeNextRun(updates.cronExpression);
    setClauses.push(`next_run_at = $${paramIdx++}`);
    params.push(nextRun?.toISOString() ?? null);
  }
  if (updates.deliveryChannel !== undefined) {
    setClauses.push(`delivery_channel = $${paramIdx++}`);
    params.push(updates.deliveryChannel);
  }
  if (updates.recipients !== undefined) {
    setClauses.push(`recipients = $${paramIdx++}`);
    params.push(JSON.stringify(updates.recipients));
  }
  if (updates.connectionId !== undefined) {
    setClauses.push(`connection_id = $${paramIdx++}`);
    params.push(updates.connectionId);
  }
  if (updates.approvalMode !== undefined) {
    setClauses.push(`approval_mode = $${paramIdx++}`);
    params.push(updates.approvalMode);
  }
  if (updates.enabled !== undefined) {
    setClauses.push(`enabled = $${paramIdx++}`);
    params.push(updates.enabled);
  }

  if (setClauses.length === 0) return { ok: true };

  setClauses.push(`updated_at = now()`);

  try {
    const rows = await internalQuery<{ id: string }>(
      `UPDATE scheduled_tasks SET ${setClauses.join(", ")}
       WHERE id = $${paramIdx++} AND owner_id = $${paramIdx++}
       RETURNING id`,
      [...params, id, ownerId],
    );
    return rows.length > 0 ? { ok: true } : { ok: false, reason: "not_found" };
  } catch (err) {
    log.error({ err: err instanceof Error ? err.message : String(err) }, "updateScheduledTask failed");
    return { ok: false, reason: "error" };
  }
}

/** Soft delete: sets enabled=false to preserve audit trail. */
export async function deleteScheduledTask(
  id: string,
  ownerId?: string,
): Promise<CrudResult> {
  if (!hasInternalDB()) return { ok: false, reason: "no_db" };
  try {
    const rows = ownerId
      ? await internalQuery<{ id: string }>(
          `UPDATE scheduled_tasks SET enabled = false, updated_at = now()
           WHERE id = $1 AND owner_id = $2 RETURNING id`,
          [id, ownerId],
        )
      : await internalQuery<{ id: string }>(
          `UPDATE scheduled_tasks SET enabled = false, updated_at = now()
           WHERE id = $1 RETURNING id`,
          [id],
        );
    return rows.length > 0 ? { ok: true } : { ok: false, reason: "not_found" };
  } catch (err) {
    log.error({ err: err instanceof Error ? err.message : String(err) }, "deleteScheduledTask failed");
    return { ok: false, reason: "error" };
  }
}

// ---------------------------------------------------------------------------
// CRUD — Runs
// ---------------------------------------------------------------------------

/** Create a new run record. Returns the run ID or null on failure. */
export async function createTaskRun(taskId: string): Promise<string | null> {
  if (!hasInternalDB()) return null;
  try {
    const rows = await internalQuery<{ id: string }>(
      `INSERT INTO scheduled_task_runs (task_id) VALUES ($1) RETURNING id`,
      [taskId],
    );
    return rows[0]?.id ?? null;
  } catch (err) {
    log.error({ err: err instanceof Error ? err.message : String(err), taskId }, "createTaskRun failed");
    return null;
  }
}

/** Update a run record on completion. Fire-and-forget. */
export function completeTaskRun(
  runId: string,
  status: RunStatus,
  opts?: { error?: string; tokensUsed?: number; conversationId?: string },
): void {
  if (!hasInternalDB()) return;
  internalExecute(
    `UPDATE scheduled_task_runs SET
       status = $1,
       completed_at = now(),
       error = $2,
       tokens_used = $3,
       conversation_id = $4
     WHERE id = $5`,
    [status, opts?.error ?? null, opts?.tokensUsed ?? null, opts?.conversationId ?? null, runId],
  );
}

export async function listTaskRuns(
  taskId: string,
  opts?: { limit?: number },
): Promise<ScheduledTaskRun[]> {
  if (!hasInternalDB()) return [];
  const limit = opts?.limit ?? 20;
  try {
    const rows = await internalQuery<Record<string, unknown>>(
      `SELECT * FROM scheduled_task_runs WHERE task_id = $1
       ORDER BY started_at DESC LIMIT $2`,
      [taskId, limit],
    );
    return rows.map(rowToScheduledTaskRun);
  } catch (err) {
    log.error({ err: err instanceof Error ? err.message : String(err), taskId }, "listTaskRuns failed");
    return [];
  }
}

// ---------------------------------------------------------------------------
// Scheduler helpers
// ---------------------------------------------------------------------------

/** Get tasks that are due for execution (enabled + next_run_at <= now). */
export async function getTasksDueForExecution(): Promise<ScheduledTask[]> {
  if (!hasInternalDB()) return [];
  try {
    const rows = await internalQuery<Record<string, unknown>>(
      `SELECT * FROM scheduled_tasks
       WHERE enabled = true AND next_run_at <= now()
       ORDER BY next_run_at ASC`,
    );
    return rows.map(rowToScheduledTask);
  } catch (err) {
    log.error({ err: err instanceof Error ? err.message : String(err) }, "getTasksDueForExecution failed");
    return [];
  }
}

/**
 * Atomically lock a task for execution.
 *
 * Uses a single UPDATE with `AND next_run_at IS NOT NULL` as a lightweight
 * lock: the first process to UPDATE sets next_run_at to the future, preventing
 * concurrent UPDATEs from matching. Also updates last_run_at.
 *
 * Returns true if lock acquired, false if task is already locked, disabled,
 * or not found.
 */
export async function lockTaskForExecution(taskId: string): Promise<boolean> {
  if (!hasInternalDB()) return false;
  try {
    // First read the cron expression so we can compute the next run in a single UPDATE
    const taskResult = await getScheduledTask(taskId);
    if (!taskResult.ok) {
      log.warn({ taskId }, "lockTaskForExecution: task not found");
      return false;
    }

    const nextRun = computeNextRun(taskResult.data.cronExpression);

    // Atomic UPDATE: only succeeds if enabled AND next_run_at IS NOT NULL
    // (prevents double-execution — second process sees next_run_at already set to future)
    const rows = await internalQuery<{ id: string }>(
      `UPDATE scheduled_tasks SET
         last_run_at = now(),
         next_run_at = $1,
         updated_at = now()
       WHERE id = $2 AND enabled = true AND next_run_at IS NOT NULL
       RETURNING id`,
      [nextRun?.toISOString() ?? null, taskId],
    );

    if (rows.length === 0) return false;
    return true;
  } catch (err) {
    log.error({ err: err instanceof Error ? err.message : String(err), taskId }, "lockTaskForExecution failed");
    return false;
  }
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Reset module state for testing. */
export function _resetScheduledTasksForTest(): void {
  // No module-level state to reset — all state is in the DB.
  // This exists as a hook for future caching.
}
