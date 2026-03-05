/**
 * Convert Atlas query responses to Slack Block Kit format.
 *
 * Respects Slack limits: 50 blocks max, 3000 chars per text block.
 * Truncates large data tables and adds a "Showing first N rows" note.
 */

import type { AgentQueryResult, PendingAction } from "@atlas/api/lib/agent-query";

const MAX_TEXT_LENGTH = 3000;
const MAX_DATA_ROWS = 20;
const MAX_DATA_CHARS = 3000;
const MAX_BLOCKS = 50;

/** Alias for the shared agent query result — same shape, Slack-specific name. */
export type SlackQueryResult = AgentQueryResult;

export interface SlackButton {
  type: "button";
  text: { type: "plain_text"; text: string };
  action_id: string;
  value: string;
  style?: "primary" | "danger";
}

export type SlackBlock =
  | { type: "section"; text: { type: "mrkdwn" | "plain_text"; text: string } }
  | { type: "context"; elements: { type: "mrkdwn" | "plain_text"; text: string }[] }
  | { type: "actions"; elements: SlackButton[] };

/**
 * Format a query result as Slack Block Kit blocks.
 */
export function formatQueryResponse(result: SlackQueryResult): SlackBlock[] {
  const blocks: SlackBlock[] = [];

  // Answer section
  const answer = truncate(result.answer || "No answer generated.", MAX_TEXT_LENGTH);
  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: answer },
  });

  // SQL section
  if (result.sql.length > 0) {
    const sqlText = result.sql.join("\n\n");
    const formatted = truncate(`*SQL*\n\`\`\`${sqlText}\`\`\``, MAX_TEXT_LENGTH);
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: formatted },
    });
  }

  // Data section — column-aligned plain text
  for (const dataset of result.data) {
    if (!dataset.columns.length || !dataset.rows.length) continue;

    const table = formatDataTable(dataset.columns, dataset.rows);
    if (table) {
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: table },
      });
    }

    // Stay under the block limit
    if (blocks.length >= MAX_BLOCKS - 1) break;
  }

  // Context block with metadata
  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `${result.steps} steps | ${result.usage.totalTokens.toLocaleString()} tokens`,
      },
    ],
  });

  return blocks.slice(0, MAX_BLOCKS);
}

/**
 * Format column data as a code block table.
 */
function formatDataTable(
  columns: string[],
  rows: Record<string, unknown>[],
): string | null {
  if (columns.length === 0 || rows.length === 0) return null;

  const totalRows = rows.length;
  const displayRows = rows.slice(0, MAX_DATA_ROWS);
  const truncated = totalRows > MAX_DATA_ROWS;

  // Build column-aligned output
  const header = columns.join(" | ");
  const separator = columns.map((c) => "-".repeat(c.length)).join("-+-");
  const dataLines = displayRows.map((row) =>
    columns.map((col) => String(row[col] ?? "")).join(" | "),
  );

  let table = [header, separator, ...dataLines].join("\n");

  // Truncate if too long
  if (table.length > MAX_DATA_CHARS) {
    const lines = table.split("\n");
    let charCount = 0;
    let lineCount = 0;
    for (const line of lines) {
      if (charCount + line.length + 1 > MAX_DATA_CHARS - 50) break;
      charCount += line.length + 1;
      lineCount++;
    }
    table = lines.slice(0, Math.max(lineCount, 3)).join("\n");
    return `\`\`\`${table}\`\`\`\n_Showing first ${Math.max(lineCount - 2, 1)} of ${totalRows} rows (truncated)_`;
  }

  const note = truncated
    ? `\n_Showing first ${MAX_DATA_ROWS} of ${totalRows} rows_`
    : "";

  return `\`\`\`${table}\`\`\`${note}`;
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + "...";
}

/**
 * Format an error message for Slack.
 */
export function formatErrorResponse(error: string): SlackBlock[] {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `:warning: Something went wrong: ${truncate(error, 200)}`,
      },
    },
  ];
}

/**
 * Format a pending action as a Slack Block Kit approval prompt.
 * Returns a section with the action summary and an actions block with
 * Approve/Deny buttons.
 */
export function formatActionApproval(action: PendingAction): SlackBlock[] {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `:lock: *Action requires approval*\n${truncate(action.summary || action.type, MAX_TEXT_LENGTH - 40)}`,
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Approve" },
          action_id: "atlas_action_approve",
          value: action.id,
          style: "primary",
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Deny" },
          action_id: "atlas_action_deny",
          value: action.id,
          style: "danger",
        },
      ],
    },
  ];
}

/**
 * Format a resolved action status (replaces the approval buttons).
 */
export function formatActionResult(
  action: PendingAction,
  status: "approved" | "denied" | "executed" | "failed",
  error?: string,
): SlackBlock[] {
  const emoji =
    status === "executed"
      ? ":white_check_mark:"
      : status === "approved"
        ? ":white_check_mark:"
        : status === "denied"
          ? ":no_entry_sign:"
          : ":x:";

  let text = `${emoji} *Action ${status}*: ${truncate(action.summary || action.type, 200)}`;
  if (error) text += `\n_${truncate(error, 200)}_`;

  return [
    {
      type: "section",
      text: { type: "mrkdwn", text },
    },
  ];
}
