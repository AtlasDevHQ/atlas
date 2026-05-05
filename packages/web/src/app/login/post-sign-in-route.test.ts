import { describe, expect, test } from "bun:test";
import { getPostSignInRoute } from "./post-sign-in-route";

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
});
