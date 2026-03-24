/**
 * Atlas Chat SDK Bridge Plugin.
 *
 * Bridges vercel/chat (Chat SDK) into the Atlas plugin system as a unified
 * interaction layer. Supports Slack, Teams, Discord, Google Chat, Telegram,
 * GitHub, Linear, and WhatsApp.
 *
 * Replaces the standalone `@useatlas/slack` and `@useatlas/teams` plugins
 * with a unified Chat SDK adapter approach. See the migration guide in README.md.
 *
 * @example
 * ```typescript
 * import { defineConfig } from "@atlas/api/lib/config";
 * import { chatPlugin } from "@useatlas/chat";
 *
 * export default defineConfig({
 *   plugins: [
 *     chatPlugin({
 *       adapters: {
 *         slack: {
 *           botToken: process.env.SLACK_BOT_TOKEN!,
 *           signingSecret: process.env.SLACK_SIGNING_SECRET!,
 *         },
 *         teams: {
 *           appId: process.env.TEAMS_APP_ID!,
 *           appPassword: process.env.TEAMS_APP_PASSWORD!,
 *         },
 *         discord: {
 *           botToken: process.env.DISCORD_BOT_TOKEN!,
 *           applicationId: process.env.DISCORD_APPLICATION_ID!,
 *           publicKey: process.env.DISCORD_PUBLIC_KEY!,
 *         },
 *         gchat: {
 *           credentials: JSON.parse(process.env.GOOGLE_CHAT_CREDENTIALS!),
 *         },
 *         telegram: {
 *           botToken: process.env.TELEGRAM_BOT_TOKEN!,
 *         },
 *         github: {
 *           appId: process.env.GITHUB_APP_ID!,
 *           privateKey: process.env.GITHUB_PRIVATE_KEY!,
 *           webhookSecret: process.env.GITHUB_WEBHOOK_SECRET!,
 *         },
 *         linear: {
 *           apiKey: process.env.LINEAR_API_KEY!,
 *           webhookSecret: process.env.LINEAR_WEBHOOK_SECRET!,
 *         },
 *         whatsapp: {
 *           phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID!,
 *           accessToken: process.env.WHATSAPP_ACCESS_TOKEN!,
 *           verifyToken: process.env.WHATSAPP_VERIFY_TOKEN!,
 *           appSecret: process.env.WHATSAPP_APP_SECRET!,
 *         },
 *       },
 *       executeQuery: myQueryFunction,
 *     }),
 *   ],
 * });
 * ```
 */

import type { StateAdapter } from "chat";
import type { SlackAdapter } from "@chat-adapter/slack";
import type { TeamsAdapter } from "@chat-adapter/teams";
import type { DiscordAdapter } from "@chat-adapter/discord";
import type { GoogleChatAdapter } from "@chat-adapter/gchat";
import type { TelegramAdapter } from "@chat-adapter/telegram";
import type { GitHubAdapter } from "@chat-adapter/github";
import type { LinearAdapter } from "@chat-adapter/linear";
import type { WhatsAppAdapter } from "@chat-adapter/whatsapp";
import { createPlugin } from "@useatlas/plugin-sdk";
import type {
  AtlasInteractionPlugin,
  AtlasPluginContext,
  PluginHealthResult,
  PluginLogger,
} from "@useatlas/plugin-sdk";
import { ChatConfigSchema } from "./config";
import type { ChatPluginConfig } from "./config";
import { createChatBridge } from "./bridge";
import type { ChatBridge } from "./bridge";
import { createSlackAdapter } from "./adapters/slack";
import { createTeamsAdapter } from "./adapters/teams";
import { createDiscordAdapter } from "./adapters/discord";
import { createGoogleChatAdapter } from "./adapters/gchat";
import { createTelegramAdapter } from "./adapters/telegram";
import { createGitHubAdapter } from "./adapters/github";
import { createLinearAdapter } from "./adapters/linear";
import { createWhatsAppAdapter } from "./adapters/whatsapp";
import { createStateAdapter } from "./state";

// Re-export types for host wiring convenience
export type {
  ChatPluginConfig,
  ChatQueryResult,
  ChatMessage,
  StateConfig,
  PendingAction,
  ActionCallbacks,
  ConversationCallbacks,
  SlackAdapterConfig,
  TeamsAdapterConfig,
  DiscordAdapterConfig,
  GoogleChatAdapterConfig,
  TelegramAdapterConfig,
  GitHubAdapterConfig,
  LinearAdapterConfig,
  WhatsAppAdapterConfig,
  StreamingConfig,
  StreamingQueryResult,
  FileUploadConfig,
} from "./config";
export type { ChatBridge } from "./bridge";
export type { StreamChunk, TaskUpdateChunk, PlanUpdateChunk, MarkdownTextChunk } from "chat";
export { createStateAdapter } from "./state";
export type { PluginDB } from "./state";

// File upload / CSV export utilities
export {
  generateCSV,
  buildCSVFileUpload,
  buildCSVFromQueryData,
  isExportRequest,
  platformSupportsFileUpload,
  shouldAttachCSV,
} from "./features/file-upload";

// Card components for host customization
export { buildQueryResultCard } from "./cards/query-result-card";
export { buildErrorCard } from "./cards/error-card";
export type { ErrorCardProps } from "./cards/error-card";
export { buildApprovalCardJSX } from "./cards/approval-card";
export { buildDataTableCard } from "./cards/data-table-card";
export type { DataTableCardProps } from "./cards/data-table-card";

// ---------------------------------------------------------------------------
// Plugin builder
// ---------------------------------------------------------------------------

function buildChatPlugin(
  config: ChatPluginConfig,
): AtlasInteractionPlugin<ChatPluginConfig> {
  let bridge: ChatBridge | null = null;
  let stateAdapter: StateAdapter | null = null;
  let slackAdapterInstance: SlackAdapter | null = null;
  let teamsAdapterInstance: TeamsAdapter | null = null;
  let discordAdapterInstance: DiscordAdapter | null = null;
  let gchatAdapterInstance: GoogleChatAdapter | null = null;
  let telegramAdapterInstance: TelegramAdapter | null = null;
  let githubAdapterInstance: GitHubAdapter | null = null;
  let linearAdapterInstance: LinearAdapter | null = null;
  let whatsappAdapterInstance: WhatsAppAdapter | null = null;
  let log: PluginLogger | null = null;
  let initialized = false;

  if (typeof config.executeQuery !== "function") {
    throw new Error("executeQuery callback is required and must be a function");
  }

  return {
    id: "chat-interaction",
    types: ["interaction"] as const,
    version: "0.2.0",
    name: "Chat SDK Bridge",
    config,

    routes(app) {
      // Mount Chat SDK webhook handlers under the plugin route prefix.
      // The bridge is created during initialize() — routes that arrive
      // before initialization return 503.
      if (config.adapters.slack) {
        app.post("/webhooks/slack", async (c) => {
          if (!bridge) {
            return c.json({ error: "Chat plugin not yet initialized" }, 503);
          }

          const handler = bridge.webhooks.slack;
          if (!handler) {
            return c.json({ error: "Slack adapter not configured" }, 404);
          }

          // Generated before try so both waitUntil errors and handler errors share the same correlation ID
          const requestId = crypto.randomUUID();
          try {
            const response = await handler(c.req.raw, {
              waitUntil: (task: Promise<unknown>) => {
                task.catch((err: unknown) => {
                  (log ?? console).error(
                    { err: err instanceof Error ? err : new Error(String(err)), requestId, adapter: "slack" },
                    "Chat SDK Slack webhook background task failed",
                  );
                });
              },
            });
            return response;
          } catch (err) {
            (log ?? console).error(
              { err: err instanceof Error ? err : new Error(String(err)), requestId, adapter: "slack" },
              "Slack webhook handler threw unexpectedly",
            );
            return c.json({ error: "Webhook processing failed", requestId }, 500);
          }
        });

        // OAuth routes — only if clientId is configured
        if (config.adapters.slack.clientId) {
          app.get("/oauth/slack/install", async (c) => {
            if (!slackAdapterInstance || !stateAdapter) {
              return c.json({ error: "Chat plugin not yet initialized" }, 503);
            }

            const clientId = config.adapters.slack!.clientId!;
            const scopes = "commands,chat:write,app_mentions:read";
            const state = crypto.randomUUID();

            // Store CSRF state in state adapter (10 minute TTL).
            // Must complete before redirecting — callback validates this token.
            try {
              await stateAdapter.set(`oauth:slack:${state}`, true, 600_000);
            } catch (err) {
              (log ?? console).error(
                { err: err instanceof Error ? err : new Error(String(err)) },
                "Failed to store OAuth CSRF state — cannot proceed with install",
              );
              return c.json({ error: "Unable to initiate OAuth flow. Please try again." }, 500);
            }

            const url = `https://slack.com/oauth/v2/authorize?client_id=${encodeURIComponent(clientId)}&scope=${encodeURIComponent(scopes)}&state=${encodeURIComponent(state)}`;
            return c.redirect(url);
          });

          app.get("/oauth/slack/callback", async (c) => {
            if (!slackAdapterInstance || !stateAdapter) {
              return c.json({ error: "Chat plugin not yet initialized" }, 503);
            }

            const state = c.req.query("state");
            if (!state) {
              return c.json({ error: "Missing state parameter" }, 400);
            }

            // Validate CSRF state
            const valid = await stateAdapter.get(`oauth:slack:${state}`);
            if (!valid) {
              return c.json({ error: "Invalid or expired state parameter" }, 400);
            }

            // Delete used state token — failure is non-fatal (TTL will expire it)
            try {
              await stateAdapter.delete(`oauth:slack:${state}`);
            } catch (deleteErr) {
              (log ?? console).warn(
                { err: deleteErr instanceof Error ? deleteErr : new Error(String(deleteErr)), state },
                "Failed to delete OAuth state — token will expire via TTL",
              );
            }

            const code = c.req.query("code");
            if (!code) {
              return c.json({ error: "Missing code parameter" }, 400);
            }

            try {
              const result = await slackAdapterInstance.handleOAuthCallback(
                c.req.raw,
              );

              (log ?? console).info({ teamId: result.teamId }, "Slack installation saved via OAuth");

              return c.html(
                "<html><body><h1>Atlas installed!</h1><p>You can now use /atlas in your Slack workspace.</p></body></html>",
              );
            } catch (oauthErr) {
              (log ?? console).error(
                { err: oauthErr instanceof Error ? oauthErr : new Error(String(oauthErr)) },
                "OAuth callback failed",
              );
              return c.html(
                "<html><body><h1>Installation Failed</h1><p>Could not complete the OAuth flow. Please try again.</p></body></html>",
                500,
              );
            }
          });
        }
      }

      if (config.adapters.teams) {
        app.post("/webhooks/teams", async (c) => {
          if (!bridge) {
            return c.json({ error: "Chat plugin not yet initialized" }, 503);
          }

          const handler = bridge.webhooks.teams;
          if (!handler) {
            return c.json({ error: "Teams adapter not configured" }, 404);
          }

          const requestId = crypto.randomUUID();
          try {
            const response = await handler(c.req.raw, {
              waitUntil: (task: Promise<unknown>) => {
                task.catch((err: unknown) => {
                  (log ?? console).error(
                    { err: err instanceof Error ? err : new Error(String(err)), requestId, adapter: "teams" },
                    "Chat SDK Teams webhook background task failed",
                  );
                });
              },
            });
            return response;
          } catch (err) {
            (log ?? console).error(
              { err: err instanceof Error ? err : new Error(String(err)), requestId, adapter: "teams" },
              "Teams webhook handler threw unexpectedly",
            );
            return c.json({ error: "Webhook processing failed", requestId }, 500);
          }
        });
      }

      if (config.adapters.discord) {
        app.post("/webhooks/discord", async (c) => {
          if (!bridge) {
            return c.json({ error: "Chat plugin not yet initialized" }, 503);
          }

          const handler = bridge.webhooks.discord;
          if (!handler) {
            return c.json({ error: "Discord adapter not configured" }, 404);
          }

          const requestId = crypto.randomUUID();
          try {
            const response = await handler(c.req.raw, {
              waitUntil: (task: Promise<unknown>) => {
                task.catch((err: unknown) => {
                  (log ?? console).error(
                    { err: err instanceof Error ? err : new Error(String(err)), requestId, adapter: "discord" },
                    "Chat SDK Discord webhook background task failed",
                  );
                });
              },
            });
            return response;
          } catch (err) {
            (log ?? console).error(
              { err: err instanceof Error ? err : new Error(String(err)), requestId, adapter: "discord" },
              "Discord webhook handler threw unexpectedly",
            );
            return c.json({ error: "Webhook processing failed", requestId }, 500);
          }
        });
      }

      if (config.adapters.gchat) {
        app.post("/webhooks/gchat", async (c) => {
          if (!bridge) {
            return c.json({ error: "Chat plugin not yet initialized" }, 503);
          }

          const handler = bridge.webhooks.gchat;
          if (!handler) {
            return c.json({ error: "Google Chat adapter not configured" }, 404);
          }

          const requestId = crypto.randomUUID();
          try {
            const response = await handler(c.req.raw, {
              waitUntil: (task: Promise<unknown>) => {
                task.catch((err: unknown) => {
                  (log ?? console).error(
                    { err: err instanceof Error ? err : new Error(String(err)), requestId, adapter: "gchat" },
                    "Chat SDK Google Chat webhook background task failed",
                  );
                });
              },
            });
            return response;
          } catch (err) {
            (log ?? console).error(
              { err: err instanceof Error ? err : new Error(String(err)), requestId, adapter: "gchat" },
              "Google Chat webhook handler threw unexpectedly",
            );
            return c.json({ error: "Webhook processing failed", requestId }, 500);
          }
        });
      }

      if (config.adapters.telegram) {
        app.post("/webhooks/telegram", async (c) => {
          if (!bridge) {
            return c.json({ error: "Chat plugin not yet initialized" }, 503);
          }

          const handler = bridge.webhooks.telegram;
          if (!handler) {
            return c.json({ error: "Telegram adapter not configured" }, 404);
          }

          const requestId = crypto.randomUUID();
          try {
            const response = await handler(c.req.raw, {
              waitUntil: (task: Promise<unknown>) => {
                task.catch((err: unknown) => {
                  (log ?? console).error(
                    { err: err instanceof Error ? err : new Error(String(err)), requestId, adapter: "telegram" },
                    "Chat SDK Telegram webhook background task failed",
                  );
                });
              },
            });
            return response;
          } catch (err) {
            (log ?? console).error(
              { err: err instanceof Error ? err : new Error(String(err)), requestId, adapter: "telegram" },
              "Telegram webhook handler threw unexpectedly",
            );
            return c.json({ error: "Webhook processing failed", requestId }, 500);
          }
        });
      }

      if (config.adapters.github) {
        app.post("/webhooks/github", async (c) => {
          if (!bridge) {
            return c.json({ error: "Chat plugin not yet initialized" }, 503);
          }

          const handler = bridge.webhooks.github;
          if (!handler) {
            return c.json({ error: "GitHub adapter not configured" }, 404);
          }

          const requestId = crypto.randomUUID();
          try {
            const response = await handler(c.req.raw, {
              waitUntil: (task: Promise<unknown>) => {
                task.catch((err: unknown) => {
                  (log ?? console).error(
                    { err: err instanceof Error ? err : new Error(String(err)), requestId, adapter: "github" },
                    "Chat SDK GitHub webhook background task failed",
                  );
                });
              },
            });
            return response;
          } catch (err) {
            (log ?? console).error(
              { err: err instanceof Error ? err : new Error(String(err)), requestId, adapter: "github" },
              "GitHub webhook handler threw unexpectedly",
            );
            return c.json({ error: "Webhook processing failed", requestId }, 500);
          }
        });
      }

      if (config.adapters.linear) {
        app.post("/webhooks/linear", async (c) => {
          if (!bridge) {
            return c.json({ error: "Chat plugin not yet initialized" }, 503);
          }

          const handler = bridge.webhooks.linear;
          if (!handler) {
            return c.json({ error: "Linear adapter not configured" }, 404);
          }

          const requestId = crypto.randomUUID();
          try {
            const response = await handler(c.req.raw, {
              waitUntil: (task: Promise<unknown>) => {
                task.catch((err: unknown) => {
                  (log ?? console).error(
                    { err: err instanceof Error ? err : new Error(String(err)), requestId, adapter: "linear" },
                    "Chat SDK Linear webhook background task failed",
                  );
                });
              },
            });
            return response;
          } catch (err) {
            (log ?? console).error(
              { err: err instanceof Error ? err : new Error(String(err)), requestId, adapter: "linear" },
              "Linear webhook handler threw unexpectedly",
            );
            return c.json({ error: "Webhook processing failed", requestId }, 500);
          }
        });
      }

      if (config.adapters.whatsapp) {
        // GET for Meta webhook verification challenge-response
        app.get("/webhooks/whatsapp", async (c) => {
          if (!bridge) {
            return c.json({ error: "Chat plugin not yet initialized" }, 503);
          }

          const handler = bridge.webhooks.whatsapp;
          if (!handler) {
            return c.json({ error: "WhatsApp adapter not configured" }, 404);
          }

          const requestId = crypto.randomUUID();
          try {
            const response = await handler(c.req.raw, {
              waitUntil: (task: Promise<unknown>) => {
                task.catch((err: unknown) => {
                  (log ?? console).error(
                    { err: err instanceof Error ? err : new Error(String(err)), requestId, adapter: "whatsapp" },
                    "Chat SDK WhatsApp webhook background task failed",
                  );
                });
              },
            });
            return response;
          } catch (err) {
            (log ?? console).error(
              { err: err instanceof Error ? err : new Error(String(err)), requestId, adapter: "whatsapp" },
              "WhatsApp webhook handler threw unexpectedly",
            );
            return c.json({ error: "Webhook processing failed", requestId }, 500);
          }
        });

        // POST for incoming message events
        app.post("/webhooks/whatsapp", async (c) => {
          if (!bridge) {
            return c.json({ error: "Chat plugin not yet initialized" }, 503);
          }

          const handler = bridge.webhooks.whatsapp;
          if (!handler) {
            return c.json({ error: "WhatsApp adapter not configured" }, 404);
          }

          const requestId = crypto.randomUUID();
          try {
            const response = await handler(c.req.raw, {
              waitUntil: (task: Promise<unknown>) => {
                task.catch((err: unknown) => {
                  (log ?? console).error(
                    { err: err instanceof Error ? err : new Error(String(err)), requestId, adapter: "whatsapp" },
                    "Chat SDK WhatsApp webhook background task failed",
                  );
                });
              },
            });
            return response;
          } catch (err) {
            (log ?? console).error(
              { err: err instanceof Error ? err : new Error(String(err)), requestId, adapter: "whatsapp" },
              "WhatsApp webhook handler threw unexpectedly",
            );
            return c.json({ error: "Webhook processing failed", requestId }, 500);
          }
        });
      }
    },

    async initialize(ctx: AtlasPluginContext) {
      if (initialized) {
        throw new Error(
          "Chat plugin already initialized — call teardown() first",
        );
      }

      log = ctx.logger;

      // Create state adapter based on config — PG backend uses ctx.db.
      // Use a local variable until connect() succeeds to avoid leaking
      // a partially-initialized adapter on retry.
      const adapter = createStateAdapter(config.state, ctx.db);
      await adapter.connect();
      stateAdapter = adapter;

      // Create platform adapters — wrap in try-catch to disconnect
      // the state adapter if adapter creation or bridge setup fails.
      const adapterInstances: {
        slack?: SlackAdapter | null;
        teams?: TeamsAdapter | null;
        discord?: DiscordAdapter | null;
        gchat?: GoogleChatAdapter | null;
        telegram?: TelegramAdapter | null;
        github?: GitHubAdapter | null;
        linear?: LinearAdapter | null;
        whatsapp?: WhatsAppAdapter | null;
      } = {};
      try {
        if (config.adapters.slack) {
          slackAdapterInstance = createSlackAdapter(config.adapters.slack) as SlackAdapter;
          adapterInstances.slack = slackAdapterInstance;
        }
        if (config.adapters.teams) {
          teamsAdapterInstance = createTeamsAdapter(config.adapters.teams) as TeamsAdapter;
          adapterInstances.teams = teamsAdapterInstance;
        }
        if (config.adapters.discord) {
          discordAdapterInstance = createDiscordAdapter(config.adapters.discord) as DiscordAdapter;
          adapterInstances.discord = discordAdapterInstance;
        }
        if (config.adapters.gchat) {
          gchatAdapterInstance = createGoogleChatAdapter(config.adapters.gchat) as GoogleChatAdapter;
          adapterInstances.gchat = gchatAdapterInstance;
        }
        if (config.adapters.telegram) {
          telegramAdapterInstance = createTelegramAdapter(config.adapters.telegram) as TelegramAdapter;
          adapterInstances.telegram = telegramAdapterInstance;
        }
        if (config.adapters.github) {
          if (!config.adapters.github.webhookSecret) {
            ctx.logger.warn(
              "GitHub adapter configured without webhookSecret — webhook endpoint will accept unauthenticated requests. Set webhookSecret for production deployments.",
            );
          }
          githubAdapterInstance = createGitHubAdapter(config.adapters.github) as GitHubAdapter;
          adapterInstances.github = githubAdapterInstance;
        }
        if (config.adapters.linear) {
          if (!config.adapters.linear.webhookSecret) {
            ctx.logger.warn(
              "Linear adapter configured without webhookSecret — webhook endpoint will accept unauthenticated requests. Set webhookSecret for production deployments.",
            );
          }
          linearAdapterInstance = createLinearAdapter(config.adapters.linear) as LinearAdapter;
          adapterInstances.linear = linearAdapterInstance;
        }
        if (config.adapters.whatsapp) {
          whatsappAdapterInstance = createWhatsAppAdapter(config.adapters.whatsapp) as WhatsAppAdapter;
          adapterInstances.whatsapp = whatsappAdapterInstance;
        }

        bridge = createChatBridge(config, ctx.logger, stateAdapter, adapterInstances);
      } catch (err) {
        ctx.logger.error(
          { err: err instanceof Error ? err : new Error(String(err)) },
          "Chat plugin initialization failed — cleaning up state adapter",
        );
        // Clean up already-connected state adapter to prevent leaks
        try {
          await stateAdapter.disconnect();
        } catch (disconnectErr) {
          ctx.logger.warn(
            { err: disconnectErr instanceof Error ? disconnectErr : new Error(String(disconnectErr)) },
            "Failed to disconnect state adapter during initialization cleanup",
          );
        }
        stateAdapter = null;
        slackAdapterInstance = null;
        teamsAdapterInstance = null;
        discordAdapterInstance = null;
        gchatAdapterInstance = null;
        telegramAdapterInstance = null;
        githubAdapterInstance = null;
        linearAdapterInstance = null;
        whatsappAdapterInstance = null;
        throw err;
      }

      const enabledAdapters = Object.entries(config.adapters)
        .filter(([, v]) => v !== undefined)
        .map(([k]) => k);

      const backend = config.state?.backend ?? "memory";
      ctx.logger.info(
        { adapters: enabledAdapters, stateBackend: backend },
        `Chat interaction plugin initialized (${enabledAdapters.join(", ")}, state: ${backend})`,
      );
      initialized = true;
    },

    async healthCheck(): Promise<PluginHealthResult> {
      const start = performance.now();

      if (!initialized || !bridge) {
        return {
          healthy: false,
          message: "Chat plugin not initialized",
          latencyMs: Math.round(performance.now() - start),
        };
      }

      const enabledAdapters = Object.entries(config.adapters)
        .filter(([, v]) => v !== undefined)
        .map(([k]) => k);

      if (enabledAdapters.length === 0) {
        return {
          healthy: false,
          message: "No adapters configured",
          latencyMs: Math.round(performance.now() - start),
        };
      }

      // Probe state adapter health (lightweight get on a non-existent key)
      if (stateAdapter) {
        try {
          await stateAdapter.get("_healthcheck");
        } catch (stateErr) {
          return {
            healthy: false,
            message: `State backend error: ${stateErr instanceof Error ? stateErr.message : String(stateErr)}`,
            latencyMs: Math.round(performance.now() - start),
          };
        }
      }

      return {
        healthy: true,
        message: `Adapters: ${enabledAdapters.join(", ")}`,
        latencyMs: Math.round(performance.now() - start),
      };
    },

    async teardown() {
      if (bridge) {
        try {
          await bridge.shutdown();
        } catch (err) {
          (log ?? console).error(
            { err: err instanceof Error ? err : new Error(String(err)) },
            "Failed to shut down chat bridge during teardown",
          );
        }
        bridge = null;
      }
      if (stateAdapter) {
        try {
          await stateAdapter.disconnect();
        } catch (err) {
          (log ?? console).error(
            { err: err instanceof Error ? err : new Error(String(err)) },
            "Failed to disconnect state adapter during teardown",
          );
        }
        stateAdapter = null;
      }
      slackAdapterInstance = null;
      teamsAdapterInstance = null;
      discordAdapterInstance = null;
      gchatAdapterInstance = null;
      telegramAdapterInstance = null;
      githubAdapterInstance = null;
      linearAdapterInstance = null;
      whatsappAdapterInstance = null;
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
 * plugins: [chatPlugin({
 *   adapters: {
 *     slack: { botToken: "xoxb-...", signingSecret: "..." },
 *     teams: { appId: "...", appPassword: "..." },
 *     discord: { botToken: "...", applicationId: "...", publicKey: "..." },
 *     gchat: { credentials: { client_email: "...", private_key: "..." } },
 *     telegram: { botToken: "..." },
 *     github: { appId: "...", privateKey: "...", webhookSecret: "..." },
 *     linear: { apiKey: "...", webhookSecret: "..." },
 *     whatsapp: { phoneNumberId: "...", accessToken: "...", verifyToken: "...", appSecret: "..." },
 *   },
 *   executeQuery: myQueryFunction,
 * })]
 * ```
 */
export const chatPlugin = createPlugin<
  ChatPluginConfig,
  AtlasInteractionPlugin<ChatPluginConfig>
>({
  // Cast: Zod infers all-optional fields for GitHub's and Linear's schemas,
  // but runtime superRefine validates the discriminated union constraints.
  // The TypeScript union types provide compile-time safety separately.
  configSchema: ChatConfigSchema as unknown as { parse(input: unknown): ChatPluginConfig },
  create: buildChatPlugin,
});

/** Direct builder for tests or manual construction. */
export { buildChatPlugin };
