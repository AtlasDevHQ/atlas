import { describe, test, expect } from "bun:test";
import { Effect, Layer } from "effect";
import {
  AtlasToolkit,
  createToolkitTestLayer,
} from "../toolkit";

describe("AtlasToolkit", () => {
  test("createToolkitTestLayer provides empty defaults", async () => {
    const layer = createToolkitTestLayer();

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const toolkit = yield* AtlasToolkit;
        return {
          tools: toolkit.getAll(),
          desc: toolkit.describe(),
          size: toolkit.size,
          hasExplore: toolkit.has("explore"),
        };
      }).pipe(Effect.provide(layer)),
    );

    expect(result.tools).toEqual({});
    expect(result.desc).toBe("");
    expect(result.size).toBe(0);
    expect(result.hasExplore).toBe(false);
  });

  test("createToolkitTestLayer accepts overrides", async () => {
    const mockTools = { explore: {} as never, executeSQL: {} as never };
    const layer = createToolkitTestLayer({
      getAll: () => mockTools,
      describe: () => "explore + executeSQL",
      size: 2,
      has: (name) => name === "explore" || name === "executeSQL",
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const toolkit = yield* AtlasToolkit;
        return {
          toolCount: Object.keys(toolkit.getAll()).length,
          desc: toolkit.describe(),
          size: toolkit.size,
          hasExplore: toolkit.has("explore"),
          hasFoo: toolkit.has("foo"),
        };
      }).pipe(Effect.provide(layer)),
    );

    expect(result.toolCount).toBe(2);
    expect(result.desc).toBe("explore + executeSQL");
    expect(result.size).toBe(2);
    expect(result.hasExplore).toBe(true);
    expect(result.hasFoo).toBe(false);
  });

  test("composes with AI model test layer", async () => {
    const { createAiModelTestLayer, AtlasAiModel } = await import("../ai");

    const combined = Layer.merge(
      createToolkitTestLayer({ size: 3 }),
      createAiModelTestLayer({ modelId: "claude-test" }),
    );

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const toolkit = yield* AtlasToolkit;
        const ai = yield* AtlasAiModel;
        return { tools: toolkit.size, model: ai.modelId };
      }).pipe(Effect.provide(combined)),
    );

    expect(result.tools).toBe(3);
    expect(result.model).toBe("claude-test");
  });
});
