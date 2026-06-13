/**
 * Host-side `executeQuery` for the `@useatlas/chat` plugin.
 *
 * Wires the chat plugin's `executeQuery` callback to Atlas's agent loop.
 * The dispatcher branches on `adapter.name` and routes each chat platform
 * through its own per-tenant resolver + actor binding:
 *
 *   - **Slack** (slice 3 of #2607) — resolves `team_id` → `chat_cache`
 *     installation → `org_id`. Mirrors the legacy `routes/slack.ts` paths.
 *   - **Telegram** (1.5.3 slice 10 / #2748 — keystone for Phase D) —
 *     resolves `message.chat.id` → `workspace_plugins.config->>'chat_id'`
 *     → `workspace_id` via the static-bot install record.
 *   - **Discord** (1.5.3 slice 11 / #2749) — resolves `guild_id` →
 *     `workspace_plugins.config->>'guild_id'` → `workspace_id`. Same
 *     fail-closed contract as Telegram.
 *   - **WhatsApp** (1.5.3 slice 15 / #2753) — resolves the inbound
 *     webhook's normalized `phoneNumberId` →
 *     `workspace_plugins.config->>'phone_number_id'` → `workspace_id`.
 *     The user-side `wa_id` anchors per-user conversation persistence
 *     (WhatsApp has no thread / channel concept; every conversation is
 *     1:1). Remaining static-bot platform (gchat #2754) extends this
 *     dispatch when its slice lands.
 *
 * Without a per-platform tenant binding, `checkApprovalRequired`
 * short-circuits on a missing `orgId` and the approval gate silently
 * disables (F-55 regression). Both branches MUST fail-closed on unknown
 * tenant or DB outage before the agent runs.
 *
 * Mirrors what `packages/api/src/api/routes/slack.ts` does today for the
 * `app_mention` and `message + threadTs` branches:
 *
 *   - `getBotToken(teamId)` / `getInstallation(teamId)` for tenancy (Slack)
 *   - `workspace_plugins.config->>'chat_id'` lookup (Telegram)
 *   - `botActorUser({ platform, externalId, orgId, ... })` for F-55 identity
 *   - `executeAgentQuery(question, undefined, { actor, agentOrigin, priorMessages })`
 *   - `getConversationId` / `setConversationId` for thread → conversation mapping
 *   - `createConversation` / `addMessage` for multi-turn persistence
 *   - `checkRateLimit("&lt;platform&gt;:${tenantKey}")` for per-tenant rate limiting
 *   - Error scrubbing: the bridge's `scrubErrorMessage` is the single
 *     point of redaction. This helper re-throws the original message so
 *     the bridge owns the user-safe transformation.
 *
 * Pending actions (`PendingAction[]`) are returned to the chat plugin bridge
 * so it can post per-action ephemeral approval prompts. The legacy
 * `:lock:` pending-approval text is surfaced via the returned `answer`
 * field when the agent run hits an approval rule (matches the slack.ts
 * `pendingApproval` path).
 *
 * Layer hygiene: this module lives under `lib/` and never imports from
 * `api/routes/` (CLAUDE.md layer rule).
 *
 * @see packages/api/src/api/routes/slack.ts (legacy path, retired by #2611)
 * @see packages/api/src/lib/proactive/answer-adapter.ts (sister adapter for proactive flow)
 * @see packages/api/src/lib/proactive/workspace-id-resolver.ts (the
 *   precedent for `rawMessage.team_id` → org_id resolution)
 */

import type {
  ChatExecuteQueryContext,
  ChatQueryResult,
  ChatPluginConfig,
} from "@useatlas/chat";
import type { ApprovalRequestOrigin } from "@useatlas/types";
import { executeAgentQuery } from "@atlas/api/lib/agent-query";
import { BillingBlockedError } from "@atlas/api/lib/billing/agent-gate";
import { createLogger } from "@atlas/api/lib/logger";
import { checkRateLimit } from "@atlas/api/lib/auth/middleware";
import { botActorUser, type ChatBotPlatform } from "@atlas/api/lib/auth/actor";
import { getInstallation } from "@atlas/api/lib/slack/store";
import { internalQuery } from "@atlas/api/lib/db/internal";
import { DISCORD_GUILD_ID_RE } from "@atlas/api/lib/integrations/install/discord-static-bot-handler";
import { WHATSAPP_PHONE_NUMBER_ID_RE } from "@atlas/api/lib/integrations/install/whatsapp-static-bot-handler";
import { GCHAT_WORKSPACE_ID_RE } from "@atlas/api/lib/integrations/install/gchat-static-bot-handler";
import { TEAMS_TENANT_ID_RE } from "@atlas/api/lib/integrations/install/teams-static-bot-handler";
import { getConversationId, setConversationId } from "@atlas/api/lib/slack/threads";
import {
  createConversation,
  addMessage,
  getConversation,
  generateTitle,
} from "@atlas/api/lib/conversations";

const log = createLogger("chat-plugin:executeQuery");

/**
 * Minimum shape we read from the Slack raw event payload. The chat SDK
 * types `SlackEvent` for events_api callbacks but does NOT type
 * `block_actions` / interactive payloads — those flow through here too
 * (via `atlas_run_again` / `atlas_export_csv` button clicks). The
 * contract is `unknown` — narrow defensively.
 *
 * Events API: `team_id` / `user` / `channel` are bare strings.
 * block_actions: `team` / `user` / `channel` are `{ id, ... }` objects.
 * `type` lets us key the rate-limit bucket per-user for top-level
 * @mentions and team-wide for thread follow-ups (matches slack.ts).
 */
interface SlackRawEvent {
  type?: string;
  team_id?: string;
  team?: string | { id?: string };
  user?: string | { id?: string };
  channel?: string | { id?: string };
  thread_ts?: string;
  ts?: string;
}

/**
 * Minimum shape we read from a Telegram raw message envelope. The chat
 * adapter passes `TelegramMessage` (= `TelegramRawMessage`) as the raw
 * payload — see `@chat-adapter/telegram`'s `TelegramMessage` type.
 *
 * `chat.id` is a signed integer; we string-encode for parity with the
 * value persisted into `workspace_plugins.config->>'chat_id'` by
 * {@link TelegramStaticBotInstallHandler}. `message_thread_id` (Telegram
 * forum-topic concept) anchors per-topic conversation continuity; when
 * unset we fall back to `message_id` so a flat group still gets one
 * conversation per top-level message thread.
 */
interface TelegramRawEvent {
  message_id?: number;
  message_thread_id?: number;
  chat?: { id?: number; type?: string };
  from?: { id?: number; username?: string };
}

/**
 * Minimum shape we read from a Discord interaction envelope. The Chat
 * SDK's `@chat-adapter/discord` filters out PING (type 1) interactions
 * upstream and forwards APPLICATION_COMMAND (type 2) +
 * MESSAGE_COMPONENT (type 3) + APPLICATION_COMMAND_AUTOCOMPLETE (type
 * 4) + MODAL_SUBMIT (type 5) payloads through the `rawMessage` slot;
 * we don't currently branch on `type`, but include it in the shape to
 * document the contract.
 *
 * The discriminator we use for tenant routing is `guild_id` (set on
 * server interactions; absent on DMs, which Atlas refuses since the
 * static-bot install model is per-server). `member.user.id` populates
 * on guild interactions; `user.id` is the DM fallback (unreachable
 * here, kept for shape parity).
 */
interface DiscordRawEvent {
  /** Discord interaction id (snowflake). Used as a fallback channel anchor. */
  id?: string;
  /** Discord interaction type — 2=APPLICATION_COMMAND, 3=MESSAGE_COMPONENT, 5=MODAL_SUBMIT, etc. */
  type?: number;
  /** Guild snowflake — present on server interactions, absent on DMs. */
  guild_id?: string;
  channel_id?: string;
  member?: { user?: { id?: string; username?: string } };
  user?: { id?: string; username?: string };
}

/**
 * Minimum shape we read from a WhatsApp raw message envelope. The chat
 * adapter passes `WhatsAppRawMessage` (from `@chat-adapter/whatsapp`)
 * through the `rawMessage` slot — the per-message normalized shape, NOT
 * the unwrapped Meta webhook envelope. Documented at
 * https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/payload-examples.
 *
 * `phoneNumberId` is the per-Workspace routing identifier persisted by
 * {@link WhatsAppStaticBotInstallHandler} into
 * `workspace_plugins.config->>'phone_number_id'`. The user-side wa_id
 * (`contact.wa_id` or `message.from`) anchors per-user conversation
 * persistence — WhatsApp has no thread or channel concept; every
 * conversation is a 1:1 between the operator's business phone and a
 * single user, so wa_id is the only thread anchor available.
 */
interface WhatsAppRawEvent {
  /** Phone number id that received the message (per-Workspace routing). */
  phoneNumberId?: string;
  /** Contact info from the webhook. */
  contact?: { profile?: { name?: string }; wa_id?: string };
  /** The raw inbound message. */
  message?: {
    id?: string;
    from?: string;
    type?: string;
    text?: { body?: string };
  };
}

/**
 * Minimum shape we read from a Google Chat raw event envelope. The Chat
 * SDK's `@chat-adapter/gchat` forwards Google Chat MESSAGE events
 * delivered via either the HTTP endpoint or the Workspace Events
 * Pub/Sub subscription; in both shapes the routing identifier is
 * `space.customer`, which carries the Google Workspace customer id
 * once the subscription is bound to a Workspace install.
 *
 * `message.thread.name` is the per-thread anchor for conversation
 * persistence. `user.name` and `user.displayName` populate when the
 * sender is a human; bot-to-bot messages are filtered upstream.
 */
interface GchatRawEvent {
  /** Google Chat event type — `MESSAGE`, `ADDED_TO_SPACE`, etc. */
  eventType?: string;
  message?: {
    name?: string;
    thread?: { name?: string };
    space?: { name?: string };
  };
  space?: {
    /**
     * Google Workspace customer id. Canonical wire format is
     * `customers/<id>` (the Workspace Events Pub/Sub envelope) but
     * the direct webhook surface sometimes ships the bare `<id>`.
     * {@link extractGchatWorkspaceId} normalizes both into the bare
     * id stored on the install row.
     */
    customer?: string;
    /** `spaces/<id>` — anchor for per-space rate-limit + conversation continuity. */
    name?: string;
  };
  user?: { name?: string; displayName?: string };
}

/**
 * Minimum shape we read from a Microsoft Teams Bot Framework activity
 * envelope. `@chat-adapter/teams` forwards the raw activity (after its
 * own Bot Framework JWT verification) through the `rawMessage` slot.
 *
 * The per-Workspace routing identifier is the **Microsoft Entra ID tenant
 * GUID**, which the Bot Framework stamps on every activity at
 * `channelData.tenant.id` (canonical) — `conversation.tenantId` is the
 * fallback some activity types use. {@link TeamsStaticBotInstallHandler}
 * persists it (lowercased) into `workspace_plugins.config->>'tenant_id'`.
 *
 * `conversation.id` is the thread/channel anchor for conversation
 * persistence (Teams 1:1, group, and channel conversations all carry one).
 * `from.aadObjectId` is the stable per-user identity (preferred over the
 * channel-scoped `from.id`).
 */
interface TeamsRawEvent {
  channelData?: { tenant?: { id?: string } };
  conversation?: { id?: string; tenantId?: string };
  from?: { id?: string; aadObjectId?: string; name?: string };
}

/**
 * Normalize a Slack id field that may arrive as a bare string (events_api)
 * or as a `{ id, ... }` object (interactive `block_actions` payloads).
 */
function extractSlackId(
  value: string | { id?: string } | undefined,
): string | undefined {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && typeof value.id === "string") {
    return value.id;
  }
  return undefined;
}

/** Extract `team_id` (events_api) or `team.id` (block_actions). */
function extractTeamId(raw: SlackRawEvent): string | undefined {
  if (typeof raw.team_id === "string") return raw.team_id;
  return extractSlackId(raw.team);
}

/**
 * Extract the Telegram chat id and return it string-encoded. Returns
 * undefined for envelopes missing the chat envelope — those should never
 * reach the executeQuery path (the chat adapter would drop them earlier)
 * but the defensive check keeps the failure mode an actionable 4xx
 * rather than a misleading 500.
 */
function extractTelegramChatId(raw: TelegramRawEvent): string | undefined {
  const id = raw.chat?.id;
  if (typeof id !== "number" || !Number.isFinite(id)) return undefined;
  return String(id);
}

/**
 * Extract the Discord guild id from an inbound interaction envelope.
 * Returns undefined when the field is missing (DM interactions — see
 * the `runDiscordExecuteQuery` DM-refuse branch) OR when the value
 * isn't a valid snowflake. Even though the Ed25519 signature gate
 * upstream catches forgery, defending the shape here prevents an
 * attacker-controllable string from polluting the rate-limit cache key
 * (`discord:${guildId}`) or the workspace-resolution log fingerprint.
 *
 * Reuses {@link DISCORD_GUILD_ID_RE} from the install handler — single
 * source of truth for the snowflake invariant across install + receive
 * paths.
 */
function extractDiscordGuildId(raw: DiscordRawEvent): string | undefined {
  const id = raw.guild_id;
  if (typeof id !== "string" || id.length === 0) return undefined;
  if (!DISCORD_GUILD_ID_RE.test(id)) return undefined;
  return id;
}

/**
 * Extract the WhatsApp phone_number_id from an inbound message envelope.
 * Returns undefined when the field is missing OR when the value isn't a
 * valid Meta phone-number id (per {@link WHATSAPP_PHONE_NUMBER_ID_RE}).
 * Even though the HMAC-SHA256 webhook signature gate upstream catches
 * forgery, defending the shape here prevents an attacker-controllable
 * string from polluting the rate-limit cache key
 * (`whatsapp:${phoneNumberId}`) or the workspace-resolution log
 * fingerprint.
 *
 * Reuses {@link WHATSAPP_PHONE_NUMBER_ID_RE} from the install handler —
 * single source of truth for the routing-id invariant across install +
 * receive paths.
 */
function extractWhatsAppPhoneNumberId(raw: WhatsAppRawEvent): string | undefined {
  const id = raw.phoneNumberId;
  if (typeof id !== "string" || id.length === 0) return undefined;
  if (!WHATSAPP_PHONE_NUMBER_ID_RE.test(id)) return undefined;
  return id;
}

/**
 * Extract the Google Workspace customer id from `space.customer`. The
 * Workspace Events subscription stamps the field as `customers/<id>` or
 * the bare alphanumeric id depending on Pub/Sub event shape; this
 * normalizes both into the alphanumeric id the install row stored.
 *
 * Reuses {@link GCHAT_WORKSPACE_ID_RE} from the install handler — single
 * source of truth for the customer-id invariant across install + receive
 * paths (mirrors the Discord branch's `DISCORD_GUILD_ID_RE` reuse).
 */
function extractGchatWorkspaceId(raw: GchatRawEvent): string | undefined {
  const customer = raw.space?.customer;
  if (typeof customer !== "string" || customer.length === 0) return undefined;
  // Strip the `customers/` prefix if present so the value matches what
  // GchatStaticBotInstallHandler persists into workspace_plugins.config.
  const id = customer.startsWith("customers/")
    ? customer.slice("customers/".length)
    : customer;
  if (!GCHAT_WORKSPACE_ID_RE.test(id)) return undefined;
  return id;
}

/**
 * Extract the Microsoft Entra ID tenant GUID from a Teams activity
 * envelope and return it lowercased. Prefers `channelData.tenant.id`
 * (canonical) and falls back to `conversation.tenantId`. Returns
 * undefined when neither is present OR when the value isn't a valid
 * tenant GUID (per {@link TEAMS_TENANT_ID_RE}).
 *
 * Lowercasing matters: `TeamsStaticBotInstallHandler` stores the tenant
 * GUID lowercased, so the resolver's `config->>'tenant_id' = $2` compare
 * would miss an uppercase inbound value without this normalization.
 * Even though `@chat-adapter/teams` verifies the Bot Framework JWT
 * upstream, defending the shape here keeps an attacker-controllable
 * string out of the rate-limit cache key (`teams:${tenantId}`) and the
 * workspace-resolution log fingerprint.
 *
 * Reuses {@link TEAMS_TENANT_ID_RE} from the install handler — single
 * source of truth for the tenant-id invariant across install + receive
 * paths (mirrors the Discord / WhatsApp / gchat branches).
 */
function extractTeamsTenantId(raw: TeamsRawEvent): string | undefined {
  const candidate = raw.channelData?.tenant?.id ?? raw.conversation?.tenantId;
  if (typeof candidate !== "string" || candidate.length === 0) return undefined;
  if (!TEAMS_TENANT_ID_RE.test(candidate)) return undefined;
  return candidate.toLowerCase();
}

/**
 * Build the chat plugin's `executeQuery` callback.
 *
 * Multi-platform dispatch lives inside `runExecuteQuery`. Each chat
 * Platform gets its own tenant resolver, rate-limit key shape, and
 * agent-origin stamp. The `unsupported platform` branch throws a
 * user-safe error so the plugin's `buildErrorCard` path stays graceful.
 *
 * The returned callback is plain async — no `Effect` / `ManagedRuntime`
 * dependency. `executeAgentQuery` resolves its own context internally.
 */
export function createChatPluginExecuteQuery(): ChatPluginConfig["executeQuery"] {
  return runExecuteQuery;
}

/** Internal — exported only for tests. */
export async function runExecuteQuery(
  question: string,
  ctx: ChatExecuteQueryContext,
): Promise<ChatQueryResult> {
  const requestId = crypto.randomUUID();
  const { adapter } = ctx;

  if (adapter.name === "slack") {
    return runSlackExecuteQuery(question, ctx, requestId);
  }
  if (adapter.name === "telegram") {
    return runTelegramExecuteQuery(question, ctx, requestId);
  }
  if (adapter.name === "discord") {
    return runDiscordExecuteQuery(question, ctx, requestId);
  }
  if (adapter.name === "whatsapp") {
    return runWhatsAppExecuteQuery(question, ctx, requestId);
  }
  if (adapter.name === "gchat") {
    return runGchatExecuteQuery(question, ctx, requestId);
  }
  if (adapter.name === "teams") {
    return runTeamsExecuteQuery(question, ctx, requestId);
  }

  log.warn(
    { adapterName: adapter.name, threadId: ctx.threadId, requestId },
    "Chat plugin executeQuery received unsupported platform — refusing",
  );
  throw new Error(
    `Chat platform '${adapter.name}' is not yet supported by this Atlas deployment.`,
  );
}

// ---------------------------------------------------------------------------
// Slack branch — pre-existing #2607 path, unchanged behavior
// ---------------------------------------------------------------------------

async function runSlackExecuteQuery(
  question: string,
  ctx: ChatExecuteQueryContext,
  requestId: string,
): Promise<ChatQueryResult> {
  const { threadId, priorMessages, rawMessage } = ctx;

  // 1. Resolve tenant from `rawMessage.team_id` (or `team.id` on
  //    interactive `block_actions` payloads — see `extractTeamId`).
  //    Mirrors `lib/proactive/workspace-id-resolver.ts:createSlackWorkspaceIdResolver`.
  const raw = (rawMessage ?? {}) as SlackRawEvent;
  const teamId = extractTeamId(raw);
  if (!teamId) {
    log.warn(
      { threadId, requestId },
      "Chat plugin executeQuery received Slack event without team_id — refusing",
    );
    throw new Error(
      "This Slack event is missing tenant context. Please try again.",
    );
  }

  // Normalize Slack id fields (events_api: string; block_actions: object).
  const externalUserId = extractSlackId(raw.user);
  const channelId = extractSlackId(raw.channel) ?? "";

  // 2. Rate limit. Top-level @mentions are keyed per-user so one noisy
  //    user can't throttle the whole workspace (matches slack.ts:667).
  //    Thread follow-ups stay team-wide so a long-running conversation
  //    doesn't pile under one user's bucket (matches slack.ts:491).
  const rateLimitKey =
    raw.type === "app_mention"
      ? `slack:${teamId}:${externalUserId ?? raw.ts ?? "unknown"}`
      : `slack:${teamId}`;
  const rateCheck = checkRateLimit(rateLimitKey);
  if (!rateCheck.allowed) {
    log.info(
      { teamId, threadId, requestId },
      "Chat plugin executeQuery rate-limited",
    );
    throw new Error("Rate limit exceeded. Please wait before trying again.");
  }

  // 3. F-55 actor — bind a workspace bot actor so approval rules apply.
  //    `getInstallation(teamId)` reads `chat_cache` (single store, #2634).
  //    Without an Atlas org id, `checkApprovalRequired` short-circuits
  //    and any rule-matching query runs ungated, so both failure modes
  //    (DB throw, unknown tenant) MUST fail-closed before the agent
  //    runs — matches the module docstring's stated invariant.
  let orgId: string;
  try {
    const installation = await getInstallation(teamId);
    if (!installation) {
      log.warn(
        { teamId, threadId, requestId },
        "Unknown Slack team_id — refusing",
      );
      throw new Error(
        "This Slack workspace is not registered with Atlas. Reinstall the app or contact your admin.",
      );
    }
    if (!installation.org_id) {
      log.warn(
        { teamId, threadId, requestId },
        "Slack installation has no org_id — refusing",
      );
      throw new Error(
        "This Slack workspace is not registered with Atlas. Reinstall the app or contact your admin.",
      );
    }
    orgId = installation.org_id;
  } catch (err) {
    // Re-throw user-safe errors we just constructed (above) unchanged so
    // the bridge surfaces the actionable message. A genuine DB outage
    // during tenant resolution is NOT a "proceed anyway" condition —
    // log with full context (Sentry needs the unscrubbed error) and
    // surface a user-safe message.
    if (
      err instanceof Error &&
      err.message.startsWith("This Slack workspace is not registered")
    ) {
      throw err;
    }
    log.error(
      { teamId, threadId, requestId, err },
      "Failed to load Slack installation — refusing query",
    );
    throw new Error(
      "Atlas could not resolve the Slack workspace right now. Please try again in a moment.",
      { cause: err },
    );
  }

  const actor = botActorUser({
    platform: "slack",
    externalId: teamId,
    orgId,
    ...(externalUserId ? { externalUserId } : {}),
  });

  // 4. Multi-turn conversation persistence. The chat plugin's bridge
  //    already maintains the bridge's StateAdapter-backed conversation
  //    list, but Atlas's internal `conversations` table is the source of
  //    truth for cross-surface history (admin console + web chat + Slack
  //    thread reads). Mirror what slack.ts does: look up by
  //    (channel, thread_ts) and persist the user/assistant turns.
  const slackThreadTs = raw.thread_ts ?? raw.ts ?? "";
  const conversationId = await loadOrCreateConversation(
    channelId,
    slackThreadTs,
    question,
    "slack",
    requestId,
  );

  // 5. Run the agent + persist messages + return.
  return runAgentAndMap({
    question,
    requestId,
    actor,
    agentOrigin: "slack",
    conversationId,
    priorMessages: priorMessages ?? null,
    presentationMode: ctx.presentationMode,
    tenantLabel: { teamId, threadId },
  });
}

// ---------------------------------------------------------------------------
// Telegram branch — 1.5.3 #2748 keystone for Phase D
// ---------------------------------------------------------------------------

async function runTelegramExecuteQuery(
  question: string,
  ctx: ChatExecuteQueryContext,
  requestId: string,
): Promise<ChatQueryResult> {
  const { threadId, priorMessages, rawMessage } = ctx;
  const raw = (rawMessage ?? {}) as TelegramRawEvent;

  // 1. Resolve tenant — chat_id is the routing identifier persisted by
  //    `TelegramStaticBotInstallHandler` into `workspace_plugins.config`.
  const chatId = extractTelegramChatId(raw);
  if (!chatId) {
    log.warn(
      { threadId, requestId },
      "Chat plugin executeQuery received Telegram event without chat.id — refusing",
    );
    throw new Error(
      "This Telegram event is missing tenant context. Please try again.",
    );
  }

  // 2. Rate limit. Per-chat — Telegram chats are the equivalent of
  //    Slack workspaces here (one chat_id == one install row). A per-
  //    user key is also reasonable but Telegram's `from.id` is optional
  //    on channel posts, so keying on chat_id keeps the bucket simple.
  const rateCheck = checkRateLimit(`telegram:${chatId}`);
  if (!rateCheck.allowed) {
    log.info(
      { chatIdFingerprint: fingerprintChatId(chatId), threadId, requestId },
      "Chat plugin executeQuery rate-limited",
    );
    throw new Error("Rate limit exceeded. Please wait before trying again.");
  }

  // 3. F-55 actor — resolve chat_id → workspace_id via the install row.
  //    Same fail-closed contract as the Slack branch: unknown tenant or
  //    DB outage MUST throw before the agent runs.
  let orgId: string;
  try {
    orgId = await resolveTelegramWorkspaceId(chatId);
  } catch (err) {
    if (err instanceof TelegramUnknownTenantError) {
      log.warn(
        { chatIdFingerprint: fingerprintChatId(chatId), threadId, requestId },
        "Unknown Telegram chat_id — refusing",
      );
      throw new Error(
        "This Telegram chat is not connected to Atlas. Ask your admin to install Telegram in the Atlas integrations console.",
        { cause: err },
      );
    }
    log.error(
      {
        chatIdFingerprint: fingerprintChatId(chatId),
        threadId,
        requestId,
        err,
      },
      "Failed to resolve Telegram chat_id → workspace — refusing query",
    );
    throw new Error(
      "Atlas could not resolve the Telegram workspace right now. Please try again in a moment.",
      { cause: err },
    );
  }

  const externalUserId =
    typeof raw.from?.id === "number" && Number.isFinite(raw.from.id)
      ? String(raw.from.id)
      : undefined;
  const actor = botActorUser({
    platform: "telegram",
    externalId: chatId,
    orgId,
    ...(externalUserId ? { externalUserId } : {}),
  });

  // 4. Conversation persistence keyed on (chat_id, thread anchor). The
  //    thread anchor prefers Telegram's `message_thread_id` (forum-topic
  //    aware) and falls back to `message_id` so a flat group still gets
  //    one conversation per message-thread root.
  const threadAnchor = telegramThreadAnchor(raw);
  const conversationId = await loadOrCreateConversation(
    chatId,
    threadAnchor,
    question,
    "telegram",
    requestId,
  );

  return runAgentAndMap({
    question,
    requestId,
    actor,
    agentOrigin: "telegram",
    conversationId,
    priorMessages: priorMessages ?? null,
    presentationMode: ctx.presentationMode,
    tenantLabel: { chatIdFingerprint: fingerprintChatId(chatId), threadId },
  });
}

/**
 * Telegram thread anchor — prefer `message_thread_id` (the forum-topic
 * concept Telegram introduced for supergroups), fall back to
 * `message_id` so a flat group's top-level messages each anchor their
 * own conversation. Returns "" when neither is present, which matches
 * the Slack fallback that disables persistence for un-anchored events.
 */
function telegramThreadAnchor(raw: TelegramRawEvent): string {
  if (typeof raw.message_thread_id === "number") return String(raw.message_thread_id);
  if (typeof raw.message_id === "number") return String(raw.message_id);
  return "";
}

/**
 * Log-safe chat_id fingerprint — last 4 chars only. Mirrors the helper
 * in `telegram-static-bot-handler.ts`; kept inline here to avoid a
 * cross-module import for one 2-line helper.
 */
function fingerprintChatId(chatId: string): string {
  return chatId.length <= 4 ? chatId : `…${chatId.slice(-4)}`;
}

/**
 * Unknown-tenant marker for the Telegram branch's fail-closed path.
 *
 * Intentionally NOT a `Data.TaggedError` (the project's standard for
 * errors that flow through `mapTaggedError` to HTTP) — this class is
 * caught inline at its only call site and immediately rethrown as a
 * user-safe `Error` to the chat bridge. The class exists solely as an
 * `instanceof` sentinel that lets the catch arm distinguish "unknown
 * tenant" (user-actionable: install Atlas) from "DB outage" (operator-
 * actionable: retry). Promoting to `TaggedError` would only add union
 * bookkeeping for an error that never escapes this module.
 */
class TelegramUnknownTenantError extends Error {
  constructor(chatIdFingerprint: string) {
    super(`No Atlas workspace bound to Telegram chat …${chatIdFingerprint}`);
    this.name = "TelegramUnknownTenantError";
  }
}

/**
 * Resolve a Telegram chat_id → Atlas workspace_id via the static-bot
 * install record. Reads `workspace_plugins.config->>'chat_id'` for the
 * catalog row `catalog:telegram`. Throws {@link TelegramUnknownTenantError}
 * on no-row, propagates DB errors verbatim for caller-side logging.
 *
 * Why query the install row instead of a dedicated tenant table: the
 * static-bot install model stores the routing identifier inside
 * `workspace_plugins.config` JSONB (per ADR-0007's "form-based / static-
 * bot installs collapse credential + metadata into one row"), so the
 * install row IS the tenant lookup — no parallel store to keep in sync.
 */
async function resolveTelegramWorkspaceId(chatId: string): Promise<string> {
  // No LIMIT — fail-closed when the same chat_id maps to >1 workspace.
  // The DB schema doesn't currently enforce global uniqueness across
  // workspaces for the routing identifier (workspace_plugins_singleton
  // is per-workspace, not cross-workspace). Without this guard, two
  // workspaces installing the same chat_id would silently misroute
  // inbound messages — cross-tenant data exposure.
  const rows = await internalQuery<{ workspace_id: string }>(
    `SELECT workspace_id
       FROM workspace_plugins
      WHERE catalog_id = $1
        AND enabled = true
        AND config->>'chat_id' = $2`,
    ["catalog:telegram", chatId],
  );
  if (rows.length === 0) {
    throw new TelegramUnknownTenantError(fingerprintChatId(chatId));
  }
  if (rows.length > 1) {
    log.error(
      {
        chatIdFingerprint: fingerprintChatId(chatId),
        matchCount: rows.length,
      },
      "Telegram chat_id maps to multiple workspaces — refusing query (cross-tenant misroute risk). Operator must disconnect the duplicate install.",
    );
    throw new TelegramUnknownTenantError(fingerprintChatId(chatId));
  }
  return rows[0].workspace_id;
}

// ---------------------------------------------------------------------------
// Discord branch — 1.5.3 #2749 (Phase D)
// ---------------------------------------------------------------------------

async function runDiscordExecuteQuery(
  question: string,
  ctx: ChatExecuteQueryContext,
  requestId: string,
): Promise<ChatQueryResult> {
  const { threadId, priorMessages, rawMessage } = ctx;
  const raw = (rawMessage ?? {}) as DiscordRawEvent;

  // 1. Resolve tenant — guild_id is the routing identifier persisted
  //    by `DiscordStaticBotInstallHandler` into `workspace_plugins.config`.
  //    DM interactions have no `guild_id` and aren't bound to a workspace.
  const guildId = extractDiscordGuildId(raw);
  if (!guildId) {
    log.warn(
      { threadId, requestId },
      "Chat plugin executeQuery received Discord event without guild_id — refusing (DMs are not supported)",
    );
    throw new Error(
      "Atlas does not respond in Discord direct messages — interact with the bot inside a server where Atlas has been installed.",
    );
  }

  // 2. Rate limit — keyed per-guild (one install row == one rate-limit
  //    bucket). Same posture as Telegram's per-chat key.
  const rateCheck = checkRateLimit(`discord:${guildId}`);
  if (!rateCheck.allowed) {
    log.info(
      { guildIdFingerprint: fingerprintGuildId(guildId), threadId, requestId },
      "Chat plugin executeQuery rate-limited",
    );
    throw new Error("Rate limit exceeded. Please wait before trying again.");
  }

  // 3. F-55 actor — resolve guild_id → workspace_id via the install row.
  //    Same fail-closed contract as Slack / Telegram: unknown tenant or
  //    DB outage MUST throw before the agent runs.
  let orgId: string;
  try {
    orgId = await resolveDiscordWorkspaceId(guildId);
  } catch (err) {
    if (err instanceof DiscordUnknownTenantError) {
      log.warn(
        { guildIdFingerprint: fingerprintGuildId(guildId), threadId, requestId },
        "Unknown Discord guild_id — refusing",
      );
      throw new Error(
        "This Discord server is not connected to Atlas. Ask your admin to install Discord in the Atlas integrations console.",
        { cause: err },
      );
    }
    log.error(
      {
        guildIdFingerprint: fingerprintGuildId(guildId),
        threadId,
        requestId,
        err,
      },
      "Failed to resolve Discord guild_id → workspace — refusing query",
    );
    throw new Error(
      "Atlas could not resolve the Discord workspace right now. Please try again in a moment.",
      { cause: err },
    );
  }

  const externalUserId =
    raw.member?.user?.id ??
    raw.user?.id ??
    undefined;
  const actor = botActorUser({
    platform: "discord",
    externalId: guildId,
    orgId,
    ...(externalUserId ? { externalUserId } : {}),
  });

  // 4. Conversation persistence keyed on (guild_id, channel_id). Discord
  //    doesn't have a thread-of-threads model like Telegram's forum
  //    topics — channel_id is the right granularity. Falls back to the
  //    interaction id when channel_id is missing (rare — should always
  //    be present on guild interactions).
  const channelAnchor =
    typeof raw.channel_id === "string" && raw.channel_id.length > 0
      ? raw.channel_id
      : typeof raw.id === "string" && raw.id.length > 0
        ? raw.id
        : "";
  const conversationId = await loadOrCreateConversation(
    guildId,
    channelAnchor,
    question,
    "discord",
    requestId,
  );

  return runAgentAndMap({
    question,
    requestId,
    actor,
    agentOrigin: "discord",
    conversationId,
    priorMessages: priorMessages ?? null,
    presentationMode: ctx.presentationMode,
    tenantLabel: {
      guildIdFingerprint: fingerprintGuildId(guildId),
      threadId,
    },
  });
}

/**
 * Log-safe guild_id fingerprint — last 4 chars only.
 */
function fingerprintGuildId(guildId: string): string {
  return guildId.length <= 4 ? guildId : `…${guildId.slice(-4)}`;
}

/**
 * Unknown-tenant marker for the Discord branch's fail-closed path.
 * Same posture as {@link TelegramUnknownTenantError} — an `instanceof`
 * sentinel caught inline and rethrown user-safe, NOT a Data.TaggedError.
 */
class DiscordUnknownTenantError extends Error {
  constructor(guildIdFingerprint: string) {
    super(`No Atlas workspace bound to Discord guild …${guildIdFingerprint}`);
    this.name = "DiscordUnknownTenantError";
  }
}

/**
 * Resolve a Discord guild_id → Atlas workspace_id via the static-bot
 * install record. Reads `workspace_plugins.config->>'guild_id'` for the
 * catalog row `catalog:discord`. Throws {@link DiscordUnknownTenantError}
 * on no-row, propagates DB errors verbatim for caller-side logging.
 *
 * Same rationale as the Telegram resolver — the install row IS the
 * tenant lookup (no parallel store to keep in sync). See ADR-0007.
 */
async function resolveDiscordWorkspaceId(guildId: string): Promise<string> {
  // No LIMIT — fail-closed when the same guild_id maps to >1 workspace.
  // Same rationale as Telegram's resolver: the schema doesn't enforce
  // cross-workspace guild_id uniqueness today, and silently picking
  // one match is a cross-tenant data exposure risk.
  const rows = await internalQuery<{ workspace_id: string }>(
    `SELECT workspace_id
       FROM workspace_plugins
      WHERE catalog_id = $1
        AND enabled = true
        AND config->>'guild_id' = $2`,
    ["catalog:discord", guildId],
  );
  if (rows.length === 0) {
    throw new DiscordUnknownTenantError(fingerprintGuildId(guildId));
  }
  if (rows.length > 1) {
    log.error(
      {
        guildIdFingerprint: fingerprintGuildId(guildId),
        matchCount: rows.length,
      },
      "Discord guild_id maps to multiple workspaces — refusing query (cross-tenant misroute risk). Operator must disconnect the duplicate install.",
    );
    throw new DiscordUnknownTenantError(fingerprintGuildId(guildId));
  }
  return rows[0].workspace_id;
}

// ---------------------------------------------------------------------------
// Google Chat branch — 1.5.3 #2754 (Phase D)
// ---------------------------------------------------------------------------

async function runGchatExecuteQuery(
  question: string,
  ctx: ChatExecuteQueryContext,
  requestId: string,
): Promise<ChatQueryResult> {
  const { threadId, priorMessages, rawMessage } = ctx;
  const raw = (rawMessage ?? {}) as GchatRawEvent;

  // 1. Resolve tenant — workspace_id is the routing identifier persisted
  //    by `GchatStaticBotInstallHandler` into `workspace_plugins.config`.
  //    Pub/Sub envelopes without `space.customer` shouldn't reach here
  //    (the Marketplace install binds the subscription per-Workspace)
  //    but the defensive check keeps the failure mode a clear 4xx.
  const workspaceIdent = extractGchatWorkspaceId(raw);
  if (!workspaceIdent) {
    log.warn(
      { threadId, requestId },
      "Chat plugin executeQuery received Google Chat event without space.customer — refusing",
    );
    throw new Error(
      "This Google Chat event is missing tenant context (space.customer). Please try again.",
    );
  }

  // 2. Rate limit — keyed per-Workspace (one install row == one rate-
  //    limit bucket). Same posture as Telegram's per-chat / Discord's
  //    per-guild key.
  const rateCheck = checkRateLimit(`gchat:${workspaceIdent}`);
  if (!rateCheck.allowed) {
    log.info(
      { workspaceIdFingerprint: fingerprintGchatWorkspaceId(workspaceIdent), threadId, requestId },
      "Chat plugin executeQuery rate-limited",
    );
    throw new Error("Rate limit exceeded. Please wait before trying again.");
  }

  // 3. F-55 actor — resolve workspace_id → Atlas workspace via the
  //    install row. Same fail-closed contract as Slack / Telegram /
  //    Discord: unknown tenant or DB outage MUST throw before the
  //    agent runs.
  let orgId: string;
  try {
    orgId = await resolveGchatWorkspaceId(workspaceIdent);
  } catch (err) {
    if (err instanceof GchatUnknownTenantError) {
      log.warn(
        { workspaceIdFingerprint: fingerprintGchatWorkspaceId(workspaceIdent), threadId, requestId },
        "Unknown Google Workspace customer id — refusing",
      );
      throw new Error(
        "This Google Workspace is not connected to Atlas. Ask your admin to install Atlas from the Google Workspace Marketplace.",
        { cause: err },
      );
    }
    log.error(
      {
        workspaceIdFingerprint: fingerprintGchatWorkspaceId(workspaceIdent),
        threadId,
        requestId,
        err,
      },
      "Failed to resolve Google Workspace customer id → workspace — refusing query",
    );
    throw new Error(
      "Atlas could not resolve the Google Workspace right now. Please try again in a moment.",
      { cause: err },
    );
  }

  const externalUserId =
    typeof raw.user?.name === "string" && raw.user.name.length > 0
      ? raw.user.name
      : undefined;
  const actor = botActorUser({
    platform: "gchat",
    externalId: workspaceIdent,
    orgId,
    ...(externalUserId ? { externalUserId } : {}),
  });

  // 4. Conversation persistence keyed on (space.name, thread.name).
  //    Google Chat threads are first-class — `message.thread.name` is
  //    the canonical anchor. Falls back to the space name when the
  //    event is a top-level post outside a thread (DM-style).
  const spaceAnchor = raw.space?.name ?? raw.message?.space?.name ?? "";
  const threadAnchor =
    raw.message?.thread?.name ?? raw.message?.name ?? spaceAnchor;
  const conversationId = await loadOrCreateConversation(
    spaceAnchor,
    threadAnchor,
    question,
    "gchat",
    requestId,
  );

  return runAgentAndMap({
    question,
    requestId,
    actor,
    agentOrigin: "gchat",
    conversationId,
    priorMessages: priorMessages ?? null,
    presentationMode: ctx.presentationMode,
    tenantLabel: {
      workspaceIdFingerprint: fingerprintGchatWorkspaceId(workspaceIdent),
      threadId,
    },
  });
}

/**
 * Log-safe fingerprint of the Google Workspace customer id — last 4
 * chars only. Mirrors the helper in `gchat-static-bot-handler.ts`; kept
 * inline here to avoid a cross-module import for one 2-line helper.
 */
function fingerprintGchatWorkspaceId(workspaceId: string): string {
  return workspaceId.length <= 4 ? workspaceId : `…${workspaceId.slice(-4)}`;
}

/**
 * Unknown-tenant marker for the Google Chat branch's fail-closed path.
 * Same posture as {@link TelegramUnknownTenantError} — an `instanceof`
 * sentinel caught inline and rethrown user-safe, NOT a Data.TaggedError.
 */
class GchatUnknownTenantError extends Error {
  constructor(workspaceIdFingerprint: string) {
    super(`No Atlas workspace bound to Google Workspace …${workspaceIdFingerprint}`);
    this.name = "GchatUnknownTenantError";
  }
}

/**
 * Resolve a Google Workspace customer id → Atlas workspace_id via the
 * static-bot install record. Reads `workspace_plugins.config->>'workspace_id'`
 * for the catalog row `catalog:gchat`. Throws
 * {@link GchatUnknownTenantError} on no-row, propagates DB errors
 * verbatim for caller-side logging.
 *
 * Same rationale as the Telegram / Discord resolvers — the install row
 * IS the tenant lookup (no parallel store to keep in sync). See ADR-0007.
 */
async function resolveGchatWorkspaceId(workspaceIdent: string): Promise<string> {
  // No LIMIT — fail-closed when the same customer id maps to >1
  // workspace. Same rationale as Telegram / Discord: the schema doesn't
  // enforce cross-workspace customer-id uniqueness today, and silently
  // picking one match is a cross-tenant data exposure risk.
  const rows = await internalQuery<{ workspace_id: string }>(
    `SELECT workspace_id
       FROM workspace_plugins
      WHERE catalog_id = $1
        AND enabled = true
        AND config->>'workspace_id' = $2`,
    ["catalog:gchat", workspaceIdent],
  );
  if (rows.length === 0) {
    throw new GchatUnknownTenantError(fingerprintGchatWorkspaceId(workspaceIdent));
  }
  if (rows.length > 1) {
    log.error(
      {
        workspaceIdFingerprint: fingerprintGchatWorkspaceId(workspaceIdent),
        matchCount: rows.length,
      },
      "Google Workspace customer id maps to multiple workspaces — refusing query (cross-tenant misroute risk). Operator must disconnect the duplicate install.",
    );
    throw new GchatUnknownTenantError(fingerprintGchatWorkspaceId(workspaceIdent));
  }
  return rows[0].workspace_id;
}

// ---------------------------------------------------------------------------
// Microsoft Teams branch — #3142 (umbrella #2994)
// ---------------------------------------------------------------------------

async function runTeamsExecuteQuery(
  question: string,
  ctx: ChatExecuteQueryContext,
  requestId: string,
): Promise<ChatQueryResult> {
  const { threadId, priorMessages, rawMessage } = ctx;
  const raw = (rawMessage ?? {}) as TeamsRawEvent;

  // 1. Resolve tenant — the Microsoft Entra ID tenant GUID is the routing
  //    identifier persisted by `TeamsStaticBotInstallHandler` into
  //    `workspace_plugins.config`. The Bot Framework stamps it on every
  //    activity (`channelData.tenant.id`); a missing/invalid value should
  //    never reach here (the adapter verifies the JWT first) but the
  //    defensive check keeps the failure mode an actionable 4xx.
  const tenantId = extractTeamsTenantId(raw);
  if (!tenantId) {
    log.warn(
      { threadId, requestId },
      "Chat plugin executeQuery received Teams event without a valid tenant id — refusing",
    );
    throw new Error(
      "This Microsoft Teams event is missing tenant context. Please try again.",
    );
  }

  // 2. Rate limit — keyed per-tenant (one install row == one rate-limit
  //    bucket). Same posture as Discord's per-guild / gchat's per-Workspace key.
  const rateCheck = checkRateLimit(`teams:${tenantId}`);
  if (!rateCheck.allowed) {
    log.info(
      { tenantIdFingerprint: fingerprintTenantId(tenantId), threadId, requestId },
      "Chat plugin executeQuery rate-limited",
    );
    throw new Error("Rate limit exceeded. Please wait before trying again.");
  }

  // 3. F-55 actor — resolve tenant_id → workspace_id via the install row.
  //    Same fail-closed contract as Slack / Telegram / Discord: unknown
  //    tenant or DB outage MUST throw before the agent runs.
  let orgId: string;
  try {
    orgId = await resolveTeamsWorkspaceId(tenantId);
  } catch (err) {
    if (err instanceof TeamsUnknownTenantError) {
      log.warn(
        { tenantIdFingerprint: fingerprintTenantId(tenantId), threadId, requestId },
        "Unknown Teams tenant_id — refusing",
      );
      throw new Error(
        "This Microsoft Teams workspace is not connected to Atlas. Ask your admin to install Teams in the Atlas integrations console.",
        { cause: err },
      );
    }
    log.error(
      {
        tenantIdFingerprint: fingerprintTenantId(tenantId),
        threadId,
        requestId,
        err,
      },
      "Failed to resolve Teams tenant_id → workspace — refusing query",
    );
    throw new Error(
      "Atlas could not resolve the Teams workspace right now. Please try again in a moment.",
      { cause: err },
    );
  }

  const externalUserId =
    typeof raw.from?.aadObjectId === "string" && raw.from.aadObjectId.length > 0
      ? raw.from.aadObjectId
      : typeof raw.from?.id === "string" && raw.from.id.length > 0
        ? raw.from.id
        : undefined;
  const actor = botActorUser({
    platform: "teams",
    externalId: tenantId,
    orgId,
    ...(externalUserId ? { externalUserId } : {}),
  });

  // 4. Conversation persistence keyed on (tenant_id, conversation.id).
  //    Teams `conversation.id` is the stable thread/channel anchor for
  //    1:1, group, and channel conversations. Mirrors Discord's
  //    (guild_id, channel_id) granularity.
  const conversationAnchor =
    typeof raw.conversation?.id === "string" && raw.conversation.id.length > 0
      ? raw.conversation.id
      : "";
  const conversationId = await loadOrCreateConversation(
    tenantId,
    conversationAnchor,
    question,
    "teams",
    requestId,
  );

  return runAgentAndMap({
    question,
    requestId,
    actor,
    agentOrigin: "teams",
    conversationId,
    priorMessages: priorMessages ?? null,
    presentationMode: ctx.presentationMode,
    tenantLabel: {
      tenantIdFingerprint: fingerprintTenantId(tenantId),
      threadId,
    },
  });
}

/**
 * Log-safe tenant_id fingerprint — last 4 chars only. Mirrors the helper
 * in `teams-static-bot-handler.ts`; kept inline here to avoid a
 * cross-module import for one 2-line helper.
 */
function fingerprintTenantId(tenantId: string): string {
  return tenantId.length <= 4 ? tenantId : `…${tenantId.slice(-4)}`;
}

/**
 * Unknown-tenant marker for the Teams branch's fail-closed path. Same
 * posture as {@link TelegramUnknownTenantError} — an `instanceof`
 * sentinel caught inline and rethrown user-safe, NOT a Data.TaggedError.
 */
class TeamsUnknownTenantError extends Error {
  constructor(tenantIdFingerprint: string) {
    super(`No Atlas workspace bound to Teams tenant …${tenantIdFingerprint}`);
    this.name = "TeamsUnknownTenantError";
  }
}

/**
 * Resolve a Microsoft Entra ID tenant_id → Atlas workspace_id via the
 * static-bot install record. Reads `workspace_plugins.config->>'tenant_id'`
 * for the catalog row `catalog:teams`. Throws {@link TeamsUnknownTenantError}
 * on no-row, propagates DB errors verbatim for caller-side logging.
 *
 * Same rationale as the Telegram / Discord / gchat resolvers — the install
 * row IS the tenant lookup (no parallel store to keep in sync). See ADR-0007.
 */
async function resolveTeamsWorkspaceId(tenantId: string): Promise<string> {
  // No LIMIT — fail-closed when the same tenant_id maps to >1 workspace.
  // Microsoft issues each tenant GUID once, so a duplicate here is operator
  // misconfig (two workspaces both binding the same tenant); silently picking
  // one match is a cross-tenant data exposure risk.
  const rows = await internalQuery<{ workspace_id: string }>(
    `SELECT workspace_id
       FROM workspace_plugins
      WHERE catalog_id = $1
        AND enabled = true
        AND config->>'tenant_id' = $2`,
    ["catalog:teams", tenantId],
  );
  if (rows.length === 0) {
    throw new TeamsUnknownTenantError(fingerprintTenantId(tenantId));
  }
  if (rows.length > 1) {
    log.error(
      {
        tenantIdFingerprint: fingerprintTenantId(tenantId),
        matchCount: rows.length,
        matchedWorkspaceIds: rows.map((r) => r.workspace_id),
      },
      "Teams tenant_id maps to multiple workspaces — refusing query (cross-tenant misroute risk). Operator must disconnect the duplicate install.",
    );
    throw new TeamsUnknownTenantError(fingerprintTenantId(tenantId));
  }
  return rows[0].workspace_id;
}

// ---------------------------------------------------------------------------
// Shared conversation persistence + agent invocation
// ---------------------------------------------------------------------------

/**
 * Look up the conversation row for a (channel, thread anchor) pair, or
 * create a new one. Empty `channel` or `threadAnchor` disables
 * persistence — the caller proceeds without a `conversationId`, agent
 * still runs, just no cross-surface history.
 */
async function loadOrCreateConversation(
  channel: string,
  threadAnchor: string,
  question: string,
  surface: "slack" | "telegram" | "discord" | "whatsapp" | "gchat" | "teams",
  requestId: string,
): Promise<string | null> {
  if (!channel || !threadAnchor) return null;

  let conversationId: string | null = null;
  try {
    conversationId = await getConversationId(channel, threadAnchor);
  } catch (err) {
    // Promoted from debug to warn (#2749 review) so a real `chat_cache`
    // outage surfaces in default-level logs rather than masking as
    // "Atlas keeps losing context with no operator signal." The agent
    // still runs without persisted history — the warn is observability,
    // not a fail-closed gate.
    log.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        channel,
        threadAnchor,
        requestId,
      },
      "getConversationId failed — proceeding without persisted history",
    );
  }
  if (conversationId) return conversationId;

  const fresh = crypto.randomUUID();
  try {
    // Create the conversation row BEFORE stamping the thread →
    // conversationId mapping so a failure can't leave the mapping
    // pointing at a non-existent row. If `setConversationId` then
    // fails, the next event in the same thread allocates a fresh
    // conversation — worse for context continuity, harmless for
    // correctness.
    await createConversation({
      id: fresh,
      title: generateTitle(question),
      surface,
    });
    await setConversationId(channel, threadAnchor, fresh);
    return fresh;
  } catch (err) {
    // A DB write failure on the critical-path agent run is on-call
    // signal — log at error so Sentry / alerts fire alongside the
    // sibling tenant-resolution and agent-run failure paths.
    log.error(
      {
        err: err instanceof Error ? err.message : String(err),
        channel,
        threadAnchor,
        requestId,
      },
      "Failed to persist new conversation — proceeding with in-memory only",
    );
    return null;
  }
}

interface RunAgentArgs {
  readonly question: string;
  readonly requestId: string;
  readonly actor: ReturnType<typeof botActorUser>;
  readonly agentOrigin: ApprovalRequestOrigin;
  readonly conversationId: string | null;
  readonly priorMessages: ChatExecuteQueryContext["priorMessages"] | null;
  readonly presentationMode: ChatExecuteQueryContext["presentationMode"];
  /** Free-form log context — e.g. `{ teamId }` for Slack, `{ chatIdFingerprint }` for Telegram. */
  readonly tenantLabel: Record<string, unknown>;
}

/**
 * Shared agent-loop invocation + result mapping. Slack, Telegram, and
 * Discord all funnel through here once their per-platform tenant
 * resolution + actor
 * binding is done. The presentation-mode default ("conversational") is
 * load-bearing for #2705; every chat-plugin path produces the
 * conversational shape unless the bridge explicitly opts out.
 */
async function runAgentAndMap(args: RunAgentArgs): Promise<ChatQueryResult> {
  const {
    question,
    requestId,
    actor,
    agentOrigin,
    conversationId,
    priorMessages,
    presentationMode,
    tenantLabel,
  } = args;

  // Rehydrate history from the Atlas `conversations` table when the
  // bridge didn't supply it.
  let history = priorMessages;
  if (!history && conversationId) {
    try {
      const result = await getConversation(conversationId);
      if (result.ok && result.data.messages.length) {
        history = result.data.messages
          .filter(
            (m): m is typeof m & { role: "user" | "assistant" } =>
              m.role === "user" || m.role === "assistant",
          )
          .map((m) => ({
            role: m.role,
            content:
              typeof m.content === "string"
                ? m.content
                : JSON.stringify(m.content),
          }));
      }
    } catch (err) {
      log.warn(
        {
          conversationId,
          err: err instanceof Error ? err.message : String(err),
          requestId,
        },
        "Failed to load conversation history — proceeding without context",
      );
    }
  }

  let queryResult;
  try {
    queryResult = await executeAgentQuery(question, requestId, {
      ...(history ? { priorMessages: history } : {}),
      actor,
      agentOrigin,
      ...(conversationId ? { conversationId } : {}),
      // #2705 — propagate the bridge's presentation-mode signal so the
      // chat path produces the conversational shape. Default to
      // "conversational" because every call through this entrypoint
      // originates from the chat plugin's bridge (Slack/Telegram/etc.);
      // if the bridge predates #2705, we still want the chat-platform
      // shape rather than the web view.
      presentationMode: presentationMode ?? "conversational",
    });
  } catch (err) {
    // #3419 — a billing-enforcement block from the seam in
    // `executeAgentQuery` is an expected policy outcome, not an agent
    // failure: log at warn (the seam already warned with org context)
    // and rethrow UNCHANGED. Its `message` is user-safe by construction,
    // so the bridge delivers it as the in-thread platform reply — the
    // same path the rate-limit refusal takes, never a silent drop.
    if (err instanceof BillingBlockedError) {
      log.warn(
        { errorCode: err.errorCode, requestId, ...tenantLabel },
        "Chat plugin executeQuery blocked by billing enforcement",
      );
      throw err;
    }
    // Log the original `err` (with stack trace) so Sentry sees the
    // unscrubbed version. The re-thrown message stays unscrubbed too —
    // the bridge's `scrubErrorMessage` is the single source of truth
    // for what leaves the process (avoids double-redaction).
    log.error(
      { err, requestId, ...tenantLabel },
      "Chat plugin executeQuery agent run failed",
    );
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(message, { cause: err });
  }

  // Persist messages so future follow-ups can load history. Best-effort.
  if (conversationId) {
    try {
      addMessage({ conversationId, role: "user", content: question });
      addMessage({
        conversationId,
        role: "assistant",
        content: queryResult.answer,
      });
    } catch (err) {
      log.debug(
        {
          err: err instanceof Error ? err.message : String(err),
          conversationId,
          requestId,
        },
        "Failed to persist conversation messages — non-fatal",
      );
    }
  }

  // Approval-required path: replace the agent's free-form text with
  // the canonical `:lock:` notice. The bridge renders this through
  // `buildQueryResultCard` which calls `formatQueryResponse` — keeping
  // the message on `answer` means it surfaces in-thread identically to
  // the legacy slack.ts path.
  if (queryResult.pendingApproval) {
    log.info(
      {
        approvalRequestId: queryResult.pendingApproval.requestId,
        requestId,
        ...tenantLabel,
      },
      "Chat plugin executeQuery held for approval",
    );
    return {
      answer:
        `:lock: This query requires approval before it can run. ` +
        `Rule: *${queryResult.pendingApproval.ruleName}*. ` +
        `Approve via the Atlas admin console.`,
      sql: [],
      data: [],
      steps: 0,
      usage: { totalTokens: 0 },
    };
  }

  return {
    answer: queryResult.answer,
    sql: queryResult.sql,
    data: queryResult.data,
    steps: queryResult.steps,
    usage: queryResult.usage,
    ...(queryResult.pendingActions && queryResult.pendingActions.length > 0
      ? { pendingActions: queryResult.pendingActions }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// WhatsApp branch — 1.5.3 #2753 (Phase D)
// ---------------------------------------------------------------------------

async function runWhatsAppExecuteQuery(
  question: string,
  ctx: ChatExecuteQueryContext,
  requestId: string,
): Promise<ChatQueryResult> {
  const { threadId, priorMessages, rawMessage } = ctx;
  const raw = (rawMessage ?? {}) as WhatsAppRawEvent;

  // 1. Resolve tenant — phone_number_id is the routing identifier
  //    persisted by `WhatsAppStaticBotInstallHandler` into
  //    `workspace_plugins.config`. Meta tags every inbound message
  //    envelope with the phone_number_id that received it; the chat
  //    adapter normalizes that field onto `rawMessage.phoneNumberId`.
  const phoneNumberId = extractWhatsAppPhoneNumberId(raw);
  if (!phoneNumberId) {
    log.warn(
      { threadId, requestId },
      "Chat plugin executeQuery received WhatsApp event without phoneNumberId — refusing",
    );
    throw new Error(
      "This WhatsApp event is missing tenant context. Please try again.",
    );
  }

  // 2. Rate limit — keyed per-phone_number_id (one install row == one
  //    rate-limit bucket). Same posture as Discord's per-guild key.
  //    Per-user keying isn't right here because WhatsApp doesn't have
  //    a multi-user channel concept — every conversation is 1:1, so
  //    "one user owns the bucket" already.
  const rateCheck = checkRateLimit(`whatsapp:${phoneNumberId}`);
  if (!rateCheck.allowed) {
    log.info(
      {
        phoneNumberIdFingerprint: fingerprintPhoneNumberId(phoneNumberId),
        threadId,
        requestId,
      },
      "Chat plugin executeQuery rate-limited",
    );
    throw new Error("Rate limit exceeded. Please wait before trying again.");
  }

  // 3. F-55 actor — resolve phone_number_id → workspace_id via the
  //    install row. Same fail-closed contract as Slack / Telegram /
  //    Discord: unknown tenant or DB outage MUST throw before the agent
  //    runs.
  let orgId: string;
  try {
    orgId = await resolveWhatsAppWorkspaceId(phoneNumberId);
  } catch (err) {
    if (err instanceof WhatsAppUnknownTenantError) {
      log.warn(
        {
          phoneNumberIdFingerprint: fingerprintPhoneNumberId(phoneNumberId),
          threadId,
          requestId,
        },
        "Unknown WhatsApp phone_number_id — refusing",
      );
      throw new Error(
        "This WhatsApp number is not connected to Atlas. Ask your admin to install WhatsApp in the Atlas integrations console.",
        { cause: err },
      );
    }
    log.error(
      {
        phoneNumberIdFingerprint: fingerprintPhoneNumberId(phoneNumberId),
        threadId,
        requestId,
        err,
      },
      "Failed to resolve WhatsApp phone_number_id → workspace — refusing query",
    );
    throw new Error(
      "Atlas could not resolve the WhatsApp workspace right now. Please try again in a moment.",
      { cause: err },
    );
  }

  const externalUserId =
    typeof raw.contact?.wa_id === "string" && raw.contact.wa_id.length > 0
      ? raw.contact.wa_id
      : typeof raw.message?.from === "string" && raw.message.from.length > 0
        ? raw.message.from
        : undefined;
  if (!externalUserId) {
    // Meta sometimes routes status events (delivered / read receipts)
    // through the same webhook with no `contact` payload — the chat
    // adapter forwards them here without a wa_id. The actor binding
    // narrows from per-user (`whatsapp-bot:<phone>:<wa>`) to per-tenant
    // (`whatsapp-bot:<phone>`), F-55 approval rules keyed on the
    // per-user actor silently widen to the per-tenant actor, AND
    // conversation persistence below disables (no wa_id thread anchor).
    // Warn so the silent degradation is observable in operator logs.
    log.warn(
      {
        phoneNumberIdFingerprint: fingerprintPhoneNumberId(phoneNumberId),
        threadId,
        requestId,
      },
      "WhatsApp event missing wa_id — actor narrows to per-tenant granularity and conversation persistence disables for this event",
    );
  }
  const actor = botActorUser({
    platform: "whatsapp",
    externalId: phoneNumberId,
    orgId,
    ...(externalUserId ? { externalUserId } : {}),
  });

  // 4. Conversation persistence keyed on (phone_number_id, user wa_id).
  //    WhatsApp has no thread or channel concept — conversations are
  //    1:1 between the operator's business phone and a single user, so
  //    wa_id is the only thread anchor available. The chat plugin
  //    bridge encodes this in `WhatsAppThreadId` as
  //    `whatsapp:{phoneNumberId}:{userWaId}`; here we just persist
  //    by the (phoneNumberId, wa_id) pair. Empty wa_id disables
  //    persistence — see the warn above.
  const userWaId = externalUserId ?? "";
  const conversationId = await loadOrCreateConversation(
    phoneNumberId,
    userWaId,
    question,
    "whatsapp",
    requestId,
  );

  return runAgentAndMap({
    question,
    requestId,
    actor,
    agentOrigin: "whatsapp",
    conversationId,
    priorMessages: priorMessages ?? null,
    presentationMode: ctx.presentationMode,
    tenantLabel: {
      phoneNumberIdFingerprint: fingerprintPhoneNumberId(phoneNumberId),
      threadId,
    },
  });
}

/**
 * Log-safe phone_number_id fingerprint — last 4 chars only. Mirrors the
 * helper in `whatsapp-static-bot-handler.ts`; kept inline here to avoid
 * a cross-module import for one 2-line helper.
 */
function fingerprintPhoneNumberId(phoneNumberId: string): string {
  return phoneNumberId.length <= 4 ? phoneNumberId : `…${phoneNumberId.slice(-4)}`;
}

/**
 * Unknown-tenant marker for the WhatsApp branch's fail-closed path.
 * Same posture as {@link DiscordUnknownTenantError} — an `instanceof`
 * sentinel caught inline and rethrown user-safe, NOT a Data.TaggedError.
 */
class WhatsAppUnknownTenantError extends Error {
  constructor(phoneNumberIdFingerprint: string) {
    super(`No Atlas workspace bound to WhatsApp number …${phoneNumberIdFingerprint}`);
    this.name = "WhatsAppUnknownTenantError";
  }
}

/**
 * Resolve a WhatsApp phone_number_id → Atlas workspace_id via the
 * static-bot install record. Reads
 * `workspace_plugins.config->>'phone_number_id'` for the catalog row
 * `catalog:whatsapp`. Throws {@link WhatsAppUnknownTenantError} on
 * no-row, propagates DB errors verbatim for caller-side logging.
 *
 * Same rationale as the Telegram / Discord resolvers — the install row
 * IS the tenant lookup (no parallel store to keep in sync). See
 * ADR-0007.
 */
async function resolveWhatsAppWorkspaceId(phoneNumberId: string): Promise<string> {
  // No LIMIT — fail-closed when the same phone_number_id maps to >1
  // workspace. Meta's Cloud API issues each phone_number_id exactly
  // once across the entire WhatsApp Business platform, so a duplicate
  // here is operator misconfig (manual DB edit) rather than a
  // legitimate routing case — silently picking one match is a
  // cross-tenant data exposure risk.
  const rows = await internalQuery<{ workspace_id: string }>(
    `SELECT workspace_id
       FROM workspace_plugins
      WHERE catalog_id = $1
        AND enabled = true
        AND config->>'phone_number_id' = $2`,
    ["catalog:whatsapp", phoneNumberId],
  );
  if (rows.length === 0) {
    throw new WhatsAppUnknownTenantError(fingerprintPhoneNumberId(phoneNumberId));
  }
  if (rows.length > 1) {
    // Surface the matched workspace_ids so the operator can disconnect
    // the duplicate without dumping the table. Meta phone_number_ids
    // are sequentially assigned in batches, so last-4-char
    // fingerprints have a meaningfully higher collision rate than
    // Discord snowflakes — the explicit list is what makes the cross-
    // tenant misroute warning actually triagable.
    log.error(
      {
        phoneNumberIdFingerprint: fingerprintPhoneNumberId(phoneNumberId),
        matchCount: rows.length,
        matchedWorkspaceIds: rows.map((r) => r.workspace_id),
      },
      "WhatsApp phone_number_id maps to multiple workspaces — refusing query (cross-tenant misroute risk). Operator must disconnect the duplicate install.",
    );
    throw new WhatsAppUnknownTenantError(fingerprintPhoneNumberId(phoneNumberId));
  }
  return rows[0].workspace_id;
}

// Compile-time guard that the platforms wired here all exist in
// `CHAT_BOT_PLATFORMS`. Adding a new branch above without extending the
// actor enum surfaces here as a TS error. Slack is included even
// though it uses `getInstallation` for tenancy rather than the
// static-bot install row — every platform that calls `botActorUser`
// must appear in `CHAT_BOT_PLATFORMS`, and Slack is the original
// member.
const _platformGuards: ReadonlyArray<ChatBotPlatform> = [
  "slack",
  "telegram",
  "discord",
  "whatsapp",
  "gchat",
  "teams",
];
void _platformGuards;
