/**
 * Unit tests for secret-masking helpers used by admin plugin config surfaces.
 * Pins contract-level behavior so admin-marketplace.ts and admin-plugins.ts
 * can rely on the exact MASKED_PLACEHOLDER string + fail-closed malformed
 * schema handling + round-trip semantics across masked + omitted secret
 * fields.
 */

import { describe, it, expect } from "bun:test";
import type { ConfigSchemaField } from "../registry";
import type { ConfigSchema } from "../secrets";
import { MASKED_PLACEHOLDER, maskSecretFields, parseConfigSchema, restoreMaskedSecrets } from "../secrets";

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
