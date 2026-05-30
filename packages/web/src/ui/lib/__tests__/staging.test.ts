import { describe, expect, it } from "bun:test";

import { isStagingRegion } from "@/ui/lib/staging";

describe("isStagingRegion", () => {
  it("is true only for the staging region", () => {
    expect(isStagingRegion("staging")).toBe(true);
  });

  it("is false for every production region", () => {
    for (const region of ["us", "eu", "apac"]) {
      expect(isStagingRegion(region)).toBe(false);
    }
  });

  it("treats a missing region as non-staging", () => {
    expect(isStagingRegion(undefined)).toBe(false);
    expect(isStagingRegion(null)).toBe(false);
  });

  it("never mistakes an unrecognized region for staging", () => {
    // The wire field is a raw string, so any value outside the known regions
    // must fail closed.
    expect(isStagingRegion("production")).toBe(false);
    expect(isStagingRegion("")).toBe(false);
  });
});
