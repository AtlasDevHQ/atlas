import { describe, it, expect, beforeEach, mock } from "bun:test";
import { Effect } from "effect";
import { createEEMock } from "../__mocks__/internal";

// ── Mocks ──────────────────────────────────────────────────────────

const ee = createEEMock();
mock.module("../index", () => ee.enterpriseMock);
mock.module("@atlas/api/lib/db/internal", () => ee.internalDBMock);
mock.module("../lib/db-guard", () => ({
  requireInternalDB: (label: string) => {
    if (!(ee.internalDBMock.hasInternalDB as () => boolean)())
      throw new Error(`Internal database required for ${label}.`);
  },
  requireInternalDBEffect: (label: string) =>
    (ee.internalDBMock.hasInternalDB as () => boolean)()
      ? Effect.void
      : Effect.fail(new Error(`Internal database required for ${label}.`)),
}));
mock.module("@atlas/api/lib/logger", () => ee.loggerMock);

const {
  recordQueryMetric,
  getAllWorkspaceSLA,
  getWorkspaceSLADetail,
  _resetTableReady,
} = await import("./metrics");

// ── Helpers ────────────────────────────────────────────────────────

const run = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(effect as Effect.Effect<A, never>);

// ── Tests ──────────────────────────────────────────────────────────

describe("recordQueryMetric", () => {
  beforeEach(() => {
    ee.reset();
    _resetTableReady();
  });

  it("records a metric to the DB", async () => {
    // ensureTable queries + INSERT
    ee.queueMockRows([], [], [], [], [], [], []);
    await run(recordQueryMetric("ws-1", 150, false));

    const insertQuery = ee.capturedQueries.find((q) => q.sql.includes("INSERT INTO sla_metrics"));
    expect(insertQuery).toBeDefined();
    expect(insertQuery!.params).toEqual(["ws-1", 150, false]);
  });

  it("silently succeeds when no internal DB (fire-and-forget)", async () => {
    ee.setHasInternalDB(false);
    // Should not throw — recordQueryMetric catches all errors
    await run(recordQueryMetric("ws-1", 100, false));
    expect(ee.capturedQueries).toHaveLength(0);
  });

  it("logs warning but does not throw on DB error (fire-and-forget)", async () => {
    // ensureTable queries succeed, then INSERT fails
    // Since it uses Effect.promise (defect), the catchAll catches it
    ee.queueMockRows([], [], [], [], [], [], []);
    // Override internalQuery to throw after table setup
    const originalQuery = ee.internalDBMock.internalQuery;
    let callCount = 0;
    ee.internalDBMock.internalQuery = async (sql: string, params?: unknown[]) => {
      callCount++;
      // Fail on the INSERT (after CREATE TABLE queries)
      if (callCount > 6 && sql.includes("INSERT INTO sla_metrics")) {
        throw new Error("DB connection refused");
      }
      return (originalQuery as (sql: string, params?: unknown[]) => Promise<unknown[]>)(sql, params);
    };

    // Should not throw
    await run(recordQueryMetric("ws-1", 100, true));
    // Restore
    ee.internalDBMock.internalQuery = originalQuery;
  });
});

describe("getAllWorkspaceSLA", () => {
  beforeEach(() => {
    ee.reset();
    _resetTableReady();
  });

  it("returns workspace SLA summaries", async () => {
    const summaryRow = {
      workspace_id: "ws-1",
      workspace_name: "Test Workspace",
      latency_p50_ms: 50,
      latency_p95_ms: 200,
      latency_p99_ms: 500,
      total_queries: "100",
      failed_queries: "5",
      last_query_at: "2026-04-01T00:00:00Z",
    };
    // ensureTable + summary query
    ee.queueMockRows([], [], [], [], [], [], [summaryRow]);

    const summaries = await run(getAllWorkspaceSLA());
    expect(summaries).toHaveLength(1);
    expect(summaries[0].workspaceId).toBe("ws-1");
    expect(summaries[0].totalQueries).toBe(100);
    expect(summaries[0].errorRatePct).toBe<number>(5);
    expect(summaries[0].uptimePct).toBe<number>(95);
  });

  it("returns empty array when no metrics", async () => {
    ee.queueMockRows([], [], [], [], [], [], []);
    const summaries = await run(getAllWorkspaceSLA());
    expect(summaries).toHaveLength(0);
  });
});

describe("getWorkspaceSLADetail", () => {
  beforeEach(() => {
    ee.reset();
    _resetTableReady();
  });

  it("returns summary + timeline data", async () => {
    const summaryRow = {
      workspace_id: "ws-1",
      workspace_name: "Test",
      latency_p50_ms: 50,
      latency_p95_ms: 200,
      latency_p99_ms: 500,
      total_queries: "100",
      failed_queries: "2",
      last_query_at: "2026-04-01T00:00:00Z",
    };
    const latencyPoint = { hour: "2026-04-01T00:00:00Z", value: 450 };
    const errorPoint = { hour: "2026-04-01T00:00:00Z", value: 2.5 };
    // ensureTable + summary + latency timeline + error timeline
    ee.queueMockRows([], [], [], [], [], [], [summaryRow], [latencyPoint], [errorPoint]);

    const detail = await run(getWorkspaceSLADetail("ws-1"));
    expect(detail.summary.workspaceId).toBe("ws-1");
    expect(detail.latencyTimeline).toHaveLength(1);
    expect(detail.errorTimeline).toHaveLength(1);
  });

  it("returns zero values when workspace has no metrics", async () => {
    // ensureTable + empty summary + empty timelines
    ee.queueMockRows([], [], [], [], [], [], [], [], []);

    const detail = await run(getWorkspaceSLADetail("ws-empty"));
    expect(detail.summary.totalQueries).toBe(0);
    expect(detail.latencyTimeline).toHaveLength(0);
  });
});
