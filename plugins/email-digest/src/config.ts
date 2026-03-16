/**
 * Email digest plugin configuration schema.
 *
 * Supports SMTP, SendGrid, and SES transports for sending digest emails.
 */

import { z } from "zod";

export const SmtpConfigSchema = z.object({
  host: z.string().min(1, "SMTP host must not be empty"),
  port: z.number().int().min(1).max(65535),
  auth: z
    .object({
      user: z.string().min(1),
      pass: z.string().min(1),
    })
    .optional(),
});

export type SmtpConfig = z.infer<typeof SmtpConfigSchema>;

export const EmailDigestConfigSchema = z
  .object({
    /** Sender email address (e.g. "Atlas <digest@myco.com>"). */
    from: z.string().min(1, "from address must not be empty"),
    /** Email transport to use for sending digests. */
    transport: z.enum(["smtp", "sendgrid", "ses"]),
    /** SMTP configuration (required when transport is "smtp"). */
    smtp: SmtpConfigSchema.optional(),
    /** API key for SendGrid or SES (required when transport is "sendgrid" or "ses"). */
    apiKey: z.string().min(1).optional(),
    /** Base URL for unsubscribe/management links. Defaults to ATLAS_PUBLIC_URL env var. */
    publicUrl: z.string().url().optional(),
    /**
     * Callback to run a metric query and return results.
     * Required — the plugin uses this to execute each subscribed metric.
     */
    executeMetric: z
      .any()
      .refine((v) => typeof v === "function", "executeMetric must be a function"),
  })
  .refine(
    (c) => c.transport !== "smtp" || c.smtp !== undefined,
    "smtp config is required when transport is 'smtp'",
  )
  .refine(
    (c) => c.transport === "smtp" || c.apiKey !== undefined,
    "apiKey is required when transport is 'sendgrid' or 'ses'",
  );

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
  transport: "smtp" | "sendgrid" | "ses";
  smtp?: SmtpConfig;
  apiKey?: string;
  publicUrl?: string;
  executeMetric: (metricName: string) => Promise<MetricResult>;
}
