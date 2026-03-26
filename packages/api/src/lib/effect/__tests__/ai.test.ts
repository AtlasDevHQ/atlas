import { describe, test, expect } from "bun:test";
import { Effect, Layer } from "effect";
import {
  AtlasAiModel,
  createAiModelTestLayer,
  type AtlasAiModelShape,
} from "../ai";

describe("AtlasAiModel", () => {
  test("createAiModelTestLayer provides default mock model", async () => {
    const layer = createAiModelTestLayer();

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const ai = yield* AtlasAiModel;
        return {
          providerType: ai.providerType,
          modelId: ai.modelId,
          hasModel: ai.model != null,
        };
      }).pipe(Effect.provide(layer)),
    );

    expect(result.providerType).toBe("anthropic");
    expect(result.modelId).toBe("test-model");
    expect(result.hasModel).toBe(true);
  });

  test("createAiModelTestLayer accepts overrides", async () => {
    const layer = createAiModelTestLayer({
      providerType: "openai",
      modelId: "gpt-4o",
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const ai = yield* AtlasAiModel;
        return { providerType: ai.providerType, modelId: ai.modelId };
      }).pipe(Effect.provide(layer)),
    );

    expect(result.providerType).toBe("openai");
    expect(result.modelId).toBe("gpt-4o");
  });

  test("mock model throws on doGenerate/doStream", async () => {
    const layer = createAiModelTestLayer();

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const ai = yield* AtlasAiModel;
        return yield* Effect.tryPromise({
          try: () =>
            (ai.model as unknown as { doGenerate: () => Promise<void> }).doGenerate(),
          catch: (err) => (err instanceof Error ? err.message : String(err)),
        }).pipe(
          Effect.matchEffect({
            onSuccess: () => Effect.succeed("did-not-throw"),
            onFailure: (msg) => Effect.succeed(msg),
          }),
        );
      }).pipe(Effect.provide(layer)),
    );

    expect(result).toContain("Mock model");
  });

  test("provider type variants", async () => {
    const providers: AtlasAiModelShape["providerType"][] = [
      "anthropic",
      "openai",
      "bedrock",
      "ollama",
      "openai-compatible",
      "gateway",
    ];

    for (const providerType of providers) {
      const layer = createAiModelTestLayer({ providerType });

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const ai = yield* AtlasAiModel;
          return ai.providerType;
        }).pipe(Effect.provide(layer)),
      );

      expect(result).toBe(providerType);
    }
  });

  test("composes with other test layers", async () => {
    const { createRequestContextTestLayer, RequestContext } = await import(
      "../services"
    );

    const combined = Layer.merge(
      createAiModelTestLayer({ modelId: "claude-opus" }),
      createRequestContextTestLayer({ requestId: "req-ai-test" }),
    );

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const ai = yield* AtlasAiModel;
        const req = yield* RequestContext;
        return `${req.requestId}:${ai.modelId}`;
      }).pipe(Effect.provide(combined)),
    );

    expect(result).toBe("req-ai-test:claude-opus");
  });
});
