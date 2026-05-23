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
import { parseConfigSchema } from "../form-install-modal";

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

  test("preserves the typed `options` array on select fields", () => {
    const fields = parseConfigSchema([
      { key: "tls", type: "select", options: ["off", "starttls", "tls"] },
    ]);
    expect(fields[0].options).toEqual(["off", "starttls", "tls"]);
  });

  test("filters non-string entries out of an options array", () => {
    const fields = parseConfigSchema([
      { key: "tls", type: "select", options: ["off", 1, true, "tls"] },
    ]);
    expect(fields[0].options).toEqual(["off", "tls"]);
  });
});
