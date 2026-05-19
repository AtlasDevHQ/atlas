/**
 * Tests for the Slack installation encryption helper.
 *
 * Covers the round-trip with `SLACK_ENCRYPTION_KEY` set + the
 * plaintext-fallback path. Cross-format compatibility with
 * `@chat-adapter/slack` is asserted by writing via this helper and
 * reading the envelope shape — the adapter looks for the same
 * `{ iv, data, tag }` triple.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";

const {
  encryptSlackInstallationToken,
  decryptSlackInstallationToken,
  isSlackEncryptedToken,
  decodeSlackEncryptionKey,
  getSlackEncryptionKey,
  resetSlackEncryptionKeyCache,
} = await import("../installation-encryption");

describe("installation-encryption", () => {
  const savedKey = process.env.SLACK_ENCRYPTION_KEY;

  beforeEach(() => {
    delete process.env.SLACK_ENCRYPTION_KEY;
    resetSlackEncryptionKeyCache();
  });

  afterEach(() => {
    if (savedKey !== undefined) process.env.SLACK_ENCRYPTION_KEY = savedKey;
    else delete process.env.SLACK_ENCRYPTION_KEY;
    resetSlackEncryptionKeyCache();
  });

  describe("decodeSlackEncryptionKey", () => {
    it("accepts a 64-char hex string", () => {
      const key = "a".repeat(64);
      const buf = decodeSlackEncryptionKey(key);
      expect(buf.length).toBe(32);
    });

    it("accepts a 44-char base64 string (32 raw bytes)", () => {
      const buf = decodeSlackEncryptionKey(Buffer.alloc(32).toString("base64"));
      expect(buf.length).toBe(32);
    });

    it("throws on the wrong decoded length", () => {
      expect(() => decodeSlackEncryptionKey("short")).toThrow(/32 bytes/);
    });
  });

  describe("getSlackEncryptionKey", () => {
    it("returns null when SLACK_ENCRYPTION_KEY is unset", () => {
      expect(getSlackEncryptionKey()).toBeNull();
    });

    it("decodes the env var once and caches", () => {
      process.env.SLACK_ENCRYPTION_KEY = Buffer.alloc(32).toString("base64");
      resetSlackEncryptionKeyCache();
      const first = getSlackEncryptionKey();
      const second = getSlackEncryptionKey();
      expect(first).toBe(second);
      expect(first?.length).toBe(32);
    });
  });

  describe("encrypt/decrypt round-trip", () => {
    it("returns plaintext when no key is configured", () => {
      const encrypted = encryptSlackInstallationToken("xoxb-test");
      expect(encrypted).toBe("xoxb-test");
      expect(decryptSlackInstallationToken("xoxb-test")).toBe("xoxb-test");
    });

    it("encrypts as an { iv, data, tag } envelope when SLACK_ENCRYPTION_KEY is set", () => {
      process.env.SLACK_ENCRYPTION_KEY = Buffer.alloc(32).toString("base64");
      resetSlackEncryptionKeyCache();

      const encrypted = encryptSlackInstallationToken("xoxb-secret");
      expect(typeof encrypted).toBe("object");
      expect(isSlackEncryptedToken(encrypted)).toBe(true);
      expect(JSON.stringify(encrypted)).not.toContain("xoxb-secret");
    });

    it("round-trips via the envelope when the key is set on both sides", () => {
      process.env.SLACK_ENCRYPTION_KEY = Buffer.alloc(32).toString("base64");
      resetSlackEncryptionKeyCache();

      const encrypted = encryptSlackInstallationToken("xoxb-secret-payload");
      const decrypted = decryptSlackInstallationToken(encrypted);
      expect(decrypted).toBe("xoxb-secret-payload");
    });

    it("decrypts plaintext when the value happens to be a string (legacy rows)", () => {
      process.env.SLACK_ENCRYPTION_KEY = Buffer.alloc(32).toString("base64");
      resetSlackEncryptionKeyCache();

      expect(decryptSlackInstallationToken("xoxb-pre-encryption")).toBe("xoxb-pre-encryption");
    });

    it("throws when the row is encrypted but the key is unset at read time", () => {
      process.env.SLACK_ENCRYPTION_KEY = Buffer.alloc(32).toString("base64");
      resetSlackEncryptionKeyCache();
      const encrypted = encryptSlackInstallationToken("xoxb-secret");

      delete process.env.SLACK_ENCRYPTION_KEY;
      resetSlackEncryptionKeyCache();

      expect(() => decryptSlackInstallationToken(encrypted)).toThrow(/SLACK_ENCRYPTION_KEY/);
    });

    it("throws on a structurally-broken envelope", () => {
      expect(() =>
        decryptSlackInstallationToken({ iv: "x" } as unknown as never),
      ).toThrow(/unexpected shape/);
    });
  });

  describe("isSlackEncryptedToken", () => {
    it("returns true for { iv, data, tag } objects", () => {
      expect(isSlackEncryptedToken({ iv: "a", data: "b", tag: "c" })).toBe(true);
    });

    it("returns false for strings (plaintext)", () => {
      expect(isSlackEncryptedToken("xoxb-plain")).toBe(false);
    });

    it("returns false for partial envelopes", () => {
      expect(isSlackEncryptedToken({ iv: "a", data: "b" })).toBe(false);
    });

    it("returns false for null / undefined", () => {
      expect(isSlackEncryptedToken(null)).toBe(false);
      expect(isSlackEncryptedToken(undefined)).toBe(false);
    });
  });
});
