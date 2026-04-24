/**
 * Replay protection for the webhook plugin (F-75).
 *
 * Mirrors the Slack pattern (`packages/api/src/lib/slack/verify.ts`) — the
 * signing input is `${timestamp}:${body}`, requests outside a 5-minute window
 * are rejected, and a small per-channel signature cache blocks in-window
 * replays. TTL is 305s so entries expire just after the window closes.
 *
 * Legacy soft-fail (`ATLAS_WEBHOOK_REPLAY_LEGACY=true`) lets operators stage
 * the upgrade — it tolerates a missing `X-Webhook-Timestamp` header and
 * verifies the HMAC against the body alone, but still emits a warning so the
 * absence is observable. Default is fail-closed.
 */

import crypto from "crypto";

export const MAX_TIMESTAMP_AGE_SECONDS = 300;
export const NONCE_TTL_MS = 305_000;

export type ReplayMode = "strict" | "legacy";

export type TimestampCheck =
  | { valid: true; timestamp: number }
  | { valid: false; error: string };

export function parseReplayMode(envValue: string | undefined): ReplayMode {
  return envValue === "true" ? "legacy" : "strict";
}

/**
 * Validate the X-Webhook-Timestamp header is present and within the 5-minute
 * window. Returns the parsed Unix-second timestamp on success.
 */
export function checkTimestamp(
  rawTimestamp: string | null,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): TimestampCheck {
  if (!rawTimestamp) {
    return { valid: false, error: "Missing X-Webhook-Timestamp header" };
  }
  const ts = Number.parseInt(rawTimestamp, 10);
  if (!Number.isFinite(ts)) {
    return { valid: false, error: "Invalid timestamp" };
  }
  if (Math.abs(nowSeconds - ts) > MAX_TIMESTAMP_AGE_SECONDS) {
    return { valid: false, error: "Request timestamp outside allowed window" };
  }
  return { valid: true, timestamp: ts };
}

/**
 * Verify HMAC-SHA256 with timestamped signing input `${timestamp}:${body}`.
 * Falls back to body-only signing under `legacy` mode when the timestamp is
 * absent, matching the pre-F-75 wire format so operators can stage the
 * upgrade.
 */
export function verifyHmacWithTimestamp(
  secret: string,
  signature: string | null,
  rawTimestamp: string | null,
  body: string,
  mode: ReplayMode,
): { valid: true; timestamp: number | null } | { valid: false; error: string } {
  if (!signature) {
    return { valid: false, error: "Missing X-Webhook-Signature header" };
  }

  const tsCheck = checkTimestamp(rawTimestamp);
  if (!tsCheck.valid) {
    if (mode === "legacy" && tsCheck.error === "Missing X-Webhook-Timestamp header") {
      const expected = crypto.createHmac("sha256", secret).update(body).digest("hex");
      return verifyDigest(expected, signature) ? { valid: true, timestamp: null } : { valid: false, error: "Invalid signature" };
    }
    return { valid: false, error: tsCheck.error };
  }

  const signingInput = `${tsCheck.timestamp}:${body}`;
  const expected = crypto.createHmac("sha256", secret).update(signingInput).digest("hex");
  return verifyDigest(expected, signature)
    ? { valid: true, timestamp: tsCheck.timestamp }
    : { valid: false, error: "Invalid signature" };
}

function verifyDigest(expectedHex: string, providedHex: string): boolean {
  const expected = Buffer.from(expectedHex);
  const actual = Buffer.from(providedHex);
  if (expected.length !== actual.length) return false;
  try {
    return crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

/**
 * In-memory recent-signature cache, keyed by `${channelId}:${signature}`.
 * Entries expire after `NONCE_TTL_MS` so the cache never grows unbounded.
 * Lookup filters expired entries lazily on read.
 */
export function createNonceCache(now: () => number = () => Date.now()) {
  const seen = new Map<string, number>();

  function key(channelId: string, signature: string): string {
    return `${channelId}:${signature}`;
  }

  function pruneIfDue(currentMs: number): void {
    if (seen.size < 1024) return;
    for (const [k, expiresAt] of seen) {
      if (expiresAt <= currentMs) seen.delete(k);
    }
  }

  /**
   * Returns true if the (channelId, signature) was already seen within the
   * TTL window. Records the new entry as a side effect when not seen.
   */
  function checkAndRecord(channelId: string, signature: string): boolean {
    const currentMs = now();
    const k = key(channelId, signature);
    const existingExpiry = seen.get(k);
    if (existingExpiry !== undefined && existingExpiry > currentMs) {
      return true;
    }
    pruneIfDue(currentMs);
    seen.set(k, currentMs + NONCE_TTL_MS);
    return false;
  }

  function reset(): void {
    seen.clear();
  }

  return { checkAndRecord, reset };
}

export type NonceCache = ReturnType<typeof createNonceCache>;
