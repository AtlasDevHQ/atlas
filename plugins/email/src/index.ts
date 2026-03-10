/**
 * Email Action Plugin — reference implementation for AtlasActionPlugin.
 *
 * Sends email reports via the Resend API with config-driven credentials
 * and optional domain allowlisting.
 *
 * @example
 * ```typescript
 * import { defineConfig } from "@atlas/api/lib/config";
 * // Workspace dependency — not published to npm
 * import { emailPlugin } from "@useatlas/email";
 *
 * export default defineConfig({
 *   plugins: [
 *     emailPlugin({
 *       resendApiKey: "re_...",
 *       allowedDomains: ["myco.com"],
 *       fromAddress: "Atlas <atlas@myco.com>",
 *     }),
 *   ],
 * });
 * ```
 */

import { z } from "zod";
import { createPlugin } from "@useatlas/plugin-sdk";
import type { AtlasActionPlugin, PluginAction } from "@useatlas/plugin-sdk";
import { createEmailTool } from "./tool";
import type { EmailPluginConfig } from "./tool";

export type { EmailPluginConfig } from "./tool";

// ---------------------------------------------------------------------------
// Config schema (validated at factory call time via createPlugin)
// ---------------------------------------------------------------------------

const emailConfigSchema = z.object({
  /** Resend API key (from https://resend.com/api-keys). */
  resendApiKey: z.string().min(1, "Resend API key must not be empty"),
  /** Optional domain allowlist — only these recipient domains are permitted. */
  allowedDomains: z.array(z.string().min(1, "domain must not be empty")).optional(),
  /** Sender address. Defaults to "Atlas <atlas@notifications.useatlas.dev>". */
  fromAddress: z.string().min(1, "fromAddress must not be empty").optional(),
  /** Approval mode for email sends. Defaults to "admin-only". */
  approvalMode: z.enum(["auto", "manual", "admin-only"]).optional(),
}) satisfies z.ZodType<EmailPluginConfig>;

// ---------------------------------------------------------------------------
// Plugin description
// ---------------------------------------------------------------------------

const PLUGIN_DESCRIPTION = `### Send Email Report
Use sendEmailReport to email analysis results to stakeholders:
- Provide recipient email addresses
- Include a clear subject line
- Format the body as HTML for rich formatting
- Domain restrictions may apply based on plugin configuration`;

// ---------------------------------------------------------------------------
// Plugin factory
// ---------------------------------------------------------------------------

export const emailPlugin = createPlugin<EmailPluginConfig, AtlasActionPlugin<EmailPluginConfig>>({
  configSchema: emailConfigSchema,

  create(config) {
    const emailTool = createEmailTool(config);

    const action: PluginAction = {
      name: "sendEmailReport",
      description: PLUGIN_DESCRIPTION,
      tool: emailTool,
      actionType: "email:send",
      reversible: false,
      defaultApproval: config.approvalMode ?? "admin-only",
      requiredCredentials: ["resendApiKey"],
    };

    return {
      id: "email-action",
      types: ["action"] as const,
      version: "1.0.0",
      name: "Email Action",
      config,

      actions: [action],

      async initialize(ctx) {
        const domainInfo = config.allowedDomains?.length
          ? ` (domains: ${config.allowedDomains.join(", ")})`
          : "";
        ctx.logger.info(`Email plugin initialized${domainInfo}`);
      },

      async healthCheck() {
        const start = performance.now();
        try {
          const response = await fetch("https://api.resend.com/domains", {
            method: "GET",
            headers: { Authorization: `Bearer ${config.resendApiKey}` },
            signal: AbortSignal.timeout(5000),
          });
          const latencyMs = Math.round(performance.now() - start);

          if (response.ok) {
            return { healthy: true, latencyMs };
          }
          return {
            healthy: false,
            message: `Resend API returned ${response.status}`,
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
