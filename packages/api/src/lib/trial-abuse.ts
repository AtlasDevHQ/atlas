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
 * Map-of-arrays implementation deliberately matches `lib/contact.ts` /
 * `lib/demo.ts` so an operator who understands one understands all three; a
 * future Redis backend would replace every call site uniformly.
 *
 * Per-IP windows degrade gracefully: when the client IP is unknown (no
 * `ATLAS_TRUST_PROXY` behind the proxy), the caller passes `null` and every
 * request collapses into one shared `anon-trial` bucket — the same
 * conservative posture the contact form takes. The per-email window is
 * unaffected by a missing IP and keeps its teeth.
 */

import { createLogger } from "./logger";
import { getSettingAuto } from "@atlas/api/lib/settings";

const log = createLogger("trial-abuse");

/** Per-IP attempts/minute. Looser than per-email — shared NATs are legitimate. */
const TRIAL_IP_DEFAULT_RPM = 5;
/** Per-email attempts/minute. Tighter — one mailbox retrying many times is abuse. */
const TRIAL_EMAIL_DEFAULT_RPM = 3;
const WINDOW_MS = 60_000;

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

const ipWindows = new Map<string, number[]>();
const emailWindows = new Map<string, number[]>();

/**
 * Non-mutating sliding-window check. Evicts stale timestamps in place (so the
 * window self-trims) but does NOT record the current attempt — the caller
 * records only once BOTH buckets pass, so a request blocked on the second
 * bucket never inflates the first bucket's count.
 *
 * `limit === 0` disables the bucket (always allowed, never recorded).
 */
function peek(
  windows: Map<string, number[]>,
  key: string,
  limit: number,
  now: number,
): { allowed: boolean; retryAfterMs?: number } {
  if (limit === 0) return { allowed: true };

  const cutoff = now - WINDOW_MS;
  let timestamps = windows.get(key);
  if (!timestamps) {
    timestamps = [];
    windows.set(key, timestamps);
  }

  // Evict stale entries (single-pass, in-place — matches the contact limiter).
  const firstValid = timestamps.findIndex((t) => t > cutoff);
  if (firstValid > 0) timestamps.splice(0, firstValid);
  else if (firstValid === -1) timestamps.length = 0;

  if (timestamps.length < limit) return { allowed: true };
  const retryAfterMs = Math.max(1, timestamps[0]! + WINDOW_MS - now);
  return { allowed: false, retryAfterMs };
}

function record(windows: Map<string, number[]>, key: string, limit: number, now: number): void {
  if (limit === 0) return;
  let timestamps = windows.get(key);
  if (!timestamps) {
    timestamps = [];
    windows.set(key, timestamps);
  }
  timestamps.push(now);
}

/** Which bucket tripped — surfaced for structured logging, never to the caller's user. */
export type TrialAttemptBucket = "ip" | "email";

export interface TrialAttemptRateLimitResult {
  readonly allowed: boolean;
  /** The bucket that tripped (only when `allowed === false`). */
  readonly bucket?: TrialAttemptBucket;
  /** Milliseconds until the tripped bucket frees a slot. */
  readonly retryAfterMs?: number;
}

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
export function checkTrialAttemptRateLimit(input: {
  ip: string | null;
  email: string;
}): TrialAttemptRateLimitResult {
  const ipLimit = getTrialIpRpmLimit();
  const emailLimit = getTrialEmailRpmLimit();

  const ipKey = input.ip && input.ip.length > 0 ? input.ip : ANON_IP_KEY;
  const emailKey = input.email.trim().toLowerCase();
  const now = Date.now();

  // Check IP first, then email. Record in NEITHER until both pass so the
  // first-checked bucket isn't charged for an attempt the second bucket blocks.
  const ipCheck = peek(ipWindows, ipKey, ipLimit, now);
  if (!ipCheck.allowed) {
    return { allowed: false, bucket: "ip", retryAfterMs: ipCheck.retryAfterMs };
  }
  const emailCheck = peek(emailWindows, emailKey, emailLimit, now);
  if (!emailCheck.allowed) {
    return { allowed: false, bucket: "email", retryAfterMs: emailCheck.retryAfterMs };
  }

  record(ipWindows, ipKey, ipLimit, now);
  record(emailWindows, emailKey, emailLimit, now);
  return { allowed: true };
}

/** Clear all rate-limit state. For tests. */
export function resetTrialAttemptRateLimits(): void {
  ipWindows.clear();
  emailWindows.clear();
}

/**
 * Evict fully-stale buckets — matches `contactCleanupTick` shape so the
 * SchedulerLayer can sweep all the public limiters on one cadence.
 */
export function trialAttemptCleanupTick(): void {
  const cutoff = Date.now() - WINDOW_MS;
  for (const windows of [ipWindows, emailWindows]) {
    for (const [key, timestamps] of windows) {
      if (timestamps.length === 0 || timestamps[timestamps.length - 1]! <= cutoff) {
        windows.delete(key);
      }
    }
  }
}
