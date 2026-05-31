/**
 * Tier-2 OpenAPI per-install re-discovery scheduler tests (#2978).
 *
 * The cycle is exercised through its dependency seams (`query` / `rediscover` /
 * `persistSuccess` / `stampChecked` / `now`) so the test is fully hermetic — no DB,
 * no probe, no encryption. The only module mocks are the cross-cutting ones with no
 * injection seam: `logger`, `db/internal` (just `hasInternalDB`), and `audit`.
 *
 * Surface under test:
 *   - Due-selection: only installs whose interval has elapsed get re-discovered;
 *     the real `evaluateSpecRefreshDue` decides (not a stub).
 *   - off-skip: an `off` install is never re-discovered even if the query returns it.
 *   - Watermark bump on success: a successful re-probe persists snapshot + diff +
 *     the cycle's `nowIso` watermark.
 *   - Fail-soft on a down upstream: a probe failure stamps the watermark
 *     (negative-cache) WITHOUT persisting a snapshot, and the loop continues.
 *   - Per-install failure containment: a thrown install never aborts the rest.
 *   - Config skips (decrypt/no-url/unsupported-auth) stamp + audit as failures.
 *   - Persist failure does NOT stamp (the next tick retries).
 *   - Cycle-level audit emits every tick (success / failure), the scheduler-stopped
 *     forensic invariant.
 *   - Lifecycle: start/stop, double-start, idempotent stop, no-DB refusal, actor.
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";
import { Effect } from "effect";

// ── Mutable per-test state the mock factories close over ─────────────────────

let mockHasDB = true;
let auditCalls: Array<Record<string, unknown>> = [];
let dbQueryCalls: Array<{ sql: string; params: unknown[] }> = [];

// ── Mocks (declared before importing the SUT) ────────────────────────────────

mock.module("@atlas/api/lib/logger", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, child: () => logger };
  return {
    createLogger: () => logger,
    getRequestContext: () => undefined,
    runWithRequestContext: <T>(_ctx: unknown, fn: () => T): T => fn(),
  };
});

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => mockHasDB,
  internalQuery: async (sql: string, params: unknown[]) => {
    dbQueryCalls.push({ sql, params });
    return [];
  },
  internalExecute: () => {},
  getInternalDB: () => ({}),
}));

mock.module("@atlas/api/lib/audit", () => ({
  logAdminAction: (entry: Record<string, unknown>) => {
    auditCalls.push(entry);
  },
  logAdminActionAwait: async (entry: Record<string, unknown>) => {
    auditCalls.push(entry);
  },
  ADMIN_ACTIONS: {
    connection: {
      probe: "connection.probe",
      specRefreshCycle: "connection.spec_refresh_cycle",
      breakingDrift: "connection.spec_drift_breaking",
    },
  },
}));

mock.module("@atlas/api/lib/audit/error-scrub", () => ({
  errorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
  causeToError: (_cause: unknown) => undefined,
}));

const {
  runOpenApiInstallRediscoverCycle,
  triggerOpenApiInstallRediscoverCycle,
  startOpenApiInstallRediscoverScheduler,
  stopOpenApiInstallRediscoverScheduler,
  isOpenApiInstallRediscoverSchedulerRunning,
  _resetOpenApiInstallRediscoverScheduler,
  getInstallRediscoverIntervalMs,
  OPENAPI_REDISCOVER_ACTOR,
  DEFAULT_REDISCOVER_INTERVAL_MS,
} = await import("../openapi-install-rediscover");

type DueCandidateRow = import("../openapi-install-rediscover").DueCandidateRow;
type RediscoveryResult = import("@atlas/api/lib/openapi/rediscover").RediscoveryResult;
type OpenApiSnapshot = import("@atlas/api/lib/openapi/catalog").OpenApiSnapshot;
type SpecDiffRecord = import("@atlas/api/lib/openapi/diff").SpecDiffRecord;
type SpecDiffSummary = import("@atlas/api/lib/openapi/diff").SpecDiffSummary;
type OperationGraphDiff = import("@atlas/api/lib/openapi/diff").OperationGraphDiff;
type DriftAlertWrite = import("@atlas/api/lib/openapi/breaking-change").DriftAlertWrite;

// ── Fixtures / helpers ───────────────────────────────────────────────────────

const NOW = 1_700_000_000_000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const iso = (ms: number) => new Date(ms).toISOString();
const NOW_ISO = iso(NOW);

/** A config that makes an install DUE at NOW (daily interval, no prior activity). */
const dueConfig = (extra: Record<string, unknown> = {}) => ({ spec_refresh_interval: "daily", ...extra });
/** A config that is NOT yet due (checked 1h ago, daily interval). */
const notDueConfig = () => ({ spec_refresh_interval: "daily", spec_last_checked_at: iso(NOW - HOUR_MS) });

function candidate(installId: string, config: Record<string, unknown>): DueCandidateRow {
  return { workspace_id: `ws-${installId}`, install_id: installId, config };
}

function snapshot(operationCount: number): OpenApiSnapshot {
  return {
    probedAt: NOW_ISO,
    title: "Widget API",
    version: "1.0.0",
    openapiVersion: "3.1.0",
    operationCount,
    doc: { openapi: "3.1.0" },
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

function changedDrift(operationsAdded: number): SpecDiffSummary {
  return {
    previousProbedAt: iso(NOW - DAY_MS),
    currentProbedAt: NOW_ISO,
    baseline: false,
    priorParseFailed: false,
    unchanged: operationsAdded === 0,
    counts: { ...ZERO_COUNTS, operationsAdded },
  };
}

const diffRecord: SpecDiffRecord = { previousProbedAt: null, currentProbedAt: NOW_ISO, diff: null };

function okResult(operationCount = 3, drift: SpecDiffSummary | null = null): RediscoveryResult {
  return { kind: "ok", snapshot: snapshot(operationCount), diffRecord, drift };
}

/** Recording fakes for the persistence seams. */
interface Recorder {
  persistCalls: Array<{
    workspaceId: string;
    installId: string;
    snapshot: OpenApiSnapshot;
    lastCheckedAtIso: string;
    alertWrite: DriftAlertWrite;
  }>;
  stampCalls: Array<{ workspaceId: string; installId: string; lastCheckedAtIso: string }>;
  rediscoverCalls: Array<{ installId: string; config: Record<string, unknown> | null }>;
}

function makeRecorder(): Recorder {
  return { persistCalls: [], stampCalls: [], rediscoverCalls: [] };
}

interface RunArgs {
  rows: DueCandidateRow[];
  rec: Recorder;
  rediscover: (config: Record<string, unknown> | null, installId: string) => Promise<RediscoveryResult>;
  persistThrows?: boolean;
  queryThrows?: Error;
}

function runCycle(args: RunArgs) {
  return Effect.runPromise(
    runOpenApiInstallRediscoverCycle({
      now: () => NOW,
      query: async () => {
        if (args.queryThrows) throw args.queryThrows;
        return args.rows;
      },
      rediscover: (config, installId) => {
        args.rec.rediscoverCalls.push({ installId, config });
        return args.rediscover(config, installId);
      },
      persistSuccess: async (workspaceId, installId, snap, _diff, lastCheckedAtIso, alertWrite) => {
        if (args.persistThrows) throw new Error("persist boom");
        args.rec.persistCalls.push({ workspaceId, installId, snapshot: snap, lastCheckedAtIso, alertWrite });
      },
      stampChecked: async (workspaceId, installId, lastCheckedAtIso) => {
        args.rec.stampCalls.push({ workspaceId, installId, lastCheckedAtIso });
      },
    }),
  );
}

function resetAll() {
  _resetOpenApiInstallRediscoverScheduler();
  mockHasDB = true;
  auditCalls = [];
  dbQueryCalls = [];
}

const cycleRows = () => auditCalls.filter((c) => c.actionType === "connection.spec_refresh_cycle");
const probeRows = () => auditCalls.filter((c) => c.actionType === "connection.probe");

// ── Lifecycle ─────────────────────────────────────────────────────────────

describe("openapi install rediscover — lifecycle", () => {
  beforeEach(resetAll);

  it("starts and stops cleanly", () => {
    expect(isOpenApiInstallRediscoverSchedulerRunning()).toBe(false);
    startOpenApiInstallRediscoverScheduler(60_000);
    expect(isOpenApiInstallRediscoverSchedulerRunning()).toBe(true);
    stopOpenApiInstallRediscoverScheduler();
    expect(isOpenApiInstallRediscoverSchedulerRunning()).toBe(false);
  });

  it("does not double-start", () => {
    startOpenApiInstallRediscoverScheduler(60_000);
    startOpenApiInstallRediscoverScheduler(60_000);
    expect(isOpenApiInstallRediscoverSchedulerRunning()).toBe(true);
    stopOpenApiInstallRediscoverScheduler();
  });

  it("stop is idempotent — calling stop twice or without start is a no-op", () => {
    stopOpenApiInstallRediscoverScheduler();
    expect(isOpenApiInstallRediscoverSchedulerRunning()).toBe(false);
    startOpenApiInstallRediscoverScheduler(60_000);
    stopOpenApiInstallRediscoverScheduler();
    stopOpenApiInstallRediscoverScheduler();
    expect(isOpenApiInstallRediscoverSchedulerRunning()).toBe(false);
  });

  it("refuses to start without an internal DB (it reads workspace_plugins)", () => {
    mockHasDB = false;
    startOpenApiInstallRediscoverScheduler(60_000);
    expect(isOpenApiInstallRediscoverSchedulerRunning()).toBe(false);
  });

  it("reserved system actor matches the audit pattern + is distinct from siblings", () => {
    expect(OPENAPI_REDISCOVER_ACTOR).toBe("system:openapi-install-rediscover");
    expect(OPENAPI_REDISCOVER_ACTOR).toMatch(/^system:[a-z0-9][a-z0-9_-]*$/);
    expect(OPENAPI_REDISCOVER_ACTOR).not.toBe("system:byot-catalog-refresh");
  });
});

describe("getInstallRediscoverIntervalMs — env-tunable global tick", () => {
  const KEY = "ATLAS_OPENAPI_REDISCOVER_INTERVAL_HOURS";
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env[KEY];
    delete process.env[KEY];
  });
  const restore = () => {
    if (saved === undefined) delete process.env[KEY];
    else process.env[KEY] = saved;
  };

  it("defaults to 1 hour", () => {
    expect(getInstallRediscoverIntervalMs()).toBe(DEFAULT_REDISCOVER_INTERVAL_MS);
    expect(DEFAULT_REDISCOVER_INTERVAL_MS).toBe(HOUR_MS);
    restore();
  });

  it("honors a positive override (hours → ms)", () => {
    process.env[KEY] = "6";
    expect(getInstallRediscoverIntervalMs()).toBe(6 * HOUR_MS);
    restore();
  });

  it("falls back to the default on a non-positive / non-finite value", () => {
    for (const bad of ["0", "-3", "abc"]) {
      process.env[KEY] = bad;
      expect(getInstallRediscoverIntervalMs()).toBe(DEFAULT_REDISCOVER_INTERVAL_MS);
    }
    restore();
  });
});

// ── Cycle behavior ──────────────────────────────────────────────────────────

describe("openapi install rediscover — cycle behavior", () => {
  beforeEach(resetAll);

  it("empty queue → success, zero counts, one success cycle audit row", async () => {
    const rec = makeRecorder();
    const result = await runCycle({ rows: [], rec, rediscover: async () => okResult() });

    expect(result.status).toBe("success");
    expect(result.inspected).toBe(0);
    expect(result.due).toBe(0);
    expect(result.refreshed).toBe(0);
    expect(rec.rediscoverCalls).toHaveLength(0);

    expect(cycleRows()).toHaveLength(1);
    expect(cycleRows()[0].systemActor).toBe(OPENAPI_REDISCOVER_ACTOR);
    expect(cycleRows()[0].scope).toBe("platform");
    expect(cycleRows()[0].targetType).toBe("connection");
    expect(cycleRows()[0].targetId).toBe("scheduler");
    expect(cycleRows()[0].status).toBe("success");
  });

  it("default candidate query orders by effective activity (GREATEST of watermark + probedAt), not the bare watermark", async () => {
    // No injected `query` → the real defaultQuery runs against the mocked
    // internalQuery, so we can assert the SELECT it issues. Ordering by the bare
    // `spec_last_checked_at NULLS FIRST` would starve due rows behind not-yet-due
    // fresh installs (#3046 Codex review); GREATEST(watermark, probedAt) mirrors
    // evaluateSpecRefreshDue so the most-overdue install sorts first.
    await Effect.runPromise(runOpenApiInstallRediscoverCycle({ now: () => NOW }));
    const select = dbQueryCalls.find((c) => c.sql.includes("FROM workspace_plugins"));
    expect(select).toBeDefined();
    expect(select!.sql).toContain("GREATEST(config->>'spec_last_checked_at', config->'openapi_snapshot'->>'probedAt')");
    expect(select!.sql).toContain("NULLS FIRST");
    expect(select!.sql).toContain("<> 'off'");
    expect(select!.sql).toContain("status != 'archived'");
    expect(select!.params).toEqual(["catalog:openapi-generic", 100]);
  });

  it("survives an internal-DB-disabled state — emits a success cycle row with zero counts", async () => {
    mockHasDB = false;
    const result = await Effect.runPromise(runOpenApiInstallRediscoverCycle());
    expect(result.status).toBe("success");
    expect(result.inspected).toBe(0);
    expect(cycleRows()).toHaveLength(1);
    expect(cycleRows()[0].status).toBe("success");
  });

  it("candidate query throw emits a FAILURE cycle row with error metadata", async () => {
    const rec = makeRecorder();
    const result = await runCycle({
      rows: [],
      rec,
      rediscover: async () => okResult(),
      queryThrows: new Error("connection refused"),
    });
    expect(result.status).toBe("failure");
    expect(result.error).toBe("connection refused");
    expect(cycleRows()).toHaveLength(1);
    expect(cycleRows()[0].status).toBe("failure");
    expect((cycleRows()[0].metadata as Record<string, unknown>).error).toBe("connection refused");
  });

  it("DUE-SELECTION: re-discovers only the installs whose interval has elapsed", async () => {
    const rec = makeRecorder();
    const rows = [
      candidate("due-1", dueConfig()),
      candidate("not-due", notDueConfig()),
      candidate("due-2", dueConfig()),
    ];
    const result = await runCycle({ rows, rec, rediscover: async () => okResult(2) });

    expect(result.inspected).toBe(3);
    expect(result.due).toBe(2);
    expect(result.refreshed).toBe(2);
    expect(result.skippedNotDue).toBe(1);
    // Only the two due installs were probed — the not-due one was never touched.
    expect(rec.rediscoverCalls.map((c) => c.installId)).toEqual(["due-1", "due-2"]);
    expect(rec.stampCalls).toHaveLength(0);
  });

  it("OFF-SKIP: an off install is never re-discovered even if the query returns it", async () => {
    const rec = makeRecorder();
    const rows = [
      candidate("off-1", { spec_refresh_interval: "off" }),
      candidate("due-1", dueConfig()),
    ];
    const result = await runCycle({ rows, rec, rediscover: async () => okResult() });

    expect(result.skippedNotDue).toBe(1);
    expect(result.refreshed).toBe(1);
    expect(rec.rediscoverCalls.map((c) => c.installId)).toEqual(["due-1"]);
  });

  it("WATERMARK BUMP ON SUCCESS: persists snapshot + diff + the cycle's nowIso watermark", async () => {
    const rec = makeRecorder();
    const rows = [candidate("ds-1", dueConfig())];
    const result = await runCycle({ rows, rec, rediscover: async () => okResult(5, changedDrift(2)) });

    expect(result.refreshed).toBe(1);
    expect(rec.persistCalls).toHaveLength(1);
    expect(rec.persistCalls[0].workspaceId).toBe("ws-ds-1");
    expect(rec.persistCalls[0].installId).toBe("ds-1");
    expect(rec.persistCalls[0].snapshot.operationCount).toBe(5);
    expect(rec.persistCalls[0].lastCheckedAtIso).toBe(NOW_ISO);
    // Success path stamps via the snapshot write, NOT the watermark-only write.
    expect(rec.stampCalls).toHaveLength(0);

    // Audit: connection.probe, scheduler-triggered, with drift roll-up.
    const row = probeRows().find((c) => c.targetId === "ds-1");
    expect(row).toBeDefined();
    expect(row!.systemActor).toBe(OPENAPI_REDISCOVER_ACTOR);
    expect(row!.status).toBe("success");
    const meta = row!.metadata as Record<string, unknown>;
    expect(meta.workspaceId).toBe("ws-ds-1");
    expect(meta.kind).toBe("openapi-rediscover");
    expect(meta.triggeredBy).toBe("scheduler");
    expect(meta.operationCount).toBe(5);
    expect(meta.operationsAdded).toBe(2);
  });

  it("FAIL-SOFT: a down upstream stamps the watermark, leaves the snapshot untouched, keeps going", async () => {
    const rec = makeRecorder();
    const rows = [
      candidate("down-1", dueConfig()),
      candidate("ok-1", dueConfig()),
    ];
    const result = await runCycle({
      rows,
      rec,
      rediscover: async (_config, installId) =>
        installId === "down-1"
          ? { kind: "probe_failed", reason: "unreachable", message: "ETIMEDOUT" }
          : okResult(),
    });

    expect(result.failed).toBe(1);
    expect(result.refreshed).toBe(1);
    // The failed install got a watermark-only stamp (negative-cache), NOT a snapshot write.
    expect(rec.stampCalls.map((c) => c.installId)).toEqual(["down-1"]);
    expect(rec.stampCalls[0].lastCheckedAtIso).toBe(NOW_ISO);
    expect(rec.persistCalls.map((c) => c.installId)).toEqual(["ok-1"]);

    const failRow = probeRows().find((c) => c.targetId === "down-1");
    expect(failRow!.status).toBe("failure");
    expect((failRow!.metadata as Record<string, unknown>).reason).toBe("probe_failed");
    expect((failRow!.metadata as Record<string, unknown>).probeReason).toBe("unreachable");
  });

  it("PER-INSTALL CONTAINMENT: a thrown middle install does not abort the rest", async () => {
    const rec = makeRecorder();
    const rows = [
      candidate("a", dueConfig()),
      candidate("b", dueConfig()),
      candidate("c", dueConfig()),
    ];
    const result = await runCycle({
      rows,
      rec,
      rediscover: async (_config, installId) => {
        if (installId === "b") throw new Error("kaboom");
        return okResult();
      },
    });

    expect(rec.rediscoverCalls.map((c) => c.installId)).toEqual(["a", "b", "c"]);
    expect(result.refreshed).toBe(2);
    expect(result.failed).toBe(1);
    // The thrown install is fail-soft negative-cached (watermark stamped).
    expect(rec.stampCalls.map((c) => c.installId)).toEqual(["b"]);
    const failRow = probeRows().find((c) => c.targetId === "b");
    expect(failRow!.status).toBe("failure");
    // A rediscover-phase fault is negative-cached (stamped) → deferred a full interval.
    expect((failRow!.metadata as Record<string, unknown>).reason).toBe("rediscover_fault");
  });

  it("CONFIG SKIP: decrypt/no-url/unsupported-auth stamp the watermark + audit as failures", async () => {
    const rec = makeRecorder();
    const rows = [
      candidate("decrypt", dueConfig()),
      candidate("nourl", dueConfig()),
      candidate("oauth", dueConfig()),
    ];
    const result = await runCycle({
      rows,
      rec,
      rediscover: async (_config, installId) => {
        if (installId === "decrypt") return { kind: "decrypt_failed" };
        if (installId === "nourl") return { kind: "no_url" };
        return { kind: "unsupported_auth", rawAuthKind: "oauth2" };
      },
    });

    expect(result.skippedConfig).toBe(3);
    expect(result.refreshed).toBe(0);
    expect(result.failed).toBe(0);
    // Every config-skip is negative-cached so it isn't re-evaluated every tick.
    expect(rec.stampCalls.map((c) => c.installId).sort()).toEqual(["decrypt", "nourl", "oauth"]);
    expect(rec.persistCalls).toHaveLength(0);

    const oauthRow = probeRows().find((c) => c.targetId === "oauth");
    expect(oauthRow!.status).toBe("failure");
    expect((oauthRow!.metadata as Record<string, unknown>).reason).toBe("unsupported_auth");
    expect((oauthRow!.metadata as Record<string, unknown>).authKind).toBe("oauth2");
  });

  it("PERSIST FAILURE: a failed snapshot write does NOT stamp (so the next tick retries)", async () => {
    const rec = makeRecorder();
    const rows = [candidate("ds-1", dueConfig())];
    const result = await runCycle({
      rows,
      rec,
      rediscover: async () => okResult(),
      persistThrows: true,
    });

    expect(result.failed).toBe(1);
    expect(result.refreshed).toBe(0);
    // Neither a snapshot write (it threw) nor a watermark stamp — the install stays
    // due so the next tick retries rather than caching a half-applied refresh.
    expect(rec.persistCalls).toHaveLength(0);
    expect(rec.stampCalls).toHaveLength(0);
    const failRow = probeRows().find((c) => c.targetId === "ds-1");
    expect(failRow!.status).toBe("failure");
    // persist-phase failure is the retry-next-tick mode, distinct from a deferred
    // rediscover fault — the audit reason must reflect that.
    expect((failRow!.metadata as Record<string, unknown>).reason).toBe("persist_failed");
  });

  it("emits one cycle audit row carrying the full RediscoverCycleResult counts", async () => {
    const rec = makeRecorder();
    const rows = [
      candidate("ok-1", dueConfig()),
      candidate("down-1", dueConfig()),
      candidate("not-due", notDueConfig()),
      candidate("oauth", dueConfig()),
    ];
    await runCycle({
      rows,
      rec,
      rediscover: async (_c, installId) => {
        if (installId === "down-1") return { kind: "probe_failed", reason: "unreachable", message: "x" };
        if (installId === "oauth") return { kind: "unsupported_auth", rawAuthKind: "oauth2" };
        return okResult();
      },
    });

    expect(cycleRows()).toHaveLength(1);
    expect(cycleRows()[0].metadata).toEqual({
      status: "success",
      inspected: 4,
      due: 3,
      refreshed: 1,
      breaking: 0,
      failed: 1,
      skippedNotDue: 1,
      skippedConfig: 1,
    });
  });
});

// ── Breaking-change drift signal (#2979) ─────────────────────────────────────

const breakingRows = () => auditCalls.filter((c) => c.actionType === "connection.spec_drift_breaking");

/** A real breaking diff: one operation the agent relied on was removed. */
const breakingDiff: OperationGraphDiff = {
  operations: {
    added: [],
    removed: [{ operationId: "getThing", method: "GET", path: "/things/{id}" }],
    changed: [],
  },
  schemas: { added: [], removed: [], changed: [] },
  counts: { ...ZERO_COUNTS, operationsRemoved: 1 },
  unchanged: false,
};
/** A real additive-only diff: one new operation, nothing removed/retyped. */
const additiveDiff: OperationGraphDiff = {
  operations: {
    added: [{ operationId: "listThings", method: "GET", path: "/things" }],
    removed: [],
    changed: [],
  },
  schemas: { added: [], removed: [], changed: [] },
  counts: { ...ZERO_COUNTS, operationsAdded: 1 },
  unchanged: false,
};

function okResultWithDiff(diff: OperationGraphDiff | null): RediscoveryResult {
  const record: SpecDiffRecord = {
    previousProbedAt: iso(NOW - DAY_MS),
    currentProbedAt: NOW_ISO,
    diff,
  };
  return { kind: "ok", snapshot: snapshot(3), diffRecord: record, drift: changedDrift(diff?.counts.operationsAdded ?? 0) };
}

describe("openapi install rediscover — breaking-change drift signal (#2979)", () => {
  beforeEach(resetAll);

  it("RAISES the persisted signal + writes the breaking audit row on scheduled breaking drift", async () => {
    const rec = makeRecorder();
    const result = await runCycle({
      rows: [candidate("ds-1", dueConfig())],
      rec,
      rediscover: async () => okResultWithDiff(breakingDiff),
    });

    expect(result.refreshed).toBe(1);
    expect(result.breaking).toBe(1);

    // The persisted snapshot write carries a RAISE alert (the pill).
    expect(rec.persistCalls).toHaveLength(1);
    const write = rec.persistCalls[0].alertWrite;
    expect(write.op).toBe("raise");
    if (write.op === "raise") {
      expect(write.record.raisedAt).toBe(NOW_ISO);
      expect(write.record.acknowledgedAt).toBeNull();
      expect(write.record.breakingCount).toBeGreaterThan(0);
      expect(write.record.reasons.some((r) => r.kind === "operation_removed")).toBe(true);
    }

    // The success probe row still fires…
    expect(probeRows().find((c) => c.targetId === "ds-1")?.status).toBe("success");
    // …PLUS the dedicated breaking-drift attention row (success status, by design).
    const breaking = breakingRows().find((c) => c.targetId === "ds-1");
    expect(breaking).toBeDefined();
    expect(breaking!.status).toBe("success");
    expect(breaking!.systemActor).toBe(OPENAPI_REDISCOVER_ACTOR);
    expect(breaking!.scope).toBe("platform");
    const meta = breaking!.metadata as Record<string, unknown>;
    expect(meta.workspaceId).toBe("ws-ds-1");
    expect(meta.triggeredBy).toBe("scheduler");
    expect(meta.breakingCount).toBe(1);
    expect(Array.isArray(meta.reasons)).toBe(true);
  });

  it("CLEARS the signal on a scheduled additive-only refresh — no breaking row", async () => {
    const rec = makeRecorder();
    const result = await runCycle({
      rows: [candidate("ds-1", dueConfig())],
      rec,
      rediscover: async () => okResultWithDiff(additiveDiff),
    });

    expect(result.refreshed).toBe(1);
    expect(result.breaking).toBe(0);
    expect(rec.persistCalls[0].alertWrite.op).toBe("clear");
    expect(breakingRows()).toHaveLength(0);
  });

  it("LEAVES the signal on a scheduled baseline refresh (no prior comparison)", async () => {
    const rec = makeRecorder();
    const result = await runCycle({
      rows: [candidate("ds-1", dueConfig())],
      rec,
      rediscover: async () => okResultWithDiff(null),
    });

    expect(result.refreshed).toBe(1);
    expect(result.breaking).toBe(0);
    expect(rec.persistCalls[0].alertWrite.op).toBe("leave");
    expect(breakingRows()).toHaveLength(0);
  });
});

describe("openapi install rediscover — triggerOpenApiInstallRediscoverCycle wrapper", () => {
  beforeEach(resetAll);

  it("returns the cycle result on the happy path", async () => {
    const rec = makeRecorder();
    const result = await triggerOpenApiInstallRediscoverCycle({
      now: () => NOW,
      query: async () => [candidate("ds-1", dueConfig())],
      rediscover: async () => okResult(),
      persistSuccess: async (workspaceId, installId, snap, _diff, lastCheckedAtIso, alertWrite) => {
        rec.persistCalls.push({ workspaceId, installId, snapshot: snap, lastCheckedAtIso, alertWrite });
      },
      stampChecked: async () => {},
    });
    expect(result.status).toBe("success");
    expect(result.refreshed).toBe(1);
    expect(rec.persistCalls).toHaveLength(1);
  });

  it("resolves with status: failure (does not reject) when the candidate query throws", async () => {
    const result = await triggerOpenApiInstallRediscoverCycle({
      query: async () => {
        throw new Error("db down");
      },
    });
    expect(result.status).toBe("failure");
    expect(result.error).toBe("db down");
  });
});
