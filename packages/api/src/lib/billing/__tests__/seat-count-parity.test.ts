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
  /** At-cost dollar spend — the dollar enforcement denominator (#4038). */
  costUsd: 0,
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
  // Dollar enforcement denominates on `costUsd` (#4038); the page-budget figure
  // derives from the seat count (`computeTokenBudget(tier, seatCount)`), not from
  // usage. The `weightedTokenCount` mirror just keeps the returned shape realistic.
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
import { computeTokenBudget, computeUsageDollarBudget, getPlanLimits, getPlanDefinition } from "@atlas/api/lib/billing/plans";
import { invalidatePlanCache } from "@atlas/api/lib/billing/enforcement";

/**
 * The exact token-budget expression the billing and usage routes compute for
 * `limits.totalTokenBudget`: `computeTokenBudget(tier, getSeatCount(orgId))`.
 */
async function pageBudget(orgId: string, tier: "starter" | "pro" | "business"): Promise<number> {
  const seatCount = await getSeatCount(orgId);
  return computeTokenBudget(tier, seatCount);
}

const SEATS = 10;
const STARTER_PER_SEAT = getPlanLimits("starter").tokenBudgetPerSeat;
const TEN_SEAT_BUDGET = STARTER_PER_SEAT * SEATS; // 20,000,000 tokens

// Dollar enforcement credit (#4038): $20/seat × 10 seats = $200, vs the $20
// the old activeUsers=1 collapse would have used.
const TEN_SEAT_CREDIT = computeUsageDollarBudget("starter", SEATS); // $200
const ONE_SEAT_CREDIT = getPlanDefinition("starter").includedUsageDollarsPerSeat; // $20

describe("token + dollar budget parity across surfaces (#3430, #4038)", () => {
  beforeEach(() => {
    mockSeatRows = [{ count: SEATS }];
    mockUsage = { queryCount: 0, tokenCount: 0, costUsd: 0, activeUsers: 2, periodStart: "", periodEnd: "" };
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

  it("enforcement uses the same member-derived seat count as the pages (dollar credit)", async () => {
    // $190 = 95% of the 10-seat credit ($200) → a warning, allowed. The point is
    // that it's read against the 10-seat credit at all: $190 is 950% of the
    // 1-seat credit ($20), which under the 500% abuse ceiling would be a hard
    // 429 if enforcement had collapsed to a smaller seat count.
    mockUsage.costUsd = 190;

    const result = await checkPlanLimits("org-1"); // seatCount omitted → shared source
    expect(result.allowed).toBe(true);

    // The token-budget figure the pages emit derives from the SAME seat count.
    const pageLimit = await pageBudget("org-1", "starter");
    expect(pageLimit).toBe(TEN_SEAT_BUDGET);
  });

  it("meters past the member-derived credit without collapsing to the 1-seat credit (#4038)", async () => {
    // $300 = 150% of the 10-seat credit ($200) — over the credit, so metered
    // (served at cost), NOT blocked. Crucially it is also 1500% of the 1-seat
    // credit ($20), which under the default 500% ceiling WOULD have been a hard
    // cutoff if enforcement had collapsed to 1 seat. That it's merely metered
    // proves the threshold keys off the 10-seat credit.
    mockUsage.costUsd = 300;

    const result = await checkPlanLimits("org-1");
    expect(result.allowed).toBe(true);
    if (!result.allowed) {
      throw new Error(`expected metered allow, got ${JSON.stringify(result)}`);
    }
    const metric = result.warning?.metrics.find((m) => m.metric === "usd");
    expect(metric?.status).toBe("metered");
    // The reported limit is the full 10-seat credit, not the collapsed 1-seat one.
    expect(metric?.limit).toBe(TEN_SEAT_CREDIT);
    expect(metric?.limit).not.toBe(ONE_SEAT_CREDIT);
  });

  it("blocks at the member-derived abuse ceiling, not the 1-seat ceiling (#4038)", async () => {
    // Abuse ceiling = 500% of credit. 10-seat credit $200 → ceiling $1000;
    // 1-seat credit $20 → ceiling $100. $1100 clears the 10-seat ceiling and
    // hard-blocks; the reported limit proves it's the 10-seat credit.
    mockUsage.costUsd = 1100;

    const result = await checkPlanLimits("org-1");
    expect(result.allowed).toBe(false);
    if (!result.allowed && result.errorCode === "plan_limit_exceeded") {
      expect(result.usage.limit).toBe(TEN_SEAT_CREDIT);
      expect(result.usage.limit).not.toBe(ONE_SEAT_CREDIT);
    } else {
      throw new Error(`expected plan_limit_exceeded, got ${JSON.stringify(result)}`);
    }
  });

  it("a seat-count blip serves the last-known credit, never collapsing to 1 seat", async () => {
    // Warm the cache with the live count.
    expect(await pageBudget("org-1", "starter")).toBe(TEN_SEAT_BUDGET);

    // Now the member query returns nothing (transient blip). The budget must
    // hold at the 10-seat value, not collapse to the 1-seat budget.
    mockSeatRows = [];
    expect(await pageBudget("org-1", "starter")).toBe(TEN_SEAT_BUDGET);

    // Enforcement, too, keeps the 10-seat dollar credit threshold under the blip.
    mockUsage.costUsd = 190;
    const result = await checkPlanLimits("org-1");
    expect(result.allowed).toBe(true);
  });
});
