/**
 * Atlas Chat SDK Bridge Plugin.
 *
 * Bridges vercel/chat (Chat SDK) into the Atlas plugin system as a unified
 * interaction layer. Instead of maintaining separate per-platform plugins,
 * this single plugin handles Slack, Teams, Discord, and more through Chat
 * SDK adapters.
 *
 * @example
 * ```typescript
 * import { defineConfig } from "@atlas/api/lib/config";
 * import { chatPlugin } from "@useatlas/chat";
 *
 * export default defineConfig({
 *   plugins: [
 *     chatPlugin({
 *       adapters: {
 *         slack: {
 *           botToken: process.env.SLACK_BOT_TOKEN!,
 *           signingSecret: process.env.SLACK_SIGNING_SECRET!,
 *         },
 *       },
 *       executeQuery: myQueryFunction,
 *     }),
 *   ],
 * });
 * ```
 */

import { createPlugin } from "@useatlas/plugin-sdk";
import type {
  AtlasInteractionPlugin,
  AtlasPluginContext,
  PluginHealthResult,
  PluginLogger,
} from "@useatlas/plugin-sdk";
import { ChatConfigSchema } from "./config";
import type { ChatPluginConfig } from "./config";
import { createChatBridge } from "./bridge";
import type { ChatBridge } from "./bridge";

// Re-export types for host wiring convenience
export type { ChatPluginConfig, ChatQueryResult, ChatMessage } from "./config";
export type { ChatBridge } from "./bridge";

// ---------------------------------------------------------------------------
// Plugin builder
// ---------------------------------------------------------------------------

function buildChatPlugin(
  config: ChatPluginConfig,
): AtlasInteractionPlugin<ChatPluginConfig> {
  let bridge: ChatBridge | null = null;
  let log: PluginLogger | null = null;
  let initialized = false;

  if (typeof config.executeQuery !== "function") {
    throw new Error("executeQuery callback is required and must be a function");
  }

  return {
    id: "chat-interaction",
    types: ["interaction"] as const,
    version: "0.1.0",
    name: "Chat SDK Bridge",
    config,

    routes(app) {
      // Mount Chat SDK webhook handlers under the plugin route prefix.
      // The bridge is created during initialize() — routes that arrive
      // before initialization return 503.
      if (config.adapters.slack) {
        app.post("/webhooks/slack", async (c) => {
          if (!bridge) {
            return c.json({ error: "Chat plugin not yet initialized" }, 503);
          }

          const handler = bridge.webhooks.slack;
          if (!handler) {
            return c.json({ error: "Slack adapter not configured" }, 404);
          }

          const response = await handler(c.req.raw, {
            waitUntil: (task: Promise<unknown>) => {
              task.catch((err: unknown) => {
                (log ?? console).error(
                  { err: err instanceof Error ? err : new Error(String(err)) },
                  "Chat SDK webhook background task failed",
                );
              });
            },
          });
          return response;
        });
      }
    },

    async initialize(ctx: AtlasPluginContext) {
      if (initialized) {
        throw new Error(
          "Chat plugin already initialized — call teardown() first",
        );
      }

      log = ctx.logger;
      bridge = createChatBridge(config, ctx.logger);

      const enabledAdapters = Object.entries(config.adapters)
        .filter(([, v]) => v !== undefined)
        .map(([k]) => k);

      ctx.logger.info(
        { adapters: enabledAdapters },
        `Chat interaction plugin initialized (${enabledAdapters.join(", ")})`,
      );
      initialized = true;
    },

    async healthCheck(): Promise<PluginHealthResult> {
      const start = performance.now();

      if (!initialized || !bridge) {
        return {
          healthy: false,
          message: "Chat plugin not initialized",
          latencyMs: Math.round(performance.now() - start),
        };
      }

      const enabledAdapters = Object.entries(config.adapters)
        .filter(([, v]) => v !== undefined)
        .map(([k]) => k);

      if (enabledAdapters.length === 0) {
        return {
          healthy: false,
          message: "No adapters configured",
          latencyMs: Math.round(performance.now() - start),
        };
      }

      return {
        healthy: true,
        message: `Adapters: ${enabledAdapters.join(", ")}`,
        latencyMs: Math.round(performance.now() - start),
      };
    },

    async teardown() {
      if (bridge) {
        await bridge.shutdown();
        bridge = null;
      }
      log = null;
      initialized = false;
    },
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Factory function for use in atlas.config.ts plugins array.
 *
 * @example
 * ```typescript
 * plugins: [chatPlugin({
 *   adapters: { slack: { botToken: "xoxb-...", signingSecret: "..." } },
 *   executeQuery: myQueryFunction,
 * })]
 * ```
 */
export const chatPlugin = createPlugin<
  ChatPluginConfig,
  AtlasInteractionPlugin<ChatPluginConfig>
>({
  configSchema: ChatConfigSchema,
  create: buildChatPlugin,
});

/** Direct builder for tests or manual construction. */
export { buildChatPlugin };
