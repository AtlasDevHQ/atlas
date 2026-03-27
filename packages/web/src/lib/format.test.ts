import { describe, expect, test } from "bun:test";
import {
  formatDate,
  formatLongDate,
  formatDateTime,
  formatShortDateTime,
  formatNumber,
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
