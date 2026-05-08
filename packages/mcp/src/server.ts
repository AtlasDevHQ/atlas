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
import { initializeConfig, getConfig } from "@atlas/api/lib/config";
import { createLogger } from "@atlas/api/lib/logger";
import type { AtlasUser } from "@atlas/api/lib/auth/types";
import { hasInternalDB } from "@atlas/api/lib/db/internal";
import { loadSettings } from "@atlas/api/lib/settings";
import { registerTools } from "./tools.js";
import { registerPluginTools } from "./plugin-tools.js";
import { bootPluginsForMcp } from "@atlas/api/lib/plugins";
import { registerResources } from "./resources.js";
import { registerPrompts } from "./prompts/registry.js";
import { resolveMcpActor } from "./actor.js";
import type { McpTransport } from "./telemetry.js";

const log = createLogger("mcp:boot");
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
  /**
   * Hosted-MCP OAuth client_id, threaded into `audit_log.client_id` via
   * `RequestContext.actor.clientId` (#2067). Stdio MCP leaves this unset.
   */
  clientId?: string;
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
 * 5. Registers prompt templates (built-in, canonical eval, semantic layer,
 *    prompt library — see `prompts/registry.ts` for the source order)
 */
export async function createAtlasMcpServer(
  opts?: CreateMcpServerOptions,
): Promise<McpServer> {
  if (!opts?.skipConfig) {
    await initializeConfig();
  }

  // #2076 — workspace-scoped settings (e.g. ATLAS_MCP_EXPOSE_CANONICAL_PROMPTS)
  // live in the internal DB. Without `loadSettings()`, the in-process cache
  // is empty and `getSettingAuto` only sees env vars — the admin toggle
  // would silently never propagate to stdio MCP. Run once at boot when an
  // internal DB is configured. The SSE/hosted entry point already calls
  // `loadSettings()` indirectly via `buildAppLayer`, but the call here is
  // idempotent (it just re-fills the cache) so we don't bother branching.
  if (hasInternalDB()) {
    try {
      await loadSettings();
    } catch (err) {
      // Don't refuse to boot if the DB read fails — fall back to env vars
      // only and log so an operator can correlate "toggle didn't take
      // effect" with the underlying connectivity error.
      log.warn(
        { err: err instanceof Error ? err : new Error(String(err)) },
        "loadSettings failed at boot, settings cache may be stale",
      );
    }
  }

  const actor = opts?.actor ?? (await resolveMcpActor());
  const transport: McpTransport = opts?.transport ?? "stdio";
  const clientId = opts?.clientId;

  const server = new McpServer({
    name: "atlas",
    version: VERSION,
  });

  registerTools(server, { actor, transport, clientId });

  // #2078 — plugins contribute additional MCP tools via `mcpTools()`.
  // Boot the plugin lifecycle so factory functions can run, then walk
  // the singleton registry to register each tool on this server. The
  // helper is idempotent for the in-process (SSE / hosted) case where
  // the Hono server already booted plugins. Failures inside either step
  // are logged but never block server creation. Two distinct catches
  // because the failure modes diverge: a `bootPluginsForMcp` throw is
  // a plugin-config problem (broken atlas.config.ts), while a
  // `registerPluginTools` throw is an MCP-SDK contract violation
  // (malformed schema, name collision the registry let through). An
  // operator debugging "tool didn't show up" needs to know which side.
  try {
    await bootPluginsForMcp();
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err : new Error(String(err)) },
      "Plugin lifecycle boot failed before MCP tool registration — plugin tools will be absent from tools/list",
    );
  }
  try {
    const pluginToolCount = registerPluginTools(server, {
      actor,
      transport,
      ...(clientId && { clientId }),
      workspaceId: actor.activeOrganizationId ?? actor.id,
      deployMode: getConfig()?.deployMode ?? "self-hosted",
    });
    if (pluginToolCount > 0) {
      log.info(
        { count: pluginToolCount },
        `Registered ${pluginToolCount} plugin MCP tool(s)`,
      );
    }
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err : new Error(String(err)) },
      "Plugin MCP tool registration on the MCP server failed — server will boot without plugin tools",
    );
  }

  registerResources(server);
  await registerPrompts(server, {
    // `actor.activeOrganizationId` may be undefined for trusted-transport
    // (system:mcp) — gating falls back to the platform-level demo signal
    // (`ATLAS_DEMO_INDUSTRY`) in that case.
    workspaceId: actor.activeOrganizationId,
    clientId,
    transport,
    deployMode: getConfig()?.deployMode ?? "self-hosted",
    authMode: actor.mode,
  });

  return server;
}
