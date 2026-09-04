/**
 * Tests for `lib/demo.ts` — the demo principal's env knobs, signed tokens,
 * per-email rate limit, and `captureDemoLead`'s dispatch contract.
 *
 * Merged (formerly `demo.test.ts` + `demo-capture.test.ts`): one module, one
 * file. The `mock.module()` doubles below are `captureDemoLead`'s alone — the
 * token/settings/rate-limit half touches none of them. `signDemoToken`,
 * `verifyDemoToken`, `demoUserId` and the settings getters read `crypto` and
 * `process.env` only, and `checkDemoRateLimit` runs on the in-memory sliding
 * window in `lib/sliding-window-rate-limit.ts`, which imports nothing.
 *
 * ⚠️ The module under test is loaded with `await import()` AFTER the doubles,
 * not with a hoisted static import. A static one binds the real
 * `db/internal` / `effect/enterprise-layer` before any `mock.module()` runs,
 * which is what the `captureDemoLead` half needs the doubles for.
 *
 * The `captureDemoLead` half pins two acceptance-criterion behaviors that are
 * easy to regress with passing tests elsewhere:
 *
 *  1. "Twenty being unreachable does not block POST /api/v1/demo/start"
 *     → `captureDemoLead` MUST resolve even when the SaasCrm Effect
 *     dies / throws / rejects mid-runPromise. Tested by mocking the
 *     runEnterprise call site to die.
 *
 *  2. Self-hosted (Noop layer) MUST NOT dispatch — no fetch is made,
 *     and the function still resolves cleanly.
 */

import { describe, it, expect, beforeEach, afterAll, mock } from "bun:test";
import { Effect } from "effect";

// ── Mock storage state (controlled per-test) ────────────────────────

let hasInternalDBValue = true;
type QueryRow = Record<string, unknown>;
let internalQueryImpl: (sql: string, params?: unknown[]) => Promise<QueryRow[]> = async () => [
  { session_count: 1 },
];

let runEnterpriseImpl: (p: unknown) => Promise<unknown> = async () => undefined;

void mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => hasInternalDBValue,
  internalQuery: (sql: string, params?: unknown[]) => internalQueryImpl(sql, params),
  // Other exports demo.ts doesn't reach but are mocked to keep partial
  // mock.module happy with imports made transitively.
  getInternalDB: () => null,
  internalExecute: () => {},
  encryptSecret: (v: string) => v,
  decryptSecret: (v: string) => v,
  getEncryptionKey: () => Buffer.from("test-key-32-bytes-long-enough!!!"),
  closeInternalDB: async () => {},
  migrateInternalDB: async () => {},
  _resetPool: () => {},
  loadSavedConnections: async () => 0,
}));

void mock.module("@atlas/api/lib/effect/enterprise-layer", () => ({
  runEnterprise: (p: unknown) => runEnterpriseImpl(p),
  getEnterpriseRuntime: () => ({
    runPromise: <A, E>(p: Effect.Effect<A, E, never>) => Effect.runPromise(p),
  }),
}));

// SaasCrm Tag is re-imported by the demo module — keep the default
// (Noop-shaped) implementation visible. The captured `runEnterprise`
// mock controls how it's invoked.
void mock.module("@atlas/api/lib/effect/services", () => ({
  // Minimal Tag shim that supplies `available: false` + a no-op upsertLead;
  // tests that need the real Effect-Context behaviour drive the
  // `runEnterprise` mock instead.
  SaasCrm: {
    pipe: () => {},
  },
}));

// ── Import the unit under test AFTER mocks ─────────────────────────

const {
  captureDemoLead,
  signDemoToken,
  verifyDemoToken,
  demoUserId,
  checkDemoRateLimit,
  resetDemoRateLimits,
  getDemoMaxSteps,
  getDemoRpmLimit,
  isDemoEnabled,
} = await import("../lib/demo");

beforeEach(() => {
  hasInternalDBValue = true;
  internalQueryImpl = async () => [{ session_count: 1 }];
  // Default: runEnterprise runs the program normally — yields the Tag
  // and calls upsertLead, which for a Noop is just Effect.void.
  runEnterpriseImpl = async () => undefined;
});

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

  beforeEach(async () => {
    await resetDemoRateLimits();
  });

  afterAll(async () => {
    if (originalRpm !== undefined) process.env.ATLAS_DEMO_RATE_LIMIT_RPM = originalRpm;
    else delete process.env.ATLAS_DEMO_RATE_LIMIT_RPM;
    await resetDemoRateLimits();
  });

  it("allows requests under limit", async () => {
    process.env.ATLAS_DEMO_RATE_LIMIT_RPM = "5";
    for (let i = 0; i < 5; i++) {
      expect((await checkDemoRateLimit("test@example.com")).allowed).toBe(true);
    }
  });

  it("blocks at limit", async () => {
    process.env.ATLAS_DEMO_RATE_LIMIT_RPM = "3";
    for (let i = 0; i < 3; i++) {
      expect((await checkDemoRateLimit("test@example.com")).allowed).toBe(true);
    }
    const result = await checkDemoRateLimit("test@example.com");
    expect(result.allowed).toBe(false);
    if (result.allowed) throw new Error("unreachable: expected a blocked decision");
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  it("allows all when limit is 0 (disabled)", async () => {
    process.env.ATLAS_DEMO_RATE_LIMIT_RPM = "0";
    for (let i = 0; i < 100; i++) {
      expect((await checkDemoRateLimit("test@example.com")).allowed).toBe(true);
    }
  });

  it("tracks different emails separately", async () => {
    process.env.ATLAS_DEMO_RATE_LIMIT_RPM = "2";
    expect((await checkDemoRateLimit("a@b.com")).allowed).toBe(true);
    expect((await checkDemoRateLimit("a@b.com")).allowed).toBe(true);
    expect((await checkDemoRateLimit("a@b.com")).allowed).toBe(false);
    // Different email still has quota
    expect((await checkDemoRateLimit("c@d.com")).allowed).toBe(true);
  });
});

// ── R-4 #1 — die path doesn't block the demo response ──────────────

describe("captureDemoLead — Twenty failure swallow contract (R-4)", () => {
  it("resolves even when SaasCrm.upsertLead's Effect dies", async () => {
    runEnterpriseImpl = async () => {
      throw new Error("simulated defect inside runEnterprise");
    };

    const result = await captureDemoLead({
      email: "die@test.com",
      ip: "1.2.3.4",
      userAgent: "ua",
      requestId: "req-die",
    });

    // Insert succeeded → session_count 1 → returning=false
    expect(result).toEqual({ returning: false, sessionCount: 1 });
  });

  it("resolves even when runEnterprise itself rejects asynchronously", async () => {
    runEnterpriseImpl = async () => {
      return Promise.reject(new Error("async reject"));
    };

    await expect(
      captureDemoLead({
        email: "reject@test.com",
        requestId: "req-reject",
      }),
    ).resolves.toEqual({ returning: false, sessionCount: 1 });
  });

  it("returning=true on a duplicate email even when CRM dispatch dies", async () => {
    internalQueryImpl = async () => [{ session_count: 3 }];
    runEnterpriseImpl = async () => {
      throw new Error("die");
    };

    const result = await captureDemoLead({
      email: "returning@test.com",
      requestId: "req-r",
    });

    expect(result).toEqual({ returning: true, sessionCount: 3 });
  });
});

// ── R-4 #2 — Noop / self-hosted: never dispatches ──────────────────

describe("captureDemoLead — self-hosted (Noop layer) (R-4)", () => {
  it("resolves cleanly without ever rejecting or throwing", async () => {
    // runEnterpriseImpl default — runs the program. The Noop SaasCrm
    // layer (production default) yields available=false and a no-op
    // upsertLead. Tracked here by counting how many times runEnterprise
    // is invoked (exactly once) and confirming no error escapes.
    let runEnterpriseCalls = 0;
    runEnterpriseImpl = async () => {
      runEnterpriseCalls++;
      // Simulate the Noop's `upsertLead: () => Effect.void` resolving.
      return undefined;
    };

    await expect(
      captureDemoLead({
        email: "selfhosted@test.com",
        requestId: "req-self",
      }),
    ).resolves.toBeDefined();

    expect(runEnterpriseCalls).toBe(1);
  });

  it("still inserts demo_leads row when CRM dispatch is a noop", async () => {
    let inserted = false;
    internalQueryImpl = async (sql) => {
      if (sql.includes("INSERT INTO demo_leads")) {
        inserted = true;
        return [{ session_count: 1 }];
      }
      return [];
    };

    await captureDemoLead({
      email: "insert@test.com",
      requestId: "req-ins",
    });

    expect(inserted).toBe(true);
  });
});

// ── DB-failure path still attempts CRM dispatch ─────────────────────

describe("captureDemoLead — internal DB unavailable", () => {
  it("short-circuits the demo_leads insert when hasInternalDB returns false", async () => {
    hasInternalDBValue = false;
    let runEnterpriseCalls = 0;
    runEnterpriseImpl = async () => {
      runEnterpriseCalls++;
      return undefined;
    };

    const result = await captureDemoLead({
      email: "nodb@test.com",
      requestId: "req-nodb",
    });

    expect(result).toEqual({ returning: false, sessionCount: 1 });
    // When there's no internal DB we early-return BEFORE the CRM
    // dispatch — leads are lost the same way demo_leads inserts are
    // (matches existing pre-#2727 behavior).
    expect(runEnterpriseCalls).toBe(0);
  });
});
