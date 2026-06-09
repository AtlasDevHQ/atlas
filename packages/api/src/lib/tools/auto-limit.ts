/**
 * Auto-LIMIT helpers for the executeSQL pipeline.
 *
 * Kept in a standalone, dependency-free module (no DB / logger / settings
 * imports) so the literal-stripping + LIMIT-detection logic can be unit-tested
 * directly without mocking the whole sql.ts module graph. See #3325.
 */

/**
 * Scan past a quoted region whose opening quote is at index `i`. Returns the
 * index just after the closing quote, or -1 if the region is unterminated.
 * Honors the doubled-quote escape (`''`, `""`, ``` `` ```) and, when
 * `backslashEscapes` is set, the MySQL backslash escape (`\'`).
 */
function consumeQuoted(
  sql: string,
  i: number,
  quote: string,
  backslashEscapes: boolean,
): number {
  const n = sql.length;
  let j = i + 1;
  while (j < n) {
    if (backslashEscapes && sql[j] === "\\") {
      j += 2;
      continue;
    }
    if (sql[j] === quote) {
      if (sql[j + 1] === quote) {
        j += 2; // doubled-quote escape
        continue;
      }
      return j + 1;
    }
    j++;
  }
  return -1;
}

/**
 * Blank every region of a SQL string that could contain the word `LIMIT`
 * without it being a real LIMIT clause: string literals, quoted identifiers,
 * and comments. Used so the auto-LIMIT presence check can't be spoofed (a
 * quoted/commented `LIMIT` suppressing the appended row cap → an uncapped
 * query) nor mis-fire. See #3325.
 *
 * Blanking is monotonically safe for the cap: a real LIMIT clause is bare SQL —
 * never inside a literal, identifier, or comment — so it is never blanked, and
 * removing the others can only eliminate false positives.
 *
 * Single-pass scan (no regex over the body, provably linear, nothing for a
 * ReDoS analyzer to flag). Regions handled:
 *   - `'...'` string literals — doubled-quote `''` always; backslash `\'` only
 *     when `backslashEscapes` (MySQL). Postgres with
 *     standard_conforming_strings=on (the default) treats `\` as a literal char,
 *     so honoring `\'` there would mis-pair a value ending in `\`.
 *   - `"..."` / `` `...` `` quoted identifiers — blanked regardless of dialect
 *     (whether the engine reads them as identifiers or strings, a `LIMIT` inside
 *     is never a clause).
 *   - `--` / `#` line comments and slash-star block comments. `--` and block
 *     comments are universal (Postgres + MySQL); `#` is MySQL-only, gated on
 *     `backslashEscapes` so a Postgres `#` operator isn't mistaken for a comment.
 *
 * Unterminated regions leave the remainder intact (the query is malformed and
 * cannot reach here post-AST-validation; this only guards against mis-stripping
 * a real trailing clause).
 */
export function stripSqlNonClauseText(
  sql: string,
  opts?: { backslashEscapes?: boolean },
): string {
  // Fast path: nothing that can hold a spurious keyword.
  if (!/['"`#]|--|\/\*/.test(sql)) return sql;
  const backslashEscapes = opts?.backslashEscapes ?? false;
  let out = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    // String literal (') or double-quoted identifier (").
    if (c === "'" || c === '"') {
      const end = consumeQuoted(sql, i, c, backslashEscapes);
      if (end === -1) {
        out += sql.slice(i);
        break;
      }
      out += c + c; // blanked, boundary-preserving ('' or "")
      i = end;
      continue;
    }
    // Backtick identifier (MySQL) — doubled-backtick escape, no backslash.
    if (c === "`") {
      const end = consumeQuoted(sql, i, "`", false);
      if (end === -1) {
        out += sql.slice(i);
        break;
      }
      out += "``";
      i = end;
      continue;
    }
    // Line comment: -- ... (universal)
    if (c === "-" && sql[i + 1] === "-") {
      let j = i + 2;
      while (j < n && sql[j] !== "\n") j++;
      out += " ";
      i = j;
      continue;
    }
    // Line comment: # ... (MySQL only)
    if (c === "#" && backslashEscapes) {
      let j = i + 1;
      while (j < n && sql[j] !== "\n") j++;
      out += " ";
      i = j;
      continue;
    }
    // Block comment: /* ... */
    if (c === "/" && sql[i + 1] === "*") {
      const close = sql.indexOf("*/", i + 2);
      if (close === -1) {
        out += sql.slice(i);
        break;
      }
      out += " ";
      i = close + 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * Whether a SQL string already carries a LIMIT clause. Tests the sanitized form
 * (literals, quoted identifiers, and comments blanked) so a quoted value or a
 * comment can't spoof or suppress detection. Keeps the bare `\bLIMIT\b` word
 * test (rather than requiring `LIMIT <number>`) because SQL has clause-bearing
 * forms with no digit — `LIMIT ALL`, `LIMIT n, m`, `LIMIT n OFFSET m` — where
 * appending a second `LIMIT` would produce invalid SQL.
 *
 * Short-circuits when the raw SQL has no `LIMIT` token at all: sanitizing only
 * ever REMOVES occurrences, so absent-in-raw ⇒ absent-in-sanitized. This keeps
 * the common no-LIMIT query off the scan path.
 *
 * `backslashEscapes` is forwarded to {@link stripSqlNonClauseText} so MySQL
 * `\'`-escaped literals and `#` comments are handled correctly without breaking
 * Postgres.
 */
export function hasLimitClause(
  sql: string,
  opts?: { backslashEscapes?: boolean },
): boolean {
  if (!/\bLIMIT\b/i.test(sql)) return false;
  return /\bLIMIT\b/i.test(stripSqlNonClauseText(sql, opts));
}
