// ---------------------------------------------------------------------------
// CSV serialization for tabular exports (#3210 — per-card CSV export)
//
// Pure, dependency-free helpers shared by the dashboard card export route. Two
// concerns, both security-relevant:
//
//   1. RFC 4180 escaping — fields containing a comma, double-quote, or newline
//      are wrapped in double-quotes with embedded quotes doubled. Without this a
//      single cell value can break the column structure of the whole file.
//
//   2. Formula-injection (CSV injection) neutralization — a cell beginning with
//      `=` `+` `-` `@` (or a leading tab / CR) is interpreted as a FORMULA by
//      Excel / Sheets / LibreOffice when the file is opened, so `=cmd|...` style
//      payloads execute on the viewer's machine. We prefix such a cell with a
//      single quote (`'`) — the spreadsheet's "force text" marker — so the
//      value is shown literally and never evaluated. See OWASP "CSV Injection".
//
// The leading `+`/`-` case is special-cased: a genuine numeric literal
// (`-5.00`, `+1e3`) is left untouched, because the pg driver returns
// `numeric` / `bigint` columns as JS STRINGS, and prefixing those with `'`
// would silently turn every number in a numeric dashboard into text.
// ---------------------------------------------------------------------------

/**
 * Neutralize a leading character that a spreadsheet would treat as a formula.
 * Returns the value prefixed with `'` when dangerous, otherwise unchanged.
 */
function neutralizeFormula(s: string): string {
  if (s.length === 0) return s;
  const first = s[0];
  if (first === "=" || first === "@" || first === "\t" || first === "\r") {
    return `'${s}`;
  }
  if (first === "+" || first === "-") {
    // Leave genuine numeric literals alone (pg returns numeric/bigint as
    // strings); only neutralize when the field is NOT a plain finite number.
    if (Number.isFinite(Number(s))) return s;
    return `'${s}`;
  }
  return s;
}

/** Wrap a field per RFC 4180 when it contains a quote, comma, CR, or LF. */
function rfc4180Quote(s: string): string {
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/**
 * Serialize a single value into a CSV field: formula-neutralized (string-ish
 * values only — a real `number`/`boolean` can't carry a formula payload) and
 * then RFC 4180 escaped. `null`/`undefined` become an empty field.
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
    // A real number/boolean can't begin with a formula character in a way that
    // a spreadsheet would execute, so skip neutralization; still RFC-escape
    // defensively (it will virtually never trigger).
    return rfc4180Quote(String(value));
  }
  const s = typeof value === "string" ? value : JSON.stringify(value) ?? "";
  // Neutralize FIRST (may prepend `'`), then quote — so a neutralized value
  // that also contains a comma/quote is still structurally safe.
  return rfc4180Quote(neutralizeFormula(s));
}

/**
 * Build a full CSV document: a header row of column names followed by one row
 * per record (cells pulled by column key, missing keys → empty). Rows are
 * separated by CRLF per RFC 4180; there is no trailing terminator. Header names
 * and every cell go through {@link csvCell}, so injection-laden column aliases
 * are neutralized too.
 */
export function toCsv(columns: string[], rows: Record<string, unknown>[]): string {
  const header = columns.map(csvCell).join(",");
  const body = rows.map((row) => columns.map((col) => csvCell(row[col])).join(","));
  return [header, ...body].join("\r\n");
}

/** Filename-safe UTC stamp: `YYYYMMDD-HHmmss`. */
function filenameStamp(now: Date): string {
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  return (
    `${pad(now.getUTCFullYear(), 4)}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
    `-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`
  );
}

/** ASCII slug for the download filename. Falls back to `card` when empty. */
function slugifyTitle(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .toLowerCase()
    .slice(0, 80)
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "card";
}

/**
 * Derive a download filename from a card title plus a UTC timestamp:
 * `<slug>-<YYYYMMDD-HHmmss>.csv`. The slug is ASCII-only, so a plain
 * `Content-Disposition: attachment; filename="…"` needs no RFC 5987 encoding.
 */
export function csvFilename(title: string, now: Date): string {
  return `${slugifyTitle(title)}-${filenameStamp(now)}.csv`;
}
