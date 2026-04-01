/**
 * AI Model as Effect Service (P10a).
 *
 * Wraps the existing Vercel AI SDK LanguageModel from providers.ts
 * in an Effect Context.Tag so it can be yielded from Effect programs.
 *
 * This is a bridge layer — the model is still created by providers.ts
 * and uses Vercel AI SDK under the hood. P10c will migrate to native
 * @effect/ai AiLanguageModel.
 *
 * In SaaS mode, the model is re-resolved on a short TTL (5s) from settings
 * so that ATLAS_PROVIDER / ATLAS_MODEL changes take effect without restart.
 *
 * @example
 * ```ts
 * import { AtlasAiModel } from "@atlas/api/lib/effect";
 *
 * const program = Effect.gen(function* () {
 *   const { model, providerType } = yield* AtlasAiModel;
 *   // Use model with Vercel AI SDK's streamText/generateText
 *   return providerType;
 * });
 * ```
 */

import { Context, Effect, Layer } from "effect";
import type { LanguageModel } from "ai";
import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("effect:ai");

// Re-export the ProviderType from providers.ts for convenience
type ProviderType = import("@atlas/api/lib/providers").ProviderType;

// ── Service interface ────────────────────────────────────────────────

/**
 * Atlas AI model service — provides the configured LLM.
 *
 * The model is a Vercel AI SDK LanguageModel (bridge pattern).
 * `providerType` is used for cache control and prompt formatting decisions.
 */
export interface AtlasAiModelShape {
  /** The configured LLM instance (Vercel AI SDK LanguageModel). */
  readonly model: LanguageModel;
  /** Provider type for cache control and system prompt formatting. */
  readonly providerType: ProviderType;
  /** Model ID string (e.g. "claude-opus-4-6", "gpt-4o"). */
  readonly modelId: string;
}

// ── Context.Tag ──────────────────────────────────────────────────────

export class AtlasAiModel extends Context.Tag("AtlasAiModel")<
  AtlasAiModel,
  AtlasAiModelShape
>() {}

// ── Live Layer ───────────────────────────────────────────────────────

/**
 * Resolve model from current settings. Used at boot and on a short TTL (5s) in SaaS mode.
 *
 * Uses `getModelForConfig()` to build the model from explicit provider/model values,
 * avoiding process.env mutation.
 */
function resolveModelFromSettings(): { model: LanguageModel; providerType: ProviderType; modelId: string } {
  // Read settings — in SaaS mode these may have been changed via admin UI
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy import avoids circular dependency
  const { getSettingAuto } = require("@atlas/api/lib/settings") as {
    getSettingAuto: (key: string) => string | undefined;
  };
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy import avoids circular dependency
  const { getModelForConfig } = require("@atlas/api/lib/providers") as {
    getModelForConfig: (provider?: string, model?: string) => { model: LanguageModel; providerType: ProviderType; modelId: string };
  };

  const providerSetting = getSettingAuto("ATLAS_PROVIDER");
  const modelSetting = getSettingAuto("ATLAS_MODEL");

  return getModelForConfig(providerSetting, modelSetting);
}

/**
 * Create the Live layer for AtlasAiModel.
 *
 * Reads ATLAS_PROVIDER and ATLAS_MODEL from env vars via providers.ts.
 * Fails the Layer if the provider is misconfigured.
 *
 * In SaaS mode, the service uses getter properties that re-resolve the
 * model from settings on access (with a 5s TTL cache), so admin changes
 * take effect without a server restart.
 */
export const AtlasAiModelLive: Layer.Layer<AtlasAiModel, Error> = Layer.effect(
  AtlasAiModel,
  Effect.gen(function* () {
    // Boot-time resolution — validates config is valid at startup
    const bootModel = yield* Effect.tryPromise({
      try: async () => resolveModelFromSettings(),
      catch: (err) =>
        new Error(
          `AI model initialization failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
    });

    log.info({ provider: bootModel.providerType, model: bootModel.modelId }, "AI model configured");

    // Check if SaaS mode — if so, return a service that resolves dynamically
    let saas = false;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy import avoids circular dependency
      const { getConfig } = require("@atlas/api/lib/config") as {
        getConfig: () => { deployMode?: string } | null;
      };
      saas = getConfig()?.deployMode === "saas";
    } catch (err) {
      // intentionally ignored: config may not be ready during Layer construction
      log.debug({ err: err instanceof Error ? err.message : String(err) }, "SaaS mode detection failed — using static model");
    }

    if (saas) {
      // In SaaS mode, cache the resolved model with a short TTL so we don't
      // create a new SDK client on every single streamText call.
      let cached = bootModel;
      let cachedAt = Date.now();
      const TTL = 5_000;

      const dynamicService: AtlasAiModelShape = {
        get model() {
          const now = Date.now();
          if (now - cachedAt > TTL) {
            try {
              cached = resolveModelFromSettings();
              cachedAt = now;
            } catch (err) {
              log.warn(
                { err: err instanceof Error ? err.message : String(err) },
                "Failed to re-resolve AI model — using cached model",
              );
            }
          }
          return cached.model;
        },
        get providerType() {
          return cached.providerType;
        },
        get modelId() {
          return cached.modelId;
        },
      };
      return dynamicService satisfies AtlasAiModelShape;
    }

    return bootModel satisfies AtlasAiModelShape;
  }),
);

/**
 * Create a Live layer for a workspace-level model configuration.
 *
 * Enterprise workspaces can override the platform default with their
 * own provider/model/API key. This Layer reads from workspace config
 * instead of env vars.
 */
export function makeWorkspaceAiModelLayer(config: {
  provider: import("@useatlas/types").ModelConfigProvider;
  model: string;
  apiKey: string;
  baseUrl: string | null;
}): Layer.Layer<AtlasAiModel, Error> {
  return Layer.effect(
    AtlasAiModel,
    Effect.gen(function* () {
      const { model, providerType } = yield* Effect.tryPromise({
        try: async () => {
          const { getModelFromWorkspaceConfig, getWorkspaceProviderType } =
            await import("@atlas/api/lib/providers");
          const model = getModelFromWorkspaceConfig(config);
          const providerType = getWorkspaceProviderType(config.provider);
          return { model, providerType };
        },
        catch: (err) =>
          new Error(
            `Workspace AI model initialization failed: ${err instanceof Error ? err.message : String(err)}`,
          ),
      });

      return {
        model,
        providerType,
        modelId: config.model,
      } satisfies AtlasAiModelShape;
    }),
  );
}

// ── Test helper ──────────────────────────────────────────────────────

/**
 * Create a test Layer for AtlasAiModel.
 *
 * Provides a mock model that can be used in tests without requiring
 * real API keys or network access.
 *
 * @example
 * ```ts
 * const TestLayer = createAiModelTestLayer({
 *   providerType: "anthropic",
 *   modelId: "test-model",
 * });
 *
 * const result = await Effect.runPromise(
 *   Effect.gen(function* () {
 *     const { providerType } = yield* AtlasAiModel;
 *     return providerType;
 *   }).pipe(Effect.provide(TestLayer)),
 * );
 * ```
 */
export function createAiModelTestLayer(
  partial: Partial<AtlasAiModelShape> = {},
): Layer.Layer<AtlasAiModel> {
  const mockModel = {
    modelId: partial.modelId ?? "test-model",
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

  return Layer.succeed(AtlasAiModel, {
    model: partial.model ?? mockModel,
    providerType: partial.providerType ?? "anthropic",
    modelId: partial.modelId ?? "test-model",
  });
}
