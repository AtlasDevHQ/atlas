/**
 * Tests for the `encryptSecret` / `decryptSecret` / `pickDecryptedSecret`
 * helpers that F-41 (workspace integration credential encryption) relies
 * on. Covers the three contracts the integration stores depend on:
 *
 *   1. Round-trip: decryptSecret(encryptSecret(x)) === x when a key is set.
 *   2. Passthrough: with no key, both helpers become no-ops so dev still works.
 *   3. Plaintext tolerance: decryptSecret leaves un-prefixed values alone, so
 *      the read path is safe on legacy rows not yet touched by the backfill.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  encryptSecret,
  decryptSecret,
  pickDecryptedSecret,
  UnknownKeyVersionError,
} from "../secret-encryption";
import { _resetEncryptionKeyCache } from "../internal";

describe("secret encryption helpers", () => {
  const savedKey = process.env.ATLAS_ENCRYPTION_KEY;
  const savedKeys = process.env.ATLAS_ENCRYPTION_KEYS;
  const savedAuth = process.env.BETTER_AUTH_SECRET;

  beforeEach(() => {
    _resetEncryptionKeyCache();
  });

  afterEach(() => {
    if (savedKey !== undefined) process.env.ATLAS_ENCRYPTION_KEY = savedKey;
    else delete process.env.ATLAS_ENCRYPTION_KEY;
    if (savedKeys !== undefined) process.env.ATLAS_ENCRYPTION_KEYS = savedKeys;
    else delete process.env.ATLAS_ENCRYPTION_KEYS;
    if (savedAuth !== undefined) process.env.BETTER_AUTH_SECRET = savedAuth;
    else delete process.env.BETTER_AUTH_SECRET;
    _resetEncryptionKeyCache();
  });

  describe("with an encryption key configured", () => {
    beforeEach(() => {
      process.env.ATLAS_ENCRYPTION_KEY = "atlas-test-encryption-key";
      delete process.env.ATLAS_ENCRYPTION_KEYS;
      delete process.env.BETTER_AUTH_SECRET;
      _resetEncryptionKeyCache();
    });

    it("round-trips a Slack bot token", () => {
      const plaintext = "xoxb-1234567890-ABCDEFGHIJ-abcdefghij1234567890abcd";
      const encrypted = encryptSecret(plaintext);
      expect(encrypted.startsWith("enc:v1:")).toBe(true);
      expect(encrypted).not.toContain(plaintext);
      expect(decryptSecret(encrypted)).toBe(plaintext);
    });

    it("round-trips a Telegram bot token that contains colons", () => {
      // Telegram tokens look like "1234:ABC..." — colons in the plaintext
      // would trip up encryptUrl's colon-count heuristic. encryptSecret
      // uses a versioned prefix instead so this round-trips cleanly.
      const plaintext = "1234567890:ABC-DEF_ghij1234:klmnopqrstuv";
      const encrypted = encryptSecret(plaintext);
      expect(decryptSecret(encrypted)).toBe(plaintext);
    });

    it("round-trips a JSON blob (email/sandbox credential carrier)", () => {
      const blob = JSON.stringify({ apiKey: "sk-abc:def", region: "us-east-1" });
      const encrypted = encryptSecret(blob);
      expect(encrypted.startsWith("enc:v1:")).toBe(true);
      expect(JSON.parse(decryptSecret(encrypted))).toEqual({ apiKey: "sk-abc:def", region: "us-east-1" });
    });

    it("produces a different ciphertext for the same plaintext (random IV)", () => {
      const a = encryptSecret("same-secret");
      const b = encryptSecret("same-secret");
      expect(a).not.toBe(b);
      expect(decryptSecret(a)).toBe("same-secret");
      expect(decryptSecret(b)).toBe("same-secret");
    });

    it("decryptSecret returns un-prefixed values verbatim (legacy row back-compat)", () => {
      expect(decryptSecret("xoxb-legacy-plaintext")).toBe("xoxb-legacy-plaintext");
      expect(decryptSecret('{"apiKey":"legacy"}')).toBe('{"apiKey":"legacy"}');
    });

    it("decryptSecret throws on a prefixed but malformed payload", () => {
      // Prefix present but body has only two parts instead of three.
      expect(() => decryptSecret("enc:v1:abc:def")).toThrow("Failed to decrypt secret");
    });

    it("rejects plaintext that accidentally begins with enc:v1: (prefix is reserved)", () => {
      // If a legacy plaintext credential starts with `enc:v1:` it WILL
      // be mis-treated as ciphertext and throw. This is the documented
      // contract — the `enc:v1:` prefix is reserved and a future
      // refactor must not "helpfully" fall back to passthrough.
      expect(() => decryptSecret("enc:v1:fake-legacy-plaintext-value")).toThrow(
        "Failed to decrypt secret",
      );
    });

    it("throws with actionable message when decrypt key differs from encrypt key (F-47 rotation)", () => {
      const ciphertext = encryptSecret("secret");
      // Swap the configured key — the cached key is reset so getEncryptionKey
      // picks up the new env var.
      process.env.ATLAS_ENCRYPTION_KEY = "different-key";
      _resetEncryptionKeyCache();
      expect(() => decryptSecret(ciphertext)).toThrow("Failed to decrypt secret");
    });
  });

  describe("key precedence", () => {
    // Pins the documented contract: ATLAS_ENCRYPTION_KEY wins over
    // BETTER_AUTH_SECRET when both are set. A regression that flipped
    // the precedence would invalidate every previously-encrypted row.
    it("ATLAS_ENCRYPTION_KEY takes precedence over BETTER_AUTH_SECRET", () => {
      delete process.env.ATLAS_ENCRYPTION_KEYS;
      process.env.ATLAS_ENCRYPTION_KEY = "atlas-key";
      process.env.BETTER_AUTH_SECRET = "auth-secret";
      _resetEncryptionKeyCache();
      const ciphertext = encryptSecret("precedence-test");

      // Remove ATLAS_ key so only BETTER_AUTH_SECRET is visible — decrypt
      // must fail because it was encrypted under ATLAS_ENCRYPTION_KEY.
      delete process.env.ATLAS_ENCRYPTION_KEY;
      _resetEncryptionKeyCache();
      expect(() => decryptSecret(ciphertext)).toThrow("Failed to decrypt secret");
    });
  });

  describe("without an encryption key configured", () => {
    beforeEach(() => {
      delete process.env.ATLAS_ENCRYPTION_KEY;
      delete process.env.ATLAS_ENCRYPTION_KEYS;
      delete process.env.BETTER_AUTH_SECRET;
      _resetEncryptionKeyCache();
    });

    it("encryptSecret passes the value through unchanged", () => {
      expect(encryptSecret("dev-token")).toBe("dev-token");
    });

    it("decryptSecret still tolerates plaintext values", () => {
      expect(decryptSecret("dev-token")).toBe("dev-token");
    });

    it("decryptSecret throws on a prefixed value it cannot unwrap", () => {
      expect(() => decryptSecret("enc:v1:iv:tag:ciphertext")).toThrow();
    });
  });

  describe("F-47 dual-key / rotation (ATLAS_ENCRYPTION_KEYS)", () => {
    beforeEach(() => {
      delete process.env.ATLAS_ENCRYPTION_KEY;
      delete process.env.BETTER_AUTH_SECRET;
      delete process.env.ATLAS_ENCRYPTION_KEYS;
      _resetEncryptionKeyCache();
    });

    it("reads legacy v1 ciphertext after promoting a new v2 active key", () => {
      // Phase A: v1 key only — write ciphertext.
      process.env.ATLAS_ENCRYPTION_KEYS = "v1:old-raw";
      _resetEncryptionKeyCache();
      const legacyCiphertext = encryptSecret("rotation-secret");
      expect(legacyCiphertext.startsWith("enc:v1:")).toBe(true);

      // Phase B: rotate — v2 is active, v1 kept as legacy so old rows decrypt.
      process.env.ATLAS_ENCRYPTION_KEYS = "v2:new-raw,v1:old-raw";
      _resetEncryptionKeyCache();
      expect(decryptSecret(legacyCiphertext)).toBe("rotation-secret");

      // New writes stamp v2.
      const freshCiphertext = encryptSecret("fresh-secret");
      expect(freshCiphertext.startsWith("enc:v2:")).toBe(true);
      expect(decryptSecret(freshCiphertext)).toBe("fresh-secret");
    });

    it("throws a configuration-specific error when the ciphertext version is missing from the keyset", () => {
      // Write under v2-active keyset.
      process.env.ATLAS_ENCRYPTION_KEYS = "v2:new-raw,v1:old-raw";
      _resetEncryptionKeyCache();
      const v2Ciphertext = encryptSecret("orphaned-row");
      expect(v2Ciphertext.startsWith("enc:v2:")).toBe(true);

      // Operator rolls back to a v1-only config by mistake (dropping the
      // brand-new active key). v2 ciphertext becomes un-readable — the
      // error message has to name the missing version so the runbook is
      // actionable.
      process.env.ATLAS_ENCRYPTION_KEYS = "v1:old-raw";
      _resetEncryptionKeyCache();
      expect(() => decryptSecret(v2Ciphertext)).toThrow(/v2|not present|missing/i);
    });

    it("throws UnknownKeyVersionError (not plain Error) so pickDecryptedSecret can escalate the breadcrumb", () => {
      // The typed error drives the F-47 `pickDecryptedSecret` log.error
      // path — a generic Error would hide operator misconfig inside the
      // "F-41 soak" warn stream. This pin makes sure a future refactor
      // that "simplifies" the throw back to `new Error(...)` can't
      // silently regress the alerting path.
      process.env.ATLAS_ENCRYPTION_KEYS = "v2:new-raw,v1:old-raw";
      _resetEncryptionKeyCache();
      const v2Ciphertext = encryptSecret("orphaned-row");

      process.env.ATLAS_ENCRYPTION_KEYS = "v1:old-raw";
      _resetEncryptionKeyCache();
      try {
        decryptSecret(v2Ciphertext);
        throw new Error("decryptSecret should have thrown UnknownKeyVersionError");
      } catch (err) {
        expect(err).toBeInstanceOf(UnknownKeyVersionError);
        const e = err as UnknownKeyVersionError;
        expect(e.version).toBe(2);
        expect(e.activeVersion).toBe(1);
        expect(e._tag).toBe("UnknownKeyVersionError");
      }
    });

    it("encryptSecret writes with the version label of the active (first) keyset entry, not the highest number", () => {
      // The keyset can carry a higher-numbered legacy key temporarily
      // mid-rollback. Active is defined by position 0, not magnitude.
      process.env.ATLAS_ENCRYPTION_KEYS = "v1:primary,v2:retired";
      _resetEncryptionKeyCache();
      const ciphertext = encryptSecret("pinning-active");
      expect(ciphertext.startsWith("enc:v1:")).toBe(true);
    });

    it("bare (unprefixed) ATLAS_ENCRYPTION_KEYS entries get positional versions (count..1)", () => {
      process.env.ATLAS_ENCRYPTION_KEYS = "newraw,oldraw";
      _resetEncryptionKeyCache();
      const ciphertext = encryptSecret("positional");
      // Two entries → first gets version 2, last gets version 1.
      expect(ciphertext.startsWith("enc:v2:")).toBe(true);
      expect(decryptSecret(ciphertext)).toBe("positional");
    });
  });

  describe("pickDecryptedSecret", () => {
    beforeEach(() => {
      process.env.ATLAS_ENCRYPTION_KEY = "atlas-test-encryption-key";
      delete process.env.ATLAS_ENCRYPTION_KEYS;
      delete process.env.BETTER_AUTH_SECRET;
      _resetEncryptionKeyCache();
    });

    it("prefers the encrypted column when present", () => {
      const encrypted = encryptSecret("encrypted-value");
      expect(pickDecryptedSecret(encrypted, "plaintext-value")).toBe("encrypted-value");
    });

    it("falls back to plaintext when encrypted is missing", () => {
      expect(pickDecryptedSecret(null, "plaintext-value")).toBe("plaintext-value");
      expect(pickDecryptedSecret(undefined, "plaintext-value")).toBe("plaintext-value");
      expect(pickDecryptedSecret("", "plaintext-value")).toBe("plaintext-value");
    });

    it("returns null when both columns are empty (malformed row)", () => {
      expect(pickDecryptedSecret(null, null)).toBeNull();
      expect(pickDecryptedSecret("", "")).toBeNull();
      expect(pickDecryptedSecret(undefined, undefined)).toBeNull();
    });

    it("ignores non-string types from the driver", () => {
      expect(pickDecryptedSecret(123, "plaintext-value")).toBe("plaintext-value");
      expect(pickDecryptedSecret(null, 42)).toBeNull();
    });

    it("falls back to plaintext when encrypted decodes unsuccessfully (F-41 soak)", () => {
      // Corrupted ciphertext — the decrypt-failure fallback to plaintext
      // is what keeps a single bad row from taking down an integration
      // while the plaintext copy is still there during the soak period.
      expect(
        pickDecryptedSecret("enc:v1:malformed", "working-plaintext"),
      ).toBe("working-plaintext");
    });

    it("returns null when encrypted fails AND plaintext is also missing", () => {
      // Defensive: don't silently return the malformed ciphertext — the
      // caller should treat this as a bad row and move on.
      expect(pickDecryptedSecret("enc:v1:malformed", null)).toBeNull();
    });

    it("F-47: UnknownKeyVersionError still falls back to plaintext (soak), but the escalated log.error path is exercised", () => {
      // Write under v2-active keyset, then remove v2 so the ciphertext
      // becomes un-decryptable with the current keyset. The fallback to
      // plaintext must still succeed during the F-41 soak — but behind
      // the scenes the dropped-key breadcrumb goes to `log.error`, not
      // the generic `log.warn` path, so ops alerting wakes up.
      delete process.env.ATLAS_ENCRYPTION_KEY;
      process.env.ATLAS_ENCRYPTION_KEYS = "v2:new-raw,v1:old-raw";
      _resetEncryptionKeyCache();
      const v2Ciphertext = encryptSecret("soaked-secret");

      process.env.ATLAS_ENCRYPTION_KEYS = "v1:old-raw";
      _resetEncryptionKeyCache();
      // Plaintext column still carries the usable value during the F-41
      // soak. Caller behaviour is "return the plaintext" — the
      // escalation is a *logging* distinction, not a contract shift.
      expect(
        pickDecryptedSecret(v2Ciphertext, "soaked-secret"),
      ).toBe("soaked-secret");
    });
  });
});
