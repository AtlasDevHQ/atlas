import { describe, expect, test } from "bun:test";
import { getPostSignInRoute, requiresRouterPushAfterSignIn } from "./post-sign-in-route";

describe("getPostSignInRoute", () => {
  test("routes to /login/two-factor on { twoFactorRedirect: true }", () => {
    expect(getPostSignInRoute({ twoFactorRedirect: true })).toBe("/login/two-factor");
  });

  test("routes to / on a normal session payload", () => {
    expect(getPostSignInRoute({ token: "abc", user: { id: "u_1" } })).toBe("/");
  });

  test("routes to / when twoFactorRedirect is false", () => {
    expect(getPostSignInRoute({ twoFactorRedirect: false })).toBe("/");
  });

  test("routes to / when twoFactorRedirect is missing", () => {
    expect(getPostSignInRoute({ twoFactorMethods: ["totp"] })).toBe("/");
  });

  test("routes to / on null", () => {
    expect(getPostSignInRoute(null)).toBe("/");
  });

  test("routes to / on undefined", () => {
    expect(getPostSignInRoute(undefined)).toBe("/");
  });

  test("strict equality — does NOT route on stringified 'true' (Better Auth wire-shape drift guard)", () => {
    // If a future Better Auth bump returns the flag as a string, the
    // previous truthy check would silently work; the strict === true
    // check forces an explicit version-pin failure instead.
    expect(getPostSignInRoute({ twoFactorRedirect: "true" })).toBe("/");
  });

  test("strict equality — does NOT route on 1 / truthy", () => {
    expect(getPostSignInRoute({ twoFactorRedirect: 1 })).toBe("/");
  });

  test("ignores non-object inputs", () => {
    expect(getPostSignInRoute("twoFactorRedirect=true")).toBe("/");
    expect(getPostSignInRoute(42)).toBe("/");
    expect(getPostSignInRoute(true)).toBe("/");
  });

  describe("with invitationId", () => {
    test("routes to /accept-invitation/{id} on a normal sign-in", () => {
      expect(getPostSignInRoute({ token: "abc" }, "inv-123")).toBe(
        "/accept-invitation/inv-123",
      );
    });

    test("routes to /login/two-factor with accept-invitation as callbackURL on the 2FA branch", () => {
      // The 2FA challenge wins over the invitation redirect — accept-invitation
      // requires a full session, and the 2FA challenge is what mints one.
      // The accept-invitation path threads through `callbackURL` so the
      // two-factor page lands on it after verify completes.
      expect(
        getPostSignInRoute({ twoFactorRedirect: true }, "inv-123"),
      ).toBe("/login/two-factor?callbackURL=%2Faccept-invitation%2Finv-123");
    });

    test("ignores null / empty invitationId", () => {
      expect(getPostSignInRoute({ token: "abc" }, null)).toBe("/");
      expect(getPostSignInRoute({ token: "abc" }, undefined)).toBe("/");
      expect(getPostSignInRoute({ token: "abc" }, "")).toBe("/");
    });

    test("URI-encodes special characters in invitationId", () => {
      // Invitation IDs are UUIDs in practice, but defense-in-depth: a
      // crafted query that smuggles `?` or `&` into the param shouldn't
      // produce a redirect URL that breaks the 2FA callbackURL parser
      // (or worse, redirects open-redirect-style to another path).
      expect(getPostSignInRoute({ token: "abc" }, "a/b?c")).toBe(
        "/accept-invitation/a%2Fb%3Fc",
      );
    });
  });
});

describe("requiresRouterPushAfterSignIn", () => {
  test("true for the bare 2FA route", () => {
    expect(requiresRouterPushAfterSignIn("/login/two-factor")).toBe(true);
  });

  test("true for the 2FA route with a callbackURL — regression: Codex catch on #2888", () => {
    // The invited-2FA path appends `?callbackURL=…`; the bug was that an
    // exact-equality check missed this case and hard-nav'd the user, which
    // proxy.ts then 307'd back to /login because /login/two-factor isn't
    // in the exact-match authRoutes list.
    expect(
      requiresRouterPushAfterSignIn(
        "/login/two-factor?callbackURL=%2Faccept-invitation%2Finv-123",
      ),
    ).toBe(true);
  });

  test("false for the workspace home", () => {
    expect(requiresRouterPushAfterSignIn("/")).toBe(false);
  });

  test("false for /accept-invitation deep links", () => {
    expect(requiresRouterPushAfterSignIn("/accept-invitation/inv-123")).toBe(false);
  });

  test("false for anything that just happens to start with /login (not /login/two-factor)", () => {
    // Defense-in-depth: a future /login/sso or /login/passkey would NOT
    // share the partial-auth-cookie semantics of /login/two-factor and so
    // should not be treated like one.
    expect(requiresRouterPushAfterSignIn("/login")).toBe(false);
    expect(requiresRouterPushAfterSignIn("/login/sso")).toBe(false);
    expect(requiresRouterPushAfterSignIn("/login/two-factor-other")).toBe(false);
  });
});
