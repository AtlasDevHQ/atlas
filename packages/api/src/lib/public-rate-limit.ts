/**
 * Public-share rate limiter — small in-memory sliding-window limiter for
 * unauthenticated routes (`/api/public/conversations/:token`,
 * `/api/public/dashboards/:token`).
 *
 * Per-IP buckets when `ATLAS_TRUST_PROXY` is set and a client IP can be
 * resolved; a shared `__public_unknown__` bucket otherwise. The shared
 * bucket has a small ceiling (default 10/min) so a missing trust-proxy
 * config can no longer silently disable the limit (F-73).
 *
 * The previous per-route limiters used `unknown-${requestId}` as the
 * fallback key — `requestId` is a fresh UUID on every request, so each
 * call landed in its own bucket and the limit returned `true`
 * indefinitely. The fix is to bucket every IP-less request into a single
 * key with a low ceiling.
 */

import { createLogger } from "@atlas/api/lib/logger";

const WINDOW_MS = 60_000;

/**
 * Bucket key for IP-less requests when `ATLAS_TRUST_PROXY` is unset
 * (no canonical client-IP header is trusted, so we cannot per-IP bucket).
 */
const ANON_FALLBACK_KEY = "__public_unknown__";

/** Default ceiling for the anonymous fallback bucket (requests / minute). */
const ANON_FALLBACK_MAX_RPM = 10;

interface BucketState {
  count: number;
  resetAt: number;
}

export interface PublicRateLimiter {
  /**
   * Return `true` when the request should proceed, `false` when the bucket
   * is exhausted. Pass `null` for `ip` when the route layer could not
   * resolve a canonical client IP — the call lands in the shared
   * fallback bucket.
   */
  check(ip: string | null): boolean;
  /** Evict expired entries — called periodically by the SchedulerLayer fiber. */
  cleanup(): void;
  /** Test helper: drop all bucket state. */
  reset(): void;
}

export interface PublicRateLimiterOptions {
  /** Ceiling per IP per minute. Anonymous fallback uses
   *  `min(maxRpm, ANON_FALLBACK_MAX_RPM)`. */
  maxRpm: number;
}

export function createPublicRateLimiter(
  opts: PublicRateLimiterOptions,
): PublicRateLimiter {
  const buckets = new Map<string, BucketState>();
  const anonLimit = Math.min(opts.maxRpm, ANON_FALLBACK_MAX_RPM);

  return {
    check(ip) {
      const key = ip ?? ANON_FALLBACK_KEY;
      const limit = ip ? opts.maxRpm : anonLimit;
      const now = Date.now();
      const entry = buckets.get(key);
      if (!entry || now > entry.resetAt) {
        buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
        return true;
      }
      entry.count++;
      return entry.count <= limit;
    },
    cleanup() {
      const now = Date.now();
      for (const [key, entry] of buckets) {
        if (now > entry.resetAt) buckets.delete(key);
      }
    },
    reset() {
      buckets.clear();
    },
  };
}

/**
 * Operator-visible warning fired once per process when a public-share
 * route is registered and `ATLAS_TRUST_PROXY` is unset. Self-hosted
 * operators behind a reverse proxy that adds canonical IP headers will
 * silently fall back to the anonymous bucket without this hint.
 *
 * Logger is resolved lazily so test files that `mock.module(...logger)` and
 * import this module as a transitive dependency still capture the warning.
 */
let warnedTrustProxyOnce = false;
export function warnIfTrustProxyMissingForPublicShare(): void {
  if (warnedTrustProxyOnce) return;
  const v = process.env.ATLAS_TRUST_PROXY;
  if (v === "true" || v === "1") return;
  warnedTrustProxyOnce = true;
  const log = createLogger("public-rate-limit");
  log.warn(
    {
      anonFallbackRpm: ANON_FALLBACK_MAX_RPM,
    },
    "ATLAS_TRUST_PROXY is unset — public-share rate limiting buckets all anonymous requests into a single ceiling. Set ATLAS_TRUST_PROXY=true behind a trusted reverse proxy to enable per-IP buckets.",
  );
}

/** Test helper: reset the warned-once flag. */
export function _resetTrustProxyWarning(): void {
  warnedTrustProxyOnce = false;
}

export const PUBLIC_RATE_LIMIT_CONSTANTS = {
  WINDOW_MS,
  ANON_FALLBACK_KEY,
  ANON_FALLBACK_MAX_RPM,
} as const;
