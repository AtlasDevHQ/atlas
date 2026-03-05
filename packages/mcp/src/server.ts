/**
 * MCP server factory for Atlas.
 *
 * Creates an MCP server with Atlas's core tools (explore, executeSQL)
 * and the semantic layer exposed as resources.
 *
 * Usage:
 *   import { createAtlasMcpServer } from "@atlas/mcp/server";
 *   const server = await createAtlasMcpServer();
 *   await server.connect(new StdioServerTransport());
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { initializeConfig } from "@atlas/api/lib/config";
import { registerTools } from "./tools.js";
import { registerResources } from "./resources.js";

const VERSION = "0.1.0";

export interface CreateMcpServerOptions {
  /** Skip config initialization (useful when config is already loaded). */
  skipConfig?: boolean;
}

/**
 * Create and configure an Atlas MCP server.
 *
 * 1. Initializes config (atlas.config.ts or env vars) — same as Hono server.ts
 * 2. Registers the core tools (explore, executeSQL) as MCP tools
 * 3. Registers semantic layer YAML files as MCP resources
 */
export async function createAtlasMcpServer(
  opts?: CreateMcpServerOptions,
): Promise<McpServer> {
  if (!opts?.skipConfig) {
    await initializeConfig();
  }

  const server = new McpServer({
    name: "atlas",
    version: VERSION,
  });

  registerTools(server);
  registerResources(server);

  return server;
}
