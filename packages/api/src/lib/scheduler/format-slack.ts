/**
 * Slack formatter for scheduled task results.
 *
 * Reuses formatQueryResponse() from the Slack module and prepends a header
 * block with the task name and question.
 */

import type { ScheduledTask } from "@atlas/api/lib/scheduled-tasks";
import type { AgentQueryResult } from "@atlas/api/lib/agent-query";
import { formatQueryResponse, type SlackBlock } from "@atlas/api/lib/slack/format";

export function formatSlackReport(
  task: ScheduledTask,
  result: AgentQueryResult,
): { text: string; blocks: SlackBlock[] } {
  const headerBlock: SlackBlock = {
    type: "section",
    text: {
      type: "mrkdwn",
      text: `:chart_with_upwards_trend: *${task.name}*\n_${truncate(task.question, 200)}_`,
    },
  };

  const resultBlocks = formatQueryResponse(result);

  return {
    text: `Atlas Report: ${task.name} — ${truncate(result.answer || "No answer", 100)}`,
    blocks: [headerBlock, ...resultBlocks],
  };
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + "...";
}
