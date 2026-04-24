/**
 * Symmetric encryption for arbitrary secret payloads (F-41).
 *
 * Lives alongside `internal.ts`'s `encryptUrl` but covers payloads
 * `encryptUrl`'s plaintext detection can't safely handle: `encryptUrl`
 * gates plaintext detection on a URL-scheme regex (`^<scheme>://`) plus
 * a 3-colon-count check. Neither works for integration credentials —
 * Telegram bot tokens like `1234:abc…` aren't URLs and don't split into
 * three parts (the plaintext would be rejected on read), and JSON blobs
 * can coincidentally produce three colon-separated parts (triggering a
 * spurious decrypt attempt). The versioned `enc:v1:` prefix used here
 * sidesteps both problems and leaves room for `enc:v2:` once key
 * rotation lands (F-47 / #1820).
 *
 * Kept in a dedicated module so tests that partially-mock `db/internal`
 * (common in admin route tests) aren't forced to declare three extra
 * no-op exports to avoid `SyntaxError: Export not found`. Mock
 * `db/secret-encryption` separately when a test needs it.
 */

import * as crypto from "crypto";
import { createLogger } from "@atlas/api/lib/logger";
import { getEncryptionKey } from "@atlas/api/lib/db/internal";

const log = createLogger("secret-encryption");

const ENCRYPTION_ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const SECRET_PREFIX = "enc:v1:";

// Boot-time alarm: in production without a key configured, every new
// credential gets stored plaintext via the passthrough in `encryptSecret`.
// The audit-level fallback is intentional (dev + self-hosted without a
// secret should still work), but SaaS deployments are expected to set
// one and the silent pass-through would otherwise only surface on a
// read of pre-encrypted data — too late. Fire once at module load.
(() => {
  const isProdLike =
    process.env.NODE_ENV === "production" || process.env.ATLAS_DEPLOY_MODE === "saas";
  if (isProdLike && !getEncryptionKey()) {
    log.error(
      "No encryption key configured (ATLAS_ENCRYPTION_KEY / BETTER_AUTH_SECRET) — " +
      "integration credentials will be written plaintext. This is a P0 in SaaS mode.",
    );
  }
})();

/**
 * Encrypts an arbitrary secret string using AES-256-GCM, tagged with
 * the `enc:v1:` prefix so decryptSecret can distinguish ciphertext from
 * plaintext regardless of the payload's colon count.
 *
 * Returns the plaintext unchanged if no encryption key is configured,
 * matching encryptUrl's dev-friendly semantics — decryptSecret then
 * treats the un-prefixed value as plaintext on read.
 */
export function encryptSecret(plaintext: string): string {
  const key = getEncryptionKey();
  if (!key) return plaintext;

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return `${SECRET_PREFIX}${iv.toString("base64")}:${authTag.toString("base64")}:${encrypted.toString("base64")}`;
}

/**
 * Decrypts a value produced by `encryptSecret`. Values not starting
 * with the `enc:v1:` prefix are returned unchanged — safe on legacy
 * rows that predate dual-write and on deployments with no key set.
 *
 * Throws if the value carries `enc:v1:` but the body is malformed, the
 * key is absent, or AES-GCM auth-tag verification fails. Callers that
 * have a fallback path (see `pickDecryptedSecret`) should `try/catch`
 * and use it; callers without a fallback let the throw surface as a
 * 500 with `requestId`.
 */
export function decryptSecret(stored: string): string {
  if (!stored.startsWith(SECRET_PREFIX)) return stored;

  const key = getEncryptionKey();
  if (!key) {
    log.error("Encrypted secret found but no encryption key is available — set ATLAS_ENCRYPTION_KEY or BETTER_AUTH_SECRET");
    throw new Error("Cannot decrypt secret: no encryption key available");
  }

  const body = stored.slice(SECRET_PREFIX.length);
  const parts = body.split(":");
  if (parts.length !== 3) {
    log.error({ partCount: parts.length }, "Stored secret has enc:v1: prefix but does not match encrypted format (expected 3 colon-separated parts)");
    throw new Error("Failed to decrypt secret: unrecognized format");
  }

  try {
    const iv = Buffer.from(parts[0], "base64");
    const authTag = Buffer.from(parts[1], "base64");
    const ciphertext = Buffer.from(parts[2], "base64");

    const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString("utf8");
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err) },
      "Failed to decrypt secret — data may be corrupted or key may have changed",
    );
    throw new Error("Failed to decrypt secret", { cause: err });
  }
}

/**
 * Prefer the encrypted column (decrypted via `decryptSecret`) and fall
 * back to the plaintext column when:
 *   • the encrypted column is null / empty / not a string, OR
 *   • the encrypted column decodes unsuccessfully (corrupt ciphertext,
 *     rotated key, truncated row).
 *
 * The decrypt-failure fallback is load-bearing during the F-41 soak: a
 * single bad encrypted row must not take down an integration when the
 * plaintext copy is still there. Post-#1832 (plaintext drop), decrypt
 * failure will naturally become terminal since the fallback disappears.
 *
 * A warn breadcrumb is emitted in the fallback cases so ops can see
 * schema drift (non-string encrypted values) or cipher-format drift
 * (decrypt failures) without spelunking pg logs.
 *
 * Returns `null` when neither column carries a usable string — the
 * caller treats that as a malformed row.
 */
export function pickDecryptedSecret(
  encryptedValue: unknown,
  plaintextValue: unknown,
): string | null {
  if (encryptedValue !== null && encryptedValue !== undefined && typeof encryptedValue !== "string") {
    log.warn(
      { encryptedType: typeof encryptedValue },
      "Encrypted column carries non-string value — schema drift, falling back to plaintext",
    );
  }
  if (typeof encryptedValue === "string" && encryptedValue.length > 0) {
    try {
      return decryptSecret(encryptedValue);
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "Encrypted column failed to decrypt — falling back to plaintext column (F-41 soak)",
      );
    }
  }
  if (typeof plaintextValue === "string" && plaintextValue.length > 0) {
    return plaintextValue;
  }
  return null;
}
