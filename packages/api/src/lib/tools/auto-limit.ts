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

// A dollar-quote tag follows PostgreSQL unquoted-identifier rules: it starts
// with a letter or underscore and continues with letters, digits, or
// underscores. "Letter" includes diacritic and non-Latin letters (`\p{L}`), so a
// Unicode tag like `$café$` is recognized — an ASCII-only test would miss it and
// let a `LIMIT` inside the literal leak past the cap. Digits are excluded from
// the START position, so positional parameters (`$1`, `$2`) are never tags.
// (Each test is a single-char, anchored match — O(1), no ReDoS surface.)
const TAG_START_RE = /[\p{L}_]/u;
const TAG_CONT_RE = /[\p{L}0-9_]/u;
const isTagStart = (ch: string | undefined): boolean =>
  ch !== undefined && TAG_START_RE.test(ch);
const isTagCont = (ch: string | undefined): boolean =>
  ch !== undefined && TAG_CONT_RE.test(ch);

/**
 * Match a PostgreSQL dollar-quote OPENING delimiter at index `i` (where
 * `sql[i] === "$"`). Returns the full delimiter (`$$` or `$tag$`, where the tag
 * follows Postgres identifier rules — see {@link isTagStart}/{@link isTagCont})
 * or null if the `$` doesn't open a dollar-quote.
 *
 * Positional parameters (`$1`, `$2`, …) never match: a tag can't start with a
 * digit, so `$` + digit (or `$` + anything-but-`$`) returns null.
 *
 * Linear: the tag scan walks single chars via O(1) anchored char tests, and the
 * only slice is of the short matched delimiter, never the body.
 */
function matchDollarTag(sql: string, i: number): string | null {
  const n = sql.length;
  let j = i + 1; // char after the opening `$`
  if (isTagStart(sql[j])) {
    j++;
    while (j < n && isTagCont(sql[j])) j++;
  }
  if (j < n && sql[j] === "$") return sql.slice(i, j + 1);
  return null;
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
 *   - `$$...$$` / `$tag$...$tag$` Postgres dollar-quoted string literals — handled
 *     unconditionally (Postgres-only and unambiguous; the syntax doesn't exist in
 *     MySQL, so there's nothing to mis-strip there). Positional parameters
 *     (`$1`, `$2`) are not delimiters — the tag must start with `[A-Za-z_]`, so
 *     `$` + digit never opens a dollar-quote.
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
  if (!/['"`#$]|--|\/\*/.test(sql)) return sql;
  const backslashEscapes = opts?.backslashEscapes ?? false;
  let out = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    // PostgreSQL dollar-quoted literal: $$...$$ or $tag$...$tag$. Checked first
    // so the inner text (which may contain quotes/comments/LIMIT) is blanked
    // wholesale. Positional params ($1, $2) fall through (matchDollarTag → null).
    if (c === "$") {
      const delim = matchDollarTag(sql, i);
      if (delim) {
        const close = sql.indexOf(delim, i + delim.length);
        if (close === -1) {
          out += sql.slice(i);
          break;
        }
        // Blank to a fixed empty anonymous dollar-quote: boundary-preserving and
        // word-char-free. Echoing the real delimiter (`delim + delim`) would leak
        // the TAG text — a tag literally named `$limit$` would put "limit" back in
        // the output and re-spoof detection. (CodeRabbit #3329.)
        out += "$$";
        i = close + delim.length;
        continue;
      }
    }
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

/**
 * Append the auto-LIMIT row cap to a query. The clause goes on its OWN line:
 * a same-line append after a trailing `--` (or `#`) line comment would be
 * swallowed by the comment (`SELECT * FROM t -- LIMIT 1000`) and the query
 * would run uncapped. A newline terminates any line comment, so the cap is
 * always effective. Trailing block comments are no hazard either way — an
 * unterminated slash-star never survives AST validation, and a terminated one
 * doesn't extend past its close. See #3335.
 */
export function appendRowLimit(sql: string, rowLimit: number): string {
  return `${sql}\nLIMIT ${rowLimit}`;
}
