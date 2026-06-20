/**
 * Atlas Chat SDK Bridge Plugin.
 *
 * Bridges vercel/chat (Chat SDK) into the Atlas plugin system as a unified
 * interaction layer. Adapter activation is driven by `atlas.config.ts:catalog`
 * + per-Platform env vars (slice 2 of #2649 — issue #2650).
 *
 * Wired adapters:
 *   - Slack — OAuth install model (1.5.2, #2650). Bot token lives in
 *     `chat_cache` keyed by `team_id`.
 *   - Telegram — static-bot install model (1.5.3, #2748 — keystone slice
 *     for Phase D). Operator-shared `TELEGRAM_BOT_TOKEN`; per-Workspace
 *     `chat_id` routing in `workspace_plugins.config`.
 *
 * The remaining Phase D adapters (Discord #2749, Linear #2750, GitHub
 * #2751, Teams #2752, WhatsApp #2753, gchat #2754) ride the static-bot
 * (or OAuth) interface this plugin already exposes — they slot in by
 * adding a per-slug `ChatAdapterBuilder` to `adapter-registry.ts` and
 * mounting a `/webhooks/<slug>` route here.
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

import type { Adapter, StateAdapter } from "chat";
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
import { buildChatAdapterRegistry, hasInstantiationFailure } from "./adapter-registry";
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
  PresentationMode,
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
  PROACTIVE_SHOW_DETAILS_ACTION_ID,
  PROACTIVE_SHOW_SQL_ACTION_ID,
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

// Per-slug adapter env-var lookup (#2672). Core's `ChatAdapterEnvGuardLive`
// imports this to assert that a SaaS deploy whose chat catalog enables an
// OAuth Platform has every env var the AdapterRegistry would otherwise
// silently drop the adapter for. Single source of truth for the
// per-Platform requiredEnv list — duplicating in core would let the lists
// drift across packages.
export { getChatAdapterRequiredEnv } from "./adapter-registry";

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
 * Slack webhook route. Catalog-driven (post-#2650 slice 2) — mirrors
 * the AdapterRegistry's filter chain, but runs at route-registration
 * time, before initialize() has built the actual adapter.
 *
 * Two runtime checks inside the webhook handler form the second gate:
 * `if (!bridge)` → 503 covers the "still booting" case, and
 * `if (!handler)` → 404 catches the env-var misconfig where the catalog
 * says "Slack OAuth" but the AdapterRegistry never instantiated the
 * Slack adapter (missing creds).
 *
 * OAuth install + callback used to be gated by this predicate too;
 * since #2682 they live at `/api/v1/integrations/slack/*` and the
 * webhook is the only chat-plugin route still scoped here.
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

/**
 * Telegram is the first static-bot Platform that mounts a webhook here
 * (1.5.3 #2748). The route gate mirrors {@link catalogHasSlackOauth}:
 * declared + enabled in the catalog. Env-var presence (and therefore
 * the actual adapter wiring) is checked inside `initialize()` by the
 * `AdapterRegistry`; an enabled catalog row with no `TELEGRAM_BOT_TOKEN`
 * mounts the route but the runtime handler-missing branch surfaces 404.
 */
function catalogHasTelegramStaticBot(
  catalog: ReadonlyArray<ChatCatalogEntryInput> | undefined,
): boolean {
  if (!catalog) return false;
  return catalog.some(
    (e) =>
      e.slug === "telegram" &&
      e.type === "chat" &&
      e.install_model === "static-bot" &&
      e.enabled === true,
  );
}

/**
 * Discord (1.5.3 #2749) mirrors Telegram's static-bot mount story —
 * declared + enabled in the catalog mounts the webhook route at
 * `/api/plugins/chat-interaction/webhooks/discord`. Env-var presence
 * (and therefore the actual adapter wiring) is checked inside
 * `initialize()` by the `AdapterRegistry`.
 */
function catalogHasDiscordStaticBot(
  catalog: ReadonlyArray<ChatCatalogEntryInput> | undefined,
): boolean {
  if (!catalog) return false;
  return catalog.some(
    (e) =>
      e.slug === "discord" &&
      e.type === "chat" &&
      e.install_model === "static-bot" &&
      e.enabled === true,
  );
}

/**
 * WhatsApp (1.5.3 #2753) mirrors Discord's / Telegram's static-bot mount
 * story — declared + enabled in the catalog mounts the webhook route at
 * `/api/plugins/chat-interaction/webhooks/whatsapp`. Env-var presence
 * (and therefore the actual adapter wiring) is checked inside
 * `initialize()` by the `AdapterRegistry`.
 */
function catalogHasWhatsAppStaticBot(
  catalog: ReadonlyArray<ChatCatalogEntryInput> | undefined,
): boolean {
  if (!catalog) return false;
  return catalog.some(
    (e) =>
      e.slug === "whatsapp" &&
      e.type === "chat" &&
      e.install_model === "static-bot" &&
      e.enabled === true,
  );
}

/**
 * Google Chat (1.5.3 #2754) mirrors Telegram / Discord's static-bot
 * mount story — declared + enabled in the catalog mounts the webhook
 * route at `/api/plugins/chat-interaction/webhooks/gchat`. Env-var
 * presence (and therefore the actual adapter wiring) is checked inside
 * `initialize()` by the `AdapterRegistry`. Google Chat events typically
 * arrive via the Workspace Events Pub/Sub subscription that the adapter
 * binds at boot; the HTTP endpoint is the fallback for legacy
 * `/atlas`-style slash command invocations.
 */
function catalogHasGchatStaticBot(
  catalog: ReadonlyArray<ChatCatalogEntryInput> | undefined,
): boolean {
  if (!catalog) return false;
  return catalog.some(
    (e) =>
      e.slug === "gchat" &&
      e.type === "chat" &&
      e.install_model === "static-bot" &&
      e.enabled === true,
  );
}

/**
 * Microsoft Teams (#3142 — fifth static-bot mount, completing Phase D
 * under umbrella #2994) mirrors the Telegram / Discord / gchat story:
 * declared + enabled in the catalog mounts the webhook route at
 * `/api/plugins/chat-interaction/webhooks/teams`. Env-var presence
 * (`TEAMS_APP_ID` + `TEAMS_APP_PASSWORD`) — and therefore the actual
 * adapter wiring — is checked inside `initialize()` by the
 * `AdapterRegistry`. `@chat-adapter/teams` verifies the Bot Framework JWT
 * on every inbound activity internally.
 */
function catalogHasTeamsStaticBot(
  catalog: ReadonlyArray<ChatCatalogEntryInput> | undefined,
): boolean {
  if (!catalog) return false;
  return catalog.some(
    (e) =>
      e.slug === "teams" &&
      e.type === "chat" &&
      e.install_model === "static-bot" &&
      e.enabled === true,
  );
}

/**
 * Resolve the env-shaped object the AdapterRegistry builds from (#3704).
 *
 * Without `config.resolveAdapterEnv` (self-host default) this is just
 * `process.env` — behavior is unchanged. With it, the host's operator-tier
 * overlay (Admin-set, DB-backed credentials) is merged on top of
 * `process.env` so the overlay WINS while unresolved keys fall through to env
 * (env stays the fallback). Only non-empty string overlay values override —
 * `undefined`/`""` never clobber an env value.
 *
 * A throwing resolver propagates: it signals a decrypt/corruption failure in
 * the host, which must fail the (re)build loudly rather than silently boot
 * with env-only credentials (the silent-degradation class #2673 / the boot
 * guard exist to prevent). `initialize()`'s try/catch cleans up the partially
 * connected state adapter on the way out.
 */
// Exported for unit testing the operator-credential overlay precedence
// (#3704). Not part of the plugin's public surface — internal helper.
export async function resolveAdapterBuildEnv(
  config: ChatPluginConfig,
  logger: PluginLogger,
): Promise<NodeJS.ProcessEnv> {
  if (!config.resolveAdapterEnv) return process.env;
  const overlay = await config.resolveAdapterEnv();
  const merged: NodeJS.ProcessEnv = { ...process.env };
  let applied = 0;
  for (const [key, value] of Object.entries(overlay)) {
    if (typeof value === "string" && value.length > 0) {
      merged[key] = value;
      applied += 1;
    }
  }
  logger.debug?.(
    { overlayKeys: Object.keys(overlay).length, applied },
    "Resolved operator-tier adapter credential overlay (DB-backed values override env)",
  );
  return merged;
}

function buildChatPlugin(
  config: ChatPluginConfig,
): AtlasInteractionPlugin<ChatPluginConfig> {
  let bridge: ChatBridge | null = null;
  let stateAdapter: StateAdapter | null = null;
  let slackAdapterInstance: SlackAdapter | null = null;
  let telegramAdapterInstance: Adapter | null = null;
  let discordAdapterInstance: Adapter | null = null;
  let whatsappAdapterInstance: Adapter | null = null;
  let gchatAdapterInstance: Adapter | null = null;
  let teamsAdapterInstance: Adapter | null = null;
  let log: PluginLogger | null = null;
  let initialized = false;
  /**
   * Captured from `buildChatAdapterRegistry` at init so `healthCheck`
   * can surface actionable "operator misconfig" messages instead of
   * the generic "not initialized" one. Empty until `initialize` runs.
   */
  let adapterDiagnostics: {
    unrecognizedSlugs: ReadonlyArray<string>;
    missingCredSlugs: ReadonlyArray<string>;
  } = { unrecognizedSlugs: [], missingCredSlugs: [] };

  if (typeof config.executeQuery !== "function") {
    throw new Error("executeQuery callback is required and must be a function");
  }

  const slackOauthDeclared = catalogHasSlackOauth(config.catalog);
  const telegramStaticBotDeclared = catalogHasTelegramStaticBot(config.catalog);
  const discordStaticBotDeclared = catalogHasDiscordStaticBot(config.catalog);
  const whatsappStaticBotDeclared = catalogHasWhatsAppStaticBot(config.catalog);
  const gchatStaticBotDeclared = catalogHasGchatStaticBot(config.catalog);
  const teamsStaticBotDeclared = catalogHasTeamsStaticBot(config.catalog);

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
      // initialize() — if env vars are missing the webhook handler's
      // runtime `if (!handler)` check returns 404 (no adapter wired
      // means no Chat SDK webhook to dispatch into).
      //
      // Slack OAuth install + callback used to mount here too; #2682
      // retired them. The canonical flow now lives at
      // `/api/v1/integrations/slack/{install,callback}` via
      // `SlackOAuthInstallHandler` (slices #2671 + #2674).
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

        // Slack OAuth install + callback used to live here. Retired in
        // #2682 — the canonical flow is now
        // `/api/v1/integrations/slack/{install,callback}` via
        // `SlackOAuthInstallHandler` (slices #2671 + #2674). The webhook
        // route above stays — only the OAuth dance moved.
      }

      // Telegram (1.5.3 #2748 — first static-bot webhook route here).
      // The receive path verifies the optional
      // `x-telegram-bot-api-secret-token` header internally via the
      // Chat SDK adapter; the configure-secret token from BotFather's
      // setWebhook call must match `TELEGRAM_WEBHOOK_SECRET` when set.
      // Remaining static-bot platforms (Discord #2749, gchat #2754,
      // WhatsApp #2753) ride the same pattern.
      // Discord (1.5.3 #2749 — second static-bot webhook). The Chat
      // SDK Discord adapter verifies the Ed25519 signature on every
      // incoming interaction internally using DISCORD_PUBLIC_KEY.
      if (discordStaticBotDeclared) {
        app.post("/webhooks/discord", async (c) => {
          const requestId = crypto.randomUUID();
          if (!bridge) {
            return c.json({ error: "Chat plugin not yet initialized", requestId }, 503);
          }
          const handler = bridge.webhooks.discord;
          if (!handler) {
            // Catalog declared discord + enabled, but the AdapterRegistry
            // didn't wire the adapter — almost always means one of
            // DISCORD_BOT_TOKEN / DISCORD_CLIENT_ID / DISCORD_PUBLIC_KEY
            // is unset. Same fail-loud posture as the Telegram branch
            // (#2748 review + #2673 silent-degradation precedent).
            (log ?? console).error(
              { requestId, adapter: "discord" },
              "Discord webhook received but adapter not configured — check DISCORD_BOT_TOKEN + DISCORD_CLIENT_ID + DISCORD_PUBLIC_KEY and AdapterRegistry boot logs",
            );
            return c.json({ error: "Discord adapter not configured", requestId }, 404);
          }
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

      // Google Chat (1.5.3 #2754 — fourth static-bot webhook). Most
      // production traffic arrives via the Workspace Events Pub/Sub
      // subscription the adapter binds at boot — the HTTP endpoint is
      // the fallback for slash-command invocations from the Google Chat
      // app config screen.
      if (gchatStaticBotDeclared) {
        app.post("/webhooks/gchat", async (c) => {
          const requestId = crypto.randomUUID();
          if (!bridge) {
            return c.json({ error: "Chat plugin not yet initialized", requestId }, 503);
          }
          const handler = bridge.webhooks.gchat;
          if (!handler) {
            // Catalog declared gchat + enabled, but the AdapterRegistry
            // didn't wire the adapter — almost always means
            // GCHAT_SERVICE_ACCOUNT_JSON and/or GCHAT_PUBSUB_TOPIC is
            // unset (or malformed JSON). Same fail-loud posture as
            // Telegram / Discord (#2748 / #2749 review + #2673
            // silent-degradation precedent).
            (log ?? console).error(
              { requestId, adapter: "gchat" },
              "Google Chat webhook received but adapter not configured — check GCHAT_SERVICE_ACCOUNT_JSON + GCHAT_PUBSUB_TOPIC and AdapterRegistry boot logs",
            );
            return c.json({ error: "Google Chat adapter not configured", requestId }, 404);
          }
          // Fail closed when JWT verification is unconfigured (#3350). The
          // upstream adapter treats GCHAT_PROJECT_NUMBER / GCHAT_PUBSUB_AUDIENCE
          // as optional and, when both are absent, logs one warning and then
          // processes UNVERIFIED HTTP webhooks — anyone who can reach this
          // public route could forge Google Chat events. The Pub/Sub pull
          // path the adapter binds at boot authenticates with the service
          // account and is unaffected by this gate.
          if (!process.env.GCHAT_PROJECT_NUMBER && !process.env.GCHAT_PUBSUB_AUDIENCE) {
            (log ?? console).error(
              { requestId, adapter: "gchat" },
              "Google Chat HTTP webhook rejected — JWT verification is not configured. Set GCHAT_PROJECT_NUMBER (direct webhooks) and/or GCHAT_PUBSUB_AUDIENCE (Pub/Sub push) to enable verified inbound HTTP traffic",
            );
            return c.json(
              { error: "Google Chat webhook verification is not configured", requestId },
              403,
            );
          }
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

      if (telegramStaticBotDeclared) {
        app.post("/webhooks/telegram", async (c) => {
          const requestId = crypto.randomUUID();
          if (!bridge) {
            return c.json({ error: "Chat plugin not yet initialized", requestId }, 503);
          }
          const handler = bridge.webhooks.telegram;
          if (!handler) {
            // Catalog declared telegram + enabled, but the AdapterRegistry
            // didn't wire the adapter — almost always means
            // `TELEGRAM_BOT_TOKEN` is unset. Operators staring at a 404
            // in chat-plugin logs need this signal explicitly, not as
            // background webhook noise (Telegram retries with backoff
            // and disables the webhook after a long failure window —
            // missing this log loses webhook delivery silently). See
            // #2748 review + #2673 silent-degradation precedent.
            (log ?? console).error(
              { requestId, adapter: "telegram" },
              "Telegram webhook received but adapter not configured — check TELEGRAM_BOT_TOKEN and AdapterRegistry boot logs",
            );
            return c.json({ error: "Telegram adapter not configured", requestId }, 404);
          }
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

      // Microsoft Teams (#3142 — fifth static-bot webhook, completing
      // Phase D under umbrella #2994). The Chat SDK Teams adapter verifies
      // the Bot Framework JWT on every inbound activity internally using
      // `TEAMS_APP_ID` + `TEAMS_APP_PASSWORD`. Per-Workspace routing by the
      // Microsoft Entra ID tenant GUID lives downstream in executeQuery's
      // Teams branch (resolves `channelData.tenant.id` → workspace_id).
      if (teamsStaticBotDeclared) {
        app.post("/webhooks/teams", async (c) => {
          const requestId = crypto.randomUUID();
          if (!bridge) {
            return c.json({ error: "Chat plugin not yet initialized", requestId }, 503);
          }
          const handler = bridge.webhooks.teams;
          if (!handler) {
            // Catalog declared teams + enabled, but the AdapterRegistry
            // didn't wire the adapter — almost always means `TEAMS_APP_ID`
            // and/or `TEAMS_APP_PASSWORD` is unset. Same fail-loud posture
            // as Telegram / Discord / gchat (#2748 / #2749 review + #2673
            // silent-degradation precedent).
            (log ?? console).error(
              { requestId, adapter: "teams" },
              "Teams webhook received but adapter not configured — check TEAMS_APP_ID + TEAMS_APP_PASSWORD and AdapterRegistry boot logs",
            );
            return c.json({ error: "Teams adapter not configured", requestId }, 404);
          }
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

      // WhatsApp (1.5.3 #2753 — fourth static-bot webhook). The Chat
      // SDK WhatsApp adapter verifies the HMAC-SHA256 signature on
      // every incoming webhook (`X-Hub-Signature-256`) using
      // `WHATSAPP_APP_SECRET`, and handles the GET verify-token
      // handshake using `WHATSAPP_VERIFY_TOKEN`. Per-Workspace routing
      // by `phone_number_id` lives downstream in executeQuery's
      // WhatsApp branch. Meta sends a GET to verify the webhook URL +
      // verify_token at setup time, then POSTs all event deliveries —
      // both verbs are mounted so the verify handshake can succeed.
      if (whatsappStaticBotDeclared) {
        // The two handlers share identical code paths but are
        // registered separately so Hono's path-typed Context generic
        // narrows cleanly (one `H<BlankEnv, "/webhooks/whatsapp", …>`
        // overload per verb, mirroring how the Telegram + Discord
        // branches register their single POST handler inline). Folding
        // both into one shared closure broke type inference (the
        // captured Context generic ended up `never`).
        app.get("/webhooks/whatsapp", async (c) => {
          const requestId = crypto.randomUUID();
          if (!bridge) {
            return c.json({ error: "Chat plugin not yet initialized", requestId }, 503);
          }
          const handler = bridge.webhooks.whatsapp;
          if (!handler) {
            (log ?? console).error(
              { requestId, adapter: "whatsapp" },
              "WhatsApp webhook received but adapter not configured — check META_BUSINESS_ACCESS_TOKEN + META_BUSINESS_APP_ID + WHATSAPP_APP_SECRET + WHATSAPP_VERIFY_TOKEN and AdapterRegistry boot logs",
            );
            return c.json({ error: "WhatsApp adapter not configured", requestId }, 404);
          }
          try {
            return await handler(c.req.raw, {
              waitUntil: (task: Promise<unknown>) => {
                task.catch((err: unknown) => {
                  (log ?? console).error(
                    { err: err instanceof Error ? err : new Error(String(err)), requestId, adapter: "whatsapp" },
                    "Chat SDK WhatsApp webhook background task failed",
                  );
                });
              },
            });
          } catch (err) {
            (log ?? console).error(
              { err: err instanceof Error ? err : new Error(String(err)), requestId, adapter: "whatsapp" },
              "WhatsApp webhook handler threw unexpectedly",
            );
            return c.json({ error: "Webhook processing failed", requestId }, 500);
          }
        });
        app.post("/webhooks/whatsapp", async (c) => {
          const requestId = crypto.randomUUID();
          if (!bridge) {
            return c.json({ error: "Chat plugin not yet initialized", requestId }, 503);
          }
          const handler = bridge.webhooks.whatsapp;
          if (!handler) {
            (log ?? console).error(
              { requestId, adapter: "whatsapp" },
              "WhatsApp webhook received but adapter not configured — check META_BUSINESS_ACCESS_TOKEN + META_BUSINESS_APP_ID + WHATSAPP_APP_SECRET + WHATSAPP_VERIFY_TOKEN and AdapterRegistry boot logs",
            );
            return c.json({ error: "WhatsApp adapter not configured", requestId }, 404);
          }
          try {
            return await handler(c.req.raw, {
              waitUntil: (task: Promise<unknown>) => {
                task.catch((err: unknown) => {
                  (log ?? console).error(
                    { err: err instanceof Error ? err : new Error(String(err)), requestId, adapter: "whatsapp" },
                    "Chat SDK WhatsApp webhook background task failed",
                  );
                });
              },
            });
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

      // Build chat-platform adapters via the catalog-driven
      // AdapterRegistry (#2650 slice 2). The registry reads per-Platform
      // credentials from an env-shaped object, logs errors on missing creds /
      // warns on non-OAuth entries, and returns the adapters map plus diagnostic
      // slug lists. The diagnostics let `healthCheck` surface actionable
      // error messages.
      //
      // Operator credentials (#3704): when the host wires `resolveAdapterEnv`,
      // its overlay (Admin-set, DB-backed operator credentials) is merged ON
      // TOP OF `process.env` so it wins, while unresolved keys fall through to
      // env (the self-host fallback). `undefined` overlay values are stripped
      // first so they never clobber a real env value. Re-reading the resolver
      // here on every `initialize()` is what makes the runtime rebuild seam
      // (`PluginRegistry.refresh` → teardown + initialize) pick up rotated
      // credentials with no process restart.
      try {
        const adapterEnv = await resolveAdapterBuildEnv(config, ctx.logger);
        const registry = buildChatAdapterRegistry({
          catalog: (config.catalog ?? []) as ReadonlyArray<ChatCatalogEntry>,
          env: adapterEnv,
          logger: ctx.logger,
        });
        slackAdapterInstance = registry.adapters.slack ?? null;
        // Telegram (1.5.3 #2748 — first static-bot adapter wired here);
        // Discord (1.5.3 #2749 — second); WhatsApp (1.5.3 #2753 —
        // third); Google Chat (1.5.3 #2754 — fourth); Teams (#3142 —
        // fifth, completing Phase D under umbrella #2994).
        telegramAdapterInstance = (registry.adapters.telegram ?? null) as Adapter | null;
        discordAdapterInstance = (registry.adapters.discord ?? null) as Adapter | null;
        whatsappAdapterInstance = (registry.adapters.whatsapp ?? null) as Adapter | null;
        gchatAdapterInstance = (registry.adapters.gchat ?? null) as Adapter | null;
        teamsAdapterInstance = (registry.adapters.teams ?? null) as Adapter | null;
        adapterDiagnostics = registry.diagnostics;

        // Bridge takes pre-built instances per-platform; unwired slots
        // are left `undefined` (the bridge tolerates this — see
        // `createChatBridge`).
        bridge = createChatBridge(config, ctx.logger, stateAdapter, {
          slack: slackAdapterInstance,
          telegram: telegramAdapterInstance,
          discord: discordAdapterInstance,
          whatsapp: whatsappAdapterInstance,
          gchat: gchatAdapterInstance,
          teams: teamsAdapterInstance,
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
        telegramAdapterInstance = null;
        discordAdapterInstance = null;
        whatsappAdapterInstance = null;
        gchatAdapterInstance = null;
        teamsAdapterInstance = null;
        throw err;
      }

      const enabledAdapters: string[] = [];
      if (slackAdapterInstance) enabledAdapters.push("slack");
      if (telegramAdapterInstance) enabledAdapters.push("telegram");
      if (discordAdapterInstance) enabledAdapters.push("discord");
      if (whatsappAdapterInstance) enabledAdapters.push("whatsapp");
      if (gchatAdapterInstance) enabledAdapters.push("gchat");
      if (teamsAdapterInstance) enabledAdapters.push("teams");

      const backend = config.state?.backend ?? "memory";
      const initFailedSilently =
        enabledAdapters.length === 0 &&
        hasInstantiationFailure(adapterDiagnostics);

      const msg =
        enabledAdapters.length > 0
          ? `Chat interaction plugin initialized (${enabledAdapters.join(", ")}, state: ${backend})`
          : `Chat interaction plugin initialized (no chat adapters activated — see AdapterRegistry errors, state: ${backend})`;

      if (initFailedSilently) {
        // SaaS-eligible catalog entry failed to instantiate (missing
        // env vars or unknown slug) — see #2673. Surface at `error` so
        // operator log streams catch the silent-degradation case.
        ctx.logger.error(
          {
            adapters: enabledAdapters,
            stateBackend: backend,
            diagnostics: adapterDiagnostics,
          },
          msg,
        );
      } else {
        ctx.logger.info(
          { adapters: enabledAdapters, stateBackend: backend },
          msg,
        );
      }

      // #3750 — hand the host the (narrow) bridge so it can register a chat
      // resume-deliverer that posts a parked turn's continued answer in-thread
      // once its approval is resolved. Host-optional; the plugin works
      // unchanged when `onBridgeReady` is absent. Best-effort — a host wiring
      // error must not fail plugin init.
      if (typeof config.onBridgeReady === "function" && bridge) {
        try {
          config.onBridgeReady(bridge);
        } catch (err) {
          ctx.logger.warn(
            { err: err instanceof Error ? err : new Error(String(err)) },
            "onBridgeReady callback threw — chat resume delivery may be unavailable",
          );
        }
      }

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
      if (telegramAdapterInstance) enabledAdapters.push("telegram");
      if (discordAdapterInstance) enabledAdapters.push("discord");
      if (whatsappAdapterInstance) enabledAdapters.push("whatsapp");
      if (gchatAdapterInstance) enabledAdapters.push("gchat");
      if (teamsAdapterInstance) enabledAdapters.push("teams");

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
            "No chat-type catalog entries declared in atlas.config.ts (or all are disabled / form-based).",
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
      // #3750 — clear the host's resume-deliverer before tearing the bridge
      // down so a `PluginRegistry.refresh("chat-interaction")` / hot-reload
      // doesn't leave a deliverer pointing at a shut-down bridge.
      if (typeof config.onBridgeReady === "function") {
        try {
          config.onBridgeReady(null);
        } catch (err) {
          (log ?? console).warn(
            { err: err instanceof Error ? err : new Error(String(err)) },
            "onBridgeReady(null) callback threw during teardown",
          );
        }
      }
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
      telegramAdapterInstance = null;
      discordAdapterInstance = null;
      whatsappAdapterInstance = null;
      gchatAdapterInstance = null;
      teamsAdapterInstance = null;
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
