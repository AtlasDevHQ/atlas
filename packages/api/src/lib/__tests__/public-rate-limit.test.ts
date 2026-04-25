/**
 * F-73 — public-share rate limiter unit tests.
 *
 * Pins the bug fix: without `ATLAS_TRUST_PROXY`, `getClientIP` returns
 * null and the previous limiter used `unknown-${requestId}` — a fresh
 * UUID per request — as the bucket key. Every request landed in its own
 * bucket and the limit returned `true` indefinitely. The shared
 * limiter buckets all anonymous traffic into a single
 * `__public_unknown__` key with a small ceiling.
 */

import { describe, it, expect } from "bun:test";
import {
  createPublicRateLimiter,
  PUBLIC_RATE_LIMIT_CONSTANTS,
} from "../public-rate-limit";

describe("createPublicRateLimiter", () => {
  it("buckets per IP independently when an IP is present", () => {
    const limiter = createPublicRateLimiter({ maxRpm: 3 });
    expect(limiter.check("1.1.1.1")).toBe(true);
    expect(limiter.check("1.1.1.1")).toBe(true);
    expect(limiter.check("1.1.1.1")).toBe(true);
    expect(limiter.check("1.1.1.1")).toBe(false);
    // Different IP has its own bucket
    expect(limiter.check("2.2.2.2")).toBe(true);
  });

  // F-73 regression: an IP-less request flow must not silently bypass.
  it("buckets every IP-less request into a single shared key (F-73 fix)", () => {
    const limiter = createPublicRateLimiter({ maxRpm: 60 });
    // Anonymous ceiling defaults to ANON_FALLBACK_MAX_RPM (10), capped to maxRpm.
    const ceiling = PUBLIC_RATE_LIMIT_CONSTANTS.ANON_FALLBACK_MAX_RPM;
    for (let i = 0; i < ceiling; i++) {
      expect(limiter.check(null)).toBe(true);
    }
    // ceiling+1 must be rejected — the broken implementation returned true
    // here because the unique requestId fallback gave each request its own
    // bucket.
    expect(limiter.check(null)).toBe(false);
  });

  it("anonymous fallback uses min(maxRpm, ANON_FALLBACK_MAX_RPM)", () => {
    // When the per-IP limit is below the anonymous default, the anon
    // bucket should not exceed the per-IP limit.
    const limiter = createPublicRateLimiter({ maxRpm: 3 });
    expect(limiter.check(null)).toBe(true);
    expect(limiter.check(null)).toBe(true);
    expect(limiter.check(null)).toBe(true);
    expect(limiter.check(null)).toBe(false);
  });

  it("anonymous fallback bucket is independent of per-IP buckets", () => {
    const limiter = createPublicRateLimiter({ maxRpm: 10 });
    // Burn through the anonymous ceiling (10).
    for (let i = 0; i < 10; i++) {
      expect(limiter.check(null)).toBe(true);
    }
    expect(limiter.check(null)).toBe(false);
    // Per-IP buckets still allow.
    expect(limiter.check("9.9.9.9")).toBe(true);
  });

  it("cleanup() drops expired buckets", () => {
    const limiter = createPublicRateLimiter({ maxRpm: 1 });
    expect(limiter.check("1.1.1.1")).toBe(true);
    expect(limiter.check("1.1.1.1")).toBe(false);
    const originalNow = Date.now;
    Date.now = () => originalNow() + 61_000;
    try {
      limiter.cleanup();
      // After window expiry the bucket is gone — first call after cleanup
      // creates a fresh window.
      expect(limiter.check("1.1.1.1")).toBe(true);
    } finally {
      Date.now = originalNow;
    }
  });

  it("reset() clears all bucket state", () => {
    const limiter = createPublicRateLimiter({ maxRpm: 1 });
    expect(limiter.check("1.1.1.1")).toBe(true);
    expect(limiter.check("1.1.1.1")).toBe(false);
    limiter.reset();
    expect(limiter.check("1.1.1.1")).toBe(true);
  });

  it("expired window resets the bucket", () => {
    const limiter = createPublicRateLimiter({ maxRpm: 2 });
    expect(limiter.check("1.1.1.1")).toBe(true);
    expect(limiter.check("1.1.1.1")).toBe(true);
    expect(limiter.check("1.1.1.1")).toBe(false);
    const originalNow = Date.now;
    Date.now = () => originalNow() + 61_000;
    try {
      // Past the WINDOW_MS — first call after expiry seeds a fresh window.
      expect(limiter.check("1.1.1.1")).toBe(true);
    } finally {
      Date.now = originalNow;
    }
  });
});
