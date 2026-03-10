/**
 * JIRA Action Plugin — reference implementation for AtlasActionPlugin.
 *
 * Demonstrates the Plugin SDK's createPlugin() factory pattern with
 * Zod config validation, typed actions, and health checks.
 *
 * @example
 * ```typescript
 * import { defineConfig } from "@atlas/api/lib/config";
 * import { jiraPlugin } from "@useatlas/jira";
 *
 * export default defineConfig({
 *   plugins: [
 *     jiraPlugin({
 *       host: "https://myco.atlassian.net",
 *       email: "bot@myco.com",
 *       apiToken: "...",
 *       projectKey: "ENG",
 *     }),
 *   ],
 * });
 * ```
 */

import { z } from "zod";
import { createPlugin } from "@useatlas/plugin-sdk";
import type { AtlasActionPlugin, PluginAction } from "@useatlas/plugin-sdk";
import { createJiraTool } from "./tool";
import type { JiraPluginConfig } from "./tool";

export type { JiraPluginConfig } from "./tool";

// ---------------------------------------------------------------------------
// Config schema (validated at factory call time via createPlugin)
// ---------------------------------------------------------------------------

const jiraConfigSchema = z.object({
  /** JIRA instance URL (e.g. "https://myco.atlassian.net"). */
  host: z
    .string()
    .url("host must be a valid URL")
    // .url() accepts any scheme (ftp://, ws://); restrict to http/https for JIRA API
    .refine(
      (url) => url.startsWith("https://") || url.startsWith("http://"),
      "host must start with https:// or http://",
    ),
  /** Email for JIRA API authentication (Basic auth). */
  email: z.string().email("email must be a valid email address"),
  /** JIRA API token (from https://id.atlassian.net/manage-profile/security/api-tokens). */
  apiToken: z.string().min(1, "apiToken must not be empty"),
  /** Default JIRA project key (e.g. "ENG"). */
  projectKey: z
    .string()
    .min(1, "projectKey must not be empty")
    .regex(/^[A-Z][A-Z0-9_]*$/, "projectKey must be uppercase alphanumeric (e.g. 'ENG')"),
  /** Optional labels applied to every created issue. */
  labels: z.array(z.string()).optional(),
}) satisfies z.ZodType<JiraPluginConfig>;

// ---------------------------------------------------------------------------
// Plugin description
// ---------------------------------------------------------------------------

const PLUGIN_DESCRIPTION = `### Create JIRA Ticket
Use createJiraTicket to create a new JIRA issue based on the analysis findings:
- Provide a clear, concise summary (max 255 chars)
- Include relevant details in the description
- Optionally specify a project key and labels
- The ticket will require approval before creation`;

// ---------------------------------------------------------------------------
// Plugin factory
// ---------------------------------------------------------------------------

export const jiraPlugin = createPlugin<JiraPluginConfig, AtlasActionPlugin<JiraPluginConfig>>({
  configSchema: jiraConfigSchema,

  create(config) {
    const jiraTool = createJiraTool(config);

    const action: PluginAction = {
      name: "createJiraTicket",
      description: PLUGIN_DESCRIPTION,
      tool: jiraTool,
      actionType: "jira:create",
      reversible: true,
      defaultApproval: "manual",
      requiredCredentials: ["host", "email", "apiToken"],
    };

    return {
      id: "jira-action",
      types: ["action"] as const,
      version: "1.0.0",
      name: "JIRA Action",
      config,

      actions: [action],

      async initialize(ctx) {
        ctx.logger.info(`JIRA plugin initialized for project ${config.projectKey}`);
      },

      async healthCheck() {
        const auth = Buffer.from(`${config.email}:${config.apiToken}`).toString("base64");
        const url = `${config.host.replace(/\/$/, "")}/rest/api/3/myself`;

        try {
          const start = Date.now();
          const response = await fetch(url, {
            method: "GET",
            headers: {
              Authorization: `Basic ${auth}`,
              Accept: "application/json",
            },
            signal: AbortSignal.timeout(10_000),
          });
          const latencyMs = Date.now() - start;

          if (response.ok) {
            return { healthy: true, latencyMs };
          }

          return {
            healthy: false,
            message: `JIRA API returned ${response.status}`,
            latencyMs,
          };
        } catch (err) {
          return {
            healthy: false,
            message: err instanceof Error ? err.message : String(err),
          };
        }
      },
    };
  },
});
