/**
 * Atlas Chat SDK Bridge Plugin.
 *
 * Bridges vercel/chat (Chat SDK) into the Atlas plugin system as a unified
 * interaction layer. Adapter activation is driven by `atlas.config.ts:catalog`
 * + per-Platform env vars (slice 2 of #2649 — issue #2650). Slack is the
 * only OAuth chat Platform that instantiates in 1.5.2; the other adapters
 * (Teams, Discord, gchat, Telegram, GitHub, Linear, WhatsApp) ride along
 * as catalog placeholders and wire up in 1.5.3 once `StaticBotInstallHandler`
 * lands.
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
 *   // Operator declares supported Platforms + integrations. Per-Platform
 *   // credentials live in env vars (SLACK_CLIENT_ID etc.).
 *   catalog: [
 *     { slug: "slack", type: "chat", install_model: "oauth", enabled: true },
 *   ],
 *   plugins: [
 *     chatPlugin({
 *       // No `adapters:` field — the plugin reads `catalog` from the
 *       // host's resolved config and `process.env` for credentials.
 *       executeQuery: myQueryFunction,
 *     }),
 *   ],
 * });
 * ```
 */

import type { StateAdapter } from "chat";
import type { SlackAdapter } from "@chat-adapter/slack";
import { createPlugin } from "@useatlas/plugin-sdk";
import type {
  AtlasInteractionPlugin,
  AtlasPluginContext,
  PluginHealthResult,
  PluginLogger,
} from "@useatlas/plugin-sdk";
import { ChatConfigSchema } from "./config";
import type { ChatCatalogEntryInput, ChatPluginConfig } from "./config";
import { createChatBridge } from "./bridge";
import type { ChatBridge } from "./bridge";
import { buildChatAdapterRegistry } from "./adapter-registry";
import type { ChatCatalogEntry } from "./adapter-registry";
import { createStateAdapter } from "./state";

// Re-export types for host wiring convenience
export type {
  ChatPluginConfig,
  ChatQueryResult,
  ChatMessage,
  ChatAdapterName,
  ChatExecuteQueryAdapter,
  ChatExecuteQueryContext,
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
  EphemeralConfig,
  ProactiveConfig,
} from "./config";

// Proactive chat layer (slices #2292 reaction-first tracer, #2293 reaction-to-answer, #2295 kill switch, #2298 feedback)
export {
  InvalidProactiveIdentityError,
  assertAtlasUserId,
  assertChannelId,
  assertExternalUserId,
  assertThreadId,
  assertWorkspaceId,
} from "./proactive";
export type { ProactiveIdentityField } from "./proactive";
export type {
  AtlasUserId,
  ChannelId,
  ChannelPauseLayer,
  ChannelProactiveConfig,
  ClassificationResult,
  ExternalUserId,
  FeedbackCollectorFn,
  FeedbackOutcome,
  FeedbackSlashParse,
  FeedbackSource,
  GetChannelConfigsFn,
  GetWorkspaceConfigFn,
  InterjectionAction,
  InterjectionDecision,
  IsPausedFn,
  LLMClassifierFn,
  OnPauseRequestFn,
  PauseDecision,
  PauseLayer,
  PendingAnswerEntry,
  ProactiveAsker,
  ProactiveExecuteQuery,
  ProactiveFeedbackEvent,
  ProactiveGateFn,
  ProactiveQueryResult,
  ProactiveUserResolver,
  ProactiveUserResolverContext,
  RecentAnswerEntry,
  ResolvedAsker,
  ResolveWorkspaceIdFn,
  ResolverEvent,
  ResolverEventLite,
  SensitivityPreset,
  ThreadId,
  WorkspaceId,
  WorkspaceProactiveConfig,
} from "./proactive";
export {
  CHANNEL_PAUSE_DURATION_MS,
  PROACTIVE_ANSWER_ACTION_ID,
  PROACTIVE_DISMISS_ACTION_ID,
  PROACTIVE_FB_HELPFUL_ACTION_ID,
  PROACTIVE_FB_NOT_HELPFUL_ACTION_ID,
  PROACTIVE_FB_WRONG_DATA_ACTION_ID,
  PROACTIVE_FB_WRONG_DATA_INPUT_ID,
  PROACTIVE_FB_WRONG_DATA_MODAL_ID,
  PROACTIVE_REACTION,
  PendingAnswers,
  PENDING_ANSWER_MAX_ENTRIES,
  PENDING_ANSWER_TTL_MS,
  RECENT_ANSWER_MAX_ENTRIES,
  RECENT_ANSWER_TTL_MS,
  RECENT_INTERJECTION_COOLDOWN_MS,
  RecentAnswers,
  SENSITIVITY_THRESHOLDS,
  buildProactiveAnswerCard,
  buildProactiveOfferCard,
  buildUnlinkedAskerPrompt,
  buildWrongDataModal,
  classifyMessage,
  decideInterjection,
  detectPauseCommand,
  detectUnsubscribeDM,
  outcomeForActionId,
  parseFeedbackSlashArgs,
  regexPreFilter,
  registerProactiveListener,
  resolvePauseRequest,
  shouldAnswerOnReaction,
} from "./proactive";
export type { ReactionConfig, IReactionLifecycle } from "./features/reactions";
export { StatusEmoji, createReactionLifecycle } from "./features/reactions";
export type { ChatBridge, ChatPlatform } from "./bridge";
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

/**
 * Predicate the routes() block uses to decide whether to mount the
 * Slack webhook + OAuth routes. Catalog-driven (post-#2650 slice 2) —
 * mirrors the AdapterRegistry's filter chain, but runs at route-
 * registration time, before initialize() has built the actual adapter.
 *
 * The runtime check (`if (!slackAdapterInstance) return 503`) inside the
 * route handler is the second gate — it guards against an env-var
 * misconfig where the catalog says "Slack OAuth" but creds are missing.
 */
function catalogHasSlackOauth(
  catalog: ReadonlyArray<ChatCatalogEntryInput> | undefined,
): boolean {
  if (!catalog) return false;
  return catalog.some(
    (e) =>
      e.slug === "slack" &&
      e.type === "chat" &&
      e.install_model === "oauth" &&
      e.enabled === true,
  );
}

function buildChatPlugin(
  config: ChatPluginConfig,
): AtlasInteractionPlugin<ChatPluginConfig> {
  let bridge: ChatBridge | null = null;
  let stateAdapter: StateAdapter | null = null;
  let slackAdapterInstance: SlackAdapter | null = null;
  let log: PluginLogger | null = null;
  let initialized = false;
  /**
   * Captured from `buildChatAdapterRegistry` at init so `healthCheck`
   * and the OAuth-install route handler can surface actionable
   * "operator misconfig" messages instead of the generic "not
   * initialized" one. Empty until `initialize` runs.
   */
  let adapterDiagnostics: {
    unrecognizedSlugs: ReadonlyArray<string>;
    missingCredSlugs: ReadonlyArray<string>;
  } = { unrecognizedSlugs: [], missingCredSlugs: [] };

  if (typeof config.executeQuery !== "function") {
    throw new Error("executeQuery callback is required and must be a function");
  }

  const slackOauthDeclared = catalogHasSlackOauth(config.catalog);

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
      //
      // Post-#2650 (slice 2 of 1.5.2): the route gate is the catalog
      // declaration, not the old `config.adapters.slack` field. The
      // AdapterRegistry resolves the actual adapter instance inside
      // initialize() — if the env vars are missing, the runtime
      // `if (!slackAdapterInstance)` check below returns 503.
      //
      // Non-Slack chat platforms are intentionally not mounted in 1.5.2
      // — their `install_model === "static-bot"` catalog rows are
      // placeholders; their event-loop wiring lands in 1.5.3 alongside
      // `StaticBotInstallHandler`.
      if (slackOauthDeclared) {
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

        // OAuth routes — always mounted when Slack OAuth is declared in
        // the catalog. The runtime check inside the handler verifies the
        // adapter actually initialized (i.e. env vars were present and
        // `createSlackAdapter` succeeded); the client_id is read from
        // `process.env.SLACK_CLIENT_ID` rather than the old
        // `config.adapters.slack.clientId` field.
        {
          app.get("/oauth/slack/install", async (c) => {
            // Distinguish "plugin still booting" (transient — retry)
            // from "adapter never instantiated due to missing creds"
            // (terminal — operator must fix env vars). The diagnostic
            // is captured by AdapterRegistry at init time.
            if (!stateAdapter || !initialized) {
              return c.json({ error: "Chat plugin not yet initialized" }, 503);
            }
            if (!slackAdapterInstance) {
              const missingCreds = adapterDiagnostics.missingCredSlugs.includes("slack");
              return c.json(
                {
                  error: missingCreds
                    ? "Slack OAuth not configured — required env vars missing (SLACK_CLIENT_ID / SLACK_CLIENT_SECRET / SLACK_SIGNING_SECRET / SLACK_ENCRYPTION_KEY)"
                    : "Slack adapter not registered — check `catalog` declaration in atlas.config.ts",
                },
                500,
              );
            }

            const clientId = process.env.SLACK_CLIENT_ID;
            if (!clientId) {
              return c.json(
                { error: "Slack OAuth not configured — SLACK_CLIENT_ID is unset" },
                500,
              );
            }
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
            if (!stateAdapter || !initialized) {
              return c.json({ error: "Chat plugin not yet initialized" }, 503);
            }
            if (!slackAdapterInstance) {
              const missingCreds = adapterDiagnostics.missingCredSlugs.includes("slack");
              return c.json(
                {
                  error: missingCreds
                    ? "Slack OAuth not configured — required env vars missing"
                    : "Slack adapter not registered — check `catalog` declaration",
                },
                500,
              );
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

      // Non-Slack chat Platform webhook routes are intentionally not
      // mounted in 1.5.2 (#2650 AC). Their adapters don't instantiate
      // until 1.5.3 when `StaticBotInstallHandler` lands; mounting their
      // routes pre-handler would let webhooks accumulate without a
      // bridge to consume them. The route paths themselves
      // (/webhooks/teams etc.) are reserved for future activation.
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

      // Build chat-platform adapters via the catalog-driven
      // AdapterRegistry (#2650 slice 2). The registry reads per-Platform
      // credentials from `process.env`, logs warns on missing creds /
      // non-OAuth entries, and returns the adapters map plus diagnostic
      // slug lists. The diagnostics let `healthCheck` and the OAuth
      // install handler surface actionable error messages.
      try {
        const registry = buildChatAdapterRegistry({
          catalog: (config.catalog ?? []) as ReadonlyArray<ChatCatalogEntry>,
          env: process.env,
          logger: ctx.logger,
        });
        slackAdapterInstance = registry.adapters.slack ?? null;
        adapterDiagnostics = registry.diagnostics;

        // Bridge takes pre-built instances per-platform; non-Slack slots
        // are left `undefined` (the bridge tolerates this — see
        // `createChatBridge`). When 1.5.3 lands StaticBotInstallHandler,
        // each new instantiated adapter slots in here.
        bridge = createChatBridge(config, ctx.logger, stateAdapter, {
          slack: slackAdapterInstance,
        });
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
        throw err;
      }

      const enabledAdapters: string[] = [];
      if (slackAdapterInstance) enabledAdapters.push("slack");

      const backend = config.state?.backend ?? "memory";
      ctx.logger.info(
        { adapters: enabledAdapters, stateBackend: backend },
        enabledAdapters.length > 0
          ? `Chat interaction plugin initialized (${enabledAdapters.join(", ")}, state: ${backend})`
          : `Chat interaction plugin initialized (no chat adapters activated — see AdapterRegistry warns, state: ${backend})`,
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

      const enabledAdapters: string[] = [];
      if (slackAdapterInstance) enabledAdapters.push("slack");

      if (enabledAdapters.length === 0) {
        // Use the diagnostics captured at init to point operators at the
        // actual cause: a catalog row referencing an unknown slug, or a
        // recognized slug whose env vars are missing.
        const parts = [
          "No chat adapters registered.",
        ];
        if (adapterDiagnostics.missingCredSlugs.length > 0) {
          parts.push(
            `Missing env vars for: ${adapterDiagnostics.missingCredSlugs.join(", ")}.`,
          );
        }
        if (adapterDiagnostics.unrecognizedSlugs.length > 0) {
          parts.push(
            `Unknown slugs in catalog: ${adapterDiagnostics.unrecognizedSlugs.join(", ")}.`,
          );
        }
        if (
          adapterDiagnostics.missingCredSlugs.length === 0 &&
          adapterDiagnostics.unrecognizedSlugs.length === 0
        ) {
          parts.push(
            "No chat-type catalog entries declared in atlas.config.ts (or all are disabled / non-OAuth).",
          );
        }
        return {
          healthy: false,
          message: parts.join(" "),
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
 * Adapter activation is catalog-driven (#2650 slice 2). The host wires
 * `catalog` from `atlas.config.ts:catalog` (chat-type subset); per-Platform
 * credentials come from `process.env`.
 *
 * @example
 * ```typescript
 * // atlas.config.ts
 * export default defineConfig({
 *   catalog: [
 *     { slug: "slack", type: "chat", install_model: "oauth", enabled: true },
 *   ],
 *   plugins: [
 *     chatPlugin({
 *       catalog: [
 *         { slug: "slack", type: "chat", install_model: "oauth",
 *           enabled: true, saas_eligible: true },
 *       ],
 *       executeQuery: myQueryFunction,
 *     }),
 *   ],
 * });
 *
 * // env vars:
 * //   SLACK_CLIENT_ID=...
 * //   SLACK_CLIENT_SECRET=...
 * //   SLACK_SIGNING_SECRET=...
 * //   SLACK_ENCRYPTION_KEY=...
 * ```
 */
export const chatPlugin = createPlugin<
  ChatPluginConfig,
  AtlasInteractionPlugin<ChatPluginConfig>
>({
  configSchema: ChatConfigSchema as unknown as { parse(input: unknown): ChatPluginConfig },
  create: buildChatPlugin,
});

/** Direct builder for tests or manual construction. */
export { buildChatPlugin };
