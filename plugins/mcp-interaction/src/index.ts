/**
 * MCP Interaction Plugin — reference implementation for AtlasInteractionPlugin.
 *
 * Manages the lifecycle (init, health, teardown) of the `@atlas/mcp` server
 * as an Atlas plugin. Tool bridging and resource registration are handled
 * internally by `@atlas/mcp` — this plugin is a thin lifecycle wrapper.
 *
 * Supports stdio transport (default) for use with Claude Desktop, Cursor, etc.
 * SSE transport runs a Streamable HTTP server for browser/remote MCP clients.
 *
 * @example
 * ```typescript
 * import { defineConfig } from "@atlas/api/lib/config";
 * import { mcpPlugin } from "@atlas/plugin-mcp-interaction";
 *
 * export default defineConfig({
 *   plugins: [
 *     mcpPlugin({ transport: "stdio" }),
 *   ],
 * });
 * ```
 */

import { z } from "zod";
import { createPlugin } from "@useatlas/plugin-sdk";
import type { AtlasInteractionPlugin, PluginHealthResult } from "@useatlas/plugin-sdk";

const McpConfigSchema = z.object({
  /** Transport type. stdio communicates via stdin/stdout (JSON-RPC). */
  transport: z.enum(["stdio", "sse"]).default("stdio"),
  /** Port for SSE transport (ignored for stdio). */
  port: z.number().int().positive().optional(),
});

export type McpPluginConfig = z.infer<typeof McpConfigSchema>;

/**
 * Build the plugin object from validated config.
 * Exported for direct use with definePlugin() or in tests where the
 * caller constructs the config object directly.
 */
export function buildMcpPlugin(
  config: McpPluginConfig,
): AtlasInteractionPlugin<McpPluginConfig> {
  // Captured MCP server instance — set during initialize(), cleared during teardown().
  // Only used for stdio transport; SSE manages per-session servers internally.
  let mcpServer: { close(): Promise<void> } | null = null;
  let sseHandle: { close(): Promise<void> } | null = null;
  let connected = false;

  return {
    id: "mcp-interaction",
    type: "interaction" as const,
    version: "0.1.0",
    name: "MCP Server",
    config,

    // No routes needed — stdio uses stdin/stdout, SSE starts its own HTTP server.

    async initialize(ctx) {
      if (connected) {
        throw new Error("MCP plugin already initialized — call teardown() first");
      }

      if (config.transport === "sse") {
        // Dynamic import to avoid pulling in @atlas/mcp (and its transitive
        // @atlas/api deps) at module evaluation time.
        const { startSseServer } = await import("@atlas/mcp/sse");
        const { createAtlasMcpServer } = await import("@atlas/mcp/server");
        const handle = await startSseServer(
          () => createAtlasMcpServer({ skipConfig: true }),
          { port: config.port ?? 8080 },
        );
        sseHandle = handle;
        connected = true;
        ctx.logger.info(
          `MCP interaction plugin initialized (SSE on :${handle.server.port})`,
        );
      } else {
        // Dynamic import to avoid pulling in @atlas/mcp (and its transitive
        // @atlas/api deps) at module evaluation time.
        const { createAtlasMcpServer } = await import("@atlas/mcp/server");
        const server = await createAtlasMcpServer({ skipConfig: true });

        try {
          const { StdioServerTransport } = await import(
            "@modelcontextprotocol/sdk/server/stdio.js"
          );
          const transport = new StdioServerTransport();
          await server.connect(transport);
        } catch (err) {
          await server.close().catch((e) => {
            console.error(`[mcp-plugin] Error closing server after init failure: ${e instanceof Error ? e.message : String(e)}`);
          });
          throw err;
        }

        mcpServer = server;
        connected = true;
        ctx.logger.info("MCP interaction plugin initialized (stdio transport)");
      }
    },

    async healthCheck(): Promise<PluginHealthResult> {
      if (!connected) {
        return {
          healthy: false,
          message: "MCP server not initialized or not connected",
        };
      }
      if (config.transport === "sse" && !sseHandle) {
        return {
          healthy: false,
          message: "SSE handle missing — server may have crashed",
        };
      }
      return { healthy: true };
    },

    async teardown() {
      connected = false;
      if (sseHandle) {
        const h = sseHandle;
        sseHandle = null;
        await h.close().catch((err) => {
          console.error(`[mcp-plugin] Error closing SSE handle: ${err instanceof Error ? err.message : String(err)}`);
        });
      }
      if (mcpServer) {
        const s = mcpServer;
        mcpServer = null;
        await s.close();
      }
    },
  };
}

/**
 * Factory function for use in atlas.config.ts plugins array.
 *
 * Validates config via Zod at call time, then builds the plugin.
 *
 * @example
 * ```typescript
 * plugins: [mcpPlugin({ transport: "stdio" })]
 * ```
 */
export const mcpPlugin = createPlugin<
  McpPluginConfig,
  AtlasInteractionPlugin<McpPluginConfig>
>({
  configSchema: McpConfigSchema,
  create: buildMcpPlugin,
});
