/**
 * MCP-side bridge for plugin-contributed tools (#2078).
 *
 * Walks the global `pluginMcpToolRegistry` populated by
 * `wireMcpToolPlugins` (during plugin wiring at boot) and registers each
 * tool on the MCP server. Reuses `traceMcpToolCall` so plugin tools get
 * the same OTel span / counter / latency-histogram coverage as native
 * tools — operators see plugin adoption alongside `executeSQL` /
 * `runMetric` in the same dashboard.
 *
 * The api-side `registerPluginMcpTools` already wraps every dispatch in
 * `withRequestContext({ actor: { kind: "mcp", clientId, toolName } })`
 * (so audit_log + RLS pick up the actor) and applies the per-OAuth-client
 * rate limiter when `clientId` is set. This MCP-side bridge is a thin
 * shim that injects `traceMcpToolCall` for the OTel coverage and
 * forwards the structural `McpServer` to the api-side core.
 *
 * Atlas's own tools register first via `registerTools(server, ...)`;
 * plugin tools register on top here so plugin contributions cannot
 * silently shadow native tools (the namespacing rule
 * `<plugin-id>.<name>` already makes shadowing impossible — ordering is
 * a redundant guard for symmetry with `wireActionPlugins`).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AtlasUser } from "@atlas/api/lib/auth/types";
import {
  pluginMcpToolRegistry,
  registerPluginMcpTools as registerPluginMcpToolsCore,
  type PluginMcpToolRegistry,
} from "@atlas/api/lib/plugins/mcp-tools";
import {
  traceMcpToolCall,
  type McpDeployMode,
  type McpTransport,
} from "./telemetry.js";

export interface RegisterPluginToolsOptions {
  /** Bound MCP actor — same shape `tools.ts` consumes. */
  actor: AtlasUser;
  transport?: McpTransport;
  clientId?: string;
  workspaceId: string;
  deployMode: McpDeployMode;
  /** Override the registry (test seam). */
  registry?: PluginMcpToolRegistry;
}

/** Register every plugin MCP tool on the MCP server. Returns the count. */
export function registerPluginTools(
  server: McpServer,
  opts: RegisterPluginToolsOptions,
): number {
  const registry = opts.registry ?? pluginMcpToolRegistry;
  const transport: McpTransport = opts.transport ?? "stdio";

  registerPluginMcpToolsCore(
    server as unknown as Parameters<typeof registerPluginMcpToolsCore>[0],
    {
      registry,
      actor: opts.actor,
      transport,
      workspaceId: opts.workspaceId,
      deployMode: opts.deployMode,
      ...(opts.clientId && { clientId: opts.clientId }),
      // The api-side dispatch always resolves the wrapper with an
      // `McpCallToolResult` (structurally a `CallToolResult`). Cast
      // to/from `Promise<CallToolResult>` so `traceMcpToolCall` (which
      // is fixed to `CallToolResult`) accepts the wrapped fn without
      // forcing the api side to take a CallToolResult dependency.
      traceWrap: ((spanCtx, fn) =>
        traceMcpToolCall(
          spanCtx,
          fn as () => Promise<CallToolResult>,
        )) as NonNullable<Parameters<typeof registerPluginMcpToolsCore>[1]["traceWrap"]>,
    },
  );

  return registry.size;
}
