/**
 * Signed unsubscribe tokens for onboarding-email links.
 *
 * HMAC-SHA256 over `userId:expiresAt` using BETTER_AUTH_SECRET derived with a
 * ":unsubscribe" suffix (key-isolation from other signed tokens — see demo.ts).
 * Stateless: verification never touches the database, so an email unsubscribe
 * click stays fast and survives schema changes.
 *
 * Token format: `${expiresAtMs}.${base64urlHmac}`. The userId travels in the
 * URL itself (as it did before the fix); the signature binds a specific userId
 * to a specific expiry, so a token minted for user A cannot flip the flag on
 * user B.
 */

import * as crypto from "crypto";
import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("unsubscribe-token");

const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const MIN_TTL_MS = 60 * 1000; // 1 minute floor — rejects nonsense configs
const MAX_TTL_MS = 365 * 24 * 60 * 60 * 1000; // 1 year ceiling

/** TTL for newly-signed unsubscribe tokens. Configurable via env. */
export function getUnsubscribeTokenTtlMs(): number {
  const raw = process.env.ATLAS_UNSUBSCRIBE_TOKEN_TTL_MS;
  if (!raw) return DEFAULT_TTL_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < MIN_TTL_MS || n > MAX_TTL_MS) {
    log.warn(
      { value: raw, min: MIN_TTL_MS, max: MAX_TTL_MS },
      `Invalid ATLAS_UNSUBSCRIBE_TOKEN_TTL_MS; using default ${DEFAULT_TTL_MS}ms`,
    );
    return DEFAULT_TTL_MS;
  }
  return Math.floor(n);
}

/**
 * Derive the HMAC key. Namespaced with a ":unsubscribe" suffix so a leak of
 * one derived key does not compromise demo tokens or any future signed URL.
 */
function getSigningKey(): Buffer | null {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) return null;
  return crypto.createHash("sha256").update(secret + ":unsubscribe").digest();
}

export type UnsubscribeTokenFailure = "bad_sig" | "expired" | "malformed" | "no_secret";

export interface UnsubscribeTokenResult {
  valid: boolean;
  reason?: UnsubscribeTokenFailure;
}

/**
 * Sign a token binding a userId to an expiration. Returns `null` only when
 * BETTER_AUTH_SECRET is unset — which is an unreachable path at runtime
 * because startup.ts refuses to boot without it, but the helper stays safe.
 */
export function signUnsubscribeToken(userId: string, expiresAtMs: number): string | null {
  const key = getSigningKey();
  if (!key) {
    log.error("Cannot sign unsubscribe token: BETTER_AUTH_SECRET is not set");
    return null;
  }
  const sig = crypto.createHmac("sha256", key).update(`${userId}:${expiresAtMs}`).digest();
  return `${expiresAtMs}.${sig.toString("base64url")}`;
}

/**
 * Verify a token against a userId and optional wall-clock time (for tests).
 * Never throws — all failure modes collapse into a tagged result.
 */
export function verifyUnsubscribeToken(
  userId: string,
  token: string,
  now: number = Date.now(),
): UnsubscribeTokenResult {
  const key = getSigningKey();
  if (!key) {
    log.warn("Cannot verify unsubscribe token: BETTER_AUTH_SECRET is not set");
    return { valid: false, reason: "no_secret" };
  }

  const parts = token.split(".");
  if (parts.length !== 2) return { valid: false, reason: "malformed" };

  const [expStr, sigStr] = parts;
  const expiresAtMs = Number(expStr);
  if (!Number.isFinite(expiresAtMs) || !Number.isInteger(expiresAtMs) || expiresAtMs <= 0) {
    return { valid: false, reason: "malformed" };
  }

  // Buffer.from(..., "base64url") never throws on malformed input — it drops
  // invalid characters and returns a (possibly empty) buffer. The length
  // check below catches those as bad_sig.
  const actualSig = Buffer.from(sigStr, "base64url");
  const expectedSig = crypto.createHmac("sha256", key).update(`${userId}:${expiresAtMs}`).digest();

  // Length check before timingSafeEqual — required by the Node API and also
  // means a truncated/padded signature can't leak timing info about `key`.
  if (actualSig.length !== expectedSig.length) return { valid: false, reason: "bad_sig" };
  if (!crypto.timingSafeEqual(actualSig, expectedSig)) return { valid: false, reason: "bad_sig" };

  // Expiry checked last: only after the signature matches do we reveal that
  // the reason was "expired" vs "bad_sig" in the log line. Either way, the
  // caller returns the same neutral user-facing response.
  if (expiresAtMs < now) return { valid: false, reason: "expired" };

  return { valid: true };
}
