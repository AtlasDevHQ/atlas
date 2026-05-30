import { describe, expect, it } from "bun:test";

import { isStagingRegion } from "@/ui/lib/staging";
import type { DeployRegion } from "@/ui/lib/types";

describe("isStagingRegion", () => {
  it("is true only for the staging region", () => {
    expect(isStagingRegion("staging")).toBe(true);
  });

  it("is false for every production region", () => {
    const prodRegions: DeployRegion[] = ["us", "eu", "apac"];
    for (const region of prodRegions) {
      expect(isStagingRegion(region)).toBe(false);
    }
  });

  it("treats a missing region as non-staging", () => {
    expect(isStagingRegion(undefined)).toBe(false);
    expect(isStagingRegion(null)).toBe(false);
  });

  it("never mistakes an unrecognized region for staging", () => {
    // Defensive: a region the client's union doesn't know about must never
    // be treated as staging.
    expect(isStagingRegion("production" as DeployRegion)).toBe(false);
  });
});
