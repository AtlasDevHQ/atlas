import { describe, expect, it } from "bun:test";
import { hasLimitClause, stripSqlNonClauseText } from "../auto-limit";

// Regression coverage for the auto-LIMIT bypass class (#3325): the presence
// check must ignore the word LIMIT when it appears anywhere it isn't a real
// clause — inside a string literal, a quoted identifier, or a comment — so a
// crafted value can neither suppress nor spoof the appended row cap.

describe("stripSqlNonClauseText", () => {
  it("replaces single-quoted literals with empty quotes", () => {
    expect(stripSqlNonClauseText("WHERE name = 'no LIMIT here'")).toBe(
      "WHERE name = ''",
    );
  });

  it("honors doubled-quote escapes ('') in every dialect", () => {
    expect(stripSqlNonClauseText("WHERE x = 'it''s LIMIT 5' AND y = 1")).toBe(
      "WHERE x = '' AND y = 1",
    );
  });

  it("fast-paths a query with no literals/identifiers/comments", () => {
    const q = "SELECT id FROM users WHERE active = true";
    expect(stripSqlNonClauseText(q)).toBe(q);
  });

  it("blanks double-quoted identifiers", () => {
    expect(stripSqlNonClauseText('SELECT 1 AS "LIMIT" FROM t')).toBe(
      'SELECT 1 AS "" FROM t',
    );
  });

  it("blanks backtick identifiers", () => {
    expect(stripSqlNonClauseText("SELECT 1 AS `LIMIT` FROM t")).toBe(
      "SELECT 1 AS `` FROM t",
    );
  });

  it("blanks line and block comments", () => {
    expect(stripSqlNonClauseText("SELECT * FROM t -- LIMIT 5")).toBe(
      "SELECT * FROM t  ",
    );
    expect(stripSqlNonClauseText("SELECT * /* LIMIT 5 */ FROM t")).toBe(
      "SELECT *   FROM t",
    );
  });

  // Dialect split on backslash: Postgres (standard_conforming_strings=on, the
  // default) treats `\` inside a '...' literal as a literal char; MySQL treats
  // `\'` as an escaped quote. Honoring `\'` unconditionally would mis-pair the
  // closing quote of a Postgres value ending in `\`.
  describe("backslash handling is dialect-gated", () => {
    it("default (Postgres): backslash is a literal char, not an escape", () => {
      expect(stripSqlNonClauseText("x = 'C:\\path\\' AND y = 1")).toBe(
        "x = '' AND y = 1",
      );
    });

    it("MySQL (backslashEscapes): `\\'` is an escaped quote inside the literal", () => {
      expect(
        stripSqlNonClauseText("x = 'a\\'b' AND y = 1", { backslashEscapes: true }),
      ).toBe("x = '' AND y = 1");
    });
  });

  it("leaves an unterminated literal intact so a real clause stays visible", () => {
    const input = "SELECT * FROM t WHERE x = 'oops LIMIT 5";
    expect(stripSqlNonClauseText(input)).toBe(input);
  });

  it("preserves an empty string literal", () => {
    expect(stripSqlNonClauseText("WHERE x = '' AND y = 2")).toBe(
      "WHERE x = '' AND y = 2",
    );
  });

  // Postgres dollar-quoting: $$...$$ and $tag$...$tag$ (#3325 follow-up). A
  // LIMIT inside one is a string value, never a clause, so the whole region is
  // blanked to a boundary-preserving placeholder.
  describe("Postgres dollar-quoted literals", () => {
    // The placeholder is a fixed empty anonymous dollar-quote (`$$`), not the
    // echoed delimiter — echoing the tag would leak its text (see the
    // tag-named-`limit` case below).
    it("blanks an anonymous $$...$$ literal", () => {
      expect(
        stripSqlNonClauseText("SELECT * FROM t WHERE note = $$no LIMIT here$$"),
      ).toBe("SELECT * FROM t WHERE note = $$");
    });

    it("blanks a tagged $tag$...$tag$ literal", () => {
      expect(
        stripSqlNonClauseText("SELECT * FROM t WHERE note = $msg$no LIMIT here$msg$"),
      ).toBe("SELECT * FROM t WHERE note = $$");
    });

    // Postgres dollar-quote tags follow unquoted-identifier rules, which allow
    // diacritic/non-Latin letters — so a Unicode tag must be recognized and
    // blanked, else a LIMIT inside it leaks past the cap.
    it("blanks a Unicode-tagged $café$...$café$ literal", () => {
      expect(
        stripSqlNonClauseText("SELECT * FROM t WHERE note = $café$no LIMIT here$café$"),
      ).toBe("SELECT * FROM t WHERE note = $$");
    });

    // The tag itself is word-bearing: echoing the delimiter would put "limit"
    // back into the sanitized output and re-spoof detection. (CodeRabbit #3329.)
    it("does not leak a word-bearing tag name into the placeholder", () => {
      expect(
        stripSqlNonClauseText("SELECT * FROM t WHERE note = $limit$no LIMIT here$limit$"),
      ).toBe("SELECT * FROM t WHERE note = $$");
    });

    it("blanks a multi-line dollar-quoted literal", () => {
      expect(
        stripSqlNonClauseText("SELECT $$first line\nLIMIT 5\nlast line$$ FROM t"),
      ).toBe("SELECT $$ FROM t");
    });

    it("does not treat a positional parameter ($1) as a delimiter", () => {
      const q = "SELECT * FROM t WHERE id = $1 AND x = $2";
      expect(stripSqlNonClauseText(q)).toBe(q);
    });

    it("leaves an unterminated $$ intact so a real clause stays visible", () => {
      const input = "SELECT * FROM t WHERE note = $$oops LIMIT 5";
      expect(stripSqlNonClauseText(input)).toBe(input);
    });

    it("does not confuse a different tag for the closing delimiter", () => {
      expect(
        stripSqlNonClauseText("SELECT $a$inner $b$ still LIMIT inside$a$ FROM t"),
      ).toBe("SELECT $$ FROM t");
    });
  });
});

describe("hasLimitClause", () => {
  it("detects a real trailing LIMIT clause", () => {
    expect(hasLimitClause("SELECT * FROM t LIMIT 50")).toBe(true);
  });

  it("detects clause forms with no digit / offset variants", () => {
    expect(hasLimitClause("SELECT * FROM t LIMIT ALL")).toBe(true);
    expect(hasLimitClause("SELECT * FROM t LIMIT 10, 20")).toBe(true);
    expect(hasLimitClause("SELECT * FROM t LIMIT 10 OFFSET 5")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(hasLimitClause("select * from t limit 5")).toBe(true);
  });

  it("does NOT treat LIMIT inside a string literal as a clause (the bypass)", () => {
    expect(hasLimitClause("SELECT * FROM t WHERE name = 'no LIMIT here'")).toBe(
      false,
    );
    expect(hasLimitClause("SELECT * FROM t WHERE c = 'LIMIT'")).toBe(false);
  });

  it("does NOT treat LIMIT inside a comment as a clause", () => {
    expect(hasLimitClause("SELECT * FROM t -- LIMIT 5")).toBe(false);
    expect(hasLimitClause("SELECT * FROM t /* LIMIT 5 */")).toBe(false);
    // # is a MySQL comment only — gated on backslashEscapes.
    expect(hasLimitClause("SELECT * FROM t # LIMIT 5", { backslashEscapes: true })).toBe(
      false,
    );
  });

  it("does NOT treat LIMIT inside a quoted identifier as a clause", () => {
    expect(hasLimitClause('SELECT 1 AS "LIMIT" FROM t')).toBe(false);
    expect(hasLimitClause("SELECT 1 AS `LIMIT` FROM t", { backslashEscapes: true })).toBe(
      false,
    );
  });

  it("does not mistake a Postgres `#` operator for a comment (would hide a real LIMIT)", () => {
    // backslashEscapes off (Postgres): `#` is not a comment, so the real LIMIT
    // after it must still be detected.
    expect(hasLimitClause("SELECT a # b FROM t LIMIT 5")).toBe(true);
  });

  it("still detects a real LIMIT alongside a literal/comment containing the word", () => {
    expect(
      hasLimitClause("SELECT * FROM t WHERE name = 'no LIMIT here' LIMIT 100"),
    ).toBe(true);
    expect(hasLimitClause("SELECT * FROM t /* paginated */ LIMIT 100")).toBe(true);
  });

  it("returns false for a query with no LIMIT at all", () => {
    expect(hasLimitClause("SELECT id, name FROM users WHERE active = true")).toBe(
      false,
    );
  });

  // The dialect-gating regression: a Postgres value ending in `\` must not let a
  // following literal's `LIMIT` text leak through and spoof detection.
  it("Postgres: backslash-bearing literal does not spoof LIMIT detection", () => {
    expect(
      hasLimitClause("SELECT * FROM t WHERE a = 'x\\' AND note = 'no LIMIT here'"),
    ).toBe(false);
  });

  it("MySQL: a `\\'`-escaped literal containing LIMIT is correctly stripped", () => {
    expect(
      hasLimitClause("SELECT * FROM t WHERE x = 'a\\' no LIMIT b'", {
        backslashEscapes: true,
      }),
    ).toBe(false);
  });

  // Postgres dollar-quoting bypass (#3325 follow-up): a LIMIT inside $$...$$ or
  // $tag$...$tag$ is a string value, so it must NOT count as an existing clause
  // (else the row cap is silently suppressed).
  it("does NOT treat LIMIT inside a $$...$$ dollar-quoted literal as a clause", () => {
    expect(
      hasLimitClause("SELECT * FROM t WHERE note = $$no LIMIT here$$"),
    ).toBe(false);
  });

  it("does NOT treat LIMIT inside a $tag$...$tag$ dollar-quoted literal as a clause", () => {
    expect(
      hasLimitClause("SELECT * FROM t WHERE note = $msg$no LIMIT here$msg$"),
    ).toBe(false);
  });

  // Regression: an ASCII-only tag matcher would miss a Unicode-tagged literal,
  // letting the inner LIMIT spoof "already limited" and suppress the row cap.
  it("does NOT treat LIMIT inside a Unicode-tagged $café$...$café$ literal as a clause", () => {
    expect(
      hasLimitClause("SELECT * FROM big WHERE note = $café$LIMIT$café$"),
    ).toBe(false);
  });

  // Regression (CodeRabbit #3329): a tag literally named `limit` must not leak
  // its own text into the sanitized output and spoof detection.
  it("does NOT let a word-bearing tag name ($limit$) spoof a clause", () => {
    expect(
      hasLimitClause("SELECT * FROM t WHERE note = $limit$no LIMIT here$limit$"),
    ).toBe(false);
  });

  it("still detects a real LIMIT alongside a dollar-quoted block containing the word", () => {
    expect(
      hasLimitClause("SELECT * FROM t WHERE note = $$no LIMIT here$$ LIMIT 100"),
    ).toBe(true);
  });

  it("detects a real LIMIT even when a positional parameter precedes it", () => {
    // `$1` must not be parsed as a dollar-quote opener that swallows the clause.
    expect(hasLimitClause("SELECT * FROM t WHERE id = $1 LIMIT 5")).toBe(true);
  });

  it("does not emit a double LIMIT when a $$ block is unterminated", () => {
    // Unterminated dollar-quote: remainder left intact, so the literal LIMIT
    // text inside is still visible and (conservatively) counts as present —
    // matching the existing unterminated-literal behavior, never uncapping.
    expect(
      hasLimitClause("SELECT * FROM t WHERE note = $$oops LIMIT 5"),
    ).toBe(true);
  });
});
