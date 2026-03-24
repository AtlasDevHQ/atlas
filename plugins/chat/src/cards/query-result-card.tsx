/** @jsxImportSource chat */
import { Card, CardText, Fields, Field, Table, Divider, Actions, Button } from "chat";
import type { CardElement } from "chat";
import { toCardElement } from "chat/jsx-runtime";
import type { ChatQueryResult } from "../config";

/** Maximum rows shown inline in query result cards. */
const MAX_INLINE_ROWS = 20;

/** Maximum length of SQL stored in action button values. */
const MAX_ACTION_VALUE_LENGTH = 2000;

/**
 * Build the main query result card.
 * Renders answer text, SQL code block, data table preview, metadata,
 * and quick-action buttons (Run Again, Export CSV).
 * Returns { card, fallbackText } for cross-platform compatibility.
 */
export function buildQueryResultCard(result: ChatQueryResult): {
  card: CardElement;
  fallbackText: string;
} {
  const answer = result.answer || "No answer generated.";
  const hasSql = result.sql.length > 0;
  const datasets = result.data.filter(
    (d) => d.columns.length > 0 && d.rows.length > 0,
  );

  // Build JSX children array
  const children: unknown[] = [];

  // Answer section
  children.push(<CardText>{answer}</CardText>);

  // SQL section
  if (hasSql) {
    children.push(<Divider />);
    children.push(
      <CardText style="bold">SQL</CardText>,
    );
    children.push(
      <CardText>{`\`\`\`sql\n${result.sql.join("\n\n")}\n\`\`\``}</CardText>,
    );
  }

  // Data table sections
  for (const dataset of datasets) {
    const displayRows = dataset.rows.slice(0, MAX_INLINE_ROWS);
    const tableRows = displayRows.map((row) =>
      dataset.columns.map((col) => String(row[col] ?? "")),
    );

    children.push(<Divider />);
    children.push(<Table headers={dataset.columns} rows={tableRows} />);

    if (dataset.rows.length > MAX_INLINE_ROWS) {
      children.push(
        <CardText style="muted">
          Showing first {MAX_INLINE_ROWS} of {dataset.rows.length} rows
        </CardText>,
      );
    }
  }

  // Metadata
  children.push(<Divider />);
  children.push(
    <Fields>
      <Field label="Steps" value={String(result.steps)} />
      <Field label="Tokens" value={result.usage.totalTokens.toLocaleString()} />
    </Fields>,
  );

  // Quick-action buttons (only when SQL was executed)
  if (hasSql) {
    const sqlPayload = result.sql.join("\n\n").slice(0, MAX_ACTION_VALUE_LENGTH);
    children.push(
      <Actions>
        <Button id="atlas_run_again" value={sqlPayload}>
          Run Again
        </Button>
        <Button id="atlas_export_csv" value={sqlPayload}>
          Export CSV
        </Button>
      </Actions>,
    );
  }

  const jsx = <Card>{children}</Card>;
  const card = toCardElement(jsx);
  if (!card) {
    throw new Error("Failed to build query result card — toCardElement returned null");
  }

  // Build markdown fallback
  const fallbackText = buildFallbackText(result, datasets);

  return { card, fallbackText };
}

function buildFallbackText(
  result: ChatQueryResult,
  datasets: ChatQueryResult["data"],
): string {
  const parts: string[] = [];

  parts.push(result.answer || "No answer generated.");

  if (result.sql.length > 0) {
    parts.push(`\n**SQL**\n\`\`\`sql\n${result.sql.join("\n\n")}\n\`\`\``);
  }

  for (const dataset of datasets) {
    const displayRows = dataset.rows.slice(0, MAX_INLINE_ROWS);
    const header = `| ${dataset.columns.join(" | ")} |`;
    const separator = `| ${dataset.columns.map(() => "---").join(" | ")} |`;
    const dataLines = displayRows.map(
      (row) =>
        `| ${dataset.columns.map((col) => String(row[col] ?? "")).join(" | ")} |`,
    );
    let table = [header, separator, ...dataLines].join("\n");
    if (dataset.rows.length > MAX_INLINE_ROWS) {
      table += `\n_Showing first ${MAX_INLINE_ROWS} of ${dataset.rows.length} rows_`;
    }
    parts.push(table);
  }

  parts.push(
    `\n_${result.steps} steps | ${result.usage.totalTokens.toLocaleString()} tokens_`,
  );

  // Text fallback for platforms without button support
  if (result.sql.length > 0) {
    parts.push(
      `\n_To run again, re-send the same question. To export, ask "export the last result as CSV"._`,
    );
  }

  return parts.join("\n");
}
