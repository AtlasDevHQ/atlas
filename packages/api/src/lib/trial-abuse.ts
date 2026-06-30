/**
 * Self-serve trial creation-ATTEMPT rate limiting (#3654, ADR-0018).
 *
 * The anonymous `start_trial` onboarding caller (packages/mcp/src/onboarding.ts)
 * is an UNAUTHENTICATED bootstrap surface — no actor, no Workspace, no bearer
 * yet — so spam defense rides three orthogonal guards: Turnstile, this rate
 * limiter, and the short unclaimed-grace reaper. This module is the second.
 *
 * Two independent sliding windows over a configurable RPM:
 *   - per-IP creation attempts
 *   - per-email creation attempts
 *
 * Why ATTEMPTS, not trials: ADR-0018 § Abuse posture explicitly rejects a
 * per-IP *trial* cap (it punishes shared NATs — a co-working space or a
 * university behind one egress IP would lock out everyone after the first
 * signup). We bound the *rate of attempts*, not the *number of trials*, so a
 * burst from one source is throttled while a steady trickle of distinct
 * legitimate signups behind the same NAT is not.
 *
 * Storage is the shared {@link createSlidingWindowLimiter} seam (#4129) — the same
 * limiter `lib/contact.ts` / `lib/demo.ts` use, so an operator who understands
 * one understands all three, and the Redis adapter that makes these windows
 * shared across replicas/regions lands once (at the store) without touching any
 * of these three call sites. The per-process limitation is documented at that
 * seam (`lib/sliding-window-rate-limit.ts`).
 *
 * Per-IP windows degrade gracefully: when the client IP is unknown (no
 * `ATLAS_TRUST_PROXY` behind the proxy), the caller passes `null` and every
 * request collapses into one shared `anon-trial` bucket — the same
 * conservative posture the contact form takes. The per-email window is
 * unaffected by a missing IP and keeps its teeth.
 */

import { createLogger } from "./logger";
import { getSettingAuto } from "@atlas/api/lib/settings";
import { trialAbuseRejections } from "@atlas/api/lib/metrics";
import {
  createSlidingWindowLimiter,
  RATE_LIMIT_WINDOW_MS,
} from "@atlas/api/lib/sliding-window-rate-limit";

const log = createLogger("trial-abuse");

/** Per-IP attempts/minute. Looser than per-email — shared NATs are legitimate. */
const TRIAL_IP_DEFAULT_RPM = 5;
/** Per-email attempts/minute. Tighter — one mailbox retrying many times is abuse. */
const TRIAL_EMAIL_DEFAULT_RPM = 3;

/** Fallback bucket when the client IP is unknown (no trusted proxy). */
const ANON_IP_KEY = "anon-trial";

let lastWarnedIpRpm: string | undefined;
let lastWarnedEmailRpm: string | undefined;

function parseRpm(
  raw: string | undefined,
  fallback: number,
  key: string,
  warnSlot: { last: string | undefined },
): number {
  // Platform-scoped settings registry: DB override > env > registry default.
  const value = raw ?? String(fallback);
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    if (value !== warnSlot.last) {
      log.warn({ value, key }, `Invalid ${key}; using default ${fallback}`);
      warnSlot.last = value;
    }
    return fallback;
  }
  return Math.floor(n);
}

/** Per-IP trial creation attempts allowed per minute. Default 5. 0 = disabled. */
export function getTrialIpRpmLimit(): number {
  const slot = { last: lastWarnedIpRpm };
  // Literal key at the getSettingAuto call site — see scripts/check-settings-readers.sh (R1).
  const v = parseRpm(
    getSettingAuto("ATLAS_TRIAL_IP_RATE_LIMIT_RPM"),
    TRIAL_IP_DEFAULT_RPM,
    "ATLAS_TRIAL_IP_RATE_LIMIT_RPM",
    slot,
  );
  lastWarnedIpRpm = slot.last;
  return v;
}

/** Per-email trial creation attempts allowed per minute. Default 3. 0 = disabled. */
export function getTrialEmailRpmLimit(): number {
  const slot = { last: lastWarnedEmailRpm };
  const v = parseRpm(
    getSettingAuto("ATLAS_TRIAL_EMAIL_RATE_LIMIT_RPM"),
    TRIAL_EMAIL_DEFAULT_RPM,
    "ATLAS_TRIAL_EMAIL_RATE_LIMIT_RPM",
    slot,
  );
  lastWarnedEmailRpm = slot.last;
  return v;
}

// Two independent windows over the shared limiter seam: one keyed by IP, one by
// email. Separate limiters (separate stores) keep the key spaces from colliding
// — the same isolation the previous two-Map implementation gave.
const ipLimiter = createSlidingWindowLimiter({ windowMs: RATE_LIMIT_WINDOW_MS });
const emailLimiter = createSlidingWindowLimiter({ windowMs: RATE_LIMIT_WINDOW_MS });

/** Which bucket tripped — surfaced for structured logging, never to the caller's user. */
export type TrialAttemptBucket = "ip" | "email";

/**
 * Discriminated on `allowed` so `bucket` + `retryAfterMs` are present IFF the
 * attempt was blocked — a `{ allowed: true }` result can't carry a stray bucket,
 * and a consumer that branches on `!allowed` reads both fields without a fallback.
 */
export type TrialAttemptRateLimitResult =
  | { readonly allowed: true }
  | {
      /** The bucket that tripped. */
      readonly allowed: false;
      readonly bucket: TrialAttemptBucket;
      /** Milliseconds until the tripped bucket frees a slot. */
      readonly retryAfterMs: number;
    };

/**
 * Check a trial creation attempt against BOTH the per-IP and per-email windows.
 *
 * Semantics: the attempt is allowed only when both buckets have headroom, and
 * is recorded in both buckets only when allowed. A blocked attempt is NOT
 * recorded (it neither consumes nor extends either window) — so a caller that
 * trips the limit and backs off recovers on schedule rather than being pushed
 * out indefinitely by its own retries.
 *
 * `ip` may be `null` (unknown client IP) — it collapses to a shared bucket.
 * `email` is lower-cased + trimmed so case variants share a window.
 */
export async function checkTrialAttemptRateLimit(input: {
  ip: string | null;
  email: string;
}): Promise<TrialAttemptRateLimitResult> {
  const ipLimit = getTrialIpRpmLimit();
  const emailLimit = getTrialEmailRpmLimit();

  const ipKey = input.ip && input.ip.length > 0 ? input.ip : ANON_IP_KEY;
  const emailKey = input.email.trim().toLowerCase();
  const now = Date.now();

  // Check IP first, then email. Record in NEITHER until both pass so the
  // first-checked bucket isn't charged for an attempt the second bucket blocks.
  const ipCheck = await ipLimiter.peek(ipKey, ipLimit, now);
  if (!ipCheck.allowed) {
    // Observability (#3796): aggregate per-replica in-memory rejections at the
    // collector so a fleet-wide attack is a graphable/alertable series, not
    // just a per-request log. No-op when OTel is uninitialized (metrics.ts).
    trialAbuseRejections.add(1, { limiter: "ip" });
    return { allowed: false, bucket: "ip", retryAfterMs: ipCheck.retryAfterMs };
  }
  const emailCheck = await emailLimiter.peek(emailKey, emailLimit, now);
  if (!emailCheck.allowed) {
    trialAbuseRejections.add(1, { limiter: "email" });
    return { allowed: false, bucket: "email", retryAfterMs: emailCheck.retryAfterMs };
  }

  await ipLimiter.record(ipKey, ipLimit, now);
  await emailLimiter.record(emailKey, emailLimit, now);
  return { allowed: true };
}

/** Clear all rate-limit state. For tests. */
export async function resetTrialAttemptRateLimits(): Promise<void> {
  await ipLimiter.reset();
  await emailLimiter.reset();
}

/**
 * Evict fully-stale buckets — matches `contactCleanupTick` shape so the
 * SchedulerLayer can sweep all the public limiters on one cadence.
 */
export async function trialAttemptCleanupTick(): Promise<void> {
  const now = Date.now();
  await ipLimiter.cleanup(now);
  await emailLimiter.cleanup(now);
}
