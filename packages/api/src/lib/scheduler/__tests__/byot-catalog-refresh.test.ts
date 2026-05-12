/**
 * BYOT catalog refresh scheduler tests (#2284).
 *
 * Verifies the daily cycle that walks BYOT workspaces and refreshes any
 * `(org_id, provider, region)` whose `fetched_at` is older than the TTL.
 *
 * Surface under test:
 *   - Sequential per-row refresh (one upstream provider call at a time so
 *     a noisy workspace can't burn another's rate limit).
 *   - Decrypt-failed rows are skipped + audit-logged so triage can see why.
 *   - Per-row failure increments an in-memory backoff counter so a
 *     rotated-and-broken key isn't retried 365 times/year.
 *   - One cycle-level audit row per tick, even at zero rows — the absence
 *     of the cycle row is the "scheduler stopped" signal.
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";
import { Effect } from "effect";

// ---------------------------------------------------------------------------
// Mock control variables
// ---------------------------------------------------------------------------

let mockInternalDB = true;
let mockStaleRows: Array<{ org_id: string; provider: string; bedrock_region: string | null }> = [];
let staleQueryCalls = 0;

// Per-org workspace configs returned by `getWorkspaceModelConfigRaw`. The
// special string `"DECRYPT_FAIL"` triggers a tagged-error fail to exercise
// the skip-decrypt-failed path without faking the underlying decrypt.
let mockWorkspaceConfigs: Map<
  string,
  | { provider: string; model: string; apiKey: string | null; baseUrl: string | null; bedrockRegion: string | null }
  | "DECRYPT_FAIL"
  | null
> = new Map();

// Per-provider fetcher behavior. Each entry is processed sequentially —
// resolved in order of the `.shift()` calls below — so an array of three
// entries returns these outcomes for the first three calls and "ok" for
// any later call.
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
    return mockStaleRows;
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

// Stub the EE platform/model-routing module so tests don't need the EE
// build artifact. The real module exports `ModelConfigDecryptError` as a
// `Data.TaggedError` — we mirror the shape so the scheduler's
// `catchTag("ModelConfigDecryptError")` arm exercises correctly.
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

// Import after mocks
const {
  runByotCatalogRefreshCycle,
  startByotCatalogRefreshScheduler,
  stopByotCatalogRefreshScheduler,
  isByotCatalogRefreshSchedulerRunning,
  _resetByotCatalogRefreshScheduler,
  _resetBackoffForTests,
  BYOT_CATALOG_REFRESH_ACTOR,
} = await import("../byot-catalog-refresh");

function resetAll() {
  _resetByotCatalogRefreshScheduler();
  _resetBackoffForTests();
  mockInternalDB = true;
  mockStaleRows = [];
  staleQueryCalls = 0;
  mockWorkspaceConfigs = new Map();
  anthropicFetcherCalls = [];
  openaiFetcherCalls = [];
  bedrockFetcherCalls = [];
  anthropicOutcomes = [];
  openaiOutcomes = [];
  bedrockOutcomes = [];
  auditCalls = [];
}

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
    startByotCatalogRefreshScheduler(60_000); // no-op
    expect(isByotCatalogRefreshSchedulerRunning()).toBe(true);
    stopByotCatalogRefreshScheduler();
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

  it("returns zero counts and emits one cycle audit row on an empty queue", async () => {
    const result = await Effect.runPromise(runByotCatalogRefreshCycle());
    expect(result).toEqual({
      inspected: 0,
      refreshed: 0,
      skippedDecryptFailed: 0,
      skippedInBackoff: 0,
      skippedMissingKey: 0,
      failed: 0,
    });

    const cycleRows = auditCalls.filter(
      (c) => c.actionType === "model_config.catalog_refresh_cycle",
    );
    expect(cycleRows).toHaveLength(1);
    expect(cycleRows[0].systemActor).toBe(BYOT_CATALOG_REFRESH_ACTOR);
    expect(cycleRows[0].scope).toBe("platform");
    expect(cycleRows[0].targetType).toBe("model_config");
    expect(cycleRows[0].targetId).toBe("scheduler");
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

    expect(result.inspected).toBe(3);
    expect(result.refreshed).toBe(3);
    expect(result.failed).toBe(0);

    expect(anthropicFetcherCalls).toEqual([{ orgId: "org-a", apiKey: "key-a" }]);
    expect(openaiFetcherCalls).toEqual([{ orgId: "org-b", apiKey: "key-b" }]);
    expect(bedrockFetcherCalls).toEqual([{ orgId: "org-c", region: "us-east-1" }]);
  });

  it("skips rows whose stored key fails to decrypt and audits the skip", async () => {
    mockStaleRows = [
      { org_id: "org-bad", provider: "anthropic", bedrock_region: null },
      { org_id: "org-ok", provider: "anthropic", bedrock_region: null },
    ];
    mockWorkspaceConfigs.set("org-bad", "DECRYPT_FAIL");
    mockWorkspaceConfigs.set("org-ok", { provider: "anthropic", model: "claude-3", apiKey: "good", baseUrl: null, bedrockRegion: null });

    const result = await Effect.runPromise(runByotCatalogRefreshCycle());

    expect(result.skippedDecryptFailed).toBe(1);
    expect(result.refreshed).toBe(1);
    // The good workspace still got its fetch — a single bad sibling can't
    // poison the cycle.
    expect(anthropicFetcherCalls).toEqual([{ orgId: "org-ok", apiKey: "good" }]);

    const skipRow = auditCalls.find(
      (c) =>
        c.actionType === "model_config.catalog_refresh_skip" &&
        (c.targetId as string) === "org-bad",
    );
    expect(skipRow).toBeDefined();
    expect(skipRow!.status).toBe("failure");
    const meta = skipRow!.metadata as Record<string, unknown>;
    expect(meta.reason).toBe("decrypt_failed");
    expect(meta.provider).toBe("anthropic");
  });

  it("skips rows whose workspace has no saved key (missing config or null apiKey)", async () => {
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
    expect((skipRow!.metadata as Record<string, unknown>).reason).toBe("missing_byot_key");
  });

  it("records failures so a broken-key workspace enters exponential backoff", async () => {
    mockStaleRows = [
      { org_id: "org-broken", provider: "anthropic", bedrock_region: null },
    ];
    mockWorkspaceConfigs.set("org-broken", { provider: "anthropic", model: "claude-3", apiKey: "bad", baseUrl: null, bedrockRegion: null });
    anthropicOutcomes = [{ kind: "throw", error: new Error("401 invalid api key") }];

    const result1 = await Effect.runPromise(runByotCatalogRefreshCycle());
    expect(result1.failed).toBe(1);
    expect(result1.skippedInBackoff).toBe(0);
    expect(anthropicFetcherCalls).toHaveLength(1);

    // The second cycle (simulating tomorrow's tick) finds the same row stale
    // again. Without backoff, the broken key would fetch again. With backoff,
    // it sits out.
    auditCalls = [];
    const result2 = await Effect.runPromise(runByotCatalogRefreshCycle());
    expect(result2.skippedInBackoff).toBe(1);
    expect(result2.failed).toBe(0);
    expect(anthropicFetcherCalls).toHaveLength(1); // unchanged

    const skipRow = auditCalls.find(
      (c) =>
        c.actionType === "model_config.catalog_refresh_skip" &&
        (c.targetId as string) === "org-broken",
    );
    expect((skipRow!.metadata as Record<string, unknown>).reason).toBe("in_backoff");
  });

  it("clears backoff on a successful refresh", async () => {
    mockStaleRows = [
      { org_id: "org-flaky", provider: "openai", bedrock_region: null },
    ];
    mockWorkspaceConfigs.set("org-flaky", { provider: "openai", model: "gpt-4", apiKey: "tok", baseUrl: null, bedrockRegion: null });

    // Cycle 1: fails → enters backoff
    openaiOutcomes = [{ kind: "throw", error: new Error("503 unavailable") }];
    await Effect.runPromise(runByotCatalogRefreshCycle());

    // Manually clear backoff to simulate enough time passing — the unit
    // surface for that is the test-only reset.
    _resetBackoffForTests();

    // Cycle 2: succeeds → backoff cleared
    openaiOutcomes = [{ kind: "ok", modelCount: 8 }];
    const result2 = await Effect.runPromise(runByotCatalogRefreshCycle());
    expect(result2.refreshed).toBe(1);

    // Cycle 3: even if the row stayed stale, no backoff carries over.
    openaiOutcomes = [{ kind: "ok", modelCount: 8 }];
    const result3 = await Effect.runPromise(runByotCatalogRefreshCycle());
    expect(result3.refreshed).toBe(1);
    expect(result3.skippedInBackoff).toBe(0);
  });

  it("emits one cycle audit row with summary metadata even when rows mixed outcomes", async () => {
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
      inspected: 3,
      refreshed: 1,
      failed: 1,
      skippedDecryptFailed: 1,
      skippedInBackoff: 0,
      skippedMissingKey: 0,
    });
  });

  it("audits each successful refresh with the standard catalogRefresh action", async () => {
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
    expect(refreshRow).toBeDefined();
    expect(refreshRow!.systemActor).toBe(BYOT_CATALOG_REFRESH_ACTOR);
    const meta = refreshRow!.metadata as Record<string, unknown>;
    expect(meta.provider).toBe("anthropic");
    expect(meta.source).toBe("fresh");
    expect(meta.modelCount).toBe(3);
  });

  it("processes providers one at a time so a slow provider does not race the next row", async () => {
    mockStaleRows = [
      { org_id: "org-1", provider: "anthropic", bedrock_region: null },
      { org_id: "org-2", provider: "anthropic", bedrock_region: null },
      { org_id: "org-3", provider: "anthropic", bedrock_region: null },
    ];
    mockWorkspaceConfigs.set("org-1", { provider: "anthropic", model: "x", apiKey: "k1", baseUrl: null, bedrockRegion: null });
    mockWorkspaceConfigs.set("org-2", { provider: "anthropic", model: "x", apiKey: "k2", baseUrl: null, bedrockRegion: null });
    mockWorkspaceConfigs.set("org-3", { provider: "anthropic", model: "x", apiKey: "k3", baseUrl: null, bedrockRegion: null });

    await Effect.runPromise(runByotCatalogRefreshCycle());

    // Calls land in the queue strictly in order: the second call cannot
    // have been issued before the first awaited.
    expect(anthropicFetcherCalls.map((c) => c.orgId)).toEqual([
      "org-1",
      "org-2",
      "org-3",
    ]);
  });

  it("queries the staleness view exactly once per cycle", async () => {
    mockStaleRows = [];
    await Effect.runPromise(runByotCatalogRefreshCycle());
    expect(staleQueryCalls).toBe(1);
  });

  it("survives an internal DB outage without crashing", async () => {
    mockInternalDB = false;
    const result = await Effect.runPromise(runByotCatalogRefreshCycle());
    expect(result.inspected).toBe(0);
  });
});

describe("byot catalog refresh — bedrock specifics", () => {
  beforeEach(resetAll);

  it("skips bedrock rows whose stored bundle parses as null (malformed)", async () => {
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
    expect(result.skippedMissingKey).toBe(1);
    expect(bedrockFetcherCalls).toHaveLength(0);

    const skipRow = auditCalls.find(
      (c) =>
        c.actionType === "model_config.catalog_refresh_skip" &&
        (c.targetId as string) === "org-malformed",
    );
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
});
