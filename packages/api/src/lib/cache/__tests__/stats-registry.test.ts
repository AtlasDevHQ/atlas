/**
 * Tests for the org-bucketed cache stats registry (#4549): two-generation
 * sliding-window rotation, weighted window decay, fleet aggregation, and
 * independence from backend recreation. All time-sensitive assertions inject
 * `now` — no fake timers.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import {
  recordCacheAccess,
  getOrgCacheStats,
  getFleetCacheStats,
  resetCacheStatsRegistry,
} from "../stats-registry";

const WINDOW_MS = 3_600_000;

/** A `now` aligned to the START of a window generation, offset by `intoMs`. */
function at(gen: number, intoMs = 0): number {
  return gen * WINDOW_MS + intoMs;
}

beforeEach(() => {
  resetCacheStatsRegistry();
});

describe("stats registry — lifetime accounting", () => {
  it("never-active org reads as warming (since null, null rates)", () => {
    const s = getOrgCacheStats("org-a", at(100));
    expect(s.since).toBeNull();
    expect(s.hits).toBe(0);
    expect(s.misses).toBe(0);
    expect(s.hitRate).toBeNull();
    expect(s.windowHitRate).toBeNull();
    expect(s.windowTotal).toBe(0);
  });

  it("buckets lifetime hits/misses per org with a since label", () => {
    recordCacheAccess("org-a", true, at(100, 1000));
    recordCacheAccess("org-a", true, at(100, 2000));
    recordCacheAccess("org-a", false, at(100, 3000));
    recordCacheAccess("org-b", false, at(100, 4000));

    const a = getOrgCacheStats("org-a", at(100, 5000));
    expect(a.since).toBe(at(100, 1000));
    expect(a.hits).toBe(2);
    expect(a.misses).toBe(1);
    expect(a.hitRate).toBeCloseTo(2 / 3, 10);

    // org-b's bucket is isolated from org-a's.
    const b = getOrgCacheStats("org-b", at(100, 5000));
    expect(b.hits).toBe(0);
    expect(b.misses).toBe(1);
    expect(b.hitRate).toBe(0);
  });

  it("no-org accesses land in their own bucket (undefined orgId)", () => {
    recordCacheAccess(undefined, true, at(100));
    const s = getOrgCacheStats(undefined, at(100, 1000));
    expect(s.hits).toBe(1);
    // ...and never bleed into a named org's bucket.
    expect(getOrgCacheStats("org-a", at(100, 1000)).since).toBeNull();
  });
});

describe("stats registry — two-generation sliding window", () => {
  it("same generation: window counts are exact", () => {
    recordCacheAccess("org-a", true, at(100, 0));
    recordCacheAccess("org-a", false, at(100, 1000));
    // Reading at the very start of the generation: weight ≈ 1, but prev is
    // empty, so the window is exactly the current counts.
    const s = getOrgCacheStats("org-a", at(100, 2000));
    expect(s.windowTotal).toBe(2);
    expect(s.windowHitRate).toBeCloseTo(0.5, 10);
  });

  it("adjacent generation: previous hour decays linearly as the hour progresses", () => {
    // 10 hits recorded in generation 100.
    for (let i = 0; i < 10; i++) recordCacheAccess("org-a", true, at(100, i));

    // Read 25% into generation 101: weight = 0.75 → windowHits = 7.5.
    const quarter = getOrgCacheStats("org-a", at(101, WINDOW_MS * 0.25));
    expect(quarter.windowTotal).toBe(8); // round(7.5)
    expect(quarter.windowHitRate).toBeCloseTo(1, 10);

    // Read 90% into generation 101: weight = 0.1 → windowHits = 1.
    const late = getOrgCacheStats("org-a", at(101, WINDOW_MS * 0.9));
    expect(late.windowTotal).toBe(1);

    // Lifetime is untouched by rotation.
    expect(late.hits).toBe(10);
  });

  it("mixes previous-generation decay with current-generation counts", () => {
    for (let i = 0; i < 4; i++) recordCacheAccess("org-a", true, at(100, i));
    // Two misses recorded mid-way through generation 101.
    recordCacheAccess("org-a", false, at(101, WINDOW_MS * 0.5));
    recordCacheAccess("org-a", false, at(101, WINDOW_MS * 0.5));

    // Read at 50% into gen 101: weight 0.5 → windowHits = 4*0.5 = 2, windowMisses = 2.
    const s = getOrgCacheStats("org-a", at(101, WINDOW_MS * 0.5));
    expect(s.windowTotal).toBe(4);
    expect(s.windowHitRate).toBeCloseTo(0.5, 10);
  });

  it("a gap of 2+ generations empties the window entirely", () => {
    for (let i = 0; i < 10; i++) recordCacheAccess("org-a", true, at(100, i));
    const s = getOrgCacheStats("org-a", at(102, 0));
    expect(s.windowTotal).toBe(0);
    expect(s.windowHitRate).toBeNull(); // no recent activity
    expect(s.hits).toBe(10); // lifetime survives
    expect(s.hitRate).toBe(1);
  });

  it("rotation happens on record too, not just on read", () => {
    recordCacheAccess("org-a", true, at(100, 0));
    // Recording in gen 101 rotates: gen-100 counts become prev.
    recordCacheAccess("org-a", false, at(101, 0));
    const s = getOrgCacheStats("org-a", at(101, 0));
    // weight at the exact start of the hour = 1 → windowHits = 1 (prev) + 0.
    expect(s.windowTotal).toBe(2);
    expect(s.windowHitRate).toBeCloseTo(0.5, 10);
  });
});

describe("stats registry — fleet aggregation", () => {
  it("sums lifetime counts, weighted-sums windows, takes the earliest since", () => {
    recordCacheAccess("org-a", true, at(100, 1000));
    recordCacheAccess("org-a", true, at(100, 2000));
    recordCacheAccess("org-b", false, at(100, 500));
    recordCacheAccess(undefined, true, at(100, 3000));

    const fleet = getFleetCacheStats(at(100, 5000));
    expect(fleet.since).toBe(at(100, 500)); // earliest bucket
    expect(fleet.hits).toBe(3);
    expect(fleet.misses).toBe(1);
    expect(fleet.hitRate).toBeCloseTo(0.75, 10);
    expect(fleet.windowTotal).toBe(4);
  });

  it("empty registry aggregates to the warming shape", () => {
    const fleet = getFleetCacheStats(at(100));
    expect(fleet.since).toBeNull();
    expect(fleet.hitRate).toBeNull();
    expect(fleet.windowHitRate).toBeNull();
  });

  it("applies per-bucket window rotation during aggregation", () => {
    // org-a active only in gen 100; org-b active in gen 101.
    for (let i = 0; i < 10; i++) recordCacheAccess("org-a", true, at(100, i));
    recordCacheAccess("org-b", false, at(101, WINDOW_MS * 0.5));

    // At 50% into gen 101: org-a contributes 10*0.5 = 5 window hits, org-b 1 miss.
    const fleet = getFleetCacheStats(at(101, WINDOW_MS * 0.5));
    expect(fleet.windowTotal).toBe(6);
    expect(fleet.windowHitRate).toBeCloseTo(5 / 6, 10);
  });
});

describe("stats registry — lifecycle", () => {
  it("reset clears every bucket", () => {
    recordCacheAccess("org-a", true, at(100));
    resetCacheStatsRegistry();
    expect(getOrgCacheStats("org-a", at(100, 1)).since).toBeNull();
    expect(getFleetCacheStats(at(100, 1)).hits).toBe(0);
  });
});
