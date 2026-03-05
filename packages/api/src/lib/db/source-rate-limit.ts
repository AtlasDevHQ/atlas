/**
 * Per-source rate limiting for multi-database deployments.
 *
 * Enforces QPM (queries per minute) and concurrency limits per datasource.
 * Uses a sliding-window pattern for QPM tracking.
 */

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

/** Per-source config overrides. */
const limits = new Map<string, SourceRateLimit>();

/** Per-source sliding window of request timestamps. */
const windows = new Map<string, number[]>();

/** Per-source current concurrency count. */
const concurrency = new Map<string, number>();

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

function getLimit(id: string): SourceRateLimit {
  return limits.get(id) ?? DEFAULT_LIMIT;
}

export function checkSourceRateLimit(sourceId: string): {
  allowed: boolean;
  reason?: string;
  retryAfterMs?: number;
} {
  const limit = getLimit(sourceId);

  // Check concurrency first
  const current = concurrency.get(sourceId) ?? 0;
  if (current >= limit.concurrency) {
    return {
      allowed: false,
      reason: `Source "${sourceId}" concurrency limit reached (${limit.concurrency})`,
    };
  }

  // Check QPM
  const now = Date.now();
  const cutoff = now - WINDOW_MS;

  let timestamps = windows.get(sourceId);
  if (!timestamps) {
    timestamps = [];
    windows.set(sourceId, timestamps);
  }

  // Evict stale entries
  const firstValid = timestamps.findIndex((t) => t > cutoff);
  if (firstValid > 0) timestamps.splice(0, firstValid);
  else if (firstValid === -1) timestamps.length = 0;

  if (timestamps.length >= limit.queriesPerMinute) {
    const retryAfterMs = Math.max(1, timestamps[0] + WINDOW_MS - now);
    return {
      allowed: false,
      reason: `Source "${sourceId}" QPM limit reached (${limit.queriesPerMinute}/min)`,
      retryAfterMs,
    };
  }

  timestamps.push(now);
  return { allowed: true };
}

/**
 * Atomic check-and-acquire: checks both QPM and concurrency limits, and if
 * allowed, atomically records the QPM timestamp AND increments the concurrency
 * counter. This prevents the TOCTOU race where two concurrent requests both
 * pass the concurrency check before either increments.
 *
 * Callers MUST call `decrementSourceConcurrency()` in a `finally` block after
 * the query completes (success or failure).
 */
export function acquireSourceSlot(sourceId: string): {
  acquired: boolean;
  reason?: string;
  retryAfterMs?: number;
} {
  const limit = getLimit(sourceId);

  // Check concurrency first
  const current = concurrency.get(sourceId) ?? 0;
  if (current >= limit.concurrency) {
    return {
      acquired: false,
      reason: `Source "${sourceId}" concurrency limit reached (${limit.concurrency})`,
    };
  }

  // Check QPM
  const now = Date.now();
  const cutoff = now - WINDOW_MS;

  let timestamps = windows.get(sourceId);
  if (!timestamps) {
    timestamps = [];
    windows.set(sourceId, timestamps);
  }

  // Evict stale entries
  const firstValid = timestamps.findIndex((t) => t > cutoff);
  if (firstValid > 0) timestamps.splice(0, firstValid);
  else if (firstValid === -1) timestamps.length = 0;

  if (timestamps.length >= limit.queriesPerMinute) {
    const retryAfterMs = Math.max(1, timestamps[0] + WINDOW_MS - now);
    return {
      acquired: false,
      reason: `Source "${sourceId}" QPM limit reached (${limit.queriesPerMinute}/min)`,
      retryAfterMs,
    };
  }

  // Atomically record QPM timestamp AND increment concurrency
  timestamps.push(now);
  concurrency.set(sourceId, current + 1);
  return { acquired: true };
}

/** Increment concurrency counter before query execution. */
export function incrementSourceConcurrency(sourceId: string): void {
  concurrency.set(sourceId, (concurrency.get(sourceId) ?? 0) + 1);
}

/** Decrement concurrency counter after query execution. */
export function decrementSourceConcurrency(sourceId: string): void {
  const current = concurrency.get(sourceId) ?? 0;
  concurrency.set(sourceId, Math.max(0, current - 1));
}

/** Periodic cleanup — evict stale QPM windows. */
const cleanupInterval = setInterval(() => {
  try {
    const cutoff = Date.now() - WINDOW_MS;
    for (const [key, timestamps] of windows) {
      if (timestamps.length === 0 || timestamps[timestamps.length - 1] <= cutoff) {
        windows.delete(key);
      }
    }
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err : new Error(String(err)) },
      "Source rate limit cleanup failed",
    );
  }
}, WINDOW_MS);
cleanupInterval.unref();

/** Stop the periodic cleanup timer. For tests. */
export function _stopSourceRateLimitCleanup(): void {
  clearInterval(cleanupInterval);
}

/** Reset all state. For tests. */
export function _resetSourceRateLimits(): void {
  limits.clear();
  windows.clear();
  concurrency.clear();
}
