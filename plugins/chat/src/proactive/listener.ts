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
import {
  detectPauseCommand,
  detectUnsubscribeDM,
  resolvePauseRequest,
  type IsPausedFn,
} from "./pause";
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
  GetPublicDatasetFn,
  GetQuotaStatusFn,
  LLMClassifierFn,
  OnPauseRequestFn,
  ProactiveGateFn,
  ProactiveMeterEvent,
  ProactiveMeterEventFn,
  ProactivePublicDatasetEntry,
  RecentActivity,
  WorkspaceProactiveConfig,
} from "./types";
import { DEFAULT_PROACTIVE_REFUSAL_COPY } from "./types";
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

  // ---- Slice #2296 additions ----

  /**
   * Active workspace id. Stamped on every meter / audit event so rows
   * pivot cleanly on the workspace, not the channel. Optional: when
   * Optional host-injected meter callback (#2296). Receives one event
   * per classify (always) and one per react (when the policy
   * interjects). Failures are swallowed inside the listener so a meter
   * outage never crashes the Chat SDK loop.
   */
  onMeterEvent?: ProactiveMeterEventFn;

  // ---- Slice #2301 additions: monthly quota cap ----

  /**
   * Optional host-injected quota reader. Consulted BEFORE classification
   * so a workspace that has hit its monthly cap pays only a DB read
   * (well-indexed) per message instead of an LLM call. When the cap is
   * reached the listener emits a `classify` meter event with
   * `metadata: { capReached: true, skipped: "monthly-quota" }` and
   * skips both classification and reaction.
   *
   * Failures are swallowed (no-op + warn) so a quota outage never
   * silences Atlas — the agent fails open just like the pause registry.
   */
  getQuotaStatus?: GetQuotaStatusFn;

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

  // ---- Slice #2297 additions: public dataset for unlinked askers ----

  /**
   * Host-injected fetch for the curated allowlist of semantic entities
   * an unlinked asker may ask about. When omitted the listener keeps
   * the #2293 unlinked-asker stub (link-Atlas prompt only).
   */
  getPublicDataset?: GetPublicDatasetFn;
  /**
   * Override the default refusal copy posted when an unlinked asker's
   * question touches an entity that isn't on the public dataset.
   * Defaults to `DEFAULT_PROACTIVE_REFUSAL_COPY`.
   */
  refusalCopy?: string;
  /**
   * Opt-out for hosts whose `executeQueryProactive` cannot report
   * `entitiesReferenced` on the result. When `false` (the safe
   * default), a result without `entitiesReferenced` is treated as
   * "unknown entities" and refused (`public_refused` emitted with
   * `reason: "entitiesReferenced-missing"`). Setting `true` lets
   * such a result through — only enable when the host has another
   * compensating control (e.g. RLS, a wrapper that enforces the
   * allowlist at SQL time). Logs at warn on startup so the bypass
   * is visible in boot logs.
   */
  allowAnswerWhenEntitiesUnknown?: boolean;

  // ---- Slice #2295 additions (kill switch + per-user opt-out) ----

  /**
   * Workspace id threaded into the kill-switch callbacks. Required
   * when `isPaused` or `onPauseRequest` is set. In single-tenant
   * deployments this can be a constant; multi-tenant hosts pass the
   * org id.
   */
  workspaceId?: string;
  /**
   * Pause-registry read API. Consulted BEFORE classification so the
   * kill switch pays only a DB read, never an LLM call. When omitted
   * no pause check happens — the legacy env-var allowlist path stays
   * available for tests + dev.
   */
  isPaused?: IsPausedFn;
  /**
   * Pause-registry write API. Called when the listener detects an
   * `@atlas pause` channel command or a DM `unsubscribe`. The plugin
   * builds the request shape and hands it off to the host.
   */
  onPauseRequest?: OnPauseRequestFn;
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
  log.info(
    {
      allowlistSize: allowlist.size,
      killSwitch: Boolean(config.isPaused),
      unsubscribe: Boolean(config.onPauseRequest),
    },
    "Proactive listener registered",
  );
  if (config.allowAnswerWhenEntitiesUnknown) {
    log.warn(
      { workspaceId: config.workspaceId },
      "Proactive: allowAnswerWhenEntitiesUnknown=true — unlinked-asker results without entitiesReferenced will be allowed through. Public-dataset allowlist is NOT enforced for these results; the host must provide a compensating control.",
    );
  }

  // Per-channel last-interjection timestamps for rate limiting. In-memory
  // is fine for slices #2292–#2293 — #2296 layered in a durable meter
  // row but kept the cooldown gate cheap and local; cross-host cooldown
  // could ride the same `proactive_meter_events` table in a later slice.
  const recent = new Map<string, RecentActivity>();
  // Pending answers awaiting a reaction-back or button-click.
  const pending = new PendingAnswers();
  // Most-recent Atlas answer per (channelId, externalUserId) for the
  // slice #2298 `/atlas feedback <text>` fallback path.
  const recentAnswers = new RecentAnswers();

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
      const userId = message.author.userId;
      const isDM = thread.isDM === true;

      // ---------------------------------------------------------------
      // Pause-command intake (#2295) — runs BEFORE classification so
      // a mute message never costs an LLM call.
      // ---------------------------------------------------------------

      // DM `unsubscribe` → workspace-wide user-optout row.
      if (
        isDM &&
        config.workspaceId &&
        config.onPauseRequest &&
        detectUnsubscribeDM(text)
      ) {
        try {
          await config.onPauseRequest(
            resolvePauseRequest("dm-unsubscribe", {
              workspaceId: config.workspaceId,
              channelId,
              userId,
            }),
          );
          log.info(
            { workspaceId: config.workspaceId, userId },
            "Proactive: user opted out via DM unsubscribe",
          );
        } catch (err) {
          log.warn(
            { err: err instanceof Error ? err : new Error(String(err)) },
            "Proactive: DM unsubscribe write failed — user still listed in proactive",
          );
        }
        return;
      }

      // In-channel `@atlas pause` → 24h channel-scoped pause.
      if (
        !isDM &&
        config.workspaceId &&
        config.onPauseRequest &&
        detectPauseCommand(text)
      ) {
        try {
          await config.onPauseRequest(
            resolvePauseRequest("channel-pause-command", {
              workspaceId: config.workspaceId,
              channelId,
              userId,
            }),
          );
          log.info(
            { workspaceId: config.workspaceId, channelId, userId },
            "Proactive: channel paused for 24h via @atlas pause",
          );
        } catch (err) {
          log.warn(
            { err: err instanceof Error ? err : new Error(String(err)) },
            "Proactive: @atlas pause write failed — channel remains live",
          );
        }
        return;
      }

      // ---------------------------------------------------------------
      // Kill-switch lookup — runs BEFORE classification so we pay only
      // a DB read when Atlas is silenced.
      //
      // Fails CLOSED on callback throw: a registry hiccup must not
      // silently defeat workspace-kill / admin-channel / user-optout /
      // channel-24h. The host-side `isPaused` (`pause-registry.ts`)
      // already fails closed on DB error and returns a synthetic
      // workspace-kill decision; this extra catch protects against
      // a host implementation that throws (rather than returning) on
      // failure, so the listener's posture matches the registry's
      // regardless of host wiring.
      // ---------------------------------------------------------------
      if (config.isPaused && config.workspaceId) {
        let pause: Awaited<ReturnType<IsPausedFn>>;
        try {
          pause = await config.isPaused({
            workspaceId: config.workspaceId,
            channelId,
            userId,
          });
        } catch (err) {
          log.error(
            { err: err instanceof Error ? err : new Error(String(err)) },
            "Proactive: pause-registry callback threw — failing CLOSED (Atlas silenced)",
          );
          return;
        }
        if (pause.paused) {
          log.debug(
            {
              workspaceId: config.workspaceId,
              channelId,
              userId,
              layer: pause.layer,
              until: pause.until,
            },
            "Proactive: skipped — pause registry says silent",
          );
          return;
        }
      }

      const channelAllowed = allowlist.has(channelId);
      const channelConfig = config.channelConfigs?.[channelId];

      // ---------------------------------------------------------------
      // Monthly quota cap (#2301) — short-circuit BEFORE the classifier
      // when the workspace has used its allotted classifies for the
      // current calendar month. Records a `classify` meter row with
      // `capReached: true` so the admin analytics + audit trail show
      // "we saw a question and chose to skip it because of the cap"
      // instead of a silent gap. No reaction, no offer card.
      // ---------------------------------------------------------------
      if (config.getQuotaStatus && config.workspaceId) {
        let quota: Awaited<ReturnType<GetQuotaStatusFn>> | null = null;
        try {
          quota = await config.getQuotaStatus({
            workspaceId: config.workspaceId,
          });
        } catch (err) {
          // Fail open on quota — cost ceiling, not a security control.
          // BUT surface the bypass: log at error AND emit a meter row
          // tagged `quota-read-failed` so the analytics rollup shows
          // the per-message bypass count during the outage.
          log.error(
            { err: err instanceof Error ? err : new Error(String(err)) },
            "Proactive: quota callback threw — treating as under cap (monthly cap NOT enforced this request)",
          );
          await emitMeter({
            channelId,
            messageId: message.id,
            eventType: "classify",
            tokens: 0,
            actorUserId: message.author.userId ?? null,
            metadata: { skipped: "quota-read-failed" },
          });
        }
        if (quota?.readFailed) {
          // Host returned the fail-open snapshot — same observability
          // path as the catch above, no log (host already logged).
          await emitMeter({
            channelId,
            messageId: message.id,
            eventType: "classify",
            tokens: 0,
            actorUserId: message.author.userId ?? null,
            metadata: { skipped: "quota-read-failed" },
          });
        } else if (quota?.capReached) {
          log.debug(
            {
              workspaceId: config.workspaceId,
              channelId,
              classifyCountThisMonth: quota.classifyCountThisMonth,
              monthlyClassifierCap: quota.monthlyClassifierCap,
            },
            "Proactive: skipped — monthly classifier cap reached",
          );
          await emitMeter({
            channelId,
            messageId: message.id,
            eventType: "classify",
            tokens: 0,
            actorUserId: message.author.userId ?? null,
            metadata: {
              capReached: true,
              skipped: "monthly-quota",
              classifyCountThisMonth: quota.classifyCountThisMonth,
              monthlyClassifierCap: quota.monthlyClassifierCap,
            },
          });
          return;
        }
      }

      const classification = await classifyMessage({
        text,
        mode: config.workspace.classifierMode,
        llm: config.classify,
        log,
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
          // Distinguishes "silent because not a question" from "silent
          // because the LLM provider threw" so admins triaging a low
          // react rate can spot a classifier outage in the rollup.
          classifierErrored: classification.classifierErrored === true,
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

  // Helper: route a meter event through the host (slice #2297 / #2296).
  // Shared with the public-dataset refusal branch below and the linked-
  // asker happy path. Failures are swallowed because the meter is
  // observability, not control flow.
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

  // -----------------------------------------------------------------
  // Slice #2297 — unlinked-asker public dataset gate
  // -----------------------------------------------------------------
  //
  // Three branches, conservative defaults:
  //
  //   - Unlinked asker, no `getPublicDataset` wired → fall through to
  //     the #2293 link-Atlas stub. Self-hosted free deployments stay
  //     on this path because the public dataset feature is enterprise-
  //     gated at the route layer.
  //
  //   - Unlinked asker, allowlist is empty → refuse with the configured
  //     copy and emit `public_refused`. We intentionally refuse rather
  //     than falling back to the link prompt; the admin has signalled
  //     "no public data" by not curating anything yet, and the refusal
  //     event is what drives the discoverability rollup.
  //
  //   - Unlinked asker, allowlist non-empty → call
  //     `executeQueryProactive` with `atlasUserId: null` (explicit
  //     "no Atlas identity" — the type forces every host to handle
  //     the public-dataset branch deliberately). The host implementation
  //     is responsible for constraining the agent to the allowlist.
  //     Post-execution we intersect `entitiesReferenced` against the
  //     allowlist and refuse if any out-of-allowlist entity slipped
  //     through — belt-and-braces against an agent that ignores the
  //     constraint.
  if (!resolved.atlasUserId) {
    if (!config.getPublicDataset || !config.executeQueryProactive) {
      const prompt = buildUnlinkedAskerPrompt(config.linkUrl);
      await thread.post(prompt);
      log.info(
        { threadId, externalUserId: asker.externalUserId },
        "Proactive answer: posted unlinked-asker stub (no public-dataset wiring)",
      );
      return;
    }

    let allowlist: ReadonlyArray<ProactivePublicDatasetEntry> = [];
    try {
      allowlist = await config.getPublicDataset({
        workspaceId: config.workspaceId ?? "",
      });
    } catch (err) {
      // Fail closed — a registry hiccup must NOT widen the refusal
      // surface. Treat as empty allowlist; the user sees the refusal
      // copy and the admin sees a logged warning.
      log.warn(
        {
          err: err instanceof Error ? err : new Error(String(err)),
          workspaceId: config.workspaceId,
        },
        "Proactive public-dataset lookup threw — treating as empty allowlist",
      );
      allowlist = [];
    }

    if (allowlist.length === 0) {
      await postPublicRefusal(thread, config, log, asker, threadId, undefined);
      await emitMeter({
        channelId: thread.channelId,
        eventType: "public_refused",
        actorUserId: asker.externalUserId,
        metadata: {
          reason: "allowlist-empty",
          askerExternalUserId: asker.externalUserId,
        },
      });
      return;
    }

    let publicResult: ProactiveQueryResultLike;
    try {
      publicResult = await config.executeQueryProactive(text, {
        threadId,
        asker,
        // Explicit null: host implementations check for null to skip
        // RLS and constrain the agent to the workspace's public-dataset
        // allowlist. Nullable signature (vs an empty-string sentinel)
        // forces deliberate null handling on every host.
        atlasUserId: null,
      });
    } catch (err) {
      log.error(
        {
          err: err instanceof Error ? err : new Error(String(err)),
          threadId,
        },
        "Proactive executeQueryProactive threw (unlinked-asker / public-dataset path)",
      );
      await thread.post(
        "Sorry — I hit an error while answering. Try asking again or use `@atlas` directly.",
      );
      return;
    }

    const allowlistCheck = checkResultAgainstAllowlist(publicResult, allowlist, {
      allowWhenEntitiesUnknown: config.allowAnswerWhenEntitiesUnknown === true,
    });
    if (!allowlistCheck.allowed) {
      const firstRefused = allowlistCheck.refusedEntities[0];
      await postPublicRefusal(thread, config, log, asker, threadId, firstRefused);
      await emitMeter({
        channelId: thread.channelId,
        eventType: "public_refused",
        actorUserId: asker.externalUserId,
        metadata: {
          reason: allowlistCheck.reason,
          entityName: firstRefused,
          refusedEntities: allowlistCheck.refusedEntities,
          askerExternalUserId: asker.externalUserId,
        },
      });
      return;
    }

    await postProactiveAnswer(thread, log, threadId, asker, text, publicResult, recentAnswers);
    log.info(
      { threadId, externalUserId: asker.externalUserId, mode: "public-dataset" },
      "Proactive answer delivered to unlinked asker via public dataset",
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

  let result: ProactiveQueryResultLike;
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

  await postProactiveAnswer(thread, log, threadId, asker, text, result, recentAnswers);
  log.info(
    { threadId, externalUserId: asker.externalUserId, atlasUserId: resolved.atlasUserId },
    "Proactive answer delivered to linked asker",
  );
}

// ---------------------------------------------------------------------------
// Public-dataset helpers (#2297)
// ---------------------------------------------------------------------------

/**
 * Minimal contract on the executeQueryProactive return shape that the
 * listener actually consumes. Kept here rather than importing the full
 * `ProactiveQueryResult` so a host that adds new optional fields to
 * the result doesn't fan-out a type churn through the listener.
 */
type ProactiveQueryResultLike = {
  answer: string;
  followupSubscribe?: boolean;
  entitiesReferenced?: string[];
  metricsReferenced?: string[];
};

/** Discriminated allowlist verdict. */
type AllowlistCheck =
  | { allowed: true }
  | {
      allowed: false;
      /** Refusal classification tag — pinned for audit/meter `metadata.reason`. */
      reason:
        | "entitiesReferenced-missing"
        | "entity-not-in-allowlist"
        | "metric-denied";
      /** Refused entity names (may be empty when `reason === "entitiesReferenced-missing"`). */
      refusedEntities: string[];
    };

/**
 * Walk the agent's reported entity touches against the workspace
 * allowlist and return a structured verdict.
 *
 * Defaults to **fail-closed**: a result that omits `entitiesReferenced`
 * is refused with `reason: "entitiesReferenced-missing"`. The opposite
 * posture (allowing through on missing data) is the exact failure mode
 * #2297 was meant to prevent. Hosts whose agent genuinely cannot report
 * `entitiesReferenced` can opt out via
 * `ProactiveListenerConfig.allowAnswerWhenEntitiesUnknown = true` after
 * confirming a compensating control (RLS, allowlist enforcement at SQL
 * time, etc.).
 *
 * Cross-entity joins: walks every referenced entity. A query that joins
 * an allowlisted entity to a non-allowlisted entity refuses on the
 * second entity.
 */
function checkResultAgainstAllowlist(
  result: ProactiveQueryResultLike,
  allowlist: ReadonlyArray<ProactivePublicDatasetEntry>,
  opts: { allowWhenEntitiesUnknown: boolean },
): AllowlistCheck {
  const entitiesReferenced = result.entitiesReferenced;
  if (entitiesReferenced === undefined || entitiesReferenced === null) {
    if (opts.allowWhenEntitiesUnknown) return { allowed: true };
    return {
      allowed: false,
      reason: "entitiesReferenced-missing",
      refusedEntities: [],
    };
  }
  if (entitiesReferenced.length === 0) {
    // The agent ran but reported no entity touches — treat as a meta
    // answer (e.g. clarifying question) and let it through. The
    // `metricsReferenced` list is irrelevant without an entity context.
    return { allowed: true };
  }
  const metrics = result.metricsReferenced ?? [];
  const refused: string[] = [];
  let denyMetricHit = false;
  for (const entity of entitiesReferenced) {
    const entry = allowlist.find((row) => row.entityName === entity);
    if (!entry) {
      refused.push(entity);
      continue;
    }
    if (entry.denyMetrics.length > 0) {
      const hit = metrics.find((m) => entry.denyMetrics.includes(m));
      if (hit) {
        refused.push(entity);
        denyMetricHit = true;
      }
    }
  }
  if (refused.length === 0) return { allowed: true };
  return {
    allowed: false,
    reason: denyMetricHit ? "metric-denied" : "entity-not-in-allowlist",
    refusedEntities: refused,
  };
}

/**
 * Post the public-dataset refusal copy in-thread. Always pairs the
 * copy with the link-Atlas prompt (the asker's next step), so the
 * single refusal landing answers both questions: "why didn't Atlas
 * answer" and "how do I get an answer". Configurable via
 * `config.refusalCopy`.
 */
async function postPublicRefusal(
  thread: AnyThread,
  config: ProactiveListenerConfig,
  log: PluginLogger,
  asker: ProactiveAsker,
  threadId: string,
  _refusedEntity: string | undefined,
): Promise<void> {
  const copy = config.refusalCopy ?? DEFAULT_PROACTIVE_REFUSAL_COPY;
  try {
    await thread.post(copy);
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err : new Error(String(err)), threadId },
      "Proactive public-dataset refusal: failed to post copy",
    );
  }
  // Always follow up with the unlinked-asker link prompt — the HITL
  // decision pairs the refusal with the existing link button.
  try {
    const linkPrompt = buildUnlinkedAskerPrompt(config.linkUrl);
    await thread.post(linkPrompt);
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err : new Error(String(err)), threadId },
      "Proactive public-dataset refusal: failed to post link prompt",
    );
  }
  log.info(
    {
      threadId,
      externalUserId: asker.externalUserId,
      // Intentionally NOT logging the refused entity name into the
      // structured INFO line — keeps the operator log content-blind
      // even when forensic detail lands on the meter event.
    },
    "Proactive public-dataset refusal posted",
  );
}

/**
 * Shared answer-posting tail. Hoisted from the linked-asker happy
 * path so the unlinked-asker public-dataset branch reuses the exact
 * same card shape + feedback wiring + recent-answers bookkeeping.
 */
async function postProactiveAnswer(
  thread: AnyThread,
  log: PluginLogger,
  threadId: string,
  asker: ProactiveAsker,
  question: string,
  result: ProactiveQueryResultLike,
  recentAnswers: RecentAnswers,
): Promise<void> {
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
      question,
      answer: result.answer,
    });
  }

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
    } catch (err) {
      // Ack is best-effort — the feedback row was already persisted
      // above, so a missing thank-you doesn't cost data. Log at debug
      // (not warn) because a consistent ack failure is a UX bug worth
      // investigating, but doesn't degrade core feedback collection.
      log.debug(
        {
          err: err instanceof Error ? err : new Error(String(err)),
          outcome: event.outcome,
          source: event.source,
        },
        "Proactive feedback ack postEphemeral failed — feedback already recorded",
      );
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
