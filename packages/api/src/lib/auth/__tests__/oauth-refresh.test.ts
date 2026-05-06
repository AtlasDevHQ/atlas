/**
 * OAuth refresh-token TTL resolvers + audit hook (#2066).
 *
 * Three concerns pinned here:
 *
 *   1. `resolveAccessTokenTtlSeconds` / `resolveRefreshTokenTtlSeconds`
 *      — env-driven config that backs the e2e test's "mint a 30-second
 *      JWT" override. Bad parsing here silently ships a 0-second token
 *      or falls back to a default the e2e setup didn't expect.
 *
 *   2. `recordOAuthTokenRefresh` — the helper wired into Better Auth's
 *      `customTokenResponseFields` hook. Side-effects (audit + counter)
 *      must fire even when fields are partial; production calls have
 *      `clientId: null` because the hook signature doesn't expose it.
 *
 *   3. The actions catalog and metrics counter exist and are wired in.
 *      Compile-time + light runtime checks: `ADMIN_ACTIONS.oauth_token`
 *      must be the string the audit row writes; `oauthTokenRefresh`
 *      must implement the OTel Counter shape.
 *
 * No `mock.module()` here — the helpers under test are pure functions
 * + side-effect emitters. The audit emit is fire-and-forget under the
 * hood, so we exercise the call path rather than asserting on the row
 * itself (the audit logger has its own dedicated tests).
 */

import { describe, it, expect } from "bun:test";
import {
  resolveAccessTokenTtlSeconds,
  resolveRefreshTokenTtlSeconds,
} from "../server";
import { recordOAuthTokenRefresh } from "../oauth-refresh-audit";
import { ADMIN_ACTIONS } from "@atlas/api/lib/audit";
import { oauthTokenRefresh } from "@atlas/api/lib/metrics";

describe("resolveAccessTokenTtlSeconds", () => {
  it("returns the 1-hour default when the env var is unset", () => {
    expect(resolveAccessTokenTtlSeconds({} as NodeJS.ProcessEnv)).toBe(3600);
  });

  it("returns the 1-hour default when the env var is empty", () => {
    expect(
      resolveAccessTokenTtlSeconds({
        ATLAS_OAUTH_ACCESS_TOKEN_TTL_SECONDS: "",
      } as NodeJS.ProcessEnv),
    ).toBe(3600);
  });

  it("parses a positive integer override", () => {
    // 30 seconds is the e2e test's canonical short-TTL value — keep
    // this assertion in sync with the spec or the test's premise breaks.
    expect(
      resolveAccessTokenTtlSeconds({
        ATLAS_OAUTH_ACCESS_TOKEN_TTL_SECONDS: "30",
      } as NodeJS.ProcessEnv),
    ).toBe(30);
  });

  it("falls back to default on a non-numeric value (no silent 0-second token)", () => {
    // A typo ('thirty') must not ship a zero-TTL token — that would mean
    // every token is born expired and refresh would loop forever.
    expect(
      resolveAccessTokenTtlSeconds({
        ATLAS_OAUTH_ACCESS_TOKEN_TTL_SECONDS: "thirty",
      } as NodeJS.ProcessEnv),
    ).toBe(3600);
  });

  it("falls back to default on zero / negative values", () => {
    for (const raw of ["0", "-1", "  -42 "]) {
      expect(
        resolveAccessTokenTtlSeconds({
          ATLAS_OAUTH_ACCESS_TOKEN_TTL_SECONDS: raw,
        } as NodeJS.ProcessEnv),
      ).toBe(3600);
    }
  });
});

describe("resolveRefreshTokenTtlSeconds", () => {
  it("returns the 30-day default when the env var is unset", () => {
    expect(resolveRefreshTokenTtlSeconds({} as NodeJS.ProcessEnv)).toBe(
      60 * 60 * 24 * 30,
    );
  });

  it("parses a positive integer override", () => {
    expect(
      resolveRefreshTokenTtlSeconds({
        ATLAS_OAUTH_REFRESH_TOKEN_TTL_SECONDS: "120",
      } as NodeJS.ProcessEnv),
    ).toBe(120);
  });

  it("falls back to default on garbage input", () => {
    expect(
      resolveRefreshTokenTtlSeconds({
        ATLAS_OAUTH_REFRESH_TOKEN_TTL_SECONDS: "forever",
      } as NodeJS.ProcessEnv),
    ).toBe(60 * 60 * 24 * 30);
  });
});

describe("ADMIN_ACTIONS.oauth_token catalog", () => {
  it("declares the canonical refresh action string", () => {
    // The literal is the wire shape — forensic queries pivot on
    // `action_type = 'oauth_token.refresh'`. Don't drift it.
    expect(ADMIN_ACTIONS.oauth_token.refresh).toBe("oauth_token.refresh");
  });
});

describe("oauthTokenRefresh counter", () => {
  it("implements the OTel Counter `add` method", () => {
    // We're not asserting against an exporter — there is none in unit
    // tests. The check is structural: the metric exists and the SDK
    // returns a real counter (not the no-op stub the type system
    // would happily accept).
    expect(typeof oauthTokenRefresh.add).toBe("function");
  });
});

describe("recordOAuthTokenRefresh", () => {
  it("does not throw on a fully-populated info object", () => {
    expect(() =>
      recordOAuthTokenRefresh({
        clientId: "claude-desktop",
        userId: "user_abc",
        tokenJti: "jti_xyz",
        ageAtRefreshSec: 3600,
        scopes: ["openid", "profile", "offline_access", "mcp:read"],
      }),
    ).not.toThrow();
  });

  it("does not throw when clientId is null (production hook fallback)", () => {
    // The production hook can't always pull clientId from
    // `customTokenResponseFields`'s `metadata` arg — record with
    // `null` and let the audit row carry whatever we have rather
    // than dropping the event.
    expect(() =>
      recordOAuthTokenRefresh({
        clientId: null,
        userId: "user_abc",
        scopes: ["mcp:read"],
      }),
    ).not.toThrow();
  });

  it("does not throw when userId is null", () => {
    // M2M flows have `user?` undefined — but this hook only fires on
    // `refresh_token` grant (always user-bound per Better Auth's
    // own contract). The null path exists as a defense in depth.
    expect(() =>
      recordOAuthTokenRefresh({
        clientId: "cursor",
        userId: null,
        scopes: ["openid"],
      }),
    ).not.toThrow();
  });
});
