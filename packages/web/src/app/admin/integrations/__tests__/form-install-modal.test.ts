/**
 * Tests for the parser that converts `plugin_catalog.config_schema`
 * (typed as `unknown` on the wire) into the typed
 * {@link FormFieldDescriptor}[] the modal renders from.
 *
 * The modal's runtime behavior (form submit, server-error mapping)
 * lives in the browser e2e — the unit-test surface here is the
 * defensive coercion: malformed entries from a hand-edited catalog
 * row mustn't black-hole the entire form.
 */

import { describe, expect, test } from "bun:test";
import {
  parseConfigSchema,
  buildZodSchema,
  buildSubmitPayload,
  isFieldVisible,
  type FormFieldDescriptor,
} from "../form-install-modal";

describe("parseConfigSchema", () => {
  test("returns [] for non-array input", () => {
    expect(parseConfigSchema(null)).toEqual([]);
    expect(parseConfigSchema(undefined)).toEqual([]);
    expect(parseConfigSchema("not-an-array")).toEqual([]);
    expect(parseConfigSchema({ key: "host" })).toEqual([]);
  });

  test("returns the Email SMTP shape end-to-end", () => {
    const raw = [
      { key: "host", type: "string", required: true, label: "SMTP host" },
      { key: "port", type: "number", required: true, default: 587 },
      { key: "password", type: "string", required: true, secret: true },
      { key: "secure", type: "boolean", default: true },
    ];
    const fields = parseConfigSchema(raw);
    expect(fields).toHaveLength(4);
    expect(fields[0]).toMatchObject({ key: "host", type: "string", required: true, label: "SMTP host" });
    expect(fields[2]).toMatchObject({ key: "password", secret: true });
    expect(fields[3]).toMatchObject({ key: "secure", type: "boolean", default: true });
  });

  test("filters out malformed entries — missing key, unknown type, non-object", () => {
    const raw = [
      { key: "host", type: "string" }, // valid
      { type: "string" }, // missing key
      { key: "", type: "string" }, // empty key
      { key: "bogus", type: "magic" }, // unknown type
      null, // non-object
      "not-an-object", // non-object
      { key: "port", type: "number" }, // valid
    ];
    const fields = parseConfigSchema(raw);
    expect(fields.map((f) => f.key)).toEqual(["host", "port"]);
  });

  test("coerces missing boolean flags to false (not undefined)", () => {
    const fields = parseConfigSchema([{ key: "host", type: "string" }]);
    expect(fields[0].required).toBe(false);
    expect(fields[0].secret).toBe(false);
  });

  test("normalizes bare-string `options` to { value, label } pairs", () => {
    const fields = parseConfigSchema([
      { key: "tls", type: "select", options: ["off", "starttls", "tls"] },
    ]);
    expect(fields[0].options).toEqual([
      { value: "off", label: "off" },
      { value: "starttls", label: "starttls" },
      { value: "tls", label: "tls" },
    ]);
  });

  test("preserves { value, label } options and drops malformed entries", () => {
    const fields = parseConfigSchema([
      {
        key: "authMode",
        type: "select",
        options: [
          { value: "basic", label: "Username & password" },
          { value: "none", label: "None (no auth)" },
          1, // malformed — dropped
          { label: "no value" }, // malformed — dropped
        ],
      },
    ]);
    expect(fields[0].options).toEqual([
      { value: "basic", label: "Username & password" },
      { value: "none", label: "None (no auth)" },
    ]);
  });

  test("parses a valid `showWhen` rule and drops a malformed one", () => {
    const fields = parseConfigSchema([
      { key: "password", type: "string", showWhen: { field: "authMode", equals: ["basic"] } },
      { key: "apiKey", type: "string", showWhen: { field: "authMode" } }, // missing equals — dropped
    ]);
    expect(fields[0].showWhen).toEqual({ field: "authMode", equals: ["basic"] });
    expect(fields[1].showWhen).toBeUndefined();
  });
});

// Mirrors the Elasticsearch auth-mode form: a select discriminator gating
// per-mode credential fields via `showWhen`.
const ES_FIELDS: FormFieldDescriptor[] = [
  { key: "url", type: "string", required: true },
  { key: "authMode", type: "select", required: true, default: "basic", options: [
    { value: "basic", label: "Username & password" },
    { value: "apiKey", label: "API key" },
    { value: "none", label: "None (no auth)" },
  ] },
  { key: "username", type: "string", required: true, showWhen: { field: "authMode", equals: ["basic"] } },
  { key: "password", type: "string", required: true, secret: true, showWhen: { field: "authMode", equals: ["basic"] } },
  { key: "apiKey", type: "string", required: true, secret: true, showWhen: { field: "authMode", equals: ["apiKey"] } },
];

describe("isFieldVisible", () => {
  test("ungated fields are always visible", () => {
    expect(isFieldVisible(ES_FIELDS[0], {})).toBe(true);
  });

  test("gated fields show only when the controlling value matches", () => {
    const username = ES_FIELDS[2];
    expect(isFieldVisible(username, { authMode: "basic" })).toBe(true);
    expect(isFieldVisible(username, { authMode: "apiKey" })).toBe(false);
    expect(isFieldVisible(username, { authMode: "none" })).toBe(false);
    expect(isFieldVisible(username, {})).toBe(false);
  });
});

describe("buildSubmitPayload", () => {
  test("drops fields hidden by the current authMode + empty strings", () => {
    const values = { url: "opensearch://h:9200?ssl=false", authMode: "none", username: "", password: "", apiKey: "" };
    expect(buildSubmitPayload(ES_FIELDS, values)).toEqual({
      url: "opensearch://h:9200?ssl=false",
      authMode: "none",
    });
  });

  test("keeps the visible branch's filled fields, drops the other branches", () => {
    const values = { url: "elasticsearch://h:9200", authMode: "basic", username: "elastic", password: "pw", apiKey: "stale" };
    // apiKey belongs to a hidden branch → dropped even though non-empty.
    expect(buildSubmitPayload(ES_FIELDS, values)).toEqual({
      url: "elasticsearch://h:9200",
      authMode: "basic",
      username: "elastic",
      password: "pw",
    });
  });
});

describe("buildZodSchema — conditional required", () => {
  test("a required showWhen field passes when its branch is hidden", () => {
    const schema = buildZodSchema(ES_FIELDS);
    // authMode=none: username/password/apiKey hidden → not required.
    const r = schema.safeParse({ url: "opensearch://h:9200?ssl=false", authMode: "none" });
    expect(r.success).toBe(true);
  });

  test("a required showWhen field fails when visible and empty", () => {
    const schema = buildZodSchema(ES_FIELDS);
    // authMode=basic: username/password are now required.
    const r = schema.safeParse({ url: "elasticsearch://h:9200", authMode: "basic" });
    expect(r.success).toBe(false);
  });

  test("passes when the visible branch is filled", () => {
    const schema = buildZodSchema(ES_FIELDS);
    const r = schema.safeParse({
      url: "elasticsearch://h:9200",
      authMode: "basic",
      username: "elastic",
      password: "pw",
    });
    expect(r.success).toBe(true);
  });
});

describe("buildZodSchema — conditional required number fields", () => {
  // A showWhen-gated required NUMBER field. Regression guard: z.coerce.number()
  // turns a blank "" into 0 (Number("") === 0), which would slip past the
  // superRefine empty-check and submit a required-but-blank number as 0. The
  // optional branch maps "" → undefined so the conditional-required rule fires.
  const NUM_FIELDS: FormFieldDescriptor[] = [
    {
      key: "mode",
      type: "select",
      required: true,
      options: [
        { value: "default", label: "Default" },
        { value: "custom", label: "Custom" },
      ],
    },
    { key: "timeout", type: "number", required: true, showWhen: { field: "mode", equals: ["custom"] } },
  ];

  test('a gated required number left blank fails ("" is not coerced to 0)', () => {
    const schema = buildZodSchema(NUM_FIELDS);
    const r = schema.safeParse({ mode: "custom", timeout: "" });
    expect(r.success).toBe(false);
  });

  test("a gated required number passes when filled", () => {
    const schema = buildZodSchema(NUM_FIELDS);
    const r = schema.safeParse({ mode: "custom", timeout: "30" });
    expect(r.success).toBe(true);
  });

  test("a gated required number is not required when its branch is hidden", () => {
    const schema = buildZodSchema(NUM_FIELDS);
    const r = schema.safeParse({ mode: "default", timeout: "" });
    expect(r.success).toBe(true);
  });
});
