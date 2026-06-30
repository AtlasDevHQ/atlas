/**
 * Sliding-window rate limiter with a swappable store (#4129).
 *
 * Consolidates the three byte-for-byte-identical Map-of-timestamps sliding
 * windows that v0.0.19 grew on the unauthenticated public surface
 * (`lib/trial-abuse.ts` per-IP + per-email, `lib/contact.ts` per-IP,
 * `lib/demo.ts` per-email) into ONE limiter behind a store interface.
 *
 * The window *algorithm* lives here once; the *storage* is pluggable via
 * {@link SlidingWindowStore}. The only adapter that ships today is the
 * per-process {@link createInMemorySlidingWindowStore}; a Redis adapter is a
 * drop-in follow-up (see the seam note below).
 *
 * ── The multi-instance limitation (the reason this seam exists) ──────────────
 * The in-memory adapter holds its window in a per-process `Map`, and each
 * regional API service is an independent process that scales to N replicas
 * under load (today the regions are US / EU / APAC). So a per-IP cap of R RPM
 * is really enforced as `R × replicas-per-region` within a region and is
 * fragmented across regions entirely — the effective ceiling on exactly the
 * unauthenticated trial / demo / contact surface you'd scale under launch load
 * is `R × (total replicas across all regions)`. This is LATENT at one replica
 * per region but activates on any horizontal scale-up.
 *
 * The fix is a process-external store. Because every {@link SlidingWindowStore}
 * method is async, a Redis adapter (a sorted set per key: `ZADD` to record,
 * `ZREMRANGEBYSCORE` + `ZCARD` to read, per-key TTL for eviction) is a drop-in
 * that makes the window shared across replicas AND regions WITHOUT touching any
 * call site — the limiter, `trial-abuse.ts`, `contact.ts`, `demo.ts`, and their
 * routes already `await`. That Redis adapter is a not-yet-filed follow-up
 * (parent umbrella #3801; this seam landed in #4129); until it lands, the
 * fragmentation above stands.
 *
 * Note on atomicity: a check spans `await`s (read, then record). With the
 * in-memory adapter those awaits do NO real I/O and resolve on the microtask
 * queue, which drains fully before the next request's macrotask — so one
 * request's read→record pair completes before another request's check begins.
 * The pair is therefore effectively atomic per process, preserving the
 * synchronous originals' behavior (single-threaded-ness alone would NOT
 * guarantee this — the load-bearing property is the absence of a real I/O
 * suspension between read and record). A networked adapter (Redis) introduces
 * exactly that suspension, so concurrent same-key requests can interleave and
 * admit a few past the cap. That race is acceptable for abuse control (a
 * handful of extra requests slipping a burst window is not a security boundary)
 * and can be tightened later with a Lua script — it is NOT a reason to keep the
 * store in-process.
 */

/** The window every public-surface limiter uses: one minute. */
export const RATE_LIMIT_WINDOW_MS = 60_000;

/** A non-recording snapshot of a key's live window. */
export interface WindowSnapshot {
  /** Count of attempts still within `[now - windowMs, now]` after eviction. */
  readonly count: number;
  /** Oldest surviving timestamp (ms), or `undefined` when the window is empty. */
  readonly oldest: number | undefined;
}

/**
 * Storage backing a sliding window. Every method is async so a process-external
 * adapter (Redis) is a drop-in for {@link createInMemorySlidingWindowStore}
 * without changing the limiter or any call site.
 *
 * Keys are opaque strings — the caller owns key derivation (IP, lowercased
 * email, hashed user id) so distinct logical buckets never collide.
 */
export interface SlidingWindowStore {
  /**
   * Evict timestamps older than `now - windowMs` for `key`, then return the
   * surviving {@link WindowSnapshot}. Non-recording: it never adds the current
   * attempt, so a caller can check several windows and commit to none.
   */
  read(key: string, windowMs: number, now: number): Promise<WindowSnapshot>;
  /** Record an attempt timestamp for `key`. */
  append(key: string, timestamp: number): Promise<void>;
  /** Evict every key whose window is fully stale (periodic memory reclaim). */
  evictStale(windowMs: number, now: number): Promise<void>;
  /** Drop all state. Test helper / window-reset simulation. */
  clear(): Promise<void>;
}

/**
 * Outcome of a window check. Discriminated on `allowed` so `retryAfterMs` is
 * present IFF blocked — a `{ allowed: true }` can't carry a stray retry, and a
 * consumer that branches on `!allowed` reads `retryAfterMs` without a fallback
 * or a non-null assertion.
 */
export type RateLimitDecision =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      /** Milliseconds until the window frees a slot. */
      readonly retryAfterMs: number;
    };

/**
 * A sliding-window limiter over a {@link SlidingWindowStore}. `limit` is passed
 * per call (not fixed at construction) so a hot-reloadable, settings-backed RPM
 * is read fresh by the caller each time. `limit === 0` disables the bucket:
 * always allowed, never recorded, never touches the store.
 */
export interface SlidingWindowLimiter {
  /**
   * Non-mutating check — evicts stale entries and reports the decision but does
   * NOT record. Lets a caller gate on several windows and record only once all
   * pass (the per-IP + per-email trial pattern), so a bucket that passes is not
   * charged for an attempt a later bucket blocks. Pass an explicit shared `now`
   * across a multi-window check.
   */
  peek(key: string, limit: number, now?: number): Promise<RateLimitDecision>;
  /** Record an attempt. No-op when `limit === 0`. */
  record(key: string, limit: number, now?: number): Promise<void>;
  /** {@link peek} then {@link record} iff allowed — the single-bucket path. */
  check(key: string, limit: number, now?: number): Promise<RateLimitDecision>;
  /** Evict fully-stale keys. Called periodically by the SchedulerLayer fiber. */
  cleanup(now?: number): Promise<void>;
  /** Drop all state. Test helper / window-reset simulation. */
  reset(): Promise<void>;
}

/**
 * Per-process in-memory store: a `Map` of key → ascending attempt timestamps.
 * Eviction is a single in-place pass (the shape every call site already used).
 * This is the only adapter that ships today — see the multi-instance note at
 * the top of the file for why a Redis adapter is the eventual replacement.
 */
export function createInMemorySlidingWindowStore(): SlidingWindowStore {
  const windows = new Map<string, number[]>();

  function bucket(key: string): number[] {
    let timestamps = windows.get(key);
    if (!timestamps) {
      timestamps = [];
      windows.set(key, timestamps);
    }
    return timestamps;
  }

  return {
    async read(key, windowMs, now) {
      const cutoff = now - windowMs;
      const timestamps = bucket(key);
      // Evict stale entries in place (single pass — they're ascending).
      const firstValid = timestamps.findIndex((t) => t > cutoff);
      if (firstValid > 0) timestamps.splice(0, firstValid);
      else if (firstValid === -1) timestamps.length = 0;
      return { count: timestamps.length, oldest: timestamps[0] };
    },
    async append(key, timestamp) {
      bucket(key).push(timestamp);
    },
    async evictStale(windowMs, now) {
      const cutoff = now - windowMs;
      for (const [key, timestamps] of windows) {
        if (timestamps.length === 0 || timestamps[timestamps.length - 1]! <= cutoff) {
          windows.delete(key);
        }
      }
    },
    async clear() {
      windows.clear();
    },
  } satisfies SlidingWindowStore;
}

/**
 * Build a {@link SlidingWindowLimiter}. Defaults to a fresh in-memory store and
 * the one-minute {@link RATE_LIMIT_WINDOW_MS} window; pass `store` to swap in a
 * process-external adapter (the Redis follow-up) with no other change.
 */
export function createSlidingWindowLimiter(opts?: {
  store?: SlidingWindowStore;
  windowMs?: number;
}): SlidingWindowLimiter {
  const store = opts?.store ?? createInMemorySlidingWindowStore();
  const windowMs = opts?.windowMs ?? RATE_LIMIT_WINDOW_MS;

  async function peek(key: string, limit: number, now = Date.now()): Promise<RateLimitDecision> {
    if (limit === 0) return { allowed: true };
    const { count, oldest } = await store.read(key, windowMs, now);
    if (count < limit) return { allowed: true };
    // count >= limit >= 1 here, so `oldest` is defined; `?? now` is defensive.
    const retryAfterMs = Math.max(1, (oldest ?? now) + windowMs - now);
    return { allowed: false, retryAfterMs };
  }

  async function record(key: string, limit: number, now = Date.now()): Promise<void> {
    if (limit === 0) return;
    await store.append(key, now);
  }

  return {
    peek,
    record,
    async check(key, limit, now = Date.now()) {
      const decision = await peek(key, limit, now);
      if (decision.allowed) await record(key, limit, now);
      return decision;
    },
    cleanup: (now = Date.now()) => store.evictStale(windowMs, now),
    reset: () => store.clear(),
  } satisfies SlidingWindowLimiter;
}
