import { describe, it, expect } from "bun:test";
import { resolveDeviceVerificationUri } from "../device-verification-uri";

/**
 * #4167 — the RFC 8628 `verification_uri` the CLI prints must resolve to the
 * WEB app's /device page (where the approval UI lives), never the API origin.
 * Better Auth resolves a *relative* verificationUri against its own base URL
 * (the API host), so a bare "/device" 404s. These pin the absolute-URL rule so
 * a regression back to a relative path is RED, not a live dead-end.
 */
describe("resolveDeviceVerificationUri (#4167)", () => {
  it("builds an absolute web-origin /device URL when a web origin is known", () => {
    expect(resolveDeviceVerificationUri("https://app.staging.useatlas.dev")).toBe(
      "https://app.staging.useatlas.dev/device",
    );
  });

  it("points at the WEB origin, not the API origin", () => {
    // The whole bug: the printed URL landed on api.* (404). Given the web
    // origin, the result must be on app.* — never on an api.* host.
    const uri = resolveDeviceVerificationUri("https://app.useatlas.dev");
    expect(uri.startsWith("https://app.useatlas.dev/")).toBe(true);
    expect(uri).not.toContain("api.");
  });

  it("is an absolute URL (has a scheme + host), so Better Auth won't re-resolve it against the API base", () => {
    const uri = resolveDeviceVerificationUri("https://app.useatlas.dev");
    // Absolute parse must succeed on its own (no base argument) — that's
    // exactly what buildVerificationUris checks before falling back to the
    // API base URL.
    expect(() => new URL(uri)).not.toThrow();
    expect(new URL(uri).pathname).toBe("/device");
  });

  it("falls back to the relative /device when no web origin is configured (single-origin embedded deploy)", () => {
    expect(resolveDeviceVerificationUri(null)).toBe("/device");
  });

  it("owns its no-trailing-slash precondition — never emits //device", () => {
    // getWebOrigin() strips trailing slashes today, but the module enforces it
    // itself so a future caller can't reintroduce a double slash.
    expect(resolveDeviceVerificationUri("https://app.useatlas.dev/")).toBe(
      "https://app.useatlas.dev/device",
    );
    expect(resolveDeviceVerificationUri("https://app.useatlas.dev///")).toBe(
      "https://app.useatlas.dev/device",
    );
  });
});
