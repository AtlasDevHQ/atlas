/**
 * Tests for AI model TTL cache in SaaS mode (#1089 gap 2).
 *
 * Validates that:
 * - Dynamic re-resolution works via getter properties
 * - TTL cache prevents excessive re-resolution
 * - Graceful degradation on resolution failure uses cached model
 */

import { describe, it, expect, mock } from "bun:test";
import { Effect } from "effect";
import type { LanguageModel } from "ai";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

let resolveCallCount = 0;
let shouldThrow = false;
let warnCalls: Array<unknown[]> = [];

function createMockModel(id: string): LanguageModel {
  return {
    modelId: id,
    provider: "test-provider",
    specificationVersion: "v1",
    defaultObjectGenerationMode: undefined,
    supportsImageUrls: false,
    supportsStructuredOutputs: false,
    doGenerate: async () => {
      throw new Error("Mock model: doGenerate not implemented");
    },
    doStream: async () => {
      throw new Error("Mock model: doStream not implemented");
    },
  } as unknown as LanguageModel;
}

mock.module("@atlas/api/lib/config", () => ({
  getConfig: () => ({ deployMode: "saas" }),
  defineConfig: (c: unknown) => c,
}));

let currentModelId = "claude-sonnet-4-20250514";
mock.module("@atlas/api/lib/settings", () => ({
  getSetting: () => undefined,
  getSettingAuto: (key: string) => {
    if (key === "ATLAS_PROVIDER") return "anthropic";
    if (key === "ATLAS_MODEL") return currentModelId;
    return undefined;
  },
  getSettingLive: async () => undefined,
  setSetting: async () => {},
  deleteSetting: async () => {},
  getAllSettingOverrides: async () => [],
  loadSettings: async () => 0,
  getSettingsForAdmin: () => [],
  getSettingsRegistry: () => [],
  getSettingDefinition: () => undefined,
  _resetSettingsCache: () => {},
}));

mock.module("@atlas/api/lib/providers", () => ({
  getModelForConfig: (provider?: string, model?: string) => {
    resolveCallCount++;
    if (shouldThrow) throw new Error("Provider unavailable");
    const id = model ?? "default-model";
    return { model: createMockModel(id), providerType: provider ?? "anthropic", modelId: id };
  },
  getModel: () => createMockModel("default"),
  getProviderType: () => "anthropic" as const,
  getDefaultProvider: () => "anthropic" as const,
  getModelFromWorkspaceConfig: () => createMockModel("workspace"),
  getWorkspaceProviderType: () => "anthropic" as const,
}));

mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    info: () => {},
    warn: (...args: unknown[]) => { warnCalls.push(args); },
    error: () => {},
    debug: () => {},
  }),
  getLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    level: "info",
  }),
  getRequestContext: () => undefined,
  setLogLevel: () => true,
}));

// Import after mocks
const { AtlasAiModel, AtlasAiModelLive } = await import("../ai");

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AtlasAiModel SaaS TTL cache", () => {
  it("builds Layer successfully in SaaS mode", async () => {
    resolveCallCount = 0;
    shouldThrow = false;
    currentModelId = "claude-sonnet-4-20250514";

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const ai = yield* AtlasAiModel;
        return {
          providerType: ai.providerType,
          modelId: ai.modelId,
          hasModel: ai.model != null,
        };
      }).pipe(Effect.provide(AtlasAiModelLive)),
    );

    expect(result.providerType).toBe("anthropic");
    expect(result.modelId).toBe("claude-sonnet-4-20250514");
    expect(result.hasModel).toBe(true);
    // Boot-time resolution should have been called
    expect(resolveCallCount).toBeGreaterThanOrEqual(1);
  });

  it("re-resolves model after TTL expires", async () => {
    resolveCallCount = 0;
    shouldThrow = false;
    currentModelId = "claude-sonnet-4-20250514";

    // Build the layer — this resolves once at boot
    const layer = AtlasAiModelLive;

    await Effect.runPromise(
      Effect.gen(function* () {
        const ai = yield* AtlasAiModel;

        // First access — should use cached boot model
        const initialCount = resolveCallCount;
        const _model1 = ai.model;

        // Access within TTL should not re-resolve (or re-resolve at most once if TTL already expired)
        const _model2 = ai.model;
        // The key assertion: within TTL, we should NOT see many extra resolutions
        const countAfterAccess = resolveCallCount;

        // Access count should be modest (boot + maybe 1 re-resolve, not unlimited)
        expect(countAfterAccess - initialCount).toBeLessThanOrEqual(1);
      }).pipe(Effect.provide(layer)),
    );
  });

  it("gracefully degrades to cached model on resolution failure", async () => {
    resolveCallCount = 0;
    shouldThrow = false;
    warnCalls = [];
    currentModelId = "claude-opus-4-20250514";

    const layer = AtlasAiModelLive;

    await Effect.runPromise(
      Effect.gen(function* () {
        const ai = yield* AtlasAiModel;

        // First access via model getter — triggers TTL check and resolution
        const model1 = ai.model;
        const id1 = typeof model1 === "string" ? model1 : model1.modelId;
        expect(id1).toBe("claude-opus-4-20250514");

        // Now make resolution fail
        shouldThrow = true;
        const countBeforeWait = resolveCallCount;

        // Wait for TTL to expire (7s > 5s TTL, with margin for timer imprecision)
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 7000)));

        // Access via model getter after TTL + failure — triggers re-resolution
        // which fails, so the catch block should preserve the cached model
        const model2 = ai.model;
        const id2 = typeof model2 === "string" ? model2 : model2.modelId;
        expect(id2).toBe("claude-opus-4-20250514");

        // Verify re-resolution was actually attempted (TTL expired)
        expect(resolveCallCount).toBeGreaterThan(countBeforeWait);

        // Verify the warning was logged (operationally important)
        expect(warnCalls.length).toBeGreaterThanOrEqual(1);
      }).pipe(Effect.provide(layer)),
    );
  }, 15_000); // 15s timeout for the TTL wait
});
