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
import { getSetting } from "@atlas/api/lib/settings";
import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("scheduler-shape");

export const DEFAULT_DELIVERY_MAX_ROWS = 50;
const MIN_DELIVERY_MAX_ROWS = 1;
const MAX_DELIVERY_MAX_ROWS = 10000;

let lastWarnedMaxRows: string | undefined;

/**
 * Rows-per-dataset cap for delivered reports. Settings/env-overridable via
 * `ATLAS_DELIVERY_MAX_ROWS` (distinct from `ATLAS_ROW_LIMIT`, the SQL
 * result cap — a delivered report is a digest, not the full result set).
 * `orgId` threads the workspace tier for org-owned tasks (#3406); org-less
 * tasks keep the platform/env resolution.
 */
export function getDeliveryMaxRows(orgId?: string): number {
  const raw = getSetting("ATLAS_DELIVERY_MAX_ROWS", orgId) ?? String(DEFAULT_DELIVERY_MAX_ROWS);
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < MIN_DELIVERY_MAX_ROWS || n > MAX_DELIVERY_MAX_ROWS) {
    if (raw !== lastWarnedMaxRows) {
      log.warn({ value: raw }, `Invalid ATLAS_DELIVERY_MAX_ROWS value; using default ${DEFAULT_DELIVERY_MAX_ROWS}`);
      lastWarnedMaxRows = raw;
    }
    return DEFAULT_DELIVERY_MAX_ROWS;
  }
  return n;
}

export interface ShapedDataset {
  columns: string[];
  /** At most {@link getDeliveryMaxRows} rows. */
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
   * Datasets in result order, each capped at {@link getDeliveryMaxRows} rows.
   * Empty datasets are preserved (the webhook wire format includes them);
   * renderers that hide them keep doing so.
   */
  datasets: ShapedDataset[];
  steps: number;
  totalTokens: number;
  /** ISO timestamp decided once so all channels report the same instant. */
  generatedAt: string;
  /**
   * The task's org — threaded so email delivery resolves the SAME
   * provider-chain link (per-org transport first) the sender preflight
   * checks at create/update time (#3379/#3386). `null` for org-less tasks.
   */
  orgId: string | null;
}

export function shapeResult(
  task: ScheduledTask,
  result: AgentQueryResult,
): FormattedResult {
  const maxRows = getDeliveryMaxRows(task.orgId ?? undefined);
  return {
    taskId: task.id,
    taskName: task.name,
    orgId: task.orgId,
    question: task.question,
    answer: result.answer,
    sql: result.sql,
    datasets: result.data.map(({ columns, rows }) => {
      const truncated = rows.length > maxRows;
      return {
        columns,
        rows: truncated ? rows.slice(0, maxRows) : rows,
        totalRows: rows.length,
        truncated,
      };
    }),
    steps: result.steps,
    totalTokens: result.usage.totalTokens,
    generatedAt: new Date().toISOString(),
  };
}
