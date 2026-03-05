/**
 * Auth middleware — central dispatcher + rate limiting.
 *
 * Calls detectAuthMode() and routes to the appropriate validator.
 * Exports in-memory sliding-window rate limiting (checkRateLimit, getClientIP).
 *
 * A background setInterval timer evicts stale rate-limit entries every 60s.
 * Call _stopCleanup() in tests to prevent the timer from keeping the process alive.
 */

import type { AuthResult } from "@atlas/api/lib/auth/types";
import { detectAuthMode } from "@atlas/api/lib/auth/detect";
import { validateApiKey } from "@atlas/api/lib/auth/simple-key";
import { validateManaged } from "@atlas/api/lib/auth/managed";
import { validateBYOT } from "@atlas/api/lib/auth/byot";
import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("auth");

// ---------------------------------------------------------------------------
// Rate limiting — in-memory sliding window
// ---------------------------------------------------------------------------

const WINDOW_MS = 60_000; // 60 seconds

/** Map of rate-limit key → array of request timestamps (ms). */
const windows = new Map<string, number[]>();

let warnedInvalidRpm = false;

function getRpmLimit(): number {
  const raw = process.env.ATLAS_RATE_LIMIT_RPM;
  if (raw === undefined || raw === "") return 0; // disabled
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    if (!warnedInvalidRpm) {
      log.warn({ value: raw }, "Invalid ATLAS_RATE_LIMIT_RPM; rate limiting disabled");
      warnedInvalidRpm = true;
    }
    return 0;
  }
  return Math.floor(n);
}

/**
 * Extract client IP from request headers.
 *
 * Both `X-Forwarded-For` and `X-Real-IP` are only trusted when
 * `ATLAS_TRUST_PROXY` is `"true"` or `"1"`. Without this, an attacker
 * can spoof these headers to bypass per-IP rate limits.
 */
export function getClientIP(req: Request): string | null {
  const trustProxy = process.env.ATLAS_TRUST_PROXY;
  if (trustProxy === "true" || trustProxy === "1") {
    const xff = req.headers.get("x-forwarded-for");
    if (xff) {
      const first = xff.split(",")[0].trim();
      if (first) return first;
    }
    const realIp = req.headers.get("x-real-ip");
    if (realIp) return realIp.trim();
  }
  return null;
}

/**
 * Sliding-window rate limit check.
 *
 * Returns `{ allowed: true }` when the request should proceed, or
 * `{ allowed: false, retryAfterMs }` when the caller should back off.
 * Always allows when ATLAS_RATE_LIMIT_RPM is unset or "0".
 *
 * Note: this limits API *requests*, not agent steps. A single chat request
 * may run up to 25 agent steps internally, so effective LLM call volume
 * can be higher than the RPM value implies.
 */
export function checkRateLimit(key: string): {
  allowed: boolean;
  retryAfterMs?: number;
} {
  const limit = getRpmLimit();
  if (limit === 0) return { allowed: true };

  const now = Date.now();
  const cutoff = now - WINDOW_MS;

  let timestamps = windows.get(key);
  if (!timestamps) {
    timestamps = [];
    windows.set(key, timestamps);
  }

  // Evict stale entries
  const firstValid = timestamps.findIndex((t) => t > cutoff);
  if (firstValid > 0) timestamps.splice(0, firstValid);
  else if (firstValid === -1) timestamps.length = 0;

  if (timestamps.length < limit) {
    timestamps.push(now);
    return { allowed: true };
  }

  // Blocked — oldest entry determines when a slot opens
  const retryAfterMs = Math.max(1, timestamps[0] + WINDOW_MS - now);
  return { allowed: false, retryAfterMs };
}

/** Clear all rate limit state. For tests. */
export function resetRateLimits(): void {
  windows.clear();
  warnedInvalidRpm = false;
}

/** Periodic cleanup — evict keys with no recent timestamps. */
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
      "Rate limit cleanup failed",
    );
  }
}, WINDOW_MS);

// Don't prevent Node/bun from exiting
cleanupInterval.unref();

/** Stop the periodic cleanup timer. For tests. */
export function _stopCleanup(): void {
  clearInterval(cleanupInterval);
}

// ---------------------------------------------------------------------------
// Auth dispatcher
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Test-only validator overrides
// ---------------------------------------------------------------------------

let _managedOverride: ((req: Request) => Promise<AuthResult>) | null = null;
let _byotOverride: ((req: Request) => Promise<AuthResult>) | null = null;

/** @internal — test-only. Override validateManaged/validateBYOT for isolation. */
export function _setValidatorOverrides(overrides: {
  managed?: ((req: Request) => Promise<AuthResult>) | null;
  byot?: ((req: Request) => Promise<AuthResult>) | null;
}): void {
  _managedOverride = overrides.managed ?? null;
  _byotOverride = overrides.byot ?? null;
}

/** Authenticate an incoming request based on the detected auth mode. */
export async function authenticateRequest(req: Request): Promise<AuthResult> {
  const mode = detectAuthMode();

  switch (mode) {
    case "none":
      return { authenticated: true, user: undefined, mode: "none" };

    case "simple-key":
      return validateApiKey(req);

    case "managed":
      try {
        return await (_managedOverride ?? validateManaged)(req);
      } catch (err) {
        log.error(
          { err: err instanceof Error ? err : new Error(String(err)), mode },
          "Managed auth error",
        );
        if (err instanceof TypeError || err instanceof ReferenceError || err instanceof SyntaxError) {
          log.error({ err, mode }, "BUG: Unexpected programming error in auth validator");
        }
        return {
          authenticated: false,
          mode,
          status: 500,
          error: "Authentication service error",
        };
      }

    case "byot":
      try {
        return await (_byotOverride ?? validateBYOT)(req);
      } catch (err) {
        log.error(
          { err: err instanceof Error ? err : new Error(String(err)), mode },
          "BYOT auth error",
        );
        if (err instanceof TypeError || err instanceof ReferenceError || err instanceof SyntaxError) {
          log.error({ err, mode }, "BUG: Unexpected programming error in auth validator");
        }
        return {
          authenticated: false,
          mode,
          status: 500,
          error: "Authentication service error",
        };
      }
  }
}
