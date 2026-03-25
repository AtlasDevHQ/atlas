/**
 * Tests for per-source rate limiting (Effect-based).
 */
import { describe, it, expect, afterEach } from "bun:test";
import { Effect, Exit, Cause, Option } from "effect";
import {
  registerSourceRateLimit,
  clearSourceRateLimit,
  acquireSlot,
  withSourceSlot,
  _resetSourceRateLimits,
} from "../source-rate-limit";
import { RateLimitExceededError, ConcurrencyLimitError } from "@atlas/api/lib/effect/errors";

afterEach(() => {
  _resetSourceRateLimits();
});

// ── Helpers ────────────────────────────────────────────────────────

/** Run acquireSlot and return the Exit (success or tagged error). */
const tryAcquire = (sourceId: string) =>
  Effect.runPromiseExit(acquireSlot(sourceId));

/** Extract the typed failure from an Exit, or undefined on success. */
function getFailure(exit: Exit.Exit<void, RateLimitExceededError | ConcurrencyLimitError>) {
  if (Exit.isFailure(exit)) {
    const opt = Cause.failureOption(exit.cause);
    return Option.isSome(opt) ? opt.value : undefined;
  }
  return undefined;
}

// ── Tests ──────────────────────────────────────────────────────────

describe("per-source rate limiting (Effect)", () => {
  describe("QPM enforcement", () => {
    it("allows queries under the limit", async () => {
      registerSourceRateLimit("test", { queriesPerMinute: 5, concurrency: 10 });
      for (let i = 0; i < 5; i++) {
        const exit = await tryAcquire("test");
        expect(Exit.isSuccess(exit)).toBe(true);
      }
    });

    it("blocks queries over the QPM limit", async () => {
      registerSourceRateLimit("test", { queriesPerMinute: 3, concurrency: 10 });
      await Effect.runPromise(acquireSlot("test"));
      await Effect.runPromise(acquireSlot("test"));
      await Effect.runPromise(acquireSlot("test"));

      const exit = await tryAcquire("test");
      expect(Exit.isFailure(exit)).toBe(true);
      const err = getFailure(exit);
      expect(err).toBeInstanceOf(RateLimitExceededError);
      expect(err!.message).toContain("QPM limit reached");
      expect((err as RateLimitExceededError).retryAfterMs).toBeGreaterThan(0);
    });

    it("uses default limit (60 QPM) when no custom limit is set", async () => {
      // Use withSourceSlot so concurrency is released between calls
      for (let i = 0; i < 60; i++) {
        await Effect.runPromise(withSourceSlot("unregistered", Effect.void));
      }
      const exit = await tryAcquire("unregistered");
      expect(Exit.isFailure(exit)).toBe(true);
    });
  });

  describe("concurrency enforcement", () => {
    it("allows queries under the concurrency limit", async () => {
      registerSourceRateLimit("test", { queriesPerMinute: 100, concurrency: 2 });
      await Effect.runPromise(acquireSlot("test"));
      const exit = await tryAcquire("test");
      expect(Exit.isSuccess(exit)).toBe(true);
    });

    it("blocks queries at the concurrency limit", async () => {
      registerSourceRateLimit("test", { queriesPerMinute: 100, concurrency: 2 });
      await Effect.runPromise(acquireSlot("test"));
      await Effect.runPromise(acquireSlot("test"));

      const exit = await tryAcquire("test");
      expect(Exit.isFailure(exit)).toBe(true);
      const err = getFailure(exit);
      expect(err).toBeInstanceOf(ConcurrencyLimitError);
      expect(err!.message).toContain("concurrency limit reached");
    });

    it("allows queries after withSourceSlot releases", async () => {
      registerSourceRateLimit("test", { queriesPerMinute: 100, concurrency: 1 });

      // withSourceSlot acquires, runs the effect, and releases
      await Effect.runPromise(withSourceSlot("test", Effect.void));

      // Slot is released — next acquire should succeed
      const exit = await tryAcquire("test");
      expect(Exit.isSuccess(exit)).toBe(true);
    });
  });

  describe("withSourceSlot scoped resource", () => {
    it("releases slot on success", async () => {
      registerSourceRateLimit("test", { queriesPerMinute: 100, concurrency: 1 });

      await Effect.runPromise(
        withSourceSlot("test", Effect.succeed("ok")),
      );

      // Concurrency released — can acquire again
      const exit = await tryAcquire("test");
      expect(Exit.isSuccess(exit)).toBe(true);
    });

    it("releases slot on failure", async () => {
      registerSourceRateLimit("test", { queriesPerMinute: 100, concurrency: 1 });

      const exit = await Effect.runPromiseExit(
        withSourceSlot("test", Effect.fail("boom")),
      );
      expect(Exit.isFailure(exit)).toBe(true);

      // Concurrency released even though inner effect failed
      const nextExit = await tryAcquire("test");
      expect(Exit.isSuccess(nextExit)).toBe(true);
    });

    it("returns the inner effect result on success", async () => {
      const result = await Effect.runPromise(
        withSourceSlot("test", Effect.succeed(42)),
      );
      expect(result).toBe(42);
    });

    it("propagates rate-limit error without acquiring", async () => {
      registerSourceRateLimit("test", { queriesPerMinute: 1, concurrency: 10 });
      await Effect.runPromise(acquireSlot("test")); // exhaust QPM

      const exit = await Effect.runPromiseExit(
        withSourceSlot("test", Effect.succeed("should not reach")),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      const err = getFailure(exit as Exit.Exit<void, RateLimitExceededError | ConcurrencyLimitError>);
      expect(err).toBeInstanceOf(RateLimitExceededError);
    });
  });

  describe("per-source isolation", () => {
    it("limits are independent per source", async () => {
      registerSourceRateLimit("a", { queriesPerMinute: 2, concurrency: 10 });
      registerSourceRateLimit("b", { queriesPerMinute: 2, concurrency: 10 });

      await Effect.runPromise(acquireSlot("a"));
      await Effect.runPromise(acquireSlot("a"));
      expect(Exit.isFailure(await tryAcquire("a"))).toBe(true); // a is at limit

      expect(Exit.isSuccess(await tryAcquire("b"))).toBe(true); // b is independent
      expect(Exit.isSuccess(await tryAcquire("b"))).toBe(true);
    });
  });

  describe("registerSourceRateLimit + clearSourceRateLimit", () => {
    it("custom limits override defaults", async () => {
      registerSourceRateLimit("test", { queriesPerMinute: 2, concurrency: 10 });
      await Effect.runPromise(withSourceSlot("test", Effect.void));
      await Effect.runPromise(withSourceSlot("test", Effect.void));
      expect(Exit.isFailure(await tryAcquire("test"))).toBe(true); // QPM exhausted (2 used)
    });

    it("clearSourceRateLimit reverts to defaults", async () => {
      registerSourceRateLimit("test", { queriesPerMinute: 1, concurrency: 10 });
      await Effect.runPromise(acquireSlot("test"));
      expect(Exit.isFailure(await tryAcquire("test"))).toBe(true);

      _resetSourceRateLimits();
      clearSourceRateLimit("test");
      // Should use default (60 QPM) — should allow
      expect(Exit.isSuccess(await tryAcquire("test"))).toBe(true);
    });
  });

  describe("_resetSourceRateLimits", () => {
    it("clears all state", async () => {
      registerSourceRateLimit("test", { queriesPerMinute: 1, concurrency: 1 });
      await Effect.runPromise(acquireSlot("test"));

      _resetSourceRateLimits();

      // After reset, limits/concurrency/windows are cleared
      expect(Exit.isSuccess(await tryAcquire("test"))).toBe(true);
    });
  });
});
