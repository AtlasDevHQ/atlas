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
import type { AtlasActionPlugin, PluginAction, PluginLogger } from "@useatlas/plugin-sdk";
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

    // Captured at initialize() so onUninstall can log through the
    // host-scoped child logger. Null until the host initializes us.
    let log: PluginLogger | null = null;

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
        log = ctx.logger;
        ctx.logger.info(`JIRA plugin initialized for project ${config.projectKey}`);
      },

      /**
       * Per-workspace uninstall hook (#3188) — intentional no-op.
       *
       * This plugin instance is deployment-wide (one operator-config
       * Basic credential, id `jira-action`) and is invoked whenever ANY
       * workspace uninstalls the jira catalog entry. It never registers
       * webhooks — so there is nothing here that can be positively
       * attributed to (a) this plugin AND (b) the uninstalling
       * workspace.
       *
       * The hard rule: never revoke an external subscription you cannot
       * attribute to both. An earlier draft listed `/rest/api/3/webhook`
       * and DELETEd every returned id — that nuked subscriptions created
       * out-of-band by other tooling sharing the bot credential, for
       * every workspace, on any single workspace's uninstall. If this
       * plugin ever starts registering webhooks, tag each registration
       * with a workspace marker (e.g. a `?atlas_workspace_id=<id>` query
       * param on the callback URL, since Jira webhooks carry no metadata
       * field) and revoke only the ids that carry the uninstalling
       * workspace's marker — see the correctly-scoped per-workspace
       * reference implementation in
       * `packages/api/src/lib/integrations/jira/lazy-builder.ts`.
       */
      async onUninstall(workspaceId: string): Promise<void> {
        log?.debug(
          { workspaceId },
          "JIRA onUninstall: no-op — this operator-config instance registers no per-workspace webhooks, so there is nothing attributable to revoke",
        );
      },

      async healthCheck() {
        const start = performance.now();
        const auth = Buffer.from(`${config.email}:${config.apiToken}`).toString("base64");
        const url = `${config.host.replace(/\/$/, "")}/rest/api/3/myself`;

        try {
          const response = await fetch(url, {
            method: "GET",
            headers: {
              Authorization: `Basic ${auth}`,
              Accept: "application/json",
            },
            signal: AbortSignal.timeout(5000),
          });
          const latencyMs = Math.round(performance.now() - start);

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
            latencyMs: Math.round(performance.now() - start),
          };
        }
      },
    };
  },
});
