/**
 * Tests for usage metering helpers.
 *
 * Covers: logUsageEvent, aggregateUsageSummary, getCurrentPeriodUsage,
 * getUsageHistory, getUsageBreakdown.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  mock,
} from "bun:test";

// --- Internal DB mock ---

let mockHasInternalDB = true;
let mockQueryShouldThrow = false;
let queryCalls: Array<{ sql: string; params?: unknown[] }> = [];
let queryResults: unknown[] = [];
/** Drives the {@link isInternalCircuitOpen} mock — when true, the
 *  fire-and-forget drop path is exercised (#3428). */
let mockCircuitOpen = false;
/** Structured `log.error` calls captured for the #3428 drop-alert assertions. */
let errorLogs: Array<{ ctx: unknown; msg: unknown }> = [];

const mockPool = {
  query: mock((sql: string, params?: unknown[]) => {
    queryCalls.push({ sql, params });
    const result = queryResults.shift();
    return Promise.resolve({ rows: result ?? [] });
  }),
  end: mock(() => Promise.resolve()),
  on: mock(() => {}),
};

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => mockHasInternalDB,
  internalExecute: (sql: string, params?: unknown[]) => {
    queryCalls.push({ sql, params });
  },
  internalQuery: async (sql: string, params?: unknown[]) => {
    if (mockQueryShouldThrow) throw new Error("connection refused");
    queryCalls.push({ sql, params });
    const result = queryResults.shift();
    return result ?? [];
  },
  isInternalCircuitOpen: () => mockCircuitOpen,
  getInternalDB: () => mockPool,
  _resetPool: () => {},
  _resetCircuitBreaker: () => {},
  setWorkspaceRegion: mock(async () => {}),
  insertSemanticAmendment: mock(async () => "mock-amendment-id"),
  getPendingAmendmentCount: mock(async () => 0),
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

// --- Now import the module under test ---
//
// Loaded via a dynamic import in `beforeAll` (not a top-level static import) so
// the module evaluates AFTER the `mock.module` calls above are registered. This
// matters for the #3428 drop-alert assertions: metering.ts captures its logger
// once at module scope (`const log = createLogger("metering")`), and a top-level
// static import would evaluate that line against the REAL logger before the
// mock applied, leaving `errorLogs` empty. Resolving the module at call time
// binds `log` to the captured logger above so the alert is observable.

let logUsageEvent: typeof import("@atlas/api/lib/metering").logUsageEvent;
let aggregateUsageSummary: typeof import("@atlas/api/lib/metering").aggregateUsageSummary;
let getCurrentPeriodUsage: typeof import("@atlas/api/lib/metering").getCurrentPeriodUsage;
let getUsageHistory: typeof import("@atlas/api/lib/metering").getUsageHistory;
let getUsageBreakdown: typeof import("@atlas/api/lib/metering").getUsageBreakdown;

describe("metering", () => {
  beforeAll(async () => {
    ({
      logUsageEvent,
      aggregateUsageSummary,
      getCurrentPeriodUsage,
      getUsageHistory,
      getUsageBreakdown,
    } = await import("@atlas/api/lib/metering"));
  });

  beforeEach(() => {
    queryCalls = [];
    queryResults = [];
    mockHasInternalDB = true;
    mockQueryShouldThrow = false;
    mockCircuitOpen = false;
    errorLogs = [];
  });

  describe("logUsageEvent", () => {
    it("inserts a usage event with correct parameters", () => {
      logUsageEvent({
        workspaceId: "org-1",
        userId: "user-1",
        eventType: "query",
        quantity: 1,
        metadata: { model: "gpt-4" },
      });

      expect(queryCalls).toHaveLength(1);
      expect(queryCalls[0].sql).toContain("INSERT INTO usage_events");
      expect(queryCalls[0].params).toEqual([
        "org-1",
        "user-1",
        "query",
        1,
        null, // weighted_quantity — omitted for a non-token event
        null, // gateway_cost_usd — omitted for a non-token event (#4036)
        JSON.stringify({ model: "gpt-4" }),
      ]);
    });

    it("handles null workspace and metadata", () => {
      logUsageEvent({
        workspaceId: null,
        userId: null,
        eventType: "token",
        quantity: 500,
      });

      expect(queryCalls).toHaveLength(1);
      expect(queryCalls[0].params).toEqual([null, null, "token", 500, null, null, null]);
    });

    it("persists the weighted (output-equivalent) quantity for a token event (#3989)", () => {
      logUsageEvent({
        workspaceId: "org-1",
        userId: "user-1",
        eventType: "token",
        quantity: 1500,
        weightedQuantity: 4200,
        metadata: { input: 500, output: 1000, weighted: 4200 },
      });

      expect(queryCalls).toHaveLength(1);
      expect(queryCalls[0].sql).toContain("weighted_quantity");
      expect(queryCalls[0].params).toEqual([
        "org-1",
        "user-1",
        "token",
        1500,
        4200,
        null, // gateway_cost_usd — not supplied here
        JSON.stringify({ input: 500, output: 1000, weighted: 4200 }),
      ]);
    });

    it("persists the at-cost gateway dollars for a token event (#4036)", () => {
      logUsageEvent({
        workspaceId: "org-1",
        userId: "user-1",
        eventType: "token",
        quantity: 1500,
        weightedQuantity: 4200,
        gatewayCostUsd: 0.2345,
        metadata: { input: 500, output: 1000, weighted: 4200 },
      });

      expect(queryCalls).toHaveLength(1);
      expect(queryCalls[0].sql).toContain("gateway_cost_usd");
      expect(queryCalls[0].params).toEqual([
        "org-1",
        "user-1",
        "token",
        1500,
        4200,
        0.2345,
        JSON.stringify({ input: 500, output: 1000, weighted: 4200 }),
      ]);
    });

    it("is a no-op when internal DB is not configured", () => {
      mockHasInternalDB = false;
      logUsageEvent({
        workspaceId: "org-1",
        userId: "user-1",
        eventType: "query",
        quantity: 1,
      });

      expect(queryCalls).toHaveLength(0);
    });

    // ── Dropped-event operator alert (#3428) ──────────────────────────
    // When the internal-DB circuit breaker is open the row is about to be
    // dropped by internalExecute and lost for good (no replay in v1). The
    // triage decision (2026-06-12) keeps the fail-open but requires the drop
    // to be OPERATOR-VISIBLE: a loud structured `log.error` per dropped event
    // carrying workspace/user/event context to scope the permanent under-count.

    it("emits a structured drop alert when the circuit breaker is open", () => {
      mockCircuitOpen = true;

      logUsageEvent({
        workspaceId: "org-1",
        userId: "user-1",
        eventType: "token",
        quantity: 1234,
      });

      // Still delegates to internalExecute so the drop counter advances and
      // recovery is re-triggered — the event isn't withheld, it's surfaced.
      expect(queryCalls).toHaveLength(1);
      expect(queryCalls[0].sql).toContain("INSERT INTO usage_events");

      // The alert fired with enough context for an operator to act on.
      expect(errorLogs).toHaveLength(1);
      const { ctx, msg } = errorLogs[0];
      expect(ctx).toMatchObject({
        workspaceId: "org-1",
        userId: "user-1",
        eventType: "token",
        quantity: 1234,
        reason: "circuit_open",
      });
      expect(String(msg)).toContain("#3428");
      expect(String(msg)).toContain("under-counted");
    });

    it("does NOT emit a drop alert when the circuit breaker is closed", () => {
      mockCircuitOpen = false;

      logUsageEvent({
        workspaceId: "org-1",
        userId: "user-1",
        eventType: "query",
        quantity: 1,
      });

      expect(queryCalls).toHaveLength(1);
      expect(errorLogs).toHaveLength(0);
    });
  });

  describe("getCurrentPeriodUsage", () => {
    // #3431: getCurrentPeriodUsage now issues TWO queries — first the
    // active-subscription period lookup (billing/period.ts), then the
    // usage aggregate. The first queryResults entry feeds the subscription
    // lookup; an empty array there means "no active subscription → UTC
    // calendar-month fallback".
    it("returns current period aggregates (UTC-month fallback, no subscription)", async () => {
      queryResults = [
        [], // no active subscription row → UTC month
        [{ query_count: 42, token_count: 10000, weighted_token_count: 23000, cost_usd: 1.23, active_users: 3 }],
      ];

      const result = await getCurrentPeriodUsage("org-1");

      expect(result.queryCount).toBe(42);
      expect(result.tokenCount).toBe(10000);
      // Output-equivalent (model-weighted) token spend — the budget denominator (#3989).
      expect(result.weightedTokenCount).toBe(23000);
      // At-cost provider dollars for the period — the Structure B denominator (#4036).
      expect(result.costUsd).toBe(1.23);
      expect(result.activeUsers).toBe(3);
      expect(result.periodStart).toBeTruthy();
      expect(result.periodEnd).toBeTruthy();
      expect(result.periodSource).toBe("utc-month");

      // The aggregate sums the weighted column with a COALESCE fallback to raw
      // so token rows predating migration 0152 still contribute.
      const usageCall = queryCalls.find((c) => c.sql.includes("usage_events"));
      expect(usageCall?.sql).toContain("COALESCE(weighted_quantity, quantity)");
      // …and sums the at-cost gateway dollars for the period (#4036).
      expect(usageCall?.sql).toContain("gateway_cost_usd");
    });

    it("anchors on the Stripe period when an active subscription exists", async () => {
      const start = "2026-05-25T00:00:00.000Z";
      const end = "2026-06-25T00:00:00.000Z";
      queryResults = [
        [{ periodStart: start, periodEnd: end }], // active subscription
        [{ query_count: 7, token_count: 700, active_users: 1 }],
      ];

      const result = await getCurrentPeriodUsage(
        "org-sub",
        new Date("2026-06-10T12:00:00.000Z"),
      );

      expect(result.periodSource).toBe("stripe");
      expect(result.periodStart).toBe(start);
      expect(result.periodEnd).toBe(end);
      // The usage aggregate must be windowed on the Stripe bounds.
      const usageCall = queryCalls.find((c) => c.sql.includes("usage_events"));
      expect(usageCall?.params).toEqual(["org-sub", start, end]);
    });

    it("returns zeros when no data", async () => {
      queryResults = [
        [], // no active subscription
        [{ query_count: 0, token_count: 0, weighted_token_count: 0, active_users: 0 }],
      ];

      const result = await getCurrentPeriodUsage("org-empty");

      expect(result.queryCount).toBe(0);
      expect(result.tokenCount).toBe(0);
      expect(result.weightedTokenCount).toBe(0);
      expect(result.activeUsers).toBe(0);
    });

    it("returns zeros when internal DB is not configured", async () => {
      mockHasInternalDB = false;
      const result = await getCurrentPeriodUsage("org-1");
      expect(result.queryCount).toBe(0);
      expect(result.weightedTokenCount).toBe(0);
      expect(result.periodSource).toBe("utc-month");
      expect(queryCalls).toHaveLength(0);
    });

    it("returns zeros when query returns empty result set", async () => {
      queryResults = [
        [], // no active subscription
        [], // empty aggregate — rows[0] is undefined
      ];

      const result = await getCurrentPeriodUsage("org-1");

      expect(result.queryCount).toBe(0);
      expect(result.tokenCount).toBe(0);
      expect(result.activeUsers).toBe(0);
      expect(result.periodStart).toBeTruthy();
      expect(result.periodEnd).toBeTruthy();
    });
  });

  describe("getUsageHistory", () => {
    it("queries with period and workspace", async () => {
      queryResults = [[
        { id: "s-1", workspace_id: "org-1", period: "monthly", period_start: "2026-02-01", query_count: 100, token_count: 5000, active_users: 5, storage_bytes: 0 },
      ]];

      const result = await getUsageHistory("org-1", "monthly");

      expect(result).toHaveLength(1);
      expect(queryCalls[0].sql).toContain("usage_summaries");
      expect(queryCalls[0].params?.[0]).toBe("org-1");
      expect(queryCalls[0].params?.[1]).toBe("monthly");
    });

    it("applies date filters when provided", async () => {
      queryResults = [[]];

      await getUsageHistory("org-1", "daily", "2026-01-01", "2026-03-01");

      const call = queryCalls[0];
      expect(call.sql).toContain("period_start >=");
      expect(call.sql).toContain("period_start <=");
      expect(call.params).toContain("2026-01-01");
      expect(call.params).toContain("2026-03-01");
    });

    it("returns empty when internal DB is not configured", async () => {
      mockHasInternalDB = false;
      const result = await getUsageHistory("org-1", "monthly");
      expect(result).toEqual([]);
    });

    it("passes custom limit as last SQL parameter", async () => {
      queryResults = [[]];

      await getUsageHistory("org-1", "daily", undefined, undefined, 10);

      const call = queryCalls[0];
      const params = call.params as unknown[];
      expect(params[params.length - 1]).toBe(10);
    });
  });

  describe("getUsageBreakdown", () => {
    it("returns per-user breakdown", async () => {
      queryResults = [[
        { user_id: "u-1", query_count: 50, token_count: 2000, login_count: 5 },
        { user_id: "u-2", query_count: 30, token_count: 1000, login_count: 3 },
      ]];

      const result = await getUsageBreakdown("org-1");

      expect(result).toHaveLength(2);
      expect(result[0].user_id).toBe("u-1");
      expect(result[0].query_count).toBe(50);
    });

    it("applies date filters", async () => {
      queryResults = [[]];

      await getUsageBreakdown("org-1", "2026-01-01", "2026-03-01");

      const call = queryCalls[0];
      expect(call.sql).toContain("created_at >=");
      expect(call.sql).toContain("created_at <=");
    });

    it("returns empty when internal DB is not configured", async () => {
      mockHasInternalDB = false;
      const result = await getUsageBreakdown("org-1");
      expect(result).toEqual([]);
    });
  });

  describe("aggregateUsageSummary", () => {
    it("executes upsert with correct parameters", async () => {
      queryResults = [[]];
      const periodStart = new Date("2026-03-01T00:00:00Z");

      await aggregateUsageSummary("org-1", "monthly", periodStart);

      expect(queryCalls).toHaveLength(1);
      const call = queryCalls[0];
      expect(call.sql).toContain("INSERT INTO usage_summaries");
      expect(call.sql).toContain("ON CONFLICT");
      expect(call.params?.[0]).toBe("org-1");
      expect(call.params?.[1]).toBe("monthly");
    });

    it("is a no-op when internal DB is not configured", async () => {
      mockHasInternalDB = false;
      await aggregateUsageSummary("org-1", "daily", new Date());
      expect(queryCalls).toHaveLength(0);
    });

    it("swallows errors without rethrowing", async () => {
      mockQueryShouldThrow = true;

      // Should not throw despite the error
      await expect(aggregateUsageSummary("org-1", "daily", new Date())).resolves.toBeUndefined();
    });
  });
});
