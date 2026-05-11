/**
 * Unit tests for the `AbuseLevel` helpers added alongside #2269.
 *
 * `normalizeAbuseLevel`, `compareAbuseLevel`, and `isAbuseLevelAtLeast`
 * are the typesafe replacements for the `?? "none"` / hand-rolled
 * severity-comparison patterns sprinkled across SDK and admin
 * consumers. Pinning the ladder here is the regression floor: a
 * reordering of `ABUSE_LEVELS` that broke the ordinal contract would
 * silently change which level gates each threshold across every caller.
 */

import { describe, it, expect } from "bun:test";
import {
  ABUSE_LEVELS,
  compareAbuseLevel,
  isAbuseLevelAtLeast,
  normalizeAbuseLevel,
  type AbuseLevel,
} from "../abuse";

describe("normalizeAbuseLevel", () => {
  it("returns 'none' for undefined", () => {
    expect(normalizeAbuseLevel(undefined)).toBe("none");
  });

  it("returns 'none' for null", () => {
    expect(normalizeAbuseLevel(null)).toBe("none");
  });

  it("passes through each defined level unchanged", () => {
    for (const level of ABUSE_LEVELS) {
      expect(normalizeAbuseLevel(level)).toBe(level);
    }
  });
});

describe("compareAbuseLevel", () => {
  it("returns 0 for equal levels", () => {
    for (const level of ABUSE_LEVELS) {
      expect(compareAbuseLevel(level, level)).toBe(0);
    }
  });

  it("orders levels as none < warning < throttled < suspended", () => {
    expect(compareAbuseLevel("none", "warning")).toBeLessThan(0);
    expect(compareAbuseLevel("warning", "throttled")).toBeLessThan(0);
    expect(compareAbuseLevel("throttled", "suspended")).toBeLessThan(0);
    expect(compareAbuseLevel("suspended", "none")).toBeGreaterThan(0);
  });

  it("supports sorting an array of mixed levels", () => {
    const arr: AbuseLevel[] = ["throttled", "none", "suspended", "warning"];
    arr.sort(compareAbuseLevel);
    expect(arr).toEqual(["none", "warning", "throttled", "suspended"]);
  });
});

describe("isAbuseLevelAtLeast", () => {
  it("returns true when level equals or exceeds the floor", () => {
    expect(isAbuseLevelAtLeast("warning", "warning")).toBe(true);
    expect(isAbuseLevelAtLeast("throttled", "warning")).toBe(true);
    expect(isAbuseLevelAtLeast("suspended", "warning")).toBe(true);
  });

  it("returns false when level is below the floor", () => {
    expect(isAbuseLevelAtLeast("none", "warning")).toBe(false);
    expect(isAbuseLevelAtLeast("warning", "throttled")).toBe(false);
    expect(isAbuseLevelAtLeast("throttled", "suspended")).toBe(false);
  });
});
