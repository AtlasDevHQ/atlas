/**
 * Slack Interaction Plugin — reference implementation for AtlasInteractionPlugin.
 *
 * Integrates Slack as an interaction surface for Atlas: slash commands,
 * threaded conversations, Block Kit formatting, OAuth multi-workspace
 * installs, and action approval buttons.
 *
 * This is the first InteractionPlugin to use the `routes()` interface,
 * validating the plugin SDK's route-mounting design.
 *
 * Runtime dependencies (agent executor, conversations, actions, rate
 * limiting) are injected via config callbacks rather than imported from
 * `@atlas/api`. This surfaces the AtlasPluginContext gaps that need to
 * be addressed in v1.1 for full host-level decoupling.
 *
 * @example
 * ```typescript
 * import { defineConfig } from "@atlas/api/lib/config";
 * import { executeAgentQuery } from "@atlas/api/lib/agent-query";
 * import { slackPlugin } from "@useatlas/slack";
 *
 * export default defineConfig({
 *   plugins: [
 *     slackPlugin({
 *       signingSecret: process.env.SLACK_SIGNING_SECRET!,
 *       botToken: process.env.SLACK_BOT_TOKEN,
 *       executeQuery: executeAgentQuery,
 *     }),
 *   ],
 * });
 * ```
 */

import { z } from "zod";
import { createPlugin } from "@useatlas/plugin-sdk";
import type {
  AtlasInteractionPlugin,
  AtlasPluginContext,
  PluginHealthResult,
  PluginLogger,
} from "@useatlas/plugin-sdk";
import { createSlackRoutes } from "./routes";
import type {
  ConversationCallbacks,
  ActionCallbacks,
  SlackRuntimeDeps,
} from "./routes";
import type { SlackQueryResult } from "./format";
import type { PluginDB } from "./store";

// ---------------------------------------------------------------------------
// Config types
// ---------------------------------------------------------------------------

export interface SlackPluginConfig {
  /** Slack signing secret for request verification. */
  signingSecret: string;
  /** Bot token for single-workspace mode. */
  botToken?: string;
  /** Client ID for multi-workspace OAuth. */
  clientId?: string;
  /** Client secret for multi-workspace OAuth. */
  clientSecret?: string;

  // --- Runtime callbacks (injected by host, not end users) ---

  /** Run the Atlas agent on a question and return structured results. Required. */
  executeQuery: (
    question: string,
    options?: {
      priorMessages?: Array<{ role: "user" | "assistant"; content: string }>;
    },
  ) => Promise<SlackQueryResult>;

  /** Optional rate limiting callback. */
  checkRateLimit?: (key: string) => { allowed: boolean };

  /** Optional conversation persistence callbacks. */
  conversations?: ConversationCallbacks;

  /** Optional action framework callbacks. */
  actions?: ActionCallbacks;

  /** Optional error scrubbing callback. */
  scrubError?: (message: string) => string;
}

// Re-export for host wiring convenience
export type { SlackQueryResult } from "./format";
export type { ConversationCallbacks, ActionCallbacks } from "./routes";

// ---------------------------------------------------------------------------
// Config schema — validates credential fields, passes through callbacks
// ---------------------------------------------------------------------------

const SlackConfigSchema = z
  .object({
    signingSecret: z.string().min(1, "signingSecret must not be empty"),
    botToken: z.string().optional(),
    clientId: z.string().optional(),
    clientSecret: z.string().optional(),
    // Runtime callbacks — z.any() with refinement validates the value is callable.
    // TypeScript provides compile-time safety via SlackPluginConfig.
    executeQuery: z.any().refine((v) => typeof v === "function", "executeQuery must be a function"),
    checkRateLimit: z.any().refine((v) => v === undefined || typeof v === "function", "checkRateLimit must be a function").optional(),
    conversations: z.any().refine(
      (v) => v === undefined || (typeof v === "object" && v !== null && typeof v.create === "function" && typeof v.get === "function"),
      "conversations must implement { create, addMessage, get, generateTitle }",
    ).optional(),
    actions: z.any().refine(
      (v) => v === undefined || (typeof v === "object" && v !== null && typeof v.approve === "function" && typeof v.deny === "function"),
      "actions must implement { approve, deny, get }",
    ).optional(),
    scrubError: z.any().refine((v) => v === undefined || typeof v === "function", "scrubError must be a function").optional(),
  })
  .refine(
    (c) => c.botToken || (c.clientId && c.clientSecret),
    "Either botToken (single-workspace) or clientId + clientSecret (OAuth) required",
  );

// ---------------------------------------------------------------------------
// Plugin builder
// ---------------------------------------------------------------------------

function buildSlackPlugin(
  config: SlackPluginConfig,
): AtlasInteractionPlugin<SlackPluginConfig> {
  // Runtime state — set during initialize()
  let db: PluginDB | null = null;
  let log: PluginLogger | null = null;
  let initialized = false;

  // Validate executeQuery is actually a function at runtime
  if (typeof config.executeQuery !== "function") {
    throw new Error("executeQuery callback is required and must be a function");
  }

  return {
    id: "slack-interaction",
    types: ["interaction"] as const,
    version: "0.1.0",
    name: "Slack Bot",
    config,

    schema: {
      slack_installations: {
        fields: {
          team_id: { type: "string", required: true, unique: true },
          bot_token: { type: "string", required: true },
          installed_at: { type: "date" },
        },
      },
      slack_threads: {
        fields: {
          channel_id: { type: "string", required: true },
          thread_ts: { type: "string", required: true },
          conversation_id: { type: "string", required: true },
        },
      },
    },

    routes(app) {
      const deps: SlackRuntimeDeps = {
        signingSecret: config.signingSecret,
        botToken: config.botToken,
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        db,
        log: log ?? {
          info: () => {},
          warn: (...args: unknown[]) => console.warn("[slack-interaction]", ...args),
          error: (...args: unknown[]) => console.error("[slack-interaction]", ...args),
          debug: () => {},
        },
        executeQuery: config.executeQuery,
        checkRateLimit: config.checkRateLimit,
        conversations: config.conversations,
        actions: config.actions,
        scrubError: config.scrubError,
      };

      const slackRoutes = createSlackRoutes(deps);
      app.route("", slackRoutes);
    },

    async initialize(ctx: AtlasPluginContext) {
      if (initialized) {
        throw new Error("Slack plugin already initialized — call teardown() first");
      }

      db = ctx.db;
      log = ctx.logger;

      const mode = config.botToken
        ? "single-workspace (bot token)"
        : "multi-workspace (OAuth)";
      ctx.logger.info(`Slack interaction plugin initialized (${mode})`);
      initialized = true;
    },

    async healthCheck(): Promise<PluginHealthResult> {
      const start = performance.now();

      if (!initialized) {
        return {
          healthy: false,
          message: "Slack plugin not initialized",
          latencyMs: Math.round(performance.now() - start),
        };
      }

      if (!config.signingSecret) {
        return {
          healthy: false,
          message: "Missing signing secret",
          latencyMs: Math.round(performance.now() - start),
        };
      }

      // If a bot token is available, verify it against the Slack API
      const botToken = config.botToken;
      if (botToken) {
        try {
          const response = await fetch("https://slack.com/api/auth.test", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${botToken}`,
              "Content-Type": "application/x-www-form-urlencoded",
            },
            signal: AbortSignal.timeout(5000),
          });
          const latencyMs = Math.round(performance.now() - start);
          if (!response.ok) {
            return { healthy: false, message: `Slack API returned HTTP ${response.status}`, latencyMs };
          }
          const body = await response.json() as { ok: boolean; error?: string };
          if (!body.ok) {
            return { healthy: false, message: `Slack auth.test failed: ${body.error ?? "unknown"}`, latencyMs };
          }
          return { healthy: true, latencyMs };
        } catch (err) {
          return {
            healthy: false,
            message: err instanceof Error ? err.message : String(err),
            latencyMs: Math.round(performance.now() - start),
          };
        }
      }

      return { healthy: true, latencyMs: Math.round(performance.now() - start) };
    },

    async teardown() {
      db = null;
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
 * plugins: [slackPlugin({ signingSecret: "...", botToken: "xoxb-...", executeQuery })]
 * ```
 */
export const slackPlugin = createPlugin<
  SlackPluginConfig,
  AtlasInteractionPlugin<SlackPluginConfig>
>({
  configSchema: SlackConfigSchema,
  create: buildSlackPlugin,
});

/** Direct builder for tests or manual construction. */
export { buildSlackPlugin };
