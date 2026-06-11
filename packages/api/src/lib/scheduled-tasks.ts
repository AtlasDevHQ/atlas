/**
 * Scheduled task persistence — CRUD operations for scheduled tasks and runs.
 *
 * Pattern follows conversations.ts: hasInternalDB() guard, CrudResult/CrudDataResult
 * discriminated unions, fire-and-forget for non-critical writes.
 *
 * All CRUD operations scope by org_id. The scheduler's internal helpers
 * (getTasksDueForExecution, lockTaskForExecution) are unscoped since they
 * run from the /tick endpoint which has its own cron-secret auth.
 */

import { Cron } from "croner";
import { createLogger } from "@atlas/api/lib/logger";
import { errorMessage } from "@atlas/api/lib/audit/error-scrub";
import {
  hasInternalDB,
  internalQuery,
  internalExecute,
} from "@atlas/api/lib/db/internal";
import { withGroupScope } from "@atlas/api/lib/db/with-group-scope";
import type {
  ScheduledTask,
  ScheduledTaskRun,
  ScheduledTaskRunWithTaskName,
  ScheduledTaskWithRuns,
  DeliveryChannel,
  DeliveryStatus,
  Recipient,
  RunStatus,
} from "@atlas/api/lib/scheduled-task-types";
import { KNOWN_DELIVERY_STATUSES } from "@atlas/api/lib/scheduled-task-types";
import { isRecipient } from "@atlas/api/lib/scheduled-task-types";
import type { ActionApprovalMode } from "@atlas/api/lib/action-types";

const log = createLogger("scheduled-tasks");

// Re-export types for consumers
export type { ScheduledTask, ScheduledTaskRun, ScheduledTaskRunWithTaskName, ScheduledTaskWithRuns };

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
      { taskId: r.id, err: errorMessage(err) },
      "Failed to parse recipients JSONB — task will have no delivery targets",
    );
  }

  return {
    id: r.id as string,
    ownerId: r.owner_id as string,
    orgId: typeof r.org_id === "string" ? r.org_id : null,
    name: r.name as string,
    question: r.question as string,
    cronExpression: r.cron_expression as string,
    deliveryChannel: (r.delivery_channel as DeliveryChannel) ?? "webhook",
    recipients,
    connectionGroupId: (r.connection_group_id as string) ?? null,
    approvalMode: (r.approval_mode as ActionApprovalMode) ?? "auto",
    enabled: r.enabled === true,
    lastRunAt: r.last_run_at ? String(r.last_run_at) : null,
    nextRunAt: r.next_run_at ? String(r.next_run_at) : null,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

function rowToScheduledTaskRun(r: Record<string, unknown>): ScheduledTaskRun {
  const rawDeliveryStatus = r.delivery_status as string | null | undefined;
  // KNOWN_DELIVERY_STATUSES (not the published DELIVERY_STATUSES) so
  // "failed_permanent" rows survive the boundary instead of mapping to null
  // and hiding the misconfiguration signal from the run-history UI (#3379).
  const deliveryStatus: DeliveryStatus | null =
    rawDeliveryStatus && KNOWN_DELIVERY_STATUSES.includes(rawDeliveryStatus)
      ? (rawDeliveryStatus as DeliveryStatus)
      : null;

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
    deliveryStatus,
    deliveryError: (r.delivery_error as string) ?? null,
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
    return { valid: false, error: errorMessage(err) };
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
      { cronExpression: expr, err: errorMessage(err) },
      "Failed to compute next run time — task will not be scheduled",
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Org scoping helper
// ---------------------------------------------------------------------------

/** Builds an org_id filter clause. When orgId is provided, uses a parameterized match; otherwise matches NULL. */
function orgScopeClause(
  orgId: string | null | undefined,
  params: unknown[],
  paramIdx: number,
  tableAlias?: string,
): { clause: string; nextIdx: number } {
  const col = tableAlias ? `${tableAlias}.org_id` : "org_id";
  if (orgId) {
    params.push(orgId);
    return { clause: `${col} = $${paramIdx}`, nextIdx: paramIdx + 1 };
  }
  return { clause: `${col} IS NULL`, nextIdx: paramIdx };
}

// ---------------------------------------------------------------------------
// CRUD — Tasks
// ---------------------------------------------------------------------------

export async function createScheduledTask(opts: {
  ownerId: string;
  orgId?: string | null;
  name: string;
  question: string;
  cronExpression: string;
  deliveryChannel?: DeliveryChannel;
  recipients?: Recipient[];
  connectionGroupId?: string | null;
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
      `INSERT INTO scheduled_tasks (owner_id, org_id, name, question, cron_expression, delivery_channel, recipients, connection_group_id, approval_mode, next_run_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        opts.ownerId,
        opts.orgId ?? null,
        opts.name,
        opts.question,
        opts.cronExpression,
        opts.deliveryChannel ?? "webhook",
        JSON.stringify(opts.recipients ?? []),
        opts.connectionGroupId ?? null,
        opts.approvalMode ?? "auto",
        nextRun?.toISOString() ?? null,
      ],
    );
    if (rows.length === 0) return { ok: false, reason: "error" };
    return { ok: true, data: rowToScheduledTask(rows[0]) };
  } catch (err) {
    log.error({ err: errorMessage(err) }, "createScheduledTask failed");
    return { ok: false, reason: "error" };
  }
}

/**
 * Get a scheduled task by ID.
 *
 * When scope is provided, the query is filtered by org_id (org-scoped
 * admin access). When omitted, no org filter is applied (used by the
 * scheduler engine internal lookups).
 */
export async function getScheduledTask(
  id: string,
  scope?: { orgId?: string | null; connectionGroupId?: string | null },
): Promise<CrudDataResult<ScheduledTask>> {
  if (!hasInternalDB()) return { ok: false, reason: "no_db" };
  try {
    let rows: Record<string, unknown>[];
    if (scope !== undefined) {
      // Org-scoped lookup (admin routes)
      const params: unknown[] = [id];
      const org = orgScopeClause(scope.orgId, params, 2);
      const group = "connectionGroupId" in scope ? withGroupScope(scope.connectionGroupId) : null;
      if (group) params.push(group.param);
      rows = await internalQuery<Record<string, unknown>>(
        `SELECT * FROM scheduled_tasks WHERE id = $1 AND ${org.clause}${
          group ? ` AND ${group.match(org.nextIdx, { column: "connection_group_id" })}` : ""
        }`,
        params,
      );
    } else {
      // Unscoped lookup (scheduler engine internals)
      rows = await internalQuery<Record<string, unknown>>(
        `SELECT * FROM scheduled_tasks WHERE id = $1`,
        [id],
      );
    }
    if (rows.length === 0) return { ok: false, reason: "not_found" };
    return { ok: true, data: rowToScheduledTask(rows[0]) };
  } catch (err) {
    log.error({ err: errorMessage(err) }, "getScheduledTask failed");
    return { ok: false, reason: "error" };
  }
}

export async function listScheduledTasks(opts?: {
  orgId?: string | null;
  enabled?: boolean;
  connectionGroupId?: string | null;
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

    // Always scope by org
    const org = orgScopeClause(opts?.orgId, params, paramIdx);
    conditions.push(org.clause);
    paramIdx = org.nextIdx;

    if (opts?.enabled !== undefined) {
      conditions.push(`enabled = $${paramIdx++}`);
      params.push(opts.enabled);
    }
    if (opts !== undefined && "connectionGroupId" in opts) {
      const group = withGroupScope(opts.connectionGroupId);
      conditions.push(group.match(paramIdx, { column: "connection_group_id" }));
      params.push(group.param);
      paramIdx++;
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
    log.error({ err: errorMessage(err) }, "listScheduledTasks failed");
    return empty;
  }
}

export async function updateScheduledTask(
  id: string,
  scope: { orgId?: string | null },
  updates: {
    name?: string;
    question?: string;
    cronExpression?: string;
    deliveryChannel?: DeliveryChannel;
    recipients?: Recipient[];
    connectionGroupId?: string | null;
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
  // `connection_group_id` mutates iff the caller sets `connectionGroupId`
  // — no implicit re-derivation from any sibling field. The absence of a
  // re-derivation branch is load-bearing (#2418); covered by the
  // `PATCH connection_group_id semantics` block in the unit tests.
  if (updates.connectionGroupId !== undefined) {
    setClauses.push(`connection_group_id = $${paramIdx++}`);
    params.push(updates.connectionGroupId);
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

  const org = orgScopeClause(scope.orgId, params, paramIdx);
  paramIdx = org.nextIdx;

  try {
    const rows = await internalQuery<{ id: string }>(
      `UPDATE scheduled_tasks SET ${setClauses.join(", ")}
       WHERE id = $${paramIdx} AND ${org.clause}
       RETURNING id`,
      [...params, id],
    );
    return rows.length > 0 ? { ok: true } : { ok: false, reason: "not_found" };
  } catch (err) {
    log.error({ err: errorMessage(err) }, "updateScheduledTask failed");
    return { ok: false, reason: "error" };
  }
}

/** Soft delete: sets enabled=false to preserve audit trail. */
export async function deleteScheduledTask(
  id: string,
  scope?: { orgId?: string | null },
): Promise<CrudResult> {
  if (!hasInternalDB()) return { ok: false, reason: "no_db" };
  try {
    const params: unknown[] = [id];
    const org = orgScopeClause(scope?.orgId, params, 2);
    const rows = await internalQuery<{ id: string }>(
      `UPDATE scheduled_tasks SET enabled = false, updated_at = now()
       WHERE id = $1 AND ${org.clause} RETURNING id`,
      params,
    );
    return rows.length > 0 ? { ok: true } : { ok: false, reason: "not_found" };
  } catch (err) {
    log.error({ err: errorMessage(err) }, "deleteScheduledTask failed");
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
    log.error({ err: errorMessage(err), taskId }, "createTaskRun failed");
    return null;
  }
}

/**
 * Update delivery status on a run record. Fire-and-forget.
 *
 * The `| "failed_permanent"` widening is redundant against the workspace
 * `DeliveryStatus` union but load-bearing against the *published* `.d.ts`
 * that scaffold builds compile this file with (see
 * {@link KNOWN_DELIVERY_STATUSES}).
 */
export function updateRunDeliveryStatus(
  runId: string,
  status: DeliveryStatus | "failed_permanent",
  error?: string,
): void {
  if (!hasInternalDB()) return;
  internalExecute(
    `UPDATE scheduled_task_runs SET delivery_status = $1, delivery_error = $2 WHERE id = $3`,
    [status, error ?? null, runId],
  );
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

/** List runs across all tasks with optional filters. */
export async function listAllRuns(opts?: {
  orgId?: string | null;
  taskId?: string;
  status?: RunStatus;
  dateFrom?: string;
  dateTo?: string;
  limit?: number;
  offset?: number;
}): Promise<{ runs: ScheduledTaskRunWithTaskName[]; total: number }> {
  const empty = { runs: [], total: 0 };
  if (!hasInternalDB()) return empty;

  const limit = opts?.limit ?? 20;
  const offset = opts?.offset ?? 0;

  try {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIdx = 1;

    // Org scoping — runs are filtered via the parent task's org_id
    const org = orgScopeClause(opts?.orgId, params, paramIdx, "t");
    conditions.push(org.clause);
    paramIdx = org.nextIdx;

    if (opts?.taskId) {
      conditions.push(`r.task_id = $${paramIdx++}`);
      params.push(opts.taskId);
    }
    if (opts?.status) {
      conditions.push(`r.status = $${paramIdx++}`);
      params.push(opts.status);
    }
    if (opts?.dateFrom) {
      conditions.push(`r.started_at >= $${paramIdx++}`);
      params.push(opts.dateFrom);
    }
    if (opts?.dateTo) {
      conditions.push(`r.started_at <= $${paramIdx++}`);
      params.push(opts.dateTo);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const [countRows, dataRows] = await Promise.all([
      internalQuery<Record<string, unknown>>(
        `SELECT COUNT(*)::int AS total
         FROM scheduled_task_runs r
         JOIN scheduled_tasks t ON t.id = r.task_id
         ${where}`,
        params,
      ),
      internalQuery<Record<string, unknown>>(
        `SELECT r.*, t.name AS task_name
         FROM scheduled_task_runs r
         JOIN scheduled_tasks t ON t.id = r.task_id
         ${where}
         ORDER BY r.started_at DESC
         LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
        [...params, limit, offset],
      ),
    ]);

    const total = (countRows[0]?.total as number) ?? 0;
    const runs = dataRows.map((row) => ({
      ...rowToScheduledTaskRun(row),
      taskName: (row.task_name as string) ?? "Unknown",
    }));
    return { runs, total };
  } catch (err) {
    log.error({ err: errorMessage(err) }, "listAllRuns failed");
    return empty;
  }
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
    log.error({ err: errorMessage(err), taskId }, "listTaskRuns failed");
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
    // Orphan guard (#3180): a plugin-owned task whose owning install row is
    // gone must never be dispatched — otherwise it consumes a tick, a
    // task_run row, and tokens before failing downstream. Exclude any task
    // with a non-null plugin_id that has NO live workspace_plugins row
    // matching on (catalog_id = plugin_id, workspace_id = org_id) — the exact
    // pair the uninstall cleanup and orphan-reconcile sweep scope by (see
    // lib/scheduler/orphan-task-reconcile.ts). Non-plugin tasks
    // (plugin_id IS NULL) are always eligible.
    const rows = await internalQuery<Record<string, unknown>>(
      `SELECT st.* FROM scheduled_tasks st
       WHERE st.enabled = true AND st.next_run_at <= now()
         AND (
           st.plugin_id IS NULL
           OR EXISTS (
             SELECT 1 FROM workspace_plugins wp
             WHERE wp.catalog_id = st.plugin_id
               AND wp.workspace_id = st.org_id
           )
         )
       ORDER BY st.next_run_at ASC`,
    );
    return rows.map(rowToScheduledTask);
  } catch (err) {
    log.error({ err: errorMessage(err) }, "getTasksDueForExecution failed");
    return [];
  }
}

/**
 * Atomically lock a task for execution.
 *
 * Uses a single UPDATE with AND next_run_at IS NOT NULL as a lightweight
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
    // Note: unscoped lookup — scheduler runs across all orgs
    const taskResult = await getScheduledTask(taskId);
    if (!taskResult.ok) {
      log.warn({ taskId }, "lockTaskForExecution: task not found");
      return false;
    }

    const nextRun = computeNextRun(taskResult.data.cronExpression);

    // Atomic UPDATE: only succeeds if enabled AND next_run_at IS NOT NULL
    // (prevents double-execution — second process sees next_run_at already set to future).
    //
    // Orphan guard (#3180 / #3196 review): re-check plugin ownership HERE, not
    // just at getTasksDueForExecution time. The tick selects due tasks, then
    // locks + dispatches each in separate statements — so an uninstall that
    // deletes the workspace_plugins row between the SELECT and this UPDATE
    // would otherwise let an already-selected orphan acquire the lock and run
    // once. Re-evaluating the same (catalog_id = plugin_id, workspace_id =
    // org_id) predicate inside the lock UPDATE closes that TOCTOU window
    // atomically: a task orphaned mid-tick fails to lock and is never dispatched.
    const rows = await internalQuery<{ id: string }>(
      `UPDATE scheduled_tasks SET
         last_run_at = now(),
         next_run_at = $1,
         updated_at = now()
       WHERE id = $2 AND enabled = true AND next_run_at IS NOT NULL
         AND (
           plugin_id IS NULL
           OR EXISTS (
             SELECT 1 FROM workspace_plugins wp
             WHERE wp.catalog_id = scheduled_tasks.plugin_id
               AND wp.workspace_id = scheduled_tasks.org_id
           )
         )
       RETURNING id`,
      [nextRun?.toISOString() ?? null, taskId],
    );

    if (rows.length === 0) return false;
    return true;
  } catch (err) {
    log.error({ err: errorMessage(err), taskId }, "lockTaskForExecution failed");
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
