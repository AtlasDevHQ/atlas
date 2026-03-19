/**
 * Tests for plan limit enforcement.
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

import { checkPlanLimits, type PlanCheckResult } from "@atlas/api/lib/billing/enforcement";

/** Narrow a denied result for type-safe assertion access. */
function expectDenied(result: PlanCheckResult): Extract<PlanCheckResult, { allowed: false }> {
  expect(result.allowed).toBe(false);
  return result as Extract<PlanCheckResult, { allowed: false }>;
}

describe("billing/enforcement", () => {
  beforeEach(() => {
    mockHasInternalDB = true;
    mockWorkspaceDetailsShouldThrow = false;
    mockUsageShouldThrow = false;
    mockUsage = { queryCount: 0, tokenCount: 0, activeUsers: 0, periodStart: "", periodEnd: "" };
    mockWorkspace = null;
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
    mockWorkspace = { id: "org-1", name: "Test", slug: "test", workspace_status: "active", plan_tier: "free", byot: false, stripe_customer_id: null, trial_ends_at: null, suspended_at: null, deleted_at: null, createdAt: "2026-01-01T00:00:00Z" };
    mockUsage = { queryCount: 999_999, tokenCount: 999_999_999, activeUsers: 0, periodStart: "", periodEnd: "" };
    const result = await checkPlanLimits("org-1");
    expect(result.allowed).toBe(true);
  });

  // ── Enterprise tier ───────────────────────────────────────────────

  it("allows enterprise tier unconditionally", async () => {
    mockWorkspace = { id: "org-1", name: "Test", slug: "test", workspace_status: "active", plan_tier: "enterprise", byot: false, stripe_customer_id: null, trial_ends_at: null, suspended_at: null, deleted_at: null, createdAt: "2026-01-01T00:00:00Z" };
    mockUsage = { queryCount: 999_999, tokenCount: 999_999_999, activeUsers: 0, periodStart: "", periodEnd: "" };
    const result = await checkPlanLimits("org-1");
    expect(result.allowed).toBe(true);
  });

  // ── Trial tier ────────────────────────────────────────────────────

  it("allows trial tier within trial period", async () => {
    const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    mockWorkspace = { id: "org-1", name: "Test", slug: "test", workspace_status: "active", plan_tier: "trial", byot: false, stripe_customer_id: null, trial_ends_at: futureDate, suspended_at: null, deleted_at: null, createdAt: new Date().toISOString() };
    mockUsage = { queryCount: 100, tokenCount: 1000, activeUsers: 0, periodStart: "", periodEnd: "" };
    const result = await checkPlanLimits("org-1");
    expect(result.allowed).toBe(true);
  });

  it("blocks expired trial", async () => {
    const pastDate = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
    mockWorkspace = { id: "org-1", name: "Test", slug: "test", workspace_status: "active", plan_tier: "trial", byot: false, stripe_customer_id: null, trial_ends_at: pastDate, suspended_at: null, deleted_at: null, createdAt: "2026-01-01T00:00:00Z" };
    const denied = expectDenied(await checkPlanLimits("org-1"));
    expect(denied.errorCode).toBe("trial_expired");
    expect(denied.httpStatus).toBe(403);
  });

  it("allows trial without trial_ends_at when created recently", async () => {
    const recentDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    mockWorkspace = { id: "org-1", name: "Test", slug: "test", workspace_status: "active", plan_tier: "trial", byot: false, stripe_customer_id: null, trial_ends_at: null, suspended_at: null, deleted_at: null, createdAt: recentDate };
    mockUsage = { queryCount: 100, tokenCount: 1000, activeUsers: 0, periodStart: "", periodEnd: "" };
    const result = await checkPlanLimits("org-1");
    expect(result.allowed).toBe(true);
  });

  it("blocks trial without trial_ends_at when created > 14 days ago", async () => {
    const oldDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    mockWorkspace = { id: "org-1", name: "Test", slug: "test", workspace_status: "active", plan_tier: "trial", byot: false, stripe_customer_id: null, trial_ends_at: null, suspended_at: null, deleted_at: null, createdAt: oldDate };
    const denied = expectDenied(await checkPlanLimits("org-1"));
    expect(denied.errorCode).toBe("trial_expired");
  });

  // ── Team tier — usage limits ──────────────────────────────────────

  it("allows team tier within limits", async () => {
    mockWorkspace = { id: "org-1", name: "Test", slug: "test", workspace_status: "active", plan_tier: "team", byot: false, stripe_customer_id: null, trial_ends_at: null, suspended_at: null, deleted_at: null, createdAt: "2026-01-01T00:00:00Z" };
    mockUsage = { queryCount: 500, tokenCount: 10_000, activeUsers: 0, periodStart: "", periodEnd: "" };
    const result = await checkPlanLimits("org-1");
    expect(result.allowed).toBe(true);
  });

  it("blocks team tier when query limit exceeded", async () => {
    mockWorkspace = { id: "org-1", name: "Test", slug: "test", workspace_status: "active", plan_tier: "team", byot: false, stripe_customer_id: null, trial_ends_at: null, suspended_at: null, deleted_at: null, createdAt: "2026-01-01T00:00:00Z" };
    mockUsage = { queryCount: 10_000, tokenCount: 0, activeUsers: 0, periodStart: "", periodEnd: "" };
    const denied = expectDenied(await checkPlanLimits("org-1"));
    expect(denied.errorCode).toBe("query_limit_exceeded");
    expect(denied.httpStatus).toBe(429);
  });

  it("blocks team tier when token limit exceeded", async () => {
    mockWorkspace = { id: "org-1", name: "Test", slug: "test", workspace_status: "active", plan_tier: "team", byot: false, stripe_customer_id: null, trial_ends_at: null, suspended_at: null, deleted_at: null, createdAt: "2026-01-01T00:00:00Z" };
    mockUsage = { queryCount: 0, tokenCount: 5_000_000, activeUsers: 0, periodStart: "", periodEnd: "" };
    const denied = expectDenied(await checkPlanLimits("org-1"));
    expect(denied.errorCode).toBe("token_limit_exceeded");
    expect(denied.httpStatus).toBe(429);
  });

  // ── Trial tier — usage limits ────────────────────────────────────

  it("blocks trial tier when query limit exceeded", async () => {
    const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    mockWorkspace = { id: "org-1", name: "Test", slug: "test", workspace_status: "active", plan_tier: "trial", byot: false, stripe_customer_id: null, trial_ends_at: futureDate, suspended_at: null, deleted_at: null, createdAt: new Date().toISOString() };
    mockUsage = { queryCount: 10_000, tokenCount: 0, activeUsers: 0, periodStart: "", periodEnd: "" };
    const denied = expectDenied(await checkPlanLimits("org-1"));
    expect(denied.errorCode).toBe("query_limit_exceeded");
    expect(denied.httpStatus).toBe(429);
  });

  // ── Error handling ────────────────────────────────────────────────

  it("blocks on workspace details DB error (fail closed)", async () => {
    mockWorkspaceDetailsShouldThrow = true;
    const denied = expectDenied(await checkPlanLimits("org-1"));
    expect(denied.errorCode).toBe("billing_check_failed");
    expect(denied.httpStatus).toBe(503);
  });

  it("allows on metering read error (fail open for usage)", async () => {
    mockWorkspace = { id: "org-1", name: "Test", slug: "test", workspace_status: "active", plan_tier: "team", byot: false, stripe_customer_id: null, trial_ends_at: null, suspended_at: null, deleted_at: null, createdAt: "2026-01-01T00:00:00Z" };
    mockUsageShouldThrow = true;
    const result = await checkPlanLimits("org-1");
    expect(result.allowed).toBe(true);
  });
});
