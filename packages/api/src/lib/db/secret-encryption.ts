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
// Import the resolver from its dedicated module, not via the `db/internal`
// re-export, so the many `mock.module("@atlas/api/lib/db/internal", ...)`
// partial-mock sites in admin route tests don't need to be kept in
// lockstep with new encryption exports. The re-export in internal.ts
// stays for back-compat for callers outside `lib/db/`.
import { getEncryptionKeyset } from "@atlas/api/lib/db/encryption-keys";

// Re-export the keyset-version helper so existing callers that know
// `secret-encryption.ts` as the canonical helper surface keep working
// — but don't build new code against this path. Import from
// `encryption-keys.ts` directly so the integration-store test files
// that partially-mock secret-encryption don't need updating when new
// encryption helpers land.
export { activeKeyVersion } from "@atlas/api/lib/db/encryption-keys";

const log = createLogger("secret-encryption");

const ENCRYPTION_ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

/**
 * Thrown by `decryptSecret` when the ciphertext's `enc:v<N>:` prefix
 * references a version that isn't in the currently-configured keyset.
 *
 * Distinct from a generic decrypt failure because the remediation is
 * different: an `UnknownKeyVersionError` is an *operator misconfig*
 * (legacy key dropped from `ATLAS_ENCRYPTION_KEYS` before rotation
 * finished), not data corruption. `pickDecryptedSecret` distinguishes
 * these so a dropped key surfaces as a `log.error` with a distinct
 * breadcrumb instead of hiding inside the generic F-41 "fall back to
 * plaintext" warn — otherwise the integration keeps working silently
 * until the follow-up plaintext-drop (#1832) turns every read into a
 * 500 with no warning history.
 */
export class UnknownKeyVersionError extends Error {
  readonly _tag = "UnknownKeyVersionError" as const;
  readonly version: number;
  readonly activeVersion: number;
  constructor(version: number, activeVersion: number) {
    super(`Cannot decrypt secret: key version v${version} not present in ATLAS_ENCRYPTION_KEYS`);
    this.name = "UnknownKeyVersionError";
    this.version = version;
    this.activeVersion = activeVersion;
  }
}

/**
 * F-47 versioned prefix format: `enc:v<N>:iv:authTag:ciphertext`. The
 * version label points into the active keyset (`ATLAS_ENCRYPTION_KEYS`
 * / `ATLAS_ENCRYPTION_KEY` / `BETTER_AUTH_SECRET`). Pre-F-47 ciphertext
 * landed as `enc:v1:` explicitly; that's still readable because v1 is
 * the implicit version of the legacy single-key env vars.
 */
const PREFIXED_RE = /^enc:v(\d+):(.+)$/s;

/** Check for any `enc:v<N>:` prefix without buying into a specific version. */
function hasVersionedPrefix(stored: string): boolean {
  return PREFIXED_RE.test(stored);
}

// Boot-time alarm: in production without a key configured, every new
// credential gets stored plaintext via the passthrough in `encryptSecret`.
// The audit-level fallback is intentional (dev + self-hosted without a
// secret should still work), but SaaS deployments are expected to set
// one and the silent pass-through would otherwise only surface on a
// read of pre-encrypted data — too late. Fire once at module load.
(() => {
  const isProdLike =
    process.env.NODE_ENV === "production" || process.env.ATLAS_DEPLOY_MODE === "saas";
  if (isProdLike && !getEncryptionKeyset()) {
    log.error(
      "No encryption key configured (ATLAS_ENCRYPTION_KEYS / ATLAS_ENCRYPTION_KEY / BETTER_AUTH_SECRET) — " +
      "integration credentials will be written plaintext. This is a P0 in SaaS mode.",
    );
  }
})();

/**
 * Encrypts an arbitrary secret string under the active keyset entry,
 * tagged with a `enc:v<N>:` prefix so `decryptSecret` can look up the
 * right key even after a rotation (F-47). Returns the plaintext
 * unchanged if no encryption key is configured, matching encryptUrl's
 * dev-friendly semantics.
 */
export function encryptSecret(plaintext: string): string {
  const keyset = getEncryptionKeyset();
  if (!keyset) return plaintext;

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, keyset.active.key, iv, { authTagLength: AUTH_TAG_LENGTH });
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return `enc:v${keyset.active.version}:${iv.toString("base64")}:${authTag.toString("base64")}:${encrypted.toString("base64")}`;
}

/**
 * Decrypts a value produced by `encryptSecret`. Values not carrying a
 * `enc:v<N>:` prefix are returned unchanged — safe on legacy rows that
 * predate dual-write and on deployments with no key set.
 *
 * Throws when:
 *   • the value carries `enc:v<N>:` but `N` isn't in the current
 *     keyset (config error — operator must add the legacy key back);
 *   • the body is malformed or AES-GCM auth-tag verification fails
 *     (corruption — caller should surface a 500 with `requestId` or
 *     fall back to a plaintext column via `pickDecryptedSecret`).
 */
export function decryptSecret(stored: string): string {
  if (!hasVersionedPrefix(stored)) return stored;

  const keyset = getEncryptionKeyset();
  if (!keyset) {
    log.error("Encrypted secret found but no encryption key is available — set ATLAS_ENCRYPTION_KEYS / ATLAS_ENCRYPTION_KEY / BETTER_AUTH_SECRET");
    throw new Error("Cannot decrypt secret: no encryption key available");
  }

  const match = stored.match(PREFIXED_RE);
  // `hasVersionedPrefix` above guarantees a match here; the check
  // exists only to satisfy strict narrowing without a non-null assertion.
  if (!match) throw new Error("Failed to decrypt secret: unrecognized format");

  const version = Number.parseInt(match[1], 10);
  const key = keyset.byVersion.get(version);
  if (!key) {
    log.error(
      { version, active: keyset.active.version },
      "Encrypted secret references an unknown key version — ATLAS_ENCRYPTION_KEYS is missing this version",
    );
    throw new UnknownKeyVersionError(version, keyset.active.version);
  }

  const body = match[2];
  const parts = body.split(":");
  if (parts.length !== 3) {
    log.error({ partCount: parts.length, version }, "Stored secret has enc:v<N>: prefix but body does not match encrypted format (expected 3 colon-separated parts)");
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
      { err: err instanceof Error ? err.message : String(err), version },
      "Failed to decrypt secret — data may be corrupted or key material may have changed",
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
 * F-47: `UnknownKeyVersionError` (the ciphertext's `enc:v<N>:` points
 * at a version missing from the keyset) is logged at `error` level, not
 * `warn`. Rationale: every other decrypt failure is data-corruption
 * drift, but a missing version is *operator misconfig* — the legacy
 * key was dropped before the rotation script finished. Same symptom,
 * different remediation, so the breadcrumbs must not blur together
 * (the generic F-41 warn path was hiding this class of misconfig
 * silently until #1832 turned every read into a 500). Sentry-grade
 * alert wiring should page on the `error`, not sample the warn stream.
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
      if (err instanceof UnknownKeyVersionError) {
        log.error(
          { version: err.version, activeVersion: err.activeVersion },
          "F-47 dropped-legacy-key: ciphertext references an unknown key version — " +
          "ATLAS_ENCRYPTION_KEYS is missing the version the row was written under. " +
          "Falling back to plaintext column (soak); post-#1832 this will 500. " +
          "Add the legacy key back under the right v<N>: label and run the rotation script.",
        );
      } else {
        log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "Encrypted column failed to decrypt — falling back to plaintext column (F-41 soak)",
        );
      }
    }
  }
  if (typeof plaintextValue === "string" && plaintextValue.length > 0) {
    return plaintextValue;
  }
  return null;
}
