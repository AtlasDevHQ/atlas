/**
 * Tests for plan limit enforcement with graceful degradation.
 *
 * Per-seat token budget model: total budget = tokenBudgetPerSeat * seatCount.
 * Starter: 2M tokens/seat, Pro: 5M tokens/seat, Business: 15M tokens/seat.
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
  setWorkspaceRegion: async () => {},
  insertSemanticAmendment: async () => "mock-amendment-id",
  getPendingAmendmentCount: async () => 0,
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

import { checkPlanLimits, checkResourceLimit, invalidatePlanCache, type PlanCheckResult, type ResourceLimitResult } from "@atlas/api/lib/billing/enforcement";

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

/** Create a standard workspace fixture (defaults to starter tier). */
function makeWorkspace(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: "org-1",
    name: "Test",
    slug: "test",
    workspace_status: "active",
    plan_tier: "starter",
    byot: false,
    stripe_customer_id: null,
    trial_ends_at: null,
    suspended_at: null,
    deleted_at: null,
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

/** Default seat count for tests (1 seat = 2M tokens for starter). */
const SEATS = 1;

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

  // ── BYOT ──────────────────────────────────────────────────────────

  it("allows BYOT workspaces unconditionally", async () => {
    mockWorkspace = makeWorkspace({ plan_tier: "starter", byot: true });
    mockUsage = { queryCount: 999_999, tokenCount: 999_999_999, activeUsers: 0, periodStart: "", periodEnd: "" };
    const result = await checkPlanLimits("org-1", SEATS);
    expect(result.allowed).toBe(true);
  });

  // ── Trial tier ────────────────────────────────────────────────────

  it("allows trial tier within trial period", async () => {
    const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    mockWorkspace = makeWorkspace({ plan_tier: "trial", trial_ends_at: futureDate, createdAt: new Date().toISOString() });
    mockUsage = { queryCount: 100, tokenCount: 1000, activeUsers: 0, periodStart: "", periodEnd: "" };
    const result = await checkPlanLimits("org-1", SEATS);
    expect(result.allowed).toBe(true);
  });

  it("blocks expired trial", async () => {
    const pastDate = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
    mockWorkspace = makeWorkspace({ plan_tier: "trial", trial_ends_at: pastDate });
    const denied = expectDenied(await checkPlanLimits("org-1", SEATS));
    expect(denied.errorCode).toBe("trial_expired");
    expect(denied.httpStatus).toBe(403);
  });

  it("allows trial without trial_ends_at when created recently", async () => {
    const recentDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    mockWorkspace = makeWorkspace({ plan_tier: "trial", trial_ends_at: null, createdAt: recentDate });
    mockUsage = { queryCount: 100, tokenCount: 1000, activeUsers: 0, periodStart: "", periodEnd: "" };
    const result = await checkPlanLimits("org-1", SEATS);
    expect(result.allowed).toBe(true);
  });

  it("blocks trial without trial_ends_at when created > 14 days ago", async () => {
    const oldDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    mockWorkspace = makeWorkspace({ plan_tier: "trial", trial_ends_at: null, createdAt: oldDate });
    const denied = expectDenied(await checkPlanLimits("org-1", SEATS));
    expect(denied.errorCode).toBe("trial_expired");
  });

  // ── Starter tier — OK (below 80%) ─────────────────────────────────
  // Starter: 2M tokens/seat. With 1 seat = 2M budget.

  it("allows at 79% with no warning (boundary: just below warning)", async () => {
    mockWorkspace = makeWorkspace();
    // 79% of 2,000,000 = 1,580,000
    mockUsage = { queryCount: 0, tokenCount: 1_580_000, activeUsers: 0, periodStart: "", periodEnd: "" };
    const result = expectAllowed(await checkPlanLimits("org-1", SEATS));
    expect(result.warning).toBeUndefined();
  });

  it("allows starter tier below 80% with no warning", async () => {
    mockWorkspace = makeWorkspace();
    mockUsage = { queryCount: 500, tokenCount: 500_000, activeUsers: 0, periodStart: "", periodEnd: "" };
    const result = expectAllowed(await checkPlanLimits("org-1", SEATS));
    expect(result.warning).toBeUndefined();
  });

  // ── Starter tier — Warning (80-99%) ───────────────────────────────

  it("returns warning at 80% token usage", async () => {
    mockWorkspace = makeWorkspace();
    // 80% of 2,000,000 = 1,600,000
    mockUsage = { queryCount: 0, tokenCount: 1_600_000, activeUsers: 0, periodStart: "", periodEnd: "" };
    const result = expectAllowed(await checkPlanLimits("org-1", SEATS));
    expect(result.warning).toBeDefined();
    expect(result.warning!.code).toBe("plan_limit_warning");
    expect(result.warning!.message).toContain("approaching");
    const tokenMetric = result.warning!.metrics.find((m) => m.metric === "tokens");
    expect(tokenMetric).toBeDefined();
    expect(tokenMetric!.status).toBe("warning");
    expect(tokenMetric!.usagePercent).toBe(80);
  });

  it("returns warning at 95% token usage", async () => {
    mockWorkspace = makeWorkspace();
    // 95% of 2,000,000 = 1,900,000
    mockUsage = { queryCount: 0, tokenCount: 1_900_000, activeUsers: 0, periodStart: "", periodEnd: "" };
    const result = expectAllowed(await checkPlanLimits("org-1", SEATS));
    expect(result.warning).toBeDefined();
    const tokenMetric = result.warning!.metrics.find((m) => m.metric === "tokens");
    expect(tokenMetric).toBeDefined();
    expect(tokenMetric!.status).toBe("warning");
    expect(tokenMetric!.usagePercent).toBe(95);
  });

  // ── Starter tier — Soft limit (100-109%) ──────────────────────────

  it("allows with soft limit warning at 100% token usage", async () => {
    mockWorkspace = makeWorkspace();
    mockUsage = { queryCount: 0, tokenCount: 2_000_000, activeUsers: 0, periodStart: "", periodEnd: "" };
    const result = expectAllowed(await checkPlanLimits("org-1", SEATS));
    expect(result.warning).toBeDefined();
    expect(result.warning!.message).toContain("grace period");
    const tokenMetric = result.warning!.metrics.find((m) => m.metric === "tokens");
    expect(tokenMetric!.status).toBe("soft_limit");
    expect(tokenMetric!.usagePercent).toBe(100);
  });

  it("allows with soft limit warning at 105% token usage", async () => {
    mockWorkspace = makeWorkspace();
    // 105% of 2,000,000 = 2,100,000
    mockUsage = { queryCount: 0, tokenCount: 2_100_000, activeUsers: 0, periodStart: "", periodEnd: "" };
    const result = expectAllowed(await checkPlanLimits("org-1", SEATS));
    expect(result.warning).toBeDefined();
    const tokenMetric = result.warning!.metrics.find((m) => m.metric === "tokens");
    expect(tokenMetric!.status).toBe("soft_limit");
  });

  it("allows with soft limit at 109% token usage", async () => {
    mockWorkspace = makeWorkspace();
    // 109% of 2,000,000 = 2,180,000
    mockUsage = { queryCount: 0, tokenCount: 2_180_000, activeUsers: 0, periodStart: "", periodEnd: "" };
    const result = expectAllowed(await checkPlanLimits("org-1", SEATS));
    expect(result.warning).toBeDefined();
    const tokenMetric = result.warning!.metrics.find((m) => m.metric === "tokens");
    expect(tokenMetric!.status).toBe("soft_limit");
  });

  // ── Starter tier — Hard limit (110%+) ─────────────────────────────

  it("blocks at 110% token usage", async () => {
    mockWorkspace = makeWorkspace();
    // 110% of 2,000,000 = 2,200,000
    mockUsage = { queryCount: 0, tokenCount: 2_200_000, activeUsers: 0, periodStart: "", periodEnd: "" };
    const exceeded = expectLimitExceeded(await checkPlanLimits("org-1", SEATS));
    expect(exceeded.httpStatus).toBe(429);
    expect(exceeded.errorMessage).toContain("token budget");
    expect(exceeded.errorMessage).toContain("grace buffer");
    expect(exceeded.usage.currentUsage).toBe(2_200_000);
    expect(exceeded.usage.limit).toBe(2_000_000);
    expect(exceeded.usage.metric).toBe("tokens");
  });

  it("blocks at 150% token usage", async () => {
    mockWorkspace = makeWorkspace();
    // 150% of 2,000,000 = 3,000,000
    mockUsage = { queryCount: 0, tokenCount: 3_000_000, activeUsers: 0, periodStart: "", periodEnd: "" };
    const exceeded = expectLimitExceeded(await checkPlanLimits("org-1", SEATS));
    expect(exceeded.httpStatus).toBe(429);
    expect(exceeded.usage.metric).toBe("tokens");
  });

  // ── Per-seat scaling ──────────────────────────────────────────────

  it("scales token budget with seat count", async () => {
    mockWorkspace = makeWorkspace(); // starter: 2M/seat
    // 3 seats = 6M budget. 5M usage = 83% → warning
    mockUsage = { queryCount: 0, tokenCount: 5_000_000, activeUsers: 0, periodStart: "", periodEnd: "" };
    const result = expectAllowed(await checkPlanLimits("org-1", 3));
    expect(result.warning).toBeDefined();
    expect(result.warning!.metrics[0].usagePercent).toBe(83);
  });

  it("more seats increases total budget", async () => {
    mockWorkspace = makeWorkspace(); // starter: 2M/seat
    // 5 seats = 10M budget. 2M usage = 20% → OK
    mockUsage = { queryCount: 0, tokenCount: 2_000_000, activeUsers: 0, periodStart: "", periodEnd: "" };
    const result = expectAllowed(await checkPlanLimits("org-1", 5));
    expect(result.warning).toBeUndefined();
  });

  // ── Pro tier ──────────────────────────────────────────────────────

  it("pro tier has 5M token budget per seat", async () => {
    mockWorkspace = makeWorkspace({ plan_tier: "pro" });
    // 1 seat = 5M budget. 4.5M usage = 90% → warning
    mockUsage = { queryCount: 0, tokenCount: 4_500_000, activeUsers: 0, periodStart: "", periodEnd: "" };
    const result = expectAllowed(await checkPlanLimits("org-1", 1));
    expect(result.warning).toBeDefined();
    expect(result.warning!.metrics[0].usagePercent).toBe(90);
  });

  // ── Business tier ─────────────────────────────────────────────────

  it("business tier has 15M token budget per seat", async () => {
    mockWorkspace = makeWorkspace({ plan_tier: "business" });
    // 1 seat = 15M budget. 12M usage = 80% → warning
    mockUsage = { queryCount: 0, tokenCount: 12_000_000, activeUsers: 0, periodStart: "", periodEnd: "" };
    const result = expectAllowed(await checkPlanLimits("org-1", 1));
    expect(result.warning).toBeDefined();
    expect(result.warning!.metrics[0].usagePercent).toBe(80);
  });

  // ── Trial tier — usage limits ────────────────────────────────────

  it("blocks trial tier at hard limit", async () => {
    const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    mockWorkspace = makeWorkspace({ plan_tier: "trial", trial_ends_at: futureDate, createdAt: new Date().toISOString() });
    // Trial = starter limits (2M/seat). 110% of 2M = 2.2M
    mockUsage = { queryCount: 0, tokenCount: 2_200_000, activeUsers: 0, periodStart: "", periodEnd: "" };
    const denied = expectDenied(await checkPlanLimits("org-1", SEATS));
    expect(denied.errorCode).toBe("plan_limit_exceeded");
    expect(denied.httpStatus).toBe(429);
  });

  it("warns trial tier at 85% usage", async () => {
    const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    mockWorkspace = makeWorkspace({ plan_tier: "trial", trial_ends_at: futureDate, createdAt: new Date().toISOString() });
    // 85% of 2M = 1.7M
    mockUsage = { queryCount: 0, tokenCount: 1_700_000, activeUsers: 0, periodStart: "", periodEnd: "" };
    const result = expectAllowed(await checkPlanLimits("org-1", SEATS));
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
    const result = expectAllowed(await checkPlanLimits("org-1", SEATS));
    expect(result.warning).toBeDefined();
    expect(result.warning!.message).toContain("metering is temporarily unavailable");
    expect(result.warning!.metrics).toEqual([]);
  });

  // ── Caching ───────────────────────────────────────────────────────

  it("uses cached workspace on second call", async () => {
    mockWorkspace = makeWorkspace(); // starter tier
    // 85% of 2M = 1,700,000
    mockUsage = { queryCount: 0, tokenCount: 1_700_000, activeUsers: 0, periodStart: "", periodEnd: "" };

    // First call — populates cache with "starter" tier, 85% usage → warning
    const r1 = expectAllowed(await checkPlanLimits("org-1", SEATS));
    expect(r1.warning).toBeDefined();

    // Change mock to expired trial — if cache is bypassed, this would block the request
    const pastDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    mockWorkspace = makeWorkspace({ plan_tier: "trial", trial_ends_at: pastDate });

    // Second call — cache should still serve "starter" tier → allowed with warning
    const r2 = expectAllowed(await checkPlanLimits("org-1", SEATS));
    expect(r2.warning).toBeDefined();
    // If cache was bypassed, we'd get { allowed: false, errorCode: "trial_expired" }
  });

  it("invalidatePlanCache clears cache for a specific org", async () => {
    mockWorkspace = makeWorkspace();
    mockUsage = { queryCount: 0, tokenCount: 500_000, activeUsers: 0, periodStart: "", periodEnd: "" };

    await checkPlanLimits("org-1", SEATS);

    // Invalidate and change mock
    invalidatePlanCache("org-1");
    mockWorkspace = makeWorkspace({ plan_tier: "free" });

    const result = await checkPlanLimits("org-1", SEATS);
    expect(result.allowed).toBe(true);
    // After invalidation, it should have re-fetched and gotten "free" tier
  });
});

// ===========================================================================
// checkResourceLimit — seat / connection plan enforcement
// ===========================================================================

/** Narrow a denied resource limit result for type-safe assertion access. */
function expectResourceDenied(result: ResourceLimitResult): Extract<ResourceLimitResult, { allowed: false }> {
  expect(result.allowed).toBe(false);
  return result as Extract<ResourceLimitResult, { allowed: false }>;
}

describe("checkResourceLimit", () => {
  beforeEach(() => {
    mockHasInternalDB = true;
    mockWorkspaceDetailsShouldThrow = false;
    mockWorkspace = null;
    invalidatePlanCache();
  });

  // ── Pass-through cases ────────────────────────────────────────────

  it("allows when no orgId provided", async () => {
    const result = await checkResourceLimit(undefined, "seats", 100);
    expect(result.allowed).toBe(true);
  });

  it("allows when no internal DB", async () => {
    mockHasInternalDB = false;
    const result = await checkResourceLimit("org-1", "seats", 100);
    expect(result.allowed).toBe(true);
  });

  it("allows when workspace not found", async () => {
    mockWorkspace = null;
    const result = await checkResourceLimit("org-1", "seats", 100);
    expect(result.allowed).toBe(true);
  });

  it("blocks when workspace details fetch fails (fail closed)", async () => {
    mockWorkspaceDetailsShouldThrow = true;
    const result = await checkResourceLimit("org-1", "seats", 100);
    expect(result.allowed).toBe(false);
  });

  // ── Free tier ─────────────────────────────────────────────────────

  it("allows free tier unconditionally (seats)", async () => {
    mockWorkspace = makeWorkspace({ plan_tier: "free" });
    const result = await checkResourceLimit("org-1", "seats", 9999);
    expect(result.allowed).toBe(true);
  });

  it("allows free tier unconditionally (connections)", async () => {
    mockWorkspace = makeWorkspace({ plan_tier: "free" });
    const result = await checkResourceLimit("org-1", "connections", 9999);
    expect(result.allowed).toBe(true);
  });

  // ── Business tier ─────────────────────────────────────────────────

  it("allows business tier unconditionally (seats)", async () => {
    mockWorkspace = makeWorkspace({ plan_tier: "business" });
    const result = await checkResourceLimit("org-1", "seats", 9999);
    expect(result.allowed).toBe(true);
  });

  it("allows business tier unconditionally (connections)", async () => {
    mockWorkspace = makeWorkspace({ plan_tier: "business" });
    const result = await checkResourceLimit("org-1", "connections", 9999);
    expect(result.allowed).toBe(true);
  });

  // ── Starter tier — under limit ────────────────────────────────────

  it("allows starter tier under seat limit", async () => {
    mockWorkspace = makeWorkspace({ plan_tier: "starter" });
    // Starter plan maxSeats = 10
    const result = await checkResourceLimit("org-1", "seats", 5);
    expect(result.allowed).toBe(true);
  });

  it("allows starter tier under connection limit", async () => {
    mockWorkspace = makeWorkspace({ plan_tier: "starter" });
    // Starter plan maxConnections = 1
    const result = await checkResourceLimit("org-1", "connections", 0);
    expect(result.allowed).toBe(true);
  });

  // ── Starter tier — at limit ───────────────────────────────────────

  it("blocks starter tier at seat limit", async () => {
    mockWorkspace = makeWorkspace({ plan_tier: "starter" });
    // Starter plan maxSeats = 10
    const denied = expectResourceDenied(
      await checkResourceLimit("org-1", "seats", 10),
    );
    expect(denied.limit).toBe(10);
    expect(denied.errorMessage).toContain("10 seats");
    expect(denied.errorMessage).toContain("Upgrade");
  });

  it("blocks starter tier at connection limit", async () => {
    mockWorkspace = makeWorkspace({ plan_tier: "starter" });
    // Starter plan maxConnections = 1
    const denied = expectResourceDenied(
      await checkResourceLimit("org-1", "connections", 1),
    );
    expect(denied.limit).toBe(1);
    expect(denied.errorMessage).toContain("1 connection");
    expect(denied.errorMessage).toContain("Upgrade");
  });

  // ── Pro tier — at limit ───────────────────────────────────────────

  it("blocks pro tier at seat limit", async () => {
    mockWorkspace = makeWorkspace({ plan_tier: "pro" });
    // Pro plan maxSeats = 25
    const denied = expectResourceDenied(
      await checkResourceLimit("org-1", "seats", 25),
    );
    expect(denied.limit).toBe(25);
    expect(denied.errorMessage).toContain("25 seats");
  });

  it("blocks pro tier at connection limit", async () => {
    mockWorkspace = makeWorkspace({ plan_tier: "pro" });
    // Pro plan maxConnections = 3
    const denied = expectResourceDenied(
      await checkResourceLimit("org-1", "connections", 3),
    );
    expect(denied.limit).toBe(3);
    expect(denied.errorMessage).toContain("3 connections");
  });

  // ── Starter tier — over limit ─────────────────────────────────────

  it("blocks starter tier over seat limit", async () => {
    mockWorkspace = makeWorkspace({ plan_tier: "starter" });
    const denied = expectResourceDenied(
      await checkResourceLimit("org-1", "seats", 15),
    );
    expect(denied.limit).toBe(10);
    expect(denied.errorMessage).toContain("10 seats");
  });

  // ── Trial tier — same limits as starter ───────────────────────────

  it("blocks trial tier at seat limit", async () => {
    const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    mockWorkspace = makeWorkspace({ plan_tier: "trial", trial_ends_at: futureDate });
    const denied = expectResourceDenied(
      await checkResourceLimit("org-1", "seats", 10),
    );
    expect(denied.limit).toBe(10);
    expect(denied.errorMessage).toContain("trial");
  });

  it("allows trial tier under seat limit", async () => {
    const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    mockWorkspace = makeWorkspace({ plan_tier: "trial", trial_ends_at: futureDate });
    const result = await checkResourceLimit("org-1", "seats", 5);
    expect(result.allowed).toBe(true);
  });

  // ── Edge: count exactly one below limit ───────────────────────────

  it("allows starter tier one below seat limit", async () => {
    mockWorkspace = makeWorkspace({ plan_tier: "starter" });
    const result = await checkResourceLimit("org-1", "seats", 9);
    expect(result.allowed).toBe(true);
  });
});
