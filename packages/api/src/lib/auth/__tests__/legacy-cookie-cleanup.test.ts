import { describe, it, expect } from "bun:test";
import {
  countSessionTokenCookies,
  parentCookieDomains,
  buildLegacyCookieDeletions,
} from "../legacy-cookie-cleanup";

/**
 * #4086 — the legacy cross-subdomain cookie that shadows the host-only one.
 *
 * The header below is the real shape captured from a broken prod browser: two
 * `__Secure-atlas.session_token` cookies (the live host-only one + the stale
 * `Domain=.useatlas.dev` one) plus the host-only passkey cookie. The
 * `session_data` cache cookie has already lapsed (its 30s window), which is the
 * exact moment auth starts 401ing.
 */
const SHADOWED_HEADER =
  "__Secure-atlas.better-auth-passkey=xUf.sig; " +
  "__Secure-atlas.session_token=ndlpHostOnly.sig; " +
  "__Secure-atlas.session_token=p6wZStaleParent.sig";

/** A clean, migrated browser: exactly one host-only session token. */
const CLEAN_HEADER =
  "__Secure-atlas.better-auth-passkey=xUf.sig; " +
  "__Secure-atlas.session_token=ndlpHostOnly.sig; " +
  "__Secure-atlas.session_data=eyJ.cache";

describe("countSessionTokenCookies", () => {
  it("counts both spellings of the session-token cookie, ignoring others", () => {
    expect(countSessionTokenCookies(SHADOWED_HEADER, "atlas")).toBe(2);
    expect(countSessionTokenCookies(CLEAN_HEADER, "atlas")).toBe(1);
  });

  it("does not count session_data or passkey cookies", () => {
    const onlyOthers =
      "__Secure-atlas.session_data=x; __Secure-atlas.better-auth-passkey=y";
    expect(countSessionTokenCookies(onlyOthers, "atlas")).toBe(0);
  });

  it("counts a bare (non-__Secure-) spelling for http dev", () => {
    expect(
      countSessionTokenCookies("atlas.session_token=a; atlas.session_token=b", "atlas"),
    ).toBe(2);
  });

  it("respects the cookie prefix (staging vs prod isolation)", () => {
    // A prod cookie must not be counted against the staging prefix.
    expect(countSessionTokenCookies(SHADOWED_HEADER, "atlas-staging")).toBe(0);
  });

  it("tolerates malformed / empty segments", () => {
    expect(countSessionTokenCookies(";; =novalue; __Secure-atlas.session_token=a", "atlas")).toBe(1);
  });
});

describe("parentCookieDomains", () => {
  it("returns the registrable parent for a regional API host", () => {
    expect(parentCookieDomains("api.useatlas.dev")).toEqual(["useatlas.dev"]);
    expect(parentCookieDomains("api-eu.useatlas.dev")).toEqual(["useatlas.dev"]);
    expect(parentCookieDomains("api-apac.useatlas.dev")).toEqual(["useatlas.dev"]);
  });

  it("walks every ancestor for a deeper host (covers staging-style hosts)", () => {
    expect(parentCookieDomains("api.staging.useatlas.dev")).toEqual([
      "staging.useatlas.dev",
      "useatlas.dev",
    ]);
  });

  it("never returns the full host (host-only needs no cleanup) nor a bare TLD", () => {
    const parents = parentCookieDomains("api.useatlas.dev");
    expect(parents).not.toContain("api.useatlas.dev");
    expect(parents).not.toContain("dev");
  });

  it("returns [] for a registrable-domain or single-label host", () => {
    expect(parentCookieDomains("useatlas.dev")).toEqual([]);
    expect(parentCookieDomains("localhost")).toEqual([]);
  });

  it("strips a port and lowercases", () => {
    expect(parentCookieDomains("API.useatlas.dev:443")).toEqual(["useatlas.dev"]);
  });
});

describe("buildLegacyCookieDeletions", () => {
  it("emits parent-domain deletions for the #4086 shadow (prod)", () => {
    const out = buildLegacyCookieDeletions({
      cookieHeader: SHADOWED_HEADER,
      host: "api.useatlas.dev",
      cookiePrefix: "atlas",
    });
    // session_token + session_data, one parent domain → 2 deletions.
    expect(out).toEqual([
      "__Secure-atlas.session_token=; Domain=useatlas.dev; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure",
      "__Secure-atlas.session_data=; Domain=useatlas.dev; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure",
    ]);
  });

  it("targets the PARENT domain only — never the live host-only cookie", () => {
    const out = buildLegacyCookieDeletions({
      cookieHeader: SHADOWED_HEADER,
      host: "api.useatlas.dev",
      cookiePrefix: "atlas",
    });
    // A deletion scoped to the full host would clobber the live session — assert
    // none is. (Host-only cookies carry no Domain; Domain=api.useatlas.dev is a
    // distinct cookie, but emitting it would still be a smell.)
    for (const sc of out) expect(sc).not.toContain("Domain=api.useatlas.dev");
  });

  it("is a NO-OP for a clean (already-migrated) browser", () => {
    expect(
      buildLegacyCookieDeletions({
        cookieHeader: CLEAN_HEADER,
        host: "api.useatlas.dev",
        cookiePrefix: "atlas",
      }),
    ).toEqual([]);
  });

  it("is a no-op without a cookie header or host", () => {
    expect(buildLegacyCookieDeletions({ cookieHeader: null, host: "api.useatlas.dev", cookiePrefix: "atlas" })).toEqual([]);
    expect(buildLegacyCookieDeletions({ cookieHeader: SHADOWED_HEADER, host: null, cookiePrefix: "atlas" })).toEqual([]);
  });

  it("omits Secure for a bare-prefix (http dev) shadow", () => {
    const out = buildLegacyCookieDeletions({
      cookieHeader: "atlas.session_token=a; atlas.session_token=b",
      host: "api.staging.useatlas.dev",
      cookiePrefix: "atlas",
    });
    expect(out).toContain("atlas.session_token=; Domain=useatlas.dev; Path=/; Max-Age=0; HttpOnly; SameSite=Lax");
    expect(out).toContain("atlas.session_token=; Domain=staging.useatlas.dev; Path=/; Max-Age=0; HttpOnly; SameSite=Lax");
    for (const sc of out) expect(sc).not.toContain("Secure");
  });

  it("does not fire for a different deployment's prefix", () => {
    expect(
      buildLegacyCookieDeletions({
        cookieHeader: SHADOWED_HEADER,
        host: "api.useatlas.dev",
        cookiePrefix: "atlas-staging",
      }),
    ).toEqual([]);
  });
});
