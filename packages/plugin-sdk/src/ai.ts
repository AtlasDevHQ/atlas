/**
 * Re-exports from the Vercel AI SDK for plugin authors.
 *
 * The `ai` package is an optional peer dependency of `@useatlas/plugin-sdk`.
 * Install it when your plugin defines custom tools or actions.
 *
 * @example
 * ```typescript
 * import { tool } from "@useatlas/plugin-sdk/ai";
 * import { z } from "zod";
 *
 * const myTool = tool({
 *   description: "Look up inventory by SKU",
 *   parameters: z.object({ sku: z.string() }),
 *   execute: async ({ sku }) => ({ stock: 42 }),
 * });
 * ```
 */

export { tool, jsonSchema } from "ai";
export type { ToolSet, Tool } from "ai";
