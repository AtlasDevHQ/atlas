/**
 * Symmetric encryption for arbitrary secret payloads (F-41).
 *
 * Lives alongside `internal.ts`'s `encryptUrl` but targets a different
 * contract: where `encryptUrl` assumes its plaintext is a URL and uses a
 * colon-count heuristic to tell plaintext from ciphertext, the helpers
 * here cover integration credentials that *do* contain colons (Telegram
 * bot tokens like "1234:abc…") and JSON blobs (email/sandbox config
 * carriers). The versioned `enc:v1:` prefix makes the ciphertext form
 * unambiguous, leaving room for `enc:v2:` once key rotation lands
 * (F-47 / #1820).
 *
 * Kept in a dedicated module so tests that partially-mock `db/internal`
 * (which every admin route test does via `mock.module`) aren't forced to
 * opt into the three new exports to avoid `SyntaxError: Export not
 * found`. Mock `db/secret-encryption` separately when a test needs it.
 */

import * as crypto from "crypto";
import { createLogger } from "@atlas/api/lib/logger";
import { getEncryptionKey } from "@atlas/api/lib/db/internal";

const log = createLogger("secret-encryption");

const ENCRYPTION_ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const SECRET_PREFIX = "enc:v1:";

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
 * Prefer the encrypted column if present (decrypting via `decryptSecret`);
 * fall back to the plaintext column for rows that have not yet been
 * dual-written. Used by every integration store's `parseInstallationRow`
 * so the read-priority logic stays in lockstep across tables.
 *
 * Returns `null` when neither column carries a usable string — the
 * caller treats that as a malformed row.
 */
export function pickDecryptedSecret(
  encryptedValue: unknown,
  plaintextValue: unknown,
): string | null {
  if (typeof encryptedValue === "string" && encryptedValue.length > 0) {
    return decryptSecret(encryptedValue);
  }
  if (typeof plaintextValue === "string" && plaintextValue.length > 0) {
    return plaintextValue;
  }
  return null;
}
