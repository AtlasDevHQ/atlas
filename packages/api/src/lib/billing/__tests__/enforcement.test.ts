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
  beforeAll,
  beforeEach,
  mock,
} from "bun:test";

// --- Mocks ---

let mockHasInternalDB = true;
let mockWorkspace: Record<string, unknown> | null = null;
let mockUsage: {
  queryCount: number;
  tokenCount: number;
  /** When set, the budget denominator (#3989); otherwise mirrors `tokenCount`. */
  weightedTokenCount?: number;
  /**
   * At-cost provider spend (USD) for the period (#4036) — the dollar
   * enforcement denominator (#4038). Defaults to 0 when a test omits it.
   */
  costUsd?: number;
  activeUsers: number;
  periodStart: string;
  periodEnd: string;
} = { queryCount: 0, tokenCount: 0, activeUsers: 0, periodStart: "", periodEnd: "" };
let mockWorkspaceDetailsShouldThrow = false;
/** Count of `getWorkspaceDetails` invocations — i.e. internal-DB plan reads
 *  that the per-replica planCache did NOT absorb. Used by the #3432
 *  per-replica staleness-contract test. */
let mockWorkspaceReadCount = 0;
let mockUsageShouldThrow = false;
/** Rows returned by the `internalQuery` mock (chat-integration count query). */
let mockInternalQueryResult: unknown[] = [];
/** When true, the `internalQuery` mock throws (count-query failure path). */
let mockInternalQueryShouldThrow = false;
/**
 * Fake transaction client `getInternalDB().connect()` hands back for the
 * atomic install-gate tests (`checkChatIntegrationLimitAndInstall`). Set per
 * test via {@link makeFakeTxnClient}; `null` means no test configured one (the
 * gate's no-orgId / no-DB short-circuits never call `connect`).
 */
let mockTxnClient: ReturnType<typeof makeFakeTxnClient> | null = null;
/** Count of `getInternalDB().connect()` calls — asserts no transaction opened. */
let mockConnectCount = 0;
/** Structured `log.error` calls captured for the #3428 bypass-alert assertions. */
let errorLogs: Array<{ ctx: unknown; msg: unknown }> = [];

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => mockHasInternalDB,
  getWorkspaceDetails: async (orgId: string) => {
    if (mockWorkspaceDetailsShouldThrow) throw new Error("db error");
    mockWorkspaceReadCount++;
    return orgId ? mockWorkspace : null;
  },
  getWorkspaceStatus: async () => mockWorkspace?.workspace_status ?? null,
  getInternalDB: () => ({
    query: mock(() => Promise.resolve({ rows: [] })),
    connect: () => {
      mockConnectCount++;
      if (!mockTxnClient) {
        throw new Error("test did not configure a fake txn client (mockTxnClient)");
      }
      return Promise.resolve(mockTxnClient.client);
    },
    end: mock(() => {}),
    on: mock(() => {}),
  }),
  internalQuery: async () => {
    if (mockInternalQueryShouldThrow) throw new Error("db error");
    return mockInternalQueryResult;
  },
  internalExecute: () => {},
  _resetPool: () => {},
  _resetCircuitBreaker: () => {},
  updateWorkspacePlanTier: async () => true,
  updateWorkspaceByot: async () => true,
  setWorkspaceTrialEndsAt: async () => true,
  setWorkspaceRegion: async () => {},
  insertSemanticAmendment: async () => "mock-amendment-id",
  getPendingAmendmentCount: async () => 0,
}));

mock.module("@atlas/api/lib/metering", () => ({
  getCurrentPeriodUsage: async () => {
    if (mockUsageShouldThrow) throw new Error("metering error");
    // Dollar enforcement (#4038) denominates on `costUsd`; the band cases below
    // drive it directly. `weightedTokenCount` mirrors `tokenCount` (retained for
    // the token OverageMeter), and `costUsd` defaults to 0 when a case omits it.
    return {
      weightedTokenCount: mockUsage.tokenCount,
      costUsd: 0,
      ...mockUsage,
    };
  },
  logUsageEvent: () => {},
  aggregateUsageSummary: async () => {},
  getUsageHistory: async () => [],
  getUsageBreakdown: async () => [],
}));

const captureLogger = {
  info: () => {},
  warn: () => {},
  error: (ctx: unknown, msg?: unknown) => {
    errorLogs.push({ ctx, msg });
  },
  debug: () => {},
  trace: () => {},
  fatal: () => {},
  child: () => captureLogger,
  level: "info",
};

mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => captureLogger,
  getLogger: () => captureLogger,
  getRequestContext: () => null,
  withRequestContext: (_ctx: unknown, fn: () => unknown) => fn(),
}));

// --- Import under test ---
//
// Value exports are loaded via a dynamic import in `beforeAll` (not a top-level
// static import) so enforcement.ts evaluates AFTER the `mock.module` calls above
// register. enforcement.ts captures its logger once at module scope
// (`const log = createLogger("billing:enforcement")`); a top-level static import
// would bind it to the REAL logger before the mock applied, leaving the #3428
// bypass-alert assertion unable to observe `log.error`. Types are erased at
// compile time, so they stay as a static `import type`.
import type {
  ChatIntegrationInstallResult,
  PlanCheckResult,
  ResourceLimitResult,
} from "@atlas/api/lib/billing/enforcement";

let checkChatIntegrationLimit: typeof import("@atlas/api/lib/billing/enforcement").checkChatIntegrationLimit;
let checkChatIntegrationLimitAndInstall: typeof import("@atlas/api/lib/billing/enforcement").checkChatIntegrationLimitAndInstall;
let CHAT_INTEGRATION_COUNT_SQL: typeof import("@atlas/api/lib/billing/enforcement").CHAT_INTEGRATION_COUNT_SQL;
let checkPlanLimits: typeof import("@atlas/api/lib/billing/enforcement").checkPlanLimits;
let checkResourceLimit: typeof import("@atlas/api/lib/billing/enforcement").checkResourceLimit;
let invalidatePlanCache: typeof import("@atlas/api/lib/billing/enforcement").invalidatePlanCache;
let buildMetricStatus: typeof import("@atlas/api/lib/billing/enforcement").buildMetricStatus;
let computeOverageTokens: typeof import("@atlas/api/lib/billing/enforcement").computeOverageTokens;
let computeOverageDollars: typeof import("@atlas/api/lib/billing/enforcement").computeOverageDollars;
let resolveAbuseCeilingPercent: typeof import("@atlas/api/lib/billing/enforcement").resolveAbuseCeilingPercent;
let resolveSpendPolicy: typeof import("@atlas/api/lib/billing/enforcement").resolveSpendPolicy;
let resolveUsageCeiling: typeof import("@atlas/api/lib/billing/enforcement").resolveUsageCeiling;
let _resetSettingsCache: typeof import("@atlas/api/lib/settings")._resetSettingsCache;

beforeAll(async () => {
  ({
    checkChatIntegrationLimit,
    checkChatIntegrationLimitAndInstall,
    CHAT_INTEGRATION_COUNT_SQL,
    checkPlanLimits,
    checkResourceLimit,
    invalidatePlanCache,
    buildMetricStatus,
    computeOverageTokens,
    computeOverageDollars,
    resolveAbuseCeilingPercent,
    resolveSpendPolicy,
    resolveUsageCeiling,
  } = await import("@atlas/api/lib/billing/enforcement"));
  ({ _resetSettingsCache } = await import("@atlas/api/lib/settings"));
});

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

// ---------------------------------------------------------------------------
// Fake transaction client for the atomic install-gate tests
// (`checkChatIntegrationLimitAndInstall`). Records every `query` call so a
// test can assert the BEGIN → advisory-lock → COUNT → INSERT → COMMIT
// sequence (or ROLLBACK on a denial), and exposes the `release` error so the
// poisoned-socket destroy path can be checked.
// ---------------------------------------------------------------------------

interface FakeTxnClientOpts {
  /** Rows returned for the chat-integration COUNT(*) FILTER query. */
  readonly countRows?: Array<Record<string, unknown>>;
  /** When true, the COUNT query throws. */
  readonly countThrows?: boolean;
  /** Rows returned for the workspace_plugins INSERT (RETURNING). */
  readonly insertRows?: Array<Record<string, unknown>>;
  /** When true, the INSERT throws (write-path failure → gate re-throws). */
  readonly insertThrows?: boolean;
  /** When true, ROLLBACK throws (poisoned socket → client destroyed on release). */
  readonly rollbackThrows?: boolean;
}

function makeFakeTxnClient(opts: FakeTxnClientOpts = {}) {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  const state: { releaseErr: Error | undefined; released: boolean } = {
    releaseErr: undefined,
    released: false,
  };
  const client = {
    query: (sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> => {
      calls.push({ sql, params });
      if (sql === "ROLLBACK") {
        if (opts.rollbackThrows) return Promise.reject(new Error("rollback failed"));
        return Promise.resolve({ rows: [] });
      }
      if (sql === "BEGIN" || sql === "COMMIT") return Promise.resolve({ rows: [] });
      if (sql.includes("pg_advisory_xact_lock")) return Promise.resolve({ rows: [] });
      if (sql.includes("COUNT(*) FILTER")) {
        if (opts.countThrows) return Promise.reject(new Error("count failed"));
        return Promise.resolve({ rows: opts.countRows ?? [] });
      }
      if (sql.includes("INSERT INTO workspace_plugins")) {
        if (opts.insertThrows) return Promise.reject(new Error("insert failed"));
        return Promise.resolve({ rows: opts.insertRows ?? [] });
      }
      return Promise.resolve({ rows: [] });
    },
    release: (err?: Error): void => {
      state.released = true;
      state.releaseErr = err;
    },
  };
  /** SQL of every recorded call, in order — for sequence assertions. */
  const sqls = (): string[] => calls.map((c) => c.sql);
  /** True if any recorded call's SQL contains `needle`. */
  const ran = (needle: string): boolean => calls.some((c) => c.sql.includes(needle));
  return { client, calls, sqls, ran, state };
}

/** Narrow a chat-install gate cap_reached denial for `.limit` access. */
function expectInstallCapReached<T extends Record<string, unknown>>(
  result: ChatIntegrationInstallResult<T>,
): Extract<ChatIntegrationInstallResult<T>, { reason: "cap_reached" }> {
  expect(result.allowed).toBe(false);
  if (!result.allowed) expect(result.reason).toBe("cap_reached");
  return result as Extract<ChatIntegrationInstallResult<T>, { reason: "cap_reached" }>;
}

/** Narrow a chat-install gate check_failed (fail-closed) denial. */
function expectInstallCheckFailed<T extends Record<string, unknown>>(
  result: ChatIntegrationInstallResult<T>,
): Extract<ChatIntegrationInstallResult<T>, { reason: "check_failed" }> {
  expect(result.allowed).toBe(false);
  if (!result.allowed) expect(result.reason).toBe("check_failed");
  return result as Extract<ChatIntegrationInstallResult<T>, { reason: "check_failed" }>;
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
    mockUsage = { queryCount: 0, tokenCount: 0, costUsd: 0, activeUsers: 0, periodStart: "", periodEnd: "" };
    mockWorkspace = null;
    mockWorkspaceReadCount = 0;
    errorLogs = [];
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

  // ── Locked tier (#3421) ───────────────────────────────────────────

  it("blocks locked workspaces with 403 subscription_required", async () => {
    mockWorkspace = makeWorkspace({ plan_tier: "locked" });
    const result = await checkPlanLimits("org-1", SEATS);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.errorCode).toBe("subscription_required");
      expect(result.httpStatus).toBe(403);
      expect(result.errorMessage).toContain("Resubscribe");
    }
  });

  it("blocks locked workspaces even with BYOT enabled (no key-based escape hatch)", async () => {
    mockWorkspace = makeWorkspace({ plan_tier: "locked", byot: true });
    const result = await checkPlanLimits("org-1", SEATS);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.errorCode).toBe("subscription_required");
    }
  });

  // ── BYOT ──────────────────────────────────────────────────────────

  it("allows BYOT workspaces unconditionally — and NEVER accrues overage (#3990)", async () => {
    // Paid tier + BYOT, usage massively over budget (far past any abuse
    // ceiling). BYOT bypasses enforcement before any usage evaluation, so the
    // request is allowed AND carries no overage warning — the "BYOT never
    // accrues overage" acceptance criterion. A regression that attached a
    // metered warning to BYOT would flip the warning assertion.
    mockWorkspace = makeWorkspace({ plan_tier: "starter", byot: true });
    mockUsage = { queryCount: 999_999, tokenCount: 999_999_999, activeUsers: 0, periodStart: "", periodEnd: "" };
    const result = expectAllowed(await checkPlanLimits("org-1", SEATS));
    expect(result.warning).toBeUndefined();
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

  // ── Dollar credit — OK (below 80%) ────────────────────────────────
  // All paid tiers carry a $20/seat at-cost usage credit (#4034). 1 seat = $20.

  it("allows at 79% with no warning (boundary: just below warning)", async () => {
    mockWorkspace = makeWorkspace();
    // 79% of $20 = $15.80
    mockUsage = { queryCount: 0, tokenCount: 0, costUsd: 15.8, activeUsers: 0, periodStart: "", periodEnd: "" };
    const result = expectAllowed(await checkPlanLimits("org-1", SEATS));
    expect(result.warning).toBeUndefined();
  });

  it("allows well below 80% with no warning", async () => {
    mockWorkspace = makeWorkspace();
    mockUsage = { queryCount: 0, tokenCount: 0, costUsd: 5, activeUsers: 0, periodStart: "", periodEnd: "" };
    const result = expectAllowed(await checkPlanLimits("org-1", SEATS));
    expect(result.warning).toBeUndefined();
  });

  // ── Dollar credit — Warning (80-99%) ──────────────────────────────

  it("returns warning at 80% of the credit", async () => {
    mockWorkspace = makeWorkspace();
    // 80% of $20 = $16
    mockUsage = { queryCount: 0, tokenCount: 0, costUsd: 16, activeUsers: 0, periodStart: "", periodEnd: "" };
    const result = expectAllowed(await checkPlanLimits("org-1", SEATS));
    expect(result.warning).toBeDefined();
    expect(result.warning!.code).toBe("plan_limit_warning");
    expect(result.warning!.message).toContain("approaching");
    const metric = result.warning!.metrics.find((m) => m.metric === "usd");
    expect(metric).toBeDefined();
    expect(metric!.status).toBe("warning");
    expect(metric!.usagePercent).toBe(80);
  });

  it("returns warning at 95% of the credit", async () => {
    mockWorkspace = makeWorkspace();
    // 95% of $20 = $19
    mockUsage = { queryCount: 0, tokenCount: 0, costUsd: 19, activeUsers: 0, periodStart: "", periodEnd: "" };
    const result = expectAllowed(await checkPlanLimits("org-1", SEATS));
    expect(result.warning).toBeDefined();
    const metric = result.warning!.metrics.find((m) => m.metric === "usd");
    expect(metric).toBeDefined();
    expect(metric!.status).toBe("warning");
    expect(metric!.usagePercent).toBe(95);
  });

  // ── Dollar credit — Metered overage (100% → ceiling), continue policy ──
  // Default spend policy is `continue`: at-cost usage past the $20 credit is
  // METERED (served at provider cost), not cut off, until the abuse ceiling
  // (default 500% = $100). Structure B bills the overage at provider cost, so
  // the real "$X.XX so far" excess is now surfaced (no synthetic rate).

  it("meters (does not block) at exactly 100% of the credit", async () => {
    mockWorkspace = makeWorkspace();
    mockUsage = { queryCount: 0, tokenCount: 0, costUsd: 20, activeUsers: 0, periodStart: "", periodEnd: "" };
    const result = expectAllowed(await checkPlanLimits("org-1", SEATS));
    expect(result.warning).toBeDefined();
    expect(result.warning!.message).toContain("included usage credit");
    const metric = result.warning!.metrics.find((m) => m.metric === "usd");
    expect(metric!.status).toBe("metered");
    expect(metric!.usagePercent).toBe(100);
    // Exactly at the credit → $0 overage → no "so far" suffix.
    expect(result.warning!.message).not.toContain("so far");
  });

  it("meters at 105% and surfaces the real at-cost overage so far", async () => {
    mockWorkspace = makeWorkspace();
    // 105% of $20 = $21 → $1.00 of at-cost overage (metered band).
    mockUsage = { queryCount: 0, tokenCount: 0, costUsd: 21, activeUsers: 0, periodStart: "", periodEnd: "" };
    const result = expectAllowed(await checkPlanLimits("org-1", SEATS));
    const metric = result.warning!.metrics.find((m) => m.metric === "usd");
    expect(metric!.status).toBe("metered");
    expect(result.warning!.message).toContain("$1.00 so far");
  });

  it("meters at 150% without cutting off (continue policy)", async () => {
    mockWorkspace = makeWorkspace();
    // 150% of $20 = $30 → $10.00 of at-cost overage (metered band).
    mockUsage = { queryCount: 0, tokenCount: 0, costUsd: 30, activeUsers: 0, periodStart: "", periodEnd: "" };
    const result = expectAllowed(await checkPlanLimits("org-1", SEATS));
    const metric = result.warning!.metrics.find((m) => m.metric === "usd");
    expect(metric!.status).toBe("metered");
    expect(result.warning!.message).toContain("$10.00 so far");
  });

  // ── Dollar credit — Abuse ceiling cutoff (≥ ceiling), continue policy ──
  // Under `continue` the hard 429 fires ONLY at the abuse ceiling (default
  // 500% = $100), not at the credit.

  it("does NOT block at 110% of the credit (continue)", async () => {
    mockWorkspace = makeWorkspace();
    mockUsage = { queryCount: 0, tokenCount: 0, costUsd: 22, activeUsers: 0, periodStart: "", periodEnd: "" };
    const result = expectAllowed(await checkPlanLimits("org-1", SEATS));
    const metric = result.warning!.metrics.find((m) => m.metric === "usd");
    expect(metric!.status).toBe("metered");
  });

  it("blocks at the abuse ceiling (500% = $100) with 429", async () => {
    mockWorkspace = makeWorkspace();
    // 500% of $20 = $100 → at the default ceiling → cutoff.
    mockUsage = { queryCount: 0, tokenCount: 0, costUsd: 100, activeUsers: 0, periodStart: "", periodEnd: "" };
    const exceeded = expectLimitExceeded(await checkPlanLimits("org-1", SEATS));
    expect(exceeded.httpStatus).toBe(429);
    expect(exceeded.errorMessage).toContain("ceiling");
    expect(exceeded.usage.currentUsage).toBe(100);
    expect(exceeded.usage.limit).toBe(20);
    expect(exceeded.usage.metric).toBe("usd");
  });

  it("blocks above the abuse ceiling (600% = $120) with 429", async () => {
    mockWorkspace = makeWorkspace();
    mockUsage = { queryCount: 0, tokenCount: 0, costUsd: 120, activeUsers: 0, periodStart: "", periodEnd: "" };
    const exceeded = expectLimitExceeded(await checkPlanLimits("org-1", SEATS));
    expect(exceeded.httpStatus).toBe(429);
  });

  it("just under the abuse ceiling (499% = $99.80) still meters, not blocks", async () => {
    mockWorkspace = makeWorkspace();
    mockUsage = { queryCount: 0, tokenCount: 0, costUsd: 99.8, activeUsers: 0, periodStart: "", periodEnd: "" };
    const result = expectAllowed(await checkPlanLimits("org-1", SEATS));
    const metric = result.warning!.metrics.find((m) => m.metric === "usd");
    expect(metric!.status).toBe("metered");
  });

  // ── Spend policy: cutoff (#4038) ──────────────────────────────────
  // `cutoff` clamps the effective ceiling to 100% of the credit, so any overage
  // past the included credit instantly hard-blocks. Driven end-to-end via
  // ATLAS_SPEND_POLICY in env (settings reads it through the mocked internalQuery
  // → no override → env), with set/restore + cache reset so they stay isolated.
  async function withSpendPolicyE2E<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
    const prev = process.env.ATLAS_SPEND_POLICY;
    if (value === undefined) delete process.env.ATLAS_SPEND_POLICY;
    else process.env.ATLAS_SPEND_POLICY = value;
    _resetSettingsCache();
    invalidatePlanCache();
    try {
      return await fn();
    } finally {
      if (prev === undefined) delete process.env.ATLAS_SPEND_POLICY;
      else process.env.ATLAS_SPEND_POLICY = prev;
      _resetSettingsCache();
    }
  }

  it("cutoff hard-blocks at exactly 100% of the credit (429)", async () => {
    mockWorkspace = makeWorkspace({ id: "org-cutoff" });
    mockUsage = { queryCount: 0, tokenCount: 0, costUsd: 20, activeUsers: 0, periodStart: "", periodEnd: "" };
    await withSpendPolicyE2E("cutoff", async () => {
      const exceeded = expectLimitExceeded(await checkPlanLimits("org-cutoff", SEATS));
      expect(exceeded.httpStatus).toBe(429);
      expect(exceeded.errorMessage).toContain("spend policy");
      expect(exceeded.usage.metric).toBe("usd");
    });
  });

  it("cutoff still warns (does not block) at 99% of the credit", async () => {
    mockWorkspace = makeWorkspace({ id: "org-cutoff-2" });
    // 99% of $20 = $19.80 — under the credit, so warning (not yet cut off).
    mockUsage = { queryCount: 0, tokenCount: 0, costUsd: 19.8, activeUsers: 0, periodStart: "", periodEnd: "" };
    await withSpendPolicyE2E("cutoff", async () => {
      const result = expectAllowed(await checkPlanLimits("org-cutoff-2", SEATS));
      const metric = result.warning!.metrics.find((m) => m.metric === "usd");
      expect(metric!.status).toBe("warning");
    });
  });

  it("cutoff blocks the same overage that `continue` meters ($30 = 150%)", async () => {
    mockWorkspace = makeWorkspace({ id: "org-cutoff-3" });
    mockUsage = { queryCount: 0, tokenCount: 0, costUsd: 30, activeUsers: 0, periodStart: "", periodEnd: "" };
    // continue: metered (served)…
    await withSpendPolicyE2E("continue", async () => {
      const result = expectAllowed(await checkPlanLimits("org-cutoff-3", SEATS));
      expect(result.warning!.metrics.find((m) => m.metric === "usd")!.status).toBe("metered");
    });
    // …cutoff: the SAME usage hard-blocks.
    await withSpendPolicyE2E("cutoff", async () => {
      const exceeded = expectLimitExceeded(await checkPlanLimits("org-cutoff-3", SEATS));
      expect(exceeded.httpStatus).toBe(429);
    });
  });

  // ── Configurable abuse ceiling end-to-end (continue policy) (#3990) ──
  // The above ride the registry default (500). These drive a NON-default ceiling
  // and the disabled ceiling all the way through enforcement by setting
  // ATLAS_ABUSE_CEILING in env (the continue policy honours it).
  async function withCeilingEnvE2E<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
    const prev = process.env.ATLAS_ABUSE_CEILING;
    if (value === undefined) delete process.env.ATLAS_ABUSE_CEILING;
    else process.env.ATLAS_ABUSE_CEILING = value;
    _resetSettingsCache();
    invalidatePlanCache();
    try {
      return await fn();
    } finally {
      if (prev === undefined) delete process.env.ATLAS_ABUSE_CEILING;
      else process.env.ATLAS_ABUSE_CEILING = prev;
      _resetSettingsCache();
    }
  }

  it("blocks at a custom (lower) ceiling set via ATLAS_ABUSE_CEILING", async () => {
    mockWorkspace = makeWorkspace({ id: "org-custom-ceiling" });
    // Custom ceiling 200% = $40 → at the custom ceiling → cutoff, even though
    // it's far under the default 500% ($100).
    mockUsage = { queryCount: 0, tokenCount: 0, costUsd: 40, activeUsers: 0, periodStart: "", periodEnd: "" };
    await withCeilingEnvE2E("200", async () => {
      const exceeded = expectLimitExceeded(await checkPlanLimits("org-custom-ceiling", SEATS));
      expect(exceeded.httpStatus).toBe(429);
    });
  });

  it("meters just under a custom ceiling set via ATLAS_ABUSE_CEILING", async () => {
    mockWorkspace = makeWorkspace({ id: "org-custom-ceiling-2" });
    // Custom ceiling 200%. 150% ($30) is under it → metered, not blocked.
    mockUsage = { queryCount: 0, tokenCount: 0, costUsd: 30, activeUsers: 0, periodStart: "", periodEnd: "" };
    await withCeilingEnvE2E("200", async () => {
      const result = expectAllowed(await checkPlanLimits("org-custom-ceiling-2", SEATS));
      expect(result.warning!.metrics.find((m) => m.metric === "usd")!.status).toBe("metered");
    });
  });

  it("never blocks at extreme usage when the ceiling is disabled (0) — pure metering", async () => {
    mockWorkspace = makeWorkspace({ id: "org-disabled-ceiling" });
    // 2000% of credit ($400) with the ceiling disabled → still metered, never 429.
    mockUsage = { queryCount: 0, tokenCount: 0, costUsd: 400, activeUsers: 0, periodStart: "", periodEnd: "" };
    await withCeilingEnvE2E("0", async () => {
      const result = expectAllowed(await checkPlanLimits("org-disabled-ceiling", SEATS));
      expect(result.warning!.metrics.find((m) => m.metric === "usd")!.status).toBe("metered");
    });
  });

  // ── Denominates on costUsd, NOT tokens (#4038) ────────────────────
  // The decision keys off `usage.costUsd`, not token counts — reverting
  // enforcement.ts to a token denominator would flip both of these.

  it("blocks on costUsd reaching the ceiling even though token usage is trivial", async () => {
    mockWorkspace = makeWorkspace();
    // Tiny token count but $100 of at-cost spend (500% of credit) → hard block.
    mockUsage = { queryCount: 0, tokenCount: 1_000, costUsd: 100, activeUsers: 0, periodStart: "", periodEnd: "" };
    const exceeded = expectLimitExceeded(await checkPlanLimits("org-1", SEATS));
    expect(exceeded.httpStatus).toBe(429);
    expect(exceeded.usage.currentUsage).toBe(100);
    expect(exceeded.usage.limit).toBe(20);
  });

  it("allows when costUsd is under credit even though token usage is enormous", async () => {
    mockWorkspace = makeWorkspace();
    // 50M tokens but only $2 of at-cost spend (10% of credit) → allowed, no warning.
    mockUsage = { queryCount: 0, tokenCount: 50_000_000, costUsd: 2, activeUsers: 0, periodStart: "", periodEnd: "" };
    const result = expectAllowed(await checkPlanLimits("org-1", SEATS));
    expect(result.warning).toBeUndefined();
  });

  // ── Per-seat scaling ──────────────────────────────────────────────

  it("scales the dollar credit with seat count", async () => {
    mockWorkspace = makeWorkspace();
    // 3 seats = $60 credit. $50 spend = 83% → warning.
    mockUsage = { queryCount: 0, tokenCount: 0, costUsd: 50, activeUsers: 0, periodStart: "", periodEnd: "" };
    const result = expectAllowed(await checkPlanLimits("org-1", 3));
    expect(result.warning).toBeDefined();
    expect(result.warning!.metrics[0].usagePercent).toBe(83);
    expect(result.warning!.metrics[0].limit).toBe(60);
  });

  it("more seats increases the total credit", async () => {
    mockWorkspace = makeWorkspace();
    // 5 seats = $100 credit. $20 spend = 20% → OK.
    mockUsage = { queryCount: 0, tokenCount: 0, costUsd: 20, activeUsers: 0, periodStart: "", periodEnd: "" };
    const result = expectAllowed(await checkPlanLimits("org-1", 5));
    expect(result.warning).toBeUndefined();
  });

  // ── Per-tier: every paid tier shares the same $20/seat credit ──────

  it("pro tier enforces the $20/seat credit", async () => {
    mockWorkspace = makeWorkspace({ plan_tier: "pro" });
    // 1 seat = $20 credit. $18 = 90% → warning.
    mockUsage = { queryCount: 0, tokenCount: 0, costUsd: 18, activeUsers: 0, periodStart: "", periodEnd: "" };
    const result = expectAllowed(await checkPlanLimits("org-1", 1));
    expect(result.warning).toBeDefined();
    expect(result.warning!.metrics[0].usagePercent).toBe(90);
  });

  it("business tier enforces the $20/seat credit", async () => {
    mockWorkspace = makeWorkspace({ plan_tier: "business" });
    // 1 seat = $20 credit. $16 = 80% → warning.
    mockUsage = { queryCount: 0, tokenCount: 0, costUsd: 16, activeUsers: 0, periodStart: "", periodEnd: "" };
    const result = expectAllowed(await checkPlanLimits("org-1", 1));
    expect(result.warning).toBeDefined();
    expect(result.warning!.metrics[0].usagePercent).toBe(80);
  });

  // ── Trial tier — usage limits ─────────────────────────────────────

  it("meters trial tier in the 100%→ceiling band (continue policy)", async () => {
    const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    mockWorkspace = makeWorkspace({ plan_tier: "trial", trial_ends_at: futureDate, createdAt: new Date().toISOString() });
    // Trial = $20 credit. 110% = $22 — over credit but well under the 500%
    // ceiling → metered, with the real at-cost overage ($2.00) surfaced.
    mockUsage = { queryCount: 0, tokenCount: 0, costUsd: 22, activeUsers: 0, periodStart: "", periodEnd: "" };
    const result = expectAllowed(await checkPlanLimits("org-1", SEATS));
    const metric = result.warning!.metrics.find((m) => m.metric === "usd");
    expect(metric!.status).toBe("metered");
    expect(result.warning!.message).toContain("$2.00 so far");
  });

  it("blocks trial tier at the abuse ceiling (500% = $100) with 429", async () => {
    const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    mockWorkspace = makeWorkspace({ plan_tier: "trial", trial_ends_at: futureDate, createdAt: new Date().toISOString() });
    mockUsage = { queryCount: 0, tokenCount: 0, costUsd: 100, activeUsers: 0, periodStart: "", periodEnd: "" };
    const denied = expectDenied(await checkPlanLimits("org-1", SEATS));
    expect(denied.errorCode).toBe("plan_limit_exceeded");
    expect(denied.httpStatus).toBe(429);
  });

  it("warns trial tier at 85% of the credit", async () => {
    const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    mockWorkspace = makeWorkspace({ plan_tier: "trial", trial_ends_at: futureDate, createdAt: new Date().toISOString() });
    // 85% of $20 = $17
    mockUsage = { queryCount: 0, tokenCount: 0, costUsd: 17, activeUsers: 0, periodStart: "", periodEnd: "" };
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

  // ── Bypass operator alert (#3428) ─────────────────────────────────
  // The metering-read fail-open is deliberate (availability over revenue), but
  // the triage decision (2026-06-12) requires the token-budget BYPASS to be
  // OPERATOR-VISIBLE: a structured `log.error` carrying the orgId + reason so
  // an operator paging on metering failures can scope the unmetered window.

  it("emits an operator-visible bypass alert when the usage read fails (#3428)", async () => {
    mockWorkspace = makeWorkspace();
    mockUsageShouldThrow = true;

    const result = expectAllowed(await checkPlanLimits("org-1", SEATS));
    // The request is still ALLOWED — fail-open is preserved.
    expect(result.warning).toBeDefined();

    // …AND the bypass was surfaced loudly with actionable context.
    const bypassAlert = errorLogs.find(
      (e) =>
        typeof e.ctx === "object" &&
        e.ctx !== null &&
        (e.ctx as Record<string, unknown>).reason === "metering_read_failed",
    );
    expect(bypassAlert).toBeDefined();
    expect(bypassAlert!.ctx).toMatchObject({ orgId: "org-1", reason: "metering_read_failed" });
    expect(String(bypassAlert!.msg)).toContain("#3428");
    expect(String(bypassAlert!.msg)).toContain("BYPASSED");
  });

  // ── Cost-basis gap alert (#4038) ──────────────────────────────────
  // costUsd sums gateway_cost_usd, which is NULL for non-gateway providers and
  // pre-#4036 token rows. When tokens were recorded but the cost basis summed to
  // $0, the dollar gauge reads ~0% and the workspace is effectively un-metered —
  // a SILENT fade-out. Enforcement must surface it as an operator-visible alert
  // (matching the #3428 bypass) while still failing open.

  it("emits an operator-visible alert when tokens were recorded but costUsd is $0 (#4038)", async () => {
    mockWorkspace = makeWorkspace();
    // Tokens recorded this period, but no cost basis (NULL gateway_cost_usd).
    mockUsage = { queryCount: 0, tokenCount: 1_500_000, costUsd: 0, activeUsers: 0, periodStart: "p", periodEnd: "" };

    // Still ALLOWED (fail-open: meter on the under-counted $0, never block).
    const result = expectAllowed(await checkPlanLimits("org-1", SEATS));
    expect(result.warning).toBeUndefined();

    const alert = errorLogs.find(
      (e) =>
        typeof e.ctx === "object" &&
        e.ctx !== null &&
        (e.ctx as Record<string, unknown>).reason === "cost_basis_missing",
    );
    expect(alert).toBeDefined();
    expect(alert!.ctx).toMatchObject({ orgId: "org-1", reason: "cost_basis_missing", tokenCount: 1_500_000 });
    expect(String(alert!.msg)).toContain("#4038");
  });

  it("does NOT alert cost-basis when there is genuinely no usage (costUsd $0, no tokens)", async () => {
    mockWorkspace = makeWorkspace();
    mockUsage = { queryCount: 0, tokenCount: 0, costUsd: 0, activeUsers: 0, periodStart: "", periodEnd: "" };
    await checkPlanLimits("org-1", SEATS);
    const alert = errorLogs.find(
      (e) => typeof e.ctx === "object" && e.ctx !== null && (e.ctx as Record<string, unknown>).reason === "cost_basis_missing",
    );
    expect(alert).toBeUndefined();
  });

  // ── Disabled-ceiling extreme-overage alert (#3990, dollars #4038) ──
  // A workspace metering past the default ceiling WITH its abuse ceiling disabled
  // (continue policy) is accruing unbounded overage with no cutoff. evaluateUsage
  // must elevate that to an operator-visible log.error, distinct from an ordinary
  // metered warning.

  it("emits an operator alert at extreme overage when the abuse ceiling is disabled", async () => {
    mockWorkspace = makeWorkspace({ id: "org-uncapped" });
    // 2000% of the $20 credit ($400) with the ceiling disabled → metered (no
    // cutoff) but the unbounded-overage alert fires.
    mockUsage = { queryCount: 0, tokenCount: 0, costUsd: 400, activeUsers: 0, periodStart: "", periodEnd: "" };
    const prev = process.env.ATLAS_ABUSE_CEILING;
    process.env.ATLAS_ABUSE_CEILING = "0"; // disable the ceiling
    _resetSettingsCache();
    invalidatePlanCache();
    try {
      const result = expectAllowed(await checkPlanLimits("org-uncapped", SEATS));
      expect(result.warning).toBeDefined();
      const alert = errorLogs.find(
        (e) =>
          typeof e.ctx === "object" &&
          e.ctx !== null &&
          (e.ctx as Record<string, unknown>).reason === "abuse_ceiling_disabled_extreme_overage",
      );
      expect(alert).toBeDefined();
      expect(alert!.ctx).toMatchObject({ reason: "abuse_ceiling_disabled_extreme_overage", overageDollars: 380 });
    } finally {
      if (prev === undefined) delete process.env.ATLAS_ABUSE_CEILING;
      else process.env.ATLAS_ABUSE_CEILING = prev;
      _resetSettingsCache();
    }
  });

  // ── Caching ───────────────────────────────────────────────────────

  it("uses cached workspace on second call", async () => {
    mockWorkspace = makeWorkspace(); // starter tier
    // 85% of $20 credit = $17 → warning
    mockUsage = { queryCount: 0, tokenCount: 0, costUsd: 17, activeUsers: 0, periodStart: "", periodEnd: "" };

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

  // ── Per-replica staleness contract (#3432) ────────────────────────
  //
  // The planCache is in-memory PER PROCESS: invalidatePlanCache only clears
  // the calling replica's Map. A Stripe webhook on "replica A" cannot reach
  // "replica B"'s cache, so B serves the stale tier until its own TTL lapses.
  // These tests pin that documented contract via the internal-DB read count
  // (a re-read == a cache miss).

  it("serves the cached tier within TTL without re-reading the internal DB (warm cache)", async () => {
    mockWorkspace = makeWorkspace({ plan_tier: "starter" });
    mockUsage = { queryCount: 0, tokenCount: 500_000, activeUsers: 0, periodStart: "", periodEnd: "" };

    // First call populates the cache — one internal-DB read.
    await checkPlanLimits("org-1", SEATS);
    expect(mockWorkspaceReadCount).toBe(1);

    // Tier flips at the source (as a Stripe webhook on ANOTHER replica would
    // land it), but THIS process was not invalidated.
    mockWorkspace = makeWorkspace({ plan_tier: "free" });

    // Second call within TTL is served from the warm cache — no re-read, so
    // the stale "starter" tier is still enforced. This IS the ≤60s window.
    await checkPlanLimits("org-1", SEATS);
    expect(mockWorkspaceReadCount).toBe(1);
  });

  it("invalidatePlanCache only clears the LOCAL process cache — proven by the re-read", async () => {
    mockWorkspace = makeWorkspace({ plan_tier: "starter" });
    mockUsage = { queryCount: 0, tokenCount: 500_000, activeUsers: 0, periodStart: "", periodEnd: "" };

    // Warm the cache for two distinct orgs — one DB read each.
    await checkPlanLimits("org-1", SEATS);
    await checkPlanLimits("org-2", SEATS);
    expect(mockWorkspaceReadCount).toBe(2);

    // Local invalidation models the webhook firing on THIS replica for org-1.
    invalidatePlanCache("org-1");

    // org-1 re-reads (cache cleared locally → DB hit); org-2 stays warm. There
    // is no shared store, so a sibling replica's cache would be untouched by
    // this call — exactly the cross-replica staleness #3432 accepts.
    await checkPlanLimits("org-1", SEATS);
    expect(mockWorkspaceReadCount).toBe(3);
    await checkPlanLimits("org-2", SEATS);
    expect(mockWorkspaceReadCount).toBe(3);
  });
});

// ===========================================================================
// Metered soft-cap classification + overage accounting (#3990)
//
// Unit tests on the pure helpers — `buildMetricStatus` takes the abuse-ceiling
// percent directly, so the metered/hard_limit boundary and the disabled-ceiling
// (pure-metering) case are exercised without going through the settings read.
// ===========================================================================

describe("buildMetricStatus — dollar metered soft-cap classification (#4038)", () => {
  const CREDIT = 20; // $20/seat, 1 seat

  it("classifies under 80% as ok", () => {
    expect(buildMetricStatus("usd", 10, CREDIT, 500).status).toBe("ok");
  });

  it("classifies 80-99% as warning", () => {
    expect(buildMetricStatus("usd", 16, CREDIT, 500).status).toBe("warning"); // 80%
    expect(buildMetricStatus("usd", 19.8, CREDIT, 500).status).toBe("warning"); // 99%
  });

  it("classifies exactly 100% (the credit) as metered", () => {
    expect(buildMetricStatus("usd", 20, CREDIT, 500).status).toBe("metered");
  });

  it("classifies the 100%→ceiling band as metered (110%, 150%, 499%)", () => {
    expect(buildMetricStatus("usd", 22, CREDIT, 500).status).toBe("metered"); // 110%
    expect(buildMetricStatus("usd", 30, CREDIT, 500).status).toBe("metered"); // 150%
    expect(buildMetricStatus("usd", 99.8, CREDIT, 500).status).toBe("metered"); // 499%
  });

  it("classifies at/above the ceiling as hard_limit", () => {
    expect(buildMetricStatus("usd", 100, CREDIT, 500).status).toBe("hard_limit"); // 500%
    expect(buildMetricStatus("usd", 120, CREDIT, 500).status).toBe("hard_limit"); // 600%
  });

  it("honours a custom (lower) ceiling", () => {
    // Ceiling 200%: 150% meters, 200% cuts off.
    expect(buildMetricStatus("usd", 30, CREDIT, 200).status).toBe("metered"); // 150%
    expect(buildMetricStatus("usd", 40, CREDIT, 200).status).toBe("hard_limit"); // 200%
  });

  it("clamps to the credit (100%) under the cutoff policy's ceiling", () => {
    // The `cutoff` spend policy passes METERED_THRESHOLD (100) as the ceiling:
    // any overage past the credit is hard_limit, exactly the credit cuts off.
    expect(buildMetricStatus("usd", 19.8, CREDIT, 100).status).toBe("warning"); // 99%
    expect(buildMetricStatus("usd", 20, CREDIT, 100).status).toBe("hard_limit"); // 100%
    expect(buildMetricStatus("usd", 21, CREDIT, 100).status).toBe("hard_limit"); // 105%
  });

  it("never hard-limits when the ceiling is disabled (null) — pure metering", () => {
    // Even at 2000% of credit, a disabled ceiling keeps the status metered.
    expect(buildMetricStatus("usd", 400, CREDIT, null).status).toBe("metered");
  });

  it("defaults to the conservative ceiling when none is passed", () => {
    // Default param = 500%. 499% meters, 500% cuts off.
    expect(buildMetricStatus("usd", 99.8, CREDIT).status).toBe("metered");
    expect(buildMetricStatus("usd", 100, CREDIT).status).toBe("hard_limit");
  });

  it("treats an invalid (<=0) credit as hard_limit regardless of ceiling", () => {
    expect(buildMetricStatus("usd", 1, 0, 500).status).toBe("hard_limit");
    expect(buildMetricStatus("usd", 1, 0, null).status).toBe("hard_limit");
  });
});

describe("computeOverageDollars (#4038)", () => {
  it("reports zero overage at or under the credit", () => {
    expect(computeOverageDollars(10, 20)).toBe(0);
    expect(computeOverageDollars(20, 20)).toBe(0);
  });

  it("reports the at-cost excess over the credit (identity, no rate)", () => {
    expect(computeOverageDollars(21, 20)).toBeCloseTo(1, 6);
    expect(computeOverageDollars(30, 20)).toBeCloseTo(10, 6);
    expect(computeOverageDollars(20.25, 20)).toBeCloseTo(0.25, 6);
  });

  it("is zero (never negative) when under the credit", () => {
    expect(computeOverageDollars(5, 20)).toBe(0);
  });

  it("guards an invalid (<=0) credit — no overage from a misconfigured credit", () => {
    expect(computeOverageDollars(10, 0)).toBe(0);
  });
});

// computeOverageTokens survives for the token OverageMeter (#3992/#4039) even
// though enforcement no longer uses it — keep it under test.
describe("computeOverageTokens (token OverageMeter, #3990)", () => {
  it("reports zero overage at or under budget", () => {
    expect(computeOverageTokens(1_000_000, 2_000_000)).toBe(0);
    expect(computeOverageTokens(2_000_000, 2_000_000)).toBe(0);
  });

  it("reports the excess over budget as overage tokens", () => {
    expect(computeOverageTokens(2_100_000, 2_000_000)).toBe(100_000);
    expect(computeOverageTokens(3_000_000, 2_000_000)).toBe(1_000_000);
  });

  it("guards an invalid (<=0) limit", () => {
    expect(computeOverageTokens(1_000_000, 0)).toBe(0);
  });
});

describe("resolveAbuseCeilingPercent — settings parsing (#3990)", () => {
  // The setting resolves through the REAL settings module (internalQuery is
  // mocked to return no rows, so reads fall to the env var → registry default).
  // Each case sets ATLAS_ABUSE_CEILING in env, clears the settings live cache,
  // then restores env — self-contained, no top-level env mutation.
  async function withCeilingEnv<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
    const prev = process.env.ATLAS_ABUSE_CEILING;
    if (value === undefined) delete process.env.ATLAS_ABUSE_CEILING;
    else process.env.ATLAS_ABUSE_CEILING = value;
    _resetSettingsCache();
    try {
      return await fn();
    } finally {
      if (prev === undefined) delete process.env.ATLAS_ABUSE_CEILING;
      else process.env.ATLAS_ABUSE_CEILING = prev;
      _resetSettingsCache();
    }
  }

  it("returns the registry default (500) when unset", async () => {
    const ceiling = await withCeilingEnv(undefined, () => resolveAbuseCeilingPercent("org-ceiling-default"));
    expect(ceiling).toBe(500);
  });

  it("returns a custom numeric ceiling", async () => {
    const ceiling = await withCeilingEnv("250", () => resolveAbuseCeilingPercent("org-ceiling-custom"));
    expect(ceiling).toBe(250);
  });

  it("returns null (disabled) for '0'", async () => {
    const ceiling = await withCeilingEnv("0", () => resolveAbuseCeilingPercent("org-ceiling-zero"));
    expect(ceiling).toBeNull();
  });

  it("returns null (disabled) for an empty/whitespace value", async () => {
    const ceiling = await withCeilingEnv("  ", () => resolveAbuseCeilingPercent("org-ceiling-blank"));
    expect(ceiling).toBeNull();
  });

  it("floors a self-defeating ceiling (<=100%) at the default", async () => {
    const ceiling = await withCeilingEnv("90", () => resolveAbuseCeilingPercent("org-ceiling-low"));
    expect(ceiling).toBe(500);
  });

  it("falls back to the default for a non-numeric value", async () => {
    const ceiling = await withCeilingEnv("not-a-number", () => resolveAbuseCeilingPercent("org-ceiling-garbage"));
    expect(ceiling).toBe(500);
  });
});

describe("resolveSpendPolicy — settings parsing (#4038)", () => {
  // Resolves through the REAL settings module (internalQuery mocked to no rows,
  // so reads fall to env → registry default "continue"). Self-contained env
  // set/restore + live-cache reset, no top-level mutation.
  async function withPolicyEnv<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
    const prev = process.env.ATLAS_SPEND_POLICY;
    if (value === undefined) delete process.env.ATLAS_SPEND_POLICY;
    else process.env.ATLAS_SPEND_POLICY = value;
    _resetSettingsCache();
    try {
      return await fn();
    } finally {
      if (prev === undefined) delete process.env.ATLAS_SPEND_POLICY;
      else process.env.ATLAS_SPEND_POLICY = prev;
      _resetSettingsCache();
    }
  }

  it("defaults to 'continue' when unset (default-ON spend posture)", async () => {
    const policy = await withPolicyEnv(undefined, () => resolveSpendPolicy("org-policy-default"));
    expect(policy).toBe("continue");
  });

  it("honours an explicit 'cutoff'", async () => {
    const policy = await withPolicyEnv("cutoff", () => resolveSpendPolicy("org-policy-cutoff"));
    expect(policy).toBe("cutoff");
  });

  it("honours an explicit 'continue'", async () => {
    const policy = await withPolicyEnv("continue", () => resolveSpendPolicy("org-policy-continue"));
    expect(policy).toBe("continue");
  });

  it("is case/whitespace tolerant", async () => {
    expect(await withPolicyEnv("  CUTOFF  ", () => resolveSpendPolicy("org-policy-case"))).toBe("cutoff");
  });

  it("falls back to 'continue' for an unrecognised value (never silent cutoff)", async () => {
    const policy = await withPolicyEnv("stop-everything", () => resolveSpendPolicy("org-policy-garbage"));
    expect(policy).toBe("continue");
  });

  it("falls back to 'continue' (never throws) when the settings read fails", async () => {
    // Force getSettingLive → loadSettings → internalQuery to throw; the catch
    // must degrade to the default posture, not propagate (a paying workspace is
    // never silently flipped to a hard cutoff by an internal-DB blip).
    mockInternalQueryShouldThrow = true;
    try {
      expect(await resolveSpendPolicy("org-policy-throws")).toBe("continue");
    } finally {
      mockInternalQueryShouldThrow = false;
    }
  });
});

// ===========================================================================
// resolveUsageCeiling — the spend-policy × ceiling SSOT (#4038)
//
// The single source both enforcement and the billing page read, so the gauge
// and the 429 can never disagree. The load-bearing property: `cutoff` clamps to
// 100% of credit WITHOUT consulting the abuse ceiling (so an unrelated
// ATLAS_ABUSE_CEILING can never defeat a customer's hard cutoff); `continue`
// tracks resolveAbuseCeilingPercent.
// ===========================================================================

describe("resolveUsageCeiling — policy × ceiling SSOT (#4038)", () => {
  async function withEnv<T>(
    spendPolicy: string | undefined,
    abuseCeiling: string | undefined,
    fn: () => Promise<T>,
  ): Promise<T> {
    const prevPolicy = process.env.ATLAS_SPEND_POLICY;
    const prevCeiling = process.env.ATLAS_ABUSE_CEILING;
    if (spendPolicy === undefined) delete process.env.ATLAS_SPEND_POLICY;
    else process.env.ATLAS_SPEND_POLICY = spendPolicy;
    if (abuseCeiling === undefined) delete process.env.ATLAS_ABUSE_CEILING;
    else process.env.ATLAS_ABUSE_CEILING = abuseCeiling;
    _resetSettingsCache();
    try {
      return await fn();
    } finally {
      if (prevPolicy === undefined) delete process.env.ATLAS_SPEND_POLICY;
      else process.env.ATLAS_SPEND_POLICY = prevPolicy;
      if (prevCeiling === undefined) delete process.env.ATLAS_ABUSE_CEILING;
      else process.env.ATLAS_ABUSE_CEILING = prevCeiling;
      _resetSettingsCache();
    }
  }

  it("continue → ceiling tracks resolveAbuseCeilingPercent (default 500)", async () => {
    const r = await withEnv("continue", undefined, () => resolveUsageCeiling("org-rc-1"));
    expect(r).toEqual({ spendPolicy: "continue", ceilingPercent: 500 });
  });

  it("continue → honours a custom abuse ceiling", async () => {
    const r = await withEnv("continue", "250", () => resolveUsageCeiling("org-rc-2"));
    expect(r).toEqual({ spendPolicy: "continue", ceilingPercent: 250 });
  });

  it("continue → null ceiling when the abuse ceiling is disabled (0)", async () => {
    const r = await withEnv("continue", "0", () => resolveUsageCeiling("org-rc-3"));
    expect(r).toEqual({ spendPolicy: "continue", ceilingPercent: null });
  });

  it("cutoff → clamps to 100% of credit, IGNORING a disabled abuse ceiling", async () => {
    // The defeat case: a `cutoff` customer with ATLAS_ABUSE_CEILING=0 must still
    // hard-block at the credit — cutoff must NOT route through the abuse-ceiling
    // resolver (which would return null/disabled and serve unlimited).
    const r = await withEnv("cutoff", "0", () => resolveUsageCeiling("org-rc-4"));
    expect(r).toEqual({ spendPolicy: "cutoff", ceilingPercent: 100 });
  });

  it("cutoff → clamps to 100% regardless of a high abuse ceiling", async () => {
    const r = await withEnv("cutoff", "9999", () => resolveUsageCeiling("org-rc-5"));
    expect(r).toEqual({ spendPolicy: "cutoff", ceilingPercent: 100 });
  });
});

// ===========================================================================
// checkResourceLimit — seat / connection plan enforcement
// ===========================================================================

/** Narrow a cap-reached (vs check-failed) denial for type-safe `.limit` access. */
function expectResourceDenied(
  result: ResourceLimitResult,
): Extract<ResourceLimitResult, { allowed: false; reason: "cap_reached" }> {
  expect(result.allowed).toBe(false);
  if (!result.allowed) expect(result.reason).toBe("cap_reached");
  return result as Extract<ResourceLimitResult, { allowed: false; reason: "cap_reached" }>;
}

/** Narrow a fail-closed (check_failed) denial. */
function expectCheckFailed(
  result: ResourceLimitResult,
): Extract<ResourceLimitResult, { allowed: false; reason: "check_failed" }> {
  expect(result.allowed).toBe(false);
  if (!result.allowed) expect(result.reason).toBe("check_failed");
  return result as Extract<ResourceLimitResult, { allowed: false; reason: "check_failed" }>;
}

describe("checkResourceLimit — locked tier (#3421)", () => {
  beforeEach(() => {
    mockHasInternalDB = true;
    mockWorkspace = makeWorkspace({ plan_tier: "locked" });
    invalidatePlanCache();
  });

  it("blocks adding any seat/connection/chat integration (caps are 0)", async () => {
    for (const resource of ["seats", "connections", "chat_integrations"] as const) {
      const result = await checkResourceLimit("org-1", resource, 0);
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.reason).toBe("cap_reached");
      }
    }
  });
});

describe("checkResourceLimit", () => {
  beforeEach(() => {
    mockHasInternalDB = true;
    mockWorkspaceDetailsShouldThrow = false;
    mockWorkspace = null;
    mockInternalQueryResult = [];
    mockInternalQueryShouldThrow = false;
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

  it("blocks when workspace details fetch fails (fail closed, check_failed)", async () => {
    mockWorkspaceDetailsShouldThrow = true;
    const denied = expectCheckFailed(await checkResourceLimit("org-1", "seats", 100));
    // check_failed carries no `limit` — there's no meaningful cap to report.
    expect(denied.errorMessage).toContain("Unable to verify plan limits");
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

  // ── Chat integrations (#2953) ─────────────────────────────────────

  it("allows free tier unconditionally (chat_integrations)", async () => {
    mockWorkspace = makeWorkspace({ plan_tier: "free" });
    const result = await checkResourceLimit("org-1", "chat_integrations", 9999);
    expect(result.allowed).toBe(true);
  });

  it("allows business tier unconditionally (chat_integrations)", async () => {
    mockWorkspace = makeWorkspace({ plan_tier: "business" });
    const result = await checkResourceLimit("org-1", "chat_integrations", 9999);
    expect(result.allowed).toBe(true);
  });

  it("allows starter tier under chat-integration limit", async () => {
    mockWorkspace = makeWorkspace({ plan_tier: "starter" });
    // Starter plan maxChatIntegrations = 1
    const result = await checkResourceLimit("org-1", "chat_integrations", 0);
    expect(result.allowed).toBe(true);
  });

  it("blocks starter tier at chat-integration limit (singular label)", async () => {
    mockWorkspace = makeWorkspace({ plan_tier: "starter" });
    const denied = expectResourceDenied(
      await checkResourceLimit("org-1", "chat_integrations", 1),
    );
    expect(denied.limit).toBe(1);
    expect(denied.errorMessage).toContain("1 chat integration");
    expect(denied.errorMessage).toContain("Upgrade");
  });

  it("blocks starter tier over chat-integration limit (grandfathered — still cannot add)", async () => {
    mockWorkspace = makeWorkspace({ plan_tier: "starter" });
    // Already over the new cap (e.g. installed before enforcement landed).
    const denied = expectResourceDenied(
      await checkResourceLimit("org-1", "chat_integrations", 5),
    );
    expect(denied.limit).toBe(1);
  });

  it("blocks pro tier at chat-integration limit (plural label)", async () => {
    mockWorkspace = makeWorkspace({ plan_tier: "pro" });
    // Pro plan maxChatIntegrations = 3
    const denied = expectResourceDenied(
      await checkResourceLimit("org-1", "chat_integrations", 3),
    );
    expect(denied.limit).toBe(3);
    expect(denied.errorMessage).toContain("3 chat integrations");
  });

  it("allows pro tier under chat-integration limit", async () => {
    mockWorkspace = makeWorkspace({ plan_tier: "pro" });
    const result = await checkResourceLimit("org-1", "chat_integrations", 2);
    expect(result.allowed).toBe(true);
  });
});

// ===========================================================================
// checkChatIntegrationLimit — read-only pre-redirect cap precheck (#2998)
//
// The chat handlers run this BEFORE minting the provider OAuth redirect so an
// at-cap workspace is refused before completing the whole dance. It reuses the
// SAME count aggregate + checkResourceLimit decision as the atomic gate, but
// opens no transaction and runs no INSERT — `mockConnectCount` must stay 0.
// ===========================================================================

describe("checkChatIntegrationLimit (read-only precheck)", () => {
  const SLACK = "catalog:slack";

  beforeEach(() => {
    mockHasInternalDB = true;
    mockWorkspaceDetailsShouldThrow = false;
    mockWorkspace = null;
    mockInternalQueryResult = [];
    mockInternalQueryShouldThrow = false;
    mockTxnClient = null;
    mockConnectCount = 0;
    invalidatePlanCache();
  });

  // ── No-enforcement short-circuits ─────────────────────────────────

  it("allows when no orgId provided (and opens no transaction)", async () => {
    const result = await checkChatIntegrationLimit(undefined, SLACK);
    expect(result.allowed).toBe(true);
    expect(mockConnectCount).toBe(0);
  });

  it("allows when no internal DB", async () => {
    mockHasInternalDB = false;
    const result = await checkChatIntegrationLimit("org-1", SLACK);
    expect(result.allowed).toBe(true);
    expect(mockConnectCount).toBe(0);
  });

  it("allows when the workspace has no organization row (fail-open, no plan)", async () => {
    mockWorkspace = null;
    const result = await checkChatIntegrationLimit("org-1", SLACK);
    expect(result.allowed).toBe(true);
  });

  // ── Fail-closed paths (→ 503 "try again") ─────────────────────────

  it("fails closed (check_failed) when the workspace lookup throws", async () => {
    mockWorkspace = makeWorkspace({ plan_tier: "starter" });
    mockWorkspaceDetailsShouldThrow = true;
    const denied = expectCheckFailed(await checkChatIntegrationLimit("org-1", SLACK));
    expect(denied.errorMessage).toContain("Unable to verify plan limits");
  });

  it("fails closed (check_failed) when the count query throws", async () => {
    mockWorkspace = makeWorkspace({ plan_tier: "starter" });
    mockInternalQueryShouldThrow = true;
    const denied = expectCheckFailed(await checkChatIntegrationLimit("org-1", SLACK));
    expect(denied.errorMessage).toContain("Unable to verify plan limits");
  });

  it("fails closed (check_failed) when the count returns no row (no coerce-to-0)", async () => {
    mockWorkspace = makeWorkspace({ plan_tier: "starter" });
    mockInternalQueryResult = [];
    expectCheckFailed(await checkChatIntegrationLimit("org-1", SLACK));
  });

  // ── Reconnect carve-out — never blocked ───────────────────────────

  it("allows reconnect (this_count > 0) even when over the cap", async () => {
    mockWorkspace = makeWorkspace({ plan_tier: "starter" });
    // Slack already installed (this_count=1) and the workspace is over its
    // starter cap on other platforms — reconnect must still be allowed.
    mockInternalQueryResult = [{ others: 5, this_count: 1 }];
    const result = await checkChatIntegrationLimit("org-1", SLACK);
    expect(result.allowed).toBe(true);
  });

  // ── Net-new decisions ─────────────────────────────────────────────

  it("allows starter net-new under the cap (others=0)", async () => {
    mockWorkspace = makeWorkspace({ plan_tier: "starter" });
    mockInternalQueryResult = [{ others: 0, this_count: 0 }];
    const result = await checkChatIntegrationLimit("org-1", SLACK);
    expect(result.allowed).toBe(true);
    // Read-only — never opened a transaction.
    expect(mockConnectCount).toBe(0);
  });

  it("blocks starter net-new at the cap (cap_reached, carries the limit)", async () => {
    mockWorkspace = makeWorkspace({ plan_tier: "starter" });
    // One other chat platform already installed; starter cap = 1.
    mockInternalQueryResult = [{ others: 1, this_count: 0 }];
    const denied = expectResourceDenied(await checkChatIntegrationLimit("org-1", SLACK));
    expect(denied.limit).toBe(1);
    expect(denied.errorMessage).toContain("Upgrade");
    // Still read-only on the deny path.
    expect(mockConnectCount).toBe(0);
  });

  it("allows business (unlimited) net-new", async () => {
    mockWorkspace = makeWorkspace({ plan_tier: "business" });
    mockInternalQueryResult = [{ others: 9, this_count: 0 }];
    const result = await checkChatIntegrationLimit("org-1", SLACK);
    expect(result.allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// checkChatIntegrationLimitAndInstall — atomic cap + INSERT gate (#2953, #3001)
//
// Exercises the in-transaction decision logic against a fake client that
// records the BEGIN → advisory-lock → COUNT → (INSERT/COMMIT | ROLLBACK)
// sequence. The COUNT and INSERT rows are scripted per test; the real-Postgres
// aggregate + the concurrency race are covered by chat-cap-pg.test.ts (#2999).
// ---------------------------------------------------------------------------

describe("checkChatIntegrationLimitAndInstall", () => {
  const SLACK = "catalog:slack";
  /** A representative workspace_plugins UPSERT — the fake client matches on substring. */
  const INSERT = {
    sql: `INSERT INTO workspace_plugins (id, workspace_id, catalog_id, install_id, pillar, config, enabled, installed_at)
      VALUES ($1, $2, $3, $1, 'chat', $4::jsonb, true, NOW())
      ON CONFLICT (workspace_id, catalog_id) WHERE pillar IN ('chat', 'action') DO UPDATE
        SET config = EXCLUDED.config, enabled = true
      RETURNING id`,
    params: ["install-1", "org-1", SLACK, "{}"],
  };

  beforeEach(() => {
    mockHasInternalDB = true;
    mockWorkspaceDetailsShouldThrow = false;
    mockWorkspace = null;
    mockInternalQueryResult = [];
    mockInternalQueryShouldThrow = false;
    mockTxnClient = null;
    mockConnectCount = 0;
    invalidatePlanCache();
  });

  /** Configure the fake txn client with scripted COUNT + INSERT rows. */
  function setTxn(
    others: number,
    thisCount: number,
    opts: { insertRows?: Array<Record<string, unknown>>; rollbackThrows?: boolean } = {},
  ): ReturnType<typeof makeFakeTxnClient> {
    mockTxnClient = makeFakeTxnClient({
      countRows: [{ others, this_count: thisCount }],
      insertRows: opts.insertRows ?? [{ id: "persisted-1" }],
      rollbackThrows: opts.rollbackThrows,
    });
    return mockTxnClient;
  }

  // ── No-enforcement short-circuit (no lock / transaction) ──────────

  it("runs the INSERT directly (no transaction) when no orgId", async () => {
    mockInternalQueryResult = [{ id: "direct-1" }];
    const result = await checkChatIntegrationLimitAndInstall<{ id: string }>(undefined, SLACK, INSERT);
    expect(result.allowed).toBe(true);
    if (result.allowed) expect(result.rows).toEqual([{ id: "direct-1" }]);
    expect(mockConnectCount).toBe(0);
  });

  it("runs the INSERT directly (no transaction) when no internal DB", async () => {
    mockHasInternalDB = false;
    mockInternalQueryResult = [{ id: "direct-2" }];
    const result = await checkChatIntegrationLimitAndInstall<{ id: string }>("org-1", SLACK, INSERT);
    expect(result.allowed).toBe(true);
    expect(mockConnectCount).toBe(0);
  });

  it("runs the INSERT directly (no lock) when the workspace has no organization row", async () => {
    // orgId present + internal DB present, but no `organization` row → no plan,
    // no cap. The ONLY deliberate fail-open: allow with a direct INSERT and
    // never open a transaction. (A workspace lookup *error* fails closed — see
    // the next section; a genuine *absence* allows.)
    mockWorkspace = null;
    mockInternalQueryResult = [{ id: "no-org-row" }];
    const result = await checkChatIntegrationLimitAndInstall<{ id: string }>("org-1", SLACK, INSERT);
    expect(result.allowed).toBe(true);
    if (result.allowed) expect(result.rows).toEqual([{ id: "no-org-row" }]);
    // No transaction opened — the fail-open path skips the lock entirely.
    expect(mockConnectCount).toBe(0);
  });

  // ── Fail-closed before/under the lock ─────────────────────────────

  it("fails closed (check_failed) before opening a transaction when the workspace lookup throws", async () => {
    mockWorkspace = makeWorkspace({ plan_tier: "starter" });
    mockWorkspaceDetailsShouldThrow = true;
    const denied = expectInstallCheckFailed(
      await checkChatIntegrationLimitAndInstall<{ id: string }>("org-1", SLACK, INSERT),
    );
    expect(denied.errorMessage).toContain("Unable to verify plan limits");
    // Failed closed before taking the lock — no transaction opened.
    expect(mockConnectCount).toBe(0);
  });

  it("fails closed (check_failed) and rolls back when the count query throws under the lock", async () => {
    mockWorkspace = makeWorkspace({ plan_tier: "starter" });
    mockTxnClient = makeFakeTxnClient({ countThrows: true });
    const denied = expectInstallCheckFailed(
      await checkChatIntegrationLimitAndInstall<{ id: string }>("org-1", SLACK, INSERT),
    );
    expect(denied.errorMessage).toContain("Unable to verify plan limits");
    expect(mockTxnClient.ran("ROLLBACK")).toBe(true);
    expect(mockTxnClient.ran("INSERT INTO workspace_plugins")).toBe(false);
    expect(mockTxnClient.ran("COMMIT")).toBe(false);
  });

  it("fails closed (check_failed) when the count returns no row (no coerce-to-0)", async () => {
    mockWorkspace = makeWorkspace({ plan_tier: "starter" });
    mockTxnClient = makeFakeTxnClient({ countRows: [] });
    expectInstallCheckFailed(
      await checkChatIntegrationLimitAndInstall<{ id: string }>("org-1", SLACK, INSERT),
    );
    expect(mockTxnClient.ran("ROLLBACK")).toBe(true);
    expect(mockTxnClient.ran("INSERT INTO workspace_plugins")).toBe(false);
  });

  // ── Allowed paths — INSERT + COMMIT ───────────────────────────────

  it("allows free tier net-new and commits the INSERT", async () => {
    mockWorkspace = makeWorkspace({ plan_tier: "free" });
    const txn = setTxn(9, 0, { insertRows: [{ id: "free-row" }] });
    const result = await checkChatIntegrationLimitAndInstall<{ id: string }>("org-1", SLACK, INSERT);
    expect(result.allowed).toBe(true);
    if (result.allowed) expect(result.rows).toEqual([{ id: "free-row" }]);
    expect(txn.ran("INSERT INTO workspace_plugins")).toBe(true);
    expect(txn.ran("COMMIT")).toBe(true);
    expect(txn.ran("ROLLBACK")).toBe(false);
    expect(txn.state.released).toBe(true);
  });

  it("allows business (unlimited) net-new and commits", async () => {
    mockWorkspace = makeWorkspace({ plan_tier: "business" });
    const txn = setTxn(7, 0);
    const result = await checkChatIntegrationLimitAndInstall<{ id: string }>("org-1", SLACK, INSERT);
    expect(result.allowed).toBe(true);
    expect(txn.ran("COMMIT")).toBe(true);
  });

  it("allows starter first install (no others) and commits", async () => {
    mockWorkspace = makeWorkspace({ plan_tier: "starter" });
    const txn = setTxn(0, 0);
    const result = await checkChatIntegrationLimitAndInstall<{ id: string }>("org-1", SLACK, INSERT);
    expect(result.allowed).toBe(true);
    expect(txn.ran("INSERT INTO workspace_plugins")).toBe(true);
    expect(txn.ran("COMMIT")).toBe(true);
  });

  it("allows pro under cap (2 others, net-new third) and commits", async () => {
    mockWorkspace = makeWorkspace({ plan_tier: "pro" });
    const txn = setTxn(2, 0);
    const result = await checkChatIntegrationLimitAndInstall<{ id: string }>("org-1", SLACK, INSERT);
    expect(result.allowed).toBe(true);
    expect(txn.ran("COMMIT")).toBe(true);
  });

  // ── Reconnect is never blocked (skips the cap comparison) ──────────

  it("allows reconnect at cap and commits (skips the cap comparison)", async () => {
    mockWorkspace = makeWorkspace({ plan_tier: "starter" });
    // Slack itself is already installed (this_count=1) and is the only one.
    const txn = setTxn(0, 1);
    const result = await checkChatIntegrationLimitAndInstall<{ id: string }>("org-1", SLACK, INSERT);
    expect(result.allowed).toBe(true);
    expect(txn.ran("INSERT INTO workspace_plugins")).toBe(true);
    expect(txn.ran("COMMIT")).toBe(true);
  });

  it("allows reconnect even when grandfathered over cap", async () => {
    mockWorkspace = makeWorkspace({ plan_tier: "starter" });
    // Over the cap (others=2) but reconnecting a platform already owned.
    const txn = setTxn(2, 1);
    const result = await checkChatIntegrationLimitAndInstall<{ id: string }>("org-1", SLACK, INSERT);
    expect(result.allowed).toBe(true);
    expect(txn.ran("COMMIT")).toBe(true);
  });

  // ── Cap reached — ROLLBACK, no INSERT ─────────────────────────────

  it("blocks starter net-new at cap, rolls back, and never INSERTs", async () => {
    mockWorkspace = makeWorkspace({ plan_tier: "starter" });
    const txn = setTxn(1, 0); // one other chat platform → cap=1 hit
    const denied = expectInstallCapReached(
      await checkChatIntegrationLimitAndInstall<{ id: string }>("org-1", SLACK, INSERT),
    );
    expect(denied.limit).toBe(1);
    expect(denied.errorMessage).toContain("1 chat integration");
    expect(txn.ran("ROLLBACK")).toBe(true);
    expect(txn.ran("INSERT INTO workspace_plugins")).toBe(false);
    expect(txn.ran("COMMIT")).toBe(false);
  });

  it("blocks a grandfathered over-cap net-new and rolls back", async () => {
    mockWorkspace = makeWorkspace({ plan_tier: "starter" });
    const txn = setTxn(2, 0);
    expectInstallCapReached(
      await checkChatIntegrationLimitAndInstall<{ id: string }>("org-1", SLACK, INSERT),
    );
    expect(txn.ran("ROLLBACK")).toBe(true);
    expect(txn.ran("INSERT INTO workspace_plugins")).toBe(false);
  });

  it("blocks pro at cap (3 others) and rolls back", async () => {
    mockWorkspace = makeWorkspace({ plan_tier: "pro" });
    const txn = setTxn(3, 0);
    const denied = expectInstallCapReached(
      await checkChatIntegrationLimitAndInstall<{ id: string }>("org-1", SLACK, INSERT),
    );
    expect(denied.limit).toBe(3);
    expect(txn.ran("ROLLBACK")).toBe(true);
  });

  // ── Sequencing + write-path failures ──────────────────────────────

  it("acquires the per-workspace advisory lock before counting, and runs the exact aggregate SQL", async () => {
    mockWorkspace = makeWorkspace({ plan_tier: "starter" });
    const txn = setTxn(0, 0);
    await checkChatIntegrationLimitAndInstall<{ id: string }>("org-1", SLACK, INSERT);

    const sqls = txn.sqls();
    const beginAt = sqls.findIndex((s) => s === "BEGIN");
    const lockAt = sqls.findIndex((s) => s.includes("pg_advisory_xact_lock"));
    const countAt = sqls.findIndex((s) => s.includes("COUNT(*) FILTER"));
    const insertAt = sqls.findIndex((s) => s.includes("INSERT INTO workspace_plugins"));
    const commitAt = sqls.findIndex((s) => s === "COMMIT");
    // BEGIN → lock → count → insert → commit, strictly ordered.
    expect(beginAt).toBe(0);
    expect(lockAt).toBeGreaterThan(beginAt);
    expect(countAt).toBeGreaterThan(lockAt);
    expect(insertAt).toBeGreaterThan(countAt);
    expect(commitAt).toBeGreaterThan(insertAt);

    // The recount under the lock uses the exact exported aggregate (the same
    // SQL the real-PG #2999 test pins), parameterized on (workspace, catalog).
    const countCall = txn.calls.find((c) => c.sql.includes("COUNT(*) FILTER"));
    expect(countCall?.sql).toBe(CHAT_INTEGRATION_COUNT_SQL);
    expect(countCall?.params).toEqual(["org-1", SLACK]);
  });

  it("re-throws a write-path failure (INSERT error) and rolls back", async () => {
    mockWorkspace = makeWorkspace({ plan_tier: "starter" });
    const txn = makeFakeTxnClient({ countRows: [{ others: 0, this_count: 0 }], insertThrows: true });
    mockTxnClient = txn;
    await expect(
      checkChatIntegrationLimitAndInstall<{ id: string }>("org-1", SLACK, INSERT),
    ).rejects.toThrow("insert failed");
    expect(txn.ran("ROLLBACK")).toBe(true);
    expect(txn.ran("COMMIT")).toBe(false);
  });

  it("destroys the client on a failed ROLLBACK (poisoned socket) while still returning the denial", async () => {
    mockWorkspace = makeWorkspace({ plan_tier: "starter" });
    // Cap reached → ROLLBACK path; the ROLLBACK itself fails.
    const txn = setTxn(1, 0, { rollbackThrows: true });
    const denied = expectInstallCapReached(
      await checkChatIntegrationLimitAndInstall<{ id: string }>("org-1", SLACK, INSERT),
    );
    expect(denied.limit).toBe(1);
    // release() called with the rollback error so the pool destroys the client.
    expect(txn.state.released).toBe(true);
    expect(txn.state.releaseErr).toBeInstanceOf(Error);
  });
});
