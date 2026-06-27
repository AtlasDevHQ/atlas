/**
 * Unit tests for the OverageMeter reporter (#3992; at-cost cents repoint #4039).
 *
 * Covers the acceptance criteria at the module boundary:
 *   - period overage reported idempotently + reconcilably (ledger-backed):
 *     the same delta reported twice bills once;
 *   - overage is denominated in at-cost CENTS (dollars → cents), not tokens;
 *   - OBS-1: the `meter_event` identifier is bounded ≤100 chars via a hash of
 *     `(orgId|period|baseline)`, retaining the baseline-keyed crash-window dedup;
 *   - the metered item is added as a second subscription item per tier;
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
import type { UsageCurrentPeriod } from "@atlas/api/lib/metering";

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

// ── Quiet logger (error captured so the cost-basis-gap alert is assertable) ──
const errorCalls: unknown[][] = [];
const stubLogger = {
  info: () => {},
  warn: () => {},
  error: (...args: unknown[]) => {
    errorCalls.push(args);
  },
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
  dollarsToCents,
  computeReportableDelta,
  buildOverageEventIdentifier,
  getReportedOverageCents,
  recordOverageReport,
  reportWorkspaceOverage,
  reportPeriodOverages,
  ensureOverageSubscriptionItem,
} = await import("../overage-meter");

const NOW = new Date("2026-06-15T12:00:00.000Z");
const PERIOD_START = "2026-06-01T00:00:00.000Z";

// computeUsageDollarBudget("starter", 1) = $20/seat × 1 seat (plans.ts).
const STARTER_CREDIT_USD = 20;

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
    getCurrentPeriodUsage: async () => usageWithCost(0),
    getReportedOverageCents: async () => 0,
    recordOverageReport: async (r) => {
      recordCalls.push(r);
    },
    ...overrides,
  };
  return { deps, recordCalls };
}

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
  errorCalls.length = 0;
  mockInternalQuery.mockReset();
  mockInternalQuery.mockImplementation(() => Promise.resolve([]));
});

/** Did the cost-basis-gap `log.error` (reason `cost_basis_missing`) fire? */
function sawCostBasisAlert(): boolean {
  return errorCalls.some(
    (args) =>
      typeof args[0] === "object" &&
      args[0] !== null &&
      (args[0] as Record<string, unknown>).reason === "cost_basis_missing",
  );
}

// ───────────────────────────────────────────────────────────────────────
describe("dollarsToCents", () => {
  it("rounds at-cost dollars to the nearest whole cent", () => {
    expect(dollarsToCents(5)).toBe(500);
    expect(dollarsToCents(2.5)).toBe(250);
    expect(dollarsToCents(12.347)).toBe(1235); // rounded
    expect(dollarsToCents(0.004)).toBe(0); // sub-half-cent rounds down
  });

  it("is 0 for non-positive or non-finite input (never a negative quantity)", () => {
    expect(dollarsToCents(0)).toBe(0);
    expect(dollarsToCents(-3)).toBe(0);
    expect(dollarsToCents(Number.NaN)).toBe(0);
    expect(dollarsToCents(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

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

describe("buildOverageEventIdentifier (OBS-1)", () => {
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
    expect(buildOverageEventIdentifier("org_1", PERIOD_START, 500)).not.toBe(
      buildOverageEventIdentifier("org_2", PERIOD_START, 500),
    );
    expect(buildOverageEventIdentifier("org_1", PERIOD_START, 500)).not.toBe(
      buildOverageEventIdentifier("org_1", "2026-07-01T00:00:00.000Z", 500),
    );
  });

  it("is bounded ≤100 chars regardless of org-id length (the OBS-1 fix)", () => {
    // Better-Auth org ids are unbounded TEXT; the old raw spelling overflowed
    // Stripe's 100-char identifier cap for a long id, stranding that org's
    // overage. The hash makes the identifier fixed-width.
    const longOrg = "org_" + "a".repeat(512);
    const id = buildOverageEventIdentifier(longOrg, PERIOD_START, 123456789);
    expect(id.length).toBeLessThanOrEqual(100);
    // Hashed — the raw (overflowing) org id is NOT embedded verbatim.
    expect(id).not.toContain(longOrg);
    expect(id.startsWith("atlas-overage-")).toBe(true);
    // Still deterministic for the long id (dedup intact).
    expect(id).toBe(buildOverageEventIdentifier(longOrg, PERIOD_START, 123456789));
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

describe("getReportedOverageCents", () => {
  it("returns 0 when no ledger row exists", async () => {
    mockInternalQuery.mockResolvedValueOnce([]);
    await expect(getReportedOverageCents("org_1", PERIOD_START)).resolves.toBe(0);
    const [sql, params] = mockInternalQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("reported_cost_cents");
    expect(sql).toContain("FROM overage_meter_reports");
    expect(sql).toContain("org_id = $1");
    expect(sql).toContain("period_start = $2");
    expect(params).toEqual(["org_1", PERIOD_START]);
  });

  it("coerces the pg BIGINT string back to a number", async () => {
    mockInternalQuery.mockResolvedValueOnce([{ reported_cost_cents: "12345" }]);
    await expect(getReportedOverageCents("org_1", PERIOD_START)).resolves.toBe(12345);
  });

  it("THROWS on a present-but-uncoercible value (fail closed, never silently 0 → no double-bill)", async () => {
    mockInternalQuery.mockResolvedValueOnce([{ reported_cost_cents: "not-a-number" }]);
    // Returning 0 here would re-key the identifier on baseline 0 and re-report
    // the whole cumulative; throwing routes to the safe per-workspace skip+retry.
    await expect(getReportedOverageCents("org_1", PERIOD_START)).rejects.toThrow();
  });

  it("no-ops to 0 without an internal DB", async () => {
    hasDb = false;
    await expect(getReportedOverageCents("org_1", PERIOD_START)).resolves.toBe(0);
    expect(mockInternalQuery).not.toHaveBeenCalled();
  });
});

describe("recordOverageReport", () => {
  it("upserts the cumulative cents with GREATEST + composite-PK conflict", async () => {
    await recordOverageReport({
      orgId: "org_1",
      periodStartISO: PERIOD_START,
      stripeCustomerId: "cus_1",
      reportedCents: 500,
      eventIdentifier: "id_1",
    });
    const [sql, params] = mockInternalQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("INSERT INTO overage_meter_reports");
    expect(sql).toContain("reported_cost_cents");
    expect(sql).toContain("ON CONFLICT (org_id, period_start) DO UPDATE");
    // Monotonic: never regress the cumulative (would re-bill).
    expect(sql).toContain(
      "GREATEST(overage_meter_reports.reported_cost_cents, EXCLUDED.reported_cost_cents)",
    );
    expect(params).toEqual(["org_1", PERIOD_START, "cus_1", 500, "id_1"]);
  });

  it("no-ops without an internal DB", async () => {
    hasDb = false;
    await recordOverageReport({
      orgId: "org_1",
      periodStartISO: PERIOD_START,
      stripeCustomerId: "cus_1",
      reportedCents: 500,
      eventIdentifier: "id_1",
    });
    expect(mockInternalQuery).not.toHaveBeenCalled();
  });
});

describe("reportWorkspaceOverage", () => {
  it("reports the at-cost overage delta in CENTS and advances the ledger", async () => {
    const { stripe, meterCreate } = makeMeterStripe();
    const { deps, recordCalls } = makeDeps({
      // $5 over the $20 credit → 500 cents of overage.
      getCurrentPeriodUsage: async () => usageWithCost(STARTER_CREDIT_USD + 5),
      getReportedOverageCents: async () => 0,
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
    expect(params.payload.value).toBe("500"); // delta cents, as a string
    // Identifier is keyed on the BASELINE (reportedSoFar = 0 here), not the
    // new cumulative — so a crash-retry from the un-advanced ledger reuses it.
    expect(params.identifier).toBe(buildOverageEventIdentifier("org_1", PERIOD_START, 0));

    expect(recordCalls).toHaveLength(1);
    expect(recordCalls[0].reportedCents).toBe(500); // cumulative cents, not delta
    // The recorded identifier MUST equal the one sent — the crash-window dedup
    // relies on the retry reproducing it.
    expect(recordCalls[0].eventIdentifier).toBe(params.identifier);
  });

  it("rounds fractional at-cost dollars to whole cents", async () => {
    const { stripe, meterCreate } = makeMeterStripe();
    const { deps } = makeDeps({
      // $2.347 over credit → 234.7¢ → 235¢ (nearest cent).
      getCurrentPeriodUsage: async () => usageWithCost(STARTER_CREDIT_USD + 2.347),
      getReportedOverageCents: async () => 0,
    });
    await expect(reportWorkspaceOverage(stripe, starterRow(), NOW, deps)).resolves.toBe("reported");
    const params = meterCreate.mock.calls[0][0] as { payload: { value: string } };
    expect(params.payload.value).toBe("235");
  });

  it("skips a $0 at-cost basis with a LOUD operator alert when tokens were recorded (safe but visible under-bill)", async () => {
    const { stripe, meterCreate } = makeMeterStripe();
    const { deps } = makeDeps({
      getCurrentPeriodUsage: async () => ({
        queryCount: 0,
        tokenCount: 5_000_000, // tokens recorded…
        weightedTokenCount: 5_000_000,
        costUsd: 0, // …but no at-cost basis (non-gateway / pre-#4036 / broken capture)
        activeUsers: 0,
        periodStart: PERIOD_START,
        periodEnd: "2026-07-01T00:00:00.000Z",
        periodSource: "utc-month",
      }),
      getReportedOverageCents: async () => 0,
    });
    await expect(reportWorkspaceOverage(stripe, starterRow(), NOW, deps)).resolves.toBe("skipped");
    expect(meterCreate).not.toHaveBeenCalled();
    // A silent skip here would let a fleet-wide capture regression zero overage
    // revenue unnoticed — mirror enforcement.ts's cost-basis-gap alert (#4038).
    expect(sawCostBasisAlert()).toBe(true);
  });

  it("does NOT fire the cost-basis alert on a legitimately-under-credit skip", async () => {
    const { stripe } = makeMeterStripe();
    const { deps } = makeDeps({
      // Real at-cost basis, simply under the credit — a normal quiet skip.
      getCurrentPeriodUsage: async () => usageWithCost(STARTER_CREDIT_USD - 1),
    });
    await expect(reportWorkspaceOverage(stripe, starterRow(), NOW, deps)).resolves.toBe("skipped");
    expect(sawCostBasisAlert()).toBe(false);
  });

  it("reuses the baseline-keyed identifier across ticks when the ledger hasn't advanced (crash-window dedup)", async () => {
    // Models the prod hazard: tick 1 bills Stripe but crashes before the ledger
    // records, so the baseline stays 0; tick 2 sees HIGHER usage. The identifier
    // must stay keyed on the unchanged baseline (0) so Stripe dedupes the overlap
    // (keeps tick 1's value) instead of double-billing the grown amount.
    const { stripe, meterCreate } = makeMeterStripe();
    let costUsd = STARTER_CREDIT_USD + 5; // 500 cents
    const { deps } = makeDeps({
      getCurrentPeriodUsage: async () => usageWithCost(costUsd),
      getReportedOverageCents: async () => 0, // ledger never advanced (crash before record)
    });

    await reportWorkspaceOverage(stripe, starterRow(), NOW, deps);
    costUsd = STARTER_CREDIT_USD + 9; // usage grew to 900 cents before the retry
    await reportWorkspaceOverage(stripe, starterRow(), NOW, deps);

    const id1 = (meterCreate.mock.calls[0][0] as { identifier: string }).identifier;
    const id2 = (meterCreate.mock.calls[1][0] as { identifier: string }).identifier;
    expect(id2).toBe(id1); // same baseline (0) → same identifier → Stripe dedupes
    expect(id1).toBe(buildOverageEventIdentifier("org_1", PERIOD_START, 0));
  });

  it("reports only the DELTA past what's already reported, recording the new cumulative", async () => {
    const { stripe, meterCreate } = makeMeterStripe();
    const { deps, recordCalls } = makeDeps({
      // $2.50 over credit → 250 cents current overage.
      getCurrentPeriodUsage: async () => usageWithCost(STARTER_CREDIT_USD + 2.5),
      getReportedOverageCents: async () => 100,
    });

    await expect(reportWorkspaceOverage(stripe, starterRow(), NOW, deps)).resolves.toBe("reported");

    const params = meterCreate.mock.calls[0][0] as { payload: { value: string }; identifier: string };
    expect(params.payload.value).toBe("150"); // 250 current − 100 reported
    expect(recordCalls[0].reportedCents).toBe(250);
    // Identifier is keyed on the BASELINE (100), not the delta or the cumulative
    // — pins the baseline-keying for a non-zero baseline.
    expect(params.identifier).toBe(buildOverageEventIdentifier("org_1", PERIOD_START, 100));
  });

  it("is idempotent — the same overage reported twice bills once", async () => {
    const { stripe, meterCreate } = makeMeterStripe();
    // Second tick: the ledger already holds the full cumulative (500 cents).
    const { deps } = makeDeps({
      getCurrentPeriodUsage: async () => usageWithCost(STARTER_CREDIT_USD + 5),
      getReportedOverageCents: async () => 500,
    });

    await expect(reportWorkspaceOverage(stripe, starterRow(), NOW, deps)).resolves.toBe("skipped");
    expect(meterCreate).not.toHaveBeenCalled();
  });

  it("reconciles a downward correction without a negative meter event", async () => {
    const { stripe, meterCreate } = makeMeterStripe();
    const { deps } = makeDeps({
      getCurrentPeriodUsage: async () => usageWithCost(STARTER_CREDIT_USD + 3), // 300 cents
      getReportedOverageCents: async () => 500, // ledger ahead of current
    });

    await expect(reportWorkspaceOverage(stripe, starterRow(), NOW, deps)).resolves.toBe("skipped");
    expect(meterCreate).not.toHaveBeenCalled();
  });

  it("never reports a BYOT workspace", async () => {
    const { stripe, meterCreate } = makeMeterStripe();
    const getSeatCount = mock(async () => 1);
    const { deps, recordCalls } = makeDeps({
      getSeatCount,
      getCurrentPeriodUsage: async () => usageWithCost(STARTER_CREDIT_USD + 100),
      getReportedOverageCents: async () => 0,
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
      getCurrentPeriodUsage: async () => usageWithCost(STARTER_CREDIT_USD + 100),
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
      getCurrentPeriodUsage: async () => usageWithCost(STARTER_CREDIT_USD + 100),
    });
    await expect(
      reportWorkspaceOverage(stripe, starterRow({ stripe_customer_id: null }), NOW, deps),
    ).resolves.toBe("skipped");
    expect(meterCreate).not.toHaveBeenCalled();
  });

  it("skips when usage is within the credit (no overage)", async () => {
    const { stripe, meterCreate } = makeMeterStripe();
    const { deps } = makeDeps({
      getCurrentPeriodUsage: async () => usageWithCost(STARTER_CREDIT_USD - 1),
    });
    await expect(reportWorkspaceOverage(stripe, starterRow(), NOW, deps)).resolves.toBe("skipped");
    expect(meterCreate).not.toHaveBeenCalled();
  });

  it("does NOT advance the ledger when the meter report fails (report-before-record)", async () => {
    const { stripe, meterCreate } = makeMeterStripe(async () => {
      throw new Error("stripe 503");
    });
    const { deps, recordCalls } = makeDeps({
      getCurrentPeriodUsage: async () => usageWithCost(STARTER_CREDIT_USD + 5),
      getReportedOverageCents: async () => 0,
    });

    await expect(reportWorkspaceOverage(stripe, starterRow(), NOW, deps)).rejects.toThrow("stripe 503");
    expect(meterCreate).toHaveBeenCalledTimes(1);
    expect(recordCalls).toHaveLength(0); // ledger untouched → delta retried next tick
  });

  it("re-throws (so the tick retries) when Stripe billed but the ledger record fails", async () => {
    const { stripe, meterCreate } = makeMeterStripe(); // Stripe succeeds
    const { deps } = makeDeps({
      getCurrentPeriodUsage: async () => usageWithCost(STARTER_CREDIT_USD + 5),
      getReportedOverageCents: async () => 0,
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
  it("uses the at-cost cents Stripe meter event name (distinct from the token meter)", () => {
    expect(OVERAGE_METER_EVENT_NAME).toBe("atlas_usage_overage_cents");
  });

  it("ticks on a positive interval", () => {
    expect(OVERAGE_REPORT_INTERVAL_MS).toBeGreaterThan(0);
  });
});

// ── helpers ────────────────────────────────────────────────────────────
function usageWithCost(costUsd: number): UsageCurrentPeriod {
  return {
    queryCount: 0,
    tokenCount: 0,
    weightedTokenCount: 0,
    costUsd,
    activeUsers: 0,
    periodStart: PERIOD_START,
    periodEnd: "2026-07-01T00:00:00.000Z",
    periodSource: "utc-month",
  };
}
