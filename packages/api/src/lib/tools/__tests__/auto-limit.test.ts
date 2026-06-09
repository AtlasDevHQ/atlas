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
});
