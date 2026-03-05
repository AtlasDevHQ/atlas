/**
 * Scheduled task executor — bridges the scheduler to executeAgentQuery().
 *
 * Fetches the task, runs the agent, delivers results, and returns execution
 * metadata. The executor does NOT update the run record — callers (engine.ts)
 * own run completion to avoid double-writes.
 */

import { createLogger } from "@atlas/api/lib/logger";
import { getScheduledTask } from "@atlas/api/lib/scheduled-tasks";
import { executeAgentQuery } from "@atlas/api/lib/agent-query";
import { deliverResult } from "./delivery";

const log = createLogger("scheduler-executor");

export interface ExecutionResult {
  tokensUsed: number;
  deliveryAttempted: number;
  deliverySucceeded: number;
  deliveryFailed: number;
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

  // Run agent with timeout — clear timer to avoid resource leak
  let timer: ReturnType<typeof setTimeout>;
  const agentPromise = executeAgentQuery(task.question, requestId);
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Task execution timed out after ${timeoutMs}ms`)), timeoutMs);
  });

  let agentResult;
  try {
    agentResult = await Promise.race([agentPromise, timeoutPromise]);
  } finally {
    clearTimeout(timer!);
  }

  // Deliver results to configured channels (best-effort)
  const delivery = await deliverResult(task, agentResult);

  if (delivery.failed > 0) {
    log.warn(
      { taskId, runId, ...delivery },
      "Partial delivery failure — some recipients did not receive results",
    );
  }

  return {
    tokensUsed: agentResult.usage.totalTokens,
    deliveryAttempted: delivery.attempted,
    deliverySucceeded: delivery.succeeded,
    deliveryFailed: delivery.failed,
  };
}
