/**
 * Output formatting utilities for CLI command handlers.
 *
 * Table rendering, CSV formatting, and cell value display.
 */

/**
 * Format a value for display in table cells.
 * Numbers get locale formatting; nulls display as "(null)".
 */
export function formatCellValue(value: unknown): string {
  if (value === null || value === undefined) return "(null)";
  if (typeof value === "number") return value.toLocaleString();
  return String(value);
}

export function formatCsvValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value);
}

/** Quote a CSV field value per RFC 4180: wrap in double-quotes if it contains commas, quotes, or newlines. */
export function quoteCsvField(val: string): string {
  if (/[,"\n]/.test(val)) return `"${val.replace(/"/g, '""')}"`;
  return val;
}

/**
 * Render a data table with box-drawing characters.
 * Adapts column widths to content.
 */
export function renderTable(
  columns: string[],
  rows: Record<string, unknown>[],
): string {
  // Compute display values
  const displayRows = rows.map((row) =>
    columns.map((col) => formatCellValue(row[col])),
  );

  // Column widths: max of header and all row values
  const widths = columns.map((col, i) =>
    Math.max(col.length, ...displayRows.map((r) => r[i].length)),
  );

  const top =
    "\u250C" +
    widths.map((w) => "\u2500".repeat(w + 2)).join("\u252C") +
    "\u2510";
  const mid =
    "\u251C" +
    widths.map((w) => "\u2500".repeat(w + 2)).join("\u253C") +
    "\u2524";
  const bottom =
    "\u2514" +
    widths.map((w) => "\u2500".repeat(w + 2)).join("\u2534") +
    "\u2518";

  const formatRow = (cells: string[]) =>
    "\u2502" +
    cells.map((cell, i) => " " + cell.padEnd(widths[i]) + " ").join("\u2502") +
    "\u2502";

  const lines: string[] = [top, formatRow(columns), mid];
  for (const row of displayRows) {
    lines.push(formatRow(row));
  }
  lines.push(bottom);
  return lines.join("\n");
}
