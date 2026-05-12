/**
 * L1↔L2 wiring contract for the BYOT discovery catalogs.
 *
 * Mocks `byot-catalog-store` wholesale so the wiring is observable end-to-end
 * through each per-provider catalog. Anthropic carries the full case-set;
 * openai/bedrock get parallel smokes scoped to provider-specific divergences
 * (notably bedrock's per-region L2 key). Safe to run without an internal DB —
 * `hasInternalDB()` is never consulted because the store is mocked at load.
 */

import { afterEach, beforeEach, describe, expect, test, mock } from "bun:test";
import type { GatewayCatalogModel, BedrockRegion } from "@useatlas/types";
import type {
  ByotProviderKey,
  PersistedCatalog,
} from "@atlas/api/lib/byot-catalog-store";

type FetchFn = typeof globalThis.fetch;
const realFetch: FetchFn = globalThis.fetch;

// Distinct error class so a fixture rejection is visually separable from a
// genuine upstream failure after the catalog's own try/catch normalizes it
// into `*CatalogUnavailable`.
class TestFixtureViolation extends Error {
  readonly _tag = "TestFixtureViolation";
}

let loadFromDBResult: PersistedCatalog | null = null;
let isFreshResult = false;

const loadFromDBSpy = mock(
  async (
    _orgId: string,
    _provider: ByotProviderKey,
    _region?: string,
  ): Promise<PersistedCatalog | null> => loadFromDBResult,
);
const storeToDBSpy = mock(
  async (
    _orgId: string,
    _provider: ByotProviderKey,
    _region: string,
    _persisted: PersistedCatalog,
  ): Promise<void> => {},
);
const deleteFromDBSpy = mock(
  async (_orgId: string, _provider: ByotProviderKey): Promise<void> => {},
);
const isFreshSpy = mock(
  (_persisted: PersistedCatalog, _ttlMs: number): boolean => isFreshResult,
);

// Factory must be sync — async mock.module factories with inner awaits
// deadlock the bun loader.
mock.module("@atlas/api/lib/byot-catalog-store", () => ({
  loadFromDB: loadFromDBSpy,
  storeToDB: storeToDBSpy,
  deleteFromDB: deleteFromDBSpy,
  isFresh: isFreshSpy,
}));

let bedrockSendPayload: { modelSummaries: unknown[] } | null = null;
const bedrockSendSpy = mock(async (_command: { $name: string }) => {
  if (!bedrockSendPayload) {
    throw new TestFixtureViolation("bedrock send mock outcome not configured");
  }
  return bedrockSendPayload;
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

const {
  __resetAnthropicCatalogCacheForTests,
  getAnthropicCatalog,
  invalidateAnthropicCatalog,
} = await import("../anthropic-catalog");
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

// "Yesterday" so wall-clock can't accidentally satisfy a real TTL window if
// isFresh ever gets bypassed.
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
  ...ANTHROPIC_PERSISTED,
  id: "gpt-4o",
  name: "gpt-4o",
  provider: "openai",
};

const BEDROCK_PERSISTED: GatewayCatalogModel = {
  ...ANTHROPIC_PERSISTED,
  id: "anthropic.claude-opus-4-7",
  provider: "bedrock",
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
    throw new TestFixtureViolation(
      "fetch unexpectedly called — L2-hit branch should short-circuit",
    );
  }) as unknown as FetchFn;
}

function resetSharedState() {
  loadFromDBResult = null;
  isFreshResult = false;
  bedrockSendPayload = null;
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
    expect(loadFromDBSpy.mock.calls[0][0]).toBe(ORG);
    expect(loadFromDBSpy.mock.calls[0][1]).toBe("anthropic");
    expect(isFreshSpy).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(storeToDBSpy).not.toHaveBeenCalled();
  });

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

  test("stale L2 (isFresh=false) → upstream fetch + L2 writeback + populates L1", async () => {
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

    // Fresh-write path must populate L1 — dropping cache.set on the fresh
    // branch would let upstream get hammered until L2 takes over.
    const second = await getAnthropicCatalog(ORG, ANTHROPIC_KEY);
    expect(second.source).toBe("cache");
    expect(loadFromDBSpy).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(storeToDBSpy).toHaveBeenCalledTimes(1);
  });

  test("missing L2 (loadFromDB → null) → upstream fetch + L2 writeback + populates L1", async () => {
    loadFromDBResult = null;

    const fetchMock = mockFetchOk({
      data: [{ type: "model", id: "claude-haiku-4-5", display_name: "Claude Haiku 4.5" }],
    });
    globalThis.fetch = fetchMock;

    const res = await getAnthropicCatalog(ORG, ANTHROPIC_KEY);

    expect(res.source).toBe("fresh");
    expect(res.models[0].id).toBe("claude-haiku-4-5");
    expect(loadFromDBSpy).toHaveBeenCalledTimes(1);
    // null payload short-circuits the isFresh check entirely.
    expect(isFreshSpy).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(storeToDBSpy).toHaveBeenCalledTimes(1);
    expect(storeToDBSpy.mock.calls[0][1]).toBe("anthropic");

    // Same L1-population guarantee as the stale-L2 case.
    const second = await getAnthropicCatalog(ORG, ANTHROPIC_KEY);
    expect(second.source).toBe("cache");
    expect(loadFromDBSpy).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("persist: false skips both L2 read and L2 write but still fetches upstream", async () => {
    loadFromDBResult = { models: [ANTHROPIC_PERSISTED], fetchedAt: PERSISTED_FETCHED_AT };
    isFreshResult = true;

    const fetchMock = mockFetchOk({
      data: [{ type: "model", id: "claude-sonnet-4-6", display_name: "Claude Sonnet 4.6" }],
    });
    globalThis.fetch = fetchMock;

    const res = await getAnthropicCatalog(ORG, ANTHROPIC_KEY, { persist: false });

    expect(res.source).toBe("fresh");
    expect(res.models[0].id).toBe("claude-sonnet-4-6");
    expect(loadFromDBSpy).not.toHaveBeenCalled();
    expect(storeToDBSpy).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("invalidateAnthropicCatalog flushes L1 and fires L2 delete", async () => {
    loadFromDBResult = { models: [ANTHROPIC_PERSISTED], fetchedAt: PERSISTED_FETCHED_AT };
    isFreshResult = true;
    globalThis.fetch = mockFetchThatFailsIfCalled();

    const warm = await getAnthropicCatalog(ORG, ANTHROPIC_KEY);
    expect(warm.source).toBe("cache");

    invalidateAnthropicCatalog(ORG);

    // L2 delete is fire-and-forget but the spy registers the call sync.
    expect(deleteFromDBSpy).toHaveBeenCalledTimes(1);
    expect(deleteFromDBSpy.mock.calls[0][0]).toBe(ORG);
    expect(deleteFromDBSpy.mock.calls[0][1]).toBe("anthropic");
  });
});

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
    expect(loadFromDBSpy).toHaveBeenCalledTimes(1);
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

    const res = await getBedrockCatalog(ORG, BEDROCK_REGION, BEDROCK_CREDS);

    expect(res.source).toBe("cache");
    expect(res.region).toBe(BEDROCK_REGION);
    expect(loadFromDBSpy).toHaveBeenCalledTimes(1);
    expect(loadFromDBSpy.mock.calls[0][1]).toBe("bedrock");
    expect(loadFromDBSpy.mock.calls[0][2]).toBe(BEDROCK_REGION);
    expect(bedrockSendSpy).not.toHaveBeenCalled();
    expect(storeToDBSpy).not.toHaveBeenCalled();
  });

  test("missing L2 → upstream SDK call + L2 writeback with region key + populates L1", async () => {
    loadFromDBResult = null;
    bedrockSendPayload = {
      modelSummaries: [
        {
          modelId: "anthropic.claude-opus-4-7",
          modelName: "Claude Opus 4.7",
          providerName: "Anthropic",
          outputModalities: ["TEXT"],
        },
      ],
    };

    const res = await getBedrockCatalog(ORG, BEDROCK_REGION, BEDROCK_CREDS);

    expect(res.source).toBe("fresh");
    expect(bedrockSendSpy).toHaveBeenCalledTimes(1);
    expect(storeToDBSpy).toHaveBeenCalledTimes(1);
    expect(storeToDBSpy.mock.calls[0][1]).toBe("bedrock");
    // Region rides on the L2 upsert key so multi-region workspaces don't
    // collide on read.
    expect(storeToDBSpy.mock.calls[0][2]).toBe(BEDROCK_REGION);

    // Fresh-write path must populate L1 (keyed by `${orgId}:${region}`).
    const second = await getBedrockCatalog(ORG, BEDROCK_REGION, BEDROCK_CREDS);
    expect(second.source).toBe("cache");
    expect(bedrockSendSpy).toHaveBeenCalledTimes(1);
    expect(storeToDBSpy).toHaveBeenCalledTimes(1);
  });
});
