/**
 * Proactive chat listener wiring.
 *
 * Slice #2292: subscribe → classify → react 🤖 on confident questions.
 * Slice #2293: when the asker (or anyone) reacts 🤖 back, or clicks
 * the "Yes, answer" button on the ephemeral offer, post the answer
 * in-thread.
 *
 * The plugin never imports `@atlas/ee` or `@atlas/api` directly. The
 * host wires `isEnabled` (`isEnterpriseEnabled() && workspaceFlag`),
 * `classify` (LLM call), `userResolver` (asker → Atlas user), and
 * `executeQueryProactive` (Atlas agent on behalf of the asker).
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
  RecentActivity,
  WorkspaceProactiveConfig,
} from "./types";
import {
  buildProactiveAnswerCard,
  buildProactiveOfferCard,
  buildUnlinkedAskerPrompt,
  buildWrongDataModal,
  PROACTIVE_ANSWER_ACTION_ID,
  PROACTIVE_DISMISS_ACTION_ID,
} from "../cards/proactive-answer-card";
import {
  outcomeForActionId,
  parseFeedbackSlashArgs,
  PROACTIVE_FB_HELPFUL_ACTION_ID,
  PROACTIVE_FB_NOT_HELPFUL_ACTION_ID,
  PROACTIVE_FB_WRONG_DATA_ACTION_ID,
  PROACTIVE_FB_WRONG_DATA_INPUT_ID,
  PROACTIVE_FB_WRONG_DATA_MODAL_ID,
  RecentAnswers,
  type FeedbackCollectorFn,
  type ProactiveFeedbackEvent,
} from "./feedback";

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

  // ---- Slice #2298 additions: feedback collection ----

  /**
   * Persistence callback for `[Helpful] [Not helpful] [Wrong data]`
   * clicks, the wrong-data modal, and `/atlas feedback <text>`. The
   * host typically writes to the meter / evals dataset.
   */
  feedbackCollector?: FeedbackCollectorFn;
  /**
   * Configured slash-command name (e.g. `/atlas`). Used to register a
   * `feedback`-subcommand handler. Defaults to `/atlas` to match the
   * bridge default; pass the same value you pass to `slashCommandName`.
   */
  slashCommandName?: string;
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
export interface ProactiveListenerHandle {
  /**
   * Shared registry of recent Atlas answers per (channel, user) — used
   * by the bridge's `/atlas feedback <text>` subcommand fallback (see
   * `handleProactiveFeedbackSlash`). Null when the listener never
   * registered (gate closed at boot).
   */
  recentAnswers: RecentAnswers | null;
}

export async function registerProactiveListener(
  chat: Chat,
  log: PluginLogger,
  config: ProactiveListenerConfig,
): Promise<ProactiveListenerHandle> {
  const enabledAtRegistration = await config.isEnabled();
  if (!enabledAtRegistration) {
    log.debug("Proactive listener not registered — gate is closed");
    return { recentAnswers: null };
  }

  const allowlist = resolveChannelAllowlist(config.channelAllowlist);
  log.info({ allowlistSize: allowlist.size }, "Proactive listener registered");

  // Per-channel last-interjection timestamps for rate limiting.
  const recent = new Map<string, RecentActivity>();
  // Pending answers awaiting a reaction-back or button-click.
  const pending = new PendingAnswers();
  // Most-recent Atlas answer per (channelId, externalUserId) for the
  // slice #2298 `/atlas feedback <text>` fallback path.
  const recentAnswers = new RecentAnswers();

  // -------------------------------------------------------------------------
  // Channel-message hook: classify + react
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

      if (decision.action !== "react") return;

      const sent = thread.createSentMessageFromMessage(message);
      await sent.addReaction(PROACTIVE_REACTION);
      recent.set(channelId, { lastInterjectionAt: Date.now() });

      const platform = adapterPlatform(undefined, config.platform);
      const asker = askerFromAuthor(message.author, platform);
      pending.record(thread.channelId, message.id, { text, asker });

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
      await runAnswerFlow(event.thread, event.threadId, decision.pending.text, decision.pending.asker, config, log, recentAnswers);
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
      await runAnswerFlow(event.thread, event.threadId, lookup.text, lookup.asker, config, log, recentAnswers);
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

  // -------------------------------------------------------------------------
  // Feedback button handlers (slice #2298)
  // -------------------------------------------------------------------------
  chat.onAction(
    [
      PROACTIVE_FB_HELPFUL_ACTION_ID,
      PROACTIVE_FB_NOT_HELPFUL_ACTION_ID,
      PROACTIVE_FB_WRONG_DATA_ACTION_ID,
    ],
    async (event) => {
      try {
        if (!(await config.isEnabled())) return;
        const outcome = outcomeForActionId(event.actionId);
        if (!outcome) return;

        const platform = adapterPlatform(event.adapter, config.platform);
        const asker = askerFromAuthor(event.user, platform);
        const answerMessageId = event.messageId;

        if (outcome === "wrong-data") {
          // Open the textarea modal; the modal-submit handler below
          // writes the actual feedback record with the freeform text.
          const modal = buildWrongDataModal(answerMessageId);
          if (modal && typeof event.openModal === "function") {
            try {
              await event.openModal(modal);
              return; // record happens on submit
            } catch (modalErr) {
              log.debug(
                { err: modalErr instanceof Error ? modalErr : new Error(String(modalErr)) },
                "Proactive feedback: openModal failed — recording 'wrong-data' without freeform context",
              );
            }
          }
          // Platforms without modal support fall through and record
          // the button click as-is.
        }

        await deliverFeedback(
          {
            threadId: event.threadId,
            answerMessageId,
            asker,
            outcome,
            source: "button",
          },
          config,
          log,
          event.thread,
        );
      } catch (err) {
        log.warn(
          { err: err instanceof Error ? err : new Error(String(err)), actionId: event.actionId },
          "Proactive feedback button handler threw — suppressed",
        );
      }
    },
  );

  // -------------------------------------------------------------------------
  // Wrong-data modal submit (slice #2298)
  // -------------------------------------------------------------------------
  chat.onModalSubmit(PROACTIVE_FB_WRONG_DATA_MODAL_ID, async (event) => {
    try {
      if (!(await config.isEnabled())) return { action: "close" as const };

      const platform = adapterPlatform(event.adapter, config.platform);
      const asker = askerFromAuthor(event.user, platform);
      const answerMessageId =
        typeof event.privateMetadata === "string" ? event.privateMetadata : "";
      const rawText = event.values?.[PROACTIVE_FB_WRONG_DATA_INPUT_ID];
      const text = typeof rawText === "string" ? rawText.trim() : "";

      await deliverFeedback(
        {
          threadId: "",
          answerMessageId,
          asker,
          outcome: "wrong-data",
          context: text || undefined,
          source: "modal",
        },
        config,
        log,
        null,
      );

      return { action: "close" as const };
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err : new Error(String(err)) },
        "Proactive wrong-data modal handler threw — suppressed",
      );
      return { action: "close" as const };
    }
  });

  // Slice #2298: the `/atlas feedback <text>` subcommand is routed
  // from the bridge's existing `onSlashCommand` handler so we don't
  // register a duplicate listener for the same command. See
  // `handleProactiveFeedbackSlash` below for the entry point.

  return { recentAnswers };
}

// ---------------------------------------------------------------------------
// Public: bridge-routed slash subcommand handler
// ---------------------------------------------------------------------------

/**
 * Try to handle an `/atlas feedback <text>` invocation. Returns true
 * when the slash command was a feedback subcommand and was handled.
 *
 * The bridge calls this at the top of its `/atlas` slash handler. We
 * keep it as a free function (rather than a closure captured during
 * `registerProactiveListener`) so the bridge can call it directly
 * with the shared `RecentAnswers` registry.
 */
export async function handleProactiveFeedbackSlash(args: {
  text: string | undefined;
  channelId: string;
  asker: ProactiveAsker;
  config: ProactiveListenerConfig;
  log: PluginLogger;
  recentAnswers: RecentAnswers;
}): Promise<boolean> {
  const { text, channelId, asker, config, log, recentAnswers } = args;
  if (!config.feedbackCollector) return false;
  const parsed = parseFeedbackSlashArgs(text);
  if (parsed.kind !== "feedback") return false;

  if (!(await config.isEnabled())) return false;

  const recent = recentAnswers.lookup(channelId, asker.externalUserId);

  await deliverFeedback(
    {
      threadId: recent?.threadId ?? "",
      answerMessageId: recent?.answerMessageId ?? "",
      asker,
      outcome: "not-helpful",
      context: parsed.text,
      source: "slash-command",
    },
    config,
    log,
    null,
  );
  return true;
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
  recentAnswers: RecentAnswers,
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

  // Post the answer with the feedback button row. The Chat SDK
  // surfaces the answer card's own message ID as `event.messageId` on
  // feedback button clicks, so we don't have to round-trip the answer
  // id through the button `value`.
  const answer = buildProactiveAnswerCard(result.answer);
  const sent = await thread.post(answer);
  const answerMessageId =
    typeof sent === "object" && sent != null && "id" in sent && typeof sent.id === "string"
      ? sent.id
      : "";

  if (answerMessageId) {
    recentAnswers.record(thread.channelId, asker.externalUserId, {
      threadId,
      answerMessageId,
      question: text,
      answer: result.answer,
    });
  }

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

async function deliverFeedback(
  event: ProactiveFeedbackEvent,
  config: ProactiveListenerConfig,
  log: PluginLogger,
  thread: AnyThread | null,
): Promise<void> {
  if (!config.feedbackCollector) {
    log.debug(
      { outcome: event.outcome, source: event.source },
      "Proactive feedback: no collector configured — discarding event",
    );
    return;
  }
  try {
    await config.feedbackCollector(event);
  } catch (err) {
    log.warn(
      {
        err: err instanceof Error ? err : new Error(String(err)),
        outcome: event.outcome,
        source: event.source,
      },
      "Proactive feedbackCollector threw — feedback NOT recorded",
    );
    return;
  }

  if (thread && event.source === "button") {
    try {
      await thread.postEphemeral(event.asker.externalUserId, "Thanks for the feedback.", {
        fallbackToDM: false,
      });
    } catch {
      // Ack is best-effort. The feedback is already recorded.
    }
  }
  log.info(
    {
      outcome: event.outcome,
      source: event.source,
      externalUserId: event.asker.externalUserId,
      answerMessageId: event.answerMessageId,
    },
    "Proactive feedback recorded",
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
