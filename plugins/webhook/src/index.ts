/**
 * Webhook Interaction Plugin for Atlas.
 *
 * Accepts inbound HTTP requests with a query, runs the Atlas agent,
 * and returns structured results. Designed for Zapier, Make, and n8n
 * integrations.
 *
 * Each webhook channel has its own authentication (API key or HMAC)
 * and can optionally deliver results asynchronously via a callback URL.
 *
 * @example
 * ```typescript
 * import { defineConfig } from "@atlas/api/lib/config";
 * import { webhookPlugin } from "@useatlas/webhook";
 *
 * export default defineConfig({
 *   plugins: [
 *     webhookPlugin({
 *       channels: [
 *         {
 *           channelId: "zapier-prod",
 *           authType: "api-key",
 *           secret: process.env.WEBHOOK_SECRET!,
 *           responseFormat: "json",
 *         },
 *       ],
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
import { WebhookConfigSchema } from "./config";
import type { WebhookPluginConfig, WebhookChannel, WebhookQueryResult } from "./config";
import { createWebhookRoutes } from "./routes";
import type { WebhookRuntimeDeps } from "./routes";

// Re-export config types so consumers don't need to import from ./config directly
export type { WebhookPluginConfig, WebhookChannel, WebhookQueryResult } from "./config";

// ---------------------------------------------------------------------------
// Plugin builder
// ---------------------------------------------------------------------------

function buildWebhookPlugin(
  config: WebhookPluginConfig,
): AtlasInteractionPlugin<WebhookPluginConfig> {
  let log: PluginLogger | null = null;
  let initialized = false;

  const channelMap = new Map<string, WebhookChannel>();
  for (const ch of config.channels) {
    if (channelMap.has(ch.channelId)) {
      throw new Error(`Duplicate channelId "${ch.channelId}" — each channel must have a unique ID`);
    }
    channelMap.set(ch.channelId, ch);
  }

  if (typeof config.executeQuery !== "function") {
    throw new Error("executeQuery callback is required and must be a function");
  }

  return {
    id: "webhook-interaction",
    types: ["interaction"] as const,
    version: "0.1.0",
    name: "Webhook",
    config,

    routes(app) {
      const deps: WebhookRuntimeDeps = {
        channels: channelMap,
        log: log ?? {
          info: () => {},
          warn: (...args: unknown[]) => console.warn("[webhook-interaction]", ...args),
          error: (...args: unknown[]) => console.error("[webhook-interaction]", ...args),
          debug: () => {},
        },
        executeQuery: config.executeQuery,
      };

      const webhookRoutes = createWebhookRoutes(deps);
      app.route("", webhookRoutes);
    },

    async initialize(ctx: AtlasPluginContext) {
      if (initialized) {
        throw new Error("Webhook plugin already initialized — call teardown() first");
      }

      log = ctx.logger;
      ctx.logger.info(
        `Webhook interaction plugin initialized (${config.channels.length} channel${config.channels.length === 1 ? "" : "s"})`,
      );
      initialized = true;
    },

    async healthCheck(): Promise<PluginHealthResult> {
      const start = performance.now();

      if (!initialized) {
        return {
          healthy: false,
          message: "Webhook plugin not initialized",
          latencyMs: Math.round(performance.now() - start),
        };
      }

      if (channelMap.size === 0) {
        return {
          healthy: false,
          message: "No webhook channels configured",
          latencyMs: Math.round(performance.now() - start),
        };
      }

      return { healthy: true, latencyMs: Math.round(performance.now() - start) };
    },

    async teardown() {
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
 * plugins: [webhookPlugin({ channels: [...], executeQuery })]
 * ```
 */
export const webhookPlugin = createPlugin<
  WebhookPluginConfig,
  AtlasInteractionPlugin<WebhookPluginConfig>
>({
  configSchema: WebhookConfigSchema,
  create: buildWebhookPlugin,
});

/** Direct builder for tests or manual construction. */
export { buildWebhookPlugin };
