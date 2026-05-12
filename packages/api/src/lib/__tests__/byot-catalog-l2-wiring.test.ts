/**
 * L1↔L2 wiring contract for the BYOT discovery catalogs (#2287).
 *
 * Per-provider tests (`anthropic-catalog.test.ts`, `openai-catalog.test.ts`,
 * `bedrock-catalog.test.ts`) don't mock `byot-catalog-store`, so the store
 * silently no-ops in test runs (no internal DB → `hasInternalDB()` returns
 * false). Store tests (`byot-catalog-store.test.ts`) mock `db/internal` but
 * never thread through a per-provider catalog module. A regression that
 * dropped `cache.set(orgId, …)` on the L2-hit branch, or skipped
 * `storeToDB` on the upstream-fresh branch, would ship green under that
 * split.
 *
 * This file closes that gap. It mocks the store module wholesale, observes
 * `fetch` directly, and asserts the four wiring properties that matter:
 *   1. Warm L2 → returns `source: "cache"` AND upstream is never called.
 *   2. Warm L2 → L1 is populated (next call doesn't hit `loadFromDB`).
 *   3. Stale L2 (`isFresh=false`) → upstream IS called AND L2 is rewritten.
 *   4. Cold L2 (`loadFromDB → null`) → upstream IS called AND L2 is written.
 *
 * Anthropic is the representative — openai/bedrock are structural copies of
 * the same control flow, so a single parallel smoke per provider keeps the
 * regression surface honest without duplicating every case. The parallel
 * imports also let `scripts/test-isolated.ts --affected` pick this file up
 * when any of the four wired modules change.
 *
 * Passes locally with no internal DB configured: `byot-catalog-store` is
 * mocked at module-load time, so the real `hasInternalDB()` is never
 * consulted.
 */

import { afterEach, beforeEach, describe, expect, test, mock } from "bun:test";
import type { GatewayCatalogModel } from "@useatlas/types";
import type { BedrockRegion } from "@useatlas/types";

type FetchFn = typeof globalThis.fetch;
const realFetch: FetchFn = globalThis.fetch;

type StoredPayload = { models: GatewayCatalogModel[]; fetchedAt: string };
type LoadResult = StoredPayload | null;

// Per-test mutable state. The mock factory is sync (CLAUDE.md feedback:
// async factories with inner awaits deadlock the bun loader), so we
// forward into closure-captured variables instead.
let loadFromDBResult: LoadResult = null;
let isFreshResult = false;

const loadFromDBSpy = mock(
  async (_orgId: string, _provider: string, _region?: string): Promise<LoadResult> =>
    loadFromDBResult,
);
const storeToDBSpy = mock(
  async (
    _orgId: string,
    _provider: string,
    _region: string,
    _persisted: StoredPayload,
  ): Promise<void> => {},
);
const deleteFromDBSpy = mock(
  async (_orgId: string, _provider: string): Promise<void> => {},
);
const isFreshSpy = mock(
  (_persisted: StoredPayload, _ttlMs: number): boolean => isFreshResult,
);

// Mock every named export of `byot-catalog-store` — partial-mock SyntaxError
// trap from CLAUDE.md. The store is the only seam the per-provider catalogs
// touch for L2, so this is the entire surface we need to control.
mock.module("@atlas/api/lib/byot-catalog-store", () => ({
  loadFromDB: loadFromDBSpy,
  storeToDB: storeToDBSpy,
  deleteFromDB: deleteFromDBSpy,
  isFresh: isFreshSpy,
}));

// AWS SDK mock for the bedrock smoke. Bedrock doesn't go through `fetch`,
// so we substitute the SDK client wholesale to observe upstream calls.
let bedrockSendOutcome: { kind: "ok"; payload: { modelSummaries: unknown[] } } | null = null;
const bedrockSendSpy = mock(async (_command: { $name: string }) => {
  if (!bedrockSendOutcome) throw new Error("bedrock send mock outcome not configured");
  return bedrockSendOutcome.payload;
});

class MockListFoundationModelsCommand {
  readonly $name = "ListFoundationModelsCommand";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirrors AWS SDK v3 command surface
  constructor(public readonly input: any) {}
}

class MockBedrockClient {
  readonly region: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirrors AWS SDK v3 BedrockClient constructor
  constructor(opts: any) {
    this.region = opts.region;
  }
  async send(command: MockListFoundationModelsCommand) {
    return bedrockSendSpy(command);
  }
  destroy() {}
}

mock.module("@aws-sdk/client-bedrock", () => ({
  BedrockClient: MockBedrockClient,
  ListFoundationModelsCommand: MockListFoundationModelsCommand,
}));

const { __resetAnthropicCatalogCacheForTests, getAnthropicCatalog } = await import(
  "../anthropic-catalog"
);
const { __resetOpenAICatalogCacheForTests, getOpenAICatalog } = await import(
  "../openai-catalog"
);
const { __resetBedrockCatalogCacheForTests, getBedrockCatalog } = await import(
  "../bedrock-catalog"
);

const ORG = "org_l2_wiring";
const ANTHROPIC_KEY = "sk-ant-test-key";
const OPENAI_KEY = "sk-openai-test-key";
const BEDROCK_CREDS = { accessKeyId: "AKIA-TEST", secretAccessKey: "secret-test" };
const BEDROCK_REGION: BedrockRegion = "us-east-1";

// Stored "yesterday" so the wall-clock value can't accidentally satisfy a
// real TTL window if the mock for `isFresh` ever gets bypassed.
const PERSISTED_FETCHED_AT = new Date(Date.now() - 60 * 60 * 1000).toISOString();

const ANTHROPIC_PERSISTED: GatewayCatalogModel = {
  id: "claude-opus-4-7",
  name: "Claude Opus 4.7",
  provider: "anthropic",
  type: "language",
  contextWindow: null,
  maxOutputTokens: null,
  inputPrice: null,
  outputPrice: null,
  recommended: true,
};

const OPENAI_PERSISTED: GatewayCatalogModel = {
  id: "gpt-4o",
  name: "gpt-4o",
  provider: "openai",
  type: "language",
  contextWindow: null,
  maxOutputTokens: null,
  inputPrice: null,
  outputPrice: null,
  recommended: true,
};

const BEDROCK_PERSISTED: GatewayCatalogModel = {
  id: "anthropic.claude-opus-4-7",
  name: "Claude Opus 4.7",
  provider: "bedrock",
  type: "language",
  contextWindow: null,
  maxOutputTokens: null,
  inputPrice: null,
  outputPrice: null,
  recommended: true,
};

function mockFetchOk(body: unknown): FetchFn {
  return mock(
    async (): Promise<Response> =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  ) as unknown as FetchFn;
}

function mockFetchThatFailsIfCalled(): FetchFn {
  return mock(async (): Promise<Response> => {
    throw new Error("fetch unexpectedly called — L2-hit branch should short-circuit");
  }) as unknown as FetchFn;
}

function resetSharedState() {
  loadFromDBResult = null;
  isFreshResult = false;
  bedrockSendOutcome = null;
  loadFromDBSpy.mockClear();
  storeToDBSpy.mockClear();
  deleteFromDBSpy.mockClear();
  isFreshSpy.mockClear();
  bedrockSendSpy.mockClear();
  __resetAnthropicCatalogCacheForTests();
  __resetOpenAICatalogCacheForTests();
  __resetBedrockCatalogCacheForTests();
}

describe("byot-catalog L1↔L2 wiring (anthropic representative)", () => {
  beforeEach(() => resetSharedState());

  afterEach(() => {
    globalThis.fetch = realFetch;
    resetSharedState();
  });

  // Case 1 — Cold L1 + warm L2 → returns source: "cache" AND fetch was never called.
  test("warm L2 returns source='cache' and skips upstream fetch", async () => {
    loadFromDBResult = { models: [ANTHROPIC_PERSISTED], fetchedAt: PERSISTED_FETCHED_AT };
    isFreshResult = true;

    const fetchMock = mockFetchThatFailsIfCalled();
    globalThis.fetch = fetchMock;

    const res = await getAnthropicCatalog(ORG, ANTHROPIC_KEY);

    expect(res.source).toBe("cache");
    expect(res.fetchedAt).toBe(PERSISTED_FETCHED_AT);
    expect(res.models).toHaveLength(1);
    expect(res.models[0].id).toBe("claude-opus-4-7");
    expect(loadFromDBSpy).toHaveBeenCalledTimes(1);
    expect(loadFromDBSpy.mock.calls[0][1]).toBe("anthropic");
    expect(isFreshSpy).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(storeToDBSpy).not.toHaveBeenCalled();
  });

  // Case 2 — Cold L1 + warm L2 → L1 is populated (subsequent calls don't hit loadFromDB).
  test("warm L2 hit populates L1 — second call short-circuits before loadFromDB", async () => {
    loadFromDBResult = { models: [ANTHROPIC_PERSISTED], fetchedAt: PERSISTED_FETCHED_AT };
    isFreshResult = true;

    const fetchMock = mockFetchThatFailsIfCalled();
    globalThis.fetch = fetchMock;

    const first = await getAnthropicCatalog(ORG, ANTHROPIC_KEY);
    const second = await getAnthropicCatalog(ORG, ANTHROPIC_KEY);

    expect(first.source).toBe("cache");
    expect(second.source).toBe("cache");
    expect(loadFromDBSpy).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // Case 3 — L2 freshness boundary: isFresh=false → fetch IS called AND storeToDB IS called.
  test("stale L2 (isFresh=false) falls through to upstream fetch + writes L2 back", async () => {
    loadFromDBResult = { models: [ANTHROPIC_PERSISTED], fetchedAt: PERSISTED_FETCHED_AT };
    isFreshResult = false;

    const fetchMock = mockFetchOk({
      data: [{ type: "model", id: "claude-sonnet-4-6", display_name: "Claude Sonnet 4.6" }],
    });
    globalThis.fetch = fetchMock;

    const res = await getAnthropicCatalog(ORG, ANTHROPIC_KEY);

    expect(res.source).toBe("fresh");
    expect(res.models[0].id).toBe("claude-sonnet-4-6");
    expect(loadFromDBSpy).toHaveBeenCalledTimes(1);
    expect(isFreshSpy).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(storeToDBSpy).toHaveBeenCalledTimes(1);

    const [argOrg, argProvider, argRegion, argPayload] = storeToDBSpy.mock.calls[0];
    expect(argOrg).toBe(ORG);
    expect(argProvider).toBe("anthropic");
    expect(argRegion).toBe("");
    expect(argPayload.models[0].id).toBe("claude-sonnet-4-6");
  });

  // Case 4 — Cold L2 (loadFromDB → null) → fetch + storeToDB called.
  test("missing L2 (loadFromDB → null) → upstream fetch + storeToDB writeback", async () => {
    loadFromDBResult = null;

    const fetchMock = mockFetchOk({
      data: [{ type: "model", id: "claude-haiku-4-5", display_name: "Claude Haiku 4.5" }],
    });
    globalThis.fetch = fetchMock;

    const res = await getAnthropicCatalog(ORG, ANTHROPIC_KEY);

    expect(res.source).toBe("fresh");
    expect(res.models[0].id).toBe("claude-haiku-4-5");
    expect(loadFromDBSpy).toHaveBeenCalledTimes(1);
    // isFresh is only invoked when loadFromDB returned a non-null payload —
    // null short-circuits the freshness check entirely.
    expect(isFreshSpy).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(storeToDBSpy).toHaveBeenCalledTimes(1);
    expect(storeToDBSpy.mock.calls[0][1]).toBe("anthropic");
  });
});

// openai/bedrock are structural copies of the anthropic control flow. A
// minimal parallel smoke per provider is enough to catch a regression
// scoped to one of those files — and the imports above ensure
// `--affected` includes this test on changes to either module.
describe("byot-catalog L1↔L2 wiring — openai parallel smoke", () => {
  beforeEach(() => resetSharedState());
  afterEach(() => {
    globalThis.fetch = realFetch;
    resetSharedState();
  });

  test("warm L2 returns 'cache' and skips upstream", async () => {
    loadFromDBResult = { models: [OPENAI_PERSISTED], fetchedAt: PERSISTED_FETCHED_AT };
    isFreshResult = true;

    const fetchMock = mockFetchThatFailsIfCalled();
    globalThis.fetch = fetchMock;

    const res = await getOpenAICatalog(ORG, OPENAI_KEY);

    expect(res.source).toBe("cache");
    expect(loadFromDBSpy.mock.calls[0][1]).toBe("openai");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(storeToDBSpy).not.toHaveBeenCalled();
  });

  test("missing L2 → upstream fetch + storeToDB writeback", async () => {
    loadFromDBResult = null;

    const fetchMock = mockFetchOk({ data: [{ id: "gpt-4o" }] });
    globalThis.fetch = fetchMock;

    const res = await getOpenAICatalog(ORG, OPENAI_KEY);

    expect(res.source).toBe("fresh");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(storeToDBSpy).toHaveBeenCalledTimes(1);
    expect(storeToDBSpy.mock.calls[0][1]).toBe("openai");
    expect(storeToDBSpy.mock.calls[0][2]).toBe("");
  });
});

describe("byot-catalog L1↔L2 wiring — bedrock parallel smoke", () => {
  beforeEach(() => resetSharedState());
  afterEach(() => {
    globalThis.fetch = realFetch;
    resetSharedState();
  });

  test("warm L2 returns 'cache' and skips upstream SDK call", async () => {
    loadFromDBResult = { models: [BEDROCK_PERSISTED], fetchedAt: PERSISTED_FETCHED_AT };
    isFreshResult = true;
    // Leave bedrockSendOutcome null so a stray SDK call would throw loudly.

    const res = await getBedrockCatalog(ORG, BEDROCK_REGION, BEDROCK_CREDS);

    expect(res.source).toBe("cache");
    expect(res.region).toBe(BEDROCK_REGION);
    expect(loadFromDBSpy.mock.calls[0][1]).toBe("bedrock");
    expect(loadFromDBSpy.mock.calls[0][2]).toBe(BEDROCK_REGION);
    expect(bedrockSendSpy).not.toHaveBeenCalled();
    expect(storeToDBSpy).not.toHaveBeenCalled();
  });

  test("missing L2 → upstream SDK call + storeToDB writeback with region key", async () => {
    loadFromDBResult = null;
    bedrockSendOutcome = {
      kind: "ok",
      payload: {
        modelSummaries: [
          {
            modelId: "anthropic.claude-opus-4-7",
            modelName: "Claude Opus 4.7",
            providerName: "Anthropic",
            outputModalities: ["TEXT"],
          },
        ],
      },
    };

    const res = await getBedrockCatalog(ORG, BEDROCK_REGION, BEDROCK_CREDS);

    expect(res.source).toBe("fresh");
    expect(bedrockSendSpy).toHaveBeenCalledTimes(1);
    expect(storeToDBSpy).toHaveBeenCalledTimes(1);
    expect(storeToDBSpy.mock.calls[0][1]).toBe("bedrock");
    // Region rides on the L2 upsert key so multi-region workspaces don't
    // collide. A regression that wrote `""` instead would shadow a real
    // region's catalog on the next read.
    expect(storeToDBSpy.mock.calls[0][2]).toBe(BEDROCK_REGION);
  });
});
