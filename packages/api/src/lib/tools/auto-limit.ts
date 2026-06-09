/**
 * Auto-LIMIT helpers for the executeSQL pipeline.
 *
 * Kept in a standalone, dependency-free module (no DB / logger / settings
 * imports) so the literal-stripping + LIMIT-detection logic can be unit-tested
 * directly without mocking the whole sql.ts module graph. See #3325.
 */

/**
 * Strip single-quoted string literals so the auto-LIMIT presence check doesn't
 * match the word `LIMIT` embedded in a user value (e.g.
 * `WHERE name = 'no LIMIT here'`). Without this, such a literal suppresses the
 * appended row cap → an uncapped query, breaking the "every query gets a LIMIT"
 * guarantee (#3325).
 *
 * Single-pass scan (no regex, provably linear, nothing for a ReDoS analyzer to
 * flag). Honors both SQL escape conventions inside a literal — doubled quotes
 * (`''`, standard SQL/Postgres) and backslash escapes (`\'`, MySQL) — so an
 * escaped quote doesn't end the literal early. An unterminated literal is left
 * untouched, so a real trailing clause can still be detected (never mis-stripped
 * into a double-LIMIT).
 */
export function stripSqlStringLiterals(sql: string): string {
  let out = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    if (sql[i] !== "'") {
      out += sql[i];
      i++;
      continue;
    }
    // At an opening quote — scan for the close, skipping escaped chars.
    let j = i + 1;
    let closed = false;
    while (j < n) {
      if (sql[j] === "\\") {
        j += 2; // MySQL backslash escape (\' , \\)
        continue;
      }
      if (sql[j] === "'") {
        if (sql[j + 1] === "'") {
          j += 2; // doubled-quote escape ('')
          continue;
        }
        closed = true;
        break;
      }
      j++;
    }
    if (!closed) {
      out += sql.slice(i); // unterminated — leave the remainder intact
      break;
    }
    out += "''";
    i = j + 1;
  }
  return out;
}

/**
 * Whether a SQL string already carries a LIMIT clause. Tests the
 * literal-stripped form so a quoted value can't spoof or suppress detection.
 * Keeps the bare `\bLIMIT\b` word test (rather than requiring `LIMIT <number>`)
 * because SQL has clause-bearing forms with no digit — `LIMIT ALL`,
 * `LIMIT n, m`, `LIMIT n OFFSET m` — where appending a second `LIMIT` would
 * produce invalid SQL.
 */
export function hasLimitClause(sql: string): boolean {
  return /\bLIMIT\b/i.test(stripSqlStringLiterals(sql));
}
