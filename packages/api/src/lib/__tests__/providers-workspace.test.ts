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
