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
 * Create the Live layer for AtlasAiModel.
 *
 * Reads ATLAS_PROVIDER and ATLAS_MODEL from env vars via providers.ts.
 * Fails the Layer if the provider is misconfigured.
 */
export const AtlasAiModelLive: Layer.Layer<AtlasAiModel, Error> = Layer.effect(
  AtlasAiModel,
  Effect.gen(function* () {
    const { model, providerType, modelId } = yield* Effect.tryPromise({
      try: async () => {
        const { getModel, getProviderType } = await import(
          "@atlas/api/lib/providers"
        );
        const model = getModel();
        const providerType = getProviderType();
        const modelId = process.env.ATLAS_MODEL ?? (model as unknown as { modelId?: string }).modelId ?? "unknown";
        return { model, providerType, modelId };
      },
      catch: (err) =>
        new Error(
          `AI model initialization failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
    });

    log.info({ provider: providerType, model: modelId }, "AI model configured");

    return { model, providerType, modelId } satisfies AtlasAiModelShape;
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
