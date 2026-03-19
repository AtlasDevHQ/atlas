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
  beforeEach,
  mock,
} from "bun:test";

// --- Internal DB mock ---

let mockHasInternalDB = true;
let mockQueryShouldThrow = false;
let queryCalls: Array<{ sql: string; params?: unknown[] }> = [];
let queryResults: unknown[] = [];

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
  getInternalDB: () => mockPool,
  _resetPool: () => {},
  _resetCircuitBreaker: () => {},
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

// --- Now import the module under test ---

import {
  logUsageEvent,
  aggregateUsageSummary,
  getCurrentPeriodUsage,
  getUsageHistory,
  getUsageBreakdown,
} from "@atlas/api/lib/metering";

describe("metering", () => {
  beforeEach(() => {
    queryCalls = [];
    queryResults = [];
    mockHasInternalDB = true;
    mockQueryShouldThrow = false;
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
      expect(queryCalls[0].params).toEqual([null, null, "token", 500, null]);
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
  });

  describe("getCurrentPeriodUsage", () => {
    it("returns current period aggregates", async () => {
      queryResults = [
        [{ query_count: 42, token_count: 10000, active_users: 3 }],
      ];

      const result = await getCurrentPeriodUsage("org-1");

      expect(result.queryCount).toBe(42);
      expect(result.tokenCount).toBe(10000);
      expect(result.activeUsers).toBe(3);
      expect(result.periodStart).toBeTruthy();
      expect(result.periodEnd).toBeTruthy();
    });

    it("returns zeros when no data", async () => {
      queryResults = [[{ query_count: 0, token_count: 0, active_users: 0 }]];

      const result = await getCurrentPeriodUsage("org-empty");

      expect(result.queryCount).toBe(0);
      expect(result.tokenCount).toBe(0);
      expect(result.activeUsers).toBe(0);
    });

    it("returns zeros when internal DB is not configured", async () => {
      mockHasInternalDB = false;
      const result = await getCurrentPeriodUsage("org-1");
      expect(result.queryCount).toBe(0);
      expect(queryCalls).toHaveLength(0);
    });

    it("returns zeros when query returns empty result set", async () => {
      queryResults = [[]]; // empty array — rows[0] is undefined

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
