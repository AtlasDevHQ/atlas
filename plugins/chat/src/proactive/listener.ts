/**
 * Proactive chat listener wiring.
 *
 * Slice #2292: subscribe → classify → react 🤖 on confident questions.
 * Slice #2293: when the asker (or anyone) reacts 🤖 back, or clicks
 * the "Yes, answer" button on the ephemeral offer, post the answer
 * in-thread.
 * Slice #2296: emit `classify` / `react` meter events to the host so
 * the AnswerMeter table picks up per-event cost + outcome.
 *
 * The plugin never imports `@atlas/ee` or `@atlas/api` directly. The
 * host wires `isEnabled` (`isEnterpriseEnabled() && workspaceFlag`),
 * `classify` (LLM call), `userResolver` (asker → Atlas user),
 * `executeQueryProactive` (Atlas agent on behalf of the asker), and
 * `onMeterEvent` (proactive_meter_events writer).
 */

import { emoji } from "chat";
import type { Author, Chat, Message, ReactionEvent, Thread } from "chat";
import type { PluginLogger } from "@useatlas/plugin-sdk";
import { classifyMessage } from "./classifier";
import { decideInterjection } from "./policy";
import {
  PendingAnswers,
  shouldAnswerOnReaction,
  type ProactiveAsker,
  type ProactiveExecuteQuery,
  type ProactiveUserResolver,
} from "./answerer";
import type {
  ChannelProactiveConfig,
  LLMClassifierFn,
  ProactiveGateFn,
  ProactiveMeterEvent,
  ProactiveMeterEventFn,
  RecentActivity,
  WorkspaceProactiveConfig,
} from "./types";
import {
  buildProactiveAnswerCard,
  buildProactiveOfferCard,
  buildUnlinkedAskerPrompt,
  PROACTIVE_ANSWER_ACTION_ID,
  PROACTIVE_DISMISS_ACTION_ID,
} from "../cards/proactive-answer-card";

// ---------------------------------------------------------------------------
// Public config
// ---------------------------------------------------------------------------

export interface ProactiveListenerConfig {
  /** Gate: true when proactive mode is allowed (enterprise + workspace flag). */
  isEnabled: ProactiveGateFn;
  /** LLM classifier callback. */
  classify: LLMClassifierFn;
  /** Workspace-level config. */
  workspace: WorkspaceProactiveConfig;
  /** Explicit channel allowlist, else `ATLAS_PROACTIVE_CHANNELS`. */
  channelAllowlist?: string[];
  /** Per-channel overrides keyed by channel ID. */
  channelConfigs?: Record<string, ChannelProactiveConfig>;

  // ---- Slice #2293 additions ----

  /**
   * Resolves a chat-platform user to an Atlas user. Linked askers get
   * the answer with their RLS; unlinked askers see the stub.
   */
  userResolver?: ProactiveUserResolver;
  /**
   * Runs the Atlas agent on behalf of a linked asker. Host wires this
   * to `runAgent` / `runAgentEffect` with the asker's `AuthContext`.
   */
  executeQueryProactive?: ProactiveExecuteQuery;
  /** URL the unlinked-asker prompt deep-links to. */
  linkUrl?: string;
  /** Platform name (`"slack"` etc.) used in `ProactiveAsker`. */
  platform?: string;

  // ---- Slice #2296 additions ----

  /**
   * Active workspace id. Stamped on every meter / audit event so rows
   * pivot cleanly on the workspace, not the channel. Optional: when
   * omitted the listener emits events with an empty string and the
   * host can decide whether to record. The current single-workspace
   * self-hosted setup doesn't need this; the SaaS multitenancy slice
   * does.
   */
  workspaceId?: string;
  /**
   * Optional host-injected meter callback (#2296). Receives one event
   * per classify (always) and one per react (when the policy
   * interjects). Failures are swallowed inside the listener so a meter
   * outage never crashes the Chat SDK loop.
   */
  onMeterEvent?: ProactiveMeterEventFn;
}

/**
 * Reaction emoji used when policy decides to interject. `robot_face`
 * isn't in the SDK well-known emoji map, so we use the `custom()`
 * escape hatch and let each adapter resolve to its native shortcode.
 */
export const PROACTIVE_REACTION = emoji.custom("robot_face");

// ---------------------------------------------------------------------------
// Channel allowlist resolution
// ---------------------------------------------------------------------------

export function resolveChannelAllowlist(
  explicit: string[] | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Set<string> {
  if (explicit && explicit.length > 0) return new Set(explicit);
  const raw = env.ATLAS_PROACTIVE_CHANNELS ?? "";
  return new Set(
    raw
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id.length > 0),
  );
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Adapter platform name, when the SDK exposes it. */
function adapterPlatform(adapter: { name?: string } | undefined, fallback?: string): string {
  return adapter?.name ?? fallback ?? "unknown";
}

/** Build a ProactiveAsker from a message author. */
function askerFromAuthor(author: Author, platform: string): ProactiveAsker {
  return {
    platform,
    externalUserId: author.userId,
    userName: author.userName,
  };
}

// ---------------------------------------------------------------------------
// Listener registration
// ---------------------------------------------------------------------------

/**
 * Register the proactive listener on a Chat SDK instance.
 *
 * Does nothing (and logs at debug) when `isEnabled()` returns falsy at
 * registration time. The gate is *also* re-checked inside the handler
 * for every message so a workspace toggle flip takes effect without
 * a restart.
 */
export async function registerProactiveListener(
  chat: Chat,
  log: PluginLogger,
  config: ProactiveListenerConfig,
): Promise<void> {
  const enabledAtRegistration = await config.isEnabled();
  if (!enabledAtRegistration) {
    log.debug("Proactive listener not registered — gate is closed");
    return;
  }

  const allowlist = resolveChannelAllowlist(config.channelAllowlist);
  log.info({ allowlistSize: allowlist.size }, "Proactive listener registered");

  // Per-channel last-interjection timestamps for rate limiting. In-memory
  // is fine for slices #2292–#2293 — #2296 layered in a durable meter
  // row but kept the cooldown gate cheap and local; cross-host cooldown
  // could ride the same `proactive_meter_events` table in a later slice.
  const recent = new Map<string, RecentActivity>();
  // Pending answers awaiting a reaction-back or button-click.
  const pending = new PendingAnswers();

  // Local helper: route an event through the host meter callback,
  // swallowing failures so a meter outage never propagates into the
  // SDK event loop. Stamps `workspaceId` from the registration config
  // so callers don't have to repeat it at every call site.
  const emitMeter = async (
    partial: Omit<ProactiveMeterEvent, "workspaceId">,
  ): Promise<void> => {
    if (!config.onMeterEvent) return;
    try {
      await config.onMeterEvent({
        workspaceId: config.workspaceId ?? "",
        ...partial,
      });
    } catch (err) {
      log.warn(
        {
          err: err instanceof Error ? err : new Error(String(err)),
          eventType: partial.eventType,
        },
        "Proactive meter callback threw — suppressed",
      );
    }
  };

  // -------------------------------------------------------------------------
  // Channel-message hook: classify + react + record asker for later answer
  // -------------------------------------------------------------------------
  chat.onNewMessage(/.+/, async (thread: Thread, message: Message) => {
    try {
      if (!(await config.isEnabled())) return;
      if (message.author.isBot === true || message.author.isMe) return;
      const text = message.text?.trim() ?? "";
      if (text.length === 0) return;

      const channelId = thread.channelId;
      const channelAllowed = allowlist.has(channelId);
      const channelConfig = config.channelConfigs?.[channelId];

      const classification = await classifyMessage({
        text,
        mode: config.workspace.classifierMode,
        llm: config.classify,
      });

      const decision = decideInterjection({
        classification,
        workspace: config.workspace,
        channel: channelConfig,
        channelAllowed,
        recentActivity: recent.get(channelId),
      });

      log.debug(
        {
          channelId,
          messageId: message.id,
          isQuestion: classification.isQuestion,
          confidence: classification.confidence,
          action: decision.action,
          reason: decision.reason,
        },
        "Proactive classification decision",
      );

      // Meter: every classify call lands a row. Tokens are populated
      // when the LLM actually ran; `0` on a regex-prefilter rejection
      // so the billing aggregator can split prefilter-rejected from
      // LLM-invoked calls without re-scanning metadata.
      await emitMeter({
        channelId,
        messageId: message.id,
        eventType: "classify",
        confidence: classification.confidence,
        tokens: classification.llmInvoked ? estimateClassifyTokens(text) : 0,
        actorUserId: message.author.userId ?? null,
        metadata: {
          isQuestion: classification.isQuestion,
          llmInvoked: classification.llmInvoked,
          candidate: classification.candidate,
          action: decision.action,
          reason: decision.reason,
        },
      });

      if (decision.action !== "react") return;

      const sent = thread.createSentMessageFromMessage(message);
      await sent.addReaction(PROACTIVE_REACTION);
      recent.set(channelId, { lastInterjectionAt: Date.now() });

      const platform = adapterPlatform(undefined, config.platform);
      const asker = askerFromAuthor(message.author, platform);
      pending.record(thread.channelId, message.id, { text, asker });

      // Meter: reaction landed — emit a `react` row so the admin
      // analytics panel and the eventual billing aggregator have a
      // clean "how often did the policy actually fire?" count without
      // scanning every classify row.
      await emitMeter({
        channelId,
        messageId: message.id,
        eventType: "react",
        confidence: classification.confidence,
        actorUserId: message.author.userId ?? null,
        metadata: { reason: decision.reason },
      });

      // Send an ephemeral "Yes, answer" offer card to the asker — only
      // they see it, so the channel stays clean even when the asker
      // doesn't react back. Best-effort: a missing or fallback-disabled
      // adapter is fine.
      await postOfferCard(thread, message, log);
    } catch (err) {
      log.warn(
        {
          err: err instanceof Error ? err : new Error(String(err)),
          messageId: message?.id,
        },
        "Proactive listener handler threw — suppressed",
      );
    }
  });

  // -------------------------------------------------------------------------
  // Reaction-back hook: trigger the answer flow
  // -------------------------------------------------------------------------
  chat.onReaction([PROACTIVE_REACTION], async (event: ReactionEvent) => {
    try {
      if (!(await config.isEnabled())) return;
      const lookup = pending.peek(event.threadId, event.messageId);
      const decision = shouldAnswerOnReaction({
        added: event.added,
        reactor: event.user,
        pending: lookup,
      });
      if (decision.action !== "answer") {
        log.debug(
          {
            threadId: event.threadId,
            messageId: event.messageId,
            reason: decision.reason,
          },
          "Reaction-back skipped",
        );
        return;
      }
      // Consume now so a second reactor doesn't double-fire.
      pending.consume(event.threadId, event.messageId);
      await runAnswerFlow(event.thread, event.threadId, decision.pending.text, decision.pending.asker, config, log);
    } catch (err) {
      log.warn(
        {
          err: err instanceof Error ? err : new Error(String(err)),
          messageId: event?.messageId,
        },
        "Proactive reaction-back handler threw — suppressed",
      );
    }
  });

  // -------------------------------------------------------------------------
  // "Yes, answer" / "Not now" button handlers
  // -------------------------------------------------------------------------
  chat.onAction(PROACTIVE_ANSWER_ACTION_ID, async (event) => {
    try {
      if (!(await config.isEnabled())) return;
      // Thread is null for view-based actions (e.g. home-tab buttons),
      // which the proactive offer card never reaches.
      if (!event.thread) return;
      // `event.value` is the original message ID the offer card was
      // built against.
      const originalMessageId = typeof event.value === "string" ? event.value : "";
      const lookup = pending.consume(event.threadId, originalMessageId);
      if (!lookup) {
        log.debug(
          {
            threadId: event.threadId,
            messageId: originalMessageId,
          },
          "Proactive 'Yes, answer' clicked but no pending entry — likely expired or already answered",
        );
        return;
      }
      await runAnswerFlow(event.thread, event.threadId, lookup.text, lookup.asker, config, log);
    } catch (err) {
      log.warn(
        {
          err: err instanceof Error ? err : new Error(String(err)),
          actionId: PROACTIVE_ANSWER_ACTION_ID,
        },
        "Proactive answer button handler threw — suppressed",
      );
    }
  });

  chat.onAction(PROACTIVE_DISMISS_ACTION_ID, async (event) => {
    try {
      const originalMessageId = typeof event.value === "string" ? event.value : "";
      pending.consume(event.threadId, originalMessageId);
      log.debug(
        { threadId: event.threadId, messageId: originalMessageId },
        "Proactive offer dismissed by asker",
      );
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err : new Error(String(err)) },
        "Proactive dismiss handler threw — suppressed",
      );
    }
  });
}

// ---------------------------------------------------------------------------
// Internal: offer card + answer flow
// ---------------------------------------------------------------------------

type AnyThread = Thread<unknown, unknown>;

async function postOfferCard(thread: AnyThread, message: Message, log: PluginLogger): Promise<void> {
  try {
    const offer = buildProactiveOfferCard(message.id);
    await thread.postEphemeral(message.author, offer, { fallbackToDM: true });
  } catch (err) {
    // Failure to post the offer card must not poison the reaction
    // flow — the asker can still react back manually.
    log.debug(
      { err: err instanceof Error ? err : new Error(String(err)) },
      "Proactive offer card delivery failed — reaction-back path still available",
    );
  }
}

async function runAnswerFlow(
  thread: AnyThread,
  threadId: string,
  text: string,
  asker: ProactiveAsker,
  config: ProactiveListenerConfig,
  log: PluginLogger,
): Promise<void> {
  const resolved = config.userResolver
    ? await safeResolveUser(config.userResolver, asker, log)
    : { atlasUserId: undefined };

  if (!resolved.atlasUserId) {
    const prompt = buildUnlinkedAskerPrompt(config.linkUrl);
    await thread.post(prompt);
    log.info(
      { threadId, externalUserId: asker.externalUserId },
      "Proactive answer: posted unlinked-asker stub",
    );
    return;
  }

  if (!config.executeQueryProactive) {
    log.warn(
      { threadId },
      "Proactive answer: linked asker resolved but executeQueryProactive not wired — falling back to unlinked prompt",
    );
    const prompt = buildUnlinkedAskerPrompt(config.linkUrl);
    await thread.post(prompt);
    return;
  }

  let result: { answer: string; followupSubscribe?: boolean };
  try {
    result = await config.executeQueryProactive(text, {
      threadId,
      asker,
      atlasUserId: resolved.atlasUserId,
    });
  } catch (err) {
    log.error(
      {
        err: err instanceof Error ? err : new Error(String(err)),
        threadId,
      },
      "Proactive executeQueryProactive threw",
    );
    await thread.post(
      "Sorry — I hit an error while answering. Try asking again or use `@atlas` directly.",
    );
    return;
  }

  const answer = buildProactiveAnswerCard(result.answer);
  await thread.post(answer);

  // Subscribe so follow-ups in the thread flow through the existing
  // `onSubscribedMessage` handler.
  if (result.followupSubscribe !== false) {
    try {
      await thread.subscribe();
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err : new Error(String(err)), threadId },
        "Proactive thread.subscribe() failed — follow-ups via onSubscribedMessage may not fire",
      );
    }
  }

  log.info(
    { threadId, externalUserId: asker.externalUserId, atlasUserId: resolved.atlasUserId },
    "Proactive answer delivered to linked asker",
  );
}

async function safeResolveUser(
  resolver: ProactiveUserResolver,
  asker: ProactiveAsker,
  log: PluginLogger,
): Promise<{ atlasUserId?: string }> {
  try {
    return await resolver(asker);
  } catch (err) {
    log.warn(
      {
        err: err instanceof Error ? err : new Error(String(err)),
        externalUserId: asker.externalUserId,
      },
      "Proactive userResolver threw — treating asker as unlinked",
    );
    return { atlasUserId: undefined };
  }
}

// ---------------------------------------------------------------------------
// Token estimation (heuristic)
// ---------------------------------------------------------------------------

/**
 * Cheap token estimate for the classify call.
 *
 * The classifier prompt is short and fixed-format; the input is bounded
 * by the prefilter's `MAX_MESSAGE_CHARS`. A rough `chars / 4` heuristic
 * is good enough for the meter — billing accuracy lands when the
 * classifier callback widens its return type to surface real provider
 * usage (#2287 line of work). The host can always overwrite `tokens`
 * in `onMeterEvent` once the real numbers are wired.
 *
 * Kept inline rather than re-exported because the plugin must not
 * depend on `@atlas/api`.
 */
function estimateClassifyTokens(text: string): number {
  // ~80 tokens of system prompt + the message itself at ~4 chars/token.
  const PROMPT_OVERHEAD = 80;
  if (typeof text !== "string" || text.length === 0) return PROMPT_OVERHEAD;
  return PROMPT_OVERHEAD + Math.ceil(text.length / 4);
}
