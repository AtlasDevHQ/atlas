import { describe, expect, test } from "bun:test";
import {
  parseCSV,
  parseSuggestions,
  toCsvString,
  formatCell,
  getToolArgs,
  getToolResult,
  isToolComplete,
  coerceExcelCell,
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
/*  coerceExcelCell                                                     */
/* ------------------------------------------------------------------ */

describe("coerceExcelCell", () => {
  test("null and undefined become empty string", () => {
    expect(coerceExcelCell(null)).toBe("");
    expect(coerceExcelCell(undefined)).toBe("");
  });

  test("numbers pass through as-is", () => {
    expect(coerceExcelCell(42)).toBe(42);
    expect(coerceExcelCell(3.14)).toBe(3.14);
    expect(coerceExcelCell(0)).toBe(0);
    expect(coerceExcelCell(-100)).toBe(-100);
  });

  test("booleans pass through as-is", () => {
    expect(coerceExcelCell(true)).toBe(true);
    expect(coerceExcelCell(false)).toBe(false);
  });

  test("ISO date-only strings become Date objects", () => {
    const result = coerceExcelCell("2024-01-15");
    expect(result).toBeInstanceOf(Date);
    expect((result as Date).toISOString()).toContain("2024-01-15");
  });

  test("ISO datetime strings become Date objects", () => {
    const result = coerceExcelCell("2024-06-15T10:30:00Z");
    expect(result).toBeInstanceOf(Date);
  });

  test("ISO datetime with offset becomes Date", () => {
    const result = coerceExcelCell("2024-06-15T10:30:00+05:00");
    expect(result).toBeInstanceOf(Date);
  });

  test("ISO datetime with milliseconds becomes Date", () => {
    const result = coerceExcelCell("2024-06-15T10:30:00.123Z");
    expect(result).toBeInstanceOf(Date);
  });

  test("date-prefixed non-date strings stay as strings", () => {
    expect(coerceExcelCell("2024-01-15-batch-A")).toBe("2024-01-15-batch-A");
    expect(coerceExcelCell("2024-01-15 some random text")).toBe("2024-01-15 some random text");
  });

  test("plain strings pass through as strings", () => {
    expect(coerceExcelCell("hello")).toBe("hello");
    expect(coerceExcelCell("")).toBe("");
  });

  test("numeric strings stay as strings", () => {
    expect(coerceExcelCell("12345")).toBe("12345");
  });

  test("objects become stringified", () => {
    expect(coerceExcelCell({ a: 1 })).toBe("[object Object]");
  });

  test("arrays become stringified", () => {
    expect(coerceExcelCell([1, 2, 3])).toBe("1,2,3");
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
/*  parseSuggestions                                                     */
/* ------------------------------------------------------------------ */

describe("parseSuggestions", () => {
  test("extracts suggestions and strips the block from text", () => {
    const content = `Here is the answer.\n\n<suggestions>\nWhat is the trend?\nHow does this break down?\nWhich accounts matter most?\n</suggestions>`;
    const result = parseSuggestions(content);
    expect(result.text).toBe("Here is the answer.");
    expect(result.suggestions).toEqual([
      "What is the trend?",
      "How does this break down?",
      "Which accounts matter most?",
    ]);
  });

  test("returns empty suggestions when no block present", () => {
    const content = "Just a normal response.";
    const result = parseSuggestions(content);
    expect(result.text).toBe("Just a normal response.");
    expect(result.suggestions).toEqual([]);
  });

  test("handles extra whitespace inside suggestions block", () => {
    const content = `Answer.\n\n<suggestions>\n  Spaced question?  \n\n  Another one?  \n</suggestions>`;
    const result = parseSuggestions(content);
    expect(result.suggestions).toEqual(["Spaced question?", "Another one?"]);
  });

  test("strips block even when inline with text", () => {
    const content = `Some text before <suggestions>\nQ1?\nQ2?\n</suggestions> and after`;
    const result = parseSuggestions(content);
    expect(result.text).toBe("Some text before  and after");
    expect(result.suggestions).toEqual(["Q1?", "Q2?"]);
  });

  test("strips all blocks when multiple exist and merges suggestions", () => {
    const content = `Answer\n<suggestions>\nQ1?\n</suggestions>\nMore text\n<suggestions>\nQ2?\n</suggestions>`;
    const result = parseSuggestions(content);
    expect(result.text).toBe("Answer\n\nMore text");
    expect(result.suggestions).toEqual(["Q1?", "Q2?"]);
  });

  test("returns empty suggestions for empty content", () => {
    const result = parseSuggestions("");
    expect(result.text).toBe("");
    expect(result.suggestions).toEqual([]);
  });

  test("unclosed suggestions tag is not matched (streaming partial)", () => {
    const content = "Answer\n\n<suggestions>\nQ1?\nQ2?";
    const result = parseSuggestions(content);
    expect(result.text).toBe(content);
    expect(result.suggestions).toEqual([]);
  });

  test("caps suggestions at 5", () => {
    const lines = Array.from({ length: 10 }, (_, i) => `Question ${i + 1}?`).join("\n");
    const content = `Answer\n<suggestions>\n${lines}\n</suggestions>`;
    const result = parseSuggestions(content);
    expect(result.suggestions).toHaveLength(5);
    expect(result.suggestions[0]).toBe("Question 1?");
    expect(result.suggestions[4]).toBe("Question 5?");
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
