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
       * Per-workspace uninstall hook (#3188) — reference implementation.
       *
       * Revokes the dynamic webhook subscriptions this integration
       * registered with Jira (`/rest/api/3/webhook`) so Jira stops
       * delivering events for a workspace that no longer has the plugin
       * installed. Invoked by the host BEFORE the install row and
       * credentials are removed, so the Basic-auth credential is still
       * valid here.
       *
       * Failure semantics: a 403/404 from the list endpoint means this
       * credential owns no dynamic webhooks (or the deployment doesn't
       * expose the API) — nothing to revoke, return cleanly. Any other
       * non-OK response throws; the host logs the failure (plugin id +
       * workspaceId) and the uninstall proceeds regardless.
       */
      async onUninstall(workspaceId: string): Promise<void> {
        const auth = Buffer.from(`${config.email}:${config.apiToken}`).toString("base64");
        const base = config.host.replace(/\/$/, "");
        const headers = {
          Authorization: `Basic ${auth}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        };

        const listResponse = await fetch(`${base}/rest/api/3/webhook`, {
          method: "GET",
          headers,
          signal: AbortSignal.timeout(10_000),
        });
        if (listResponse.status === 403 || listResponse.status === 404) {
          log?.info(
            { workspaceId, status: listResponse.status },
            "JIRA onUninstall: credential owns no dynamic webhooks — nothing to revoke",
          );
          return;
        }
        if (!listResponse.ok) {
          throw new Error(
            `JIRA onUninstall: webhook list returned HTTP ${listResponse.status}`,
          );
        }

        const parsed = (await listResponse.json()) as {
          values?: Array<{ id: number }>;
        };
        const webhookIds = (parsed.values ?? []).map((v) => v.id);
        if (webhookIds.length === 0) {
          log?.info(
            { workspaceId },
            "JIRA onUninstall: no webhook subscriptions registered — nothing to revoke",
          );
          return;
        }

        const deleteResponse = await fetch(`${base}/rest/api/3/webhook`, {
          method: "DELETE",
          headers,
          body: JSON.stringify({ webhookIds }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!deleteResponse.ok) {
          throw new Error(
            `JIRA onUninstall: webhook revocation returned HTTP ${deleteResponse.status} — ${webhookIds.length} subscription(s) may still be delivering`,
          );
        }
        log?.info(
          { workspaceId, revoked: webhookIds.length },
          "JIRA onUninstall: revoked webhook subscriptions",
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
