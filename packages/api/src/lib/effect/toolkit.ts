/**
 * Atlas Toolkit as Effect Service (P10b foundation).
 *
 * Wraps the existing ToolRegistry in an Effect Context.Tag so it can
 * be yielded from Effect programs. The toolkit provides tool descriptions
 * for the system prompt and the tool set for the agent loop.
 *
 * This is a bridge layer — the actual tools are still Vercel AI SDK
 * ToolSet entries. P10c will migrate tool definitions to @effect/ai
 * AiTool.make() and create a native AiToolkit.
 *
 * @example
 * ```ts
 * import { AtlasToolkit } from "@atlas/api/lib/effect";
 *
 * const program = Effect.gen(function* () {
 *   const toolkit = yield* AtlasToolkit;
 *   const tools = toolkit.getAll();       // ToolSet for streamText
 *   const desc = toolkit.describe();      // System prompt fragment
 *   return { toolCount: toolkit.size };
 * });
 * ```
 */

import { Context, Effect, Layer } from "effect";
import type { ToolSet } from "ai";
import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("effect:toolkit");

// ── Service interface ────────────────────────────────────────────────

/**
 * Atlas toolkit service — provides tools for the agent loop.
 *
 * Bridges the existing ToolRegistry to Effect Context.
 */
export interface AtlasToolkitShape {
  /** Get all tools as a Vercel AI SDK ToolSet. */
  getAll(): ToolSet;
  /** Get tool descriptions for the system prompt. */
  describe(): string;
  /** Number of registered tools. */
  readonly size: number;
  /** Check if a tool is registered. */
  has(name: string): boolean;
}

// ── Context.Tag ──────────────────────────────────────────────────────

export class AtlasToolkit extends Context.Tag("AtlasToolkit")<
  AtlasToolkit,
  AtlasToolkitShape
>() {}

// ── Live Layer ───────────────────────────────────────────────────────

/**
 * Create the Live layer for AtlasToolkit.
 *
 * Builds the tool registry (including Python and action tools based on
 * config) and wraps it as an Effect service.
 */
export function makeAtlasToolkitLive(options?: {
  includeActions?: boolean;
}): Layer.Layer<AtlasToolkit, Error> {
  return Layer.effect(
    AtlasToolkit,
    Effect.gen(function* () {
      const { registry, warnings } = yield* Effect.tryPromise({
        try: async () => {
          const { buildRegistry } = await import(
            "@atlas/api/lib/tools/registry"
          );
          return buildRegistry(options);
        },
        catch: (err) =>
          new Error(
            `Tool registry build failed: ${err instanceof Error ? err.message : String(err)}`,
          ),
      });

      if (warnings.length > 0) {
        log.warn({ warnings }, "Tool registry built with warnings");
      }

      log.info({ tools: registry.size }, "Atlas toolkit ready");

      return {
        getAll: () => registry.getAll(),
        describe: () => registry.describe(),
        get size() {
          return registry.size;
        },
        has: (name) => registry.get(name) !== undefined,
      } satisfies AtlasToolkitShape;
    }),
  );
}

/** Default Live layer using default buildRegistry options. */
export const AtlasToolkitLive: ReturnType<typeof makeAtlasToolkitLive> =
  makeAtlasToolkitLive();

// ── Test helper ──────────────────────────────────────────────────────

/**
 * Create a test Layer for AtlasToolkit.
 *
 * Provides a mock toolkit with configurable tools. Defaults to empty.
 */
export function createToolkitTestLayer(
  partial: Partial<AtlasToolkitShape> = {},
): Layer.Layer<AtlasToolkit> {
  return Layer.succeed(AtlasToolkit, {
    getAll: partial.getAll ?? (() => ({})),
    describe: partial.describe ?? (() => ""),
    get size() {
      return partial.size ?? 0;
    },
    has: partial.has ?? (() => false),
  });
}
