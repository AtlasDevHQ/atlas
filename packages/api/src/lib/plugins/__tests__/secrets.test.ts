/**
 * Unit tests for secret-masking helpers used by admin plugin config surfaces.
 * Pins contract-level behavior so admin-marketplace.ts and admin-plugins.ts
 * can rely on the exact MASKED_PLACEHOLDER string + round-trip semantics.
 */

import { describe, it, expect } from "bun:test";
import type { ConfigSchemaField } from "../registry";
import { MASKED_PLACEHOLDER, maskSecretFields, parseConfigSchema, restoreMaskedSecrets } from "../secrets";

describe("MASKED_PLACEHOLDER", () => {
  it("is the exact 8-bullet string", () => {
    // Pinning the exact string defends the write-path restoration path:
    // if the constant drifts, re-submitted placeholders stop getting
    // recognized and start corrupting live secrets.
    expect(MASKED_PLACEHOLDER).toBe("••••••••");
  });
});

describe("parseConfigSchema", () => {
  it("parses an array of field-shaped objects", () => {
    const raw = [
      { key: "apiKey", type: "string", secret: true },
      { key: "region", type: "string" },
    ];
    const parsed = parseConfigSchema(raw);
    expect(parsed).toHaveLength(2);
    expect(parsed![0]!.key).toBe("apiKey");
    expect(parsed![0]!.secret).toBe(true);
  });

  it("returns null for non-arrays", () => {
    expect(parseConfigSchema(null)).toBeNull();
    expect(parseConfigSchema({})).toBeNull();
    expect(parseConfigSchema("string")).toBeNull();
  });

  it("skips entries that lack a string `key`", () => {
    const parsed = parseConfigSchema([{ type: "string" }, { key: "ok" }]);
    expect(parsed).toHaveLength(1);
    expect(parsed![0]!.key).toBe("ok");
  });
});

describe("maskSecretFields", () => {
  const schema: ConfigSchemaField[] = [
    { key: "apiKey", type: "string", secret: true },
    { key: "region", type: "string" },
  ];

  it("masks secret: true fields with MASKED_PLACEHOLDER", () => {
    const out = maskSecretFields({ apiKey: "sk-live-1", region: "us-east-1" }, schema);
    expect(out).toEqual({ apiKey: MASKED_PLACEHOLDER, region: "us-east-1" });
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

  it("passes all fields through unchanged when schema is null or empty", () => {
    const input = { anything: "goes" };
    expect(maskSecretFields(input, null)).toEqual(input);
    expect(maskSecretFields(input, [])).toEqual(input);
  });

  it("does not mutate the input config", () => {
    const input = { apiKey: "sk-live-1" };
    maskSecretFields(input, schema);
    expect(input.apiKey).toBe("sk-live-1");
  });
});

describe("restoreMaskedSecrets", () => {
  const schema: ConfigSchemaField[] = [
    { key: "apiKey", type: "string", secret: true },
    { key: "region", type: "string" },
  ];

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
    const out = restoreMaskedSecrets(
      { apiKey: MASKED_PLACEHOLDER },
      {},
      schema,
    );
    expect(out).not.toHaveProperty("apiKey");
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
    // If the UI ever echoes "••••••••" for a non-secret field, treat it as
    // user-entered content — not a restore trigger. Avoids surprising
    // behavior for fields whose schema changed to drop `secret: true`.
    const out = restoreMaskedSecrets(
      { region: MASKED_PLACEHOLDER },
      { region: "us-east-1" },
      schema,
    );
    expect(out.region).toBe(MASKED_PLACEHOLDER);
  });

  it("returns a new object — does not mutate incoming", () => {
    const incoming = { apiKey: MASKED_PLACEHOLDER };
    const out = restoreMaskedSecrets(incoming, { apiKey: "x" }, schema);
    expect(incoming.apiKey).toBe(MASKED_PLACEHOLDER);
    expect(out.apiKey).toBe("x");
  });

  it("passes incoming through when schema is null", () => {
    const incoming = { apiKey: MASKED_PLACEHOLDER };
    expect(restoreMaskedSecrets(incoming, { apiKey: "x" }, null)).toEqual(incoming);
  });
});
