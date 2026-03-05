/**
 * Tests for per-source rate limiting.
 */
import { describe, it, expect, afterEach } from "bun:test";
import {
  checkSourceRateLimit,
  registerSourceRateLimit,
  clearSourceRateLimit,
  incrementSourceConcurrency,
  decrementSourceConcurrency,
  _resetSourceRateLimits,
  _stopSourceRateLimitCleanup,
} from "../source-rate-limit";

afterEach(() => {
  _resetSourceRateLimits();
});

// Stop cleanup timer so it doesn't keep test runner alive
afterEach(() => {
  _stopSourceRateLimitCleanup();
});

describe("per-source rate limiting", () => {
  describe("QPM enforcement", () => {
    it("allows queries under the limit", () => {
      registerSourceRateLimit("test", { queriesPerMinute: 5, concurrency: 10 });
      for (let i = 0; i < 5; i++) {
        expect(checkSourceRateLimit("test").allowed).toBe(true);
      }
    });

    it("blocks queries over the QPM limit", () => {
      registerSourceRateLimit("test", { queriesPerMinute: 3, concurrency: 10 });
      expect(checkSourceRateLimit("test").allowed).toBe(true);
      expect(checkSourceRateLimit("test").allowed).toBe(true);
      expect(checkSourceRateLimit("test").allowed).toBe(true);
      const result = checkSourceRateLimit("test");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("QPM limit reached");
      expect(result.retryAfterMs).toBeGreaterThan(0);
    });

    it("uses default limit (60 QPM) when no custom limit is set", () => {
      for (let i = 0; i < 60; i++) {
        expect(checkSourceRateLimit("unregistered").allowed).toBe(true);
      }
      expect(checkSourceRateLimit("unregistered").allowed).toBe(false);
    });
  });

  describe("concurrency enforcement", () => {
    it("allows queries under the concurrency limit", () => {
      registerSourceRateLimit("test", { queriesPerMinute: 100, concurrency: 2 });
      incrementSourceConcurrency("test");
      expect(checkSourceRateLimit("test").allowed).toBe(true);
    });

    it("blocks queries at the concurrency limit", () => {
      registerSourceRateLimit("test", { queriesPerMinute: 100, concurrency: 2 });
      incrementSourceConcurrency("test");
      incrementSourceConcurrency("test");
      const result = checkSourceRateLimit("test");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("concurrency limit reached");
    });

    it("allows queries after decrementing concurrency", () => {
      registerSourceRateLimit("test", { queriesPerMinute: 100, concurrency: 1 });
      incrementSourceConcurrency("test");
      expect(checkSourceRateLimit("test").allowed).toBe(false);
      decrementSourceConcurrency("test");
      expect(checkSourceRateLimit("test").allowed).toBe(true);
    });

    it("concurrency does not go below zero", () => {
      decrementSourceConcurrency("test");
      decrementSourceConcurrency("test");
      // Should not throw, count stays at 0
      expect(checkSourceRateLimit("test").allowed).toBe(true);
    });
  });

  describe("per-source isolation", () => {
    it("limits are independent per source", () => {
      registerSourceRateLimit("a", { queriesPerMinute: 2, concurrency: 10 });
      registerSourceRateLimit("b", { queriesPerMinute: 2, concurrency: 10 });

      expect(checkSourceRateLimit("a").allowed).toBe(true);
      expect(checkSourceRateLimit("a").allowed).toBe(true);
      expect(checkSourceRateLimit("a").allowed).toBe(false); // a is at limit

      expect(checkSourceRateLimit("b").allowed).toBe(true); // b is independent
      expect(checkSourceRateLimit("b").allowed).toBe(true);
    });
  });

  describe("registerSourceRateLimit + clearSourceRateLimit", () => {
    it("custom limits override defaults", () => {
      registerSourceRateLimit("test", { queriesPerMinute: 2, concurrency: 1 });
      expect(checkSourceRateLimit("test").allowed).toBe(true);
      expect(checkSourceRateLimit("test").allowed).toBe(true);
      expect(checkSourceRateLimit("test").allowed).toBe(false);
    });

    it("clearSourceRateLimit reverts to defaults", () => {
      registerSourceRateLimit("test", { queriesPerMinute: 1, concurrency: 10 });
      expect(checkSourceRateLimit("test").allowed).toBe(true);
      expect(checkSourceRateLimit("test").allowed).toBe(false);

      _resetSourceRateLimits();
      clearSourceRateLimit("test");
      // Should use default (60 QPM) — should allow
      expect(checkSourceRateLimit("test").allowed).toBe(true);
    });
  });

  describe("_resetSourceRateLimits", () => {
    it("clears all state", () => {
      registerSourceRateLimit("test", { queriesPerMinute: 1, concurrency: 1 });
      incrementSourceConcurrency("test");
      checkSourceRateLimit("test");

      _resetSourceRateLimits();

      // After reset, limits/concurrency/windows are cleared
      expect(checkSourceRateLimit("test").allowed).toBe(true);
    });
  });
});
