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

  it("honors doubled-quote escapes ('') inside a literal", () => {
    expect(stripSqlStringLiterals("WHERE x = 'it''s LIMIT 5' AND y = 1")).toBe(
      "WHERE x = '' AND y = 1",
    );
  });

  it("honors MySQL backslash escapes (\\') inside a literal", () => {
    expect(stripSqlStringLiterals("WHERE x = 'a\\' LIMIT 5 b' AND y = 1")).toBe(
      "WHERE x = '' AND y = 1",
    );
  });

  it("leaves an unterminated literal intact so a real clause stays visible", () => {
    // No closing quote — the remainder (including any real LIMIT) is preserved
    // rather than swallowed, so detection can never mis-strip into a double LIMIT.
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
});
