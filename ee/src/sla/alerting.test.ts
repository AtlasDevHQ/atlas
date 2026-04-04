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
  getThresholds,
  updateThresholds,
  getAlerts,
  acknowledgeAlert,
} = await import("./alerting");

// ── Helpers ────────────────────────────────────────────────────────

const run = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(effect as Effect.Effect<A, never>);

const defaultThresholdRow = {
  workspace_id: "_default",
  latency_p99_ms: 5000,
  error_rate_pct: 5,
};

// ── Tests ──────────────────────────────────────────────────────────

describe("getThresholds", () => {
  beforeEach(() => {
    ee.reset();
    // ensureTable is mocked — no table state to reset
  });

  it("returns default thresholds from DB", async () => {
    // ensureTable mocked to void; SELECT default thresholds
    ee.queueMockRows([defaultThresholdRow]);

    const thresholds = await run(getThresholds());
    expect(thresholds.latencyP99Ms).toBe(5000);
    expect(thresholds.errorRatePct).toBe(5);
  });

  it("returns workspace-specific thresholds when available", async () => {
    const wsThreshold = { workspace_id: "ws-1", latency_p99_ms: 3000, error_rate_pct: 2 };
    // ensureTable mocked; workspace query
    ee.queueMockRows([wsThreshold]);

    const thresholds = await run(getThresholds("ws-1"));
    expect(thresholds.latencyP99Ms).toBe(3000);
    expect(thresholds.errorRatePct).toBe(2);
  });

  it("falls back to defaults when workspace thresholds not found", async () => {
    // ensureTable mocked; empty workspace query + default fallback query
    ee.queueMockRows([], [defaultThresholdRow]);

    const thresholds = await run(getThresholds("ws-missing"));
    expect(thresholds.latencyP99Ms).toBe(5000);
  });

  it("returns env-var defaults when no DB rows exist", async () => {
    // ensureTable mocked; empty workspace + empty default
    ee.queueMockRows([], []);

    const thresholds = await run(getThresholds("ws-1"));
    // Default from env: ATLAS_SLA_LATENCY_P99_MS=5000, ATLAS_SLA_ERROR_RATE_PCT=5
    expect(thresholds.latencyP99Ms).toBe(5000);
    expect(thresholds.errorRatePct).toBe(5);
  });
});

describe("updateThresholds", () => {
  beforeEach(() => {
    ee.reset();
    // ensureTable is mocked — no table state to reset
  });

  it("upserts thresholds", async () => {
    // ensureTable mocked; UPSERT
    ee.queueMockRows([]);

    await run(updateThresholds({ latencyP99Ms: 3000, errorRatePct: 2 }));
    const upsert = ee.capturedQueries.find((q) => q.sql.includes("sla_thresholds"));
    expect(upsert).toBeDefined();
  });
});

describe("getAlerts", () => {
  beforeEach(() => {
    ee.reset();
    // ensureTable is mocked — no table state to reset
  });

  it("returns alerts from DB", async () => {
    const alertRow = {
      id: "a1",
      workspace_id: "ws-1",
      workspace_name: "Test",
      alert_type: "latency_p99",
      status: "firing",
      current_value: 6000,
      threshold: 5000,
      message: "Latency p99 (6000ms) exceeds threshold (5000ms)",
      fired_at: "2026-04-01T00:00:00Z",
      resolved_at: null,
      acknowledged_at: null,
      acknowledged_by: null,
    };
    // ensureTable mocked; SELECT alerts
    ee.queueMockRows([alertRow]);

    const alerts = await run(getAlerts());
    expect(alerts).toHaveLength(1);
    expect(alerts[0].id).toBe("a1");
    expect(alerts[0].status).toBe("firing");
  });

  it("filters by status", async () => {
    ee.queueMockRows([]);
    await run(getAlerts("resolved"));
    const query = ee.capturedQueries.find((q) => q.sql.includes("status = $1"));
    expect(query).toBeDefined();
    expect(query!.params[0]).toBe("resolved");
  });

  it("returns empty array when no alerts", async () => {
    ee.queueMockRows([]);
    const alerts = await run(getAlerts());
    expect(alerts).toHaveLength(0);
  });
});

describe("acknowledgeAlert", () => {
  beforeEach(() => {
    ee.reset();
    // ensureTable is mocked — no table state to reset
  });

  it("acknowledges a firing alert", async () => {
    // ensureTable is mocked to void; UPDATE returning 1 row
    ee.queueMockRows([{ id: "a1" }]);

    const result = await run(acknowledgeAlert("a1", "admin-1"));
    expect(result).toBe(true);
  });

  it("returns false when alert not found or not firing", async () => {
    // ensureTable is mocked to void; UPDATE returning 0 rows
    ee.queueMockRows([]);

    const result = await run(acknowledgeAlert("nonexistent", "admin-1"));
    expect(result).toBe(false);
  });
});
