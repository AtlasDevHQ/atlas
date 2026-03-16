/**
 * Convert Atlas query responses to Microsoft Teams Adaptive Card format.
 *
 * Adaptive Cards are the standard rich-content format for Teams messages.
 * This module creates cards with the answer, optional SQL, data tables,
 * and metadata — respecting Teams' message size limits.
 *
 * @see https://adaptivecards.io/explorer/
 */

const MAX_TEXT_LENGTH = 2000;
const MAX_DATA_ROWS = 20;
const MAX_DATA_CHARS = 2000;
const ADAPTIVE_CARD_VERSION = "1.5";
const ADAPTIVE_CARD_SCHEMA =
  "http://adaptivecards.io/schemas/adaptive-card.json";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TeamsQueryResult {
  answer: string;
  sql: string[];
  data: { columns: string[]; rows: Record<string, unknown>[] }[];
  steps: number;
  usage: { totalTokens: number };
}

export interface AdaptiveCard {
  type: "AdaptiveCard";
  $schema: string;
  version: string;
  body: AdaptiveCardElement[];
}

export type AdaptiveCardElement =
  | {
      type: "TextBlock";
      text: string;
      wrap?: boolean;
      weight?: "Default" | "Bolder";
      size?: "Default" | "Small" | "Medium" | "Large";
      isSubtle?: boolean;
      separator?: boolean;
      fontType?: "Default" | "Monospace";
    }
  | {
      type: "ColumnSet";
      columns: Array<{
        type: "Column";
        width: string;
        items: AdaptiveCardElement[];
      }>;
      separator?: boolean;
    };

// ---------------------------------------------------------------------------
// Card builders
// ---------------------------------------------------------------------------

/**
 * Format a query result as an Adaptive Card.
 */
export function formatQueryResponse(result: TeamsQueryResult): AdaptiveCard {
  const body: AdaptiveCardElement[] = [];

  // Answer section
  const answer = truncate(result.answer || "No answer generated.", MAX_TEXT_LENGTH);
  body.push({
    type: "TextBlock",
    text: answer,
    wrap: true,
  });

  // SQL section
  if (result.sql.length > 0) {
    const sqlText = result.sql.join("\n\n");
    body.push({
      type: "TextBlock",
      text: "**SQL**",
      wrap: true,
      separator: true,
      weight: "Bolder",
      size: "Small",
    });
    body.push({
      type: "TextBlock",
      text: truncate(sqlText, MAX_TEXT_LENGTH),
      wrap: true,
      fontType: "Monospace",
      size: "Small",
    });
  }

  // Data table section
  for (const dataset of result.data) {
    if (!dataset.columns.length || !dataset.rows.length) continue;

    const table = formatDataTable(dataset.columns, dataset.rows);
    if (table) {
      body.push({
        type: "TextBlock",
        text: "**Results**",
        wrap: true,
        separator: true,
        weight: "Bolder",
        size: "Small",
      });
      body.push({
        type: "TextBlock",
        text: table,
        wrap: true,
        fontType: "Monospace",
        size: "Small",
      });
    }

    // Limit card size
    if (body.length >= 10) break;
  }

  // Metadata
  body.push({
    type: "TextBlock",
    text: `${result.steps} steps | ${result.usage.totalTokens.toLocaleString()} tokens`,
    wrap: true,
    isSubtle: true,
    separator: true,
    size: "Small",
  });

  return {
    type: "AdaptiveCard",
    $schema: ADAPTIVE_CARD_SCHEMA,
    version: ADAPTIVE_CARD_VERSION,
    body,
  };
}

/**
 * Format column data as a plain-text table for monospace display.
 */
function formatDataTable(
  columns: string[],
  rows: Record<string, unknown>[],
): string | null {
  if (columns.length === 0 || rows.length === 0) return null;

  const totalRows = rows.length;
  const displayRows = rows.slice(0, MAX_DATA_ROWS);
  const truncated = totalRows > MAX_DATA_ROWS;

  const header = columns.join(" | ");
  const separator = columns.map((c) => "-".repeat(c.length)).join("-+-");
  const dataLines = displayRows.map((row) =>
    columns.map((col) => String(row[col] ?? "")).join(" | "),
  );

  let table = [header, separator, ...dataLines].join("\n");

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
    return `${table}\n(Showing first ${Math.max(lineCount - 2, 1)} of ${totalRows} rows)`;
  }

  const note = truncated
    ? `\n(Showing first ${MAX_DATA_ROWS} of ${totalRows} rows)`
    : "";

  return `${table}${note}`;
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + "...";
}

/**
 * Format an error message as an Adaptive Card.
 */
export function formatErrorResponse(error: string): AdaptiveCard {
  return {
    type: "AdaptiveCard",
    $schema: ADAPTIVE_CARD_SCHEMA,
    version: ADAPTIVE_CARD_VERSION,
    body: [
      {
        type: "TextBlock",
        text: `Something went wrong: ${truncate(error, 200)}`,
        wrap: true,
        weight: "Bolder",
      },
    ],
  };
}

/**
 * Wrap an Adaptive Card as a Bot Framework attachment.
 */
export function cardAttachment(card: AdaptiveCard): {
  contentType: "application/vnd.microsoft.card.adaptive";
  content: AdaptiveCard;
} {
  return {
    contentType: "application/vnd.microsoft.card.adaptive",
    content: card,
  };
}
