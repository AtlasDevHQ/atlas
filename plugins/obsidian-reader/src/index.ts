/**
 * Obsidian Reader Plugin — read-only access to an Obsidian vault via
 * the Obsidian Local REST API plugin.
 *
 * @example
 * ```typescript
 * import { defineConfig } from "@atlas/api/lib/config";
 * import { obsidianReaderPlugin } from "@useatlas/obsidian-reader";
 *
 * export default defineConfig({
 *   plugins: [
 *     obsidianReaderPlugin({
 *       api_url: "http://127.0.0.1:27123",
 *       api_key: process.env.OBSIDIAN_API_KEY!,
 *     }),
 *   ],
 * });
 * ```
 */

import { z } from "zod";
import { createPlugin } from "@useatlas/plugin-sdk";
import type { AtlasActionPlugin, PluginAction } from "@useatlas/plugin-sdk";
import { createObsidianTool, stripTrailingSlashes } from "./tool";
import type { ObsidianReaderPluginConfig } from "./tool";

export type { ObsidianReaderPluginConfig } from "./tool";
export { executeObsidianSearch } from "./tool";

const obsidianConfigSchema = z.object({
  api_url: z.string().min(1, "api_url must not be empty").optional(),
  api_key: z.string().min(1, "api_key must not be empty"),
}) satisfies z.ZodType<ObsidianReaderPluginConfig>;

const PLUGIN_DESCRIPTION = `### Read Obsidian Vault
Use readObsidianVault to search the user's connected Obsidian vault for
notes, definitions, or prior analysis. Read-only — the tool never writes.`;

export const obsidianReaderPlugin = createPlugin<
  ObsidianReaderPluginConfig,
  AtlasActionPlugin<ObsidianReaderPluginConfig>
>({
  configSchema: obsidianConfigSchema,

  create(config) {
    const obsidianTool = createObsidianTool(config);

    const action: PluginAction = {
      name: "readObsidianVault",
      description: PLUGIN_DESCRIPTION,
      tool: obsidianTool,
      actionType: "obsidian:read",
      // Read-only — nothing to undo, so trivially reversible (matches
      // the Jira ticket-read convention).
      reversible: true,
      // Read-only — safe to invoke without approval (mirrors executeSQL).
      defaultApproval: "auto",
      requiredCredentials: ["api_key"],
    };

    return {
      id: "obsidian-reader",
      types: ["action"] as const,
      version: "1.0.0",
      name: "Obsidian Reader",
      config,

      actions: [action],

      async initialize(ctx) {
        ctx.logger.info(`Obsidian reader plugin initialized (${safeHost(config.api_url)})`);
      },

      async healthCheck() {
        const start = performance.now();
        const base = stripTrailingSlashes(config.api_url ?? "http://127.0.0.1:27123");
        try {
          const response = await fetch(`${base}/`, {
            method: "GET",
            headers: { Authorization: `Bearer ${config.api_key}` },
            signal: AbortSignal.timeout(5000),
          });
          const latencyMs = Math.round(performance.now() - start);
          if (response.ok || response.status === 401) {
            // 401 means the plugin is running but the key is wrong — still
            // a "reachable" signal. The agent will surface the auth error
            // on a real call. A flat fail here would block install retries
            // on transient TLS / proxy weirdness in the wider network.
            if (!response.ok) {
              // No logger context in healthCheck — emit to stderr so an
              // operator scanning logs sees the specific misconfig.
              console.warn("[obsidian-reader] healthCheck: REST API rejected the API key (401)");
            }
            return response.ok
              ? { healthy: true, latencyMs }
              : { healthy: false, message: "Obsidian REST API rejected the API key", latencyMs };
          }
          return {
            healthy: false,
            message: `Obsidian REST API returned ${response.status}`,
            latencyMs,
          };
        } catch (err) {
          return {
            healthy: false,
            message: err instanceof Error ? err.message : String(err),
            latencyMs: Math.round(performance.now() - start),
          };
        }
      },
    };
  },
});

function safeHost(url: string | undefined): string {
  try {
    return new URL(url ?? "http://127.0.0.1:27123").host;
  } catch {
    return "<unparseable>";
  }
}
