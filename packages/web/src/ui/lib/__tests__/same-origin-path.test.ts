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
import { sameOriginPath, externalRedirectUrl } from "../fetch-error";

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

/**
 * #5191 — `externalRedirectUrl`, the OTHER rule, which had no tests of its own.
 *
 * It is the deliberate inverse of `sameOriginPath`: `ssoRedirectUrl` is always
 * an external IdP, so same-origin would reject every legitimate value. The two
 * rules and which field each guards are recorded in `redirect-target.ts`.
 *
 * ⚠️ The "returns the ORIGINAL string" clause could not fail before this: both
 * existing fixtures in the tree carry a path, so `raw === u.href` for both and
 * `return u.href` would have passed everything. The bare-origin case below is
 * the one that distinguishes them.
 */
describe("externalRedirectUrl — an absolute http(s) URL, or null", () => {
  it("returns an absolute https URL unchanged", () => {
    expect(externalRedirectUrl("https://idp.example.com/sso/saml")).toBe(
      "https://idp.example.com/sso/saml",
    );
  });

  it("returns a BARE ORIGIN byte-identical, without WHATWG's trailing slash", () => {
    // `new URL("https://idp.example.com").href` is `"https://idp.example.com/"`.
    // Normalizing someone else's endpoint is not ours to do, and this is the
    // only fixture that can tell `return raw` from `return u.href`.
    expect(externalRedirectUrl("https://idp.example.com")).toBe(
      "https://idp.example.com",
    );
  });

  it("allows http for a self-hosted IdP on a private network", () => {
    expect(externalRedirectUrl("http://keycloak.internal/realms/atlas")).toBe(
      "http://keycloak.internal/realms/atlas",
    );
  });

  for (const [label, hostile] of [
    ["javascript:", "javascript:alert(1)"],
    ["data:", "data:text/html,<script>alert(1)</script>"],
    ["a relative path", "/admin/settings"],
    ["a protocol-relative URL", "//evil.example.com/harvest"],
    ["a bare word", "not a url"],
    ["stringified garbage", "[object Object]"],
  ] as const) {
    it(`refuses ${label}`, () => {
      // `javascript:` and `data:` parse fine as absolute URLs — the protocol
      // allowlist is the only thing refusing them, which is why this rule can
      // afford to allow an external origin at all.
      expect(externalRedirectUrl(hostile)).toBeNull();
    });
  }

  it("refuses a non-string and an empty string", () => {
    expect(externalRedirectUrl(undefined)).toBeNull();
    expect(externalRedirectUrl(null)).toBeNull();
    expect(externalRedirectUrl({})).toBeNull();
    expect(externalRedirectUrl("")).toBeNull();
  });

  it("is NOT sameOriginPath — the two rules disagree on purpose", () => {
    // The pair that would silently break if a future field were guarded with
    // the wrong one: each accepts exactly what the other refuses.
    expect(externalRedirectUrl("https://idp.example.com/sso")).not.toBeNull();
    expect(sameOriginPath("https://idp.example.com/sso")).toBeNull();
    expect(sameOriginPath("/admin/account-security")).not.toBeNull();
    expect(externalRedirectUrl("/admin/account-security")).toBeNull();
  });
});
