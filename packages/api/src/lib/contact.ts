/**
 * Contact-form per-IP rate limit. Mirrors the shape of
 * `checkDemoRateLimit` in `lib/demo.ts` — sliding window over a
 * configurable RPM — but with a tighter default ceiling because the
 * contact form should be a rare event per visitor (5 submissions per
 * minute is plenty for a sales conversation; 30+ is abuse).
 *
 * Storage is the shared {@link createSlidingWindowLimiter} seam (#4129) — the same
 * limiter `lib/demo.ts` / `lib/trial-abuse.ts` use, so the Redis adapter that
 * makes this window shared across replicas/regions lands once (at the store)
 * without touching this call site. The per-process limitation is documented at
 * that seam (`lib/sliding-window-rate-limit.ts`).
 */

import { createLogger } from "./logger";
import { getSettingAuto } from "@atlas/api/lib/settings";
import {
  createSlidingWindowLimiter,
  type RateLimitDecision,
} from "@atlas/api/lib/sliding-window-rate-limit";

const log = createLogger("contact");

const CONTACT_DEFAULT_RPM = 5;

let lastWarnedRpm: string | undefined;

/** Requests per minute per IP. Default 5. 0 = disabled. */
export function getContactRpmLimit(): number {
  // Platform-scoped settings registry (#3705): DB override > env > default.
  const raw = getSettingAuto("ATLAS_CONTACT_RATE_LIMIT_RPM") ?? String(CONTACT_DEFAULT_RPM);
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

const contactLimiter = createSlidingWindowLimiter();

/**
 * Sliding-window rate limit keyed by IP. The discriminated `RateLimitDecision`
 * carries `retryAfterMs` IFF blocked, so callers read it after `!allowed`
 * without a fallback.
 */
export function checkContactRateLimit(ip: string): Promise<RateLimitDecision> {
  return contactLimiter.check(ip, getContactRpmLimit());
}

/** Clear rate limit state. For tests. */
export function resetContactRateLimits(): Promise<void> {
  return contactLimiter.reset();
}

/**
 * Evict stale entries — matches `demoCleanupTick` shape so the
 * SchedulerLayer can call it on the same cadence.
 */
export function contactCleanupTick(): Promise<void> {
  return contactLimiter.cleanup();
}
