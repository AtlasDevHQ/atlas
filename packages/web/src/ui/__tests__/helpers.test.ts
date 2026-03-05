import { describe, expect, test } from "bun:test";
import {
  parseCSV,
  toCsvString,
  formatCell,
  getToolArgs,
  getToolResult,
  isToolComplete,
} from "../lib/helpers";

/* ------------------------------------------------------------------ */
/*  parseCSV                                                            */
/* ------------------------------------------------------------------ */

describe("parseCSV", () => {
  test("basic CSV with header and rows", () => {
    const csv = "name,age\nAlice,30\nBob,25";
    const result = parseCSV(csv);
    expect(result.headers).toEqual(["name", "age"]);
    expect(result.rows).toEqual([
      ["Alice", "30"],
      ["Bob", "25"],
    ]);
  });

  test("quoted fields with commas", () => {
    const csv = 'name,address\nAlice,"123 Main St, Apt 4"';
    const result = parseCSV(csv);
    expect(result.headers).toEqual(["name", "address"]);
    expect(result.rows).toEqual([["Alice", "123 Main St, Apt 4"]]);
  });

  test('escaped double quotes ("")', () => {
    const csv = 'name,quote\nAlice,"She said ""hello"""\nBob,"ok"';
    const result = parseCSV(csv);
    expect(result.rows[0]).toEqual(["Alice", 'She said "hello"']);
    expect(result.rows[1]).toEqual(["Bob", "ok"]);
  });

  test("empty input returns empty structure", () => {
    const result = parseCSV("");
    expect(result).toEqual({ headers: [], rows: [] });
  });

  test("whitespace-only input returns empty", () => {
    const result = parseCSV("   \n  \n  ");
    expect(result).toEqual({ headers: [], rows: [] });
  });

  test("header-only CSV (no data rows)", () => {
    const result = parseCSV("name,age,city");
    expect(result.headers).toEqual(["name", "age", "city"]);
    expect(result.rows).toEqual([]);
  });

  test("blank lines between data rows are filtered", () => {
    const csv = "id,val\n1,a\n\n2,b\n\n3,c";
    const result = parseCSV(csv);
    expect(result.rows).toEqual([
      ["1", "a"],
      ["2", "b"],
      ["3", "c"],
    ]);
  });
});

/* ------------------------------------------------------------------ */
/*  toCsvString                                                         */
/* ------------------------------------------------------------------ */

describe("toCsvString", () => {
  test("basic columns and rows", () => {
    const csv = toCsvString(["name", "age"], [{ name: "Alice", age: 30 }, { name: "Bob", age: 25 }]);
    expect(csv).toBe("name,age\nAlice,30\nBob,25");
  });

  test("escapes commas in values", () => {
    const csv = toCsvString(["name", "address"], [{ name: "Alice", address: "123 Main St, Apt 4" }]);
    expect(csv).toBe('name,address\nAlice,"123 Main St, Apt 4"');
  });

  test("escapes double quotes in values", () => {
    const csv = toCsvString(["name", "quote"], [{ name: "Alice", quote: 'She said "hello"' }]);
    expect(csv).toBe('name,quote\nAlice,"She said ""hello"""');
  });

  test("escapes newlines in values", () => {
    const csv = toCsvString(["name", "bio"], [{ name: "Alice", bio: "Line 1\nLine 2" }]);
    expect(csv).toBe('name,bio\nAlice,"Line 1\nLine 2"');
  });

  test("null and undefined become empty strings", () => {
    const csv = toCsvString(["a", "b"], [{ a: null, b: undefined }]);
    expect(csv).toBe("a,b\n,");
  });

  test("empty rows produce header only", () => {
    const csv = toCsvString(["x", "y"], []);
    expect(csv).toBe("x,y");
  });

  test("roundtrips with parseCSV for simple data", () => {
    const cols = ["id", "name"];
    const rows = [{ id: 1, name: "Acme" }, { id: 2, name: "Beta" }];
    const csv = toCsvString(cols, rows);
    const parsed = parseCSV(csv);
    expect(parsed.headers).toEqual(cols);
    expect(parsed.rows).toEqual([["1", "Acme"], ["2", "Beta"]]);
  });
});

/* ------------------------------------------------------------------ */
/*  formatCell                                                          */
/* ------------------------------------------------------------------ */

describe("formatCell", () => {
  test("null renders as em-dash", () => {
    expect(formatCell(null)).toBe("\u2014");
  });

  test("undefined renders as em-dash", () => {
    expect(formatCell(undefined)).toBe("\u2014");
  });

  test("integer formats with locale separators", () => {
    const result = formatCell(1000);
    // Locale formatting varies, but should contain "1" and represent 1000
    expect(result).toContain("1");
    expect(result).not.toBe("1000.00");
  });

  test("float limits to 2 decimal places", () => {
    const result = formatCell(3.14159);
    expect(result).toContain("3");
    // Should not have more than 2 decimal digits
    const parts = result.replace(/[^0-9.]/g, "").split(".");
    if (parts.length > 1) {
      expect(parts[1].length).toBeLessThanOrEqual(2);
    }
  });

  test("string values pass through", () => {
    expect(formatCell("hello")).toBe("hello");
  });

  test("zero is formatted as '0'", () => {
    expect(formatCell(0)).toBe("0");
  });
});

/* ------------------------------------------------------------------ */
/*  getToolArgs                                                         */
/* ------------------------------------------------------------------ */

describe("getToolArgs", () => {
  test("returns input from valid part", () => {
    const part = { input: { query: "SELECT 1" } };
    expect(getToolArgs(part)).toEqual({ query: "SELECT 1" });
  });

  test("returns empty object for null", () => {
    expect(getToolArgs(null)).toEqual({});
  });

  test("returns empty object when input is not an object", () => {
    expect(getToolArgs({ input: "string" })).toEqual({});
    expect(getToolArgs({ input: 42 })).toEqual({});
  });
});

/* ------------------------------------------------------------------ */
/*  getToolResult                                                       */
/* ------------------------------------------------------------------ */

describe("getToolResult", () => {
  test("returns output from valid part", () => {
    const part = { output: { rows: [1, 2, 3] } };
    expect(getToolResult(part)).toEqual({ rows: [1, 2, 3] });
  });

  test("returns null for null", () => {
    expect(getToolResult(null)).toBeNull();
  });

  test("returns null when no output property", () => {
    expect(getToolResult({ state: "running" })).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/*  isToolComplete                                                      */
/* ------------------------------------------------------------------ */

describe("isToolComplete", () => {
  test('returns true for state "output-available"', () => {
    expect(isToolComplete({ state: "output-available" })).toBe(true);
  });

  test("returns false for other states", () => {
    expect(isToolComplete({ state: "running" })).toBe(false);
    expect(isToolComplete({ state: "error" })).toBe(false);
  });

  test("returns false for null", () => {
    expect(isToolComplete(null)).toBe(false);
  });
});
