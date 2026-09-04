/**
 * Unit tests for `src/lib/plugins/secrets.ts`.
 *
 * Part 1 — secret-masking helpers used by admin plugin config surfaces. Pins
 * contract-level behavior so admin-marketplace.ts and admin-plugins.ts can rely
 * on the exact MASKED_PLACEHOLDER string + fail-closed malformed schema
 * handling + round-trip semantics across masked + omitted secret fields.
 *
 * Part 2 (formerly `secrets-encryption.test.ts`) — the F-42 encrypt/decrypt
 * walkers. They walk the same three-state `ConfigSchema` shape but, instead of
 * placeholder substitution, wrap / unwrap the value through `encryptSecret` /
 * `decryptSecret`. The contract pinned there:
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
  MASKED_PLACEHOLDER,
  checkStrictPluginSecrets,
  decryptSecretFields,
  encryptSecretFields,
  isConfigFieldActive,
  isEncryptedSecret,
  isStrictPluginSecretsEnabled,
  maskSecretFields,
  parseConfigSchema,
  restoreMaskedSecrets,
} from "../secrets";
import { _resetEncryptionKeyCache } from "../../db/internal";

const parsed = (fields: ConfigSchemaField[]): ConfigSchema => ({ state: "parsed", fields });
const absent: ConfigSchema = { state: "absent" };

describe("MASKED_PLACEHOLDER", () => {
  it("is the exact 8-bullet string", () => {
    // Pinning the exact string defends the write-path restoration path:
    // if the constant drifts, re-submitted placeholders stop getting
    // recognized and start corrupting live secrets.
    expect(MASKED_PLACEHOLDER).toBe("••••••••");
  });
});

describe("parseConfigSchema", () => {
  it("reports absent for null/undefined (no schema configured)", () => {
    expect(parseConfigSchema(null)).toEqual({ state: "absent" });
    expect(parseConfigSchema(undefined)).toEqual({ state: "absent" });
  });

  it("reports corrupt for non-arrays — callers must fail closed, not pass through", () => {
    const corruptObject = parseConfigSchema({ fields: [] });
    expect(corruptObject.state).toBe("corrupt");
    const corruptString = parseConfigSchema("oops");
    expect(corruptString.state).toBe("corrupt");
    const corruptNumber = parseConfigSchema(42);
    expect(corruptNumber.state).toBe("corrupt");
  });

  it("parses an array of field-shaped objects", () => {
    const result = parseConfigSchema([
      { key: "apiKey", type: "string", secret: true },
      { key: "region", type: "string" },
    ]);
    expect(result.state).toBe("parsed");
    if (result.state === "parsed") {
      expect(result.fields).toHaveLength(2);
      expect(result.fields[0]!.key).toBe("apiKey");
      expect(result.fields[0]!.secret).toBe(true);
    }
  });

  it("skips array entries that lack a string `key`", () => {
    const result = parseConfigSchema([{ type: "string" }, { key: "ok" }]);
    expect(result.state).toBe("parsed");
    if (result.state === "parsed") {
      expect(result.fields).toHaveLength(1);
      expect(result.fields[0]!.key).toBe("ok");
    }
  });
});

describe("isConfigFieldActive", () => {
  // Mirrors the admin UI's isFieldVisible so server-side validation only
  // enforces a `showWhen`-gated field when its branch is active. Regression
  // guard for #3842 (ES un-installable because apiKey/awsRegion were demanded
  // in every auth mode).
  const apiKeyField: ConfigSchemaField = {
    key: "apiKey",
    type: "string",
    required: true,
    showWhen: { field: "authMode", equals: ["apiKey"] },
  };

  it("treats a field with no showWhen as always active", () => {
    const url: ConfigSchemaField = { key: "url", type: "string", required: true };
    expect(isConfigFieldActive(url, {})).toBe(true);
    expect(isConfigFieldActive(url, { authMode: "basic" })).toBe(true);
  });

  it("is active when the controller value is in equals", () => {
    expect(isConfigFieldActive(apiKeyField, { authMode: "apiKey" })).toBe(true);
  });

  it("is inactive when the controller value is not in equals (the #3842 case)", () => {
    expect(isConfigFieldActive(apiKeyField, { authMode: "basic" })).toBe(false);
    expect(isConfigFieldActive(apiKeyField, { authMode: "sigv4" })).toBe(false);
  });

  it("is inactive when the controller is absent (coerced to \"\")", () => {
    expect(isConfigFieldActive(apiKeyField, {})).toBe(false);
    expect(isConfigFieldActive(apiKeyField, { authMode: null })).toBe(false);
    expect(isConfigFieldActive(apiKeyField, { authMode: undefined })).toBe(false);
  });

  it("fails open (active) on a malformed gate — never throws on bad JSONB", () => {
    // parseConfigSchema only validates `key`, so a hand-edited row could carry
    // a gate missing `equals` (or `field`). It must fail open, not 500. (#3842)
    const missingEquals = { key: "x", type: "string", showWhen: { field: "authMode" } } as unknown as ConfigSchemaField;
    const missingField = { key: "x", type: "string", showWhen: { equals: ["basic"] } } as unknown as ConfigSchemaField;
    expect(isConfigFieldActive(missingEquals, { authMode: "basic" })).toBe(true);
    expect(isConfigFieldActive(missingField, {})).toBe(true);
  });

  it("matches any value in a multi-value equals", () => {
    const field: ConfigSchemaField = {
      key: "x",
      type: "string",
      showWhen: { field: "mode", equals: ["a", "b"] },
    };
    expect(isConfigFieldActive(field, { mode: "a" })).toBe(true);
    expect(isConfigFieldActive(field, { mode: "b" })).toBe(true);
    expect(isConfigFieldActive(field, { mode: "c" })).toBe(false);
  });
});

describe("maskSecretFields", () => {
  const schema = parsed([
    { key: "apiKey", type: "string", secret: true },
    { key: "region", type: "string" },
  ]);

  it("masks secret: true fields with MASKED_PLACEHOLDER", () => {
    const out = maskSecretFields({ apiKey: "sk-live-1", region: "us-east-1" }, schema);
    expect(out).toEqual({ apiKey: MASKED_PLACEHOLDER, region: "us-east-1" });
  });

  it("only treats strict boolean `secret: true` as a secret — string 'true' is a non-secret leak otherwise", () => {
    const loose = parsed([
      { key: "apiKey", type: "string", secret: "true" as unknown as boolean },
    ]);
    const out = maskSecretFields({ apiKey: "sk-live-1" }, loose);
    expect(out).toEqual({ apiKey: "sk-live-1" });
  });

  it("leaves empty-string and missing secret values unmasked so the UI can tell 'set' from 'unset'", () => {
    const out = maskSecretFields({ apiKey: "", region: "us" }, schema);
    expect(out).toEqual({ apiKey: "", region: "us" });
  });

  it("returns null for null config (not-installed case)", () => {
    expect(maskSecretFields(null, schema)).toBeNull();
  });

  it("returns empty object for non-object configs (defensive — DB should never produce this)", () => {
    expect(maskSecretFields("string", schema)).toEqual({});
    expect(maskSecretFields([1, 2, 3], schema)).toEqual({});
  });

  it("passes all fields through unchanged when schema state is absent or parsed-empty", () => {
    const input = { anything: "goes" };
    expect(maskSecretFields(input, absent)).toEqual(input);
    expect(maskSecretFields(input, parsed([]))).toEqual(input);
  });

  it("fail-closes on corrupt schema by masking every non-empty string — the F-43 disclosure surface", () => {
    const corrupt: ConfigSchema = { state: "corrupt", reason: "expected array, got object" };
    const out = maskSecretFields({ apiKey: "sk-live-1", port: 5432, debug: true, region: "us" }, corrupt);
    expect(out).toEqual({
      apiKey: MASKED_PLACEHOLDER,
      port: 5432,
      debug: true,
      region: MASKED_PLACEHOLDER,
    });
  });

  it("does not mutate the input config", () => {
    const input = { apiKey: "sk-live-1" };
    maskSecretFields(input, schema);
    expect(input.apiKey).toBe("sk-live-1");
  });
});

describe("restoreMaskedSecrets", () => {
  const schema = parsed([
    { key: "apiKey", type: "string", secret: true },
    { key: "region", type: "string" },
  ]);

  it("swaps MASKED_PLACEHOLDER on a secret field for the original persisted value", () => {
    const out = restoreMaskedSecrets(
      { apiKey: MASKED_PLACEHOLDER, region: "eu-west-1" },
      { apiKey: "sk-live-1", region: "us-east-1" },
      schema,
    );
    expect(out.apiKey).toBe("sk-live-1");
    expect(out.region).toBe("eu-west-1");
  });

  it("drops a placeholder secret that has no original — prevents persisting the literal bullet string", () => {
    const out = restoreMaskedSecrets({ apiKey: MASKED_PLACEHOLDER }, {}, schema);
    expect(out).not.toHaveProperty("apiKey");
  });

  it("preserves an omitted secret — UI that only sends dirty fields must not wipe the credential", () => {
    const out = restoreMaskedSecrets(
      { region: "eu-west-1" },
      { apiKey: "sk-live-1", region: "us-east-1" },
      schema,
    );
    expect(out.apiKey).toBe("sk-live-1");
    expect(out.region).toBe("eu-west-1");
  });

  it("respects an explicit clear (empty string or null) — caller opted into the rotation/removal", () => {
    const empty = restoreMaskedSecrets({ apiKey: "" }, { apiKey: "sk-live-1" }, schema);
    expect(empty.apiKey).toBe("");
    const nulled = restoreMaskedSecrets({ apiKey: null }, { apiKey: "sk-live-1" }, schema);
    expect(nulled.apiKey).toBeNull();
  });

  it("leaves a rotated secret (new value, not the placeholder) untouched", () => {
    const out = restoreMaskedSecrets(
      { apiKey: "sk-new" },
      { apiKey: "sk-old" },
      schema,
    );
    expect(out.apiKey).toBe("sk-new");
  });

  it("does not restore on non-secret fields even if value === MASKED_PLACEHOLDER", () => {
    const out = restoreMaskedSecrets(
      { region: MASKED_PLACEHOLDER },
      { region: "us-east-1" },
      schema,
    );
    expect(out.region).toBe(MASKED_PLACEHOLDER);
  });

  it("does not preserve an omitted non-secret field — only secrets get the omit-to-preserve guarantee", () => {
    const out = restoreMaskedSecrets(
      { apiKey: "sk-new" },
      { apiKey: "sk-old", region: "us-east-1" },
      schema,
    );
    expect(out).not.toHaveProperty("region");
  });

  it("returns a new object — does not mutate incoming", () => {
    const incoming = { apiKey: MASKED_PLACEHOLDER };
    const out = restoreMaskedSecrets(incoming, { apiKey: "x" }, schema);
    expect(incoming.apiKey).toBe(MASKED_PLACEHOLDER);
    expect(out.apiKey).toBe("x");
  });

  it("passes incoming through when schema state is absent", () => {
    const incoming = { apiKey: MASKED_PLACEHOLDER };
    expect(restoreMaskedSecrets(incoming, { apiKey: "x" }, absent)).toEqual(incoming);
  });

  it("fail-closes on corrupt schema by restoring every stored key the UI hid or omitted", () => {
    const corrupt: ConfigSchema = { state: "corrupt", reason: "expected array, got object" };
    const out = restoreMaskedSecrets(
      { apiKey: MASKED_PLACEHOLDER, port: 5432 },
      { apiKey: "sk-live-1", region: "us-east-1", port: 5432 },
      corrupt,
    );
    expect(out.apiKey).toBe("sk-live-1");
    expect(out.region).toBe("us-east-1"); // omitted → preserved
    expect(out.port).toBe(5432);
  });
});

// ---------------------------------------------------------------------------
// F-42 strict-mode opt-in (#1835)
// ---------------------------------------------------------------------------

describe("checkStrictPluginSecrets / isStrictPluginSecretsEnabled", () => {
  const savedFlag = process.env.ATLAS_STRICT_PLUGIN_SECRETS;
  afterEach(() => {
    if (savedFlag !== undefined) process.env.ATLAS_STRICT_PLUGIN_SECRETS = savedFlag;
    else delete process.env.ATLAS_STRICT_PLUGIN_SECRETS;
  });

  it("returns null when strict mode is disabled (default)", () => {
    delete process.env.ATLAS_STRICT_PLUGIN_SECRETS;
    expect(isStrictPluginSecretsEnabled()).toBe(false);
    expect(checkStrictPluginSecrets({ state: "corrupt", reason: "bad" })).toBeNull();
    expect(
      checkStrictPluginSecrets(parsed([
        { key: "apiKey", type: "string", secret: true },
      ])),
    ).toBeNull();
  });

  it("treats anything other than the literal 'true' as disabled", () => {
    // Avoid the trap where TRUE / 1 / yes silently enable production
    // strict mode after a string-coercion bug.
    for (const value of ["", "TRUE", "1", "yes", "True"]) {
      process.env.ATLAS_STRICT_PLUGIN_SECRETS = value;
      expect(isStrictPluginSecretsEnabled()).toBe(false);
      expect(checkStrictPluginSecrets({ state: "corrupt", reason: "bad" })).toBeNull();
    }
  });

  it("rejects corrupt schema when strict mode is on", () => {
    process.env.ATLAS_STRICT_PLUGIN_SECRETS = "true";
    expect(isStrictPluginSecretsEnabled()).toBe(true);
    expect(checkStrictPluginSecrets({ state: "corrupt", reason: "expected array, got string" })).toEqual({
      state: "corrupt",
      reason: "expected array, got string",
    });
  });

  it("rejects per-key secret-vs-passthrough drift when strict mode is on", () => {
    process.env.ATLAS_STRICT_PLUGIN_SECRETS = "true";
    const drift = parsed([
      { key: "apiKey", type: "string", secret: true },
      { key: "apiKey", type: "string", secret: false },
    ]);
    expect(checkStrictPluginSecrets(drift)).toEqual({
      state: "passthrough_with_secret",
      key: "apiKey",
    });
  });

  it("allows clean parsed schemas under strict mode", () => {
    process.env.ATLAS_STRICT_PLUGIN_SECRETS = "true";
    const clean = parsed([
      { key: "apiKey", type: "string", secret: true },
      { key: "region", type: "string", secret: false },
    ]);
    expect(checkStrictPluginSecrets(clean)).toBeNull();
  });

  it("allows absent / empty schemas under strict mode (no secrets to enforce)", () => {
    process.env.ATLAS_STRICT_PLUGIN_SECRETS = "true";
    expect(checkStrictPluginSecrets(absent)).toBeNull();
    expect(checkStrictPluginSecrets(parsed([]))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// F-42 encrypt / decrypt walkers (formerly secrets-encryption.test.ts)
// ---------------------------------------------------------------------------

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
