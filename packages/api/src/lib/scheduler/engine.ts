/**
 * Scheduler engine — tick-based loop that finds due tasks and executes them.
 *
 * Effect migration (P3):
 * - setInterval tick loop → Effect.repeat(tick, Schedule.spaced())
 * - Manual activeTasks counter → Effect.Semaphore for bounded concurrency
 * - Fire-and-forget dispatch → Effect.forEach with semaphore permits
 * - Graceful shutdown via Fiber.interrupt (replaces clearInterval + drain)
 * - Unified tick logic for both persistent (start/stop) and serverless (runTick)
 *
 * Factory function returns a Scheduler object with start/stop lifecycle.
 * Singleton via getScheduler() / _resetScheduler().
 */

import { Effect, Schedule, Duration, Fiber } from "effect";
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
// Config helper
// ---------------------------------------------------------------------------

function getSchedulerConfig() {
  const config = getConfig();
  return {
    maxConcurrentTasks: config?.scheduler?.maxConcurrentTasks ?? 5,
    taskTimeout: config?.scheduler?.taskTimeout ?? 60_000,
    tickIntervalSeconds: config?.scheduler?.tickIntervalSeconds ?? 60,
  };
}

// ---------------------------------------------------------------------------
// Shared helpers
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

// ---------------------------------------------------------------------------
// Per-task execution Effect (used by both persistent and serverless)
// ---------------------------------------------------------------------------

type TaskOutcome = "completed" | "failed";

/**
 * Execute a single task: lock → create run → execute → complete.
 * Returns the outcome without throwing — all errors are caught and logged.
 * Returns null when the task could not be locked (skip, not a failure).
 */
function executeAndDeliverEffect(
  taskId: string,
  timeoutMs: number,
): Effect.Effect<TaskOutcome | null> {
  return Effect.gen(function* () {
    // Attempt lock
    const lockResult = yield* Effect.tryPromise({
      try: () => lockTaskForExecution(taskId),
      catch: (err) => (err instanceof Error ? err.message : String(err)),
    }).pipe(
      Effect.catchAll((errMsg) => {
        log.error({ taskId, err: errMsg }, "Lock error");
        return Effect.succeed(null as boolean | null);
      }),
    );

    if (lockResult === null) return null;
    if (!lockResult) {
      log.debug({ taskId }, "Task already locked by another process");
      return null;
    }

    // Create run record
    const runId = yield* Effect.tryPromise({
      try: () => createTaskRun(taskId),
      catch: (err) => (err instanceof Error ? err.message : String(err)),
    }).pipe(
      Effect.catchAll((errMsg) => {
        log.error({ taskId, err: errMsg }, "Failed to create run record");
        return Effect.succeed(null);
      }),
    );

    if (!runId) {
      log.error({ taskId }, "No run record — rescheduling");
      yield* Effect.tryPromise({
        try: () => rescheduleTask(taskId),
        catch: () => "reschedule failed",
      }).pipe(Effect.catchAll(() => Effect.void));
      return "failed" as const;
    }

    // Execute + deliver, with an interrupt finalizer to avoid orphaned run records
    const execResult = yield* Effect.tryPromise({
      try: () => executeScheduledTask(taskId, runId, timeoutMs),
      catch: (err) => (err instanceof Error ? err.message : String(err)),
    }).pipe(
      Effect.catchAll((errMsg) => {
        completeTaskRun(runId, "failed", { error: errMsg });
        log.error({ taskId, runId, err: errMsg }, "Scheduled task failed");
        return Effect.succeed(null);
      }),
      Effect.onInterrupt(() =>
        Effect.sync(() => {
          completeTaskRun(runId, "failed", { error: "Interrupted (scheduler stopped)" });
          log.warn({ taskId, runId }, "Task interrupted — marked as failed");
        }),
      ),
    );

    if (execResult === null) return "failed" as const;

    completeTaskRun(runId, "success", { tokensUsed: execResult.tokensUsed });
    log.info({ taskId, runId, tokensUsed: execResult.tokensUsed }, "Scheduled task completed successfully");
    return "completed" as const;
  });
}

// ---------------------------------------------------------------------------
// Core tick Effect
// ---------------------------------------------------------------------------

/**
 * Single tick: fetch due tasks, dispatch up to maxConcurrent with semaphore.
 * Returns a TickResult summarizing what happened.
 */
function tickEffect(
  semaphore: Effect.Semaphore,
  maxConcurrent: number,
  taskTimeout: number,
): Effect.Effect<TickResult> {
  return Effect.gen(function* () {
    const fetchResult = yield* Effect.tryPromise({
      try: () => getTasksDueForExecution(),
      catch: (err) => (err instanceof Error ? err.message : String(err)),
    }).pipe(
      Effect.map((tasks) => ({ ok: true as const, tasks })),
      Effect.catchAll((message) => {
        log.error({ err: message }, "Failed to fetch due tasks");
        return Effect.succeed({ ok: false as const, error: message });
      }),
    );

    if (!fetchResult.ok) {
      return { tasksFound: 0, tasksDispatched: 0, tasksCompleted: 0, tasksFailed: 0, error: fetchResult.error };
    }
    const dueTasks = fetchResult.tasks;

    if (dueTasks.length === 0) {
      return { tasksFound: 0, tasksDispatched: 0, tasksCompleted: 0, tasksFailed: 0 };
    }

    log.info({ count: dueTasks.length }, "Scheduler tick — found due tasks");

    // Cap at maxConcurrent — remaining tasks will be picked up on the next tick
    const tasksToRun = dueTasks.slice(0, maxConcurrent);

    // Execute concurrently, each acquiring a semaphore permit
    const outcomes = yield* Effect.forEach(
      tasksToRun,
      (task) =>
        semaphore.withPermits(1)(
          executeAndDeliverEffect(task.id, taskTimeout),
        ),
      { concurrency: maxConcurrent },
    );

    let tasksDispatched = 0;
    let tasksCompleted = 0;
    let tasksFailed = 0;

    for (const outcome of outcomes) {
      if (outcome === null) continue; // lock contention — not dispatched
      tasksDispatched++;
      if (outcome === "completed") tasksCompleted++;
      else tasksFailed++;
    }

    return {
      tasksFound: dueTasks.length,
      tasksDispatched,
      tasksCompleted,
      tasksFailed,
    };
  });
}

// ---------------------------------------------------------------------------
// Persistent scheduler (start/stop lifecycle via Fiber)
// ---------------------------------------------------------------------------

function createScheduler(): Scheduler {
  let fiber: Fiber.RuntimeFiber<void, never> | null = null;
  let running = false;

  return {
    start() {
      if (running) return;
      running = true;

      const cfg = getSchedulerConfig();
      log.info(
        { intervalSeconds: cfg.tickIntervalSeconds, maxConcurrent: cfg.maxConcurrentTasks },
        "Scheduler starting",
      );

      const semaphore = Effect.unsafeMakeSemaphore(cfg.maxConcurrentTasks);

      // Build the repeating tick program
      const program = tickEffect(semaphore, cfg.maxConcurrentTasks, cfg.taskTimeout).pipe(
        Effect.catchAllCause((cause) => {
          log.error({ err: String(cause) }, "Scheduler tick crashed");
          return Effect.void;
        }),
        Effect.repeat(Schedule.spaced(Duration.seconds(cfg.tickIntervalSeconds))),
        Effect.asVoid,
      );

      // Fork into a background fiber
      fiber = Effect.runFork(program);
    },

    stop() {
      if (!running) return;
      running = false;

      if (fiber) {
        // Interrupt the fiber — cancels the current tick and the schedule
        Effect.runFork(Fiber.interrupt(fiber));
        fiber = null;
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
 * Unlike the persistent scheduler (which runs on a Fiber loop), this
 * function returns only after every dispatched task has settled —
 * required for serverless environments where the function cannot exit early.
 */
export async function runTick(): Promise<TickResult> {
  const cfg = getSchedulerConfig();
  const semaphore = Effect.unsafeMakeSemaphore(cfg.maxConcurrentTasks);
  return Effect.runPromise(
    tickEffect(semaphore, cfg.maxConcurrentTasks, cfg.taskTimeout),
  );
}

/** Reset singleton for testing. */
export function _resetScheduler(): void {
  if (_scheduler) {
    _scheduler.stop();
    _scheduler = null;
  }
}
