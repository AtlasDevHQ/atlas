import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import {
  signDemoToken,
  verifyDemoToken,
  demoUserId,
  checkDemoRateLimit,
  resetDemoRateLimits,
  getDemoMaxSteps,
  getDemoRpmLimit,
  isDemoEnabled,
} from "@atlas/api/lib/demo";

describe("isDemoEnabled", () => {
  const original = process.env.ATLAS_DEMO_ENABLED;
  afterAll(() => {
    if (original !== undefined) process.env.ATLAS_DEMO_ENABLED = original;
    else delete process.env.ATLAS_DEMO_ENABLED;
  });

  it("returns false when unset", () => {
    delete process.env.ATLAS_DEMO_ENABLED;
    expect(isDemoEnabled()).toBe(false);
  });

  it("returns true when set to 'true'", () => {
    process.env.ATLAS_DEMO_ENABLED = "true";
    expect(isDemoEnabled()).toBe(true);
  });

  it("returns false for other values", () => {
    process.env.ATLAS_DEMO_ENABLED = "1";
    expect(isDemoEnabled()).toBe(false);
  });
});

describe("getDemoMaxSteps", () => {
  const original = process.env.ATLAS_DEMO_MAX_STEPS;
  afterAll(() => {
    if (original !== undefined) process.env.ATLAS_DEMO_MAX_STEPS = original;
    else delete process.env.ATLAS_DEMO_MAX_STEPS;
  });

  it("returns default 10 when unset", () => {
    delete process.env.ATLAS_DEMO_MAX_STEPS;
    expect(getDemoMaxSteps()).toBe(10);
  });

  it("respects valid env var", () => {
    process.env.ATLAS_DEMO_MAX_STEPS = "5";
    expect(getDemoMaxSteps()).toBe(5);
  });

  it("clamps to default for invalid values", () => {
    process.env.ATLAS_DEMO_MAX_STEPS = "0";
    expect(getDemoMaxSteps()).toBe(10);
    process.env.ATLAS_DEMO_MAX_STEPS = "101";
    expect(getDemoMaxSteps()).toBe(10);
    process.env.ATLAS_DEMO_MAX_STEPS = "abc";
    expect(getDemoMaxSteps()).toBe(10);
  });
});

describe("getDemoRpmLimit", () => {
  const original = process.env.ATLAS_DEMO_RATE_LIMIT_RPM;
  afterAll(() => {
    if (original !== undefined) process.env.ATLAS_DEMO_RATE_LIMIT_RPM = original;
    else delete process.env.ATLAS_DEMO_RATE_LIMIT_RPM;
  });

  it("returns default 10 when unset", () => {
    delete process.env.ATLAS_DEMO_RATE_LIMIT_RPM;
    expect(getDemoRpmLimit()).toBe(10);
  });

  it("returns 0 to disable", () => {
    process.env.ATLAS_DEMO_RATE_LIMIT_RPM = "0";
    expect(getDemoRpmLimit()).toBe(0);
  });

  it("returns default for invalid values", () => {
    process.env.ATLAS_DEMO_RATE_LIMIT_RPM = "abc";
    expect(getDemoRpmLimit()).toBe(10);
  });
});

describe("signDemoToken / verifyDemoToken", () => {
  const original = process.env.BETTER_AUTH_SECRET;
  afterAll(() => {
    if (original !== undefined) process.env.BETTER_AUTH_SECRET = original;
    else delete process.env.BETTER_AUTH_SECRET;
  });

  it("returns null when BETTER_AUTH_SECRET is not set", () => {
    delete process.env.BETTER_AUTH_SECRET;
    expect(signDemoToken("test@example.com")).toBeNull();
  });

  it("signs and verifies a valid token", () => {
    process.env.BETTER_AUTH_SECRET = "test-secret-that-is-at-least-32-chars-long";
    const result = signDemoToken("test@example.com");
    expect(result).not.toBeNull();
    expect(result!.token).toContain(".");
    expect(result!.expiresAt).toBeGreaterThan(Date.now());

    const email = verifyDemoToken(result!.token);
    expect(email).toBe("test@example.com");
  });

  it("normalizes email to lowercase", () => {
    process.env.BETTER_AUTH_SECRET = "test-secret-that-is-at-least-32-chars-long";
    const result = signDemoToken("Test@Example.COM");
    expect(result).not.toBeNull();

    const email = verifyDemoToken(result!.token);
    expect(email).toBe("test@example.com");
  });

  it("rejects tampered token", () => {
    process.env.BETTER_AUTH_SECRET = "test-secret-that-is-at-least-32-chars-long";
    const result = signDemoToken("test@example.com");
    expect(result).not.toBeNull();

    // Tamper with the signature
    const parts = result!.token.split(".");
    const tampered = `${parts[0]}.AAAA${parts[1].slice(4)}`;
    expect(verifyDemoToken(tampered)).toBeNull();
  });

  it("rejects malformed token", () => {
    process.env.BETTER_AUTH_SECRET = "test-secret-that-is-at-least-32-chars-long";
    expect(verifyDemoToken("")).toBeNull();
    expect(verifyDemoToken("only-one-part")).toBeNull();
    expect(verifyDemoToken("a.b.c")).toBeNull();
  });

  it("verifies non-expired token succeeds", () => {
    process.env.BETTER_AUTH_SECRET = "test-secret-that-is-at-least-32-chars-long";
    const result = signDemoToken("test@example.com");
    expect(result).not.toBeNull();
    // Token was just signed, so it should not be expired
    expect(verifyDemoToken(result!.token)).toBe("test@example.com");
  });

  it("rejects token when secret changes", () => {
    process.env.BETTER_AUTH_SECRET = "original-secret-that-is-at-least-32-chars";
    const result = signDemoToken("test@example.com");
    expect(result).not.toBeNull();

    // Change the secret
    process.env.BETTER_AUTH_SECRET = "different-secret-that-is-at-least-32-chars";
    expect(verifyDemoToken(result!.token)).toBeNull();
  });
});

describe("demoUserId", () => {
  it("returns a deterministic hash-based ID", () => {
    const id1 = demoUserId("test@example.com");
    const id2 = demoUserId("test@example.com");
    expect(id1).toBe(id2);
    expect(id1).toMatch(/^demo:[a-f0-9]{16}$/);
  });

  it("normalizes email", () => {
    expect(demoUserId("Test@Example.COM")).toBe(demoUserId("test@example.com"));
  });

  it("produces different IDs for different emails", () => {
    expect(demoUserId("a@b.com")).not.toBe(demoUserId("c@d.com"));
  });
});

describe("checkDemoRateLimit", () => {
  const originalRpm = process.env.ATLAS_DEMO_RATE_LIMIT_RPM;

  beforeEach(() => {
    resetDemoRateLimits();
  });

  afterAll(() => {
    if (originalRpm !== undefined) process.env.ATLAS_DEMO_RATE_LIMIT_RPM = originalRpm;
    else delete process.env.ATLAS_DEMO_RATE_LIMIT_RPM;
    resetDemoRateLimits();
  });

  it("allows requests under limit", () => {
    process.env.ATLAS_DEMO_RATE_LIMIT_RPM = "5";
    for (let i = 0; i < 5; i++) {
      expect(checkDemoRateLimit("test@example.com").allowed).toBe(true);
    }
  });

  it("blocks at limit", () => {
    process.env.ATLAS_DEMO_RATE_LIMIT_RPM = "3";
    for (let i = 0; i < 3; i++) {
      expect(checkDemoRateLimit("test@example.com").allowed).toBe(true);
    }
    const result = checkDemoRateLimit("test@example.com");
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  it("allows all when limit is 0 (disabled)", () => {
    process.env.ATLAS_DEMO_RATE_LIMIT_RPM = "0";
    for (let i = 0; i < 100; i++) {
      expect(checkDemoRateLimit("test@example.com").allowed).toBe(true);
    }
  });

  it("tracks different emails separately", () => {
    process.env.ATLAS_DEMO_RATE_LIMIT_RPM = "2";
    expect(checkDemoRateLimit("a@b.com").allowed).toBe(true);
    expect(checkDemoRateLimit("a@b.com").allowed).toBe(true);
    expect(checkDemoRateLimit("a@b.com").allowed).toBe(false);
    // Different email still has quota
    expect(checkDemoRateLimit("c@d.com").allowed).toBe(true);
  });
});
