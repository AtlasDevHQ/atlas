/**
 * Webhook renderer for scheduled task results.
 *
 * Produces a structured JSON payload from the pre-shaped
 * {@link FormattedResult}. Datasets are capped at the shared
 * scheduled-delivery row limit; `totalRows`/`truncated` let consumers
 * detect when rows were dropped.
 */

import type { FormattedResult, ShapedDataset } from "./shape-result";

export interface WebhookPayload {
  taskId: string;
  taskName: string;
  question: string;
  answer: string;
  sql: string[];
  data: ShapedDataset[];
  steps: number;
  usage: { totalTokens: number };
  timestamp: string;
}

export function formatWebhookPayload(shaped: FormattedResult): WebhookPayload {
  return {
    taskId: shaped.taskId,
    taskName: shaped.taskName,
    question: shaped.question,
    answer: shaped.answer,
    sql: shaped.sql,
    data: shaped.datasets,
    steps: shaped.steps,
    usage: { totalTokens: shaped.totalTokens },
    timestamp: shaped.generatedAt,
  };
}
