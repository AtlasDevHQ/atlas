/**
 * Scheduler engine — tick-based loop that finds due tasks and executes them.
 *
 * Factory function returns a Scheduler object with start/stop lifecycle.
 * Singleton via getScheduler() / _resetScheduler().
 */

import { createLogger } from "@atlas/api/lib/logger";
import {
  getTasksDueForExecution,
  lockTaskForExecution,
  createTaskRun,
  completeTaskRun,
  computeNextRun,
  getScheduledTask,
} from "@atlas/api/lib/scheduled-tasks";
import { internalExecute } from "@atlas/api/lib/db/internal";
import { executeScheduledTask } from "./executor";
import { getConfig } from "@atlas/api/lib/config";

const log = createLogger("scheduler");

export interface Scheduler {
  start(): void;
  stop(): void;
  isRunning(): boolean;
}

// ---------------------------------------------------------------------------
// Shared helpers (used by both createScheduler and runTick)
// ---------------------------------------------------------------------------

async function rescheduleTask(taskId: string) {
  try {
    const taskResult = await getScheduledTask(taskId);
    if (taskResult.ok) {
      const nextRun = computeNextRun(taskResult.data.cronExpression);
      if (nextRun) {
        internalExecute(
          `UPDATE scheduled_tasks SET next_run_at = $1 WHERE id = $2`,
          [nextRun.toISOString(), taskId],
        );
      }
    }
  } catch (err) {
    log.error({ taskId, err: err instanceof Error ? err.message : String(err) }, "Failed to reschedule task");
  }
}

function createScheduler(): Scheduler {
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;
  let activeTasks = 0;

  function getSchedulerConfig() {
    const config = getConfig();
    return {
      maxConcurrentTasks: config?.scheduler?.maxConcurrentTasks ?? 5,
      taskTimeout: config?.scheduler?.taskTimeout ?? 60_000,
      tickIntervalSeconds: config?.scheduler?.tickIntervalSeconds ?? 60,
    };
  }

  async function tick() {
    const cfg = getSchedulerConfig();

    if (activeTasks >= cfg.maxConcurrentTasks) {
      log.debug({ activeTasks, max: cfg.maxConcurrentTasks }, "Scheduler tick skipped — at capacity");
      return;
    }

    let dueTasks;
    try {
      dueTasks = await getTasksDueForExecution();
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err) }, "Failed to fetch due tasks");
      return;
    }

    if (dueTasks.length === 0) return;

    log.info({ count: dueTasks.length }, "Scheduler tick — found due tasks");

    const slotsAvailable = cfg.maxConcurrentTasks - activeTasks;
    const tasksToRun = dueTasks.slice(0, slotsAvailable);

    for (const task of tasksToRun) {
      try {
        const locked = await lockTaskForExecution(task.id);
        if (!locked) {
          log.debug({ taskId: task.id }, "Task already locked by another process");
          continue;
        }

        activeTasks++;
        executeAndDeliver(task.id, cfg.taskTimeout).finally(() => {
          activeTasks--;
        });
      } catch (err) {
        log.error({ taskId: task.id, err: err instanceof Error ? err.message : String(err) }, "Failed to lock/dispatch task");
      }
    }
  }

  async function executeAndDeliver(taskId: string, timeoutMs: number) {
    const runId = await createTaskRun(taskId);
    if (!runId) {
      log.error({ taskId }, "Failed to create run record — attempting to reschedule");
      await rescheduleTask(taskId);
      return;
    }

    try {
      const result = await executeScheduledTask(taskId, runId, timeoutMs);
      completeTaskRun(runId, "success", { tokensUsed: result.tokensUsed });
      log.info({ taskId, runId, tokensUsed: result.tokensUsed }, "Scheduled task completed successfully");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      completeTaskRun(runId, "failed", { error: message });
      log.error({ taskId, runId, err: message }, "Scheduled task failed");
    }
  }

  return {
    start() {
      if (running) return;
      running = true;

      const cfg = getSchedulerConfig();
      log.info(
        { intervalSeconds: cfg.tickIntervalSeconds, maxConcurrent: cfg.maxConcurrentTasks },
        "Scheduler starting",
      );

      // First tick fires immediately
      void tick().catch((err) => {
        log.error({ err: err instanceof Error ? err.message : String(err) }, "Scheduler tick crashed");
      });

      timer = setInterval(() => {
        void tick().catch((err) => {
          log.error({ err: err instanceof Error ? err.message : String(err) }, "Scheduler tick crashed");
        });
      }, cfg.tickIntervalSeconds * 1000);
      timer.unref();
    },

    stop() {
      if (!running) return;
      running = false;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      log.info("Scheduler stopped");
    },

    isRunning() {
      return running;
    },
  };
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _scheduler: Scheduler | null = null;

export function getScheduler(): Scheduler {
  if (!_scheduler) {
    _scheduler = createScheduler();
  }
  return _scheduler;
}

/** Trigger a single task immediately (used by POST /:id/run route). */
export async function triggerTask(taskId: string): Promise<void> {
  const config = getConfig();
  const timeoutMs = config?.scheduler?.taskTimeout ?? 60_000;

  const locked = await lockTaskForExecution(taskId);
  if (!locked) {
    throw new Error("Failed to lock task for execution — task may be disabled or already running");
  }

  const runId = await createTaskRun(taskId);
  if (!runId) {
    throw new Error("Failed to create run record");
  }

  try {
    const result = await executeScheduledTask(taskId, runId, timeoutMs);
    completeTaskRun(runId, "success", { tokensUsed: result.tokensUsed });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    completeTaskRun(runId, "failed", { error: message });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// runTick() — awaitable tick for serverless (Vercel Cron)
// ---------------------------------------------------------------------------

/**
 * Summary of a single scheduler tick.
 *
 * Invariants:
 * - All fields are non-negative integers.
 * - tasksDispatched <= tasksFound (capped by maxConcurrentTasks, reduced by lock contention).
 * - tasksCompleted + tasksFailed === tasksDispatched (every dispatched task settles).
 */
export interface TickResult {
  tasksFound: number;
  tasksDispatched: number;
  tasksCompleted: number;
  tasksFailed: number;
  /** Non-null when the tick itself failed (e.g. DB unreachable). */
  error?: string;
}

/**
 * Run a single scheduler tick that **awaits** all task executions.
 *
 * Unlike the in-process `tick()` (fire-and-forget inside `setInterval`),
 * this function returns only after every dispatched task has settled —
 * required for serverless environments where the function cannot exit early.
 *
 * When the due-task query fails, the error is surfaced in `result.error`
 * so the caller can return an appropriate HTTP status (not a silent 200).
 */
export async function runTick(): Promise<TickResult> {
  const config = getConfig();
  const maxConcurrent = config?.scheduler?.maxConcurrentTasks ?? 5;
  const taskTimeout = config?.scheduler?.taskTimeout ?? 60_000;

  let dueTasks;
  try {
    dueTasks = await getTasksDueForExecution();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err: message }, "runTick: failed to fetch due tasks");
    return { tasksFound: 0, tasksDispatched: 0, tasksCompleted: 0, tasksFailed: 0, error: message };
  }

  if (dueTasks.length === 0) {
    return { tasksFound: 0, tasksDispatched: 0, tasksCompleted: 0, tasksFailed: 0 };
  }

  const tasksToRun = dueTasks.slice(0, maxConcurrent);
  type TaskOutcome = "completed" | "failed";
  const promises: Promise<TaskOutcome>[] = [];

  let tasksDispatched = 0;

  for (const task of tasksToRun) {
    let locked: boolean;
    try {
      locked = await lockTaskForExecution(task.id);
    } catch (err) {
      log.error({ taskId: task.id, err: err instanceof Error ? err.message : String(err) }, "runTick: lock error");
      continue;
    }
    if (!locked) {
      log.debug({ taskId: task.id }, "runTick: task already locked");
      continue;
    }

    tasksDispatched++;

    promises.push(
      (async (): Promise<TaskOutcome> => {
        const runId = await createTaskRun(task.id);
        if (!runId) {
          log.error({ taskId: task.id }, "runTick: failed to create run record — rescheduling");
          await rescheduleTask(task.id);
          return "failed";
        }
        try {
          const execResult = await executeScheduledTask(task.id, runId, taskTimeout);
          completeTaskRun(runId, "success", { tokensUsed: execResult.tokensUsed });
          log.info({ taskId: task.id, runId }, "runTick: task completed");
          return "completed";
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          completeTaskRun(runId, "failed", { error: message });
          log.error({ taskId: task.id, runId, err: message }, "runTick: task failed");
          return "failed";
        }
      })(),
    );
  }

  const outcomes = await Promise.allSettled(promises);
  let tasksCompleted = 0;
  let tasksFailed = 0;
  for (const o of outcomes) {
    if (o.status === "fulfilled" && o.value === "completed") tasksCompleted++;
    else tasksFailed++;
  }

  return {
    tasksFound: dueTasks.length,
    tasksDispatched,
    tasksCompleted,
    tasksFailed,
  };
}

/** Reset singleton for testing. */
export function _resetScheduler(): void {
  if (_scheduler) {
    _scheduler.stop();
    _scheduler = null;
  }
}
