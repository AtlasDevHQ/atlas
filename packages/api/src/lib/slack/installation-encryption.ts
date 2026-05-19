/**
 * Slack installation token encryption — compatible with `@chat-adapter/slack`.
 *
 * The chat-adapter persists per-tenant bot tokens in `chat_cache` (key
 * prefix `slack:installation:`) and applies its own AES-256-GCM
 * encryption when `encryptionKey` / `SLACK_ENCRYPTION_KEY` is set. The
 * stored shape is `{ iv, data, tag }` (each base64) — adapter reads it
 * back, detects the shape, and decrypts transparently.
 *
 * Atlas writes those rows from the OAuth callback (`saveInstallation`)
 * and reads them from host code (`getInstallation` / `getBotToken`).
 * For both sides to agree, this module replicates the adapter's exact
 * algorithm + key format. The helpers are pure — no DB, no logger — so
 * they can be unit-tested without infra.
 *
 * **Key precedence.** The chat-adapter reads `SLACK_ENCRYPTION_KEY` from
 * env directly. Atlas does the same, falling back to no-encryption (the
 * adapter's behaviour when the key is unset). Both paths must read the
 * SAME env var so encrypted-write / encrypted-read stay symmetric.
 *
 * **Key format.** 32 raw bytes, supplied as either a 64-char hex string
 * or a 44-char base64 string. Anything else throws at decode time.
 *
 * **Plaintext fallback.** When `SLACK_ENCRYPTION_KEY` is unset, tokens
 * persist as raw strings (no envelope). This matches the chat-adapter
 * defaults and is acceptable for self-hosted single-user deployments
 * where the internal DB is already a trust boundary. SaaS deploys must
 * set the key — `deploy/api/atlas.config.ts` documents the requirement.
 *
 * @see plugins/chat/node_modules/@chat-adapter/slack — the source of
 *      truth for the encryption shape this module mirrors.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const HEX_KEY_PATTERN = /^[0-9a-fA-F]{64}$/;

/**
 * Chat-adapter's encrypted envelope. Stored as a JSONB object in
 * `chat_cache.value.botToken`. All three fields are base64-encoded.
 */
export interface SlackEncryptedToken {
  iv: string;
  data: string;
  tag: string;
}

/**
 * `botToken` may be a plaintext string OR the encrypted-envelope shape
 * — both are valid persisted states depending on whether
 * `SLACK_ENCRYPTION_KEY` was set when the row was written. Read paths
 * decide which branch to take via {@link isSlackEncryptedToken}.
 */
export type StoredSlackBotToken = string | SlackEncryptedToken;

/**
 * Decode the 32-byte key from a hex (64 chars) or base64 (44 chars)
 * string. Throws if the decoded length is wrong — matches the
 * chat-adapter's `decodeKey` semantics so a misconfigured key fails
 * loudly at startup rather than producing silently-undecryptable rows.
 */
export function decodeSlackEncryptionKey(rawKey: string): Buffer {
  const trimmed = rawKey.trim();
  const isHex = HEX_KEY_PATTERN.test(trimmed);
  const key = Buffer.from(trimmed, isHex ? "hex" : "base64");
  if (key.length !== 32) {
    throw new Error(
      `SLACK_ENCRYPTION_KEY must decode to exactly 32 bytes (received ${key.length}). ` +
        "Use a 64-char hex string or 44-char base64 string.",
    );
  }
  return key;
}

/**
 * Cache the decoded key per process — `decodeSlackEncryptionKey` does a
 * Buffer alloc + format check on every call, and the encrypt/decrypt
 * paths run on every Slack event for multi-workspace adapters.
 */
let cachedKey: Buffer | null | undefined;

/** Read SLACK_ENCRYPTION_KEY, decode once, cache. Null when unset. */
export function getSlackEncryptionKey(): Buffer | null {
  if (cachedKey !== undefined) return cachedKey;
  const raw = process.env.SLACK_ENCRYPTION_KEY;
  if (!raw) {
    cachedKey = null;
    return null;
  }
  cachedKey = decodeSlackEncryptionKey(raw);
  return cachedKey;
}

/** Reset the cached key — call from tests after mutating env. */
export function resetSlackEncryptionKeyCache(): void {
  cachedKey = undefined;
}

/** True when `value` is the `{ iv, data, tag }` envelope shape. */
export function isSlackEncryptedToken(value: unknown): value is SlackEncryptedToken {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.iv === "string" &&
    typeof obj.data === "string" &&
    typeof obj.tag === "string"
  );
}

/**
 * Encrypt a Slack bot token for persistence. Returns the plaintext
 * unchanged when no key is configured (matches chat-adapter behaviour
 * — the chat-adapter also no-ops when its `encryptionKey` is unset).
 */
export function encryptSlackInstallationToken(plaintext: string): StoredSlackBotToken {
  const key = getSlackEncryptionKey();
  if (!key) return plaintext;

  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString("base64"),
    data: ciphertext.toString("base64"),
    tag: tag.toString("base64"),
  };
}

/**
 * Decrypt whatever was stored. Accepts both the envelope shape (when a
 * key was set at write time) and bare strings (plaintext fallback). A
 * key MUST be configured to decrypt an envelope — missing key on an
 * encrypted row throws so the failure surfaces in logs rather than
 * being returned as a useless ciphertext bearer.
 */
export function decryptSlackInstallationToken(stored: StoredSlackBotToken): string {
  if (typeof stored === "string") return stored;
  if (!isSlackEncryptedToken(stored)) {
    throw new Error("Stored Slack bot token has unexpected shape — refusing to decrypt");
  }
  const key = getSlackEncryptionKey();
  if (!key) {
    throw new Error(
      "Slack bot token is encrypted but SLACK_ENCRYPTION_KEY is not set — cannot decrypt",
    );
  }
  const iv = Buffer.from(stored.iv, "base64");
  const ciphertext = Buffer.from(stored.data, "base64");
  const tag = Buffer.from(stored.tag, "base64");
  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
