/**
 * Email digest plugin configuration schema.
 *
 * Currently supports SendGrid for sending digest emails.
 * SES and SMTP transports are planned for future releases.
 */

import { z } from "zod";

export const EmailDigestConfigSchema = z.object({
  /** Sender email address. Supports display-name format (e.g. "Atlas <digest@myco.com>"). */
  from: z.string().min(1, "from address must not be empty"),
  /** Email transport. Currently only SendGrid is supported. */
  transport: z.literal("sendgrid"),
  /** SendGrid API key. */
  apiKey: z.string().min(1, "apiKey must not be empty"),
  /** Base URL for unsubscribe/management links (e.g. "https://app.myco.com"). Optional. */
  publicUrl: z.string().url().optional(),
  /**
   * Callback to run a metric query and return results.
   * Required — the plugin uses this to execute each subscribed metric.
   */
  executeMetric: z
    .any()
    .refine((v) => typeof v === "function", "executeMetric must be a function"),
});

export interface MetricResult {
  name: string;
  value: string | number | null;
  previousValue?: string | number | null;
  columns?: string[];
  rows?: Record<string, unknown>[];
  error?: string;
}

export interface EmailDigestPluginConfig {
  from: string;
  transport: "sendgrid";
  apiKey: string;
  publicUrl?: string;
  executeMetric: (metricName: string) => Promise<MetricResult>;
}
