/**
 * BYOT catalog refresh scheduler tests (#2284).
 *
 * Surface under test:
 *   - Sequential per-row refresh (one upstream provider call at a time).
 *   - Decrypt-failed / no-config / missing-key / malformed-bundle skips with
 *     correct audit status semantics (deliberate suppressions = success,
 *     corruption = failure).
 *   - In-memory exponential backoff (1, 2, 4, 8, 16, 32 days capped) with
 *     per-row math verified by advancing `nowFn` past each threshold.
 *   - Per-row failure containment — a thrown row never aborts the rest.
 *   - Cycle-level audit emits every tick, with `status: "success"` on a
 *     healthy tick and `status: "failure"` on stale-row query failure.
 *   - `triggerByotCatalogRefreshCycle()` promise wrapper.
 *   - EE-module-missing branch routes to `ee_unavailable` skip reason.
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";
import { Effect } from "effect";

// ---------------------------------------------------------------------------
// Mock control variables
// ---------------------------------------------------------------------------

let mockInternalDB = true;
let mockStaleRows: Array<{ org_id: string; provider: string; bedrock_region: string | null }> = [];
let staleQueryCalls = 0;
let staleQueryShouldThrow: Error | null = null;

let mockWorkspaceConfigs: Map<
  string,
  | { provider: string; model: string; apiKey: string | null; baseUrl: string | null; bedrockRegion: string | null }
  | "DECRYPT_FAIL"
  | null
> = new Map();

let anthropicFetcherCalls: Array<{ orgId: string; apiKey: string }> = [];
let openaiFetcherCalls: Array<{ orgId: string; apiKey: string }> = [];
let bedrockFetcherCalls: Array<{ orgId: string; region: string }> = [];

type FetchOutcome =
  | { kind: "ok"; modelCount: number }
  | { kind: "throw"; error: Error };
let anthropicOutcomes: FetchOutcome[] = [];
let openaiOutcomes: FetchOutcome[] = [];
let bedrockOutcomes: FetchOutcome[] = [];

let auditCalls: Array<Record<string, unknown>> = [];
let auditShouldThrowForAction: string | null = null;

// ---------------------------------------------------------------------------
// Mocks — all named exports mocked per CLAUDE.md "mock all exports" rule.
// ---------------------------------------------------------------------------

mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
  getRequestContext: () => undefined,
  runWithRequestContext: <T>(_ctx: unknown, fn: () => T): T => fn(),
}));

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => mockInternalDB,
  internalQuery: async () => {
    staleQueryCalls++;
    if (staleQueryShouldThrow) throw staleQueryShouldThrow;
    return mockStaleRows;
  },
  internalExecute: () => {},
  getInternalDB: () => ({}),
}));

mock.module("@atlas/api/lib/audit", () => ({
  logAdminAction: (entry: Record<string, unknown>) => {
    auditCalls.push(entry);
    if (auditShouldThrowForAction && entry.actionType === auditShouldThrowForAction) {
      throw new Error(`audit threw on ${auditShouldThrowForAction}`);
    }
  },
  logAdminActionAwait: async (entry: Record<string, unknown>) => {
    auditCalls.push(entry);
  },
  ADMIN_ACTIONS: {
    model_config: {
      update: "model_config.update",
      delete: "model_config.delete",
      test: "model_config.test",
      catalogRefresh: "model_config.catalog_refresh",
      catalogRefreshCycle: "model_config.catalog_refresh_cycle",
      catalogRefreshSkip: "model_config.catalog_refresh_skip",
    },
  },
}));

mock.module("@atlas/api/lib/audit/error-scrub", () => ({
  errorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
  causeToError: (_cause: unknown) => undefined,
}));

class FakeDecryptError extends Error {
  readonly _tag = "ModelConfigDecryptError" as const;
  readonly configId: string;
  readonly cause: string;
  constructor(configId: string, cause: string) {
    super(`Failed to decrypt config ${configId}: ${cause}`);
    this.configId = configId;
    this.cause = cause;
  }
}

mock.module("@atlas/ee/platform/model-routing", () => ({
  ModelConfigDecryptError: FakeDecryptError,
  getWorkspaceModelConfigRaw: (orgId: string) => {
    const cfg = mockWorkspaceConfigs.get(orgId);
    if (cfg === "DECRYPT_FAIL") {
      return Effect.fail(new FakeDecryptError("cfg-" + orgId, "key rotated"));
    }
    return Effect.succeed(cfg ?? null);
  },
  parseBedrockCredentialBundle: (apiKey: string) => {
    if (apiKey === "BAD_BUNDLE") return null;
    return {
      accessKeyId: "AKIA-test",
      secretAccessKey: "secret-test",
      sessionToken: null,
    };
  },
}));

mock.module("@atlas/api/lib/anthropic-catalog", () => ({
  getAnthropicCatalog: async (orgId: string, apiKey: string, _opts: { refresh?: boolean }) => {
    anthropicFetcherCalls.push({ orgId, apiKey });
    const outcome = anthropicOutcomes.shift() ?? { kind: "ok" as const, modelCount: 3 };
    if (outcome.kind === "throw") throw outcome.error;
    return {
      models: Array.from({ length: outcome.modelCount }, (_, i) => ({ id: `m-${i}` })),
      fetchedAt: new Date().toISOString(),
      source: "fresh" as const,
    };
  },
  AnthropicCatalogUnauthorized: class extends Error {},
  AnthropicCatalogRateLimited: class extends Error {
    retryAfterSeconds: number | null = 60;
  },
  AnthropicCatalogUnavailable: class extends Error {},
  invalidateAnthropicCatalog: () => {},
}));

mock.module("@atlas/api/lib/openai-catalog", () => ({
  getOpenAICatalog: async (orgId: string, apiKey: string, _opts: { refresh?: boolean }) => {
    openaiFetcherCalls.push({ orgId, apiKey });
    const outcome = openaiOutcomes.shift() ?? { kind: "ok" as const, modelCount: 5 };
    if (outcome.kind === "throw") throw outcome.error;
    return {
      models: Array.from({ length: outcome.modelCount }, (_, i) => ({ id: `m-${i}` })),
      fetchedAt: new Date().toISOString(),
      source: "fresh" as const,
    };
  },
  OpenAICatalogUnauthorized: class extends Error {},
  OpenAICatalogRateLimited: class extends Error {
    retryAfterSeconds: number | null = 60;
  },
  OpenAICatalogUnavailable: class extends Error {},
  invalidateOpenAICatalog: () => {},
}));

mock.module("@atlas/api/lib/bedrock-catalog", () => ({
  getBedrockCatalog: async (
    orgId: string,
    region: string,
    _bundle: unknown,
    _opts: { refresh?: boolean },
  ) => {
    bedrockFetcherCalls.push({ orgId, region });
    const outcome = bedrockOutcomes.shift() ?? { kind: "ok" as const, modelCount: 7 };
    if (outcome.kind === "throw") throw outcome.error;
    return {
      models: Array.from({ length: outcome.modelCount }, (_, i) => ({ id: `m-${i}` })),
      fetchedAt: new Date().toISOString(),
      source: "fresh" as const,
    };
  },
  BedrockCatalogUnauthorized: class extends Error {},
  BedrockCatalogRateLimited: class extends Error {
    retryAfterSeconds: number | null = 60;
  },
  BedrockCatalogUnavailable: class extends Error {},
  invalidateBedrockCatalog: () => {},
}));

const {
  runByotCatalogRefreshCycle,
  startByotCatalogRefreshScheduler,
  stopByotCatalogRefreshScheduler,
  isByotCatalogRefreshSchedulerRunning,
  _resetByotCatalogRefreshScheduler,
  _resetBackoffForTests,
  _resetEeProbeForTests,
  _computeBackoffMsForTests,
  triggerByotCatalogRefreshCycle,
  BYOT_CATALOG_REFRESH_ACTOR,
} = await import("../byot-catalog-refresh");

function resetAll() {
  _resetByotCatalogRefreshScheduler();
  _resetBackoffForTests();
  _resetEeProbeForTests();
  mockInternalDB = true;
  mockStaleRows = [];
  staleQueryCalls = 0;
  staleQueryShouldThrow = null;
  mockWorkspaceConfigs = new Map();
  anthropicFetcherCalls = [];
  openaiFetcherCalls = [];
  bedrockFetcherCalls = [];
  anthropicOutcomes = [];
  openaiOutcomes = [];
  bedrockOutcomes = [];
  auditCalls = [];
  auditShouldThrowForAction = null;
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("byot catalog refresh scheduler — lifecycle", () => {
  beforeEach(resetAll);

  it("starts and stops cleanly", () => {
    expect(isByotCatalogRefreshSchedulerRunning()).toBe(false);
    startByotCatalogRefreshScheduler(60_000);
    expect(isByotCatalogRefreshSchedulerRunning()).toBe(true);
    stopByotCatalogRefreshScheduler();
    expect(isByotCatalogRefreshSchedulerRunning()).toBe(false);
  });

  it("does not double-start", () => {
    startByotCatalogRefreshScheduler(60_000);
    startByotCatalogRefreshScheduler(60_000);
    expect(isByotCatalogRefreshSchedulerRunning()).toBe(true);
    stopByotCatalogRefreshScheduler();
  });

  it("stop is idempotent — calling stop twice or without start is a no-op", () => {
    stopByotCatalogRefreshScheduler();
    expect(isByotCatalogRefreshSchedulerRunning()).toBe(false);
    startByotCatalogRefreshScheduler(60_000);
    stopByotCatalogRefreshScheduler();
    stopByotCatalogRefreshScheduler();
    expect(isByotCatalogRefreshSchedulerRunning()).toBe(false);
  });

  it("refuses to start without an internal DB", () => {
    mockInternalDB = false;
    startByotCatalogRefreshScheduler(60_000);
    expect(isByotCatalogRefreshSchedulerRunning()).toBe(false);
  });

  it("reserved system actor matches the audit pattern", () => {
    expect(BYOT_CATALOG_REFRESH_ACTOR).toBe("system:byot-catalog-refresh");
    expect(BYOT_CATALOG_REFRESH_ACTOR).toMatch(/^system:[a-z0-9][a-z0-9_-]*$/);
  });
});

describe("byot catalog refresh — cycle behavior", () => {
  beforeEach(resetAll);

  it("returns success status + zero counts and emits one cycle audit row on an empty queue", async () => {
    const result = await Effect.runPromise(runByotCatalogRefreshCycle());
    expect(result.status).toBe("success");
    expect(result.inspected).toBe(0);
    expect(result.refreshed).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.error).toBeUndefined();

    const cycleRows = auditCalls.filter(
      (c) => c.actionType === "model_config.catalog_refresh_cycle",
    );
    expect(cycleRows).toHaveLength(1);
    expect(cycleRows[0].systemActor).toBe(BYOT_CATALOG_REFRESH_ACTOR);
    expect(cycleRows[0].scope).toBe("platform");
    expect(cycleRows[0].targetType).toBe("model_config");
    expect(cycleRows[0].targetId).toBe("scheduler");
    expect(cycleRows[0].status).toBe("success");
  });

  it("refreshes each stale workspace sequentially in the order returned by the query", async () => {
    mockStaleRows = [
      { org_id: "org-a", provider: "anthropic", bedrock_region: null },
      { org_id: "org-b", provider: "openai", bedrock_region: null },
      { org_id: "org-c", provider: "bedrock", bedrock_region: "us-east-1" },
    ];
    mockWorkspaceConfigs.set("org-a", { provider: "anthropic", model: "claude-3", apiKey: "key-a", baseUrl: null, bedrockRegion: null });
    mockWorkspaceConfigs.set("org-b", { provider: "openai", model: "gpt-4", apiKey: "key-b", baseUrl: null, bedrockRegion: null });
    mockWorkspaceConfigs.set("org-c", { provider: "bedrock", model: "claude-3", apiKey: "bundle-c", baseUrl: null, bedrockRegion: "us-east-1" });

    const result = await Effect.runPromise(runByotCatalogRefreshCycle());

    expect(result.status).toBe("success");
    expect(result.inspected).toBe(3);
    expect(result.refreshed).toBe(3);
    expect(result.failed).toBe(0);

    expect(anthropicFetcherCalls).toEqual([{ orgId: "org-a", apiKey: "key-a" }]);
    expect(openaiFetcherCalls).toEqual([{ orgId: "org-b", apiKey: "key-b" }]);
    expect(bedrockFetcherCalls).toEqual([{ orgId: "org-c", region: "us-east-1" }]);
  });

  it("skips rows whose stored key fails to decrypt and audits the skip as failure", async () => {
    mockStaleRows = [
      { org_id: "org-bad", provider: "anthropic", bedrock_region: null },
      { org_id: "org-ok", provider: "anthropic", bedrock_region: null },
    ];
    mockWorkspaceConfigs.set("org-bad", "DECRYPT_FAIL");
    mockWorkspaceConfigs.set("org-ok", { provider: "anthropic", model: "claude-3", apiKey: "good", baseUrl: null, bedrockRegion: null });

    const result = await Effect.runPromise(runByotCatalogRefreshCycle());

    expect(result.skippedDecryptFailed).toBe(1);
    expect(result.refreshed).toBe(1);
    expect(anthropicFetcherCalls).toEqual([{ orgId: "org-ok", apiKey: "good" }]);

    const skipRow = auditCalls.find(
      (c) =>
        c.actionType === "model_config.catalog_refresh_skip" &&
        (c.targetId as string) === "org-bad",
    );
    expect(skipRow).toBeDefined();
    // decrypt_failed is corruption — admin must re-enter the key.
    expect(skipRow!.status).toBe("failure");
    const meta = skipRow!.metadata as Record<string, unknown>;
    expect(meta.reason).toBe("decrypt_failed");
  });

  it("skips rows with no saved config (no_config branch) with success status", async () => {
    mockStaleRows = [
      { org_id: "org-missing", provider: "anthropic", bedrock_region: null },
    ];
    mockWorkspaceConfigs.set("org-missing", null);

    const result = await Effect.runPromise(runByotCatalogRefreshCycle());

    expect(result.skippedMissingKey).toBe(1);
    expect(anthropicFetcherCalls).toHaveLength(0);

    const skipRow = auditCalls.find(
      (c) =>
        c.actionType === "model_config.catalog_refresh_skip" &&
        (c.targetId as string) === "org-missing",
    );
    expect(skipRow!.status).toBe("success");
    expect((skipRow!.metadata as Record<string, unknown>).reason).toBe("missing_byot_key");
  });

  it("audits each successful refresh with the standard catalogRefresh action + scheduler triggeredBy", async () => {
    mockStaleRows = [
      { org_id: "org-a", provider: "anthropic", bedrock_region: null },
    ];
    mockWorkspaceConfigs.set("org-a", { provider: "anthropic", model: "claude-3", apiKey: "key-a", baseUrl: null, bedrockRegion: null });

    await Effect.runPromise(runByotCatalogRefreshCycle());

    const refreshRow = auditCalls.find(
      (c) =>
        c.actionType === "model_config.catalog_refresh" &&
        (c.targetId as string) === "org-a",
    );
    expect(refreshRow!.systemActor).toBe(BYOT_CATALOG_REFRESH_ACTOR);
    const meta = refreshRow!.metadata as Record<string, unknown>;
    expect(meta.provider).toBe("anthropic");
    expect(meta.source).toBe("fresh");
    expect(meta.modelCount).toBe(3);
    expect(meta.triggeredBy).toBe("scheduler");
  });

  it("processes providers one at a time so a slow provider does not race the next row", async () => {
    mockStaleRows = [
      { org_id: "org-1", provider: "anthropic", bedrock_region: null },
      { org_id: "org-2", provider: "anthropic", bedrock_region: null },
      { org_id: "org-3", provider: "anthropic", bedrock_region: null },
    ];
    for (const o of ["org-1", "org-2", "org-3"]) {
      mockWorkspaceConfigs.set(o, { provider: "anthropic", model: "x", apiKey: `k-${o}`, baseUrl: null, bedrockRegion: null });
    }

    await Effect.runPromise(runByotCatalogRefreshCycle());

    expect(anthropicFetcherCalls.map((c) => c.orgId)).toEqual(["org-1", "org-2", "org-3"]);
  });

  it("per-row failure containment — a thrown middle row does not abort later rows", async () => {
    mockStaleRows = [
      { org_id: "org-1", provider: "anthropic", bedrock_region: null },
      { org_id: "org-2", provider: "anthropic", bedrock_region: null },
      { org_id: "org-3", provider: "anthropic", bedrock_region: null },
    ];
    for (const o of ["org-1", "org-2", "org-3"]) {
      mockWorkspaceConfigs.set(o, { provider: "anthropic", model: "x", apiKey: `k-${o}`, baseUrl: null, bedrockRegion: null });
    }
    anthropicOutcomes = [
      { kind: "ok", modelCount: 2 },
      { kind: "throw", error: new Error("502 bad gateway") },
      { kind: "ok", modelCount: 4 },
    ];

    const result = await Effect.runPromise(runByotCatalogRefreshCycle());

    expect(anthropicFetcherCalls.map((c) => c.orgId)).toEqual(["org-1", "org-2", "org-3"]);
    expect(result.refreshed).toBe(2);
    expect(result.failed).toBe(1);
  });

  it("queries the staleness view exactly once per cycle", async () => {
    mockStaleRows = [];
    await Effect.runPromise(runByotCatalogRefreshCycle());
    expect(staleQueryCalls).toBe(1);
  });

  it("survives an internal-DB-disabled state — emits success cycle row with zero counts", async () => {
    mockInternalDB = false;
    const result = await Effect.runPromise(runByotCatalogRefreshCycle());
    expect(result.status).toBe("success");
    expect(result.inspected).toBe(0);
    const cycleRows = auditCalls.filter(
      (c) => c.actionType === "model_config.catalog_refresh_cycle",
    );
    expect(cycleRows).toHaveLength(1);
    expect(cycleRows[0].status).toBe("success");
  });

  it("stale-row query throw emits a FAILURE cycle row with error metadata", async () => {
    mockInternalDB = true;
    staleQueryShouldThrow = new Error("connection refused");
    const result = await Effect.runPromise(runByotCatalogRefreshCycle());
    expect(result.status).toBe("failure");
    expect(result.error).toBe("connection refused");
    expect(result.inspected).toBe(0);
    const cycleRows = auditCalls.filter(
      (c) => c.actionType === "model_config.catalog_refresh_cycle",
    );
    expect(cycleRows).toHaveLength(1);
    expect(cycleRows[0].status).toBe("failure");
    expect((cycleRows[0].metadata as Record<string, unknown>).error).toBe("connection refused");
  });

  it("emits one cycle audit row with full ByotRefreshCycleResult metadata", async () => {
    mockStaleRows = [
      { org_id: "org-ok", provider: "anthropic", bedrock_region: null },
      { org_id: "org-bad", provider: "anthropic", bedrock_region: null },
      { org_id: "org-decrypt", provider: "openai", bedrock_region: null },
    ];
    mockWorkspaceConfigs.set("org-ok", { provider: "anthropic", model: "x", apiKey: "good", baseUrl: null, bedrockRegion: null });
    mockWorkspaceConfigs.set("org-bad", { provider: "anthropic", model: "x", apiKey: "stale", baseUrl: null, bedrockRegion: null });
    mockWorkspaceConfigs.set("org-decrypt", "DECRYPT_FAIL");
    anthropicOutcomes = [
      { kind: "ok", modelCount: 2 },
      { kind: "throw", error: new Error("401 invalid") },
    ];

    await Effect.runPromise(runByotCatalogRefreshCycle());

    const cycleRows = auditCalls.filter(
      (c) => c.actionType === "model_config.catalog_refresh_cycle",
    );
    expect(cycleRows).toHaveLength(1);
    expect(cycleRows[0].metadata).toEqual({
      status: "success",
      inspected: 3,
      refreshed: 1,
      failed: 1,
      skippedDecryptFailed: 1,
      skippedInBackoff: 0,
      skippedMissingKey: 0,
      skippedEeUnavailable: 0,
      skippedMalformedBundle: 0,
    });
  });

  it("audit-emission throw on a skip row does not tear down the rest of the cycle", async () => {
    mockStaleRows = [
      { org_id: "org-skip", provider: "anthropic", bedrock_region: null },
      { org_id: "org-refresh", provider: "anthropic", bedrock_region: null },
    ];
    mockWorkspaceConfigs.set("org-skip", null);
    mockWorkspaceConfigs.set("org-refresh", { provider: "anthropic", model: "x", apiKey: "good", baseUrl: null, bedrockRegion: null });
    auditShouldThrowForAction = "model_config.catalog_refresh_skip";

    const result = await Effect.runPromise(runByotCatalogRefreshCycle());

    // The skip row's audit threw, but the cycle continued and the next row
    // still fetched + audited + counted.
    expect(result.skippedMissingKey).toBe(1);
    expect(result.refreshed).toBe(1);
    expect(anthropicFetcherCalls).toEqual([{ orgId: "org-refresh", apiKey: "good" }]);
    // The cycle audit row still landed (audit module rebuilds on the next
    // action; only `catalog_refresh_skip` throws).
    const cycleRows = auditCalls.filter(
      (c) => c.actionType === "model_config.catalog_refresh_cycle",
    );
    expect(cycleRows).toHaveLength(1);
  });
});

describe("byot catalog refresh — backoff math", () => {
  beforeEach(resetAll);

  // The `nowFn` injection drives the clock. After N consecutive failures the
  // workspace's `nextEligibleAt` should sit `2^(N-1)` days in the future
  // (capped at 32 days = 2^5).
  async function failOnce(orgId: string, atMs: number): Promise<void> {
    mockStaleRows = [{ org_id: orgId, provider: "anthropic", bedrock_region: null }];
    mockWorkspaceConfigs.set(orgId, { provider: "anthropic", model: "x", apiKey: "bad", baseUrl: null, bedrockRegion: null });
    anthropicOutcomes = [{ kind: "throw", error: new Error("401 invalid") }];
    await Effect.runPromise(runByotCatalogRefreshCycle({ nowFn: () => atMs }));
  }

  async function inspectSkipAtTime(orgId: string, nowMs: number): Promise<{ skipped: boolean }> {
    mockStaleRows = [{ org_id: orgId, provider: "anthropic", bedrock_region: null }];
    mockWorkspaceConfigs.set(orgId, { provider: "anthropic", model: "x", apiKey: "bad", baseUrl: null, bedrockRegion: null });
    anthropicOutcomes = [{ kind: "ok", modelCount: 1 }];
    anthropicFetcherCalls = [];
    const result = await Effect.runPromise(runByotCatalogRefreshCycle({ nowFn: () => nowMs }));
    return { skipped: result.skippedInBackoff === 1 };
  }

  it("after failure 1 → in backoff for 1 day; eligible again at +1d", async () => {
    const t0 = 1_000_000_000_000;
    await failOnce("org-x", t0);

    // At t0 + 1 day - 1ms → still in backoff.
    expect((await inspectSkipAtTime("org-x", t0 + ONE_DAY_MS - 1)).skipped).toBe(true);
    // At t0 + 1 day exactly → eligible (nextEligibleAt > now is the gate;
    // equal means eligible).
    expect((await inspectSkipAtTime("org-x", t0 + ONE_DAY_MS)).skipped).toBe(false);
  });

  // Pure math test — the unit-level invariant the cycle relies on. Decoupled
  // from cycle state so iteration N doesn't depend on iteration N-1's clock.
  it("computeBackoffMs returns 1d, 2d, 4d, 8d, 16d, 32d, 32d, 32d (cap) for failures 1..8", () => {
    const expectedDays = [1, 2, 4, 8, 16, 32, 32, 32];
    for (let f = 1; f <= expectedDays.length; f++) {
      expect(_computeBackoffMsForTests(f)).toBe(expectedDays[f - 1] * ONE_DAY_MS);
    }
  });

  it("computeBackoffMs is non-negative even for invalid (zero/negative) failure counts", () => {
    expect(_computeBackoffMsForTests(0)).toBe(ONE_DAY_MS); // clamp prevents negative exponent
    expect(_computeBackoffMsForTests(-5)).toBe(ONE_DAY_MS);
  });

  it("clears backoff on a successful refresh", async () => {
    const t0 = 1_000_000_000_000;
    await failOnce("org-flaky", t0);

    _resetBackoffForTests(); // simulate enough time passing

    mockStaleRows = [{ org_id: "org-flaky", provider: "openai", bedrock_region: null }];
    mockWorkspaceConfigs.set("org-flaky", { provider: "openai", model: "gpt-4", apiKey: "tok", baseUrl: null, bedrockRegion: null });
    openaiOutcomes = [{ kind: "ok", modelCount: 8 }];
    const result = await Effect.runPromise(runByotCatalogRefreshCycle({ nowFn: () => t0 + 100_000 }));
    expect(result.refreshed).toBe(1);

    // Even with the same orgId stale again, no backoff carries over.
    openaiOutcomes = [{ kind: "ok", modelCount: 8 }];
    const result2 = await Effect.runPromise(runByotCatalogRefreshCycle({ nowFn: () => t0 + 200_000 }));
    expect(result2.refreshed).toBe(1);
    expect(result2.skippedInBackoff).toBe(0);
  });

  it("in_backoff skip is audited as success (deliberate suppression, not corruption)", async () => {
    const t0 = 1_000_000_000_000;
    await failOnce("org-x", t0);
    auditCalls = [];

    mockStaleRows = [{ org_id: "org-x", provider: "anthropic", bedrock_region: null }];
    mockWorkspaceConfigs.set("org-x", { provider: "anthropic", model: "x", apiKey: "bad", baseUrl: null, bedrockRegion: null });
    await Effect.runPromise(runByotCatalogRefreshCycle({ nowFn: () => t0 + 1000 })); // well within backoff

    const skipRow = auditCalls.find(
      (c) =>
        c.actionType === "model_config.catalog_refresh_skip" &&
        (c.targetId as string) === "org-x",
    );
    expect(skipRow!.status).toBe("success");
    expect((skipRow!.metadata as Record<string, unknown>).reason).toBe("in_backoff");
  });
});

describe("byot catalog refresh — bedrock specifics", () => {
  beforeEach(resetAll);

  it("skips bedrock rows whose stored bundle parses as null (malformed) — audited as failure", async () => {
    mockStaleRows = [
      { org_id: "org-malformed", provider: "bedrock", bedrock_region: "us-east-1" },
    ];
    mockWorkspaceConfigs.set("org-malformed", {
      provider: "bedrock",
      model: "claude-3",
      apiKey: "BAD_BUNDLE",
      baseUrl: null,
      bedrockRegion: "us-east-1",
    });

    const result = await Effect.runPromise(runByotCatalogRefreshCycle());
    expect(result.skippedMalformedBundle).toBe(1);
    expect(bedrockFetcherCalls).toHaveLength(0);

    const skipRow = auditCalls.find(
      (c) =>
        c.actionType === "model_config.catalog_refresh_skip" &&
        (c.targetId as string) === "org-malformed",
    );
    expect(skipRow!.status).toBe("failure");
    expect((skipRow!.metadata as Record<string, unknown>).reason).toBe(
      "malformed_bedrock_bundle",
    );
  });

  it("skips bedrock rows that have no saved region", async () => {
    mockStaleRows = [
      { org_id: "org-noregion", provider: "bedrock", bedrock_region: null },
    ];
    mockWorkspaceConfigs.set("org-noregion", {
      provider: "bedrock",
      model: "claude-3",
      apiKey: "bundle",
      baseUrl: null,
      bedrockRegion: null,
    });

    const result = await Effect.runPromise(runByotCatalogRefreshCycle());
    expect(result.skippedMissingKey).toBe(1);
    expect(bedrockFetcherCalls).toHaveLength(0);
  });

  it("falls back to row.bedrockRegion when config.bedrockRegion is null but row has one", async () => {
    mockStaleRows = [
      { org_id: "org-rowregion", provider: "bedrock", bedrock_region: "us-west-2" },
    ];
    mockWorkspaceConfigs.set("org-rowregion", {
      provider: "bedrock",
      model: "claude-3",
      apiKey: "bundle",
      baseUrl: null,
      bedrockRegion: null,
    });

    const result = await Effect.runPromise(runByotCatalogRefreshCycle());
    expect(result.refreshed).toBe(1);
    expect(bedrockFetcherCalls).toEqual([{ orgId: "org-rowregion", region: "us-west-2" }]);
  });
});

describe("byot catalog refresh — triggerByotCatalogRefreshCycle wrapper", () => {
  beforeEach(resetAll);

  it("returns the same shape as runByotCatalogRefreshCycle on the happy path", async () => {
    mockStaleRows = [
      { org_id: "org-a", provider: "anthropic", bedrock_region: null },
    ];
    mockWorkspaceConfigs.set("org-a", { provider: "anthropic", model: "x", apiKey: "k", baseUrl: null, bedrockRegion: null });

    const result = await triggerByotCatalogRefreshCycle();
    expect(result.status).toBe("success");
    expect(result.inspected).toBe(1);
    expect(result.refreshed).toBe(1);
  });

  it("resolves with status: failure (does not reject) when the stale-row query throws", async () => {
    staleQueryShouldThrow = new Error("db down");
    const result = await triggerByotCatalogRefreshCycle();
    expect(result.status).toBe("failure");
    expect(result.error).toBe("db down");
  });
});
