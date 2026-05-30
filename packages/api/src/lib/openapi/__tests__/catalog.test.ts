/**
 * Unit tests for the `openapi-generic` catalog parsers (#2926 / slice 5 #2929).
 *
 * These guard the *fail-closed* contract of the functions that gate write access
 * and auth selection. Every other test hand-constructs an already-parsed
 * allowlist `Set`; this file is the one place that proves the PARSER turns
 * hostile / drifted config into a safe value. A regression that made
 * `parseWriteAllowlist` lenient (e.g. treating a bare string as a one-op
 * allowlist) would silently ENABLE writes and leave every Set-constructing test
 * still green — so the assertions here are load-bearing, not decorative.
 */
import { describe, it, expect } from "bun:test";
import {
  parseWriteAllowlist,
  parseSideEffectingOperations,
  narrowSupportedAuthKind,
  coerceRepresentationMode,
  isValidSnapshot,
  DEFAULT_REPRESENTATION_MODE,
  OPENAPI_SUPPORTED_AUTH_KINDS,
  type OpenApiSnapshot,
} from "../catalog";

describe("parseWriteAllowlist — fail-closed write gate", () => {
  it("parses a form-stored JSON string array into a Set", () => {
    const set = parseWriteAllowlist('["createOnePerson","createOneNote"]');
    expect(set.has("createOnePerson")).toBe(true);
    expect(set.has("createOneNote")).toBe(true);
    expect(set.size).toBe(2);
  });

  it("accepts an already-parsed array (the atlas.config.ts plugins path)", () => {
    const set = parseWriteAllowlist(["deleteOnePerson"]);
    expect(set.has("deleteOnePerson")).toBe(true);
    expect(set.size).toBe(1);
  });

  it("treats absent / empty config as read-only (empty set)", () => {
    expect(parseWriteAllowlist(undefined).size).toBe(0);
    expect(parseWriteAllowlist(null).size).toBe(0);
    expect(parseWriteAllowlist("").size).toBe(0);
  });

  it("fails closed on malformed JSON — NOT a permissive fallback", () => {
    expect(parseWriteAllowlist("not json{").size).toBe(0);
    expect(parseWriteAllowlist("[unterminated").size).toBe(0);
  });

  it("fails closed when the JSON is not an array (object / number / bool)", () => {
    expect(parseWriteAllowlist('{"createOnePerson":true}').size).toBe(0);
    expect(parseWriteAllowlist("42").size).toBe(0);
    expect(parseWriteAllowlist("true").size).toBe(0);
  });

  it("does NOT treat a bare string as a single-op allowlist (the regression that would enable writes)", () => {
    // A raw bare string isn't valid JSON → empty set.
    expect(parseWriteAllowlist("createOnePerson").size).toBe(0);
    // A JSON string-literal parses to a string (not an array) → still empty set.
    expect(parseWriteAllowlist('"createOnePerson"').size).toBe(0);
  });

  it("drops non-string / empty-string elements, keeping only valid op ids", () => {
    const set = parseWriteAllowlist(["createOnePerson", "", 7, null, "createOneNote"] as unknown);
    expect([...set].toSorted()).toEqual(["createOneNote", "createOnePerson"]);
  });
});

describe("parseSideEffectingOperations — #3008 escape-hatch parse", () => {
  // Mirrors the parseWriteAllowlist suite: this is the canonical fail-closed
  // normalization that feeds the write allowlist + confirm gate for a config-
  // flagged side-effecting GET. A regression that made it lenient (e.g. treating a
  // bare string as a one-op list) would mis-stage operations and leave every
  // Set-constructing test still green — so these assertions are load-bearing.
  it("parses a form-stored JSON string array into a Set", () => {
    const set = parseSideEffectingOperations('["cancelJob","resetPassword"]');
    expect(set.has("cancelJob")).toBe(true);
    expect(set.has("resetPassword")).toBe(true);
    expect(set.size).toBe(2);
  });

  it("accepts an already-parsed array (the atlas.config.ts plugins path)", () => {
    const set = parseSideEffectingOperations(["cancelJob"]);
    expect(set.has("cancelJob")).toBe(true);
    expect(set.size).toBe(1);
  });

  it("treats absent / empty config as no overrides (empty set, method-only classification)", () => {
    expect(parseSideEffectingOperations(undefined).size).toBe(0);
    expect(parseSideEffectingOperations(null).size).toBe(0);
    expect(parseSideEffectingOperations("").size).toBe(0);
  });

  it("degrades to empty on malformed JSON — never a permissive / fabricated list", () => {
    expect(parseSideEffectingOperations("not json{").size).toBe(0);
    expect(parseSideEffectingOperations("[unterminated").size).toBe(0);
  });

  it("degrades to empty when the JSON is not an array (object / number / bool)", () => {
    expect(parseSideEffectingOperations('{"cancelJob":true}').size).toBe(0);
    expect(parseSideEffectingOperations("42").size).toBe(0);
    expect(parseSideEffectingOperations("true").size).toBe(0);
  });

  it("does NOT treat a bare string as a single-op list", () => {
    // A raw bare string isn't valid JSON → empty set.
    expect(parseSideEffectingOperations("cancelJob").size).toBe(0);
    // A JSON string-literal parses to a string (not an array) → still empty set.
    expect(parseSideEffectingOperations('"cancelJob"').size).toBe(0);
  });

  it("drops non-string / empty-string elements, keeping only valid op ids", () => {
    const set = parseSideEffectingOperations(["cancelJob", "", 7, null, "resetPassword"] as unknown);
    expect([...set].toSorted()).toEqual(["cancelJob", "resetPassword"]);
  });
});

describe("narrowSupportedAuthKind — positive membership", () => {
  it("returns each executable kind unchanged", () => {
    for (const kind of OPENAPI_SUPPORTED_AUTH_KINDS) {
      // Widen the narrowed result to compare against the (broader) source enum.
      expect(narrowSupportedAuthKind(kind) as string | null).toBe(kind);
    }
  });

  it("returns null for the declared-but-deferred oauth2", () => {
    expect(narrowSupportedAuthKind("oauth2")).toBeNull();
  });

  it("returns null for an unrecognized / drifted value (not just oauth2)", () => {
    expect(narrowSupportedAuthKind("garbage")).toBeNull();
    expect(narrowSupportedAuthKind("apikey")).toBeNull(); // close but not a real kind
    expect(narrowSupportedAuthKind("")).toBeNull();
    expect(narrowSupportedAuthKind("BEARER")).toBeNull(); // case-sensitive
  });
});

describe("coerceRepresentationMode — fail-soft toggle", () => {
  it("passes a known mode through", () => {
    expect(coerceRepresentationMode("operation-graph")).toBe("operation-graph");
    expect(coerceRepresentationMode("semantic-yaml")).toBe("semantic-yaml");
  });

  it("falls back to the bake-off default for unknown / non-string values", () => {
    expect(coerceRepresentationMode("bogus")).toBe(DEFAULT_REPRESENTATION_MODE);
    expect(coerceRepresentationMode(undefined)).toBe(DEFAULT_REPRESENTATION_MODE);
    expect(coerceRepresentationMode(42)).toBe(DEFAULT_REPRESENTATION_MODE);
    expect(coerceRepresentationMode(null)).toBe(DEFAULT_REPRESENTATION_MODE);
  });
});

describe("isValidSnapshot — trust-boundary guard", () => {
  const valid: OpenApiSnapshot = {
    probedAt: "2026-05-29T00:00:00.000Z",
    title: "Widgets",
    version: "1.0.0",
    openapiVersion: "3.1.0",
    operationCount: 3,
    doc: { openapi: "3.1.0", info: {}, paths: {} },
  };

  it("accepts a well-formed snapshot", () => {
    expect(isValidSnapshot(valid)).toBe(true);
  });

  it("rejects a non-object value", () => {
    expect(isValidSnapshot(undefined)).toBe(false);
    expect(isValidSnapshot(null)).toBe(false);
    expect(isValidSnapshot("snapshot")).toBe(false);
  });

  it("rejects a snapshot missing any load-bearing field", () => {
    for (const key of ["probedAt", "title", "version", "openapiVersion", "operationCount", "doc"] as const) {
      const { [key]: _omitted, ...rest } = valid;
      expect(isValidSnapshot(rest)).toBe(false);
    }
  });

  it("rejects a snapshot whose doc is a primitive / null / array (not a JSON object)", () => {
    expect(isValidSnapshot({ ...valid, doc: null })).toBe(false);
    expect(isValidSnapshot({ ...valid, doc: "not-a-doc" })).toBe(false);
    expect(isValidSnapshot({ ...valid, doc: 7 })).toBe(false);
    expect(isValidSnapshot({ ...valid, doc: ["openapi"] })).toBe(false);
  });
});
