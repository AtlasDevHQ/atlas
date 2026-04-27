import { describe, it, expect } from "bun:test";
import { parseSignInError } from "./parse-sign-in-error";

describe("parseSignInError — thrown branch", () => {
  it("classifies TypeError as network", () => {
    const out = parseSignInError({ thrown: new TypeError("fetch failed") });
    expect(out.kind).toBe("network");
    expect(out.title).toMatch(/can't reach/i);
  });

  it("classifies generic Error as unknown with the message body", () => {
    const out = parseSignInError({ thrown: new Error("boom") });
    expect(out.kind).toBe("unknown");
    expect(out.body).toBe("boom");
  });

  it("classifies non-Error thrown values as unknown via String(...)", () => {
    const out = parseSignInError({ thrown: "weird-string-error" });
    expect(out.kind).toBe("unknown");
    expect(out.body).toBe("weird-string-error");
  });

  it("uses the fallback body when thrown has empty message", () => {
    const out = parseSignInError({ thrown: new Error("") });
    expect(out.kind).toBe("unknown");
    expect(out.body).toMatch(/contact your workspace admin/i);
  });
});

describe("parseSignInError — response branch", () => {
  it("classifies code INVALID_EMAIL_OR_PASSWORD as invalid_credentials with /incorrect/i copy (e2e contract)", () => {
    const out = parseSignInError({
      error: { code: "INVALID_EMAIL_OR_PASSWORD", message: "Invalid email or password", status: 401 },
    });
    expect(out.kind).toBe("invalid_credentials");
    expect(out.title).toMatch(/incorrect/i);
  });

  it("classifies status 401 alone as invalid_credentials", () => {
    const out = parseSignInError({ error: { status: 401 } });
    expect(out.kind).toBe("invalid_credentials");
  });

  it("classifies status 429 as rate_limited", () => {
    const out = parseSignInError({ error: { status: 429 } });
    expect(out.kind).toBe("rate_limited");
  });

  it("classifies code RATE_LIMITED as rate_limited", () => {
    const out = parseSignInError({ error: { code: "RATE_LIMITED" } });
    expect(out.kind).toBe("rate_limited");
  });

  it("classifies EMAIL_NOT_VERIFIED as email_unverified", () => {
    const out = parseSignInError({ error: { code: "EMAIL_NOT_VERIFIED" } });
    expect(out.kind).toBe("email_unverified");
  });

  it("classifies SSO_REQUIRED with valid redirect as sso_required + action", () => {
    const out = parseSignInError({
      error: {
        code: "SSO_REQUIRED",
        ssoRedirectUrl: "https://idp.example.com/sso/login?org=acme",
      },
    });
    expect(out.kind).toBe("sso_required");
    if (out.kind === "sso_required") {
      expect(out.action?.href).toBe("https://idp.example.com/sso/login?org=acme");
    }
  });

  it("classifies SSO_REQUIRED without redirect as sso_required + no action", () => {
    const out = parseSignInError({ error: { code: "SSO_REQUIRED" } });
    expect(out.kind).toBe("sso_required");
    if (out.kind === "sso_required") {
      expect(out.action).toBeUndefined();
    }
  });

  it("rejects garbage ssoRedirectUrl (object stringified to [object Object])", () => {
    const out = parseSignInError({
      error: {
        code: "SSO_REQUIRED",
        // simulate a server bug: object-shape redirect — should not render a broken link
        ssoRedirectUrl: { href: "x" } as unknown as string,
      },
    });
    expect(out.kind).toBe("sso_required");
    if (out.kind === "sso_required") {
      expect(out.action).toBeUndefined();
    }
  });

  it("rejects malformed ssoRedirectUrl strings", () => {
    const out = parseSignInError({
      error: { code: "SSO_REQUIRED", ssoRedirectUrl: "not a url" },
    });
    // "not a url" isn't a valid URL — URL ctor throws → action stays undefined
    expect(out.kind).toBe("sso_required");
    if (out.kind === "sso_required") {
      expect(out.action).toBeUndefined();
    }
  });

  it("falls back to unknown for unfamiliar shapes, surfacing the message", () => {
    const out = parseSignInError({
      error: { message: "totally novel server error" },
    });
    expect(out.kind).toBe("unknown");
    expect(out.body).toBe("totally novel server error");
  });

  it("falls back to unknown with actionable copy when the message is empty", () => {
    const out = parseSignInError({ error: {} });
    expect(out.kind).toBe("unknown");
    expect(out.body).toMatch(/contact your workspace admin/i);
  });
});

describe("parseSignInError — branch ordering invariants", () => {
  it("a 429 whose message says 'incorrect' still routes to rate_limited (status leads)", () => {
    const out = parseSignInError({
      error: { status: 429, message: "Email or password is incorrect" },
    });
    expect(out.kind).toBe("rate_limited");
  });

  it("an EMAIL_NOT_VERIFIED whose message contains 'password' still routes to email_unverified (code leads)", () => {
    const out = parseSignInError({
      error: { code: "EMAIL_NOT_VERIFIED", message: "Set a password after verifying" },
    });
    expect(out.kind).toBe("email_unverified");
  });

  it("a SSO_REQUIRED whose message contains 'password' still routes to sso_required", () => {
    const out = parseSignInError({
      error: { code: "SSO_REQUIRED", message: "Use SSO instead of password" },
    });
    expect(out.kind).toBe("sso_required");
  });

  it("does NOT misclassify a generic 'Password reset email sent' as invalid_credentials", () => {
    const out = parseSignInError({
      error: { message: "Password reset email sent" },
    });
    // No status, no code, message doesn't match the tightened regex — falls through to unknown
    expect(out.kind).toBe("unknown");
  });
});
