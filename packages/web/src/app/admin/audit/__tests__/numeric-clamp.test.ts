import { describe, expect, test } from "bun:test";
import {
  clampIntInput,
  isIntInRange,
  RETENTION_CUSTOM_DAYS_MIN,
  RETENTION_HARD_DELETE_DELAY_MIN,
} from "../numeric-clamp";

describe("isIntInRange", () => {
  test("accepts integers at or above the minimum", () => {
    expect(isIntInRange("7", 7)).toBe(true);
    expect(isIntInRange("30", 7)).toBe(true);
    expect(isIntInRange("0", 0)).toBe(true);
  });

  test("rejects integers below the minimum", () => {
    expect(isIntInRange("3", 7)).toBe(false);
    expect(isIntInRange("-5", 0)).toBe(false);
  });

  test("rejects empty / whitespace input — Number('') is 0, which must not pass", () => {
    expect(isIntInRange("", 0)).toBe(false);
    expect(isIntInRange("   ", 0)).toBe(false);
  });

  test("rejects non-numeric and non-integer input", () => {
    expect(isIntInRange("abc", 0)).toBe(false);
    expect(isIntInRange("7.5", 7)).toBe(false);
  });

  test("honors an optional maximum", () => {
    expect(isIntInRange("400", 1, 365)).toBe(false);
    expect(isIntInRange("365", 1, 365)).toBe(true);
  });
});

describe("clampIntInput", () => {
  test("clamps below-minimum values up to the minimum", () => {
    expect(clampIntInput("3", 7)).toBe("7");
    expect(clampIntInput("-5", 0)).toBe("0");
  });

  test("passes in-range values through, normalized", () => {
    expect(clampIntInput("30", 7)).toBe("30");
    expect(clampIntInput(" 30 ", 7)).toBe("30");
  });

  test("falls back to the minimum on empty or unparseable input", () => {
    expect(clampIntInput("", 7)).toBe("7");
    expect(clampIntInput("abc", 0)).toBe("0");
  });

  test("rounds fractional input to the nearest integer before clamping", () => {
    expect(clampIntInput("7.4", 7)).toBe("7");
    expect(clampIntInput("8.6", 7)).toBe("9");
    expect(clampIntInput("6.9", 7)).toBe("7");
  });

  test("clamps above an optional maximum", () => {
    expect(clampIntInput("400", 1, 365)).toBe("365");
  });
});

describe("documented retention minimums", () => {
  test("match the server contract (customDays ≥ 7, hardDeleteDelay ≥ 0)", () => {
    expect(RETENTION_CUSTOM_DAYS_MIN).toBe(7);
    expect(RETENTION_HARD_DELETE_DELAY_MIN).toBe(0);
  });
});
