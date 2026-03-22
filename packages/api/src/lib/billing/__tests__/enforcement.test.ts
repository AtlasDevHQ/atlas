/**
 * Tests for plan limit enforcement with graceful degradation.
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  mock,
} from "bun:test";

// --- Mocks ---

let mockHasInternalDB = true;
let mockWorkspace: Record<string, unknown> | null = null;
let mockUsage = { queryCount: 0, tokenCount: 0, activeUsers: 0, periodStart: "", periodEnd: "" };
let mockWorkspaceDetailsShouldThrow = false;
let mockUsageShouldThrow = false;

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => mockHasInternalDB,
  getWorkspaceDetails: async (orgId: string) => {
    if (mockWorkspaceDetailsShouldThrow) throw new Error("db error");
    return orgId ? mockWorkspace : null;
  },
  getWorkspaceStatus: async () => mockWorkspace?.workspace_status ?? null,
  getInternalDB: () => ({ query: mock(() => Promise.resolve({ rows: [] })), end: mock(() => {}), on: mock(() => {}) }),
  internalQuery: async () => [],
  internalExecute: () => {},
  _resetPool: () => {},
  _resetCircuitBreaker: () => {},
  updateWorkspacePlanTier: async () => true,
  updateWorkspaceByot: async () => true,
  setWorkspaceStripeCustomerId: async () => true,
  setWorkspaceTrialEndsAt: async () => true,
}));

mock.module("@atlas/api/lib/metering", () => ({
  getCurrentPeriodUsage: async () => {
    if (mockUsageShouldThrow) throw new Error("metering error");
    return mockUsage;
  },
  logUsageEvent: () => {},
  aggregateUsageSummary: async () => {},
  getUsageHistory: async () => [],
  getUsageBreakdown: async () => [],
}));

mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
  getRequestContext: () => null,
  withRequestContext: (_ctx: unknown, fn: () => unknown) => fn(),
}));

// --- Import under test ---

import { checkPlanLimits, invalidatePlanCache, type PlanCheckResult } from "@atlas/api/lib/billing/enforcement";

/** Narrow a denied result for type-safe assertion access. */
function expectDenied(result: PlanCheckResult): Extract<PlanCheckResult, { allowed: false }> {
  expect(result.allowed).toBe(false);
  return result as Extract<PlanCheckResult, { allowed: false }>;
}

/** Narrow to a plan_limit_exceeded result with usage data. */
function expectLimitExceeded(result: PlanCheckResult): Extract<PlanCheckResult, { errorCode: "plan_limit_exceeded" }> {
  expect(result.allowed).toBe(false);
  if (!result.allowed) {
    expect(result.errorCode).toBe("plan_limit_exceeded");
  }
  return result as Extract<PlanCheckResult, { errorCode: "plan_limit_exceeded" }>;
}

/** Narrow an allowed result for type-safe assertion access. */
function expectAllowed(result: PlanCheckResult): Extract<PlanCheckResult, { allowed: true }> {
  expect(result.allowed).toBe(true);
  return result as Extract<PlanCheckResult, { allowed: true }>;
}

/** Create a standard workspace fixture. */
function makeWorkspace(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: "org-1",
    name: "Test",
    slug: "test",
    workspace_status: "active",
    plan_tier: "team",
    byot: false,
    stripe_customer_id: null,
    trial_ends_at: null,
    suspended_at: null,
    deleted_at: null,
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("billing/enforcement", () => {
  beforeEach(() => {
    mockHasInternalDB = true;
    mockWorkspaceDetailsShouldThrow = false;
    mockUsageShouldThrow = false;
    mockUsage = { queryCount: 0, tokenCount: 0, activeUsers: 0, periodStart: "", periodEnd: "" };
    mockWorkspace = null;
    invalidatePlanCache();
  });

  // ── Pass-through cases ────────────────────────────────────────────

  it("allows when no orgId provided", async () => {
    const result = await checkPlanLimits(undefined);
    expect(result.allowed).toBe(true);
  });

  it("allows when no internal DB", async () => {
    mockHasInternalDB = false;
    const result = await checkPlanLimits("org-1");
    expect(result.allowed).toBe(true);
  });

  it("allows when workspace not found (pre-migration)", async () => {
    mockWorkspace = null;
    const result = await checkPlanLimits("org-1");
    expect(result.allowed).toBe(true);
  });

  // ── Free tier ─────────────────────────────────────────────────────

  it("allows free tier unconditionally", async () => {
    mockWorkspace = makeWorkspace({ plan_tier: "free" });
    mockUsage = { queryCount: 999_999, tokenCount: 999_999_999, activeUsers: 0, periodStart: "", periodEnd: "" };
    const result = await checkPlanLimits("org-1");
    expect(result.allowed).toBe(true);
  });

  // ── Enterprise tier ───────────────────────────────────────────────

  it("allows enterprise tier unconditionally", async () => {
    mockWorkspace = makeWorkspace({ plan_tier: "enterprise" });
    mockUsage = { queryCount: 999_999, tokenCount: 999_999_999, activeUsers: 0, periodStart: "", periodEnd: "" };
    const result = await checkPlanLimits("org-1");
    expect(result.allowed).toBe(true);
  });

  // ── Trial tier ────────────────────────────────────────────────────

  it("allows trial tier within trial period", async () => {
    const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    mockWorkspace = makeWorkspace({ plan_tier: "trial", trial_ends_at: futureDate, createdAt: new Date().toISOString() });
    mockUsage = { queryCount: 100, tokenCount: 1000, activeUsers: 0, periodStart: "", periodEnd: "" };
    const result = await checkPlanLimits("org-1");
    expect(result.allowed).toBe(true);
  });

  it("blocks expired trial", async () => {
    const pastDate = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
    mockWorkspace = makeWorkspace({ plan_tier: "trial", trial_ends_at: pastDate });
    const denied = expectDenied(await checkPlanLimits("org-1"));
    expect(denied.errorCode).toBe("trial_expired");
    expect(denied.httpStatus).toBe(403);
  });

  it("allows trial without trial_ends_at when created recently", async () => {
    const recentDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    mockWorkspace = makeWorkspace({ plan_tier: "trial", trial_ends_at: null, createdAt: recentDate });
    mockUsage = { queryCount: 100, tokenCount: 1000, activeUsers: 0, periodStart: "", periodEnd: "" };
    const result = await checkPlanLimits("org-1");
    expect(result.allowed).toBe(true);
  });

  it("blocks trial without trial_ends_at when created > 14 days ago", async () => {
    const oldDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    mockWorkspace = makeWorkspace({ plan_tier: "trial", trial_ends_at: null, createdAt: oldDate });
    const denied = expectDenied(await checkPlanLimits("org-1"));
    expect(denied.errorCode).toBe("trial_expired");
  });

  // ── Team tier — OK (below 80%) ────────────────────────────────────

  it("allows at 79% with no warning (boundary: just below warning)", async () => {
    mockWorkspace = makeWorkspace();
    // 79% of 10,000 = 7,900
    mockUsage = { queryCount: 7_900, tokenCount: 0, activeUsers: 0, periodStart: "", periodEnd: "" };
    const result = expectAllowed(await checkPlanLimits("org-1"));
    expect(result.warning).toBeUndefined();
  });

  it("allows team tier below 80% with no warning", async () => {
    mockWorkspace = makeWorkspace();
    mockUsage = { queryCount: 500, tokenCount: 10_000, activeUsers: 0, periodStart: "", periodEnd: "" };
    const result = expectAllowed(await checkPlanLimits("org-1"));
    expect(result.warning).toBeUndefined();
  });

  // ── Team tier — Warning (80–99%) ──────────────────────────────────

  it("returns warning at 80% query usage", async () => {
    mockWorkspace = makeWorkspace();
    // 80% of 10,000 = 8,000
    mockUsage = { queryCount: 8_000, tokenCount: 0, activeUsers: 0, periodStart: "", periodEnd: "" };
    const result = expectAllowed(await checkPlanLimits("org-1"));
    expect(result.warning).toBeDefined();
    expect(result.warning!.code).toBe("plan_limit_warning");
    expect(result.warning!.message).toContain("approaching");
    const queryMetric = result.warning!.metrics.find((m) => m.metric === "queries");
    expect(queryMetric).toBeDefined();
    expect(queryMetric!.status).toBe("warning");
    expect(queryMetric!.usagePercent).toBe(80);
  });

  it("returns warning at 95% token usage", async () => {
    mockWorkspace = makeWorkspace();
    // 95% of 5,000,000 = 4,750,000
    mockUsage = { queryCount: 0, tokenCount: 4_750_000, activeUsers: 0, periodStart: "", periodEnd: "" };
    const result = expectAllowed(await checkPlanLimits("org-1"));
    expect(result.warning).toBeDefined();
    const tokenMetric = result.warning!.metrics.find((m) => m.metric === "tokens");
    expect(tokenMetric).toBeDefined();
    expect(tokenMetric!.status).toBe("warning");
    expect(tokenMetric!.usagePercent).toBe(95);
  });

  // ── Team tier — Soft limit (100–109%) ─────────────────────────────

  it("allows with soft limit warning at 100% query usage", async () => {
    mockWorkspace = makeWorkspace();
    mockUsage = { queryCount: 10_000, tokenCount: 0, activeUsers: 0, periodStart: "", periodEnd: "" };
    const result = expectAllowed(await checkPlanLimits("org-1"));
    expect(result.warning).toBeDefined();
    expect(result.warning!.message).toContain("grace period");
    const queryMetric = result.warning!.metrics.find((m) => m.metric === "queries");
    expect(queryMetric!.status).toBe("soft_limit");
    expect(queryMetric!.usagePercent).toBe(100);
  });

  it("allows with soft limit warning at 105% query usage", async () => {
    mockWorkspace = makeWorkspace();
    // 105% of 10,000 = 10,500
    mockUsage = { queryCount: 10_500, tokenCount: 0, activeUsers: 0, periodStart: "", periodEnd: "" };
    const result = expectAllowed(await checkPlanLimits("org-1"));
    expect(result.warning).toBeDefined();
    const queryMetric = result.warning!.metrics.find((m) => m.metric === "queries");
    expect(queryMetric!.status).toBe("soft_limit");
  });

  it("allows with soft limit at 109% token usage", async () => {
    mockWorkspace = makeWorkspace();
    // 109% of 5,000,000 = 5,450,000
    mockUsage = { queryCount: 0, tokenCount: 5_450_000, activeUsers: 0, periodStart: "", periodEnd: "" };
    const result = expectAllowed(await checkPlanLimits("org-1"));
    expect(result.warning).toBeDefined();
    const tokenMetric = result.warning!.metrics.find((m) => m.metric === "tokens");
    expect(tokenMetric!.status).toBe("soft_limit");
  });

  // ── Team tier — Boundary: 109% is soft, 110% is hard ──────────────

  it("allows at 109% query usage (boundary: just below hard limit)", async () => {
    mockWorkspace = makeWorkspace();
    // 109% of 10,000 = 10,900
    mockUsage = { queryCount: 10_900, tokenCount: 0, activeUsers: 0, periodStart: "", periodEnd: "" };
    const result = expectAllowed(await checkPlanLimits("org-1"));
    expect(result.warning).toBeDefined();
    const queryMetric = result.warning!.metrics.find((m) => m.metric === "queries");
    expect(queryMetric!.status).toBe("soft_limit");
  });

  // ── Team tier — Hard limit (110%+) ────────────────────────────────

  it("blocks at 110% query usage", async () => {
    mockWorkspace = makeWorkspace();
    // 110% of 10,000 = 11,000
    mockUsage = { queryCount: 11_000, tokenCount: 0, activeUsers: 0, periodStart: "", periodEnd: "" };
    const exceeded = expectLimitExceeded(await checkPlanLimits("org-1"));
    expect(exceeded.httpStatus).toBe(429);
    expect(exceeded.errorMessage).toContain("queries");
    expect(exceeded.errorMessage).toContain("grace buffer");
    expect(exceeded.usage.currentUsage).toBe(11_000);
    expect(exceeded.usage.limit).toBe(10_000);
    expect(exceeded.usage.metric).toBe("queries");
  });

  it("blocks at 150% token usage", async () => {
    mockWorkspace = makeWorkspace();
    // 150% of 5,000,000 = 7,500,000
    mockUsage = { queryCount: 0, tokenCount: 7_500_000, activeUsers: 0, periodStart: "", periodEnd: "" };
    const exceeded = expectLimitExceeded(await checkPlanLimits("org-1"));
    expect(exceeded.httpStatus).toBe(429);
    expect(exceeded.usage.metric).toBe("tokens");
  });

  it("blocks on worst metric when queries are hard-limited but tokens are ok", async () => {
    mockWorkspace = makeWorkspace();
    mockUsage = { queryCount: 12_000, tokenCount: 1_000_000, activeUsers: 0, periodStart: "", periodEnd: "" };
    const exceeded = expectLimitExceeded(await checkPlanLimits("org-1"));
    expect(exceeded.usage.metric).toBe("queries");
  });

  // ── Trial tier — usage limits ────────────────────────────────────

  it("blocks trial tier at hard limit", async () => {
    const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    mockWorkspace = makeWorkspace({ plan_tier: "trial", trial_ends_at: futureDate, createdAt: new Date().toISOString() });
    mockUsage = { queryCount: 11_000, tokenCount: 0, activeUsers: 0, periodStart: "", periodEnd: "" };
    const denied = expectDenied(await checkPlanLimits("org-1"));
    expect(denied.errorCode).toBe("plan_limit_exceeded");
    expect(denied.httpStatus).toBe(429);
  });

  it("warns trial tier at 85% usage", async () => {
    const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    mockWorkspace = makeWorkspace({ plan_tier: "trial", trial_ends_at: futureDate, createdAt: new Date().toISOString() });
    mockUsage = { queryCount: 8_500, tokenCount: 0, activeUsers: 0, periodStart: "", periodEnd: "" };
    const result = expectAllowed(await checkPlanLimits("org-1"));
    expect(result.warning).toBeDefined();
    expect(result.warning!.code).toBe("plan_limit_warning");
  });

  // ── Error handling ────────────────────────────────────────────────

  it("blocks on workspace details DB error (fail closed)", async () => {
    mockWorkspaceDetailsShouldThrow = true;
    const denied = expectDenied(await checkPlanLimits("org-1"));
    expect(denied.errorCode).toBe("billing_check_failed");
    expect(denied.httpStatus).toBe(503);
  });

  it("allows on metering read error with degradation warning (fail open)", async () => {
    mockWorkspace = makeWorkspace();
    mockUsageShouldThrow = true;
    const result = expectAllowed(await checkPlanLimits("org-1"));
    expect(result.warning).toBeDefined();
    expect(result.warning!.message).toContain("metering is temporarily unavailable");
    expect(result.warning!.metrics).toEqual([]);
  });

  // ── Caching ───────────────────────────────────────────────────────

  it("uses cached workspace on second call", async () => {
    mockWorkspace = makeWorkspace(); // team tier
    mockUsage = { queryCount: 8_500, tokenCount: 0, activeUsers: 0, periodStart: "", periodEnd: "" };

    // First call — populates cache with "team" tier, 85% usage → warning
    const r1 = expectAllowed(await checkPlanLimits("org-1"));
    expect(r1.warning).toBeDefined();

    // Change mock to expired trial — if cache is bypassed, this would block the request
    const pastDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    mockWorkspace = makeWorkspace({ plan_tier: "trial", trial_ends_at: pastDate });

    // Second call — cache should still serve "team" tier → allowed with warning
    const r2 = expectAllowed(await checkPlanLimits("org-1"));
    expect(r2.warning).toBeDefined();
    // If cache was bypassed, we'd get { allowed: false, errorCode: "trial_expired" }
  });

  it("invalidatePlanCache clears cache for a specific org", async () => {
    mockWorkspace = makeWorkspace();
    mockUsage = { queryCount: 500, tokenCount: 0, activeUsers: 0, periodStart: "", periodEnd: "" };

    await checkPlanLimits("org-1");

    // Invalidate and change mock
    invalidatePlanCache("org-1");
    mockWorkspace = makeWorkspace({ plan_tier: "free" });

    const result = await checkPlanLimits("org-1");
    expect(result.allowed).toBe(true);
    // After invalidation, it should have re-fetched and gotten "free" tier
  });
});
