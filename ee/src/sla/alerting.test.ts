import { describe, it, expect, beforeEach, mock } from "bun:test";
import crypto from "node:crypto";
import { Effect } from "effect";
import type { Fetcher } from "@useatlas/webhook-publisher";
import { asPercentage, type SLAAlert } from "@useatlas/types";
import { createEEMock } from "../__mocks__/internal";

// ── Mocks ──────────────────────────────────────────────────────────

// Persistent logger spies so the deliverAlert tests can assert on warn/error.
// `createLogger` is invoked once at module load, so returning the same object
// keeps the captured `log` reference inspectable.
const logSpies = {
  info: mock((..._args: unknown[]) => {}),
  warn: mock((..._args: unknown[]) => {}),
  error: mock((..._args: unknown[]) => {}),
  debug: mock((..._args: unknown[]) => {}),
};

const ee = createEEMock({ logger: { createLogger: () => logSpies } });
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
  deliverAlert,
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
    expect(thresholds.errorRatePct).toBe<number>(5);
  });

  it("returns workspace-specific thresholds when available", async () => {
    const wsThreshold = { workspace_id: "ws-1", latency_p99_ms: 3000, error_rate_pct: 2 };
    // ensureTable mocked; workspace query
    ee.queueMockRows([wsThreshold]);

    const thresholds = await run(getThresholds("ws-1"));
    expect(thresholds.latencyP99Ms).toBe(3000);
    expect(thresholds.errorRatePct).toBe<number>(2);
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
    expect(thresholds.errorRatePct).toBe<number>(5);
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

    await run(updateThresholds({ latencyP99Ms: 3000, errorRatePct: asPercentage(2) }));
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

describe("deliverAlert", () => {
  const ALERT: SLAAlert = {
    id: "alert-1",
    workspaceId: "ws-1",
    workspaceName: "Acme",
    type: "latency_p99",
    status: "firing",
    currentValue: 6000,
    threshold: 5000,
    message: "p99 latency exceeded",
    firedAt: "2026-04-01T00:00:00Z",
    resolvedAt: null,
    acknowledgedAt: null,
    acknowledgedBy: null,
  };
  const URL = "https://hooks.example.com/sla";
  const SECRET = "sla-shared-secret-at-least-16-chars";

  beforeEach(() => {
    ee.reset();
    logSpies.warn.mockClear();
    logSpies.error.mockClear();
  });

  it("signs with the timestamped strategy + keeps the payload shape when a secret is set", async () => {
    const ts = 1700000000;
    let captured: { headers?: Record<string, string>; body?: string } = {};
    const fetcher = mock(async (_url: string, init: RequestInit) => {
      captured = {
        headers: init.headers as Record<string, string>,
        body: init.body as string,
      };
      return new Response(null, { status: 200 });
    });

    await run(
      deliverAlert(ALERT, {
        fetcher: fetcher as unknown as Fetcher,
        webhookUrl: URL,
        secret: SECRET,
        nowSeconds: ts,
      }),
    );

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(captured.headers?.["X-Webhook-Timestamp"]).toBe(String(ts));
    const expected =
      "sha256=" +
      crypto.createHmac("sha256", SECRET).update(`${ts}:${captured.body}`).digest("hex");
    expect(captured.headers?.["X-Webhook-Signature"]).toBe(expected);

    // Payload is byte-identical to the pre-signing version.
    const payload = JSON.parse(captured.body ?? "{}");
    expect(payload).toMatchObject({ type: "sla.alert.fired" });
    expect(payload.alert.id).toBe("alert-1");
    expect(typeof payload.timestamp).toBe("string");
    expect(logSpies.warn).not.toHaveBeenCalled();
  });

  it("retries a 5xx up to 3 attempts, then logs the failure", async () => {
    let calls = 0;
    const fetcher = mock(async () => {
      calls++;
      return new Response("upstream", { status: 503 });
    });

    await run(
      deliverAlert(ALERT, {
        fetcher: fetcher as unknown as Fetcher,
        webhookUrl: URL,
        secret: SECRET,
        // No-op sleep keeps the [1s, 2s] backoff from adding real wall-clock.
        sleep: () => Promise.resolve(),
      }),
    );

    expect(calls).toBe(3);
    expect(logSpies.error).toHaveBeenCalled();
  });

  // NOTE: `warnUnsignedOnce` latches at the module level (one warn per
  // process). This is the only test that drives the unsigned path, so the
  // latch is still un-tripped when it runs. A second unsigned-path test would
  // need the latch reset to assert the warn fires.
  it("delivers unsigned (Content-Type only) and warns when no secret is set", async () => {
    let headers: Record<string, string> = {};
    const fetcher = mock(async (_url: string, init: RequestInit) => {
      headers = init.headers as Record<string, string>;
      return new Response(null, { status: 200 });
    });

    await run(
      deliverAlert(ALERT, {
        fetcher: fetcher as unknown as Fetcher,
        webhookUrl: URL,
        // Empty secret forces the unsigned path deterministically, without
        // depending on (or mutating) the ambient ATLAS_SLA_WEBHOOK_SECRET env.
        secret: "",
      }),
    );

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["X-Webhook-Signature"]).toBeUndefined();
    expect(headers["X-Webhook-Timestamp"]).toBeUndefined();
    expect(logSpies.warn).toHaveBeenCalled();
  });
});
