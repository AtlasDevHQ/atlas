/**
 * Tests for the F-42 encrypt/decrypt walkers in `plugins/secrets.ts`.
 *
 * These walk the same three-state `ConfigSchema` shape used by
 * `maskSecretFields` / `restoreMaskedSecrets` but, instead of placeholder
 * substitution, they wrap / unwrap the value through `encryptSecret` /
 * `decryptSecret`. The contract we pin here:
 *
 *   1. Round-trip: decryptSecretFields(encryptSecretFields(c, s), s) === c
 *      for every secret-declaring schema.
 *   2. Selective: non-secret keys stay as plain JSONB values (grep-able for
 *      DB ops; anything else would defeat the point of leaving them
 *      plaintext in the first place).
 *   3. Fail-closed-on-corrupt: same philosophy as the F-43 walkers — if we
 *      can't read the schema we can't know which keys are secret, so every
 *      string value in the config is encrypted/decrypted defensively.
 *   4. Idempotent re-encryption: running encryptSecretFields on an already-
 *      encrypted blob is a no-op (value already begins with `enc:v1:`).
 *      The backfill script relies on this.
 *   5. Decryption failures surface loudly — the plugin runtime has no safe
 *      fallback for a missing credential, so a thrown error is preferable
 *      to silently returning null.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import type { ConfigSchemaField } from "../registry";
import type { ConfigSchema } from "../secrets";
import {
  encryptSecretFields,
  decryptSecretFields,
  isEncryptedSecret,
} from "../secrets";
import { _resetEncryptionKeyCache } from "../../db/internal";

const parsed = (fields: ConfigSchemaField[]): ConfigSchema => ({ state: "parsed", fields });
const absent: ConfigSchema = { state: "absent" };

describe("encryptSecretFields / decryptSecretFields (F-42)", () => {
  const savedKey = process.env.ATLAS_ENCRYPTION_KEY;
  const savedAuth = process.env.BETTER_AUTH_SECRET;

  beforeEach(() => {
    process.env.ATLAS_ENCRYPTION_KEY = "atlas-test-f42-encryption-key";
    delete process.env.BETTER_AUTH_SECRET;
    _resetEncryptionKeyCache();
  });

  afterEach(() => {
    if (savedKey !== undefined) process.env.ATLAS_ENCRYPTION_KEY = savedKey;
    else delete process.env.ATLAS_ENCRYPTION_KEY;
    if (savedAuth !== undefined) process.env.BETTER_AUTH_SECRET = savedAuth;
    else delete process.env.BETTER_AUTH_SECRET;
    _resetEncryptionKeyCache();
  });

  describe("encryptSecretFields", () => {
    it("encrypts only `secret: true` fields and leaves non-secrets as plain JSONB", () => {
      const schema = parsed([
        { key: "apiKey", type: "string", secret: true },
        { key: "apiSecret", type: "string", secret: true },
        { key: "region", type: "string" },
        { key: "port", type: "number" },
        { key: "debug", type: "boolean" },
      ]);

      const out = encryptSecretFields(
        { apiKey: "sk-live-1", apiSecret: "secret-2", region: "us-east-1", port: 5432, debug: true },
        schema,
      );

      expect(isEncryptedSecret(out.apiKey)).toBe(true);
      expect(isEncryptedSecret(out.apiSecret)).toBe(true);
      expect(out.region).toBe("us-east-1");
      expect(out.port).toBe(5432);
      expect(out.debug).toBe(true);
      // Plaintext must not appear anywhere on the encrypted side.
      expect(JSON.stringify(out)).not.toContain("sk-live-1");
      expect(JSON.stringify(out)).not.toContain("secret-2");
    });

    it("round-trips through decryptSecretFields", () => {
      const schema = parsed([
        { key: "apiKey", type: "string", secret: true },
        { key: "region", type: "string" },
      ]);
      const original = { apiKey: "sk-live-1", region: "us-east-1" };
      const encrypted = encryptSecretFields(original, schema);
      const decrypted = decryptSecretFields(encrypted, schema);
      expect(decrypted).toEqual(original);
    });

    it("is idempotent — re-encrypting an already-encrypted field is a no-op", () => {
      const schema = parsed([{ key: "apiKey", type: "string", secret: true }]);
      const first = encryptSecretFields({ apiKey: "sk-live-1" }, schema);
      const firstCiphertext = first.apiKey;
      const second = encryptSecretFields(first, schema);
      // Same ciphertext — no fresh IV. Backfill script relies on this to
      // be safely re-runnable.
      expect(second.apiKey).toBe(firstCiphertext);
      expect(isEncryptedSecret(second.apiKey)).toBe(true);
    });

    it("passes non-string secret values through unchanged (null / undefined / empty)", () => {
      // Matches maskSecretFields' "distinguish set from unset" semantics.
      // An unset secret must stay unset, not become `encryptSecret("")`.
      const schema = parsed([{ key: "apiKey", type: "string", secret: true }]);
      expect(encryptSecretFields({ apiKey: "" }, schema).apiKey).toBe("");
      expect(encryptSecretFields({ apiKey: null }, schema).apiKey).toBeNull();
      expect(encryptSecretFields({}, schema)).not.toHaveProperty("apiKey");
    });

    it("coerces null / non-object config to `{}` (write path runs before persist)", () => {
      // Unlike maskSecretFields (which uses null as the "not installed"
      // signal to the UI), the encrypt walker runs on the write path where
      // "not installed" isn't reachable — callers persist the returned
      // object verbatim, so an empty JSONB blob is the right shape.
      const schema = parsed([{ key: "apiKey", type: "string", secret: true }]);
      expect(encryptSecretFields(null, schema)).toEqual({});
    });

    it("returns empty object for non-object configs (defensive — DB drift)", () => {
      const schema = parsed([{ key: "apiKey", type: "string", secret: true }]);
      expect(encryptSecretFields("string", schema)).toEqual({});
      expect(encryptSecretFields([1, 2, 3], schema)).toEqual({});
    });

    it("passes every field through unchanged on absent schema (no secret declared)", () => {
      const input = { apiKey: "sk-live-1", region: "us" };
      const out = encryptSecretFields(input, absent);
      expect(out).toEqual(input);
    });

    it("only treats strict boolean `secret: true` as a secret — never coerces string 'true'", () => {
      const loose = parsed([
        { key: "apiKey", type: "string", secret: "true" as unknown as boolean },
      ]);
      const out = encryptSecretFields({ apiKey: "sk-live-1" }, loose);
      // secret wasn't strict-true → not encrypted
      expect(out.apiKey).toBe("sk-live-1");
    });

    it("fail-closes on corrupt schema by encrypting every non-empty string value", () => {
      // A malformed schema means we can't distinguish secrets from non-
      // secrets. Encrypting every string mirrors maskSecretFields' fail-
      // closed behavior: we prefer a momentarily-unreadable config over
      // persisting a credential plaintext after a migration typo.
      const corrupt: ConfigSchema = { state: "corrupt", reason: "expected array, got object" };
      const out = encryptSecretFields(
        { apiKey: "sk-live-1", port: 5432, debug: true, region: "us" },
        corrupt,
      );
      expect(isEncryptedSecret(out.apiKey)).toBe(true);
      expect(isEncryptedSecret(out.region)).toBe(true);
      expect(out.port).toBe(5432);      // numbers pass through
      expect(out.debug).toBe(true);     // booleans pass through
    });

    it("does not mutate the input config", () => {
      const schema = parsed([{ key: "apiKey", type: "string", secret: true }]);
      const input = { apiKey: "sk-live-1" };
      encryptSecretFields(input, schema);
      expect(input.apiKey).toBe("sk-live-1");
    });
  });

  describe("decryptSecretFields", () => {
    it("decrypts only `secret: true` fields — non-secret plaintext passes through", () => {
      const schema = parsed([
        { key: "apiKey", type: "string", secret: true },
        { key: "region", type: "string" },
      ]);
      const encrypted = encryptSecretFields(
        { apiKey: "sk-live-1", region: "us-east-1" },
        schema,
      );
      const out = decryptSecretFields(encrypted, schema);
      expect(out).toEqual({ apiKey: "sk-live-1", region: "us-east-1" });
    });

    it("is idempotent on plaintext values (legacy pre-backfill row back-compat)", () => {
      // A row that predates the F-42 backfill has plaintext secret values
      // without the `enc:v1:` prefix. `decryptSecret` passes those through
      // unchanged; decryptSecretFields must do the same so the plugin
      // runtime keeps working during the backfill window.
      const schema = parsed([{ key: "apiKey", type: "string", secret: true }]);
      const out = decryptSecretFields({ apiKey: "sk-legacy-plaintext" }, schema);
      expect(out.apiKey).toBe("sk-legacy-plaintext");
    });

    it("throws loudly on a corrupted ciphertext — no silent null or plaintext fallback", () => {
      // If a ciphertext can't be decrypted we surface, because the plugin
      // runtime has no safe fallback — a dispatched action with a null
      // credential is worse than a 500.
      const schema = parsed([{ key: "apiKey", type: "string", secret: true }]);
      expect(() =>
        decryptSecretFields({ apiKey: "enc:v1:garbage:garbage:garbage" }, schema),
      ).toThrow(/decrypt/i);
    });

    it("coerces null / non-object config to `{}` (callers don't need a null check)", () => {
      const schema = parsed([{ key: "apiKey", type: "string", secret: true }]);
      expect(decryptSecretFields(null, schema)).toEqual({});
    });

    it("passes every field through unchanged on absent schema", () => {
      const input = { apiKey: "sk-live-1", region: "us" };
      const out = decryptSecretFields(input, absent);
      expect(out).toEqual(input);
    });

    it("fail-closes on corrupt schema by decrypting every enc:v1: string value", () => {
      // Symmetric with encryptSecretFields: if the schema is unreadable,
      // every `enc:v1:...` value gets a decrypt attempt. Non-prefixed strings
      // pass through (legacy rows that never got the backfill).
      const corrupt: ConfigSchema = { state: "corrupt", reason: "expected array, got null" };
      const source = encryptSecretFields({ apiKey: "sk-live-1", region: "us-east-1" }, corrupt);
      const out = decryptSecretFields(source, corrupt);
      expect(out.apiKey).toBe("sk-live-1");
      expect(out.region).toBe("us-east-1");
    });

    it("does not mutate the input config", () => {
      const schema = parsed([{ key: "apiKey", type: "string", secret: true }]);
      const encrypted = encryptSecretFields({ apiKey: "sk-live-1" }, schema);
      const ciphertext = encrypted.apiKey;
      decryptSecretFields(encrypted, schema);
      expect(encrypted.apiKey).toBe(ciphertext);
    });
  });

  describe("isEncryptedSecret", () => {
    it("recognizes the enc:v1: prefix", () => {
      const schema = parsed([{ key: "apiKey", type: "string", secret: true }]);
      const encrypted = encryptSecretFields({ apiKey: "sk-live-1" }, schema);
      expect(isEncryptedSecret(encrypted.apiKey)).toBe(true);
    });

    it("rejects plaintext, numbers, null, and other non-ciphertext shapes", () => {
      expect(isEncryptedSecret("sk-live-1")).toBe(false);
      expect(isEncryptedSecret("")).toBe(false);
      expect(isEncryptedSecret(42)).toBe(false);
      expect(isEncryptedSecret(null)).toBe(false);
      expect(isEncryptedSecret(undefined)).toBe(false);
      expect(isEncryptedSecret({ apiKey: "sk" })).toBe(false);
    });
  });

  describe("passthrough when no encryption key configured", () => {
    beforeEach(() => {
      // Override the outer describe's beforeEach: no key set.
      delete process.env.ATLAS_ENCRYPTION_KEY;
      delete process.env.BETTER_AUTH_SECRET;
      _resetEncryptionKeyCache();
    });

    it("encryptSecretFields returns plaintext (dev / self-hosted without a key)", () => {
      // Mirrors encryptSecret's passthrough semantics — the boot-time alarm
      // in db/secret-encryption.ts fires once when ATLAS_DEPLOY_MODE=saas
      // with no key, but the walker itself does not diverge from the scalar
      // helper so the contract stays consistent.
      const schema = parsed([{ key: "apiKey", type: "string", secret: true }]);
      const out = encryptSecretFields({ apiKey: "sk-live-1" }, schema);
      expect(out.apiKey).toBe("sk-live-1");
      expect(isEncryptedSecret(out.apiKey)).toBe(false);
    });

    it("decryptSecretFields round-trips plaintext when no key is set", () => {
      const schema = parsed([{ key: "apiKey", type: "string", secret: true }]);
      const out = decryptSecretFields({ apiKey: "sk-live-1" }, schema);
      expect(out.apiKey).toBe("sk-live-1");
    });
  });
});
