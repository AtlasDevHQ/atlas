/**
 * Coverage for the proxy pre-auth route allowlist (ADR-0024 §4, #3972).
 *
 * The signup reorder moves region selection and account creation BEFORE any
 * session exists, so `/signup/region` and `/signup/account` must be reachable
 * while signed out on a same-origin managed deploy — otherwise the proxy's
 * `!sessionToken && !isAuthRoute` branch 307s every regional signup to /login
 * mid-flow. This pins that membership directly via the exported `isAuthRoute`
 * predicate (env-independent, so it can't diverge local↔CI like a full
 * `proxy()` test would via the module-level NEXT_PUBLIC_* reads — #3939).
 */

import { describe, expect, test, mock } from "bun:test";

// proxy.ts pulls in next/server + better-auth/cookies at import; stub them so
// the import has no heavy side effects (the predicate under test needs neither).
void mock.module("next/server", () => ({
  NextResponse: { next: () => ({}), redirect: () => ({}) },
}));
void mock.module("better-auth/cookies", () => ({
  getSessionCookie: () => null,
}));

import { isAuthRoute } from "../proxy";

describe("proxy isAuthRoute — pre-auth signup steps (#3972)", () => {
  test("the pre-auth signup steps are reachable while signed out", () => {
    expect(isAuthRoute("/signup")).toBe(true);
    expect(isAuthRoute("/signup/region")).toBe(true);
    expect(isAuthRoute("/signup/account")).toBe(true);
  });

  test("the post-account signup steps stay session-gated (NOT auth routes)", () => {
    expect(isAuthRoute("/signup/workspace")).toBe(false);
    expect(isAuthRoute("/signup/connect")).toBe(false);
    expect(isAuthRoute("/signup/success")).toBe(false);
  });

  test("the other auth-only routes are unchanged", () => {
    expect(isAuthRoute("/login")).toBe(true);
    expect(isAuthRoute("/forgot-password")).toBe(true);
    expect(isAuthRoute("/reset-password")).toBe(true);
    // A real app route is not an auth route.
    expect(isAuthRoute("/")).toBe(false);
  });
});
