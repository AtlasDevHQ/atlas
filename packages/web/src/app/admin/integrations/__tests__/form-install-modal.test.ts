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
  buildDefaultValues,
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

describe("buildZodSchema — optional select left unselected", () => {
  // Regression for #3845: the Elasticsearch "Engine" field is an OPTIONAL
  // select (auto-derived from the URL scheme server-side, overridable here).
  // `buildDefaultValues` seeds an undefaulted field with "", and the Select
  // submits "" while showing its placeholder. Before the fix, the literal-union
  // `.optional()` schema rejected "" with the opaque `Invalid input: expected
  // "elasticsearch"` — an optional override must accept "unselected" instead.
  const ENGINE_FIELD: FormFieldDescriptor = {
    key: "engine",
    type: "select",
    options: [
      { value: "elasticsearch", label: "Elasticsearch" },
      { value: "opensearch", label: "OpenSearch" },
    ],
  };

  test('an optional select submitted as "" (unselected) passes and parses to undefined', () => {
    const schema = buildZodSchema([ENGINE_FIELD]);
    const r = schema.safeParse({ engine: "" });
    expect(r.success).toBe(true);
    // The "" → undefined transform is the load-bearing behavior: an untouched
    // optional override must not survive into the parsed output as "".
    expect(r.success && r.data).toEqual({ engine: undefined });
  });

  test("an optional select still accepts a listed value", () => {
    const schema = buildZodSchema([ENGINE_FIELD]);
    expect(schema.safeParse({ engine: "elasticsearch" }).success).toBe(true);
    expect(schema.safeParse({ engine: "opensearch" }).success).toBe(true);
  });

  test("an optional select still rejects an off-list value", () => {
    const schema = buildZodSchema([ENGINE_FIELD]);
    expect(schema.safeParse({ engine: "mongodb" }).success).toBe(false);
  });

  // A REQUIRED select left unselected must still fail — the "" tolerance is for
  // optional fields only, so a genuinely-required choice can't slip past as blank.
  test('a required select submitted as "" still fails', () => {
    const schema = buildZodSchema([{ ...ENGINE_FIELD, required: true }]);
    expect(schema.safeParse({ engine: "" }).success).toBe(false);
  });

  // Full pipeline at the seam where #3845 actually lived, threaded in the REAL
  // production order: buildDefaultValues seeds the undefaulted optional select as
  // "", the schema (regression) accepts it AND its transform yields undefined,
  // and buildSubmitPayload drops the engine. Critically, react-hook-form's
  // zodResolver fires the transform BEFORE handleSubmit, so production passes
  // buildSubmitPayload the PARSED output ({ engine: undefined }), not the raw ""
  // — feeding parsed.data here exercises the undefined-drop branch the app hits,
  // not the "" branch. So an untouched engine never reaches the server, matching
  // the "auto-detected from the URL scheme" copy.
  test("untouched optional engine: default → schema → payload drops it end-to-end", () => {
    const defaults = buildDefaultValues([ENGINE_FIELD]);
    expect(defaults).toEqual({ engine: "" });
    const schema = buildZodSchema([ENGINE_FIELD]);
    const parsed = schema.safeParse(defaults);
    expect(parsed.success).toBe(true);
    // The transform the resolver applies before handleSubmit sees the values.
    expect(parsed.success && parsed.data).toEqual({ engine: undefined });
    // buildSubmitPayload receives the parsed output in production, not raw "".
    expect(buildSubmitPayload([ENGINE_FIELD], parsed.success ? parsed.data : defaults)).toEqual({});
  });
});
