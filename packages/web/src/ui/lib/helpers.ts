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
