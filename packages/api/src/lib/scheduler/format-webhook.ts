/**
 * Webhook formatter for scheduled task results.
 *
 * Produces a structured JSON payload with all query data.
 */

import type { ScheduledTask } from "@atlas/api/lib/scheduled-tasks";
import type { AgentQueryResult } from "@atlas/api/lib/agent-query";

export interface WebhookPayload {
  taskId: string;
  taskName: string;
  question: string;
  answer: string;
  sql: string[];
  data: { columns: string[]; rows: Record<string, unknown>[] }[];
  steps: number;
  usage: { totalTokens: number };
  timestamp: string;
}

export function formatWebhookPayload(
  task: ScheduledTask,
  result: AgentQueryResult,
): WebhookPayload {
  return {
    taskId: task.id,
    taskName: task.name,
    question: task.question,
    answer: result.answer || "",
    sql: result.sql,
    data: result.data,
    steps: result.steps,
    usage: result.usage,
    timestamp: new Date().toISOString(),
  };
}
