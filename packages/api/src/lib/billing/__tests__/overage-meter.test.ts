/**
 * Unit tests for the OverageMeter reporter (#3992).
 *
 * Covers the four acceptance criteria at the module boundary:
 *   - period overage reported idempotently + reconcilably (ledger-backed):
 *     the same delta reported twice bills once;
 *   - the metered item is added as a second subscription item per tier;
 *   - delta math / identifier determinism (the idempotency primitives);
 *   - BYOT workspaces are NEVER reported.
 *
 * The meaty per-workspace path takes its I/O as injected deps (CLAUDE.md:
 * prefer dependency injection over `mock.module`), so most tests need only a
 * Stripe double. The ledger SQL-shape + the sweep scan are pinned against a
 * mocked `internalQuery`, mirroring `stripe-event-ledger.test.ts`.
 */

import { describe, it, expect, beforeEach, mock, type Mock } from "bun:test";
import type Stripe from "stripe";
import { buildInternalDbMockDefaults } from "@atlas/api/testing/api-test-mocks";
import type {
  OverageWorkspaceRow,
  WorkspaceOverageDeps,
  OverageReportRecord,
} from "@atlas/api/lib/billing/overage-meter";

// ── Mocked internal DB (drives the ledger reads/writes + the sweep scan) ──
const mockInternalQuery: Mock<(sql: string, params?: unknown[]) => Promise<unknown[]>> = mock(
  () => Promise.resolve([]),
);
let hasDb = true;
mock.module("@atlas/api/lib/db/internal", () => ({
  ...buildInternalDbMockDefaults({
    internalQuery: mockInternalQuery,
    hasInternalDB: () => hasDb,
  }),
}));

// ── Mocked Stripe client (only the period sweep resolves it) ──────────────
let stripeForSweep: Stripe | null = null;
mock.module("@atlas/api/lib/billing/stripe-client", () => ({
  getStripeClient: () => stripeForSweep,
  _resetStripeClientCache: () => {},
}));

// ── Quiet logger ──────────────────────────────────────────────────────────
const stubLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  fatal: () => {},
  trace: () => {},
};
mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => stubLogger,
  getLogger: () => stubLogger,
  setLogLevel: () => false,
  withRequestContext: (_ctx: unknown, fn: () => unknown) => fn(),
  getRequestContext: () => undefined,
  redactPaths: [] as string[],
  hashShareToken: (token: string) => token,
}));

const {
  OVERAGE_METER_EVENT_NAME,
  OVERAGE_REPORT_INTERVAL_MS,
  getOveragePriceIdForTier,
  computeReportableDelta,
  buildOverageEventIdentifier,
  getReportedOverageTokens,
  recordOverageReport,
  reportWorkspaceOverage,
  reportPeriodOverages,
  ensureOverageSubscriptionItem,
} = await import("../overage-meter");

const NOW = new Date("2026-06-15T12:00:00.000Z");
const PERIOD_START = "2026-06-01T00:00:00.000Z";

// ── Stripe doubles ──────────────────────────────────────────────────────
interface MeterDouble {
  stripe: Stripe;
  meterCreate: Mock<(params: unknown) => Promise<unknown>>;
}
function makeMeterStripe(impl?: (params: unknown) => Promise<unknown>): MeterDouble {
  const meterCreate = mock(impl ?? (async () => ({ identifier: "ok" })));
  const stripe = {
    billing: { meterEvents: { create: meterCreate } },
  } as unknown as Stripe;
  return { stripe, meterCreate };
}

interface ItemDouble {
  stripe: Stripe;
  itemCreate: Mock<(params: unknown) => Promise<unknown>>;
}
function makeItemStripe(impl?: (params: unknown) => Promise<unknown>): ItemDouble {
  const itemCreate = mock(impl ?? (async () => ({ id: "si_new" })));
  const stripe = {
    subscriptionItems: { create: itemCreate },
  } as unknown as Stripe;
  return { stripe, itemCreate };
}

// ── Injectable per-workspace deps ────────────────────────────────────────
function makeDeps(overrides: Partial<WorkspaceOverageDeps> = {}): {
  deps: WorkspaceOverageDeps;
  recordCalls: OverageReportRecord[];
} {
  const recordCalls: OverageReportRecord[] = [];
  const deps: WorkspaceOverageDeps = {
    getSeatCount: async () => 1,
    getCurrentPeriodUsage: async () => ({
      queryCount: 0,
      tokenCount: 0,
      weightedTokenCount: 0,
      costUsd: 0,
      activeUsers: 0,
      periodStart: PERIOD_START,
      periodEnd: "2026-07-01T00:00:00.000Z",
      periodSource: "utc-month",
    }),
    getReportedOverageTokens: async () => 0,
    recordOverageReport: async (r) => {
      recordCalls.push(r);
    },
    ...overrides,
  };
  return { deps, recordCalls };
}

const STARTER_BUDGET = 2_000_000; // plans.ts starter tokenBudgetPerSeat × 1 seat

function starterRow(overrides: Partial<OverageWorkspaceRow> = {}): OverageWorkspaceRow {
  return {
    org_id: "org_1",
    plan_tier: "starter",
    byot: false,
    stripe_customer_id: "cus_1",
    ...overrides,
  };
}

beforeEach(() => {
  hasDb = true;
  stripeForSweep = null;
  mockInternalQuery.mockReset();
  mockInternalQuery.mockImplementation(() => Promise.resolve([]));
});

// ───────────────────────────────────────────────────────────────────────
describe("computeReportableDelta", () => {
  it("reports the gap when current overage exceeds what's already reported", () => {
    expect(computeReportableDelta(500, 0)).toBe(500);
    expect(computeReportableDelta(500, 200)).toBe(300);
  });

  it("is zero when nothing new has accrued (same delta reported twice → bill once)", () => {
    expect(computeReportableDelta(500, 500)).toBe(0);
  });

  it("never goes negative when the ledger is ahead (downward correction)", () => {
    expect(computeReportableDelta(300, 500)).toBe(0);
  });

  it("returns 0 for non-finite inputs", () => {
    expect(computeReportableDelta(Number.NaN, 0)).toBe(0);
    expect(computeReportableDelta(500, Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("buildOverageEventIdentifier", () => {
  it("is deterministic on the baseline (re-report after crash → same id)", () => {
    const a = buildOverageEventIdentifier("org_1", PERIOD_START, 500);
    const b = buildOverageEventIdentifier("org_1", PERIOD_START, 500);
    expect(a).toBe(b);
  });

  it("differs when the baseline advances (distinct, non-overlapping ranges)", () => {
    expect(buildOverageEventIdentifier("org_1", PERIOD_START, 500)).not.toBe(
      buildOverageEventIdentifier("org_1", PERIOD_START, 650),
    );
  });

  it("scopes by org and period", () => {
    expect(buildOverageEventIdentifier("org_1", PERIOD_START, 500)).toContain("org_1");
    expect(buildOverageEventIdentifier("org_1", PERIOD_START, 500)).not.toBe(
      buildOverageEventIdentifier("org_2", PERIOD_START, 500),
    );
  });
});

describe("getOveragePriceIdForTier", () => {
  it("resolves each tier's metered-overage price via the injected resolver", () => {
    const store: Record<string, string> = {
      STRIPE_STARTER_OVERAGE_PRICE_ID: "price_so",
      STRIPE_PRO_OVERAGE_PRICE_ID: "price_po",
      STRIPE_BUSINESS_OVERAGE_PRICE_ID: "price_bo",
    };
    const resolve = (k: string) => store[k];
    expect(getOveragePriceIdForTier("starter", resolve)).toBe("price_so");
    expect(getOveragePriceIdForTier("pro", resolve)).toBe("price_po");
    expect(getOveragePriceIdForTier("business", resolve)).toBe("price_bo");
  });

  it("returns undefined for an unset or empty value", () => {
    expect(getOveragePriceIdForTier("starter", () => undefined)).toBeUndefined();
    expect(getOveragePriceIdForTier("starter", () => "")).toBeUndefined();
  });
});

describe("getReportedOverageTokens", () => {
  it("returns 0 when no ledger row exists", async () => {
    mockInternalQuery.mockResolvedValueOnce([]);
    await expect(getReportedOverageTokens("org_1", PERIOD_START)).resolves.toBe(0);
    const [sql, params] = mockInternalQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("FROM overage_meter_reports");
    expect(sql).toContain("org_id = $1");
    expect(sql).toContain("period_start = $2");
    expect(params).toEqual(["org_1", PERIOD_START]);
  });

  it("coerces the pg BIGINT string back to a number", async () => {
    mockInternalQuery.mockResolvedValueOnce([{ reported_tokens: "12345" }]);
    await expect(getReportedOverageTokens("org_1", PERIOD_START)).resolves.toBe(12345);
  });

  it("THROWS on a present-but-uncoercible value (fail closed, never silently 0 → no double-bill)", async () => {
    mockInternalQuery.mockResolvedValueOnce([{ reported_tokens: "not-a-number" }]);
    // Returning 0 here would re-key the identifier on baseline 0 and re-report
    // the whole cumulative; throwing routes to the safe per-workspace skip+retry.
    await expect(getReportedOverageTokens("org_1", PERIOD_START)).rejects.toThrow();
  });

  it("no-ops to 0 without an internal DB", async () => {
    hasDb = false;
    await expect(getReportedOverageTokens("org_1", PERIOD_START)).resolves.toBe(0);
    expect(mockInternalQuery).not.toHaveBeenCalled();
  });
});

describe("recordOverageReport", () => {
  it("upserts the cumulative with GREATEST + composite-PK conflict", async () => {
    await recordOverageReport({
      orgId: "org_1",
      periodStartISO: PERIOD_START,
      stripeCustomerId: "cus_1",
      reportedTokens: 500,
      eventIdentifier: "id_1",
    });
    const [sql, params] = mockInternalQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("INSERT INTO overage_meter_reports");
    expect(sql).toContain("ON CONFLICT (org_id, period_start) DO UPDATE");
    // Monotonic: never regress the cumulative (would re-bill).
    expect(sql).toContain("GREATEST(overage_meter_reports.reported_tokens, EXCLUDED.reported_tokens)");
    expect(params).toEqual(["org_1", PERIOD_START, "cus_1", 500, "id_1"]);
  });

  it("no-ops without an internal DB", async () => {
    hasDb = false;
    await recordOverageReport({
      orgId: "org_1",
      periodStartISO: PERIOD_START,
      stripeCustomerId: "cus_1",
      reportedTokens: 500,
      eventIdentifier: "id_1",
    });
    expect(mockInternalQuery).not.toHaveBeenCalled();
  });
});

describe("reportWorkspaceOverage", () => {
  it("reports the period overage delta to the meter and advances the ledger", async () => {
    const { stripe, meterCreate } = makeMeterStripe();
    const { deps, recordCalls } = makeDeps({
      getCurrentPeriodUsage: async () => usageWith(STARTER_BUDGET + 500),
      getReportedOverageTokens: async () => 0,
    });

    await expect(reportWorkspaceOverage(stripe, starterRow(), NOW, deps)).resolves.toBe("reported");

    expect(meterCreate).toHaveBeenCalledTimes(1);
    const params = meterCreate.mock.calls[0][0] as {
      event_name: string;
      payload: { stripe_customer_id: string; value: string };
      identifier: string;
    };
    expect(params.event_name).toBe(OVERAGE_METER_EVENT_NAME);
    expect(params.payload.stripe_customer_id).toBe("cus_1");
    expect(params.payload.value).toBe("500"); // delta, as a string
    // Identifier is keyed on the BASELINE (reportedSoFar = 0 here), not the
    // new cumulative — so a crash-retry from the un-advanced ledger reuses it.
    expect(params.identifier).toBe(buildOverageEventIdentifier("org_1", PERIOD_START, 0));

    expect(recordCalls).toHaveLength(1);
    expect(recordCalls[0].reportedTokens).toBe(500); // cumulative, not delta
    // The recorded identifier MUST equal the one sent — the crash-window dedup
    // relies on the retry reproducing it.
    expect(recordCalls[0].eventIdentifier).toBe(params.identifier);
  });

  it("falls back to raw token count when the weighted field is absent", async () => {
    const { stripe, meterCreate } = makeMeterStripe();
    const { deps } = makeDeps({
      getCurrentPeriodUsage: async () => ({
        queryCount: 0,
        tokenCount: STARTER_BUDGET + 500,
        // weighted field absent (un-backfilled / future shape change)
        weightedTokenCount: undefined as unknown as number,
        costUsd: 0,
        activeUsers: 0,
        periodStart: PERIOD_START,
        periodEnd: "2026-07-01T00:00:00.000Z",
        periodSource: "utc-month",
      }),
      getReportedOverageTokens: async () => 0,
    });

    await expect(reportWorkspaceOverage(stripe, starterRow(), NOW, deps)).resolves.toBe("reported");
    const params = meterCreate.mock.calls[0][0] as { payload: { value: string } };
    expect(params.payload.value).toBe("500"); // billed on raw, not silently zero
  });

  it("reports only the DELTA past what's already reported, recording the new cumulative", async () => {
    const { stripe, meterCreate } = makeMeterStripe();
    const { deps, recordCalls } = makeDeps({
      getCurrentPeriodUsage: async () => usageWith(STARTER_BUDGET + 250),
      getReportedOverageTokens: async () => 100,
    });

    await expect(reportWorkspaceOverage(stripe, starterRow(), NOW, deps)).resolves.toBe("reported");

    const params = meterCreate.mock.calls[0][0] as { payload: { value: string }; identifier: string };
    expect(params.payload.value).toBe("150"); // 250 current − 100 reported
    expect(recordCalls[0].reportedTokens).toBe(250);
    // Identifier is keyed on the BASELINE (100), not the delta or the cumulative
    // — pins the baseline-keying for a non-zero baseline.
    expect(params.identifier).toBe(buildOverageEventIdentifier("org_1", PERIOD_START, 100));
  });

  it("is idempotent — the same overage reported twice bills once", async () => {
    const { stripe, meterCreate } = makeMeterStripe();
    // Second tick: the ledger already holds the full cumulative.
    const { deps } = makeDeps({
      getCurrentPeriodUsage: async () => usageWith(STARTER_BUDGET + 500),
      getReportedOverageTokens: async () => 500,
    });

    await expect(reportWorkspaceOverage(stripe, starterRow(), NOW, deps)).resolves.toBe("skipped");
    expect(meterCreate).not.toHaveBeenCalled();
  });

  it("reconciles a downward correction without a negative meter event", async () => {
    const { stripe, meterCreate } = makeMeterStripe();
    const { deps } = makeDeps({
      getCurrentPeriodUsage: async () => usageWith(STARTER_BUDGET + 300),
      getReportedOverageTokens: async () => 500, // ledger ahead of current
    });

    await expect(reportWorkspaceOverage(stripe, starterRow(), NOW, deps)).resolves.toBe("skipped");
    expect(meterCreate).not.toHaveBeenCalled();
  });

  it("never reports a BYOT workspace", async () => {
    const { stripe, meterCreate } = makeMeterStripe();
    const getSeatCount = mock(async () => 1);
    const { deps, recordCalls } = makeDeps({
      getSeatCount,
      getCurrentPeriodUsage: async () => usageWith(STARTER_BUDGET + 10_000),
      getReportedOverageTokens: async () => 0,
    });

    await expect(
      reportWorkspaceOverage(stripe, starterRow({ byot: true }), NOW, deps),
    ).resolves.toBe("skipped");
    expect(meterCreate).not.toHaveBeenCalled();
    expect(recordCalls).toHaveLength(0);
    // Bailed before doing any work.
    expect(getSeatCount).not.toHaveBeenCalled();
  });

  it("skips non-paid tiers (trial / free / locked)", async () => {
    const { stripe, meterCreate } = makeMeterStripe();
    const { deps } = makeDeps({
      getCurrentPeriodUsage: async () => usageWith(STARTER_BUDGET + 10_000),
    });
    for (const tier of ["trial", "free", "locked"]) {
      await expect(
        reportWorkspaceOverage(stripe, starterRow({ plan_tier: tier }), NOW, deps),
      ).resolves.toBe("skipped");
    }
    expect(meterCreate).not.toHaveBeenCalled();
  });

  it("skips a workspace with no Stripe customer id", async () => {
    const { stripe, meterCreate } = makeMeterStripe();
    const { deps } = makeDeps({
      getCurrentPeriodUsage: async () => usageWith(STARTER_BUDGET + 10_000),
    });
    await expect(
      reportWorkspaceOverage(stripe, starterRow({ stripe_customer_id: null }), NOW, deps),
    ).resolves.toBe("skipped");
    expect(meterCreate).not.toHaveBeenCalled();
  });

  it("skips when usage is within budget (no overage)", async () => {
    const { stripe, meterCreate } = makeMeterStripe();
    const { deps } = makeDeps({
      getCurrentPeriodUsage: async () => usageWith(STARTER_BUDGET - 1),
    });
    await expect(reportWorkspaceOverage(stripe, starterRow(), NOW, deps)).resolves.toBe("skipped");
    expect(meterCreate).not.toHaveBeenCalled();
  });

  it("does NOT advance the ledger when the meter report fails (report-before-record)", async () => {
    const { stripe, meterCreate } = makeMeterStripe(async () => {
      throw new Error("stripe 503");
    });
    const { deps, recordCalls } = makeDeps({
      getCurrentPeriodUsage: async () => usageWith(STARTER_BUDGET + 500),
      getReportedOverageTokens: async () => 0,
    });

    await expect(reportWorkspaceOverage(stripe, starterRow(), NOW, deps)).rejects.toThrow("stripe 503");
    expect(meterCreate).toHaveBeenCalledTimes(1);
    expect(recordCalls).toHaveLength(0); // ledger untouched → delta retried next tick
  });

  it("re-throws (so the tick retries) when Stripe billed but the ledger record fails", async () => {
    const { stripe, meterCreate } = makeMeterStripe(); // Stripe succeeds
    const { deps } = makeDeps({
      getCurrentPeriodUsage: async () => usageWith(STARTER_BUDGET + 500),
      getReportedOverageTokens: async () => 0,
      recordOverageReport: async () => {
        throw new Error("pg down");
      },
    });

    // Stripe was billed; the ledger lagged. Re-throw → sweep counts it failed +
    // retries. The baseline-keyed identifier (baseline 0, unchanged on the
    // un-advanced ledger) makes the retry dedupe-safe rather than a double-bill.
    await expect(reportWorkspaceOverage(stripe, starterRow(), NOW, deps)).rejects.toThrow("pg down");
    expect(meterCreate).toHaveBeenCalledTimes(1);
  });
});

describe("ensureOverageSubscriptionItem", () => {
  function subWith(items: Array<{ price: { id: string } }>): Stripe.Subscription {
    return { id: "sub_1", items: { data: items } } as unknown as Stripe.Subscription;
  }
  const deps = {
    resolveTier: (priceId: string) => (priceId === "price_seat_starter" ? "starter" : null),
    getOveragePriceId: () => "price_starter_overage",
  } as const;

  it("adds the tier's metered price as a second item when absent", async () => {
    const { stripe, itemCreate } = makeItemStripe();
    const out = await ensureOverageSubscriptionItem(
      subWith([{ price: { id: "price_seat_starter" } }]),
      stripe,
      deps,
    );
    expect(out).toBe("added");
    expect(itemCreate).toHaveBeenCalledWith({ subscription: "sub_1", price: "price_starter_overage" });
  });

  it("is a no-op when the metered item is already present (idempotent)", async () => {
    const { stripe, itemCreate } = makeItemStripe();
    const out = await ensureOverageSubscriptionItem(
      subWith([{ price: { id: "price_seat_starter" } }, { price: { id: "price_starter_overage" } }]),
      stripe,
      deps,
    );
    expect(out).toBe("present");
    expect(itemCreate).not.toHaveBeenCalled();
  });

  it("skips a non-paid / unrecognized first item", async () => {
    const { stripe, itemCreate } = makeItemStripe();
    const out = await ensureOverageSubscriptionItem(
      subWith([{ price: { id: "price_unknown" } }]),
      stripe,
      deps,
    );
    expect(out).toBe("skipped");
    expect(itemCreate).not.toHaveBeenCalled();
  });

  it("skips when no overage price is configured for the tier", async () => {
    const { stripe, itemCreate } = makeItemStripe();
    const out = await ensureOverageSubscriptionItem(
      subWith([{ price: { id: "price_seat_starter" } }]),
      stripe,
      { ...deps, getOveragePriceId: () => undefined },
    );
    expect(out).toBe("skipped");
    expect(itemCreate).not.toHaveBeenCalled();
  });

  it("is best-effort — a Stripe failure is swallowed (never throws into the durable sync)", async () => {
    const { stripe } = makeItemStripe(async () => {
      throw new Error("stripe 500");
    });
    const out = await ensureOverageSubscriptionItem(
      subWith([{ price: { id: "price_seat_starter" } }]),
      stripe,
      deps,
    );
    expect(out).toBe("skipped");
  });
});

describe("reportPeriodOverages", () => {
  it("no-ops without an internal DB", async () => {
    hasDb = false;
    await expect(reportPeriodOverages(NOW)).resolves.toEqual({
      scanned: 0,
      reported: 0,
      skipped: 0,
      failed: 0,
    });
  });

  it("no-ops when Stripe is not configured", async () => {
    hasDb = true;
    stripeForSweep = null;
    await expect(reportPeriodOverages(NOW)).resolves.toEqual({
      scanned: 0,
      reported: 0,
      skipped: 0,
      failed: 0,
    });
  });

  it("scans only paid, non-BYOT, subscribed workspaces with a Stripe customer", async () => {
    stripeForSweep = makeMeterStripe().stripe;
    mockInternalQuery.mockResolvedValueOnce([]); // scan returns nothing
    await reportPeriodOverages(NOW, async () => "skipped");
    const [sql] = mockInternalQuery.mock.calls[0] as [string];
    expect(sql).toContain("plan_tier IN ('starter', 'pro', 'business')");
    expect(sql).toContain("byot IS NOT TRUE");
    expect(sql).toContain('"stripeCustomerId" IS NOT NULL');
    expect(sql).toContain("FROM subscription s");
    expect(sql).toContain("s.status = 'active'");
  });

  it("fans out to the per-workspace reporter and tallies outcomes", async () => {
    stripeForSweep = makeMeterStripe().stripe;
    mockInternalQuery.mockResolvedValueOnce([
      starterRow({ org_id: "org_a" }),
      starterRow({ org_id: "org_b" }),
      starterRow({ org_id: "org_c" }),
    ]);
    const seen: string[] = [];
    const reportOne = mock(async (_s: Stripe, row: OverageWorkspaceRow) => {
      seen.push(row.org_id);
      if (row.org_id === "org_a") return "reported" as const;
      if (row.org_id === "org_b") throw new Error("boom");
      return "skipped" as const;
    });

    const result = await reportPeriodOverages(NOW, reportOne);
    expect(seen).toEqual(["org_a", "org_b", "org_c"]);
    expect(result).toEqual({ scanned: 3, reported: 1, skipped: 1, failed: 1 });
  });
});

describe("constants", () => {
  it("uses the configured Stripe meter event name", () => {
    expect(OVERAGE_METER_EVENT_NAME).toBe("atlas_token_overage");
  });

  it("ticks on a positive interval", () => {
    expect(OVERAGE_REPORT_INTERVAL_MS).toBeGreaterThan(0);
  });
});

// ── helpers ────────────────────────────────────────────────────────────
function usageWith(weighted: number): import("@atlas/api/lib/metering").UsageCurrentPeriod {
  return {
    queryCount: 0,
    tokenCount: weighted,
    weightedTokenCount: weighted,
    costUsd: 0,
    activeUsers: 0,
    periodStart: PERIOD_START,
    periodEnd: "2026-07-01T00:00:00.000Z",
    periodSource: "utc-month",
  };
}
