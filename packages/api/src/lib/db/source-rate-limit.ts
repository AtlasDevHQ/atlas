/**
 * Per-source rate limiting for multi-database deployments.
 *
 * Enforces QPM (queries per minute) and concurrency limits per datasource.
 * Stale QPM entries are filtered on read — no periodic cleanup timer needed.
 *
 * Primary API: {@link withSourceSlot} acquires a slot, runs the effect, and
 * releases the slot on completion (success or failure). Callers never need
 * to manually decrement concurrency.
 */

import { Effect } from "effect";
import { RateLimitExceededError, ConcurrencyLimitError } from "@atlas/api/lib/effect/errors";
import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("source-rate-limit");
const WINDOW_MS = 60_000;

export interface SourceRateLimit {
  readonly queriesPerMinute: number;
  readonly concurrency: number;
}

const DEFAULT_LIMIT: SourceRateLimit = {
  queriesPerMinute: 60,
  concurrency: 5,
};

// ── State ──────────────────────────────────────────────────────────

interface SourceState {
  timestamps: number[];
  active: number;
}

const limits = new Map<string, SourceRateLimit>();
const states = new Map<string, SourceState>();

function getLimit(id: string): SourceRateLimit {
  return limits.get(id) ?? DEFAULT_LIMIT;
}

function getState(id: string): SourceState {
  let s = states.get(id);
  if (!s) {
    s = { timestamps: [], active: 0 };
    states.set(id, s);
  }
  return s;
}

// ── Config ─────────────────────────────────────────────────────────

/** Register a custom rate limit for a datasource. */
export function registerSourceRateLimit(id: string, limit: SourceRateLimit): void {
  if (!Number.isInteger(limit.queriesPerMinute) || limit.queriesPerMinute < 1) {
    throw new Error(`queriesPerMinute must be a positive integer, got ${limit.queriesPerMinute}`);
  }
  if (!Number.isInteger(limit.concurrency) || limit.concurrency < 1) {
    throw new Error(`concurrency must be a positive integer, got ${limit.concurrency}`);
  }
  limits.set(id, limit);
}

/** Remove a custom rate limit for a datasource. */
export function clearSourceRateLimit(id: string): void {
  limits.delete(id);
}

// ── Effect API ─────────────────────────────────────────────────────

/**
 * Acquire a rate-limit slot: check QPM + concurrency, record timestamp,
 * increment concurrency counter. Fails with tagged errors.
 */
export const acquireSlot = (
  sourceId: string,
): Effect.Effect<void, RateLimitExceededError | ConcurrencyLimitError> =>
  Effect.gen(function* () {
    const limit = getLimit(sourceId);
    const state = getState(sourceId);
    const now = Date.now();

    // Check concurrency first
    if (state.active >= limit.concurrency) {
      return yield* new ConcurrencyLimitError({
        message: `Source "${sourceId}" concurrency limit reached (${limit.concurrency})`,
        sourceId,
        limit: limit.concurrency,
      });
    }

    // Filter stale QPM timestamps (replaces setInterval cleanup)
    const cutoff = now - WINDOW_MS;
    state.timestamps = state.timestamps.filter((t) => t > cutoff);

    if (state.timestamps.length >= limit.queriesPerMinute) {
      const retryAfterMs = Math.max(1, state.timestamps[0] + WINDOW_MS - now);
      return yield* new RateLimitExceededError({
        message: `Source "${sourceId}" QPM limit reached (${limit.queriesPerMinute}/min)`,
        sourceId,
        limit: limit.queriesPerMinute,
        retryAfterMs,
      });
    }

    // Atomically record QPM timestamp AND increment concurrency
    state.timestamps.push(now);
    state.active++;
  });

/**
 * Run an effect inside a rate-limit slot. The slot is released on completion
 * (success or failure) — callers never need to manually decrement.
 */
export const withSourceSlot = <A, E>(
  sourceId: string,
  effect: Effect.Effect<A, E>,
): Effect.Effect<A, E | RateLimitExceededError | ConcurrencyLimitError> =>
  Effect.acquireUseRelease(
    acquireSlot(sourceId),
    () => effect,
    () =>
      Effect.sync(() => {
        const state = states.get(sourceId);
        if (state) {
          if (state.active <= 0) {
            log.warn({ sourceId, active: state.active }, "Rate limit slot double-release detected — active count already zero");
          }
          state.active = Math.max(0, state.active - 1);
        }
      }),
  );

// ── Test helpers ───────────────────────────────────────────────────

/** Reset all state. For tests. */
export function _resetSourceRateLimits(): void {
  limits.clear();
  states.clear();
}
