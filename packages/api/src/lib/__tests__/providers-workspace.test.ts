import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getModelFromWorkspaceConfig } from "../providers";

// Post-#2282: `getModelFromWorkspaceConfig` consumes the typed
// `WorkspaceCredentials` union built by the EE row mapper. The "missing
// apiKey for a BYOT provider" precondition moved upstream — the union's
// non-bedrock arms type `apiKey` as a non-nullable string, so a null key
// is unrepresentable at this boundary. The negative cases that used to
// live here are now pinned in the EE `getWorkspaceModelConfigRaw` /
// admin-model-config route tests (decrypt_failed / missing_byot_key
// envelopes). What remains is the AI Layer's behavior given a
// well-formed union value — happy paths for each provider and the one
// negative case the union still carries: a bedrock `bundle: null`
// signaling a malformed stored bundle.

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
      model: "anthropic/claude-opus-4.6",
      baseUrl: null,
      bedrockRegion: null,
      credentials: { provider: "gateway", apiKey: "vck_test_byot" },
    });
    expect(typeof model).toBe("object");
    if (typeof model !== "string") {
      expect(model.modelId).toBe("anthropic/claude-opus-4.6");
    }
  });

  test("platform credits: AI_GATEWAY_API_KEY set + no apiKey → returns env-keyed gateway()", () => {
    process.env.AI_GATEWAY_API_KEY = "vck_platform_default";
    const model = getModelFromWorkspaceConfig({
      model: "openai/gpt-4o",
      baseUrl: null,
      bedrockRegion: null,
      credentials: { provider: "gateway", apiKey: null },
    });
    expect(typeof model).toBe("object");
    if (typeof model !== "string") {
      expect(model.modelId).toBe("openai/gpt-4o");
    }
  });

  test("platform credits: no AI_GATEWAY_API_KEY + no apiKey → throws actionable error", () => {
    expect(() =>
      getModelFromWorkspaceConfig({
        model: "openai/gpt-4o",
        baseUrl: null,
        bedrockRegion: null,
        credentials: { provider: "gateway", apiKey: null },
      }),
    ).toThrow(/AI_GATEWAY_API_KEY/);
  });
});

describe("getModelFromWorkspaceConfig — BYOT happy paths", () => {
  test("anthropic returns a LanguageModel with the requested model id", () => {
    const model = getModelFromWorkspaceConfig({
      model: "claude-opus-4-6",
      baseUrl: null,
      bedrockRegion: null,
      credentials: { provider: "anthropic", apiKey: "sk-ant-test" },
    });
    expect(typeof model).toBe("object");
    if (typeof model !== "string") {
      expect(model.modelId).toBe("claude-opus-4-6");
    }
  });

  test("openai returns a LanguageModel with the requested model id", () => {
    const model = getModelFromWorkspaceConfig({
      model: "gpt-4o",
      baseUrl: null,
      bedrockRegion: null,
      credentials: { provider: "openai", apiKey: "sk-oai-test" },
    });
    expect(typeof model).toBe("object");
    if (typeof model !== "string") {
      expect(model.modelId).toBe("gpt-4o");
    }
  });

  test("azure-openai requires baseUrl", () => {
    expect(() =>
      getModelFromWorkspaceConfig({
        model: "gpt-4o",
        baseUrl: null,
        bedrockRegion: null,
        credentials: { provider: "azure-openai", apiKey: "az-key" },
      }),
    ).toThrow(/Base URL is required/);
  });

  test("custom requires baseUrl", () => {
    expect(() =>
      getModelFromWorkspaceConfig({
        model: "x",
        baseUrl: null,
        bedrockRegion: null,
        credentials: { provider: "custom", apiKey: "custom-key" },
      }),
    ).toThrow(/Base URL is required/);
  });
});

describe("getModelFromWorkspaceConfig — bedrock branch", () => {
  test("happy path: returns a LanguageModel with the requested model id", () => {
    const model = getModelFromWorkspaceConfig({
      model: "anthropic.claude-opus-4-v1:0",
      baseUrl: null,
      bedrockRegion: "us-east-1",
      credentials: {
        provider: "bedrock",
        bundle: { accessKeyId: "AKIA-EXAMPLE", secretAccessKey: "secret-example" },
      },
    });
    expect(typeof model).toBe("object");
    if (typeof model !== "string") {
      expect(model.modelId).toBe("anthropic.claude-opus-4-v1:0");
    }
  });

  test("happy path with sessionToken: still returns a LanguageModel", () => {
    const model = getModelFromWorkspaceConfig({
      model: "anthropic.claude-opus-4-v1:0",
      baseUrl: null,
      bedrockRegion: "us-west-2",
      credentials: {
        provider: "bedrock",
        bundle: {
          accessKeyId: "AKIA-EXAMPLE",
          secretAccessKey: "secret-example",
          sessionToken: "session-token-xyz",
        },
      },
    });
    expect(typeof model).toBe("object");
    if (typeof model !== "string") {
      expect(model.modelId).toBe("anthropic.claude-opus-4-v1:0");
    }
  });

  test("bundle === null (malformed signal from EE row mapper) surfaces re-enter message", () => {
    expect(() =>
      getModelFromWorkspaceConfig({
        model: "anthropic.claude-opus-4-v1:0",
        baseUrl: null,
        bedrockRegion: "us-east-1",
        credentials: { provider: "bedrock", bundle: null },
      }),
    ).toThrow(/bedrock credentials are malformed/);
  });

  test("missing region throws region-required error (even with valid bundle)", () => {
    expect(() =>
      getModelFromWorkspaceConfig({
        model: "anthropic.claude-opus-4-v1:0",
        baseUrl: null,
        bedrockRegion: null,
        credentials: {
          provider: "bedrock",
          bundle: { accessKeyId: "AKIA-EXAMPLE", secretAccessKey: "secret-example" },
        },
      }),
    ).toThrow(/AWS region is required/);
  });
});
