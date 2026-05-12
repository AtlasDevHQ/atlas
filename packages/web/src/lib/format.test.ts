import { describe, expect, test } from "bun:test";
import {
  formatDate,
  formatLongDate,
  formatDateTime,
  formatShortDateTime,
  formatNumber,
  parseISODate,
  formatISODate,
} from "./format";

const EM_DASH = "\u2014";

// Use a fixed UTC date to avoid timezone flakiness in CI.
// We test that the formatters produce *some* reasonable output rather than
// asserting exact locale strings, since locale rendering varies by OS/ICU.
const ISO = "2026-03-27T14:30:00Z";
const DATE_OBJ = new Date(ISO);
const EPOCH_MS = DATE_OBJ.getTime();

describe("formatDate", () => {
  test("returns em-dash for null", () => {
    expect(formatDate(null)).toBe(EM_DASH);
  });

  test("returns em-dash for undefined", () => {
    expect(formatDate(undefined)).toBe(EM_DASH);
  });

  test("returns em-dash for invalid date string", () => {
    expect(formatDate("not-a-date")).toBe(EM_DASH);
  });

  test("formats valid ISO string", () => {
    const result = formatDate(ISO);
    expect(result).toContain("2026");
    expect(result).not.toBe(EM_DASH);
  });

  test("formats Date object", () => {
    const result = formatDate(DATE_OBJ);
    expect(result).toContain("2026");
  });

  test("formats numeric timestamp", () => {
    const result = formatDate(EPOCH_MS);
    expect(result).toContain("2026");
  });

  test("handles epoch zero as valid date", () => {
    const result = formatDate(0);
    expect(result).toContain("1970");
    expect(result).not.toBe(EM_DASH);
  });
});

describe("formatLongDate", () => {
  test("returns em-dash for null", () => {
    expect(formatLongDate(null)).toBe(EM_DASH);
  });

  test("uses long month name (en-US)", () => {
    const result = formatLongDate(ISO);
    expect(result).toContain("March");
    expect(result).toContain("2026");
  });
});

describe("formatDateTime", () => {
  test("returns em-dash for null", () => {
    expect(formatDateTime(null)).toBe(EM_DASH);
  });

  test("returns em-dash for invalid string", () => {
    expect(formatDateTime("nope")).toBe(EM_DASH);
  });

  test("includes year and time components", () => {
    const result = formatDateTime(ISO);
    expect(result).toContain("2026");
    // Should contain time separator (colon between hour:minute)
    expect(result).toMatch(/\d{1,2}:\d{2}/);
  });
});

describe("formatShortDateTime", () => {
  test("returns em-dash for null", () => {
    expect(formatShortDateTime(null)).toBe(EM_DASH);
  });

  test("includes time but not year", () => {
    const result = formatShortDateTime(ISO);
    expect(result).toMatch(/\d{1,2}:\d{2}/);
    expect(result).not.toContain("2026");
  });
});

describe("parseISODate", () => {
  test("returns undefined for null/undefined/empty", () => {
    expect(parseISODate(null)).toBeUndefined();
    expect(parseISODate(undefined)).toBeUndefined();
    expect(parseISODate("")).toBeUndefined();
  });

  test("returns undefined for malformed input", () => {
    expect(parseISODate("2026/03/27")).toBeUndefined();
    expect(parseISODate("2026-3-27")).toBeUndefined();
    expect(parseISODate("not a date")).toBeUndefined();
  });

  test("returns undefined for out-of-range values (Feb 30)", () => {
    expect(parseISODate("2026-02-30")).toBeUndefined();
  });

  test("parses yyyy-MM-dd as local midnight", () => {
    const result = parseISODate("2026-03-27");
    expect(result).toBeInstanceOf(Date);
    expect(result?.getFullYear()).toBe(2026);
    expect(result?.getMonth()).toBe(2); // March, zero-indexed
    expect(result?.getDate()).toBe(27);
    expect(result?.getHours()).toBe(0);
  });

  test("round-trips with formatISODate", () => {
    const iso = "2026-05-11";
    const parsed = parseISODate(iso);
    expect(parsed).toBeInstanceOf(Date);
    expect(formatISODate(parsed)).toBe(iso);
  });
});

describe("formatISODate", () => {
  test("returns empty string for null/undefined", () => {
    expect(formatISODate(null)).toBe("");
    expect(formatISODate(undefined)).toBe("");
  });

  test("formats a Date as yyyy-MM-dd in local time", () => {
    const d = new Date(2026, 0, 5); // Jan 5, 2026 local
    expect(formatISODate(d)).toBe("2026-01-05");
  });

  test("zero-pads month and day", () => {
    const d = new Date(2026, 8, 9); // Sep 9
    expect(formatISODate(d)).toBe("2026-09-09");
  });
});

describe("formatNumber", () => {
  test("formats millions with M suffix", () => {
    expect(formatNumber(1_500_000)).toBe("1.5M");
  });

  test("formats thousands with K suffix", () => {
    expect(formatNumber(2_500)).toBe("2.5K");
  });

  test("formats small numbers with locale separators", () => {
    const result = formatNumber(999);
    expect(result).toContain("999");
  });

  test("formats exact million boundary", () => {
    expect(formatNumber(1_000_000)).toBe("1.0M");
  });

  test("formats exact thousand boundary", () => {
    expect(formatNumber(1_000)).toBe("1.0K");
  });
});
