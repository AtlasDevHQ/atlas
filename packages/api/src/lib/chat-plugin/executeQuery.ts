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
 *     → `workspace_id` via the static-bot install record. Future
 *     static-bot platforms (Discord #2749, gchat #2754, WhatsApp #2753)
 *     extend this branch as their slices land.
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
 *   - `executeAgentQuery(question, undefined, { actor, approvalSurface, priorMessages })`
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
import type { ApprovalRequestSurface } from "@useatlas/types";
import { executeAgentQuery } from "@atlas/api/lib/agent-query";
import { createLogger } from "@atlas/api/lib/logger";
import { checkRateLimit } from "@atlas/api/lib/auth/middleware";
import { botActorUser, type ChatBotPlatform } from "@atlas/api/lib/auth/actor";
import { getInstallation } from "@atlas/api/lib/slack/store";
import { internalQuery } from "@atlas/api/lib/db/internal";
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
 * Build the chat plugin's `executeQuery` callback.
 *
 * Multi-platform dispatch lives inside `runExecuteQuery`. Each chat
 * Platform gets its own tenant resolver, rate-limit key shape, and
 * approval-surface stamp. The `unsupported platform` branch throws a
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
    approvalSurface: "slack",
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
    approvalSurface: "telegram",
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

/** Unknown-tenant marker for the Telegram branch's fail-closed path. */
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
  const rows = await internalQuery<{ workspace_id: string }>(
    `SELECT workspace_id
       FROM workspace_plugins
      WHERE catalog_id = $1
        AND enabled = true
        AND config->>'chat_id' = $2
      LIMIT 1`,
    ["catalog:telegram", chatId],
  );
  if (rows.length === 0) {
    throw new TelegramUnknownTenantError(fingerprintChatId(chatId));
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
  surface: "slack" | "telegram",
  requestId: string,
): Promise<string | null> {
  if (!channel || !threadAnchor) return null;

  let conversationId: string | null = null;
  try {
    conversationId = await getConversationId(channel, threadAnchor);
  } catch (err) {
    log.debug(
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
  readonly approvalSurface: ApprovalRequestSurface;
  readonly conversationId: string | null;
  readonly priorMessages: ChatExecuteQueryContext["priorMessages"] | null;
  readonly presentationMode: ChatExecuteQueryContext["presentationMode"];
  /** Free-form log context — e.g. `{ teamId }` for Slack, `{ chatIdFingerprint }` for Telegram. */
  readonly tenantLabel: Record<string, unknown>;
}

/**
 * Shared agent-loop invocation + result mapping. Both Slack and Telegram
 * funnel through here once their per-platform tenant resolution + actor
 * binding is done. The presentation-mode default ("conversational") is
 * load-bearing for #2705; every chat-plugin path produces the
 * conversational shape unless the bridge explicitly opts out.
 */
async function runAgentAndMap(args: RunAgentArgs): Promise<ChatQueryResult> {
  const {
    question,
    requestId,
    actor,
    approvalSurface,
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
      approvalSurface,
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

// Compile-time guard that the platforms wired here all exist in
// `CHAT_BOT_PLATFORMS`. Adding a new branch above without extending the
// actor enum surfaces here as a TS error.
const _platformGuard: ChatBotPlatform = "telegram";
void _platformGuard;
