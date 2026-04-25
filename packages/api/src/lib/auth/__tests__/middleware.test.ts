import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import type { AuthResult } from "../types";
import { resetAuthModeCache } from "../detect";
import {
  authenticateRequest,
  checkRateLimit,
  resetRateLimits,
  rateLimitCleanupTick,
  getClientIP,
  _setValidatorOverrides,
  _setSSOEnforcementOverride,
  _setAuditEnforcementBlockOverride,
} from "../middleware";
import type { AdminActionEntry } from "@atlas/api/lib/audit";

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
  const origDatabaseUrl = process.env.DATABASE_URL;

  beforeEach(() => {
    delete process.env.ATLAS_AUTH_JWKS_URL;
    delete process.env.BETTER_AUTH_SECRET;
    delete process.env.ATLAS_API_KEY;
    delete process.env.ATLAS_AUTH_MODE;
    // Unset DATABASE_URL so the managed-auth SSO enforcement check (in
    // ee/auth/sso) short-circuits before touching Postgres. Otherwise the
    // fail-closed catch flips a passing test into a flaky `authenticated: false`
    // 500. Tests that need to exercise the SSO branch use
    // _setSSOEnforcementOverride below instead of a real DB.
    delete process.env.DATABASE_URL;
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

    if (origDatabaseUrl !== undefined) process.env.DATABASE_URL = origDatabaseUrl;
    else delete process.env.DATABASE_URL;

    resetAuthModeCache();
    _setValidatorOverrides({ managed: null, byot: null });
    _setSSOEnforcementOverride(null);
    _setAuditEnforcementBlockOverride(null);
  });

  function makeRequest(headers?: Record<string, string>): Request {
    return new Request("http://localhost/api/v1/chat", {
      method: "POST",
      headers: headers ?? {},
    });
  }

  /** Install an audit-emit override that pushes each entry into the returned
   *  array. Lets tests assert on the captured `sso.enforcement_block` shape
   *  without touching a real internal Postgres. */
  function captureAuditCalls(): AdminActionEntry[] {
    const calls: AdminActionEntry[] = [];
    _setAuditEnforcementBlockOverride((entry) => {
      calls.push(entry);
    });
    return calls;
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

  it("mode 'managed' with SSO enforcement blocks login with 403 + redirect + audit row", async () => {
    process.env.BETTER_AUTH_SECRET = "some-secret-for-managed-auth-32chars!!";
    resetAuthModeCache();

    mockValidateManaged.mockResolvedValueOnce({
      authenticated: true as const,
      mode: "managed" as const,
      user: { id: "usr_1", mode: "managed" as const, label: "alice@enforced.com" },
    });
    _setSSOEnforcementOverride(async (domain) => {
      expect(domain).toBe("enforced.com");
      return { enforced: true, ssoRedirectUrl: "https://idp.enforced.com/sso" };
    });
    const auditCalls = captureAuditCalls();

    const result = await authenticateRequest(makeRequest());
    expect(result.authenticated).toBe(false);
    if (!result.authenticated) {
      expect(result.status).toBe(403);
      expect(result.error).toContain("SSO is required");
      expect(result.ssoRedirectUrl).toBe("https://idp.enforced.com/sso");
    }
    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0]).toMatchObject({
      actionType: "sso.enforcement_block",
      targetType: "sso",
      targetId: "enforced.com",
      status: "failure",
      metadata: { authMode: "managed", userLabel: "alice@enforced.com" },
    });
  });

  it("mode 'managed' with SSO enforcement check throwing fails closed with 500", async () => {
    process.env.BETTER_AUTH_SECRET = "some-secret-for-managed-auth-32chars!!";
    resetAuthModeCache();

    mockValidateManaged.mockResolvedValueOnce({
      authenticated: true as const,
      mode: "managed" as const,
      user: { id: "usr_1", mode: "managed" as const, label: "alice@enforced.com" },
    });
    _setSSOEnforcementOverride(async () => {
      throw new Error("DB unreachable");
    });

    const result = await authenticateRequest(makeRequest());
    expect(result.authenticated).toBe(false);
    if (!result.authenticated) {
      expect(result.status).toBe(500);
      expect(result.error).toContain("Unable to verify SSO enforcement");
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

  // ---------------------------------------------------------------------------
  // F-56 — SSO enforcement gates byot, simple-key stays the documented bypass
  // ---------------------------------------------------------------------------

  it("mode 'simple-key' bypasses SSO enforcement (documented break-glass)", async () => {
    process.env.ATLAS_API_KEY = "test-secret-key";
    resetAuthModeCache();

    // The override should never be invoked — simple-key has no email domain
    // and is the documented escape hatch when SSO breaks (e.g. IdP outage).
    let invocations = 0;
    _setSSOEnforcementOverride(async () => {
      invocations += 1;
      return { enforced: true, ssoRedirectUrl: "https://idp.example/sso" };
    });
    const auditCalls = captureAuditCalls();

    const result = await authenticateRequest(
      makeRequest({ Authorization: "Bearer test-secret-key" }),
    );
    expect(result.authenticated).toBe(true);
    if (result.authenticated) expect(result.user?.mode).toBe("simple-key");
    expect(invocations).toBe(0);
    expect(auditCalls).toHaveLength(0);
  });

  it("mode 'byot' with SSO-enforced domain blocks login with 403 + redirect + audit row", async () => {
    process.env.ATLAS_AUTH_JWKS_URL = "https://example.com/.well-known/jwks.json";
    resetAuthModeCache();

    mockValidateBYOT.mockResolvedValueOnce({
      authenticated: true as const,
      mode: "byot" as const,
      user: { id: "usr_ext", mode: "byot" as const, label: "ext@enforced.com" },
    });
    _setSSOEnforcementOverride(async (domain) => {
      expect(domain).toBe("enforced.com");
      return { enforced: true, ssoRedirectUrl: "https://idp.enforced.com/sso" };
    });
    const auditCalls = captureAuditCalls();

    const result = await authenticateRequest(makeRequest());
    expect(result.authenticated).toBe(false);
    if (!result.authenticated) {
      expect(result.status).toBe(403);
      expect(result.error).toContain("SSO is required");
      expect(result.ssoRedirectUrl).toBe("https://idp.enforced.com/sso");
    }
    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0]).toMatchObject({
      actionType: "sso.enforcement_block",
      targetType: "sso",
      targetId: "enforced.com",
      status: "failure",
      metadata: { authMode: "byot", userLabel: "ext@enforced.com" },
    });
  });

  it("mode 'byot' with non-enforced domain passes through", async () => {
    process.env.ATLAS_AUTH_JWKS_URL = "https://example.com/.well-known/jwks.json";
    resetAuthModeCache();

    mockValidateBYOT.mockResolvedValueOnce({
      authenticated: true as const,
      mode: "byot" as const,
      user: { id: "usr_ext", mode: "byot" as const, label: "ext@open.com" },
    });
    _setSSOEnforcementOverride(async () => ({ enforced: false }));
    const auditCalls = captureAuditCalls();

    const result = await authenticateRequest(makeRequest());
    expect(result.authenticated).toBe(true);
    if (result.authenticated) expect(result.user?.mode).toBe("byot");
    expect(auditCalls).toHaveLength(0);
  });

  it("mode 'byot' with subject-only label (no email) skips SSO enforcement", async () => {
    process.env.ATLAS_AUTH_JWKS_URL = "https://example.com/.well-known/jwks.json";
    resetAuthModeCache();

    // BYOT JWTs without an `email` claim fall back to the `sub` for label.
    // No domain → no SSO check (consistent with simple-key).
    mockValidateBYOT.mockResolvedValueOnce({
      authenticated: true as const,
      mode: "byot" as const,
      user: { id: "usr_ext", mode: "byot" as const, label: "auth0|abc123" },
    });
    let invocations = 0;
    _setSSOEnforcementOverride(async () => {
      invocations += 1;
      return { enforced: true };
    });

    const result = await authenticateRequest(makeRequest());
    expect(result.authenticated).toBe(true);
    expect(invocations).toBe(0);
  });

  it("mode 'managed' with audit-write failure fails closed with 500 (forensic row is the security control)", async () => {
    process.env.BETTER_AUTH_SECRET = "some-secret-for-managed-auth-32chars!!";
    resetAuthModeCache();

    mockValidateManaged.mockResolvedValueOnce({
      authenticated: true as const,
      mode: "managed" as const,
      user: { id: "usr_1", mode: "managed" as const, label: "alice@enforced.com" },
    });
    _setSSOEnforcementOverride(async () => ({
      enforced: true,
      ssoRedirectUrl: "https://idp.enforced.com/sso",
    }));
    _setAuditEnforcementBlockOverride(async () => {
      throw new Error("admin_action_log insert failed — circuit open");
    });

    const result = await authenticateRequest(makeRequest());
    expect(result.authenticated).toBe(false);
    if (!result.authenticated) {
      // If we can't record the bypass attempt, we don't quietly 403 — we
      // 500 so the caller retries and the forensic trail stays whole.
      expect(result.status).toBe(500);
      expect(result.error).toContain("Unable to verify SSO enforcement");
    }
  });

  it("mode 'byot' with SSO enforcement check throwing fails closed with 500", async () => {
    process.env.ATLAS_AUTH_JWKS_URL = "https://example.com/.well-known/jwks.json";
    resetAuthModeCache();

    mockValidateBYOT.mockResolvedValueOnce({
      authenticated: true as const,
      mode: "byot" as const,
      user: { id: "usr_ext", mode: "byot" as const, label: "ext@enforced.com" },
    });
    _setSSOEnforcementOverride(async () => {
      throw new Error("DB unreachable");
    });

    const result = await authenticateRequest(makeRequest());
    expect(result.authenticated).toBe(false);
    if (!result.authenticated) {
      expect(result.status).toBe(500);
      expect(result.error).toContain("Unable to verify SSO enforcement");
    }
  });

  it("mode 'byot' with audit-write failure fails closed with 500 (mirror of managed-side, pins authMode)", async () => {
    // Pins that the F-56 fix doesn't drift back into a byot-only branch
    // that special-cases the audit emission. A regression like
    // `if (mode === "byot") return ... // skip audit, JWT has its own trail`
    // would silently re-introduce the bypass — managed-side audit-fail
    // test wouldn't catch it.
    process.env.ATLAS_AUTH_JWKS_URL = "https://example.com/.well-known/jwks.json";
    resetAuthModeCache();

    mockValidateBYOT.mockResolvedValueOnce({
      authenticated: true as const,
      mode: "byot" as const,
      user: { id: "usr_ext", mode: "byot" as const, label: "ext@enforced.com" },
    });
    _setSSOEnforcementOverride(async () => ({
      enforced: true,
      ssoRedirectUrl: "https://idp.enforced.com/sso",
    }));
    _setAuditEnforcementBlockOverride(async () => {
      throw new Error("admin_action_log insert failed — circuit open");
    });

    const result = await authenticateRequest(makeRequest());
    expect(result.authenticated).toBe(false);
    if (!result.authenticated) {
      expect(result.mode).toBe("byot");
      expect(result.status).toBe(500);
      expect(result.error).toContain("Unable to verify SSO enforcement");
    }
  });

  it("audit-write that hangs past AUDIT_WRITE_TIMEOUT_MS fails closed with 500", async () => {
    // Pins the Promise.race timeout: an unreachable-but-routable internal
    // Postgres can't stall the auth path indefinitely. The override never
    // resolves; the timeout (5s) trips and the catch returns 500.
    process.env.BETTER_AUTH_SECRET = "some-secret-for-managed-auth-32chars!!";
    resetAuthModeCache();

    mockValidateManaged.mockResolvedValueOnce({
      authenticated: true as const,
      mode: "managed" as const,
      user: { id: "usr_1", mode: "managed" as const, label: "alice@enforced.com" },
    });
    _setSSOEnforcementOverride(async () => ({ enforced: true }));

    // Compress the timeout window via a fake-timer-style trick: the override
    // returns a promise that never resolves; we advance Date.now past the
    // 5s deadline via setTimeout fast-forwarding. To keep the test fast and
    // deterministic, race manually against a short controllable timer.
    const neverResolves = new Promise<void>(() => {});
    _setAuditEnforcementBlockOverride(() => neverResolves);

    // Wrap the auth call with our own deadline so the test doesn't itself
    // wait the full 5s. The middleware's internal timer is what we're
    // pinning, so we let it fire — but cap at 6s to avoid a hang on regression.
    const result = await Promise.race([
      authenticateRequest(makeRequest()),
      new Promise<AuthResult>((_, reject) =>
        setTimeout(() => reject(new Error("test deadline exceeded — middleware did not time out")), 6_000),
      ),
    ]);

    expect(result.authenticated).toBe(false);
    if (!result.authenticated) {
      expect(result.status).toBe(500);
      expect(result.error).toContain("Unable to verify SSO enforcement");
    }
  }, 7_000);
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
// F-74 — chat bucket isolation
// ---------------------------------------------------------------------------

describe("checkRateLimit() — chat bucket (F-74)", () => {
  const origRpm = process.env.ATLAS_RATE_LIMIT_RPM;
  const origChatRpm = process.env.ATLAS_RATE_LIMIT_RPM_CHAT;

  beforeEach(() => {
    resetRateLimits();
    process.env.ATLAS_RATE_LIMIT_RPM = "20";
  });

  afterEach(() => {
    if (origRpm !== undefined) process.env.ATLAS_RATE_LIMIT_RPM = origRpm;
    else delete process.env.ATLAS_RATE_LIMIT_RPM;
    if (origChatRpm !== undefined) process.env.ATLAS_RATE_LIMIT_RPM_CHAT = origChatRpm;
    else delete process.env.ATLAS_RATE_LIMIT_RPM_CHAT;
    resetRateLimits();
  });

  it("derives default chat ceiling as max(5, RPM/4) when override unset", () => {
    delete process.env.ATLAS_RATE_LIMIT_RPM_CHAT;
    process.env.ATLAS_RATE_LIMIT_RPM = "20"; // → chat ceiling = 5
    resetRateLimits();

    for (let i = 0; i < 5; i++) {
      expect(checkRateLimit("u", { bucket: "chat" }).allowed).toBe(true);
    }
    expect(checkRateLimit("u", { bucket: "chat" }).allowed).toBe(false);
  });

  it("floor of 5/min applies when ATLAS_RATE_LIMIT_RPM is small", () => {
    delete process.env.ATLAS_RATE_LIMIT_RPM_CHAT;
    // RPM=4 / 4 = 1, but the floor is 5 to keep the chat surface usable.
    process.env.ATLAS_RATE_LIMIT_RPM = "4";
    resetRateLimits();

    for (let i = 0; i < 5; i++) {
      expect(checkRateLimit("u", { bucket: "chat" }).allowed).toBe(true);
    }
    expect(checkRateLimit("u", { bucket: "chat" }).allowed).toBe(false);
  });

  it("ATLAS_RATE_LIMIT_RPM_CHAT override wins over the derived default", () => {
    process.env.ATLAS_RATE_LIMIT_RPM = "100";
    process.env.ATLAS_RATE_LIMIT_RPM_CHAT = "2";
    resetRateLimits();

    expect(checkRateLimit("u", { bucket: "chat" }).allowed).toBe(true);
    expect(checkRateLimit("u", { bucket: "chat" }).allowed).toBe(true);
    expect(checkRateLimit("u", { bucket: "chat" }).allowed).toBe(false);
  });

  it("disables chat bucket when ATLAS_RATE_LIMIT_RPM=0", () => {
    process.env.ATLAS_RATE_LIMIT_RPM = "0";
    process.env.ATLAS_RATE_LIMIT_RPM_CHAT = "2";
    resetRateLimits();

    // When the global limit is disabled the chat bucket inherits "off".
    for (let i = 0; i < 50; i++) {
      expect(checkRateLimit("u", { bucket: "chat" }).allowed).toBe(true);
    }
  });

  // F-74 isolation pin: a chat-burning user's cheap reads must keep working.
  it("chat bucket exhaustion does not lock out the default bucket for the same key", () => {
    process.env.ATLAS_RATE_LIMIT_RPM = "20";
    process.env.ATLAS_RATE_LIMIT_RPM_CHAT = "2";
    resetRateLimits();

    // Burn the chat ceiling.
    expect(checkRateLimit("u", { bucket: "chat" }).allowed).toBe(true);
    expect(checkRateLimit("u", { bucket: "chat" }).allowed).toBe(true);
    expect(checkRateLimit("u", { bucket: "chat" }).allowed).toBe(false);

    // Default bucket on the same key still has its full allowance.
    for (let i = 0; i < 20; i++) {
      expect(checkRateLimit("u").allowed).toBe(true);
    }
    expect(checkRateLimit("u").allowed).toBe(false);
  });

  it("default bucket exhaustion does not lock out the chat bucket for the same key", () => {
    process.env.ATLAS_RATE_LIMIT_RPM = "2";
    process.env.ATLAS_RATE_LIMIT_RPM_CHAT = "5";
    resetRateLimits();

    // Burn the default ceiling.
    expect(checkRateLimit("u").allowed).toBe(true);
    expect(checkRateLimit("u").allowed).toBe(true);
    expect(checkRateLimit("u").allowed).toBe(false);

    // Chat bucket is unaffected.
    for (let i = 0; i < 5; i++) {
      expect(checkRateLimit("u", { bucket: "chat" }).allowed).toBe(true);
    }
    expect(checkRateLimit("u", { bucket: "chat" }).allowed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// rateLimitCleanupTick
// ---------------------------------------------------------------------------

describe("rateLimitCleanupTick()", () => {
  beforeEach(() => {
    resetRateLimits();
    process.env.ATLAS_RATE_LIMIT_RPM = "2";
  });

  afterEach(() => {
    delete process.env.ATLAS_RATE_LIMIT_RPM;
    resetRateLimits();
  });

  it("removes stale keys whose timestamps are all expired", () => {
    // Use up slots for two different keys
    checkRateLimit("stale-user");
    checkRateLimit("stale-user");
    checkRateLimit("active-user");

    // Advance time past the 60s window
    const originalNow = Date.now;
    Date.now = () => originalNow() + 61_000;
    try {
      // Add a fresh timestamp for active-user so it survives cleanup
      checkRateLimit("active-user");

      rateLimitCleanupTick();

      // stale-user should have been evicted — allowed again
      expect(checkRateLimit("stale-user").allowed).toBe(true);
      // active-user should still be tracked (1 fresh timestamp)
      expect(checkRateLimit("active-user").allowed).toBe(true);
      // third call for active-user should be blocked (2 existing + 1 = blocked at limit 2)
      expect(checkRateLimit("active-user").allowed).toBe(false);
    } finally {
      Date.now = originalNow;
    }
  });

  it("is safe to call when no rate limit state exists", () => {
    resetRateLimits();
    rateLimitCleanupTick(); // should not throw
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
    return new Request("http://localhost/api/v1/chat", {
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
