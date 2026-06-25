import { describe, expect, test } from "bun:test";
import { loadYaml } from "../yaml";

// ---------------------------------------------------------------------------
// loadYaml — preserves js-yaml v4's empty-input behavior under v5.
//
// js-yaml v5's `load()` throws a YAMLException on document-less input (empty,
// whitespace-only, or comment-only) where v4 returned `undefined`. loadYaml
// restores `undefined` for that case while letting genuine parse errors throw.
// ---------------------------------------------------------------------------

describe("loadYaml", () => {
  test("returns undefined for document-less input (matches v4)", () => {
    expect(loadYaml("")).toBeUndefined();
    expect(loadYaml("   ")).toBeUndefined();
    expect(loadYaml("\n\n  \n")).toBeUndefined();
    expect(loadYaml("# just a comment\n")).toBeUndefined();
    expect(loadYaml("# a\n  # indented comment\n")).toBeUndefined();
  });

  test("parses a normal YAML mapping", () => {
    expect(loadYaml("table: orders\ngrain: one row per order\n")).toEqual({
      table: "orders",
      grain: "one row per order",
    });
  });

  test("parses scalars and sequences", () => {
    expect(loadYaml("hello")).toBe("hello");
    expect(loadYaml("- a\n- b\n")).toEqual(["a", "b"]);
  });

  test("a lone document marker still parses (null), not short-circuited", () => {
    // `---` is a document, not blank — must reach yaml.load (→ null), exactly
    // as raw v5 does; only truly content-less input short-circuits.
    expect(loadYaml("---\n")).toBeNull();
  });

  test("preserves v4 number/scalar resolution (default schema, not YAML 1.1)", () => {
    // Sanity-check the schema decision: v5's default schema matches v4 here —
    // leading-zero is decimal, sexagesimal/`yes` stay strings (YAML11_SCHEMA
    // would have changed all three).
    expect(loadYaml("v: 01234")).toEqual({ v: 1234 });
    expect(loadYaml("v: 1:23")).toEqual({ v: "1:23" });
    expect(loadYaml("v: yes")).toEqual({ v: "yes" });
  });

  test("still throws on genuinely malformed YAML", () => {
    expect(() => loadYaml("broken: [unclosed")).toThrow();
    expect(() => loadYaml("{{{")).toThrow();
  });
});
