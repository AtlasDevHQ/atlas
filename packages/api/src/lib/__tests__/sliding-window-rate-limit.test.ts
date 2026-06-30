/**
 * Sliding-window limiter tests (#4129).
 *
 * The window logic is asserted against the {@link SlidingWindowStore}
 * INTERFACE, not the concrete in-memory `Map`: every case runs over two
 * conforming stores — the shipped in-memory adapter and a second, deliberately
 * Map-free `Record`-backed store defined here. If the limiter ever reached
 * past the interface into Map internals, the second store would fail. This is
 * the executable proof that the Redis adapter (the follow-up) is a drop-in.
 *
 * Scope note: both stores here resolve their `await`s synchronously, so this
 * suite proves STRUCTURAL swappability, not behavior under interleaved
 * concurrent awaits. The in-memory adapter is effectively atomic per process
 * (see the module's atomicity note); a networked adapter has a read/record
 * race. When the Redis adapter lands (#3801), it must ship with a test that
 * interleaves two concurrent `check()`s on one key — the suite below would pass
 * a racy adapter.
 */
import { describe, test, expect } from "bun:test";
import {
  createSlidingWindowLimiter,
  createInMemorySlidingWindowStore,
  type SlidingWindowStore,
  type WindowSnapshot,
} from "../sliding-window-rate-limit";

/**
 * A second conforming store with NO `Map` — keyed by a plain object — so the
 * suite proves the limiter speaks only the interface. Mirrors the in-memory
 * adapter's eviction semantics.
 */
function createRecordSlidingWindowStore(): SlidingWindowStore {
  const windows: Record<string, number[]> = Object.create(null);
  const bucket = (key: string): number[] => (windows[key] ??= []);
  return {
    async read(key, windowMs, now): Promise<WindowSnapshot> {
      const cutoff = now - windowMs;
      const live = bucket(key).filter((t) => t > cutoff);
      windows[key] = live;
      return { count: live.length, oldest: live[0] };
    },
    async append(key, timestamp) {
      bucket(key).push(timestamp);
    },
    async evictStale(windowMs, now) {
      const cutoff = now - windowMs;
      for (const key of Object.keys(windows)) {
        const ts = windows[key]!;
        if (ts.length === 0 || ts[ts.length - 1]! <= cutoff) delete windows[key];
      }
    },
    async clear() {
      for (const key of Object.keys(windows)) delete windows[key];
    },
  };
}

const STORES: ReadonlyArray<readonly [string, () => SlidingWindowStore]> = [
  ["in-memory (shipped)", createInMemorySlidingWindowStore],
  ["record-backed (interface proof)", createRecordSlidingWindowStore],
];

const WINDOW = 60_000;

for (const [name, makeStore] of STORES) {
  describe(`SlidingWindowLimiter over ${name}`, () => {
    const make = () => createSlidingWindowLimiter({ store: makeStore(), windowMs: WINDOW });

    test("allows up to the limit, then blocks with retry guidance", async () => {
      const limiter = make();
      const t0 = 1_000_000;
      expect((await limiter.check("k", 3, t0)).allowed).toBe(true);
      expect((await limiter.check("k", 3, t0 + 1)).allowed).toBe(true);
      expect((await limiter.check("k", 3, t0 + 2)).allowed).toBe(true);
      const blocked = await limiter.check("k", 3, t0 + 3);
      expect(blocked.allowed).toBe(false);
      if (blocked.allowed) throw new Error("unreachable: expected a blocked decision");
      // First of three timestamps was at t0; it frees one window later.
      expect(blocked.retryAfterMs).toBe(t0 + WINDOW - (t0 + 3));
    });

    test("retryAfterMs floors at 1ms at the last instant of the window", async () => {
      const limiter = make();
      const t0 = 1_500_000;
      expect((await limiter.check("k", 1, t0)).allowed).toBe(true);
      // One ms before the recorded attempt ages out: still blocked, retry = 1ms
      // (the Math.max(1, …) floor — the smallest non-zero retry the window emits).
      const blocked = await limiter.check("k", 1, t0 + WINDOW - 1);
      expect(blocked.allowed).toBe(false);
      if (blocked.allowed) throw new Error("unreachable: expected a blocked decision");
      expect(blocked.retryAfterMs).toBe(1);
    });

    test("peek is non-recording — it never consumes budget", async () => {
      const limiter = make();
      const t0 = 2_000_000;
      // Peek many times under a limit of 1; none of them record.
      for (let i = 0; i < 5; i++) {
        expect((await limiter.peek("k", 1, t0)).allowed).toBe(true);
      }
      // The single real slot is still free.
      expect((await limiter.check("k", 1, t0)).allowed).toBe(true);
      expect((await limiter.check("k", 1, t0)).allowed).toBe(false);
    });

    test("a blocked check does not record (caller recovers on schedule)", async () => {
      const limiter = make();
      const t0 = 3_000_000;
      expect((await limiter.check("k", 1, t0)).allowed).toBe(true);
      // Blocked — must not extend the window by recording itself.
      expect((await limiter.check("k", 1, t0 + 10)).allowed).toBe(false);
      // One window after the FIRST (only) recorded attempt, the slot frees.
      expect((await limiter.check("k", 1, t0 + WINDOW)).allowed).toBe(true);
    });

    test("sliding window: stale timestamps free slots", async () => {
      const limiter = make();
      const t0 = 4_000_000;
      expect((await limiter.check("k", 1, t0)).allowed).toBe(true);
      expect((await limiter.check("k", 1, t0 + 1)).allowed).toBe(false);
      // The first attempt ages out exactly one window later.
      expect((await limiter.check("k", 1, t0 + WINDOW + 1)).allowed).toBe(true);
    });

    test("distinct keys keep independent budgets", async () => {
      const limiter = make();
      const t0 = 5_000_000;
      expect((await limiter.check("a", 1, t0)).allowed).toBe(true);
      expect((await limiter.check("a", 1, t0)).allowed).toBe(false);
      expect((await limiter.check("b", 1, t0)).allowed).toBe(true);
    });

    test("limit 0 disables the bucket and never records", async () => {
      const store = makeStore();
      const limiter = createSlidingWindowLimiter({ store, windowMs: WINDOW });
      const t0 = 6_000_000;
      for (let i = 0; i < 50; i++) {
        expect((await limiter.check("k", 0, t0)).allowed).toBe(true);
      }
      // Nothing was recorded — the store still reports an empty window.
      expect((await store.read("k", WINDOW, t0)).count).toBe(0);
    });

    test("cleanup evicts fully-stale keys; reset frees everything", async () => {
      const limiter = make();
      const t0 = 7_000_000;
      await limiter.check("stale", 5, t0);
      await limiter.check("fresh", 5, t0 + WINDOW);
      // One window past `stale`'s only attempt → it is fully stale; `fresh` isn't.
      await limiter.cleanup(t0 + WINDOW);
      // (Eviction is a memory-reclaim concern; behavior is unchanged either way,
      //  but a fresh key keeps its budget and a stale key is reclaimable.)
      expect((await limiter.check("fresh", 1, t0 + WINDOW)).allowed).toBe(false);

      await limiter.reset();
      expect((await limiter.check("fresh", 1, t0 + WINDOW)).allowed).toBe(true);
    });
  });
}
