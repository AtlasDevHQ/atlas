import { describe, it, expect } from "bun:test";

import { foldRollingMean } from "@atlas/api/lib/learn/rolling-mean";

describe("foldRollingMean", () => {
  it("seeds the average on the first observation (oldAvg null)", () => {
    // First-ever observation: count is 0, no prior average → average is the sample.
    expect(foldRollingMean(null, 0, 42)).toBe(42);
  });

  it("treats sample = 0 as a finite, valid first observation (not skipped)", () => {
    // 0ms is a real measurement, distinct from "no measurement" (null).
    expect(foldRollingMean(null, 0, 0)).toBe(0);
  });

  it("folds the n-th observation as an incremental rolling mean", () => {
    // avg=100 over 1 observation, fold a 200ms sample → (100*1 + 200)/2 = 150.
    expect(foldRollingMean(100, 1, 200)).toBe(150);
    // avg=150 over 2 observations, fold 300 → (150*2 + 300)/3 = 200.
    expect(foldRollingMean(150, 2, 300)).toBe(200);
  });

  it("folds sample = 0 into an existing average (finite, not skipped)", () => {
    // (90*1 + 0)/2 = 45 — a 0ms sample pulls the mean down, it is not ignored.
    expect(foldRollingMean(90, 1, 0)).toBe(45);
  });

  it("returns the old average unchanged when the sample is null (no skew)", () => {
    // A missing measurement must not fabricate a 0 and drag the mean down.
    expect(foldRollingMean(120, 5, null)).toBe(120);
  });

  it("returns null when there is no prior average and no sample", () => {
    // Not-yet-observed stays not-yet-observed.
    expect(foldRollingMean(null, 0, null)).toBeNull();
  });

  it("stays numerically stable across a large number of constant folds", () => {
    // Folding the same value repeatedly must converge to (and stay at) that value.
    let avg: number | null = null;
    let count = 0;
    for (let i = 0; i < 100_000; i++) {
      avg = foldRollingMean(avg, count, 250);
      count++;
    }
    expect(avg).toBeCloseTo(250, 6);
  });

  it("converges toward the true mean of a varying stream", () => {
    // Mean of 1..1000 is 500.5; the incremental fold must land there.
    let avg: number | null = null;
    let count = 0;
    for (let i = 1; i <= 1000; i++) {
      avg = foldRollingMean(avg, count, i);
      count++;
    }
    expect(avg).toBeCloseTo(500.5, 6);
  });
});
