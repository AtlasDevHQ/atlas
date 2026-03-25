/**
 * Scheduled task executor — bridges the scheduler to executeAgentQuery().
 *
 * Fetches the task, runs the agent, delivers results, records delivery status,
 * and returns execution metadata. The executor does NOT update the run record
 * (status/completedAt) — callers (engine.ts) own run completion to avoid
 * double-writes. Delivery status is written here because only the executor
 * knows the delivery outcome.
 *
 * Effect migration (P3): Promise.race timeout replaced with Effect.timeout.
 */

import { Effect, Duration } from "effect";
import { createLogger } from "@atlas/api/lib/logger";
import { getScheduledTask, updateRunDeliveryStatus } from "@atlas/api/lib/scheduled-tasks";
import { executeAgentQuery } from "@atlas/api/lib/agent-query";
import { SchedulerTaskTimeoutError, SchedulerExecutionError } from "@atlas/api/lib/effect/errors";
import { deliverResult } from "./delivery";

const log = createLogger("scheduler-executor");

export interface ExecutionResult {
  tokensUsed: number;
  deliveryAttempted: number;
  deliverySucceeded: number;
  deliveryFailed: number;
}

/**
 * Build an Effect program that runs the agent query with a timeout.
 * Fails with SchedulerTaskTimeoutError on timeout, SchedulerExecutionError
 * on any other failure.
 */
function agentQueryEffect(
  question: string,
  requestId: string,
  taskId: string,
  timeoutMs: number,
) {
  return Effect.tryPromise({
    try: () => executeAgentQuery(question, requestId),
    catch: (err) =>
      new SchedulerExecutionError({
        message: err instanceof Error ? err.message : String(err),
        taskId,
      }),
  }).pipe(
    Effect.timeout(Duration.millis(timeoutMs)),
    Effect.catchTag("TimeoutException", () =>
      Effect.fail(
        new SchedulerTaskTimeoutError({
          message: `Task execution timed out after ${timeoutMs}ms`,
          taskId,
          timeoutMs,
        }),
      ),
    ),
  );
}

/**
 * Execute a scheduled task: run the agent query and deliver results.
 * Returns execution metadata on success. Throws on failure.
 * Callers are responsible for updating the run record.
 */
export async function executeScheduledTask(
  taskId: string,
  runId: string,
  timeoutMs: number,
): Promise<ExecutionResult> {
  const taskResult = await getScheduledTask(taskId);
  if (!taskResult.ok) {
    throw new Error(`Task not found: ${taskId}`);
  }

  const task = taskResult.data;
  const requestId = `sched-${taskId}-${runId}`;

  log.info({ taskId, runId, question: task.question.slice(0, 100) }, "Executing scheduled task");

  // Convert tagged errors to plain Errors at the Effect→Promise boundary
  // so callers get clean messages, not FiberFailure wrappers.
  const agentResult = await Effect.runPromise(
    agentQueryEffect(task.question, requestId, taskId, timeoutMs).pipe(
      Effect.catchTags({
        SchedulerTaskTimeoutError: (e) => Effect.die(new Error(e.message)),
        SchedulerExecutionError: (e) => Effect.die(new Error(e.message)),
      }),
    ),
  );

  // Only attempt delivery when recipients are configured
  const delivery = await deliverResult(task, agentResult);

  if (delivery.attempted === 0) {
    // No recipients configured — skip delivery status entirely (leave null)
  } else {
    // Mark delivery as pending, then update with outcome
    updateRunDeliveryStatus(runId, "pending");

    if (delivery.failed > 0) {
      log.warn(
        { taskId, runId, ...delivery },
        "Partial delivery failure — some recipients did not receive results",
      );
    }

    if (delivery.failed === 0) {
      updateRunDeliveryStatus(runId, "sent");
    } else {
      const errorMsg = delivery.succeeded > 0
        ? `Partial failure: ${delivery.failed}/${delivery.attempted} deliveries failed`
        : `All ${delivery.failed} deliveries failed`;
      updateRunDeliveryStatus(runId, "failed", errorMsg);
    }
  }

  return {
    tokensUsed: agentResult.usage.totalTokens,
    deliveryAttempted: delivery.attempted,
    deliverySucceeded: delivery.succeeded,
    deliveryFailed: delivery.failed,
  };
}
