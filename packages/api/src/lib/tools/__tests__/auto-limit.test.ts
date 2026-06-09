import { describe, expect, it } from "bun:test";
import { hasLimitClause, stripSqlStringLiterals } from "../auto-limit";

// Regression coverage for the auto-LIMIT literal bypass (#3325): the presence
// check must ignore the word LIMIT when it appears inside a string literal, so
// a crafted value can neither suppress nor spoof the appended row cap.

describe("stripSqlStringLiterals", () => {
  it("replaces single-quoted literals with empty quotes", () => {
    expect(stripSqlStringLiterals("WHERE name = 'no LIMIT here'")).toBe(
      "WHERE name = ''",
    );
  });

  it("honors doubled-quote escapes ('') in every dialect", () => {
    expect(stripSqlStringLiterals("WHERE x = 'it''s LIMIT 5' AND y = 1")).toBe(
      "WHERE x = '' AND y = 1",
    );
  });

  it("fast-paths a query with no literals (returned unchanged)", () => {
    const q = "SELECT id FROM users WHERE active = true";
    expect(stripSqlStringLiterals(q)).toBe(q);
  });

  // Dialect split on backslash: Postgres (standard_conforming_strings=on, the
  // default) treats `\` inside a '...' literal as a literal char; MySQL treats
  // `\'` as an escaped quote. Honoring `\'` unconditionally would mis-pair the
  // closing quote of a Postgres value ending in `\` — the bug this gating fixes.
  describe("backslash handling is dialect-gated", () => {
    it("default (Postgres): backslash is a literal char, not an escape", () => {
      // `'C:\path\'` is the complete value `C:\path\`; the trailing quote closes.
      expect(stripSqlStringLiterals("x = 'C:\\path\\' AND y = 1")).toBe(
        "x = '' AND y = 1",
      );
    });

    it("MySQL (backslashEscapes): `\\'` is an escaped quote inside the literal", () => {
      // `'a\'b'` is the value `a'b` — the escaped quote does NOT close it.
      expect(
        stripSqlStringLiterals("x = 'a\\'b' AND y = 1", { backslashEscapes: true }),
      ).toBe("x = '' AND y = 1");
    });
  });

  it("leaves an unterminated literal intact so a real clause stays visible", () => {
    const input = "SELECT * FROM t WHERE x = 'oops LIMIT 5";
    expect(stripSqlStringLiterals(input)).toBe(input);
  });

  it("preserves an empty string literal", () => {
    expect(stripSqlStringLiterals("WHERE x = '' AND y = 2")).toBe(
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

  it("still detects a real LIMIT alongside a literal containing the word", () => {
    expect(
      hasLimitClause("SELECT * FROM t WHERE name = 'no LIMIT here' LIMIT 100"),
    ).toBe(true);
  });

  it("returns false for a query with no LIMIT at all", () => {
    expect(hasLimitClause("SELECT id, name FROM users WHERE active = true")).toBe(
      false,
    );
  });

  // The core regression the dialect gating prevents: a Postgres value ending in
  // `\` must not let a following literal's `LIMIT` text leak through and spoof
  // detection (→ suppressed cap → uncapped query).
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
