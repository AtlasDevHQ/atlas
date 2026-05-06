import { describe, it, expect } from "bun:test";
import { rewriteVerificationCallbackURL } from "../server";

const FRONTEND = "https://app.useatlas.dev";

describe("rewriteVerificationCallbackURL", () => {
  it("rewrites a relative path to an absolute frontend URL", () => {
    const input =
      "https://api.useatlas.dev/api/auth/verify-email?token=abc&callbackURL=%2Flogin";
    const out = rewriteVerificationCallbackURL(input, FRONTEND);
    const parsed = new URL(out);
    expect(parsed.searchParams.get("callbackURL")).toBe("https://app.useatlas.dev/login");
    // Token is preserved.
    expect(parsed.searchParams.get("token")).toBe("abc");
  });

  it("rewrites the default '/' callback to the frontend root", () => {
    const input = "https://api.useatlas.dev/api/auth/verify-email?token=abc&callbackURL=%2F";
    const out = rewriteVerificationCallbackURL(input, FRONTEND);
    expect(new URL(out).searchParams.get("callbackURL")).toBe("https://app.useatlas.dev/");
  });

  it("rewrites missing callbackURL to the frontend root", () => {
    const input = "https://api.useatlas.dev/api/auth/verify-email?token=abc";
    const out = rewriteVerificationCallbackURL(input, FRONTEND);
    expect(new URL(out).searchParams.get("callbackURL")).toBe("https://app.useatlas.dev/");
  });

  it("preserves an already-absolute callbackURL untouched", () => {
    const input =
      "https://api.useatlas.dev/api/auth/verify-email?token=abc&callbackURL=https%3A%2F%2Fapp.useatlas.dev%2Fdashboard";
    const out = rewriteVerificationCallbackURL(input, FRONTEND);
    expect(out).toBe(input);
  });

  it("does not rewrite a protocol-relative callback that pivots origin", () => {
    // `//evil.com/x` resolves to `https://evil.com/x` when given
    // `https://app.useatlas.dev` as base — we must NOT propagate that as
    // an absolute, frontend-blessed URL. Better Auth's trustedOrigins
    // check is the authority on the original; we just don't make it worse.
    const evilCb = "//evil.com/x";
    const input = `https://api.useatlas.dev/api/auth/verify-email?token=abc&callbackURL=${encodeURIComponent(evilCb)}`;
    const out = rewriteVerificationCallbackURL(input, FRONTEND);
    expect(out).toBe(input);
  });

  it("returns input unchanged when frontendOrigin is empty", () => {
    const input = "https://api.useatlas.dev/api/auth/verify-email?token=abc&callbackURL=%2Flogin";
    const out = rewriteVerificationCallbackURL(input, "");
    expect(out).toBe(input);
  });

  it("returns input unchanged when input URL is malformed", () => {
    const input = "not a url";
    const out = rewriteVerificationCallbackURL(input, FRONTEND);
    expect(out).toBe(input);
  });

  it("preserves path-with-query callback", () => {
    const input =
      "https://api.useatlas.dev/api/auth/verify-email?token=abc&callbackURL=%2Fsignup%2Fworkspace%3Fnew%3D1";
    const out = rewriteVerificationCallbackURL(input, FRONTEND);
    const cb = new URL(out).searchParams.get("callbackURL");
    expect(cb).toBe("https://app.useatlas.dev/signup/workspace?new=1");
  });
});
