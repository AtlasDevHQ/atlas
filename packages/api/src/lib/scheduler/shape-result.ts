/**
 * Shared shaping for scheduled-delivery renderers.
 *
 * One `FormattedResult` feeds the three delivery renderers (email HTML,
 * Slack Block Kit, webhook JSON) so the cross-channel rules — row
 * truncation and the report timestamp — are decided once instead of
 * per-renderer. Presentation (section layout, fallback copy, escaping)
 * stays in the renderers.
 */

import type { ScheduledTask } from "@atlas/api/lib/scheduled-tasks";
import type { AgentQueryResult } from "@atlas/api/lib/agent-query";

export const MAX_DATA_ROWS = 50;

export interface ShapedDataset {
  columns: string[];
  /** At most {@link MAX_DATA_ROWS} rows. */
  rows: Record<string, unknown>[];
  /** Row count before truncation. */
  totalRows: number;
  truncated: boolean;
}

export interface FormattedResult {
  taskId: string;
  taskName: string;
  question: string;
  /** Raw answer — may be empty; renderers choose their own fallback copy. */
  answer: string;
  sql: string[];
  /**
   * Datasets in result order, each capped at {@link MAX_DATA_ROWS} rows.
   * Empty datasets are preserved (the webhook wire format includes them);
   * renderers that hide them keep doing so.
   */
  datasets: ShapedDataset[];
  steps: number;
  totalTokens: number;
  /** ISO timestamp decided once so all channels report the same instant. */
  generatedAt: string;
}

export function shapeResult(
  task: ScheduledTask,
  result: AgentQueryResult,
): FormattedResult {
  return {
    taskId: task.id,
    taskName: task.name,
    question: task.question,
    answer: result.answer,
    sql: result.sql,
    datasets: result.data.map(({ columns, rows }) => {
      const truncated = rows.length > MAX_DATA_ROWS;
      return {
        columns,
        rows: truncated ? rows.slice(0, MAX_DATA_ROWS) : rows,
        totalRows: rows.length,
        truncated,
      };
    }),
    steps: result.steps,
    totalTokens: result.usage.totalTokens,
    generatedAt: new Date().toISOString(),
  };
}
