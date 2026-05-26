/**
 * Contact-form per-IP rate limit. Mirrors the shape of
 * `checkDemoRateLimit` in `lib/demo.ts` — sliding window over a
 * configurable RPM — but with a tighter default ceiling because the
 * contact form should be a rare event per visitor (5 submissions per
 * minute is plenty for a sales conversation; 30+ is abuse).
 *
 * The map-of-arrays implementation matches the demo limiter so an
 * operator who looks at one understands the other. A future Redis
 * backend would replace both call sites uniformly.
 */

import { createLogger } from "./logger";

const log = createLogger("contact");

const CONTACT_DEFAULT_RPM = 5;
const WINDOW_MS = 60_000;

let lastWarnedRpm: string | undefined;

/** Requests per minute per IP. Default 5. 0 = disabled. */
export function getContactRpmLimit(): number {
  const raw = process.env.ATLAS_CONTACT_RATE_LIMIT_RPM ?? String(CONTACT_DEFAULT_RPM);
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    if (raw !== lastWarnedRpm) {
      log.warn(
        { value: raw },
        `Invalid ATLAS_CONTACT_RATE_LIMIT_RPM; using default ${CONTACT_DEFAULT_RPM}`,
      );
      lastWarnedRpm = raw;
    }
    return CONTACT_DEFAULT_RPM;
  }
  return Math.floor(n);
}

const contactWindows = new Map<string, number[]>();

/**
 * Sliding-window rate limit keyed by IP.
 * Returns `{ allowed: true }` or `{ allowed: false, retryAfterMs }`.
 */
export function checkContactRateLimit(ip: string): {
  allowed: boolean;
  retryAfterMs?: number;
} {
  const limit = getContactRpmLimit();
  if (limit === 0) return { allowed: true };

  const now = Date.now();
  const cutoff = now - WINDOW_MS;
  const key = ip;

  let timestamps = contactWindows.get(key);
  if (!timestamps) {
    timestamps = [];
    contactWindows.set(key, timestamps);
  }

  // Evict stale entries (matches demo limiter — single-pass, in-place).
  const firstValid = timestamps.findIndex((t) => t > cutoff);
  if (firstValid > 0) timestamps.splice(0, firstValid);
  else if (firstValid === -1) timestamps.length = 0;

  if (timestamps.length < limit) {
    timestamps.push(now);
    return { allowed: true };
  }

  const retryAfterMs = Math.max(1, timestamps[0] + WINDOW_MS - now);
  return { allowed: false, retryAfterMs };
}

/** Clear rate limit state. For tests. */
export function resetContactRateLimits(): void {
  contactWindows.clear();
}

/**
 * Evict stale entries — matches `demoCleanupTick` shape so the
 * SchedulerLayer can call it on the same cadence.
 */
export function contactCleanupTick(): void {
  const cutoff = Date.now() - WINDOW_MS;
  for (const [key, timestamps] of contactWindows) {
    if (timestamps.length === 0 || timestamps[timestamps.length - 1] <= cutoff) {
      contactWindows.delete(key);
    }
  }
}
