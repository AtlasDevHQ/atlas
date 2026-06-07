/**
 * Boot helper for plugin-contributed MCP tools (#2078).
 *
 * The Hono API server boots plugins in `packages/api/src/api/server.ts`
 * — registration, initialization, and `wireMcpToolPlugins` all happen
 * during process startup. The MCP server (`createAtlasMcpServer`) runs
 * in two configurations that need different boot logic:
 *
 *   - **stdio (separate process)**: spawned by Claude Desktop / Cursor
 *     via `bun packages/mcp/bin/serve.ts`. The plugin singleton starts
 *     empty; this helper registers + initializes plugins from
 *     `atlas.config.ts` so `mcpTools()` factories can run.
 *   - **SSE / hosted (same process as Hono)**: the plugin singleton is
 *     already populated by `server.ts`. This helper detects that via
 *     `plugins.isInitialized` and skips the re-init.
 *
 * Either way the MCP-tool registry is populated by `wireMcpToolPlugins`
 * before `createAtlasMcpServer` calls `registerPluginTools(server, ...)`.
 *
 * Failures (registration / initialization / wiring) are logged but do
 * not abort MCP server boot — operators expect the server to come up
 * even if a plugin is broken, so the broken plugin's tools are absent
 * from `tools/list` and the rest still work.
 */

import { createLogger } from "@atlas/api/lib/logger";
import { getConfig } from "@atlas/api/lib/config";
import { plugins, type PluginContextLike } from "./registry";
import { wireMcpToolPlugins, pluginMcpToolRegistry } from "./mcp-tools";

const log = createLogger("plugins:mcp-boot");

/**
 * Ensure plugins are registered, initialized, and have their MCP tools
 * collected into `pluginMcpToolRegistry`. Idempotent — calling twice in
 * the same process is a no-op for already-initialized plugins.
 *
 * Returns the count of registered plugin MCP tools so callers can log
 * + branch.
 */
export async function bootPluginsForMcp(): Promise<{
  registered: number;
  toolCount: number;
}> {
  const config = getConfig();
  const configPlugins = (config?.plugins ?? []) as Parameters<typeof plugins.register>[0][];

  // Register pass — only when the singleton is empty. If Hono booted
  // first the singleton already holds the plugins; re-registering would
  // throw "already registered" (PluginRegistry rejects duplicate ids).
  if (plugins.size === 0 && configPlugins.length > 0) {
    for (const raw of configPlugins) {
      try {
        plugins.register(raw);
      } catch (err) {
        log.error(
          { err: err instanceof Error ? err : new Error(String(err)) },
          "Plugin registration failed during MCP boot — skipping plugin",
        );
      }
    }
  }

  // Initialize pass — only when not already done in this process.
  if (!plugins.isInitialized && plugins.size > 0) {
    const ctx: PluginContextLike = {
      // The MCP boot path does NOT have an internal DB pool wired or
      // analytics ConnectionRegistry — those are boot products of the
      // Hono server. Plugins designed to run in MCP context must
      // tolerate `db: null` and an empty connections list. `tables` is
      // likewise empty (no semantic whitelist) — fine here for two independent
      // reasons: (1) `tools.register` below is a no-op, so the bespoke query
      // tool a plugin builds in `initialize` (which consults `tables` for its
      // whitelist) is built-and-discarded; and (2) MCP serves only the tools a
      // plugin returns from `mcpTools()` (wired separately by
      // `wireMcpToolPlugins`), never the agent tools passed to `tools.register`
      // — and the ES/SF DSL tools register only via `tools.register`. The real,
      // whitelist-backed context is the Hono boot's.
      db: null,
      connections: { get: () => ({}), list: () => [], tables: () => [] },
      tools: { register: () => {} },
      logger: log as unknown as Record<string, unknown>,
      config: (config ?? {}) as unknown as Record<string, unknown>,
    };

    const { failed } = await plugins.initializeAll(ctx);
    if (failed.length > 0) {
      log.warn({ failed }, "Some plugins failed to initialize in MCP boot");
    }
  }

  // Wire MCP tools — idempotent only when the registry was empty. If
  // wireMcpToolPlugins was already called in the same process (Hono +
  // SSE in one process), the registry already holds the entries and
  // re-wiring would throw "already registered" via the namespace
  // collision guard.
  if (pluginMcpToolRegistry.size === 0 && plugins.size > 0) {
    const result = wireMcpToolPlugins(plugins, pluginMcpToolRegistry);
    if (result.failed.length > 0) {
      log.warn(
        { failed: result.failed },
        "Some plugin MCP tools failed to register during MCP boot",
      );
    }
  }

  return {
    registered: plugins.size,
    toolCount: pluginMcpToolRegistry.size,
  };
}
