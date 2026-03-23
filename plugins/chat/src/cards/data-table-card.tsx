/** @jsxImportSource chat */
import { Card, CardText, Table, Divider } from "chat";
import type { CardElement } from "chat";
import { toCardElement } from "chat/jsx-runtime";

/** Maximum rows to show in a data table card. */
const DEFAULT_MAX_ROWS = 20;

export interface DataTableCardProps {
  columns: string[];
  rows: Record<string, unknown>[];
  /** Maximum rows to display. Default: 20 */
  maxRows?: number;
}

/**
 * Build a standalone data table card.
 * Returns { card, fallbackText } for cross-platform compatibility.
 */
export function buildDataTableCard(props: DataTableCardProps): {
  card: CardElement;
  fallbackText: string;
} {
  const { columns, rows, maxRows = DEFAULT_MAX_ROWS } = props;
  const displayRows = rows.slice(0, maxRows);
  const truncated = rows.length > maxRows;

  const tableRows = displayRows.map((row) =>
    columns.map((col) => String(row[col] ?? "")),
  );

  const jsx = (
    <Card>
      <Table headers={columns} rows={tableRows} />
      {truncated && (
        <CardText style="muted">
          Showing first {maxRows} of {rows.length} rows
        </CardText>
      )}
    </Card>
  );

  const card = toCardElement(jsx)!;

  // Markdown fallback
  const header = `| ${columns.join(" | ")} |`;
  const separator = `| ${columns.map(() => "---").join(" | ")} |`;
  const dataLines = displayRows.map(
    (row) => `| ${columns.map((col) => String(row[col] ?? "")).join(" | ")} |`,
  );
  let fallbackText = [header, separator, ...dataLines].join("\n");
  if (truncated) {
    fallbackText += `\n_Showing first ${maxRows} of ${rows.length} rows_`;
  }

  return { card, fallbackText };
}
