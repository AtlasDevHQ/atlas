/**
 * Unit tests for the #3315 query-time drift-recovery core (`drift-recovery.ts`).
 *
 * Everything is driven through the injected dep seams (loader / rediscover /
 * persist / clock) — no DB, no network, no module mock of the rediscover core.
 * The tool-side integration (retry wiring, strict-mode gate, agent-facing
 * shapes) is covered in `tools/__tests__/rest-operation.test.ts`.
 */
import { describe, it, expect, beforeEach, mock } from "bun:test";

mock.module("@atlas/api/lib/logger", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, child: () => logger };
  return { createLogger: () => logger, getRequestContext: () => undefined };
});

const {
  attemptDriftRecovery,
  coerceSpecDriftMode,
  DEFAULT_SPEC_DRIFT_MODE,
  DRIFT_REPROBE_COOLDOWN_MS,
  _resetDriftRecoveryState,
  _driftRecoveryCooldownSize,
} = await import("../drift-recovery");
const { OPENAPI_GENERIC_CATALOG_ID } = await import("../catalog");

type RawInstallRow = import("../drift-recovery").RawInstallRow;
type OperationGraph = import("../types").OperationGraph;
type OpenApiSnapshot = import("../catalog").OpenApiSnapshot;
type SpecDiffRecord = import("../diff").SpecDiffRecord;
type OperationGraphDiff = import("../diff").OperationGraphDiff;
type RediscoveryResult = import("../rediscover").RediscoveryResult;
type PersistFn = typeof import("../rediscover").persistRediscoverySnapshot;

const NOW = Date.parse("2026-06-10T12:00:00.000Z");
const NOW_ISO = new Date(NOW).toISOString();

const snapshot: OpenApiSnapshot = {
  probedAt: NOW_ISO,
  title: "Widget API",
  version: "2.0.0",
  openapiVersion: "3.1.0",
  operationCount: 1,
  doc: { openapi: "3.1.0" },
};

function graphWith(...operationIds: string[]): OperationGraph {
  return {
    operations: new Map(operationIds.map((id) => [id, { operationId: id }])),
    schemas: new Map(),
    servers: [],
  } as unknown as OperationGraph;
}

/**
 * A re-probeable generic install row: auto-refresh mode (the attempt enforces
 * the opt-in on the loaded config) + the generic catalog id. Tests override
 * fields to exercise the refusal gates.
 */
function genericRow(config: Record<string, unknown> = {}): RawInstallRow {
  return {
    config: { spec_drift_mode: "auto-refresh", ...config },
    catalogId: OPENAPI_GENERIC_CATALOG_ID,
  };
}

const ZERO_COUNTS = {
  operationsAdded: 0,
  operationsRemoved: 0,
  operationsChanged: 0,
  schemasAdded: 0,
  schemasRemoved: 0,
  schemasChanged: 0,
  fieldsAdded: 0,
  fieldsRemoved: 0,
  fieldsRetyped: 0,
};

const breakingDiff: OperationGraphDiff = {
  operations: {
    added: [],
    removed: [{ operationId: "oldOp", method: "GET", path: "/old" }],
    changed: [],
  },
  schemas: { added: [], removed: [], changed: [] },
  counts: { ...ZERO_COUNTS, operationsRemoved: 1 },
  unchanged: false,
};

const cleanDiff: OperationGraphDiff = {
  operations: { added: [], removed: [], changed: [] },
  schemas: { added: [], removed: [], changed: [] },
  counts: ZERO_COUNTS,
  unchanged: true,
};

function okResult(graph: OperationGraph, diff: OperationGraphDiff | null): RediscoveryResult {
  const diffRecord: SpecDiffRecord = {
    previousProbedAt: diff === null ? null : "2026-06-09T12:00:00.000Z",
    currentProbedAt: NOW_ISO,
    diff,
  };
  return { kind: "ok", snapshot, diffRecord, drift: null, graph };
}

interface PersistCall {
  workspaceId: string;
  installId: string;
  alertWrite: Parameters<PersistFn>[5];
}

function recorder() {
  const persistCalls: PersistCall[] = [];
  const persist: PersistFn = async (workspaceId, installId, _snap, _diff, _watermark, alertWrite) => {
    persistCalls.push({ workspaceId, installId, alertWrite });
  };
  return { persistCalls, persist };
}

beforeEach(() => {
  _resetDriftRecoveryState();
});

describe("coerceSpecDriftMode", () => {
  it("accepts both declared modes verbatim", () => {
    expect(coerceSpecDriftMode("strict")).toBe("strict");
    expect(coerceSpecDriftMode("auto-refresh")).toBe("auto-refresh");
  });

  it("fails soft to strict for absent / drifted / wrong-typed values", () => {
    expect(DEFAULT_SPEC_DRIFT_MODE).toBe("strict");
    expect(coerceSpecDriftMode(undefined)).toBe("strict");
    expect(coerceSpecDriftMode(null)).toBe("strict");
    expect(coerceSpecDriftMode("")).toBe("strict");
    expect(coerceSpecDriftMode("AUTO-REFRESH")).toBe("strict");
    expect(coerceSpecDriftMode(42)).toBe("strict");
    expect(coerceSpecDriftMode({ mode: "auto-refresh" })).toBe("strict");
  });
});

describe("attemptDriftRecovery", () => {
  it("refreshes, persists, and reports the operation found in the fresh graph", async () => {
    const { persistCalls, persist } = recorder();
    const outcome = await attemptDriftRecovery("ws-1", "ds-1", "newOp", {
      loadRawConfig: async () => genericRow({ openapi_url: "https://api.example.com/spec" }),
      rediscover: async () => okResult(graphWith("newOp"), cleanDiff),
      persist,
      now: () => NOW,
    });
    expect(outcome.kind).toBe("refreshed");
    if (outcome.kind !== "refreshed") return;
    expect(outcome.operationFound).toBe(true);
    expect(persistCalls).toHaveLength(1);
    expect(persistCalls[0].workspaceId).toBe("ws-1");
    expect(persistCalls[0].installId).toBe("ds-1");
  });

  it("reports operationFound: false when the fresh graph still lacks the operation", async () => {
    const { persist } = recorder();
    const outcome = await attemptDriftRecovery("ws-1", "ds-1", "stillMissing", {
      loadRawConfig: async () => genericRow(),
      rediscover: async () => okResult(graphWith("otherOp"), cleanDiff),
      persist,
      now: () => NOW,
    });
    expect(outcome.kind).toBe("refreshed");
    if (outcome.kind !== "refreshed") return;
    expect(outcome.operationFound).toBe(false);
  });

  it("RAISES the persisted drift alert on breaking drift, recording the drift-recovery trigger", async () => {
    const { persistCalls, persist } = recorder();
    const outcome = await attemptDriftRecovery("ws-1", "ds-1", "newOp", {
      loadRawConfig: async () => genericRow(),
      rediscover: async () => okResult(graphWith("newOp"), breakingDiff),
      persist,
      now: () => NOW,
    });
    expect(outcome.kind).toBe("refreshed");
    const write = persistCalls[0].alertWrite;
    expect(write?.op).toBe("raise");
    if (write?.op !== "raise") return;
    // The unattended trigger is recorded so audit/UI can tell a query-time
    // recovery refresh apart from the Tier-2 scheduler's.
    expect(write.record.trigger).toBe("drift-recovery");
  });

  it("CLEARS a standing alert on a clean refresh and LEAVES it on a baseline", async () => {
    const { persistCalls, persist } = recorder();
    await attemptDriftRecovery("ws-1", "ds-clean", "x", {
      loadRawConfig: async () => genericRow(),
      rediscover: async () => okResult(graphWith("x"), cleanDiff),
      persist,
      now: () => NOW,
    });
    await attemptDriftRecovery("ws-1", "ds-baseline", "x", {
      loadRawConfig: async () => genericRow(),
      rediscover: async () => okResult(graphWith("x"), null),
      persist,
      now: () => NOW,
    });
    expect(persistCalls.map((c) => c.alertWrite?.op)).toEqual(["clear", "leave"]);
  });

  it("debounces per (workspace, install): a second attempt within the cooldown is skipped", async () => {
    let rediscoverCalls = 0;
    const { persist } = recorder();
    const deps = {
      loadRawConfig: async () => genericRow(),
      rediscover: async () => {
        rediscoverCalls++;
        return okResult(graphWith("op"), cleanDiff);
      },
      persist,
      now: () => NOW,
    };
    const first = await attemptDriftRecovery("ws-1", "ds-1", "op", deps);
    const second = await attemptDriftRecovery("ws-1", "ds-1", "op", deps);
    expect(first.kind).toBe("refreshed");
    expect(second.kind).toBe("cooldown");
    expect(rediscoverCalls).toBe(1);
    // A DIFFERENT install is its own bucket — not throttled by ds-1's attempt.
    const other = await attemptDriftRecovery("ws-1", "ds-2", "op", deps);
    expect(other.kind).toBe("refreshed");
  });

  it("allows a new attempt once the cooldown has elapsed", async () => {
    const { persist } = recorder();
    let nowMs = NOW;
    const deps = {
      loadRawConfig: async () => genericRow(),
      rediscover: async () => okResult(graphWith("op"), cleanDiff),
      persist,
      now: () => nowMs,
    };
    expect((await attemptDriftRecovery("ws-1", "ds-1", "op", deps)).kind).toBe("refreshed");
    nowMs = NOW + DRIFT_REPROBE_COOLDOWN_MS - 1;
    expect((await attemptDriftRecovery("ws-1", "ds-1", "op", deps)).kind).toBe("cooldown");
    nowMs = NOW + DRIFT_REPROBE_COOLDOWN_MS;
    expect((await attemptDriftRecovery("ws-1", "ds-1", "op", deps)).kind).toBe("refreshed");
  });

  it("a FAILED probe stamps the cooldown too — no probe storm on an erroring upstream", async () => {
    let rediscoverCalls = 0;
    const { persist } = recorder();
    const deps = {
      loadRawConfig: async () => genericRow(),
      rediscover: async (): Promise<RediscoveryResult> => {
        rediscoverCalls++;
        return { kind: "probe_failed", reason: "unreachable", message: "upstream down" };
      },
      persist,
      now: () => NOW,
    };
    const first = await attemptDriftRecovery("ws-1", "ds-1", "op", deps);
    const second = await attemptDriftRecovery("ws-1", "ds-1", "op", deps);
    expect(first).toEqual({ kind: "not_refreshed", reason: "probe_failed" });
    expect(second.kind).toBe("cooldown");
    expect(rediscoverCalls).toBe(1);
  });

  it("fails closed (no persist) on every non-ok rediscovery outcome", async () => {
    const { persistCalls, persist } = recorder();
    const outcomes: Array<RediscoveryResult> = [
      { kind: "decrypt_failed" },
      { kind: "no_url" },
      { kind: "unsupported_auth", rawAuthKind: "oauth2" },
      { kind: "probe_failed", reason: "unreachable", message: "boom" },
    ];
    for (const [i, result] of outcomes.entries()) {
      const outcome = await attemptDriftRecovery("ws-1", `ds-${i}`, "op", {
        loadRawConfig: async () => genericRow(),
        rediscover: async () => result,
        persist,
        now: () => NOW,
      });
      expect(outcome).toEqual({ kind: "not_refreshed", reason: result.kind });
    }
    expect(persistCalls).toHaveLength(0);
  });

  it("maps a missing install row to install_not_found and a loader fault to not_refreshed", async () => {
    const { persist } = recorder();
    const missing = await attemptDriftRecovery("ws-1", "ds-gone", "op", {
      loadRawConfig: async () => null,
      rediscover: async () => okResult(graphWith("op"), cleanDiff),
      persist,
      now: () => NOW,
    });
    expect(missing).toEqual({ kind: "install_not_found" });

    const faulted = await attemptDriftRecovery("ws-1", "ds-db-down", "op", {
      loadRawConfig: async () => {
        throw new Error("db down");
      },
      rediscover: async () => okResult(graphWith("op"), cleanDiff),
      persist,
      now: () => NOW,
    });
    expect(faulted).toEqual({ kind: "not_refreshed", reason: "config_load_failed" });
  });

  it("never throws: an unexpected rediscover fault and a persist fault both fail closed", async () => {
    const { persist } = recorder();
    const crashed = await attemptDriftRecovery("ws-1", "ds-crash", "op", {
      loadRawConfig: async () => genericRow(),
      rediscover: async () => {
        throw new Error("unexpected fault");
      },
      persist,
      now: () => NOW,
    });
    expect(crashed).toEqual({ kind: "not_refreshed", reason: "unexpected" });

    const persistFailed = await attemptDriftRecovery("ws-1", "ds-persist", "op", {
      loadRawConfig: async () => genericRow(),
      rediscover: async () => okResult(graphWith("op"), cleanDiff),
      persist: async () => {
        throw new Error("write failed");
      },
      now: () => NOW,
    });
    expect(persistFailed).toEqual({ kind: "not_refreshed", reason: "persist_failed" });
  });

  it("REFUSES when the freshly-loaded config is strict — the opt-in is enforced here, not just in the tool", async () => {
    let rediscoverCalls = 0;
    const { persistCalls, persist } = recorder();
    for (const config of [{}, { spec_drift_mode: "strict" }, { spec_drift_mode: "garbage" }]) {
      _resetDriftRecoveryState();
      const outcome = await attemptDriftRecovery("ws-1", "ds-1", "op", {
        loadRawConfig: async () => ({ config, catalogId: OPENAPI_GENERIC_CATALOG_ID }),
        rediscover: async () => {
          rediscoverCalls++;
          return okResult(graphWith("op"), cleanDiff);
        },
        persist,
        now: () => NOW,
      });
      expect(outcome).toEqual({ kind: "not_refreshed", reason: "drift_mode_strict" });
    }
    expect(rediscoverCalls).toBe(0);
    expect(persistCalls).toHaveLength(0);
  });

  it("a refusal does NOT burn the cooldown: flipping strict → auto-refresh takes effect immediately", async () => {
    const { persist } = recorder();
    let mode = "strict";
    const deps = {
      loadRawConfig: async () => ({
        config: { spec_drift_mode: mode },
        catalogId: OPENAPI_GENERIC_CATALOG_ID,
      }),
      rediscover: async () => okResult(graphWith("op"), cleanDiff),
      persist,
      now: () => NOW,
    };
    const refused = await attemptDriftRecovery("ws-1", "ds-1", "op", deps);
    expect(refused).toEqual({ kind: "not_refreshed", reason: "drift_mode_strict" });
    expect(_driftRecoveryCooldownSize()).toBe(0);
    // Admin flips the mode; the very next attempt (same instant) re-probes.
    mode = "auto-refresh";
    const recovered = await attemptDriftRecovery("ws-1", "ds-1", "op", deps);
    expect(recovered.kind).toBe("refreshed");
  });

  it("REFUSES a non-generic install (built-in data candidate) with the distinct unsupported_catalog reason", async () => {
    let rediscoverCalls = 0;
    const { persist } = recorder();
    const outcome = await attemptDriftRecovery("ws-1", "ds-stripe", "op", {
      loadRawConfig: async () => ({
        config: { spec_drift_mode: "auto-refresh" },
        catalogId: "catalog:stripe-data",
      }),
      rediscover: async () => {
        rediscoverCalls++;
        return okResult(graphWith("op"), cleanDiff);
      },
      persist,
      now: () => NOW,
    });
    expect(outcome).toEqual({ kind: "not_refreshed", reason: "unsupported_catalog" });
    expect(rediscoverCalls).toBe(0);
  });

  it("sweeps expired cooldown stamps so the map tracks the active window, not process lifetime", async () => {
    const { persist } = recorder();
    let nowMs = NOW;
    const deps = {
      loadRawConfig: async () => genericRow(),
      rediscover: async () => okResult(graphWith("op"), cleanDiff),
      persist,
      now: () => nowMs,
    };
    await attemptDriftRecovery("ws-1", "ds-1", "op", deps);
    await attemptDriftRecovery("ws-1", "ds-2", "op", deps);
    expect(_driftRecoveryCooldownSize()).toBe(2);
    // One window later, a new attempt's sweep evicts both stale stamps and
    // leaves only its own.
    nowMs = NOW + DRIFT_REPROBE_COOLDOWN_MS;
    await attemptDriftRecovery("ws-1", "ds-3", "op", deps);
    expect(_driftRecoveryCooldownSize()).toBe(1);
  });

  it("re-derives the operations base URL from the FRESH spec when it passes the egress guard", async () => {
    const { persist } = recorder();
    const graph = {
      operations: new Map([["op", { operationId: "op" }]]),
      schemas: new Map(),
      servers: [{ url: "https://api.example.com/v2/" }],
    } as unknown as OperationGraph;
    const outcome = await attemptDriftRecovery("ws-1", "ds-1", "op", {
      loadRawConfig: async () => genericRow({ openapi_url: "https://api.example.com/openapi.json" }),
      rediscover: async () => okResult(graph, cleanDiff),
      persist,
      now: () => NOW,
    });
    expect(outcome.kind).toBe("refreshed");
    if (outcome.kind !== "refreshed") return;
    // Trailing slash stripped, exactly like the resolver's derivation.
    expect(outcome.baseUrl).toBe("https://api.example.com/v2");
  });

  it("OMITS the fresh base URL when the new spec's server target is egress-blocked (retry keeps the old base)", async () => {
    const { persist } = recorder();
    const graph = {
      operations: new Map([["op", { operationId: "op" }]]),
      schemas: new Map(),
      servers: [{ url: "https://127.0.0.1/internal" }],
    } as unknown as OperationGraph;
    const outcome = await attemptDriftRecovery("ws-1", "ds-1", "op", {
      loadRawConfig: async () => genericRow({ openapi_url: "https://api.example.com/openapi.json" }),
      rediscover: async () => okResult(graph, cleanDiff),
      persist,
      now: () => NOW,
    });
    expect(outcome.kind).toBe("refreshed");
    if (outcome.kind !== "refreshed") return;
    expect(outcome.baseUrl).toBeUndefined();
  });
});
