/**
 * Unit tests for the declarative vendor-quirk apply helpers (v0.0.2 slice 6a,
 * #3028). These pin the contract the generic client depends on: required headers
 * apply as non-clobbering defaults, and query param-shaping re-keys matched
 * params (Stripe `expand` → `expand[]`) while leaving everything else — including
 * a later pagination cursor — verbatim. A regression here would silently change
 * what the client sends upstream, which no client-layer test would catch as
 * directly.
 */
import { describe, it, expect } from "bun:test";
import {
  applyQuirkHeaders,
  applyQuirkQueryShaping,
  type VendorQuirk,
} from "../vendor-quirk";

describe("applyQuirkHeaders", () => {
  it("adds the quirk's required headers", () => {
    const headers: Record<string, string> = { accept: "application/json" };
    applyQuirkHeaders(headers, { requiredHeaders: { "Notion-Version": "2022-06-28" } });
    expect(headers["Notion-Version"]).toBe("2022-06-28");
  });

  it("does not clobber a header the caller already set (case-insensitive)", () => {
    const headers: Record<string, string> = { "notion-version": "caller-set" };
    applyQuirkHeaders(headers, { requiredHeaders: { "Notion-Version": "2022-06-28" } });
    // The caller's value survives; no duplicate key is introduced.
    expect(headers["notion-version"]).toBe("caller-set");
    expect(headers["Notion-Version"]).toBeUndefined();
  });

  it("is a no-op for an absent quirk or absent requiredHeaders", () => {
    const a: Record<string, string> = { accept: "application/json" };
    applyQuirkHeaders(a, undefined);
    expect(a).toEqual({ accept: "application/json" });

    const b: Record<string, string> = { accept: "application/json" };
    applyQuirkHeaders(b, {});
    expect(b).toEqual({ accept: "application/json" });
  });
});

describe("applyQuirkQueryShaping", () => {
  const STRIPE_QUIRK: VendorQuirk = {
    queryParamShaping: [{ param: "expand", bracketArray: true }],
  };

  it("rewrites a bracketArray param key, preserving the (array) value", () => {
    const shaped = applyQuirkQueryShaping(
      { expand: ["data.customer", "data.invoice"], limit: 10 },
      STRIPE_QUIRK,
    );
    expect(shaped).toEqual({ "expand[]": ["data.customer", "data.invoice"], limit: 10 });
  });

  it("renames a param outright (rename wins over bracketArray)", () => {
    const shaped = applyQuirkQueryShaping(
      { expand: ["x"] },
      { queryParamShaping: [{ param: "expand", bracketArray: true, rename: "expand[0]" }] },
    );
    expect(shaped).toEqual({ "expand[0]": ["x"] });
  });

  it("leaves params no rule names untouched (e.g. a pagination cursor)", () => {
    const shaped = applyQuirkQueryShaping(
      { expand: ["data.x"], starting_after: "cus_123", limit: 5 },
      STRIPE_QUIRK,
    );
    expect(shaped).toEqual({ "expand[]": ["data.x"], starting_after: "cus_123", limit: 5 });
  });

  it("returns the input unchanged when there are no rules", () => {
    const query = { a: 1, b: "two" };
    expect(applyQuirkQueryShaping(query, undefined)).toBe(query);
    expect(applyQuirkQueryShaping(query, {})).toBe(query);
    expect(applyQuirkQueryShaping(query, { queryParamShaping: [] })).toBe(query);
  });

  it("returns undefined for an undefined query", () => {
    expect(applyQuirkQueryShaping(undefined, STRIPE_QUIRK)).toBeUndefined();
  });
});
