/**
 * Webhook Action Plugin — outbound HTTPS POST with HMAC-SHA256
 * signing. Mirrors the Email plugin's shape — second
 * form-based-install action plugin under #2661.
 *
 * @example
 * ```typescript
 * import { defineConfig } from "@atlas/api/lib/config";
 * import { webhookActionPlugin } from "@useatlas/webhook-action";
 *
 * export default defineConfig({
 *   plugins: [
 *     webhookActionPlugin({
 *       url: "https://hooks.example.com/atlas",
 *       signing_secret: process.env.WEBHOOK_SIGNING_SECRET!,
 *       retry_policy: "exponential",
 *     }),
 *   ],
 * });
 * ```
 */

import { z } from "zod";
import { createPlugin } from "@useatlas/plugin-sdk";
import type { AtlasActionPlugin, PluginAction } from "@useatlas/plugin-sdk";
import { createWebhookTool } from "./tool";
import type { WebhookActionPluginConfig } from "./tool";

export type { WebhookActionPluginConfig } from "./tool";
export { hmacSign, executeWebhookPost } from "./tool";

const webhookConfigSchema = z.object({
  url: z
    .string()
    .min(1, "url must not be empty")
    .refine(
      (raw) => {
        try {
          return new URL(raw).protocol === "https:";
        } catch {
          return false;
        }
      },
      "url must be a well-formed https:// URL",
    ),
  signing_secret: z.string().min(1, "signing_secret must not be empty"),
  retry_policy: z.enum(["none", "exponential"]).optional(),
  approvalMode: z.enum(["auto", "manual", "admin-only"]).optional(),
}) satisfies z.ZodType<WebhookActionPluginConfig>;

const PLUGIN_DESCRIPTION = `### Outbound Webhook
Use postWebhook to POST a JSON payload to the configured destination:
- Body is signed with HMAC-SHA256 and sent in the X-Atlas-Signature header
- Receivers verify by computing HMAC_SHA256(secret, raw_body) and constant-time comparing
- Retries 5xx responses with exponential backoff when retry_policy is "exponential"`;

export const webhookActionPlugin = createPlugin<
  WebhookActionPluginConfig,
  AtlasActionPlugin<WebhookActionPluginConfig>
>({
  configSchema: webhookConfigSchema,

  create(config) {
    const webhookTool = createWebhookTool(config);

    const action: PluginAction = {
      name: "postWebhook",
      description: PLUGIN_DESCRIPTION,
      tool: webhookTool,
      actionType: "webhook:post",
      reversible: false,
      defaultApproval: config.approvalMode ?? "admin-only",
      requiredCredentials: ["signing_secret"],
    };

    return {
      id: "webhook-action",
      types: ["action"] as const,
      version: "1.0.0",
      name: "Webhook Action",
      config,

      actions: [action],

      async initialize(ctx) {
        ctx.logger.info(`Webhook action plugin initialized (${safeHost(config.url)})`);
      },

      async healthCheck() {
        // Webhook destinations don't have a standard liveness endpoint —
        // a HEAD probe could 405 on receivers that only accept POST, and
        // we don't want to send a real signed payload at boot. Returning
        // healthy unconditionally matches Email's stance: surface real
        // failures at first send rather than at init.
        return { healthy: true, latencyMs: 0 };
      },
    };
  },
});

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "<unparseable>";
  }
}
