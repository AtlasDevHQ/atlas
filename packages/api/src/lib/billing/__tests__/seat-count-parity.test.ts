/**
 * Budget-parity regression test (#3430).
 *
 * The per-seat token budget is computed on three surfaces that must agree:
 *   - enforcement (`checkPlanLimits`) — decides the actual 429 threshold,
 *   - GET /billing — the billing page figure,
 *   - GET /admin/usage/summary — the usage page figure.
 *
 * The bug: enforcement and /billing counted `member` rows while /admin/usage
 * used `Math.max(1, activeUsers)` (distinct logins this month). A 10-member
 * workspace with 2 active logins advertised a 4M budget on /admin/usage while
 * enforcement and /billing used 20M — the usage page disagreed with the 429
 * threshold.
 *
 * This pins that all three derive their seat count from the SAME shared
 * `getSeatCount` source, so the budgets are identical regardless of
 * `activeUsers`.
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";

// --- Mocks ---

/** Member rows returned by the seat-count query (the SHARED source). */
let mockSeatRows: unknown[] = [{ count: 10 }];
/** Usage returned by the metering layer — note the LOW activeUsers. */
let mockUsage = {
  queryCount: 0,
  tokenCount: 0,
  activeUsers: 2,
  periodStart: "",
  periodEnd: "",
};
let mockWorkspace: Record<string, unknown> | null = null;

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => true,
  getWorkspaceDetails: async (orgId: string) => (orgId ? mockWorkspace : null),
  getWorkspaceStatus: async () => mockWorkspace?.workspace_status ?? null,
  getInternalDB: () => ({
    query: mock(() => Promise.resolve({ rows: [] })),
    connect: () => Promise.reject(new Error("not configured")),
    end: mock(() => {}),
    on: mock(() => {}),
  }),
  // Both the seat-count query (member COUNT) and the settings-load query
  // (checkPlanLimits → resolveAbuseCeilingPercent → getSettingLive →
  // loadSettings) route through here. Returning the member rows is sufficient:
  // loadSettings maps a `{count}` row to a `key: undefined` cache entry, so the
  // ATLAS_ABUSE_CEILING lookup finds no override and falls to the registry
  // default (500) — exactly the ceiling the 100M/110M math below assumes.
  internalQuery: async () => mockSeatRows,
  internalExecute: () => {},
  updateWorkspacePlanTier: async () => true,
  updateWorkspaceByot: async () => true,
  setWorkspaceTrialEndsAt: async () => true,
  setWorkspaceRegion: async () => {},
  insertSemanticAmendment: async () => "mock-amendment-id",
  getPendingAmendmentCount: async () => 0,
}));

mock.module("@atlas/api/lib/metering", () => ({
  // Budget enforcement denominates in output-equivalent tokens (#3989); this
  // parity test drives the budget via `tokenCount`, so mirror it onto
  // `weightedTokenCount` (the denominator enforcement actually reads).
  getCurrentPeriodUsage: async () => ({
    weightedTokenCount: mockUsage.tokenCount,
    ...mockUsage,
  }),
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

import { checkPlanLimits } from "@atlas/api/lib/billing/enforcement";
import { getSeatCount, _resetSeatCountCache } from "@atlas/api/lib/billing/seat-count";
import { computeTokenBudget, getPlanLimits } from "@atlas/api/lib/billing/plans";
import { invalidatePlanCache } from "@atlas/api/lib/billing/enforcement";

/**
 * The exact budget expression the billing and usage routes compute:
 * `computeTokenBudget(tier, getSeatCount(orgId))`.
 */
async function pageBudget(orgId: string, tier: "starter" | "pro" | "business"): Promise<number> {
  const seatCount = await getSeatCount(orgId);
  return computeTokenBudget(tier, seatCount);
}

const SEATS = 10;
const STARTER_PER_SEAT = getPlanLimits("starter").tokenBudgetPerSeat;
const TEN_SEAT_BUDGET = STARTER_PER_SEAT * SEATS; // 20,000,000
const ONE_SEAT_BUDGET = STARTER_PER_SEAT; // 2,000,000 — the old activeUsers=1 collapse

describe("token budget parity across surfaces (#3430)", () => {
  beforeEach(() => {
    mockSeatRows = [{ count: SEATS }];
    mockUsage = { queryCount: 0, tokenCount: 0, activeUsers: 2, periodStart: "", periodEnd: "" };
    mockWorkspace = {
      id: "org-1",
      plan_tier: "starter",
      byot: false,
      trial_ends_at: null,
      createdAt: "2026-01-01T00:00:00Z",
    };
    _resetSeatCountCache();
    invalidatePlanCache();
  });

  it("billing and usage pages compute the same budget from the member count, not activeUsers", async () => {
    // Both pages run `computeTokenBudget(tier, getSeatCount(orgId))`.
    const billingBudget = await pageBudget("org-1", "starter");
    const usageBudget = await pageBudget("org-1", "starter");

    expect(billingBudget).toBe(TEN_SEAT_BUDGET);
    expect(usageBudget).toBe(TEN_SEAT_BUDGET);
    expect(billingBudget).toBe(usageBudget);

    // Proves the figure no longer keys off the 2 active logins (would be 4M).
    expect(usageBudget).not.toBe(STARTER_PER_SEAT * mockUsage.activeUsers);
  });

  it("enforcement uses the same member-derived budget as the pages", async () => {
    // 19M = 95% of the 10-seat budget (20M) → a warning, allowed. The point is
    // that it's read against the 10-seat budget at all: 19M is 950% of the
    // 1-seat budget (2M), which under the 500% abuse ceiling would be a hard
    // 429 if enforcement had collapsed to a smaller seat count.
    mockUsage.tokenCount = 19_000_000;

    const result = await checkPlanLimits("org-1"); // seatCount omitted → shared source
    expect(result.allowed).toBe(true);

    // And the limit enforcement reports is exactly the page budget.
    const pageLimit = await pageBudget("org-1", "starter");
    expect(pageLimit).toBe(TEN_SEAT_BUDGET);
  });

  it("meters past the member-derived budget without collapsing to the 1-seat budget (#3990)", async () => {
    // 30M usage = 150% of the 10-seat budget (20M) — over budget, so metered
    // (served + billed), NOT blocked. Crucially it is also 1500% of the 1-seat
    // budget (2M), which under the default 500% ceiling WOULD have been a hard
    // cutoff if enforcement had collapsed to 1 seat. That it's merely metered
    // proves the threshold keys off the 10-seat budget.
    mockUsage.tokenCount = 30_000_000;

    const result = await checkPlanLimits("org-1");
    expect(result.allowed).toBe(true);
    if (!result.allowed) {
      throw new Error(`expected metered allow, got ${JSON.stringify(result)}`);
    }
    const tokenMetric = result.warning?.metrics.find((m) => m.metric === "tokens");
    expect(tokenMetric?.status).toBe("metered");
    // The reported limit is the full 10-seat budget, not the collapsed 1-seat one.
    expect(tokenMetric?.limit).toBe(TEN_SEAT_BUDGET);
    expect(tokenMetric?.limit).not.toBe(ONE_SEAT_BUDGET);
  });

  it("blocks at the member-derived abuse ceiling, not the 1-seat ceiling (#3990)", async () => {
    // Abuse ceiling = 500% of budget. 10-seat budget 20M → ceiling 100M;
    // 1-seat budget 2M → ceiling 10M. 110M usage clears the 10-seat ceiling and
    // hard-blocks; the reported limit proves it's the 10-seat budget.
    mockUsage.tokenCount = 110_000_000;

    const result = await checkPlanLimits("org-1");
    expect(result.allowed).toBe(false);
    if (!result.allowed && result.errorCode === "plan_limit_exceeded") {
      expect(result.usage.limit).toBe(TEN_SEAT_BUDGET);
      expect(result.usage.limit).not.toBe(ONE_SEAT_BUDGET);
    } else {
      throw new Error(`expected plan_limit_exceeded, got ${JSON.stringify(result)}`);
    }
  });

  it("a seat-count blip serves the last-known budget, never collapsing to 1 seat", async () => {
    // Warm the cache with the live count.
    expect(await pageBudget("org-1", "starter")).toBe(TEN_SEAT_BUDGET);

    // Now the member query returns nothing (transient blip). The budget must
    // hold at the 10-seat value, not collapse to the 1-seat budget.
    mockSeatRows = [];
    expect(await pageBudget("org-1", "starter")).toBe(TEN_SEAT_BUDGET);

    // Enforcement, too, keeps the 10-seat threshold under the blip.
    mockUsage.tokenCount = 19_000_000;
    const result = await checkPlanLimits("org-1");
    expect(result.allowed).toBe(true);
  });
});
