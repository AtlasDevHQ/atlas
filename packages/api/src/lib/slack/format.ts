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
 *
 * Compared to the web chat surface, Slack needs aggressive deduping and
 * scalar collapsing — a cross-env query produces identical SQL + result
 * rows across N regions, and dumping them verbatim turns into a wall of
 * indistinguishable blocks. We also strip the `<suggestions>` XML tag
 * the agent emits for the web chat (rendered as buttons there) and
 * surface its items as a context-line footer instead.
 */
export function formatQueryResponse(result: SlackQueryResult): SlackBlock[] {
  const blocks: SlackBlock[] = [];

  const { answer, suggestions } = extractSuggestions(result.answer || "No answer generated.");
  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: truncate(answer, MAX_TEXT_LENGTH) },
  });

  // SQL: dedupe identical strings (cross-env queries hit N regions with the
  // same SQL). If the answer text already contains a fenced sql block, skip
  // the dedicated SQL section entirely so we don't double up.
  const uniqueSql = dedupeStrings(result.sql);
  const answerHasSql = /```\s*sql/i.test(answer);
  if (uniqueSql.length > 0 && !answerHasSql) {
    const ranAcross = result.sql.length > uniqueSql.length
      ? `  _(ran across ${result.sql.length} regions)_`
      : "";
    const header = uniqueSql.length === 1 ? "*SQL*" : `*SQL* _(${uniqueSql.length} queries)_`;
    const sqlText = uniqueSql.join("\n\n");
    const formatted = truncate(`${header}${ranAcross}\n\`\`\`${sqlText}\`\`\``, MAX_TEXT_LENGTH);
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: formatted },
    });
  }

  // Data: dedupe identical datasets, scalarize single-row results.
  const uniqueDatasets = dedupeDatasets(result.data);
  for (const { columns, rows, occurrences } of uniqueDatasets) {
    if (!columns.length || !rows.length) continue;

    const acrossNote = occurrences > 1 ? `  _(identical across ${occurrences} regions)_` : "";
    const rendered = rows.length === 1
      ? formatScalarRow(columns, rows[0]!)
      : (formatDataTable(columns, rows) ?? "");
    // formatDataTable self-truncates; formatScalarRow doesn't — wide single-row
    // results (many columns × long text) can otherwise exceed Slack's 3000-char
    // block limit and the API rejects the post with invalid_blocks.
    const body = truncate(rendered + acrossNote, MAX_TEXT_LENGTH);
    if (body) {
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: body },
      });
    }
    if (blocks.length >= MAX_BLOCKS - 2) break;
  }

  if (suggestions.length) {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `*Follow-ups:* ${suggestions.map((s) => `\`${s}\``).join("  ·  ")}`,
        },
      ],
    });
  }

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
 * Extract the agent's `<suggestions>…</suggestions>` block (used by the web
 * chat to render follow-up question buttons). Returns the cleaned answer
 * text and the list of suggestions for separate rendering.
 */
function extractSuggestions(text: string): { answer: string; suggestions: string[] } {
  const match = text.match(/<suggestions>([\s\S]*?)<\/suggestions>/i);
  if (!match) return { answer: text, suggestions: [] };
  const inner = match[1] ?? "";
  const suggestions = inner
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*•\s]+/, "").trim())
    .filter(Boolean);
  const answer = text.replace(match[0], "").trim();
  return { answer, suggestions };
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

interface DedupedDataset {
  columns: string[];
  rows: Record<string, unknown>[];
  /** Number of source datasets that collapsed into this bucket. Always ≥1. */
  occurrences: number;
}

// Dedupe key is order-sensitive on both columns and rows — two datasets with
// the same content in different orders won't collapse. Cross-env queries
// produce ordered, identical column/row vectors, so this matches the intent.
function dedupeDatasets(
  datasets: { columns: string[]; rows: Record<string, unknown>[] }[],
): DedupedDataset[] {
  const buckets = new Map<string, DedupedDataset>();
  for (const ds of datasets) {
    const key = JSON.stringify({ columns: ds.columns, rows: ds.rows });
    const existing = buckets.get(key);
    if (existing) {
      existing.occurrences += 1;
    } else {
      buckets.set(key, { columns: ds.columns, rows: ds.rows, occurrences: 1 });
    }
  }
  return Array.from(buckets.values());
}

/**
 * Format a single-row result as inline `*col*: value` pairs instead of a
 * code-block table. Reads better in Slack for scalar answers (counts,
 * single-record lookups).
 */
function formatScalarRow(columns: string[], row: Record<string, unknown>): string {
  return columns
    .map((col) => `*${col}:* ${String((row[col] as string | number | boolean) ?? "")}`)
    .join("    ");
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
    columns.map((col) => String((row[col] as string | number | boolean) ?? "")).join(" | "),
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
