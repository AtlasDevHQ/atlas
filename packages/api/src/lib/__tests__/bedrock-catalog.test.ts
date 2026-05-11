/**
 * Bedrock catalog unit tests (#2273).
 *
 * The AWS SDK `BedrockClient` is heavy to stand up in a unit test, so we
 * mock the module via `mock.module()`. Every named export the catalog
 * module imports must be mirrored in the mock to avoid the partial-mock
 * SyntaxError trap documented in CLAUDE.md.
 */

import { afterEach, beforeEach, describe, expect, test, mock } from "bun:test";

// --- AWS SDK mock (must be installed BEFORE importing the catalog).
type ListFoundationModelsResponse = {
  modelSummaries?: Array<{
    modelId?: string;
    modelName?: string;
    providerName?: string;
    outputModalities?: string[];
    modelLifecycle?: { status?: string };
  }>;
};
type ClientSendOutcome =
  | { kind: "ok"; payload: ListFoundationModelsResponse }
  | { kind: "throw"; err: Error };

let nextOutcome: ClientSendOutcome = { kind: "ok", payload: { modelSummaries: [] } };
let destroyCalls = 0;
const sendCalls: Array<{ region: string; commandName: string }> = [];

class MockListFoundationModelsCommand {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- shape mirrors AWS SDK v3 command surface; we only consume name + input
  constructor(public readonly input: any) {}
  readonly $name = "ListFoundationModelsCommand";
}

class MockBedrockClient {
  readonly region: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirrors AWS SDK v3 BedrockClient constructor shape
  constructor(opts: any) {
    this.region = opts.region;
  }
  async send(command: MockListFoundationModelsCommand) {
    sendCalls.push({ region: this.region, commandName: command.$name });
    if (nextOutcome.kind === "throw") throw nextOutcome.err;
    return nextOutcome.payload;
  }
  destroy() {
    destroyCalls += 1;
  }
}

mock.module("@aws-sdk/client-bedrock", () => ({
  BedrockClient: MockBedrockClient,
  ListFoundationModelsCommand: MockListFoundationModelsCommand,
}));

const {
  __resetBedrockCatalogCacheForTests,
  __getRecommendedBedrockIdsForTests,
  BedrockCatalogRateLimited,
  BedrockCatalogUnauthorized,
  BedrockCatalogUnavailable,
  getBedrockCatalog,
  invalidateBedrockCatalog,
} = await import("../bedrock-catalog");

const ORG_A = "org_a";
const ORG_B = "org_b";
const CREDS = { accessKeyId: "AKIA-FOO", secretAccessKey: "secret" };

function setOutcome(outcome: ClientSendOutcome) {
  nextOutcome = outcome;
}

describe("bedrock-catalog", () => {
  beforeEach(() => {
    __resetBedrockCatalogCacheForTests();
    sendCalls.length = 0;
    destroyCalls = 0;
    setOutcome({ kind: "ok", payload: { modelSummaries: [] } });
  });

  test("filters text-gen, non-LEGACY models and normalizes them", async () => {
    setOutcome({
      kind: "ok",
      payload: {
        modelSummaries: [
          // Kept.
          {
            modelId: "anthropic.claude-opus-4-v1:0",
            modelName: "Claude Opus 4",
            providerName: "Anthropic",
            outputModalities: ["TEXT"],
          },
          // Kept.
          {
            modelId: "amazon.titan-text-v1",
            modelName: "Titan Text",
            providerName: "Amazon",
            outputModalities: ["TEXT"],
          },
          // Filtered: image-gen.
          {
            modelId: "stability.stable-diffusion-xl",
            modelName: "Stable Diffusion XL",
            outputModalities: ["IMAGE"],
          },
          // Filtered: LEGACY.
          {
            modelId: "anthropic.claude-instant-v1",
            modelName: "Claude Instant",
            outputModalities: ["TEXT"],
            modelLifecycle: { status: "LEGACY" },
          },
          // Filtered: no modelId.
          { modelName: "phantom", outputModalities: ["TEXT"] },
        ],
      },
    });

    const res = await getBedrockCatalog(ORG_A, "us-east-1", CREDS);
    expect(res.source).toBe("fresh");
    expect(res.region).toBe("us-east-1");
    const ids = res.models.map((m) => m.id).sort();
    expect(ids).toEqual(["amazon.titan-text-v1", "anthropic.claude-opus-4-v1:0"]);
    const opus = res.models.find((m) => m.id === "anthropic.claude-opus-4-v1:0");
    expect(opus?.provider).toBe("anthropic");
    expect(opus?.recommended).toBe(true);
    expect(destroyCalls).toBe(1);
  });

  test("UnrecognizedClientException → BedrockCatalogUnauthorized", async () => {
    const err = new Error("rejected");
    err.name = "UnrecognizedClientException";
    setOutcome({ kind: "throw", err });
    await expect(getBedrockCatalog(ORG_A, "us-east-1", CREDS)).rejects.toBeInstanceOf(
      BedrockCatalogUnauthorized,
    );
  });

  test("AccessDeniedException → BedrockCatalogUnauthorized", async () => {
    const err = new Error("access denied");
    err.name = "AccessDeniedException";
    setOutcome({ kind: "throw", err });
    await expect(getBedrockCatalog(ORG_A, "us-east-1", CREDS)).rejects.toBeInstanceOf(
      BedrockCatalogUnauthorized,
    );
  });

  test("ThrottlingException → BedrockCatalogRateLimited", async () => {
    const err = new Error("throttled");
    err.name = "ThrottlingException";
    setOutcome({ kind: "throw", err });
    await expect(getBedrockCatalog(ORG_A, "us-east-1", CREDS)).rejects.toBeInstanceOf(
      BedrockCatalogRateLimited,
    );
  });

  test("metadata 403 routes to BedrockCatalogUnauthorized even for unknown exception names", async () => {
    const err = Object.assign(new Error("forbidden"), {
      name: "WeirdNewException",
      $metadata: { httpStatusCode: 403 },
    });
    setOutcome({ kind: "throw", err });
    await expect(getBedrockCatalog(ORG_A, "us-east-1", CREDS)).rejects.toBeInstanceOf(
      BedrockCatalogUnauthorized,
    );
  });

  test("opaque failure → BedrockCatalogUnavailable", async () => {
    setOutcome({ kind: "throw", err: new Error("ECONNRESET") });
    await expect(getBedrockCatalog(ORG_A, "us-east-1", CREDS)).rejects.toBeInstanceOf(
      BedrockCatalogUnavailable,
    );
  });

  test("cache is scoped per (orgId, region)", async () => {
    setOutcome({
      kind: "ok",
      payload: {
        modelSummaries: [
          {
            modelId: "anthropic.claude-opus-4-v1:0",
            modelName: "Opus",
            providerName: "Anthropic",
            outputModalities: ["TEXT"],
          },
        ],
      },
    });

    await getBedrockCatalog(ORG_A, "us-east-1", CREDS);
    await getBedrockCatalog(ORG_A, "us-east-1", CREDS); // cached
    await getBedrockCatalog(ORG_A, "us-west-2", CREDS); // different region → new fetch
    await getBedrockCatalog(ORG_B, "us-east-1", CREDS); // different org → new fetch
    expect(sendCalls).toHaveLength(3);
  });

  test("opts.refresh bypasses the cache", async () => {
    setOutcome({
      kind: "ok",
      payload: { modelSummaries: [{ modelId: "anthropic.claude-opus-4-v1:0", outputModalities: ["TEXT"] }] },
    });
    await getBedrockCatalog(ORG_A, "us-east-1", CREDS);
    const refreshed = await getBedrockCatalog(ORG_A, "us-east-1", CREDS, { refresh: true });
    expect(sendCalls).toHaveLength(2);
    expect(refreshed.source).toBe("fresh");
  });

  test("invalidate clears every region for an org", async () => {
    setOutcome({
      kind: "ok",
      payload: { modelSummaries: [{ modelId: "anthropic.claude-opus-4-v1:0", outputModalities: ["TEXT"] }] },
    });
    await getBedrockCatalog(ORG_A, "us-east-1", CREDS);
    await getBedrockCatalog(ORG_A, "us-west-2", CREDS);
    expect(sendCalls).toHaveLength(2);
    invalidateBedrockCatalog(ORG_A);
    await getBedrockCatalog(ORG_A, "us-east-1", CREDS);
    await getBedrockCatalog(ORG_A, "us-west-2", CREDS);
    expect(sendCalls).toHaveLength(4);
  });

  test("recommended set includes a flagship", () => {
    const ids = __getRecommendedBedrockIdsForTests();
    expect(ids.size).toBeGreaterThan(0);
    expect(ids.has("anthropic.claude-opus-4-v1:0")).toBe(true);
  });

  test("concurrent fetches for the same (orgId, region) dedupe to one AWS call", async () => {
    // Replace the mock to delay completion so both calls observe an
    // inflight promise. Parity with the anthropic + openai tests.
    const pending = Promise.withResolvers<ListFoundationModelsResponse>();
    sendCalls.length = 0;
    const originalOutcome = nextOutcome;
    nextOutcome = { kind: "ok", payload: { modelSummaries: [] } };

    // Wire the mock client to await our pending promise.
    const _origSend = MockBedrockClient.prototype.send;
    MockBedrockClient.prototype.send = async function (command: MockListFoundationModelsCommand) {
      sendCalls.push({ region: this.region, commandName: command.$name });
      return pending.promise;
    };

    try {
      const p1 = getBedrockCatalog(ORG_A, "us-east-1", CREDS);
      const p2 = getBedrockCatalog(ORG_A, "us-east-1", CREDS);
      pending.resolve({
        modelSummaries: [{ modelId: "anthropic.claude-opus-4-v1:0", outputModalities: ["TEXT"] }],
      });
      const [r1, r2] = await Promise.all([p1, p2]);
      expect(sendCalls).toHaveLength(1);
      expect(r1.models[0].id).toBe("anthropic.claude-opus-4-v1:0");
      expect(r2.models[0].id).toBe("anthropic.claude-opus-4-v1:0");
    } finally {
      MockBedrockClient.prototype.send = _origSend;
      nextOutcome = originalOutcome;
    }
  });

  afterEach(() => {
    __resetBedrockCatalogCacheForTests();
  });
});
