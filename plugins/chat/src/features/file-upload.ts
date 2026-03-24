/**
 * CSV file upload support for the Chat SDK bridge.
 *
 * Generates CSV from query results and determines when/how to deliver files
 * based on platform capabilities and user intent.
 *
 * Platform support:
 * - File upload: Slack, Teams, Discord, Google Chat, Telegram, WhatsApp
 * - Fallback to link: GitHub, Linear (no file upload API)
 */

import type { FileUpload } from "chat";
import type { FileUploadConfig } from "../config";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default row threshold for auto-attaching CSV files. */
const DEFAULT_AUTO_ATTACH_THRESHOLD = 20;

/** Platforms that support file uploads via Chat SDK. */
const FILE_UPLOAD_PLATFORMS = new Set([
  "slack",
  "teams",
  "discord",
  "gchat",
  "telegram",
  "whatsapp",
]);

/** Patterns that indicate the user wants an export. Case-insensitive. */
const EXPORT_KEYWORDS = [
  /\bexport\b/i,
  /\bdownload\b/i,
  /\bsend\s+as\s+csv\b/i,
  /\bas\s+csv\b/i,
  /\bcsv\s+file\b/i,
  /\bto\s+csv\b/i,
];

// ---------------------------------------------------------------------------
// CSV generation
// ---------------------------------------------------------------------------

/**
 * Escape a value for CSV output per RFC 4180.
 * Wraps in double quotes if the value contains commas, double quotes, or newlines.
 * Double quotes within the value are escaped as `""`.
 */
function escapeCSVValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  const str = String(value);
  if (str.includes('"') || str.includes(",") || str.includes("\n") || str.includes("\r")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Generate a CSV string from query result columns and rows.
 * Includes a UTF-8 BOM for Excel compatibility.
 */
export function generateCSV(
  columns: string[],
  rows: Record<string, unknown>[],
): string {
  const bom = "\uFEFF";
  const header = columns.map(escapeCSVValue).join(",");
  const dataLines = rows.map((row) =>
    columns.map((col) => escapeCSVValue(row[col])).join(","),
  );
  return bom + [header, ...dataLines].join("\r\n") + "\r\n";
}

/**
 * Build a `FileUpload` object from query result data.
 * The filename includes a timestamp for uniqueness.
 */
export function buildCSVFileUpload(
  columns: string[],
  rows: Record<string, unknown>[],
): FileUpload {
  const csv = generateCSV(columns, rows);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return {
    data: Buffer.from(csv, "utf-8"),
    filename: `atlas-export-${timestamp}.csv`,
    mimeType: "text/csv",
  };
}

// ---------------------------------------------------------------------------
// Decision logic
// ---------------------------------------------------------------------------

/**
 * Check whether a platform supports file uploads.
 */
export function platformSupportsFileUpload(adapterName: string): boolean {
  return FILE_UPLOAD_PLATFORMS.has(adapterName);
}

/**
 * Check whether a user's question indicates they want a CSV export.
 */
export function isExportRequest(question: string): boolean {
  return EXPORT_KEYWORDS.some((pattern) => pattern.test(question));
}

/**
 * Determine whether a CSV file should be attached to the response.
 *
 * Returns true when:
 * 1. The user explicitly requested an export (keyword match), OR
 * 2. Total row count across all datasets exceeds the auto-attach threshold
 *
 * @param totalRows - Total row count across all datasets
 * @param explicitExport - Whether the user explicitly requested export
 * @param config - File upload configuration
 */
export function shouldAttachCSV(
  totalRows: number,
  explicitExport: boolean,
  config?: FileUploadConfig,
): boolean {
  if (explicitExport) return true;

  const threshold = config?.autoAttachThreshold ?? DEFAULT_AUTO_ATTACH_THRESHOLD;
  if (threshold === 0) return false;

  return totalRows > threshold;
}

/**
 * Build a fallback message for platforms that don't support file uploads.
 * Includes a link to the web UI if configured.
 */
export function buildFallbackMessage(
  webBaseUrl?: string,
): string {
  if (webBaseUrl) {
    const url = webBaseUrl.replace(/\/+$/, "");
    return `CSV export is not available on this platform. [View full results in Atlas](${url})`;
  }
  return "CSV export is not available on this platform. Configure `fileUpload.webBaseUrl` to enable a link to the Atlas web UI.";
}

/**
 * Collect all rows from query result datasets into a single CSV FileUpload.
 * Returns null if there are no data rows.
 *
 * When multiple datasets are present (multiple SQL queries), they are
 * concatenated with a blank separator row between them.
 */
export function buildCSVFromQueryData(
  data: { columns: string[]; rows: Record<string, unknown>[] }[],
): FileUpload | null {
  const datasets = data.filter((d) => d.columns.length > 0 && d.rows.length > 0);
  if (datasets.length === 0) return null;

  // Single dataset — straightforward
  if (datasets.length === 1) {
    return buildCSVFileUpload(datasets[0].columns, datasets[0].rows);
  }

  // Multiple datasets — use the superset of all columns, separated by blank rows
  const allColumns = [...new Set(datasets.flatMap((d) => d.columns))];
  const allRows: Record<string, unknown>[] = [];

  for (let i = 0; i < datasets.length; i++) {
    if (i > 0) {
      // Blank separator row
      allRows.push(Object.fromEntries(allColumns.map((c) => [c, ""])));
    }
    for (const row of datasets[i].rows) {
      allRows.push(row);
    }
  }

  return buildCSVFileUpload(allColumns, allRows);
}

/**
 * Count total rows across all datasets.
 */
export function countTotalRows(
  data: { columns: string[]; rows: Record<string, unknown>[] }[],
): number {
  return data.reduce((sum, d) => sum + d.rows.length, 0);
}
