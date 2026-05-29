import { describe, it, expect } from "bun:test";
import { resolveWebCookiePrefix } from "./cookie-prefix";

describe("resolveWebCookiePrefix", () => {
  it("unset → 'atlas' (matches the API production profile; unconfigured self-hosted lockstep)", () => {
    // The load-bearing default: web and API must agree on the cookie name for
    // an unconfigured deploy, or every authenticated user is redirected to
    // /login in a loop. "atlas" is the API `production` profile prefix.
    expect(resolveWebCookiePrefix(undefined)).toBe("atlas");
  });

  it("passes an explicit prefix through (staging isolation)", () => {
    // web-staging sets NEXT_PUBLIC_ATLAS_COOKIE_PREFIX=atlas-staging so the
    // proxy reads `atlas-staging.session_token` and ignores prod's leaked
    // `atlas.session_token` — the cross-env isolation this PR exists for.
    expect(resolveWebCookiePrefix("atlas-staging")).toBe("atlas-staging");
    expect(resolveWebCookiePrefix("atlas-dev")).toBe("atlas-dev");
  });

  it("blank / whitespace → 'atlas' (never an empty '.session_token')", () => {
    expect(resolveWebCookiePrefix("")).toBe("atlas");
    expect(resolveWebCookiePrefix("   ")).toBe("atlas");
  });

  it("trims surrounding whitespace (symmetric with the API resolveCookiePrefix)", () => {
    expect(resolveWebCookiePrefix("  atlas-staging  ")).toBe("atlas-staging");
  });
});
