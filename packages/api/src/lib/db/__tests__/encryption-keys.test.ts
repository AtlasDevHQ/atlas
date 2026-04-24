/**
 * Tests for the F-47 encryption keyset resolver.
 *
 * The keyset resolver is the entry point for key-version-aware
 * encryption. It:
 *   1. Parses ATLAS_ENCRYPTION_KEYS (new, multi-key) or
 *      ATLAS_ENCRYPTION_KEY (legacy single-key) or BETTER_AUTH_SECRET
 *      fallback into an ordered keyset.
 *   2. Identifies the active write key (position 0).
 *   3. Allows decrypt callers to look up a legacy key by version for
 *      ciphertext carrying a `enc:v{N}:` prefix during the rotation
 *      window.
 *
 * These tests pin the resolver's behavior so that rotation procedures
 * and the re-encryption script (scripts/rotate-encryption-key.ts) have
 * stable semantics to build on.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  getEncryptionKeyset,
  getEncryptionKey,
  _resetEncryptionKeyCache,
} from "../internal";

describe("F-47 encryption keyset resolver", () => {
  const savedKey = process.env.ATLAS_ENCRYPTION_KEY;
  const savedKeys = process.env.ATLAS_ENCRYPTION_KEYS;
  const savedAuth = process.env.BETTER_AUTH_SECRET;
  const savedDeployMode = process.env.ATLAS_DEPLOY_MODE;

  beforeEach(() => {
    delete process.env.ATLAS_ENCRYPTION_KEY;
    delete process.env.ATLAS_ENCRYPTION_KEYS;
    delete process.env.BETTER_AUTH_SECRET;
    delete process.env.ATLAS_DEPLOY_MODE;
    _resetEncryptionKeyCache();
  });

  afterEach(() => {
    if (savedKey !== undefined) process.env.ATLAS_ENCRYPTION_KEY = savedKey;
    else delete process.env.ATLAS_ENCRYPTION_KEY;
    if (savedKeys !== undefined) process.env.ATLAS_ENCRYPTION_KEYS = savedKeys;
    else delete process.env.ATLAS_ENCRYPTION_KEYS;
    if (savedAuth !== undefined) process.env.BETTER_AUTH_SECRET = savedAuth;
    else delete process.env.BETTER_AUTH_SECRET;
    if (savedDeployMode !== undefined) process.env.ATLAS_DEPLOY_MODE = savedDeployMode;
    else delete process.env.ATLAS_DEPLOY_MODE;
    _resetEncryptionKeyCache();
  });

  describe("no env vars set", () => {
    it("getEncryptionKeyset() returns null", () => {
      expect(getEncryptionKeyset()).toBeNull();
    });

    it("getEncryptionKey() returns null", () => {
      expect(getEncryptionKey()).toBeNull();
    });
  });

  describe("ATLAS_ENCRYPTION_KEY (legacy single-key)", () => {
    it("treats the value as an implicit v1 keyset", () => {
      process.env.ATLAS_ENCRYPTION_KEY = "single-raw-key";
      const ks = getEncryptionKeyset();
      expect(ks).not.toBeNull();
      expect(ks!.active.version).toBe(1);
      expect(ks!.active.key.length).toBe(32);
      expect(ks!.byVersion.size).toBe(1);
      expect(ks!.byVersion.get(1)?.equals(ks!.active.key)).toBe(true);
      expect(ks!.source).toBe("ATLAS_ENCRYPTION_KEY");
    });

    it("getEncryptionKey() back-compat returns the active buffer", () => {
      process.env.ATLAS_ENCRYPTION_KEY = "single-raw-key";
      const key = getEncryptionKey();
      expect(key).not.toBeNull();
      expect(key!.length).toBe(32);
    });
  });

  describe("BETTER_AUTH_SECRET fallback", () => {
    it("treats the auth secret as an implicit v1 keyset", () => {
      process.env.BETTER_AUTH_SECRET = "auth-only-secret";
      const ks = getEncryptionKeyset();
      expect(ks).not.toBeNull();
      expect(ks!.active.version).toBe(1);
      expect(ks!.source).toBe("BETTER_AUTH_SECRET");
    });

    it("is superseded by ATLAS_ENCRYPTION_KEY when both are set", () => {
      process.env.ATLAS_ENCRYPTION_KEY = "primary";
      process.env.BETTER_AUTH_SECRET = "fallback";
      const ks = getEncryptionKeyset();
      expect(ks!.source).toBe("ATLAS_ENCRYPTION_KEY");
    });

    it("is superseded by ATLAS_ENCRYPTION_KEYS when both are set", () => {
      process.env.ATLAS_ENCRYPTION_KEYS = "v1:primary";
      process.env.BETTER_AUTH_SECRET = "fallback";
      const ks = getEncryptionKeyset();
      expect(ks!.source).toBe("ATLAS_ENCRYPTION_KEYS");
    });
  });

  describe("ATLAS_ENCRYPTION_KEYS (multi-key with explicit versions)", () => {
    it("parses a single v1 entry", () => {
      process.env.ATLAS_ENCRYPTION_KEYS = "v1:rawkey";
      const ks = getEncryptionKeyset();
      expect(ks!.active.version).toBe(1);
      expect(ks!.byVersion.size).toBe(1);
      expect(ks!.source).toBe("ATLAS_ENCRYPTION_KEYS");
    });

    it("parses an ordered list of versioned keys (first = active)", () => {
      process.env.ATLAS_ENCRYPTION_KEYS = "v2:newraw,v1:oldraw";
      const ks = getEncryptionKeyset();
      expect(ks!.active.version).toBe(2);
      expect(ks!.byVersion.get(1)).not.toBeUndefined();
      expect(ks!.byVersion.get(2)).not.toBeUndefined();
      // Active key (v2) must differ from legacy key (v1) — different raw values.
      expect(ks!.byVersion.get(2)!.equals(ks!.byVersion.get(1)!)).toBe(false);
    });

    it("treats bare entries (no version prefix) as positional: first = count, last = 1", () => {
      process.env.ATLAS_ENCRYPTION_KEYS = "firstraw,secondraw,thirdraw";
      const ks = getEncryptionKeyset();
      expect(ks!.active.version).toBe(3);
      expect(ks!.byVersion.get(3)).not.toBeUndefined();
      expect(ks!.byVersion.get(2)).not.toBeUndefined();
      expect(ks!.byVersion.get(1)).not.toBeUndefined();
    });

    it("tolerates whitespace around entries", () => {
      process.env.ATLAS_ENCRYPTION_KEYS = " v2:newraw , v1:oldraw ";
      const ks = getEncryptionKeyset();
      expect(ks!.active.version).toBe(2);
    });

    it("ignores empty entries (e.g. trailing comma)", () => {
      process.env.ATLAS_ENCRYPTION_KEYS = "v2:newraw,v1:oldraw,";
      const ks = getEncryptionKeyset();
      expect(ks!.byVersion.size).toBe(2);
    });

    it("rejects duplicate version numbers with a loud error", () => {
      process.env.ATLAS_ENCRYPTION_KEYS = "v2:a,v2:b";
      expect(() => getEncryptionKeyset()).toThrow(/duplicate|already/i);
    });

    it("rejects a mix of prefixed and unprefixed entries (ambiguous versioning)", () => {
      process.env.ATLAS_ENCRYPTION_KEYS = "v2:newraw,oldraw";
      expect(() => getEncryptionKeyset()).toThrow(/mix|prefix|ambigu/i);
    });

    it("rejects entries with a zero or negative version", () => {
      process.env.ATLAS_ENCRYPTION_KEYS = "v0:zero";
      expect(() => getEncryptionKeyset()).toThrow(/version/i);
    });

    it("rejects entries with a non-numeric version label", () => {
      process.env.ATLAS_ENCRYPTION_KEYS = "vlatest:raw";
      expect(() => getEncryptionKeyset()).toThrow(/version/i);
    });

    it("rejects empty raw material after the version prefix", () => {
      process.env.ATLAS_ENCRYPTION_KEYS = "v2:,v1:oldraw";
      expect(() => getEncryptionKeyset()).toThrow(/empty|missing|raw/i);
    });

    it("derives each key via SHA-256 so raw length is unconstrained", () => {
      process.env.ATLAS_ENCRYPTION_KEYS = "v2:abc,v1:a-much-longer-raw-value-for-the-old-key";
      const ks = getEncryptionKeyset();
      expect(ks!.byVersion.get(1)!.length).toBe(32);
      expect(ks!.byVersion.get(2)!.length).toBe(32);
    });
  });

  describe("caching", () => {
    it("returns the same keyset on repeated reads with identical env", () => {
      process.env.ATLAS_ENCRYPTION_KEYS = "v2:new,v1:old";
      const a = getEncryptionKeyset();
      const b = getEncryptionKeyset();
      expect(a).toBe(b);
    });

    it("repopulates the cache when _resetEncryptionKeyCache() is called", () => {
      process.env.ATLAS_ENCRYPTION_KEY = "first";
      const first = getEncryptionKeyset();

      process.env.ATLAS_ENCRYPTION_KEY = "second";
      _resetEncryptionKeyCache();
      const second = getEncryptionKeyset();

      expect(second).not.toBe(first);
      expect(second!.active.key.equals(first!.active.key)).toBe(false);
    });

    it("invalidates when the env var changes under the same source", () => {
      process.env.ATLAS_ENCRYPTION_KEYS = "v1:first";
      const first = getEncryptionKeyset();
      process.env.ATLAS_ENCRYPTION_KEYS = "v1:second";
      const second = getEncryptionKeyset();
      expect(second).not.toBe(first);
    });
  });
});
