import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { detectAuthMode, resetAuthModeCache, getAuthModeSource } from "../detect";

describe("detectAuthMode()", () => {
  const origJwks = process.env.ATLAS_AUTH_JWKS_URL;
  const origBetterAuth = process.env.BETTER_AUTH_SECRET;
  const origApiKey = process.env.ATLAS_API_KEY;
  const origAuthMode = process.env.ATLAS_AUTH_MODE;

  beforeEach(() => {
    delete process.env.ATLAS_AUTH_JWKS_URL;
    delete process.env.BETTER_AUTH_SECRET;
    delete process.env.ATLAS_API_KEY;
    delete process.env.ATLAS_AUTH_MODE;
    resetAuthModeCache();
  });

  afterEach(() => {
    // Restore originals
    if (origJwks !== undefined) process.env.ATLAS_AUTH_JWKS_URL = origJwks;
    else delete process.env.ATLAS_AUTH_JWKS_URL;

    if (origBetterAuth !== undefined) process.env.BETTER_AUTH_SECRET = origBetterAuth;
    else delete process.env.BETTER_AUTH_SECRET;

    if (origApiKey !== undefined) process.env.ATLAS_API_KEY = origApiKey;
    else delete process.env.ATLAS_API_KEY;

    if (origAuthMode !== undefined) process.env.ATLAS_AUTH_MODE = origAuthMode;
    else delete process.env.ATLAS_AUTH_MODE;

    resetAuthModeCache();
  });

  // -----------------------------------------------------------------------
  // Auto-detection (backward compat)
  // -----------------------------------------------------------------------

  it("returns 'none' when no auth env vars are set", () => {
    expect(detectAuthMode()).toBe("none");
  });

  it("returns 'simple-key' when only ATLAS_API_KEY is set", () => {
    process.env.ATLAS_API_KEY = "test-key-123";
    expect(detectAuthMode()).toBe("simple-key");
  });

  it("returns 'managed' when only BETTER_AUTH_SECRET is set", () => {
    process.env.BETTER_AUTH_SECRET = "super-secret";
    expect(detectAuthMode()).toBe("managed");
  });

  it("returns 'byot' when only ATLAS_AUTH_JWKS_URL is set", () => {
    process.env.ATLAS_AUTH_JWKS_URL = "https://example.com/.well-known/jwks.json";
    expect(detectAuthMode()).toBe("byot");
  });

  it("JWKS wins over managed + simple-key", () => {
    process.env.ATLAS_AUTH_JWKS_URL = "https://example.com/.well-known/jwks.json";
    process.env.BETTER_AUTH_SECRET = "super-secret";
    process.env.ATLAS_API_KEY = "test-key-123";
    expect(detectAuthMode()).toBe("byot");
  });

  it("managed wins over simple-key", () => {
    process.env.BETTER_AUTH_SECRET = "super-secret";
    process.env.ATLAS_API_KEY = "test-key-123";
    expect(detectAuthMode()).toBe("managed");
  });

  it("caches the result across calls", () => {
    process.env.ATLAS_API_KEY = "test-key-123";
    expect(detectAuthMode()).toBe("simple-key");

    // Change env — should still return cached value
    delete process.env.ATLAS_API_KEY;
    process.env.BETTER_AUTH_SECRET = "super-secret";
    expect(detectAuthMode()).toBe("simple-key");
  });

  it("resetAuthModeCache() allows re-detection", () => {
    process.env.ATLAS_API_KEY = "test-key-123";
    expect(detectAuthMode()).toBe("simple-key");

    resetAuthModeCache();
    delete process.env.ATLAS_API_KEY;
    process.env.BETTER_AUTH_SECRET = "super-secret";
    expect(detectAuthMode()).toBe("managed");
  });

  it("auto-detection sets source to 'auto-detected'", () => {
    process.env.ATLAS_API_KEY = "test-key-123";
    detectAuthMode();
    expect(getAuthModeSource()).toBe("auto-detected");
  });

  // -----------------------------------------------------------------------
  // Explicit mode (ATLAS_AUTH_MODE)
  // -----------------------------------------------------------------------

  it("ATLAS_AUTH_MODE=none returns 'none'", () => {
    process.env.ATLAS_AUTH_MODE = "none";
    expect(detectAuthMode()).toBe("none");
    expect(getAuthModeSource()).toBe("explicit");
  });

  it("ATLAS_AUTH_MODE=api-key returns 'simple-key'", () => {
    process.env.ATLAS_AUTH_MODE = "api-key";
    expect(detectAuthMode()).toBe("simple-key");
    expect(getAuthModeSource()).toBe("explicit");
  });

  it("ATLAS_AUTH_MODE=simple-key returns 'simple-key' (internal alias)", () => {
    process.env.ATLAS_AUTH_MODE = "simple-key";
    expect(detectAuthMode()).toBe("simple-key");
    expect(getAuthModeSource()).toBe("explicit");
  });

  it("ATLAS_AUTH_MODE=managed returns 'managed'", () => {
    process.env.ATLAS_AUTH_MODE = "managed";
    expect(detectAuthMode()).toBe("managed");
    expect(getAuthModeSource()).toBe("explicit");
  });

  it("ATLAS_AUTH_MODE=byot returns 'byot'", () => {
    process.env.ATLAS_AUTH_MODE = "byot";
    expect(detectAuthMode()).toBe("byot");
    expect(getAuthModeSource()).toBe("explicit");
  });

  it("ATLAS_AUTH_MODE overrides auto-detection from env vars", () => {
    // JWKS would normally win, but explicit mode takes precedence
    process.env.ATLAS_AUTH_JWKS_URL = "https://example.com/.well-known/jwks.json";
    process.env.BETTER_AUTH_SECRET = "super-secret";
    process.env.ATLAS_AUTH_MODE = "api-key";
    expect(detectAuthMode()).toBe("simple-key");
    expect(getAuthModeSource()).toBe("explicit");
  });

  it("ATLAS_AUTH_MODE is case-insensitive", () => {
    process.env.ATLAS_AUTH_MODE = "API-KEY";
    expect(detectAuthMode()).toBe("simple-key");
    expect(getAuthModeSource()).toBe("explicit");
  });

  it("invalid ATLAS_AUTH_MODE throws", () => {
    process.env.ATLAS_AUTH_MODE = "invalid-mode";
    expect(() => detectAuthMode()).toThrow("Invalid ATLAS_AUTH_MODE 'invalid-mode'");
  });

  it("invalid ATLAS_AUTH_MODE includes valid values in error", () => {
    process.env.ATLAS_AUTH_MODE = "bad";
    expect(() => detectAuthMode()).toThrow("Valid values:");
  });

  it("ATLAS_AUTH_MODE trims whitespace", () => {
    process.env.ATLAS_AUTH_MODE = "  api-key  ";
    expect(detectAuthMode()).toBe("simple-key");
    expect(getAuthModeSource()).toBe("explicit");
  });

  it("ATLAS_AUTH_MODE='' (empty string) falls through to auto-detection", () => {
    process.env.ATLAS_AUTH_MODE = "";
    process.env.ATLAS_API_KEY = "test-key-123";
    expect(detectAuthMode()).toBe("simple-key");
    expect(getAuthModeSource()).toBe("auto-detected");
  });

  it("caches explicit mode result across calls", () => {
    process.env.ATLAS_AUTH_MODE = "managed";
    expect(detectAuthMode()).toBe("managed");

    // Change env — should still return cached value
    process.env.ATLAS_AUTH_MODE = "byot";
    expect(detectAuthMode()).toBe("managed");
  });

  it("getAuthModeSource() returns null before detectAuthMode()", () => {
    expect(getAuthModeSource()).toBeNull();
  });

  it("resetAuthModeCache() clears source too", () => {
    process.env.ATLAS_AUTH_MODE = "managed";
    detectAuthMode();
    expect(getAuthModeSource()).toBe("explicit");

    resetAuthModeCache();
    expect(getAuthModeSource()).toBeNull();
  });
});
