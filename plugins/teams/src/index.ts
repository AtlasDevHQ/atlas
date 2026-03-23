/**
 * Microsoft Teams Interaction Plugin.
 *
 * @deprecated Use `@useatlas/chat` with the Teams adapter instead.
 * The Chat SDK bridge plugin (`@useatlas/chat`) provides the same Teams
 * functionality plus support for Slack, Discord, and other platforms.
 *
 * Migration:
 * ```typescript
 * // Before (@useatlas/teams):
 * import { teamsPlugin } from "@useatlas/teams";
 * teamsPlugin({
 *   appId: process.env.TEAMS_APP_ID!,
 *   appPassword: process.env.TEAMS_APP_PASSWORD!,
 *   executeQuery,
 * })
 *
 * // After (@useatlas/chat):
 * import { chatPlugin } from "@useatlas/chat";
 * chatPlugin({
 *   adapters: {
 *     teams: {
 *       appId: process.env.TEAMS_APP_ID!,
 *       appPassword: process.env.TEAMS_APP_PASSWORD!,
 *       tenantId: process.env.TEAMS_TENANT_ID,  // optional
 *     },
 *   },
 *   executeQuery,
 *   actions,        // optional — approve/deny flows
 *   conversations,  // optional — persistence
 * })
 * ```
 */

import { createPlugin } from "@useatlas/plugin-sdk";
import type {
  AtlasInteractionPlugin,
  AtlasPluginContext,
  PluginHealthResult,
  PluginLogger,
} from "@useatlas/plugin-sdk";
import { TeamsConfigSchema } from "./config";
import { createTeamsRoutes } from "./routes";
import type { TeamsRuntimeDeps } from "./routes";
import type { TeamsQueryResult } from "./format";

// ---------------------------------------------------------------------------
// Config types
// ---------------------------------------------------------------------------

export interface TeamsPluginConfig {
  /** Microsoft App ID from Azure Bot registration. */
  appId: string;
  /** Microsoft App Password from Azure Bot registration. */
  appPassword: string;
  /** Optional: restrict to a specific Microsoft Entra ID tenant. */
  tenantId?: string;

  // --- Runtime callbacks (injected by host, not end users) ---

  /** Run the Atlas agent on a question and return structured results. Required. */
  executeQuery: (question: string) => Promise<TeamsQueryResult>;

  /** Optional rate limiting callback. */
  checkRateLimit?: (key: string) => { allowed: boolean };

  /** Optional error scrubbing callback. */
  scrubError?: (message: string) => string;
}

// Re-export for host wiring convenience
export type { TeamsQueryResult } from "./format";

// ---------------------------------------------------------------------------
// Plugin builder
// ---------------------------------------------------------------------------

function buildTeamsPlugin(
  config: TeamsPluginConfig,
): AtlasInteractionPlugin<TeamsPluginConfig> {
  let log: PluginLogger | null = null;
  let initialized = false;

  if (typeof config.executeQuery !== "function") {
    throw new Error(
      "executeQuery callback is required and must be a function",
    );
  }

  return {
    id: "teams-interaction",
    types: ["interaction"] as const,
    version: "0.1.0",
    name: "Microsoft Teams Bot",
    config,

    routes(app) {
      const deps: TeamsRuntimeDeps = {
        appId: config.appId,
        appPassword: config.appPassword,
        tenantId: config.tenantId,
        log: log ?? {
          info: (...args: unknown[]) =>
            console.info("[teams-interaction]", ...args),
          warn: (...args: unknown[]) =>
            console.warn("[teams-interaction]", ...args),
          error: (...args: unknown[]) =>
            console.error("[teams-interaction]", ...args),
          debug: () => {},
        },
        executeQuery: config.executeQuery,
        checkRateLimit: config.checkRateLimit,
        scrubError: config.scrubError,
      };

      const teamsRoutes = createTeamsRoutes(deps);
      app.route("", teamsRoutes);
    },

    async initialize(ctx: AtlasPluginContext) {
      if (initialized) {
        throw new Error(
          "Teams plugin already initialized — call teardown() first",
        );
      }

      log = ctx.logger;
      ctx.logger.info("Teams interaction plugin initialized");
      initialized = true;
    },

    async healthCheck(): Promise<PluginHealthResult> {
      const start = performance.now();

      if (!initialized) {
        return {
          healthy: false,
          message: "Teams plugin not initialized",
          latencyMs: Math.round(performance.now() - start),
        };
      }

      if (!config.appId || !config.appPassword) {
        return {
          healthy: false,
          message: "Missing app credentials",
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
 * plugins: [teamsPlugin({ appId: "...", appPassword: "...", executeQuery })]
 * ```
 */
export const teamsPlugin = createPlugin<
  TeamsPluginConfig,
  AtlasInteractionPlugin<TeamsPluginConfig>
>({
  configSchema: TeamsConfigSchema,
  create: buildTeamsPlugin,
});

/** Direct builder for tests or manual construction. */
export { buildTeamsPlugin };
