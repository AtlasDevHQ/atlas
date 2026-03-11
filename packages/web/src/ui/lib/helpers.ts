/** Extract tool invocation input from a ToolUIPart. Returns empty object if unavailable. */
export function getToolArgs(part: unknown): Record<string, unknown> {
  if (part == null || typeof part !== "object") return {};
  const input = (part as Record<string, unknown>).input;
  if (input == null || typeof input !== "object") return {};
  return input as Record<string, unknown>;
}

/** Extract tool output from a ToolUIPart. Returns null if not yet available. */
export function getToolResult(part: unknown): unknown {
  if (part == null || typeof part !== "object") return null;
  return (part as Record<string, unknown>).output ?? null;
}

/** True when the tool invocation has finished successfully (state is "output-available"). */
export function isToolComplete(part: unknown): boolean {
  if (part == null || typeof part !== "object") return false;
  return (part as Record<string, unknown>).state === "output-available";
}

/** Parse a CSV string into headers + rows. Handles basic quoting and escaped quotes (""). */
export function parseCSV(csv: string): { headers: string[]; rows: string[][] } {
  if (!csv || !csv.trim()) return { headers: [], rows: [] };

  const lines = csv.trim().split("\n");
  if (lines.length === 0) return { headers: [], rows: [] };

  function parseLine(line: string): string[] {
    const result: string[] = [];
    let current = "";
    let inQuotes = false;
    for (let k = 0; k < line.length; k++) {
      const char = line[k];
      if (char === '"') {
        if (inQuotes && line[k + 1] === '"') {
          current += '"';
          k++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (char === "," && !inQuotes) {
        result.push(current.trim());
        current = "";
      } else {
        current += char;
      }
    }
    result.push(current.trim());
    return result;
  }

  return {
    headers: parseLine(lines[0]),
    rows: lines
      .slice(1)
      .filter((l) => l.trim())
      .map(parseLine),
  };
}

/** Serialize columns + rows to a CSV string. Handles commas, quotes, and newlines in values. */
export function toCsvString(columns: string[], rows: Record<string, unknown>[]): string {
  const escape = (v: unknown) => {
    const s = v == null ? "" : String(v);
    return s.includes(",") || s.includes('"') || s.includes("\n")
      ? `"${s.replace(/"/g, '""')}"`
      : s;
  };
  const header = columns.map(escape).join(",");
  const body = rows.map((row) => columns.map((col) => escape(row[col])).join(","));
  return [header, ...body].join("\n");
}

/** Trigger a CSV download in the browser. */
export function downloadCSV(csv: string, filename = "atlas-results.csv") {
  let url: string | null = null;
  try {
    const blob = new Blob([csv], { type: "text/csv" });
    url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
  } catch (err) {
    console.error("CSV download failed:", err);
    window.alert("CSV download failed");
  } finally {
    if (url) {
      const blobUrl = url;
      setTimeout(() => URL.revokeObjectURL(blobUrl), 10_000);
    }
  }
}

/** Strict ISO date pattern: YYYY-MM-DD with optional time component. */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/;

/** Coerce a cell value to a typed Excel cell: numbers/booleans pass through, ISO dates become Date objects, null becomes empty string. Exported for testing. */
export function coerceExcelCell(v: unknown): unknown {
  if (v == null) return "";
  if (typeof v === "number" || typeof v === "boolean") return v;
  if (typeof v === "string" && ISO_DATE_RE.test(v) && !isNaN(Date.parse(v))) {
    return new Date(v);
  }
  return String(v);
}

/** Trigger an Excel (.xlsx) download in the browser. Dynamically imports xlsx to avoid bundle bloat. */
export async function downloadExcel(
  columns: string[],
  rows: Record<string, unknown>[],
  filename = "atlas-results.xlsx",
) {
  let XLSX: typeof import("xlsx");
  try {
    XLSX = await import("xlsx");
  } catch (err) {
    console.error("Failed to load xlsx library:", err);
    window.alert("Excel export is unavailable. The spreadsheet library failed to load.");
    return;
  }

  let url: string | null = null;
  try {
    const data = rows.map((row) => {
      const obj: Record<string, unknown> = {};
      for (const col of columns) {
        obj[col] = coerceExcelCell(row[col]);
      }
      return obj;
    });
    const ws = XLSX.utils.json_to_sheet(data, { header: columns });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Results");
    const wbOut = XLSX.write(wb, { bookType: "xlsx", type: "array" });
    const blob = new Blob([wbOut], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
  } catch (err) {
    console.error("Excel download failed:", err);
    const detail = err instanceof Error ? err.message : "Unknown error";
    window.alert(`Excel download failed: ${detail}\n\nYou can try the CSV download as an alternative.`);
  } finally {
    if (url) {
      const blobUrl = url;
      setTimeout(() => URL.revokeObjectURL(blobUrl), 10_000);
    }
  }
}

/** Format a cell value: null as em-dash, numbers with locale formatting, else stringified. */
export function formatCell(value: unknown): string {
  if (value == null) return "\u2014";
  if (typeof value === "number") {
    return Number.isInteger(value)
      ? value.toLocaleString()
      : value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }
  return String(value);
}
