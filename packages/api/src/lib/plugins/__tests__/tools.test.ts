import { describe, test, expect, beforeEach } from "bun:test";
import { setDialectHints, getDialectHints, setContextFragments, getContextFragments } from "../tools";
import type { DialectHint } from "../wiring";

describe("setDialectHints / getDialectHints", () => {
  beforeEach(() => {
    setDialectHints([]);
  });

  test("defaults to empty array", () => {
    expect(getDialectHints()).toEqual([]);
  });

  test("round-trips DialectHint[]", () => {
    const hints: DialectHint[] = [
      { pluginId: "bq", dialect: "Use SAFE_DIVIDE for BigQuery." },
      { pluginId: "redshift", dialect: "Use GETDATE() instead of NOW()." },
    ];
    setDialectHints(hints);
    expect(getDialectHints()).toEqual(hints);
  });

  test("overwrites previous hints", () => {
    setDialectHints([{ pluginId: "a", dialect: "first" }]);
    setDialectHints([{ pluginId: "b", dialect: "second" }]);
    expect(getDialectHints()).toEqual([{ pluginId: "b", dialect: "second" }]);
  });

  test("set empty clears hints", () => {
    setDialectHints([{ pluginId: "a", dialect: "hint" }]);
    setDialectHints([]);
    expect(getDialectHints()).toEqual([]);
  });
});

describe("setContextFragments / getContextFragments", () => {
  beforeEach(() => {
    setContextFragments([]);
  });

  test("defaults to empty array", () => {
    expect(getContextFragments()).toEqual([]);
  });

  test("round-trips fragments", () => {
    setContextFragments(["frag1", "frag2"]);
    expect(getContextFragments()).toEqual(["frag1", "frag2"]);
  });
});
