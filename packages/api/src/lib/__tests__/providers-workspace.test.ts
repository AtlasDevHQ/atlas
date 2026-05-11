import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getModelFromWorkspaceConfig } from "../providers";

const savedGatewayKey = process.env.AI_GATEWAY_API_KEY;

afterEach(() => {
  if (savedGatewayKey === undefined) delete process.env.AI_GATEWAY_API_KEY;
  else process.env.AI_GATEWAY_API_KEY = savedGatewayKey;
});

describe("getModelFromWorkspaceConfig — gateway branch", () => {
  beforeEach(() => {
    delete process.env.AI_GATEWAY_API_KEY;
  });

  test("BYOT gateway: apiKey supplied → returns a LanguageModel via createGateway", () => {
    const model = getModelFromWorkspaceConfig({
      provider: "gateway",
      model: "anthropic/claude-opus-4.6",
      apiKey: "vck_test_byot",
      baseUrl: null,
    });
    // Vercel AI SDK models expose `.modelId`; this confirms we got a valid
    // model object back rather than throwing or returning the bare string.
    expect(typeof model).toBe("object");
    if (typeof model !== "string") {
      expect(model.modelId).toBe("anthropic/claude-opus-4.6");
    }
  });

  test("platform credits: AI_GATEWAY_API_KEY set + no apiKey → returns env-keyed gateway()", () => {
    process.env.AI_GATEWAY_API_KEY = "vck_platform_default";
    const model = getModelFromWorkspaceConfig({
      provider: "gateway",
      model: "openai/gpt-4o",
      apiKey: null,
      baseUrl: null,
    });
    expect(typeof model).toBe("object");
    if (typeof model !== "string") {
      expect(model.modelId).toBe("openai/gpt-4o");
    }
  });

  test("platform credits: no AI_GATEWAY_API_KEY + no apiKey → throws actionable error", () => {
    expect(() =>
      getModelFromWorkspaceConfig({
        provider: "gateway",
        model: "openai/gpt-4o",
        apiKey: null,
        baseUrl: null,
      }),
    ).toThrow(/AI_GATEWAY_API_KEY/);
  });
});

describe("getModelFromWorkspaceConfig — BYOT providers reject null apiKey", () => {
  for (const provider of ["anthropic", "openai"] as const) {
    test(`${provider} provider without apiKey throws`, () => {
      expect(() =>
        getModelFromWorkspaceConfig({
          provider,
          model: "x",
          apiKey: null,
          baseUrl: null,
        }),
      ).toThrow(/API key is required/);
    });
  }

  for (const provider of ["azure-openai", "custom"] as const) {
    test(`${provider} provider without apiKey throws (before baseUrl check)`, () => {
      expect(() =>
        getModelFromWorkspaceConfig({
          provider,
          model: "x",
          apiKey: null,
          baseUrl: "https://example.com/v1",
        }),
      ).toThrow(/API key is required/);
    });
  }
});

describe("getModelFromWorkspaceConfig — bedrock branch", () => {
  const validBundle = JSON.stringify({
    accessKeyId: "AKIA-EXAMPLE",
    secretAccessKey: "secret-example",
  });
  const validBundleWithSession = JSON.stringify({
    accessKeyId: "AKIA-EXAMPLE",
    secretAccessKey: "secret-example",
    sessionToken: "session-token-xyz",
  });

  test("happy path: returns a LanguageModel with the requested model id", () => {
    const model = getModelFromWorkspaceConfig({
      provider: "bedrock",
      model: "anthropic.claude-opus-4-v1:0",
      apiKey: validBundle,
      baseUrl: null,
      bedrockRegion: "us-east-1",
    });
    expect(typeof model).toBe("object");
    if (typeof model !== "string") {
      expect(model.modelId).toBe("anthropic.claude-opus-4-v1:0");
    }
  });

  test("happy path with sessionToken: still returns a LanguageModel", () => {
    const model = getModelFromWorkspaceConfig({
      provider: "bedrock",
      model: "anthropic.claude-opus-4-v1:0",
      apiKey: validBundleWithSession,
      baseUrl: null,
      bedrockRegion: "us-west-2",
    });
    expect(typeof model).toBe("object");
    if (typeof model !== "string") {
      expect(model.modelId).toBe("anthropic.claude-opus-4-v1:0");
    }
  });

  test("missing apiKey throws AWS-credentials-required error", () => {
    expect(() =>
      getModelFromWorkspaceConfig({
        provider: "bedrock",
        model: "anthropic.claude-opus-4-v1:0",
        apiKey: null,
        baseUrl: null,
        bedrockRegion: "us-east-1",
      }),
    ).toThrow(/AWS credentials are required/);
  });

  test("missing region throws region-required error (even with valid bundle)", () => {
    expect(() =>
      getModelFromWorkspaceConfig({
        provider: "bedrock",
        model: "anthropic.claude-opus-4-v1:0",
        apiKey: validBundle,
        baseUrl: null,
        bedrockRegion: null,
      }),
    ).toThrow(/AWS region is required/);
  });

  test("malformed JSON bundle surfaces the friendly re-enter message", () => {
    expect(() =>
      getModelFromWorkspaceConfig({
        provider: "bedrock",
        model: "anthropic.claude-opus-4-v1:0",
        apiKey: "not-json-at-all",
        baseUrl: null,
        bedrockRegion: "us-east-1",
      }),
    ).toThrow(/bedrock credentials are malformed/);
  });

  test("bundle missing secretAccessKey surfaces the friendly re-enter message", () => {
    const half = JSON.stringify({ accessKeyId: "AKIA-EXAMPLE" });
    expect(() =>
      getModelFromWorkspaceConfig({
        provider: "bedrock",
        model: "anthropic.claude-opus-4-v1:0",
        apiKey: half,
        baseUrl: null,
        bedrockRegion: "us-east-1",
      }),
    ).toThrow(/bedrock credentials are malformed/);
  });

  test("bundle with non-string field surfaces the friendly re-enter message", () => {
    const bad = JSON.stringify({ accessKeyId: "AKIA-EXAMPLE", secretAccessKey: 12345 });
    expect(() =>
      getModelFromWorkspaceConfig({
        provider: "bedrock",
        model: "anthropic.claude-opus-4-v1:0",
        apiKey: bad,
        baseUrl: null,
        bedrockRegion: "us-east-1",
      }),
    ).toThrow(/bedrock credentials are malformed/);
  });
});
