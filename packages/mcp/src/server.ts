/**
 * MCP server factory for Atlas.
 *
 * Creates an MCP server with Atlas's core tools (explore, executeSQL),
 * the semantic layer exposed as resources, and prompt templates.
 *
 * Usage:
 *   import { createAtlasMcpServer } from "@atlas/mcp/server";
 *   const server = await createAtlasMcpServer();
 *   await server.connect(new StdioServerTransport());
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { initializeConfig } from "@atlas/api/lib/config";
import type { AtlasUser } from "@atlas/api/lib/auth/types";
import { registerTools } from "./tools.js";
import { registerResources } from "./resources.js";
import { registerPrompts } from "./prompts.js";
import { resolveMcpActor } from "./actor.js";
import type { McpTransport } from "./telemetry.js";
// `serverInfo.version` is what MCP clients (Claude Desktop, Cursor) show
// in their server picker. Reading from package.json keeps the value in
// sync without a hand-edit on every bump.
import pkg from "../package.json" with { type: "json" };

const VERSION: string = pkg.version;

interface CreateMcpServerOptions {
  /** Skip config initialization (useful when config is already loaded). */
  skipConfig?: boolean;
  /**
   * Inject a pre-resolved actor (test seam — production callers should
   * leave this unset and let `resolveMcpActor()` read env vars at boot).
   */
  actor?: AtlasUser;
  /**
   * Carrier transport for OTel attribution (#2029). `bin/serve.ts` sets
   * this once at boot and threads it through every server instance so
   * span / counter attributes don't have to re-detect transport per
   * dispatch. Defaults to `stdio`.
   */
  transport?: McpTransport;
}

/**
 * Create and configure an Atlas MCP server.
 *
 * 1. Initializes config (atlas.config.ts or env vars) — same as Hono server.ts
 * 2. Resolves the MCP actor identity (#1858). For stdio this runs once at
 *    server boot. For SSE the entry point in `bin/serve.ts` resolves the
 *    actor once eagerly and threads it through `opts.actor` so every new
 *    session shares the same identity (and the fail-loud check fires at
 *    process start, not at first request). Either way the resolution
 *    fails loud when approval rules exist without
 *    `ATLAS_MCP_USER_ID` + `ATLAS_MCP_ORG_ID`, otherwise produces the
 *    bound user or a synthetic `system:mcp` actor.
 * 3. Registers the core tools (explore, executeSQL) and the typed
 *    semantic-layer tools (listEntities, describeEntity, searchGlossary,
 *    runMetric) as MCP tools, wrapping every dispatch in
 *    `withRequestContext({ user })` so the approval gate sees a bound
 *    actor.
 * 4. Registers semantic layer YAML files as MCP resources
 * 5. Registers prompt templates (built-in, semantic layer, prompt library)
 */
export async function createAtlasMcpServer(
  opts?: CreateMcpServerOptions,
): Promise<McpServer> {
  if (!opts?.skipConfig) {
    await initializeConfig();
  }

  const actor = opts?.actor ?? (await resolveMcpActor());
  const transport: McpTransport = opts?.transport ?? "stdio";

  const server = new McpServer({
    name: "atlas",
    version: VERSION,
  });

  registerTools(server, { actor, transport });
  registerResources(server);
  await registerPrompts(server);

  return server;
}
