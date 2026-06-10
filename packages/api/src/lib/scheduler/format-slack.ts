/**
 * Slack renderer for scheduled task results.
 *
 * Reuses formatQueryResponse() from the Slack module and prepends a header
 * block with the task name and question. Consumes the pre-shaped
 * {@link FormattedResult}, so data tables arrive already capped at the
 * shared scheduled-delivery row limit (Block Kit then applies its own
 * tighter display limits on top).
 */

import { formatQueryResponse, type SlackBlock } from "@atlas/api/lib/slack/format";
import type { FormattedResult } from "./shape-result";

export function formatSlackReport(
  shaped: FormattedResult,
): { text: string; blocks: SlackBlock[] } {
  const headerBlock: SlackBlock = {
    type: "section",
    text: {
      type: "mrkdwn",
      text: `:chart_with_upwards_trend: *${shaped.taskName}*\n_${truncate(shaped.question, 200)}_`,
    },
  };

  // formatQueryResponse dedupes and counts rows against what it receives:
  // datasets identical only in their first maxRows rows collapse into one
  // block, and the "of N rows" note reports the shaped total, not the raw
  // result's. Acceptable for a digest surface — Block Kit display is capped
  // tighter (20 rows) anyway.
  const resultBlocks = formatQueryResponse({
    answer: shaped.answer,
    sql: shaped.sql,
    data: shaped.datasets.map(({ columns, rows }) => ({ columns, rows })),
    steps: shaped.steps,
    usage: { totalTokens: shaped.totalTokens },
  });

  return {
    text: `Atlas Report: ${shaped.taskName} — ${truncate(shaped.answer || "No answer", 100)}`,
    blocks: [headerBlock, ...resultBlocks],
  };
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + "...";
}
