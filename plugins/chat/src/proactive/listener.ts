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
import type {
  Adapter,
  AdapterPostableMessage,
  Author,
  Chat,
  Message,
  ReactionEvent,
  Thread,
} from "chat";
import type { PluginLogger } from "@useatlas/plugin-sdk";
import type {
  AtlasUserId,
  ExternalUserId,
  WorkspaceId,
} from "@useatlas/types/proactive";
import { classifyMessage } from "./classifier";
import {
  detectPauseCommand,
  detectUnsubscribeDM,
  resolvePauseRequest,
} from "./pause";
import { decideInterjection } from "./policy";
import {
  PendingAnswers,
  shouldAnswerOnReaction,
  type ProactiveAsker,
  type ProactiveUserResolver,
} from "./answerer";
import {
  InvalidProactiveIdentityError,
  assertAtlasUserId,
  assertExternalUserId,
  assertThreadId,
  assertWorkspaceId,
} from "./identity";
import type {
  AnswerFlowConfig,
  ChannelProactiveConfig,
  FeedbackConfig,
  GetChannelConfigsFn,
  GetQuotaStatusFn,
  GetWorkspaceConfigFn,
  InstallGateConfig,
  InstallGateFn,
  KillSwitchConfig,
  LLMClassifierFn,
  ProactiveGateFn,
  ProactiveMeterEvent,
  ProactiveMeterEventFn,
  ProactivePublicDatasetEntry,
  RecentActivity,
  ResolveWorkspaceIdFn,
  ResolverEventLite,
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
  PROACTIVE_SHOW_DETAILS_ACTION_ID,
  PROACTIVE_SHOW_SQL_ACTION_ID,
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
  type ProactiveFeedbackEvent,
} from "./feedback";
import type { IsPausedFn } from "./pause";

// ---------------------------------------------------------------------------
// Public config
// ---------------------------------------------------------------------------

export interface ProactiveListenerConfig {
  /**
   * Per-event workspace resolution (#2620). The listener calls this
   * at the top of every event handler to figure out which tenant the
   * event belongs to. Returning `null` is a silent skip — no classify,
   * no meter row, no kill-switch read. Implementations should never
   * throw; failures should resolve as `null`.
   */
  resolveWorkspaceId: ResolveWorkspaceIdFn;
  /**
   * Gate: true when proactive mode is allowed for the given workspace
   * (enterprise + workspace flag). Per-call workspaceId (post-#2620
   * multi-tenant refactor).
   */
  isEnabled: ProactiveGateFn;
  /** LLM classifier callback. */
  classify: LLMClassifierFn;
  /**
   * Per-event workspace config fetcher (#2620). Called once per event
   * after `resolveWorkspaceId` returns non-null. Returning `null`
   * short-circuits the event (treat as not opted in).
   */
  getWorkspaceConfig: GetWorkspaceConfigFn;
  /**
   * Per-event channel-config fetcher (#2620). Returns the workspace's
   * per-channel overrides as a flat array; the listener scans linearly
   * (arrays are short in practice). Empty array = no overrides.
   */
  getChannelConfigs: GetChannelConfigsFn;

  /**
   * Per-event catalog-install predicate wiring (#2655). Discriminated
   * union — `{ enabled: false }` keeps the listener at pre-#2655
   * behaviour; `{ enabled: true, gate, catalogId }` enables the
   * outermost workspace-scoped check on every channel-message event
   * BEFORE classify, meter, quota, kill-switch, or any DB read.
   *
   * Per-event caching: the listener wraps `gate` in a Map memo at the
   * top of each event handler invocation. Mirrors the contract on
   * {@link GetWorkspaceConfigFn} — implementations should be cheap;
   * the listener still de-duplicates concurrent in-flight calls.
   */
  installGate: InstallGateConfig;

  // ---- Coupled feature groups (#2623 item 1) ------------------------------
  //
  // The three unions below replace 7 previously-optional fields whose
  // legal combinations were documented but not type-enforced. Encoding
  // them as discriminated unions makes the illegal half-wired states
  // compile-time impossible. See the JSDoc on each type in `./types.ts`
  // for the mode semantics.

  /**
   * Answer-flow wiring (#2623 item 1).
   *
   * Replaces the pre-1.5.2 optional `userResolver` + `getPublicDataset` +
   * shared-`executeQueryProactive` triple. Set to `{ mode: "off" }` when
   * the deploy doesn't run the agent on proactive events (reactions
   * still land; tap-back posts the link-Atlas stub).
   */
  answerFlow: AnswerFlowConfig;

  /**
   * Kill-switch wiring (#2295 / #2623 item 1).
   *
   * Replaces the pre-1.5.2 optional `isPaused` + `onPauseRequest` pair.
   * Set `{ enabled: false }` for tests / dev deploys without a pause
   * registry.
   */
  killSwitch: KillSwitchConfig;

  /**
   * Feedback wiring (#2298 / #2623 item 1).
   *
   * Replaces the pre-1.5.2 optional `feedbackCollector`. Set
   * `{ enabled: false }` to silently drop button / modal / slash
   * feedback. `slashCommandName` lived alongside this pair pre-1.5.2
   * but was declared-and-unread by the listener — dropped entirely in
   * favour of the bridge's top-level `slashCommandName`.
   */
  feedback: FeedbackConfig;

  // ---- Informational + independent optionals -----------------------------

  /** URL the unlinked-asker prompt deep-links to. */
  linkUrl?: string;
  /** Platform name (`"slack"` etc.) used in `ProactiveAsker`. */
  platform?: string;
  /**
   * Optional host-injected meter callback (#2296). Receives one event
   * per classify (always) and one per react (when the policy
   * interjects). Failures are swallowed inside the listener so a meter
   * outage never crashes the Chat SDK loop.
   */
  onMeterEvent?: ProactiveMeterEventFn;
  /**
   * Optional host-injected quota reader (#2301). Consulted BEFORE
   * classification so a workspace that has hit its monthly cap pays
   * only a DB read (well-indexed) per message instead of an LLM call.
   * When the cap is reached the listener emits a `classify` meter
   * event with `metadata: { capReached: true, skipped: "monthly-quota" }`
   * and skips both classification and reaction.
   *
   * Failures are swallowed (no-op + warn) so a quota outage never
   * silences Atlas — the agent fails open just like the pause registry.
   */
  getQuotaStatus?: GetQuotaStatusFn;
  /**
   * Override the default refusal copy posted when an unlinked asker's
   * question touches an entity that isn't on the public dataset
   * (consulted only when `answerFlow.mode` includes the public-dataset
   * path). Defaults to `DEFAULT_PROACTIVE_REFUSAL_COPY`.
   */
  refusalCopy?: string;
  /**
   * Opt-out for hosts whose `executeQueryProactive` cannot report
   * `entitiesReferenced` on the result (consulted only when
   * `answerFlow.mode` includes the public-dataset path). When `false`
   * (the safe default), a result without `entitiesReferenced` is
   * treated as "unknown entities" and refused (`public_refused`
   * emitted with `reason: "entitiesReferenced-missing"`). Setting
   * `true` lets such a result through — only enable when the host has
   * another compensating control (e.g. RLS, a wrapper that enforces
   * the allowlist at SQL time). Logs at warn on startup so the bypass
   * is visible in boot logs.
   */
  allowAnswerWhenEntitiesUnknown?: boolean;
}

/**
 * Reaction emoji used when policy decides to interject. `robot_face`
 * isn't in the SDK well-known emoji map, so we use the `custom()`
 * escape hatch and let each adapter resolve to its native shortcode.
 */
export const PROACTIVE_REACTION = emoji.custom("robot_face");

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Adapter platform name, when the SDK exposes it. */
function adapterPlatform(adapter: { name?: string } | undefined, fallback?: string): string {
  return adapter?.name ?? fallback ?? "unknown";
}

/**
 * Build a ProactiveAsker from a message author. Brands the
 * `externalUserId` at this boundary (#2641) — the asker object is the
 * one runtime shape that flows from the chat SDK into every
 * proactive entry point (resolver, executeQueryProactive, pause-request,
 * feedback). Promoting once here means the downstream code can read
 * `asker.externalUserId` as a typed {@link ExternalUserId} without
 * each consumer re-validating.
 *
 * Returns `null` when the platform-side user id is missing — the
 * caller treats that as "no asker, skip the proactive flow" because
 * we can't attribute the reaction / answer to anyone. Pre-#2641 we
 * would build an asker with an empty `externalUserId` and propagate
 * it through audit + meter rows.
 */
function askerFromAuthor(author: Author, platform: string): ProactiveAsker | null {
  try {
    const externalUserId = assertExternalUserId(author.userId);
    return {
      platform,
      externalUserId,
      userName: author.userName,
    };
  } catch (err) {
    if (err instanceof InvalidProactiveIdentityError) return null;
    throw err;
  }
}

/**
 * Route a meter event through the host meter callback (slice #2296 /
 * #2297). Failures are swallowed because the meter is observability,
 * not control flow — a meter outage must never propagate into the SDK
 * event loop.
 *
 * Single source of truth for proactive meter emission. Both the
 * registration closure (`registerProactiveListener`) and the per-flow
 * helper (`runAnswerFlow`) used to define identical inline closures
 * over `config` / `log` / `workspaceId`; consolidating into one
 * free function eliminates the drift risk.
 */
async function emitProactiveMeter(
  config: ProactiveListenerConfig,
  log: PluginLogger,
  workspaceId: WorkspaceId,
  partial: Omit<ProactiveMeterEvent, "workspaceId">,
): Promise<void> {
  if (!config.onMeterEvent) return;
  try {
    await config.onMeterEvent({ workspaceId, ...partial });
  } catch (err) {
    log.warn(
      {
        err: err instanceof Error ? err : new Error(String(err)),
        eventType: partial.eventType,
      },
      "Proactive meter callback threw — suppressed",
    );
  }
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
  // Registration-time gate. Probe with empty string — the host's
  // `isEnabled` short-circuits on `""` and answers only the enterprise
  // check (skipping the workspace SELECT, which would otherwise resolve
  // `false` on a row-missing lookup with `$1 = ''`). If EE isn't loaded,
  // registration short-circuits to the no-op handle below. Real
  // per-event calls pass actual workspaceIds.
  //
  // Single-attempt by design. The host gate's transient-retry contract
  // (`enabled-gate.ts` — "leave `enterpriseEnabled` undefined so the next
  // call retries") only fires when a per-event call follows. On the
  // falsy branch we return a no-op handle without registering any
  // event hooks, so no later call exists to exercise the retry — a
  // boot-time runtime defect wedges proactive for the process lifetime.
  // Accepted because proactive is best-effort (the rest of the bridge
  // stays up). If SaaS dogfood surfaces a registration regression, wrap
  // this in exponential-backoff retry.
  const enabledAtRegistration = await config.isEnabled("");
  if (!enabledAtRegistration) {
    log.debug("Proactive listener not registered — gate is closed");
    return { recentAnswers: null };
  }

  log.info(
    {
      killSwitch: config.killSwitch.enabled,
      answerFlow: config.answerFlow.mode,
      feedback: config.feedback.enabled,
    },
    "Proactive listener registered",
  );
  if (config.allowAnswerWhenEntitiesUnknown) {
    log.warn(
      {},
      "Proactive: allowAnswerWhenEntitiesUnknown=true — unlinked-asker results without entitiesReferenced will be allowed through. Public-dataset allowlist is NOT enforced for these results; the host must provide a compensating control.",
    );
  }

  // Per-channel last-interjection timestamps for rate limiting. In-memory
  // is fine for slices #2292–#2293 — #2296 layered in a durable meter
  // row but kept the cooldown gate cheap and local; cross-host cooldown
  // could ride the same `proactive_meter_events` table in a later slice.
  //
  // Post-#2620: keyed by `${workspaceId}:${channelId}` so two tenants
  // that share a channel id (different Slack workspaces both have a
  // "C-general") don't share a cooldown row.
  const recent = new Map<string, RecentActivity>();
  // Pending answers awaiting a reaction-back or button-click.
  const pending = new PendingAnswers();
  // Most-recent Atlas answer per (channelId, externalUserId) for the
  // slice #2298 `/atlas feedback <text>` fallback path.
  const recentAnswers = new RecentAnswers();
  // Per-answer SQL / developer-view payload for the #2705 "Show SQL" /
  // "Show details" disclosure buttons.
  const disclosures = new ProactiveDisclosureStore();

  // Local alias for the module-scope `emitProactiveMeter` helper —
  // pre-applies `config` + `log` so call sites stay terse and the
  // per-event `workspaceId` stays explicit.
  const emitMeter = (
    workspaceId: WorkspaceId,
    partial: Omit<ProactiveMeterEvent, "workspaceId">,
  ): Promise<void> => emitProactiveMeter(config, log, workspaceId, partial);

  // Per-event workspace resolution helper. Wraps `config.resolveWorkspaceId`
  // with a defensive try/catch so a host implementation that throws (the
  // contract is "never throw, resolve as null") still degrades to a
  // silent skip instead of crashing the SDK loop.
  //
  // `thread` is typed loosely (`Thread<unknown, unknown> | undefined`)
  // because the listener takes events from `onNewMessage`, `onReaction`,
  // `onAction`, and `onModalSubmit` — each surfaces a thread with a
  // different generic parameter (or none at all for the bridge's slash
  // synthesis path). The `thread` field is part of the resolver
  // contract so platforms that need it (Teams `channelData`, etc.) can
  // opt in without a signature change. The Slack resolver — the only
  // one wired today — does not read it.
  //
  // `message` is the narrowed {@link ResolverEventLite} shape (#2623
  // item 2) so action / modal call sites can pass `{ id, raw }`
  // directly. Real `Message` instances also satisfy the shape because
  // `ResolverEventLite` is `Pick<Message, "id" | "raw">`.
  const safeResolveWorkspace = async (
    adapter: Adapter,
    thread: Thread<unknown, unknown> | undefined,
    message: ResolverEventLite,
  ): Promise<WorkspaceId | null> => {
    let raw: string | null;
    try {
      raw = await config.resolveWorkspaceId({
        adapter,
        // Generic widening: `safeResolveWorkspace`'s `thread` parameter
        // is `Thread<unknown, unknown> | undefined` (callers erase the
        // generics so one wrapper can serve every event surface).
        // `ResolverEvent.thread` defaults the generics to `Record<string,
        // unknown>` for `TState`, which is invariant — hence the cast.
        thread: thread as Thread | undefined,
        message,
      });
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err : new Error(String(err)) },
        "Proactive resolveWorkspaceId threw — treating as unknown tenant (skip)",
      );
      return null;
    }
    if (raw === null) return null;
    // Brand promotion (#2641). The host's `resolveWorkspaceId`
    // contract returns `string | null`; promote to `WorkspaceId` at
    // the boundary so every downstream call site reads a typed brand.
    // Empty string falls back to "unknown tenant" — would otherwise
    // silently collapse every asker onto the global path.
    try {
      return assertWorkspaceId(raw);
    } catch (err) {
      if (err instanceof InvalidProactiveIdentityError) {
        // Log at error, not warn — the host's `resolveWorkspaceId`
        // contract is "return null OR a non-empty string". An empty /
        // whitespace-only string is a host wiring bug that would
        // persistently fire every event for the misconfigured tenant.
        // Warn-level would hide the bug behind hundreds of identical
        // lines (#2628 history); error escalates it to on-call.
        log.error(
          { rawWorkspaceId: raw, field: err.field },
          "Proactive resolveWorkspaceId returned an empty/invalid id — contract violation, treating as unknown tenant (skip)",
        );
        return null;
      }
      throw err;
    }
  };

  // Safe wrappers for the per-event workspace/channel config loaders.
  // Failures resolve to null/empty (the listener falls back to "not
  // opted in" / "no overrides" without crashing the SDK loop).
  const safeGetWorkspaceConfig = async (
    workspaceId: WorkspaceId,
  ): Promise<WorkspaceProactiveConfig | null> => {
    try {
      return await config.getWorkspaceConfig(workspaceId);
    } catch (err) {
      log.warn(
        {
          err: err instanceof Error ? err : new Error(String(err)),
          workspaceId,
        },
        "Proactive getWorkspaceConfig threw — treating as not opted in",
      );
      return null;
    }
  };

  // Build a per-event memo around `config.installGate` (#2655). The
  // returned function keeps a tiny `Map<workspaceId, Promise<boolean>>`
  // closed over so a second call within the same event handler
  // invocation returns the same verdict from ONE underlying host call.
  // De-duplicates concurrent in-flight calls too (caching the Promise,
  // not the resolved value). Wraps the host callback's `catalogId`
  // upfront so call sites stay terse — the gate is keyed on workspace
  // for the lifetime of one event (the catalog id is constant across
  // the wiring lifetime).
  //
  // Defensive try/catch on the host call: the {@link InstallGateFn}
  // contract is "never throw, resolve as false". Wrapping here matches
  // the safe-fetcher posture of `safeGetWorkspaceConfig` /
  // `safeGetChannelConfigs` above so a host wiring bug never crashes
  // the SDK event loop.
  const installGateCacheForEvent = (
    gate: InstallGateFn,
    catalogId: string,
  ): ((workspaceId: WorkspaceId) => Promise<boolean>) => {
    const cache = new Map<string, Promise<boolean>>();
    return (workspaceId) => {
      const cached = cache.get(workspaceId);
      if (cached !== undefined) return cached;
      const pending = (async () => {
        try {
          return await gate(workspaceId, catalogId);
        } catch (err) {
          log.warn(
            {
              err: err instanceof Error ? err : new Error(String(err)),
              workspaceId,
              catalogId,
            },
            "Proactive installGate threw — treating as closed (silent skip)",
          );
          return false;
        }
      })();
      cache.set(workspaceId, pending);
      return pending;
    };
  };

  const safeGetChannelConfigs = async (
    workspaceId: WorkspaceId,
  ): Promise<ReadonlyArray<ChannelProactiveConfig>> => {
    try {
      return await config.getChannelConfigs(workspaceId);
    } catch (err) {
      log.warn(
        {
          err: err instanceof Error ? err : new Error(String(err)),
          workspaceId,
        },
        "Proactive getChannelConfigs threw — treating as no overrides",
      );
      return [];
    }
  };

  // -------------------------------------------------------------------------
  // Channel-message + DM hook: classify + react + record asker for later
  // answer.
  //
  // Registered against BOTH `chat.onNewMessage(/.+/, ...)` AND
  // `chat.onDirectMessage(...)`. The chat SDK's `dispatchToHandlers`
  // sends DMs to `directMessageHandlers` and returns; mention handlers
  // and `onNewMessage` patterns only run for non-DM events (or for
  // DMs when no DM handler is registered, the pre-#2638 fallback that
  // marked DMs as mentions). Without the DM registration the
  // `unsubscribe` branch below was unreachable in production (#2638).
  //
  // DMs short-circuit after the unsubscribe check. The bridge owns
  // the chat-with-bot DM path on a parallel `onDirectMessage`
  // registration; the SDK iterates every DM handler before returning,
  // so the two handlers run independently.
  const handleProactiveMessage = async (
    thread: Thread,
    message: Message,
  ): Promise<void> => {
    try {
      if (message.author.isBot === true || message.author.isMe) return;
      const text = message.text?.trim() ?? "";
      if (text.length === 0) return;

      const isDM = thread.isDM === true;

      // DM short-circuit. The proactive listener only cares about DMs
      // that match the `unsubscribe` command; chat-with-bot DMs flow
      // through the bridge's `onDirectMessage` registration. Skip
      // every other DM cheaply (no `resolveWorkspaceId`, no
      // `isEnabled`, no DB reads) — a chat-with-bot DM otherwise pays
      // two host calls per message just to land at the `if (isDM)
      // return;` below.
      if (isDM && !detectUnsubscribeDM(text)) return;

      // ---------------------------------------------------------------
      // Per-event workspace resolution (#2620) — first DB / host call
      // we make. Runs before classify, meter, or kill-switch reads.
      // (Bot/`isMe`/empty-text and DM-not-unsubscribe skips above run
      // cheaper and earlier.) Unknown tenant → silent skip, no meter
      // event, no DB reads.
      // ---------------------------------------------------------------
      const workspaceId = await safeResolveWorkspace(
        thread.adapter,
        thread,
        message,
      );
      if (!workspaceId) return;

      // ---------------------------------------------------------------
      // WorkspaceInstallGate (#2655) — OUTERMOST workspace-scoped check.
      // Runs BEFORE `isEnabled`, classify, meter, quota, kill-switch.
      // Absent / disabled install → silent skip with a debug log so
      // operators can confirm "gate said no" during dogfood.
      //
      // Per-event cache mirrors the `safeGetWorkspaceConfig` contract:
      // one fresh `Map` per `handleProactiveMessage` invocation, so an
      // admin toggling the workspace install off takes effect on the
      // very next event (no cross-event leak).
      // ---------------------------------------------------------------
      if (config.installGate.enabled === true) {
        const cachedGate = installGateCacheForEvent(
          config.installGate.gate,
          config.installGate.catalogId,
        );
        const active = await cachedGate(workspaceId);
        if (!active) {
          log.debug(
            {
              workspaceId,
              catalogId: config.installGate.catalogId,
              channelId: thread.channelId,
            },
            "Proactive: install gate closed — skipping (no classify, no meter, no DB write)",
          );
          return;
        }
      }

      if (!(await config.isEnabled(workspaceId))) return;

      const channelId = thread.channelId;
      const userId = message.author.userId;
      // Workspace-scoped cooldown key — two tenants that share a channel
      // id (e.g. both have a "C-general") must not share cooldown state.
      const cooldownKey = `${workspaceId}:${channelId}`;

      // ---------------------------------------------------------------
      // Pause-command intake (#2295) — runs BEFORE classification so
      // a mute message never costs an LLM call.
      // ---------------------------------------------------------------

      // DM `unsubscribe` → workspace-wide user-optout row. The early
      // skip above guarantees we only reach this with an unsubscribe
      // DM, so it's an unconditional handler for the DM path. The rest
      // of the function is channel-only.
      if (isDM) {
        if (config.killSwitch.enabled) {
          try {
            await config.killSwitch.onPauseRequest(
              resolvePauseRequest("dm-unsubscribe", {
                workspaceId,
                channelId,
                userId,
              }),
            );
            log.info(
              { workspaceId, userId },
              "Proactive: user opted out via DM unsubscribe",
            );
          } catch (err) {
            log.warn(
              { err: err instanceof Error ? err : new Error(String(err)) },
              "Proactive: DM unsubscribe write failed — user still listed in proactive",
            );
          }
        } else {
          log.debug(
            { workspaceId, userId },
            "Proactive: DM unsubscribe received but kill switch disabled — discarding",
          );
        }
        return;
      }

      // In-channel `@atlas pause` → 24h channel-scoped pause.
      if (config.killSwitch.enabled && detectPauseCommand(text)) {
        try {
          await config.killSwitch.onPauseRequest(
            resolvePauseRequest("channel-pause-command", {
              workspaceId,
              channelId,
              userId,
            }),
          );
          log.info(
            { workspaceId, channelId, userId },
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
      if (config.killSwitch.enabled) {
        let pause: Awaited<ReturnType<IsPausedFn>>;
        try {
          pause = await config.killSwitch.isPaused({
            workspaceId,
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
              workspaceId,
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

      // ---------------------------------------------------------------
      // Per-event workspace/channel config (#2620). Loaded after the
      // pause check passes so a paused workspace pays zero config-read
      // cost. Both calls are independent; run them in parallel.
      // ---------------------------------------------------------------
      const [workspaceConfig, channelConfigs] = await Promise.all([
        safeGetWorkspaceConfig(workspaceId),
        safeGetChannelConfigs(workspaceId),
      ]);
      if (!workspaceConfig) {
        // No config row → workspace hasn't opted in. Silent skip; the
        // `isEnabled` gate already returned true (e.g. enterprise on),
        // but the per-workspace toggle isn't set. Pre-#2620 this state
        // never happened because the config was baked at registration;
        // multi-tenant resolution means we discover it per event.
        log.debug(
          { workspaceId },
          "Proactive: workspace has no config — skipping",
        );
        return;
      }

      // Post-#2620: the per-event `getChannelConfigs` fetcher is the
      // sole source of truth for which channels are opted in. No row =
      // not opted in. A row with `allow: true` opts in; `allow: false`
      // is an explicit deny.
      const channelConfig = channelConfigs.find(
        (cfg) => cfg.channelId === channelId,
      );
      const channelAllowed = channelConfig?.allow === true;

      // ---------------------------------------------------------------
      // Monthly quota cap (#2301) — short-circuit BEFORE the classifier
      // when the workspace has used its allotted classifies for the
      // current calendar month. Records a `classify` meter row with
      // `capReached: true` so the admin analytics + audit trail show
      // "we saw a question and chose to skip it because of the cap"
      // instead of a silent gap. No reaction, no offer card.
      // ---------------------------------------------------------------
      // Quota read state — folded into the single post-classification
      // meter row below rather than emitted as a separate bypass row.
      // The earlier two-row pattern double-counted every message during
      // a quota outage (the cap monitors `event_type = 'classify'` rows
      // without distinguishing skip-tagged ones), defeating the very
      // cost-ceiling contract the bypass tag was meant to surface.
      let quotaReadFailed = false;
      if (config.getQuotaStatus) {
        let quota: Awaited<ReturnType<GetQuotaStatusFn>> | null = null;
        try {
          quota = await config.getQuotaStatus({
            workspaceId,
          });
        } catch (err) {
          // Fail open on quota — cost ceiling, not a security control.
          // Bypass is recorded on the post-classification meter row via
          // `metadata.quotaReadFailed: true`, so an admin filter on
          // `metadata-->>'quotaReadFailed' = 'true'` surfaces every
          // bypass without double-counting the underlying `classify`
          // event.
          log.error(
            {
              workspaceId,
              channelId,
              err: err instanceof Error ? err : new Error(String(err)),
            },
            "Proactive: quota callback threw — treating as under cap (monthly cap NOT enforced this request)",
          );
          quotaReadFailed = true;
        }
        if (quota?.readFailed) {
          // Host returned the fail-open snapshot — same observability
          // path as the catch above. Host already logged at error.
          quotaReadFailed = true;
        } else if (quota?.capReached) {
          log.debug(
            {
              workspaceId,
              channelId,
              classifyCountThisMonth: quota.classifyCountThisMonth,
              monthlyClassifierCap: quota.monthlyClassifierCap,
            },
            "Proactive: skipped — monthly classifier cap reached",
          );
          await emitMeter(workspaceId, {
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
        mode: workspaceConfig.classifierMode,
        llm: config.classify,
        log,
      });

      const decision = decideInterjection({
        classification,
        workspace: workspaceConfig,
        channel: channelConfig,
        channelAllowed,
        recentActivity: recent.get(cooldownKey),
      });

      log.debug(
        {
          workspaceId,
          channelId,
          messageId: message.id,
          isQuestion: classification.isQuestion,
          confidence: classification.confidence,
          action: decision.action,
          reason: decision.reason,
        },
        "Proactive classification decision",
      );

      // Meter: every classify call lands ONE row. Tokens populated
      // when the LLM actually ran; `0` on a regex-prefilter rejection
      // so the billing aggregator can split prefilter-rejected from
      // LLM-invoked calls without re-scanning metadata. `quotaReadFailed`
      // surfaces the per-message bypass without double-counting the
      // classify event.
      await emitMeter(workspaceId, {
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
          // Per-message quota-bypass marker. True only when the cap
          // would NOT have been enforced this request (host throw or
          // host-side fail-open snapshot). Admin analytics filters on
          // this to surface outage-driven bypass counts.
          quotaReadFailed,
          action: decision.action,
          reason: decision.reason,
        },
      });

      if (decision.action !== "react") return;

      const sent = thread.createSentMessageFromMessage(message);
      await sent.addReaction(PROACTIVE_REACTION);
      recent.set(cooldownKey, { lastInterjectionAt: Date.now() });

      const platform = adapterPlatform(thread.adapter, config.platform);
      const asker = askerFromAuthor(message.author, platform);
      if (!asker) {
        // Orphan state: reaction already posted (line above), but no
        // pending entry registered — the asker can never tap-back to
        // request the answer. Warn so on-call sees the asymmetry; a
        // missing `message.author.userId` is a chat-adapter contract
        // violation, not a routine event.
        log.warn(
          { workspaceId, channelId, messageId: message.id },
          "Proactive: message.author.userId missing — reaction posted but cannot attribute pending answer (orphan reaction)",
        );
        return;
      }
      // Pending lookup key is the chat-adapter's encoded thread id
      // (#2680). The corresponding `pending.peek` on the reaction-back
      // side reads `event.threadId`, also the encoded form — passing
      // `thread.channelId` (bare `"slack:CHANNEL"`) here would key
      // pending under a value the reaction handler could never produce,
      // silently breaking the answer flow.
      pending.record(assertThreadId(thread.id), message.id, { text, asker, workspaceId });

      // Meter: reaction landed — emit a `react` row so the admin
      // analytics panel and the eventual billing aggregator have a
      // clean "how often did the policy actually fire?" count without
      // scanning every classify row.
      await emitMeter(workspaceId, {
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
  };

  chat.onNewMessage(/.+/, handleProactiveMessage);
  // The DM-handler signature accepts a `channel` + `context` the
  // listener doesn't read — wrapping rather than passing
  // `handleProactiveMessage` directly keeps the contract narrow.
  chat.onDirectMessage(async (thread: Thread, message: Message) => {
    await handleProactiveMessage(thread, message);
  });

  // -------------------------------------------------------------------------
  // Reaction-back hook: trigger the answer flow
  // -------------------------------------------------------------------------
  chat.onReaction([PROACTIVE_REACTION], async (event: ReactionEvent) => {
    try {
      // The pending entry carries `workspaceId` from the original
      // channel-message handler. If there's no pending entry the
      // reaction is on an unknown message — short-circuit before any
      // gate or DB read. If there IS a pending entry, the workspace was
      // already known-good at react-time; we just re-check the gate
      // (license / kill-switch flip while the asker paused).
      const reactionThreadId = assertThreadId(event.threadId);
      const lookup = pending.peek(reactionThreadId, event.messageId);
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
      const workspaceId = decision.pending.workspaceId;
      if (!(await config.isEnabled(workspaceId))) return;
      // Consume now so a second reactor doesn't double-fire.
      pending.consume(reactionThreadId, event.messageId);
      await runAnswerFlow(
        event.thread,
        event.threadId,
        // Asker's message id — the reaction-back lands on the asker's
        // original question, so `event.messageId` IS the asker's
        // message id. Used by `postProactiveReply` to synthesize an
        // in-thread reply target when the chat-sdk produces a
        // bare-channel thread.id (#2704).
        event.messageId,
        decision.pending.text,
        decision.pending.asker,
        workspaceId,
        config,
        log,
        recentAnswers,
        disclosures,
      );
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
      // Thread is null for view-based actions (e.g. home-tab buttons),
      // which the proactive offer card never reaches.
      if (!event.thread) return;
      // `event.value` is the original message ID the offer card was
      // built against.
      const originalMessageId = typeof event.value === "string" ? event.value : "";
      const actionThreadId = assertThreadId(event.threadId);
      const lookup = pending.consume(actionThreadId, originalMessageId);
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
      const workspaceId = lookup.workspaceId;
      if (!(await config.isEnabled(workspaceId))) return;
      await runAnswerFlow(
        event.thread,
        event.threadId,
        // Asker's message id — the offer card's button `value` carries
        // the original messageId the card was built for. Used by
        // `postProactiveReply` to thread the answer under the asker's
        // question (#2704).
        originalMessageId,
        lookup.text,
        lookup.asker,
        workspaceId,
        config,
        log,
        recentAnswers,
        disclosures,
      );
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
      pending.consume(assertThreadId(event.threadId), originalMessageId);
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
  // Progressive disclosure buttons (#2705)
  //
  // The conversational answer card includes "Show SQL" / "Show details"
  // buttons. The handlers below look the disclosure payload up by the
  // answer-card message id (which IS `event.messageId` — Slack returns
  // the message the button lives on) and post the expanded content as
  // an in-thread reply under the asker's original question.
  //
  // Both handlers route through `postProactiveReply` so the disclosure
  // post threads correctly off the asker's question (#2704), matching
  // the answer-card placement.
  // -------------------------------------------------------------------------
  chat.onAction(
    [PROACTIVE_SHOW_SQL_ACTION_ID, PROACTIVE_SHOW_DETAILS_ACTION_ID],
    async (event) => {
      try {
        if (!event.thread) return;
        // The answer card carries the answer message id as `event.messageId`
        // (Slack populates this with the message the action lives on).
        // The disclosure payload was recorded under that id at answer
        // post time, so a direct lookup works without round-tripping
        // through `event.value`.
        const answerMessageId = event.messageId;
        const payload = disclosures.lookup(answerMessageId);
        if (!payload) {
          log.debug(
            {
              actionId: event.actionId,
              threadId: event.threadId,
              answerMessageId,
            },
            "Proactive disclosure clicked but no payload — likely expired (>24h) or pre-#2705 answer",
          );
          return;
        }

        let content: string;
        if (event.actionId === PROACTIVE_SHOW_SQL_ACTION_ID) {
          if (payload.sql.length === 0) {
            log.debug(
              { answerMessageId },
              "Proactive Show SQL clicked but payload carries no SQL — skipping",
            );
            return;
          }
          // Slack code fences render `sql` syntax-highlighting when the
          // info string is set. Multiple queries are concatenated with
          // a blank line between them; the agent typically issues 1-2.
          content = payload.sql
            .map((q) => "```sql\n" + q.trim() + "\n```")
            .join("\n\n");
        } else {
          // PROACTIVE_SHOW_DETAILS_ACTION_ID
          if (payload.developerView.trim().length === 0) {
            log.debug(
              { answerMessageId },
              "Proactive Show details clicked but payload carries no developer view — skipping",
            );
            return;
          }
          content = payload.developerView;
        }

        await postProactiveReply(event.thread, payload.askerMessageId, content);
        log.info(
          {
            actionId: event.actionId,
            threadId: event.threadId,
            answerMessageId,
          },
          "Proactive disclosure posted in-thread",
        );
      } catch (err) {
        log.warn(
          {
            err: err instanceof Error ? err : new Error(String(err)),
            actionId: event.actionId,
          },
          "Proactive disclosure handler threw — suppressed",
        );
      }
    },
  );

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
        const outcome = outcomeForActionId(event.actionId);
        if (!outcome) return;

        // Resolve the tenant from the event's thread (the feedback
        // button is clicked on the answer card, which lives in the
        // same thread as the original question). Unknown tenant →
        // silent skip.
        if (!event.thread) return;
        const workspaceId = await safeResolveWorkspace(
          event.adapter,
          event.thread,
          // The action event doesn't carry the full Message that
          // triggered the answer; pass a lite shape with the adapter-
          // supplied messageId. The resolver's narrowed `ResolverEventLite`
          // contract (#2623 item 2) is "only reads `adapter.name` +
          // `message.raw`", so the lite shape satisfies the type
          // directly — no `as unknown` cast needed.
          { id: event.messageId, raw: event.raw },
        );
        if (!workspaceId) return;
        if (!(await config.isEnabled(workspaceId))) return;

        const platform = adapterPlatform(event.adapter, config.platform);
        const asker = askerFromAuthor(event.user, platform);
        if (!asker) {
          // User clicked Helpful / Not-helpful / Wrong-data but the
          // event carries no `event.user.userId` — feedback row is
          // dropped silently. Warn (not debug) so on-call notices a
          // chat-adapter contract violation that's eating feedback.
          log.warn(
            { workspaceId, actionId: event.actionId },
            "Proactive feedback button: event.user.userId missing — feedback dropped (cannot attribute row)",
          );
          return;
        }
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
      // Multi-tenant (#2620): resolve workspace from `relatedThread`
      // when present (the modal was opened from the answer-card action
      // button, which carries the thread context). When not present we
      // can't safely attribute the feedback row — close the modal
      // silently rather than write to the wrong tenant.
      const relatedThread = event.relatedThread;
      if (!relatedThread) {
        log.debug(
          {},
          "Proactive wrong-data modal submit: no related thread — cannot resolve tenant, dropping",
        );
        return { action: "close" as const };
      }
      const workspaceId = await safeResolveWorkspace(
        event.adapter,
        relatedThread,
        // Modal events don't surface the original message; pass a
        // lite shape — the resolver's `ResolverEventLite` contract
        // (#2623 item 2) only reads `adapter.name` + `message.raw`,
        // so the lite shape satisfies the type directly without a
        // cast.
        { id: "", raw: event.raw },
      );
      if (!workspaceId) return { action: "close" as const };
      if (!(await config.isEnabled(workspaceId))) {
        return { action: "close" as const };
      }

      const platform = adapterPlatform(event.adapter, config.platform);
      const asker = askerFromAuthor(event.user, platform);
      if (!asker) {
        log.debug(
          { workspaceId },
          "Proactive wrong-data modal: event.user.userId missing — cannot attribute feedback, closing",
        );
        return { action: "close" as const };
      }
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
 *
 * Post-#2620 multi-tenant: the bridge calls `config.resolveWorkspaceId`
 * with a synthetic Message (id `""`, `raw` from the slash event) before
 * invoking this helper, because slash events don't surface a Thread or
 * Message the way `onNewMessage` does. The Slack resolver only reads
 * `adapter.name` + `message.raw.team_id`, so the synthetic shape
 * resolves correctly.
 */
export async function handleProactiveFeedbackSlash(args: {
  text: string | undefined;
  channelId: string;
  workspaceId: WorkspaceId;
  asker: ProactiveAsker;
  config: ProactiveListenerConfig;
  log: PluginLogger;
  recentAnswers: RecentAnswers;
}): Promise<boolean> {
  const { text, channelId, workspaceId, asker, config, log, recentAnswers } = args;
  if (!config.feedback.enabled) return false;
  const parsed = parseFeedbackSlashArgs(text);
  if (parsed.kind !== "feedback") return false;

  if (!(await config.isEnabled(workspaceId))) return false;

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

/**
 * Compute the threadId to post a proactive reply against (#2704).
 *
 * Chat-sdk encoded threadId convention: `${platform}:${channel}:${threadTs}`.
 * For Slack the trailing `threadTs` is the parent thread's ts when the
 * asker's message is itself a thread reply, OR the message's own ts
 * when the asker's message is top-level — both cases produce the right
 * thread parent for in-thread replies.
 *
 * Happy path: `thread.id` already encodes a non-empty trailing segment;
 * we use it as-is so an asker who fired proactive from inside an
 * existing thread keeps the reply in THAT thread (not a sub-thread off
 * their reply, which Slack doesn't support anyway).
 *
 * Defensive fallback: some chat-sdk event paths surfaced a `thread.id`
 * with an empty trailing segment during dogfood (#2704), which decoded
 * to `thread_ts=""` and posted the reply at channel level. When that
 * shape lands we synthesize a threadId from `thread.channelId` plus the
 * asker's messageId so the reply still threads under the asker's
 * question rather than spamming the channel.
 */
function computeReplyThreadId(thread: AnyThread, askerMessageId: string): string {
  const threadId = thread.id;
  const parts = threadId.split(":");
  const trailing = parts.length > 0 ? parts[parts.length - 1] : "";
  if (parts.length >= 3 && typeof trailing === "string" && trailing.length > 0) {
    return threadId;
  }
  return `${thread.channelId}:${askerMessageId}`;
}

/**
 * Post a proactive reply in-thread under the asker's original message
 * (#2704). Calls the adapter's `postMessage` directly with an explicit
 * reply threadId so the threading parent is unambiguous at the call
 * site — `thread.post(...)` was landing at channel level in production
 * (dogfood signal in #sandbox-atlas) when the chat-sdk's event-derived
 * Thread happened to carry an empty `thread_ts` portion.
 *
 * Mirrors the result shape `thread.post` returns (`{ id }`) so call
 * sites that capture the posted message id (the answer-card path)
 * don't need to know about the swap.
 */
async function postProactiveReply(
  thread: AnyThread,
  askerMessageId: string,
  content: AdapterPostableMessage,
): Promise<{ id: string }> {
  const replyThreadId = computeReplyThreadId(thread, askerMessageId);
  const raw = await thread.adapter.postMessage(replyThreadId, content);
  return { id: raw.id };
}

async function runAnswerFlow(
  thread: AnyThread,
  threadId: string,
  askerMessageId: string,
  text: string,
  asker: ProactiveAsker,
  workspaceId: WorkspaceId,
  config: ProactiveListenerConfig,
  log: PluginLogger,
  recentAnswers: RecentAnswers,
  disclosures: ProactiveDisclosureStore,
): Promise<void> {
  const flow = config.answerFlow;

  // `mode === "off"` and `mode === "public-only"` carry no `userResolver`,
  // so the asker is treated as unlinked without ever calling the resolver.
  // `linked-only` / `both` carry one — `safeResolveUser` produces the
  // three-state `ResolveOutcome` ("linked" / "unlinked" / "errored").
  const resolverFn =
    flow.mode === "linked-only" || flow.mode === "both"
      ? flow.userResolver
      : undefined;
  const resolved: ResolveOutcome = resolverFn
    ? await safeResolveUser(resolverFn, asker, workspaceId, log)
    : { kind: "unlinked" };

  // Resolver THREW → post the apology copy and return. Critical
  // posture: do NOT downgrade to the public-dataset path because the
  // asker may be a fully linked Atlas user whose per-user RLS scope
  // would silently be replaced with the workspace's public allowlist.
  // The user would see a "normal" answer with no signal that their
  // identity wasn't enforced.
  if (resolved.kind === "errored") {
    try {
      await postProactiveReply(
        thread,
        askerMessageId,
        "Sorry — I hit an error while answering. Try asking again or use `@atlas` directly.",
      );
    } catch (err) {
      log.warn(
        {
          err: err instanceof Error ? err : new Error(String(err)),
          threadId,
        },
        "Proactive answer: apology post after resolver throw also failed",
      );
    }
    return;
  }

  // Local alias for the module-scope `emitProactiveMeter` helper —
  // pre-applies `config` / `log` / `workspaceId` (the latter is the
  // per-flow tenant resolved at the caller; was `config.workspaceId ?? ""`
  // pre-#2620, now a typed {@link WorkspaceId} brand per #2641). Shared
  // by the public-dataset refusal branch and the linked-asker happy
  // path below.
  const emitMeter = (
    partial: Omit<ProactiveMeterEvent, "workspaceId">,
  ): Promise<void> => emitProactiveMeter(config, log, workspaceId, partial);

  // -----------------------------------------------------------------
  // Slice #2297 — unlinked-asker public dataset gate
  // -----------------------------------------------------------------
  //
  // Discriminator (#2623 item 1) makes the three branches explicit:
  //
  //   - `answerFlow.mode === "off"` or `"linked-only"` → no
  //     `getPublicDataset` available → post the #2293 link-Atlas stub.
  //     Self-hosted free deployments default here (the public dataset
  //     feature is enterprise-gated at the route layer).
  //
  //   - `"public-only"` / `"both"` with an empty allowlist → refuse
  //     with the configured copy and emit `public_refused`. We
  //     intentionally refuse rather than falling back to the link
  //     prompt; the admin has signalled "no public data" by not
  //     curating anything yet, and the refusal event drives the
  //     discoverability rollup.
  //
  //   - `"public-only"` / `"both"` with a non-empty allowlist → call
  //     `executeQueryProactive` with `atlasUserId: null` (explicit
  //     "no Atlas identity" — the type forces every host to handle
  //     the public-dataset branch deliberately). The host implementation
  //     is responsible for constraining the agent to the allowlist.
  //     Post-execution we intersect `entitiesReferenced` against the
  //     allowlist and refuse if any out-of-allowlist entity slipped
  //     through — belt-and-braces against an agent that ignores the
  //     constraint.
  if (resolved.kind === "unlinked") {
    if (flow.mode !== "public-only" && flow.mode !== "both") {
      const prompt = buildUnlinkedAskerPrompt(config.linkUrl);
      await postProactiveReply(thread, askerMessageId, prompt);
      log.info(
        { threadId, externalUserId: asker.externalUserId },
        "Proactive answer: posted unlinked-asker stub (no public-dataset wiring)",
      );
      return;
    }

    let allowlist: ReadonlyArray<ProactivePublicDatasetEntry> = [];
    try {
      allowlist = await flow.getPublicDataset({ workspaceId });
    } catch (err) {
      // Fail closed — a registry hiccup must NOT widen the refusal
      // surface. Treat as empty allowlist; the user sees the refusal
      // copy and the admin sees a logged warning.
      log.warn(
        {
          err: err instanceof Error ? err : new Error(String(err)),
          workspaceId,
        },
        "Proactive public-dataset lookup threw — treating as empty allowlist",
      );
      allowlist = [];
    }

    if (allowlist.length === 0) {
      await postPublicRefusal(thread, askerMessageId, config, log, asker, threadId, undefined);
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
      publicResult = await flow.executeQueryProactive(text, {
        threadId,
        asker,
        // Explicit null: host implementations check for null to skip
        // RLS and constrain the agent to the workspace's public-dataset
        // allowlist. Nullable signature (vs an empty-string sentinel)
        // forces deliberate null handling on every host.
        atlasUserId: null,
        workspaceId,
        // #2705 — proactive Slack audience is non-analyst team members.
        // Ask the agent for a 1-2 sentence prose answer; the
        // listener pairs this with progressive-disclosure buttons that
        // surface the SQL / full breakdown on demand.
        presentationMode: "conversational",
      });
    } catch (err) {
      log.error(
        {
          err: err instanceof Error ? err : new Error(String(err)),
          threadId,
        },
        "Proactive executeQueryProactive threw (unlinked-asker / public-dataset path)",
      );
      await postProactiveReply(
        thread,
        askerMessageId,
        "Sorry — I hit an error while answering. Try asking again or use `@atlas` directly.",
      );
      return;
    }

    const allowlistCheck = checkResultAgainstAllowlist(publicResult, allowlist, {
      allowWhenEntitiesUnknown: config.allowAnswerWhenEntitiesUnknown === true,
    });
    if (!allowlistCheck.allowed) {
      const firstRefused = allowlistCheck.refusedEntities[0];
      await postPublicRefusal(thread, askerMessageId, config, log, asker, threadId, firstRefused);
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

    await postProactiveAnswer(
      thread,
      askerMessageId,
      log,
      threadId,
      asker,
      text,
      publicResult,
      recentAnswers,
      disclosures,
    );
    log.info(
      { threadId, externalUserId: asker.externalUserId, mode: "public-dataset" },
      "Proactive answer delivered to unlinked asker via public dataset",
    );
    return;
  }

  // Linked asker branch. `resolved.kind === "linked"` reaches here only
  // when `flow.mode === "linked-only" || flow.mode === "both"` (the
  // only modes that carry a `userResolver`). The discriminator narrows
  // `executeQueryProactive` to non-optional, so no `!config.execute…`
  // fallback is needed — the listener cannot resolve linked without a
  // wired answer call.
  if (flow.mode !== "linked-only" && flow.mode !== "both") {
    // Unreachable at runtime — `safeResolveUser` only runs when the
    // mode includes a resolver, so `resolved.kind === "linked"` cannot
    // co-occur with `mode === "off" | "public-only"`. Kept as a
    // structural narrow so `flow.executeQueryProactive` is non-optional
    // on the line below; without it the discriminator narrow goes
    // through the `resolverFn` extraction earlier and is lost.
    return;
  }

  let result: ProactiveQueryResultLike;
  try {
    result = await flow.executeQueryProactive(text, {
      threadId,
      asker,
      atlasUserId: resolved.atlasUserId,
      workspaceId,
      // #2705 — conversational Slack-audience mode. Same rationale as
      // the public-dataset branch above; centralizing the choice here
      // means a future "dev follows proactive into a thread" surface
      // can opt back into developer mode at one site without changing
      // the agent.
      presentationMode: "conversational",
    });
  } catch (err) {
    log.error(
      {
        err: err instanceof Error ? err : new Error(String(err)),
        threadId,
      },
      "Proactive executeQueryProactive threw",
    );
    await postProactiveReply(
      thread,
      askerMessageId,
      "Sorry — I hit an error while answering. Try asking again or use `@atlas` directly.",
    );
    return;
  }

  await postProactiveAnswer(
    thread,
    askerMessageId,
    log,
    threadId,
    asker,
    text,
    result,
    recentAnswers,
    disclosures,
  );
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
  /** #2705 — SQL the agent ran, for the "Show SQL" disclosure button. */
  sql?: string[];
  /** #2705 — developer-mode rendering, for the "Show details" button. */
  developerView?: string;
};

/**
 * Disclosure payload stored per-answer (#2705). Looked up by the
 * "Show SQL" / "Show details" button handlers to render the expanded
 * content as an in-thread reply. Stored in-memory only — single-pod
 * scope matches `PendingAnswers` and `RecentAnswers`; multi-pod scale
 * lands in the same future PG/Redis move those registries already
 * planned for. TTL bounds the registry so a forgotten button click
 * after several days doesn't keep stale payloads pinned in memory.
 */
interface DisclosurePayload {
  /** Encoded thread id of the answer card itself — `${platform}:CHANNEL:THREAD_TS`. */
  threadId: string;
  /** Asker's original message id, for in-thread reply target (#2704). */
  askerMessageId: string;
  /** SQL the agent ran. Empty array → no "Show SQL" button was rendered. */
  sql: string[];
  /** Developer-mode rendering. Empty string → no "Show details" button was rendered. */
  developerView: string;
  recordedAt: number;
}

const DISCLOSURE_TTL_MS = 24 * 60 * 60 * 1000; // 24h — matches typical Slack thread half-life
const DISCLOSURE_MAX_ENTRIES = 10_000;

class ProactiveDisclosureStore {
  private readonly store = new Map<string, DisclosurePayload>();
  constructor(
    private readonly ttlMs: number = DISCLOSURE_TTL_MS,
    private readonly maxEntries: number = DISCLOSURE_MAX_ENTRIES,
    private readonly now: () => number = Date.now,
  ) {}

  record(answerMessageId: string, payload: Omit<DisclosurePayload, "recordedAt">): void {
    if (this.store.size >= this.maxEntries) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey) this.store.delete(oldestKey);
    }
    this.store.set(answerMessageId, { ...payload, recordedAt: this.now() });
  }

  lookup(answerMessageId: string): DisclosurePayload | null {
    const entry = this.store.get(answerMessageId);
    if (!entry) return null;
    if (this.now() - entry.recordedAt > this.ttlMs) {
      this.store.delete(answerMessageId);
      return null;
    }
    return entry;
  }

  size(): number {
    return this.store.size;
  }
}

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
  // Undefined / null AND empty-array are both treated as "no entity
  // touch information". The empty-array case looks innocuous but is
  // exploitable: a host whose agent answers by hallucinating,
  // consulting a non-entity tool, or reading cached data outside the
  // allowlist would produce `entitiesReferenced: []` while still
  // posting arbitrary content. Default fail-closed for both; opt-in
  // bypass for hosts that genuinely emit clarifying meta-answers from
  // their agent (gated by the same `allowAnswerWhenEntitiesUnknown`
  // flag the undefined case uses, since the failure mode is identical).
  const hasEntityInfo =
    entitiesReferenced !== undefined &&
    entitiesReferenced !== null &&
    entitiesReferenced.length > 0;
  if (!hasEntityInfo) {
    if (opts.allowWhenEntitiesUnknown) return { allowed: true };
    return {
      allowed: false,
      reason: "entitiesReferenced-missing",
      refusedEntities: [],
    };
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
  askerMessageId: string,
  config: ProactiveListenerConfig,
  log: PluginLogger,
  asker: ProactiveAsker,
  threadId: string,
  _refusedEntity: string | undefined,
): Promise<void> {
  const copy = config.refusalCopy ?? DEFAULT_PROACTIVE_REFUSAL_COPY;
  try {
    await postProactiveReply(thread, askerMessageId, copy);
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
    await postProactiveReply(thread, askerMessageId, linkPrompt);
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
  askerMessageId: string,
  log: PluginLogger,
  threadId: string,
  asker: ProactiveAsker,
  question: string,
  result: ProactiveQueryResultLike,
  recentAnswers: RecentAnswers,
  disclosures: ProactiveDisclosureStore,
): Promise<void> {
  const sql = result.sql ?? [];
  const developerView = result.developerView ?? "";
  const showSql = sql.length > 0;
  const showDetails = developerView.trim().length > 0;
  // The card builder uses `answerId` as the buttons' `value` so the
  // action handler can look the disclosure payload up by message id.
  // We don't know `answerMessageId` until AFTER posting — but the
  // card embeds the message id into the button value AT post time,
  // so we'd have a chicken-and-egg. Workaround: render the card with
  // an empty `answerId`, post it, then rely on the disclosure store
  // being keyed on the posted message id (which the action handler
  // resolves from `event.messageId`, the message the button lives on).
  const answer = buildProactiveAnswerCard(result.answer, undefined, {
    showSql,
    showDetails,
  });
  const sent = await postProactiveReply(thread, askerMessageId, answer);
  const answerMessageId = typeof sent.id === "string" ? sent.id : "";

  if (answerMessageId && (showSql || showDetails)) {
    disclosures.record(answerMessageId, {
      threadId,
      askerMessageId,
      sql,
      developerView,
    });
  }

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
  if (!config.feedback.enabled) {
    log.debug(
      { outcome: event.outcome, source: event.source },
      "Proactive feedback: no collector configured — discarding event",
    );
    return;
  }
  try {
    await config.feedback.collector(event);
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

/**
 * Returned by `safeResolveUser` so the caller can distinguish three
 * states the resolver may produce:
 *
 *   - `kind: "linked"`   — `atlasUserId` is the resolved branded
 *                          {@link AtlasUserId}.
 *   - `kind: "unlinked"` — resolver returned `{ kind: "unlinked" }`
 *                          (this asker is genuinely not OAuth'd into
 *                          a workspace user). Discriminated public
 *                          contract per #2641 — pre-#2641 this branch
 *                          was an absent `atlasUserId` field on a
 *                          structural shape, indistinguishable from a
 *                          host omission.
 *   - `kind: "errored"`  — resolver threw. The caller MUST NOT treat
 *                          this as `unlinked` — that would silently
 *                          downgrade a linked Atlas user (whose
 *                          identity wasn't enforced because of a
 *                          transient host error) to the public-dataset
 *                          path, bypassing per-user RLS. Caller should
 *                          post an apology copy and return.
 */
type ResolveOutcome =
  | { kind: "linked"; atlasUserId: AtlasUserId }
  | { kind: "unlinked" }
  | { kind: "errored" };

async function safeResolveUser(
  resolver: ProactiveUserResolver,
  asker: ProactiveAsker,
  workspaceId: WorkspaceId,
  log: PluginLogger,
): Promise<ResolveOutcome> {
  try {
    // Discriminated `ResolvedAsker` (#2641) — `kind: "linked"` carries
    // a non-empty branded `AtlasUserId`; `kind: "unlinked"` carries no
    // id. Pre-#2641 the contract was `{ atlasUserId?: string }` and we
    // had to defensively check for an empty/undefined `atlasUserId` to
    // decide which branch to take.
    //
    // Belt-and-braces against a plain-JS host (or a TS host that
    // bypasses the brand via `as AtlasUserId`) returning `kind:
    // "linked"` with an empty `atlasUserId`: re-run `assertAtlasUserId`
    // at this boundary. An empty linked id would propagate into
    // `executeQueryProactive({ atlasUserId: "" })` and silently bypass
    // per-user RLS — the exact failure mode the brand was meant to
    // close. The runtime guard catches the case the brand can't (since
    // brand purity is by code-review, not by the type system).
    const resolved = await resolver(asker, { workspaceId });
    if (resolved.kind === "linked") {
      const branded = assertAtlasUserId(resolved.atlasUserId);
      return { kind: "linked", atlasUserId: branded };
    }
    return { kind: "unlinked" };
  } catch (err) {
    // Distinguish "registry hiccup" from "resolver returned unlinked"
    // — the caller treats only the second as a public-dataset path.
    // Failing to distinguish was a CRITICAL silent permission
    // downgrade: a linked Atlas user whose resolver threw would have
    // their answer served from the public allowlist with
    // `atlasUserId: null`, bypassing their per-user RLS without any
    // visible signal.
    log.error(
      {
        err: err instanceof Error ? err : new Error(String(err)),
        externalUserId: asker.externalUserId,
        workspaceId,
      },
      "Proactive userResolver threw — refusing the answer (do NOT downgrade linked askers to public-dataset on resolver failure)",
    );
    return { kind: "errored" };
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
