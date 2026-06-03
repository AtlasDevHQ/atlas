import { describe, it, expect } from "bun:test";
import { resolveConsentOutcome } from "./resolve-consent-outcome";

describe("resolveConsentOutcome — success", () => {
  it("reads `.url` as the redirect target (the real @better-auth/oauth-provider field)", () => {
    const out = resolveConsentOutcome({
      data: { redirect: true, url: "https://client.example/cb?code=abc&state=xyz" },
    });
    expect(out).toEqual({
      kind: "redirect",
      url: "https://client.example/cb?code=abc&state=xyz",
    });
  });

  it("regression (#3122): ignores the legacy `.redirectURI` field — it is undefined on this client", () => {
    // The deprecated oidc-provider plugin returned `{ redirectURI }`; the
    // oauth-provider plugin Atlas uses does not. A response carrying only
    // `redirectURI` must NOT produce a redirect — that was the live bug.
    const out = resolveConsentOutcome({
      data: { redirectURI: "https://client.example/cb" },
    } as unknown as Parameters<typeof resolveConsentOutcome>[0]);
    expect(out.kind).toBe("error");
    expect(out).toMatchObject({ message: expect.stringMatching(/no redirect was returned/i) });
  });
});

describe("resolveConsentOutcome — error / empty", () => {
  it("surfaces the server error message, taking precedence over data", () => {
    const out = resolveConsentOutcome({
      error: { message: "client disabled" },
      data: { redirect: true, url: "https://client.example/cb" },
    });
    expect(out).toEqual({ kind: "error", message: "client disabled" });
  });

  it("falls back to a generic message when the error has no message", () => {
    const out = resolveConsentOutcome({ error: { message: null } });
    expect(out.kind).toBe("error");
    expect(out).toMatchObject({ message: "Consent failed." });
  });

  it("treats an empty/whitespace-only error message as missing (no blank UI error)", () => {
    expect(resolveConsentOutcome({ error: { message: "" } })).toEqual({
      kind: "error",
      message: "Consent failed.",
    });
    expect(resolveConsentOutcome({ error: { message: "   " } })).toEqual({
      kind: "error",
      message: "Consent failed.",
    });
  });

  it("trims surrounding whitespace from a real error message", () => {
    const out = resolveConsentOutcome({ error: { message: "  client disabled  " } });
    expect(out).toEqual({ kind: "error", message: "client disabled" });
  });

  it("returns a 'no redirect' error when data is present but `url` is missing", () => {
    const out = resolveConsentOutcome({ data: { redirect: true } });
    expect(out.kind).toBe("error");
    expect(out).toMatchObject({ message: expect.stringMatching(/no redirect was returned/i) });
  });

  it("returns a 'no redirect' error for an undefined response", () => {
    const out = resolveConsentOutcome(undefined);
    expect(out.kind).toBe("error");
    expect(out).toMatchObject({ message: expect.stringMatching(/no redirect was returned/i) });
  });

  it("treats an empty-string url as missing", () => {
    const out = resolveConsentOutcome({ data: { redirect: true, url: "" } });
    expect(out.kind).toBe("error");
  });
});
