/**
 * Per-channel rate limit + concurrency throttle for the webhook plugin.
 *
 * Each channel gets its own QPM (queries-per-minute) bucket and a concurrent
 * in-flight counter. Stale QPM timestamps are filtered lazily on read — no
 * timer needed. Conceptually borrows the acquire/release shape from
 * `packages/api/src/lib/db/source-rate-limit.ts`, but exposes a synchronous
 * `acquire(channelId, limit) -> AcquireResult` (no Effect.ts dep) so
 * @useatlas/webhook keeps its standalone npm shape. Lift to a shared module
 * once a second plugin needs it.
 */
export const RATE_LIMIT_WINDOW_MS = 60_000;

export interface ChannelRateLimit {
  readonly rateLimitRpm: number;
  readonly concurrencyLimit: number;
}

export const DEFAULT_RATE_LIMIT: ChannelRateLimit = {
  rateLimitRpm: 60,
  concurrencyLimit: 3,
};

interface ChannelState {
  timestamps: number[];
  active: number;
}

export type AcquireResult =
  | { ok: true; release: () => void }
  | { ok: false; reason: "rate"; retryAfterMs: number; limit: number }
  | { ok: false; reason: "concurrency"; limit: number };

/**
 * Try to take a slot for the channel. Returns a release callback that the
 * caller MUST invoke once the request is fully processed (success or
 * failure) — the in-flight counter only drops when the release runs.
 */
export function createChannelThrottle() {
  const states = new Map<string, ChannelState>();

  function getState(channelId: string): ChannelState {
    let s = states.get(channelId);
    if (!s) {
      s = { timestamps: [], active: 0 };
      states.set(channelId, s);
    }
    return s;
  }

  function acquire(channelId: string, limit: ChannelRateLimit): AcquireResult {
    const state = getState(channelId);
    const now = Date.now();

    if (state.active >= limit.concurrencyLimit) {
      return { ok: false, reason: "concurrency", limit: limit.concurrencyLimit };
    }

    const cutoff = now - RATE_LIMIT_WINDOW_MS;
    state.timestamps = state.timestamps.filter((t) => t > cutoff);

    if (state.timestamps.length >= limit.rateLimitRpm) {
      const oldest = state.timestamps[0] ?? now;
      const retryAfterMs = Math.max(1, oldest + RATE_LIMIT_WINDOW_MS - now);
      return { ok: false, reason: "rate", retryAfterMs, limit: limit.rateLimitRpm };
    }

    state.timestamps.push(now);
    state.active++;

    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const s = states.get(channelId);
      if (!s) return;
      s.active = Math.max(0, s.active - 1);
    };

    return { ok: true, release };
  }

  function reset() {
    states.clear();
  }

  return { acquire, reset };
}

export type ChannelThrottle = ReturnType<typeof createChannelThrottle>;
