/**
 * Unit tests for the OAuth provider config resolvers (#2024 PR C).
 *
 * Pin the small env-driven helpers in `server.ts` so a future refactor
 * can't silently flip:
 *   - the audience derivation (would break token verification)
 *   - the unauthenticated-DCR opt-out (would break MCP onboarding)
 */

import { describe, it, expect } from "bun:test";
import {
  resolveOAuthValidAudiences,
  resolveAllowUnauthDcr,
  ATLAS_OAUTH_SCOPES,
} from "../server";

describe("resolveOAuthValidAudiences", () => {
  it("appends `/mcp` to the BETTER_AUTH_URL fallback so issuer == verifier audience", () => {
    // Critical invariant: the resource server (well-known.ts) advertises
    // `<base>/mcp` and the verifier (hosted.ts) compares against the
    // same string. Without the suffix on the issuer side, every
    // RFC-8707 token request would fail `requested resource invalid`
    // and every token issued without `resource=` would still fail at
    // the verifier with audience mismatch.
    expect(
      resolveOAuthValidAudiences({
        BETTER_AUTH_URL: "https://api.example.test",
      } as NodeJS.ProcessEnv),
    ).toEqual(["https://api.example.test/mcp"]);
  });

  it("prefers ATLAS_PUBLIC_API_URL over BETTER_AUTH_URL on the suffixed fallback", () => {
    // Mirrors the priority chain in well-known.ts and hosted.ts so all
    // three sites converge on the same audience in a multi-region
    // deploy where BETTER_AUTH_URL points at a global auth host but
    // each region runs a different MCP resource server. The brand
    // `mcp-eu.useatlas.dev` audience is added alongside the regional
    // fallback so tokens minted post-cutover verify under either name
    // (and pre-cutover-issued tokens — there are none in production —
    // still verify against the regional `<region>.api.useatlas.dev/mcp`
    // they were bound to).
    expect(
      resolveOAuthValidAudiences({
        ATLAS_PUBLIC_API_URL: "https://api-eu.useatlas.dev",
        BETTER_AUTH_URL: "https://api.useatlas.dev",
      } as NodeJS.ProcessEnv),
    ).toEqual([
      "https://api-eu.useatlas.dev/mcp",
      "https://mcp-eu.useatlas.dev/mcp",
    ]);
  });

  it("strips trailing slashes from the base before suffixing", () => {
    expect(
      resolveOAuthValidAudiences({
        BETTER_AUTH_URL: "https://api.example.test/",
      } as NodeJS.ProcessEnv),
    ).toEqual(["https://api.example.test/mcp"]);
  });

  it("adds the mcp.useatlas.dev brand audience alongside api.useatlas.dev (us region)", () => {
    // #2068 — `mcp.useatlas.dev` becomes the canonical hostname for the
    // hosted MCP endpoint while the regional `api.*` host stays
    // reachable as the underlying infra. Tokens minted post-cutover are
    // bound to the brand audience; the regional fallback is preserved
    // so the issuer keeps accepting tokens minted just before the flip.
    // Ordering: regional first (backward compat), brand second
    // (forward-looking) — keeps the diff against the pre-#2068 list a
    // pure append.
    expect(
      resolveOAuthValidAudiences({
        ATLAS_PUBLIC_API_URL: "https://api.useatlas.dev",
      } as NodeJS.ProcessEnv),
    ).toEqual([
      "https://api.useatlas.dev/mcp",
      "https://mcp.useatlas.dev/mcp",
    ]);
  });

  it("adds the mcp-apac.useatlas.dev brand audience alongside api-apac.useatlas.dev", () => {
    expect(
      resolveOAuthValidAudiences({
        ATLAS_PUBLIC_API_URL: "https://api-apac.useatlas.dev",
      } as NodeJS.ProcessEnv),
    ).toEqual([
      "https://api-apac.useatlas.dev/mcp",
      "https://mcp-apac.useatlas.dev/mcp",
    ]);
  });

  it("does not add a brand mirror for non-useatlas.dev hosts (self-hosted / dev)", () => {
    // The brand-hostname mirror is a SaaS-specific concern. Self-hosted
    // operators on `api.example.test` shouldn't see a synthesised
    // `mcp.example.test` audience appear out of nowhere — keep the
    // single-audience output the rest of `__tests__/oauth-config.test.ts`
    // already pins.
    expect(
      resolveOAuthValidAudiences({
        ATLAS_PUBLIC_API_URL: "https://api.example.test",
      } as NodeJS.ProcessEnv),
    ).toEqual(["https://api.example.test/mcp"]);
  });

  it("returns an empty list when neither env var is set", () => {
    expect(resolveOAuthValidAudiences({} as NodeJS.ProcessEnv)).toEqual([]);
  });

  it("parses a comma-separated explicit list verbatim — no suffix appended", () => {
    // When the operator supplies the list explicitly they may include
    // non-MCP audiences or pre-suffixed values; we don't second-guess.
    expect(
      resolveOAuthValidAudiences({
        ATLAS_OAUTH_VALID_AUDIENCES:
          "https://api.useatlas.dev/mcp, https://api-eu.useatlas.dev/mcp,, https://api-apac.useatlas.dev/mcp",
      } as NodeJS.ProcessEnv),
    ).toEqual([
      "https://api.useatlas.dev/mcp",
      "https://api-eu.useatlas.dev/mcp",
      "https://api-apac.useatlas.dev/mcp",
    ]);
  });

  it("ATLAS_OAUTH_VALID_AUDIENCES wins when both are set", () => {
    expect(
      resolveOAuthValidAudiences({
        BETTER_AUTH_URL: "https://other.example",
        ATLAS_OAUTH_VALID_AUDIENCES: "https://chosen.example",
      } as NodeJS.ProcessEnv),
    ).toEqual(["https://chosen.example"]);
  });

  it("treats a whitespace-only override as 'unset' and falls back to the suffixed default", () => {
    expect(
      resolveOAuthValidAudiences({
        ATLAS_OAUTH_VALID_AUDIENCES: "   ",
        BETTER_AUTH_URL: "https://api.example.test",
      } as NodeJS.ProcessEnv),
    ).toEqual(["https://api.example.test/mcp"]);
  });
});

describe("resolveAllowUnauthDcr", () => {
  it("defaults on when env var is unset", () => {
    expect(resolveAllowUnauthDcr({} as NodeJS.ProcessEnv)).toBe(true);
  });

  it("turns off on `false` / `0` / `no` / `off` (case-insensitive)", () => {
    for (const v of ["false", "FALSE", "0", "no", "NO", "off", "Off"]) {
      expect(
        resolveAllowUnauthDcr({
          ATLAS_OAUTH_ALLOW_UNAUTH_DCR: v,
        } as NodeJS.ProcessEnv),
      ).toBe(false);
    }
  });

  it("stays on for any other value (truthy spellings + unknown garbage)", () => {
    for (const v of ["true", "1", "yes", "on", "garbage", ""]) {
      expect(
        resolveAllowUnauthDcr({
          ATLAS_OAUTH_ALLOW_UNAUTH_DCR: v,
        } as NodeJS.ProcessEnv),
      ).toBe(true);
    }
  });
});

describe("ATLAS_OAUTH_SCOPES", () => {
  it("exposes the standard OIDC scopes plus the Atlas mcp:* scopes", () => {
    expect(ATLAS_OAUTH_SCOPES).toContain("openid");
    expect(ATLAS_OAUTH_SCOPES).toContain("profile");
    expect(ATLAS_OAUTH_SCOPES).toContain("email");
    expect(ATLAS_OAUTH_SCOPES).toContain("offline_access");
    expect(ATLAS_OAUTH_SCOPES).toContain("mcp:read");
    expect(ATLAS_OAUTH_SCOPES).toContain("mcp:write");
  });

  it("places mcp scopes after the standard OIDC ones (consent UI ordering)", () => {
    // Widen the readonly tuple to a string array for the index lookup
    // — `indexOf` on the literal-tuple type narrows to the union, which
    // would reject the test's looser inputs.
    const scopes = ATLAS_OAUTH_SCOPES as readonly string[];
    expect(scopes.indexOf("openid")).toBeLessThan(scopes.indexOf("mcp:read"));
    expect(scopes.indexOf("offline_access")).toBeLessThan(scopes.indexOf("mcp:read"));
  });
});
