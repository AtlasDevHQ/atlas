/**
 * Webhook plugin configuration schema.
 *
 * Each webhook channel has its own authentication method, response format,
 * and optional callback URL for async delivery.
 */

import { z } from "zod";

export const WebhookChannelSchema = z.object({
  /** Unique identifier for this webhook channel. */
  channelId: z.string().min(1, "channelId must not be empty"),
  /** Authentication method: API key header or HMAC signature. */
  authType: z.enum(["api-key", "hmac"]),
  /** API key or HMAC secret for request verification. */
  secret: z.string().min(1, "secret must not be empty"),
  /** Response format: structured JSON or plain text. */
  responseFormat: z.enum(["json", "text"]).default("json"),
  /** Optional callback URL for async result delivery. */
  callbackUrl: z.string().url().optional(),
});

export type WebhookChannel = z.infer<typeof WebhookChannelSchema>;

export const WebhookConfigSchema = z.object({
  /** One or more webhook channels, each with its own auth and config. */
  channels: z
    .array(WebhookChannelSchema)
    .min(1, "At least one channel is required")
    .refine(
      (chs) => new Set(chs.map((c) => c.channelId)).size === chs.length,
      "channelId values must be unique across channels",
    ),
  /** Run the Atlas agent on a question and return structured results. Required. */
  executeQuery: z
    .any()
    .refine((v) => typeof v === "function", "executeQuery must be a function"),
});

export interface WebhookQueryResult {
  answer: string;
  sql: string[];
  data: Array<{ columns: string[]; rows: Record<string, unknown>[] }>;
}

export interface WebhookPluginConfig {
  channels: WebhookChannel[];
  executeQuery: (question: string) => Promise<WebhookQueryResult>;
}
