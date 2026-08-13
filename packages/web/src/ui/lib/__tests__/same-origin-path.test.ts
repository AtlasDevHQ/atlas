/**
 * #5189 round 2 — `sameOriginPath`, the guard on every value that can drive a
 * navigation out of a response body.
 *
 * It replaced `startsWith("/") && !startsWith("//")`, which was MEASURED wrong:
 * WHATWG URL parsing normalizes `\` to `/` for special schemes and strips
 * TAB/LF/CR before authority detection, so three separate hostile shapes passed
 * it. Those three are the first cases below, and they are the reason this is a
 * parser and not a pair of prefix checks.
 */

import { describe, it, expect } from "bun:test";
import { sameOriginPath } from "../fetch-error";

describe("sameOriginPath — off-origin inputs are refused", () => {
  for (const hostile of [
    "https://evil.example.com/harvest",
    "//evil.example.com/harvest",
    // The three the prefix check admitted. Each resolves to an off-site
    // authority in every browser.
    "/\\evil.example.com/harvest",
    "/\\/evil.example.com",
    "/\t/evil.example.com",
    "/\n/evil.example.com",
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
  ]) {
    it(`refuses ${JSON.stringify(hostile)}`, () => {
      expect(sameOriginPath(hostile)).toBeNull();
    });
  }

  it("refuses undefined and empty", () => {
    expect(sameOriginPath(undefined)).toBeNull();
    expect(sameOriginPath("")).toBeNull();
  });
});

describe("sameOriginPath — same-origin paths survive intact", () => {
  // The other half: a guard that refused everything would pass every test
  // above and break enrollment entirely.
  for (const [input, expected] of [
    ["/admin/account-security", "/admin/account-security"],
    ["/admin/account-security?from=dashboards", "/admin/account-security?from=dashboards"],
    ["/admin/account-security#totp", "/admin/account-security#totp"],
    ["/a/b/c", "/a/b/c"],
  ] as const) {
    it(`keeps ${input}`, () => {
      expect(sameOriginPath(input)).toBe(expected);
    });
  }

  it("normalizes a relative path onto the origin root", () => {
    expect(sameOriginPath("admin/account-security")).toBe("/admin/account-security");
  });
});
