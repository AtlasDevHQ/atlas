import { describe, it, expect, beforeEach, afterEach, afterAll, mock } from "bun:test";
import type { AuthResult } from "../types";
import { resetAuthModeCache } from "../detect";
import {
  authenticateRequest,
  checkRateLimit,
  resetRateLimits,
  getClientIP,
  _stopCleanup,
  _setValidatorOverrides,
} from "../middleware";

// Mock validators — injected via _setValidatorOverrides (no mock.module needed)
const mockValidateManaged = mock((): Promise<AuthResult> =>
  Promise.resolve({
    authenticated: false as const,
    mode: "managed" as const,
    status: 401 as const,
    error: "Not signed in",
  }),
);

const mockValidateBYOT = mock((): Promise<AuthResult> =>
  Promise.resolve({
    authenticated: false as const,
    mode: "byot" as const,
    status: 401 as const,
    error: "Invalid or expired token",
  }),
);

describe("authenticateRequest()", () => {
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
    _setValidatorOverrides({
      managed: mockValidateManaged,
      byot: mockValidateBYOT,
    });
    mockValidateManaged.mockReset();
    mockValidateManaged.mockResolvedValue({
      authenticated: false as const,
      mode: "managed" as const,
      status: 401 as const,
      error: "Not signed in",
    });
    mockValidateBYOT.mockReset();
    mockValidateBYOT.mockResolvedValue({
      authenticated: false as const,
      mode: "byot" as const,
      status: 401 as const,
      error: "Invalid or expired token",
    });
  });

  afterEach(() => {
    if (origJwks !== undefined) process.env.ATLAS_AUTH_JWKS_URL = origJwks;
    else delete process.env.ATLAS_AUTH_JWKS_URL;

    if (origBetterAuth !== undefined) process.env.BETTER_AUTH_SECRET = origBetterAuth;
    else delete process.env.BETTER_AUTH_SECRET;

    if (origApiKey !== undefined) process.env.ATLAS_API_KEY = origApiKey;
    else delete process.env.ATLAS_API_KEY;

    if (origAuthMode !== undefined) process.env.ATLAS_AUTH_MODE = origAuthMode;
    else delete process.env.ATLAS_AUTH_MODE;

    resetAuthModeCache();
    _setValidatorOverrides({ managed: null, byot: null });
  });

  function makeRequest(headers?: Record<string, string>): Request {
    return new Request("http://localhost/api/chat", {
      method: "POST",
      headers: headers ?? {},
    });
  }

  it("mode 'none' passes through with no user", async () => {
    const result = await authenticateRequest(makeRequest());
    expect(result.authenticated).toBe(true);
    expect(result).toEqual({
      authenticated: true,
      user: undefined,
      mode: "none",
    });
  });

  it("mode 'simple-key' with valid key succeeds", async () => {
    process.env.ATLAS_API_KEY = "test-secret-key";
    resetAuthModeCache();

    const result = await authenticateRequest(
      makeRequest({ Authorization: "Bearer test-secret-key" }),
    );
    expect(result).toEqual(
      expect.objectContaining({
        authenticated: true,
        user: expect.objectContaining({ mode: "simple-key" }),
      }),
    );
  });

  it("mode 'simple-key' with wrong key returns 401", async () => {
    process.env.ATLAS_API_KEY = "test-secret-key";
    resetAuthModeCache();

    const result = await authenticateRequest(
      makeRequest({ Authorization: "Bearer wrong-key" }),
    );
    expect(result.authenticated).toBe(false);
    if (!result.authenticated) {
      expect(result.status).toBe(401);
    }
  });

  it("mode 'simple-key' with no header returns 401", async () => {
    process.env.ATLAS_API_KEY = "test-secret-key";
    resetAuthModeCache();

    const result = await authenticateRequest(makeRequest());
    expect(result.authenticated).toBe(false);
    if (!result.authenticated) {
      expect(result.status).toBe(401);
    }
  });

  it("mode 'managed' with valid session returns authenticated", async () => {
    process.env.BETTER_AUTH_SECRET = "some-secret-for-managed-auth-32chars!!";
    resetAuthModeCache();

    mockValidateManaged.mockResolvedValueOnce({
      authenticated: true as const,
      mode: "managed" as const,
      user: { id: "usr_1", mode: "managed" as const, label: "alice@test.com" },
    });

    const result = await authenticateRequest(makeRequest());
    expect(result.authenticated).toBe(true);
    if (result.authenticated) {
      expect(result.user?.mode).toBe("managed");
    }
  });

  it("mode 'managed' with no session returns 401", async () => {
    process.env.BETTER_AUTH_SECRET = "some-secret-for-managed-auth-32chars!!";
    resetAuthModeCache();

    const result = await authenticateRequest(makeRequest());
    expect(result.authenticated).toBe(false);
    if (!result.authenticated) {
      expect(result.status).toBe(401);
    }
  });

  it("mode 'managed' with unexpected error returns 500", async () => {
    process.env.BETTER_AUTH_SECRET = "some-secret-for-managed-auth-32chars!!";
    resetAuthModeCache();

    mockValidateManaged.mockRejectedValueOnce(new Error("DB crashed"));

    const result = await authenticateRequest(makeRequest());
    expect(result.authenticated).toBe(false);
    if (!result.authenticated) {
      expect(result.status).toBe(500);
      expect(result.error).toContain("Authentication service error");
    }
  });

  it("mode 'managed' with non-Error rejection returns 500", async () => {
    process.env.BETTER_AUTH_SECRET = "some-secret-for-managed-auth-32chars!!";
    resetAuthModeCache();

    mockValidateManaged.mockRejectedValueOnce("something went wrong");

    const result = await authenticateRequest(makeRequest());
    expect(result.authenticated).toBe(false);
    if (!result.authenticated) {
      expect(result.status).toBe(500);
      expect(result.error).toContain("Authentication service error");
    }
  });

  it("mode 'byot' with valid token returns authenticated", async () => {
    process.env.ATLAS_AUTH_JWKS_URL = "https://example.com/.well-known/jwks.json";
    resetAuthModeCache();

    mockValidateBYOT.mockResolvedValueOnce({
      authenticated: true as const,
      mode: "byot" as const,
      user: { id: "usr_ext", mode: "byot" as const, label: "ext@idp.com" },
    });

    const result = await authenticateRequest(makeRequest());
    expect(result.authenticated).toBe(true);
    if (result.authenticated) {
      expect(result.user?.mode).toBe("byot");
    }
  });

  it("mode 'byot' with invalid token returns 401", async () => {
    process.env.ATLAS_AUTH_JWKS_URL = "https://example.com/.well-known/jwks.json";
    resetAuthModeCache();

    const result = await authenticateRequest(makeRequest());
    expect(result.authenticated).toBe(false);
    if (!result.authenticated) {
      expect(result.status).toBe(401);
    }
  });

  it("mode 'byot' with unexpected error returns 500", async () => {
    process.env.ATLAS_AUTH_JWKS_URL = "https://example.com/.well-known/jwks.json";
    resetAuthModeCache();

    mockValidateBYOT.mockRejectedValueOnce(new Error("JWKS fetch failed"));

    const result = await authenticateRequest(makeRequest());
    expect(result.authenticated).toBe(false);
    if (!result.authenticated) {
      expect(result.status).toBe(500);
      expect(result.error).toContain("Authentication service error");
    }
  });

  it("mode 'byot' with non-Error rejection returns 500", async () => {
    process.env.ATLAS_AUTH_JWKS_URL = "https://example.com/.well-known/jwks.json";
    resetAuthModeCache();

    mockValidateBYOT.mockRejectedValueOnce("connection lost");

    const result = await authenticateRequest(makeRequest());
    expect(result.authenticated).toBe(false);
    if (!result.authenticated) {
      expect(result.status).toBe(500);
      expect(result.error).toContain("Authentication service error");
    }
  });
});

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

describe("checkRateLimit()", () => {
  const origRpm = process.env.ATLAS_RATE_LIMIT_RPM;

  beforeEach(() => {
    resetRateLimits();
    process.env.ATLAS_RATE_LIMIT_RPM = "5"; // low limit for tests
  });

  afterEach(() => {
    if (origRpm !== undefined) process.env.ATLAS_RATE_LIMIT_RPM = origRpm;
    else delete process.env.ATLAS_RATE_LIMIT_RPM;
    resetRateLimits();
  });

  // Stop the cleanup timer once after all rate limit tests
  afterAll(() => {
    _stopCleanup();
  });

  it("allows requests under the limit", () => {
    for (let i = 0; i < 4; i++) {
      expect(checkRateLimit("user1").allowed).toBe(true);
    }
  });

  it("blocks at the limit and returns retryAfterMs > 0", () => {
    for (let i = 0; i < 5; i++) {
      checkRateLimit("user2");
    }
    const result = checkRateLimit("user2");
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  it("allows again after window expires", () => {
    // Manually inject old timestamps to simulate expired window
    process.env.ATLAS_RATE_LIMIT_RPM = "2";
    resetRateLimits();

    // First two allowed
    expect(checkRateLimit("user3").allowed).toBe(true);
    expect(checkRateLimit("user3").allowed).toBe(true);
    // Third blocked
    expect(checkRateLimit("user3").allowed).toBe(false);

    // Reset and re-check — simulates window expiry
    resetRateLimits();
    expect(checkRateLimit("user3").allowed).toBe(true);
  });

  it("sliding window evicts stale timestamps after 60s", () => {
    process.env.ATLAS_RATE_LIMIT_RPM = "2";
    resetRateLimits();

    // Use up all 2 slots
    expect(checkRateLimit("window-user").allowed).toBe(true);
    expect(checkRateLimit("window-user").allowed).toBe(true);
    expect(checkRateLimit("window-user").allowed).toBe(false);

    // Advance time past the 60s window
    const originalNow = Date.now;
    Date.now = () => originalNow() + 61_000;
    try {
      // Old timestamps should be evicted — requests allowed again
      expect(checkRateLimit("window-user").allowed).toBe(true);
      expect(checkRateLimit("window-user").allowed).toBe(true);
      // Third should be blocked again
      expect(checkRateLimit("window-user").allowed).toBe(false);
    } finally {
      Date.now = originalNow;
    }
  });

  it("resetRateLimits() clears all state", () => {
    for (let i = 0; i < 5; i++) {
      checkRateLimit("user4");
    }
    expect(checkRateLimit("user4").allowed).toBe(false);

    resetRateLimits();
    expect(checkRateLimit("user4").allowed).toBe(true);
  });

  it("always allows when ATLAS_RATE_LIMIT_RPM=0", () => {
    process.env.ATLAS_RATE_LIMIT_RPM = "0";

    for (let i = 0; i < 100; i++) {
      expect(checkRateLimit("user5").allowed).toBe(true);
    }
  });

  it("always allows when ATLAS_RATE_LIMIT_RPM is not set", () => {
    delete process.env.ATLAS_RATE_LIMIT_RPM;

    for (let i = 0; i < 100; i++) {
      expect(checkRateLimit("user6").allowed).toBe(true);
    }
  });

  it("tracks separate keys independently", () => {
    process.env.ATLAS_RATE_LIMIT_RPM = "2";
    resetRateLimits();

    expect(checkRateLimit("a").allowed).toBe(true);
    expect(checkRateLimit("a").allowed).toBe(true);
    expect(checkRateLimit("a").allowed).toBe(false);

    // Different key should still be allowed
    expect(checkRateLimit("b").allowed).toBe(true);
  });

  it("treats non-numeric ATLAS_RATE_LIMIT_RPM as disabled", () => {
    process.env.ATLAS_RATE_LIMIT_RPM = "abc";
    resetRateLimits();

    for (let i = 0; i < 100; i++) {
      expect(checkRateLimit("user7").allowed).toBe(true);
    }
  });

  it("treats negative ATLAS_RATE_LIMIT_RPM as disabled", () => {
    process.env.ATLAS_RATE_LIMIT_RPM = "-5";
    resetRateLimits();

    for (let i = 0; i < 100; i++) {
      expect(checkRateLimit("user8").allowed).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// getClientIP
// ---------------------------------------------------------------------------

describe("getClientIP()", () => {
  const origTrustProxy = process.env.ATLAS_TRUST_PROXY;

  afterEach(() => {
    if (origTrustProxy !== undefined) process.env.ATLAS_TRUST_PROXY = origTrustProxy;
    else delete process.env.ATLAS_TRUST_PROXY;
  });

  function req(headers: Record<string, string>): Request {
    return new Request("http://localhost/api/chat", {
      method: "POST",
      headers,
    });
  }

  it("returns the single IP from X-Forwarded-For when proxy is trusted", () => {
    process.env.ATLAS_TRUST_PROXY = "true";
    expect(getClientIP(req({ "x-forwarded-for": "1.2.3.4" }))).toBe("1.2.3.4");
  });

  it("returns the first IP when X-Forwarded-For has multiple and proxy is trusted", () => {
    process.env.ATLAS_TRUST_PROXY = "1";
    expect(
      getClientIP(req({ "x-forwarded-for": "1.2.3.4, 5.6.7.8, 9.10.11.12" })),
    ).toBe("1.2.3.4");
  });

  it("ignores X-Forwarded-For when ATLAS_TRUST_PROXY is not set", () => {
    delete process.env.ATLAS_TRUST_PROXY;
    expect(getClientIP(req({ "x-forwarded-for": "1.2.3.4" }))).toBeNull();
  });

  it("ignores X-Forwarded-For when ATLAS_TRUST_PROXY is false", () => {
    process.env.ATLAS_TRUST_PROXY = "false";
    expect(getClientIP(req({ "x-forwarded-for": "1.2.3.4" }))).toBeNull();
  });

  it("returns null for X-Real-IP when proxy is untrusted", () => {
    delete process.env.ATLAS_TRUST_PROXY;
    expect(getClientIP(req({ "x-real-ip": "10.0.0.1" }))).toBeNull();
  });

  it("returns X-Real-IP when proxy is trusted", () => {
    process.env.ATLAS_TRUST_PROXY = "true";
    expect(getClientIP(req({ "x-real-ip": "10.0.0.1" }))).toBe("10.0.0.1");
  });

  it("returns null when proxy is untrusted even with XFF and X-Real-IP present", () => {
    delete process.env.ATLAS_TRUST_PROXY;
    expect(
      getClientIP(
        req({ "x-forwarded-for": "1.2.3.4", "x-real-ip": "10.0.0.1" }),
      ),
    ).toBeNull();
  });

  it("returns null when no IP headers present", () => {
    expect(getClientIP(req({}))).toBeNull();
  });

  it("X-Forwarded-For takes precedence over X-Real-IP when proxy is trusted", () => {
    process.env.ATLAS_TRUST_PROXY = "true";
    expect(
      getClientIP(
        req({ "x-forwarded-for": "1.2.3.4", "x-real-ip": "10.0.0.1" }),
      ),
    ).toBe("1.2.3.4");
  });
});
