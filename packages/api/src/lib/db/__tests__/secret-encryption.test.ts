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
} from "../secret-encryption";
import { _resetEncryptionKeyCache } from "../internal";

describe("secret encryption helpers", () => {
  const savedKey = process.env.ATLAS_ENCRYPTION_KEY;
  const savedAuth = process.env.BETTER_AUTH_SECRET;

  beforeEach(() => {
    _resetEncryptionKeyCache();
  });

  afterEach(() => {
    if (savedKey !== undefined) process.env.ATLAS_ENCRYPTION_KEY = savedKey;
    else delete process.env.ATLAS_ENCRYPTION_KEY;
    if (savedAuth !== undefined) process.env.BETTER_AUTH_SECRET = savedAuth;
    else delete process.env.BETTER_AUTH_SECRET;
    _resetEncryptionKeyCache();
  });

  describe("with an encryption key configured", () => {
    beforeEach(() => {
      process.env.ATLAS_ENCRYPTION_KEY = "atlas-test-encryption-key";
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
  });

  describe("without an encryption key configured", () => {
    beforeEach(() => {
      delete process.env.ATLAS_ENCRYPTION_KEY;
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

  describe("pickDecryptedSecret", () => {
    beforeEach(() => {
      process.env.ATLAS_ENCRYPTION_KEY = "atlas-test-encryption-key";
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
  });
});
