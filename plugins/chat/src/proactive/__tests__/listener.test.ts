/**
 * Tests for the proactive listener wiring.
 *
 * We capture the functions passed to `chat.onNewMessage`,
 * `chat.onDirectMessage`, `chat.onReaction`, and `chat.onAction` and
 * invoke them directly with stand-in thread, message, reaction-event,
 * and action-event objects. DM scenarios use `invokeDM` so the unit
 * contract matches the SDK's `directMessageHandlers` dispatch path.
 */

import { describe, expect, it, mock } from "bun:test";
import {
  handleProactiveFeedbackSlash,
  PROACTIVE_REACTION,
  registerProactiveListener,
} from "../listener";
import {
  PROACTIVE_ANSWER_ACTION_ID,
  PROACTIVE_DISMISS_ACTION_ID,
} from "../../cards/proactive-answer-card";
import {
  PROACTIVE_FB_HELPFUL_ACTION_ID,
  PROACTIVE_FB_NOT_HELPFUL_ACTION_ID,
  PROACTIVE_FB_WRONG_DATA_ACTION_ID,
  PROACTIVE_FB_WRONG_DATA_INPUT_ID,
  PROACTIVE_FB_WRONG_DATA_MODAL_ID,
  RecentAnswers,
  type FeedbackCollectorFn,
} from "../feedback";
import type {
  AnswerFlowConfig,
  ChannelProactiveConfig,
  FeedbackConfig,
  GetPublicDatasetFn,
  InstallGateConfig,
  KillSwitchConfig,
  LLMClassifierFn,
  OnPauseRequestFn,
  ProactiveMeterEvent,
  ResolverEventLite,
  ResolveWorkspaceIdFn,
  WorkspaceProactiveConfig,
} from "../types";
import type { IsPausedFn } from "../pause";
import type {
  ProactiveExecuteQuery,
  ProactiveUserResolver,
} from "../answerer";
import {
  assertAtlasUserId,
  assertExternalUserId,
  assertWorkspaceId,
} from "../identity";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

type AnyHandler = (...args: unknown[]) => Promise<void> | void;

function makeLogger() {
  return {
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
    debug: mock(() => {}),
  };
}

function makeChat() {
  let messageHandler: AnyHandler | null = null;
  let directMessageHandler: AnyHandler | null = null;
  let reactionHandler: AnyHandler | null = null;
  const actionHandlers = new Map<string, AnyHandler>();
  const modalSubmitHandlers = new Map<string, AnyHandler>();

  const chat = {
    onNewMessage: mock((_pattern: RegExp, handler: AnyHandler) => {
      messageHandler = handler;
    }),
    onDirectMessage: mock((handler: AnyHandler) => {
      directMessageHandler = handler;
    }),
    onReaction: mock((_filter: unknown[], handler: AnyHandler) => {
      reactionHandler = handler;
    }),
    onAction: mock((actionIdOrIds: string | string[], handler: AnyHandler) => {
      const ids = Array.isArray(actionIdOrIds) ? actionIdOrIds : [actionIdOrIds];
      for (const id of ids) actionHandlers.set(id, handler);
    }),
    onModalSubmit: mock((callbackId: string, handler: AnyHandler) => {
      modalSubmitHandlers.set(callbackId, handler);
    }),
  };

  return {
    chat,
    invokeMessage: async (thread: unknown, message: unknown) => {
      if (!messageHandler) throw new Error("listener never registered a message handler");
      await messageHandler(thread, message);
    },
    invokeDM: async (thread: unknown, message: unknown) => {
      if (!directMessageHandler) {
        throw new Error("listener never registered a direct-message handler");
      }
      await directMessageHandler(thread, message);
    },
    invokeReaction: async (event: unknown) => {
      if (!reactionHandler) throw new Error("listener never registered a reaction handler");
      await reactionHandler(event);
    },
    invokeAction: async (actionId: string, event: unknown) => {
      const handler = actionHandlers.get(actionId);
      if (!handler) throw new Error(`no handler for action ${actionId}`);
      await handler(event);
    },
    invokeModalSubmit: async (callbackId: string, event: unknown) => {
      const handler = modalSubmitHandlers.get(callbackId);
      if (!handler) throw new Error(`no modal submit handler for ${callbackId}`);
      return handler(event);
    },
    isRegistered: () => messageHandler !== null,
    isDMRegistered: () => directMessageHandler !== null,
    handlerCount: () => actionHandlers.size,
    modalCount: () => modalSubmitHandlers.size,
  };
}

interface ThreadDouble {
  /**
   * Encoded thread id matching the chat-adapter's contract — for Slack,
   * `"slack:CHANNEL:THREAD_TS"`. Distinct from {@link channelId} (the
   * bare `"slack:CHANNEL"`) so the fixture mirrors the production-shape
   * divergence #2680 exposed: the pre-#2680 fixture collapsed both into
   * the same string, masking the bug in CI.
   */
  id: string;
  channelId: string;
  isDM: boolean;
  adapter: { name: string };
  createSentMessageFromMessage: ReturnType<typeof mock>;
  postEphemeral: ReturnType<typeof mock>;
  post: ReturnType<typeof mock>;
  subscribe: ReturnType<typeof mock>;
  _addReaction: ReturnType<typeof mock>;
}

function makeThread(
  channelId = "C-allowed",
  opts: { isDM?: boolean; adapterName?: string; threadTs?: string } = {},
): ThreadDouble {
  const addReaction = mock(async () => {});
  // Mirror the chat-adapter Slack encoding so prod-shape divergence
  // between `thread.id` and `thread.channelId` is preserved in tests.
  const threadTs = opts.threadTs ?? "1700000000.000100";
  const id = `${channelId}:${threadTs}`;
  return {
    id,
    channelId,
    isDM: opts.isDM ?? false,
    // Post-#2620: the listener reads `thread.adapter` to pass to the
    // host-supplied `resolveWorkspaceId`. Test threads supply a minimal
    // adapter stub (name only — the default fixture resolver returns a
    // constant workspaceId, so it doesn't actually inspect the adapter).
    adapter: { name: opts.adapterName ?? "slack" },
    createSentMessageFromMessage: mock(() => ({ addReaction })),
    postEphemeral: mock(async () => ({ id: "E1", threadId: id, raw: {} })),
    post: mock(async () => ({ id: "P1" })),
    subscribe: mock(async () => {}),
    _addReaction: addReaction,
  };
}

function makeMessage(opts: {
  id?: string;
  text?: string;
  isBot?: boolean | "unknown";
  isMe?: boolean;
  userId?: string;
  userName?: string;
} = {}) {
  return {
    id: opts.id ?? "M1",
    text: opts.text ?? "what was MRR last month?",
    author: {
      isBot: opts.isBot ?? false,
      isMe: opts.isMe ?? false,
      userId: opts.userId ?? "U-asker",
      userName: opts.userName ?? "alice",
    },
  };
}

const baseWorkspace: WorkspaceProactiveConfig = {
  enabled: true,
  sensitivity: "balanced",
  classifierMode: "regex-prefilter",
};

const yesLLM: LLMClassifierFn = async () => ({ isQuestion: true, confidence: 0.9 });
const noLLM: LLMClassifierFn = async () => ({ isQuestion: false, confidence: 0.1 });

const linkedResolver: ProactiveUserResolver = async () => ({
  kind: "linked",
  atlasUserId: assertAtlasUserId("atlas-user-1"),
});
const unlinkedResolver: ProactiveUserResolver = async () => ({ kind: "unlinked" });

const echoExecute: ProactiveExecuteQuery = async (question) => ({
  answer: `Echo: ${question}`,
});

// ---------------------------------------------------------------------------
// #2620 — multi-tenant per-event resolution fixtures
// ---------------------------------------------------------------------------

/**
 * Build a per-event workspace resolver that returns `workspaceId` for
 * every event. Tests that exercise the unknown-tenant skip pass
 * `() => null` directly.
 */
function makeResolver(workspaceId: string | null): ResolveWorkspaceIdFn {
  return async () => workspaceId;
}

/**
 * Build the standard pair of `getWorkspaceConfig` / `getChannelConfigs`
 * fetchers from a workspace config + optional per-channel overrides.
 * Replaces the pre-#2620 static `workspace` + `channelConfigs` registration
 * fields the tests used to stub directly.
 */
function makeWorkspaceFetchers(
  workspace: WorkspaceProactiveConfig | null = baseWorkspace,
  channelConfigs: ChannelProactiveConfig[] = [],
) {
  return {
    getWorkspaceConfig: async () => workspace,
    getChannelConfigs: async () => channelConfigs,
  };
}

const defaultResolver = makeResolver("ws_1");
const { getWorkspaceConfig: defaultGetWorkspace, getChannelConfigs: defaultGetChannels } =
  makeWorkspaceFetchers();

/**
 * Test helper: build a `getChannelConfigs` fetcher that opts the given
 * channel ids in via `allow: true` rows.
 */
const allowChannels = (...ids: string[]) =>
  makeWorkspaceFetchers(
    baseWorkspace,
    ids.map((channelId) => ({ channelId, allow: true })),
  ).getChannelConfigs;

// ---------------------------------------------------------------------------
// #2623 item 1 — discriminated-union config defaults
// ---------------------------------------------------------------------------
//
// `ProactiveListenerConfig` now requires three coupled-feature-group
// unions: `answerFlow`, `killSwitch`, `feedback`. The defaults below
// keep each at the "off" branch so tests stay narrow — every test
// spreads `...offUnions` and overrides only the union it exercises.

const OFF_ANSWER_FLOW: AnswerFlowConfig = { mode: "off" };
const OFF_KILL_SWITCH: KillSwitchConfig = { enabled: false };
const OFF_FEEDBACK: FeedbackConfig = { enabled: false };
const OFF_INSTALL_GATE: InstallGateConfig = { enabled: false };

const offUnions = {
  answerFlow: OFF_ANSWER_FLOW,
  killSwitch: OFF_KILL_SWITCH,
  feedback: OFF_FEEDBACK,
  installGate: OFF_INSTALL_GATE,
} as const;

/** Build a `linked-only` answer flow from the standard linked resolver. */
function linkedOnlyFlow(
  executeQueryProactive: ProactiveExecuteQuery,
  userResolver: ProactiveUserResolver = linkedResolver,
): AnswerFlowConfig {
  return { mode: "linked-only", userResolver, executeQueryProactive };
}

/** Build a `public-only` answer flow for unlinked-asker tests. */
function publicOnlyFlow(
  executeQueryProactive: ProactiveExecuteQuery,
  getPublicDataset: GetPublicDatasetFn,
): AnswerFlowConfig {
  return { mode: "public-only", executeQueryProactive, getPublicDataset };
}

/**
 * Build a `both` answer flow — the SaaS-default mode where the listener
 * resolves linked askers AND post-filters unlinked-asker answers
 * against the public allowlist.
 */
function bothFlow(args: {
  executeQueryProactive: ProactiveExecuteQuery;
  userResolver?: ProactiveUserResolver;
  getPublicDataset: GetPublicDatasetFn;
}): AnswerFlowConfig {
  return {
    mode: "both",
    executeQueryProactive: args.executeQueryProactive,
    userResolver: args.userResolver ?? linkedResolver,
    getPublicDataset: args.getPublicDataset,
  };
}

/** Build an enabled kill-switch union. */
function enabledKillSwitch(
  isPaused: IsPausedFn,
  onPauseRequest: OnPauseRequestFn,
): KillSwitchConfig {
  return { enabled: true, isPaused, onPauseRequest };
}

/** Build an enabled feedback union. */
function enabledFeedback(collector: FeedbackCollectorFn): FeedbackConfig {
  return { enabled: true, collector };
}

// ---------------------------------------------------------------------------
// Listener registration
// ---------------------------------------------------------------------------

describe("registerProactiveListener — gating", () => {
  it("does not register when isEnabled() is false at boot", async () => {
    const { chat, isRegistered, isDMRegistered } = makeChat();
    await registerProactiveListener(chat as any, makeLogger(), {
      isEnabled: () => false,
      classify: yesLLM,
      resolveWorkspaceId: defaultResolver,
      getWorkspaceConfig: defaultGetWorkspace,
      getChannelConfigs: allowChannels("C-allowed"),
      ...offUnions,
    });
    expect(isRegistered()).toBe(false);
    expect(isDMRegistered()).toBe(false);
    expect(chat.onNewMessage).not.toHaveBeenCalled();
    expect(chat.onDirectMessage).not.toHaveBeenCalled();
  });

  it("registers all expected handler types when enabled", async () => {
    const { chat, isRegistered, isDMRegistered, handlerCount, modalCount } = makeChat();
    await registerProactiveListener(chat as any, makeLogger(), {
      isEnabled: () => true,
      classify: yesLLM,
      resolveWorkspaceId: defaultResolver,
      getWorkspaceConfig: defaultGetWorkspace,
      getChannelConfigs: allowChannels("C-allowed"),
      ...offUnions,
    });
    expect(isRegistered()).toBe(true);
    expect(isDMRegistered()).toBe(true);
    expect(chat.onNewMessage).toHaveBeenCalledTimes(1);
    expect(chat.onDirectMessage).toHaveBeenCalledTimes(1);
    expect(chat.onReaction).toHaveBeenCalledTimes(1);
    // Offer card: Yes,answer + Not now. Feedback row: Helpful, Not helpful, Wrong data.
    expect(handlerCount()).toBe(5);
    // Wrong-data textarea modal.
    expect(modalCount()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Channel-message handler — #2292 behaviours preserved
// ---------------------------------------------------------------------------

describe("registerProactiveListener — channel-message handler", () => {
  it("reacts and posts the offer card on a confident question", async () => {
    const { chat, invokeMessage } = makeChat();
    await registerProactiveListener(chat as any, makeLogger(), {
      isEnabled: () => true,
      classify: yesLLM,
      resolveWorkspaceId: defaultResolver,
      getWorkspaceConfig: defaultGetWorkspace,
      getChannelConfigs: allowChannels("C-allowed"),
      ...offUnions,
    });
    const thread = makeThread("C-allowed");
    await invokeMessage(thread, makeMessage());
    expect(thread._addReaction).toHaveBeenCalledTimes(1);
    expect(thread._addReaction).toHaveBeenCalledWith(PROACTIVE_REACTION);
    expect(thread.postEphemeral).toHaveBeenCalledTimes(1);
  });

  it("does not react when the channel has no channel_proactive_config row (not opted in)", async () => {
    const { chat, invokeMessage } = makeChat();
    await registerProactiveListener(chat as any, makeLogger(), {
      isEnabled: () => true,
      classify: yesLLM,
      resolveWorkspaceId: defaultResolver,
      getWorkspaceConfig: defaultGetWorkspace,
      getChannelConfigs: allowChannels("C-allowed"),
      ...offUnions,
    });
    const thread = makeThread("C-other");
    await invokeMessage(thread, makeMessage());
    expect(thread._addReaction).not.toHaveBeenCalled();
    expect(thread.postEphemeral).not.toHaveBeenCalled();
  });

  it("skips when a channel_proactive_config row has allow=false (explicit deny)", async () => {
    // Post-#2620 the DB row is the sole source of truth: `allow: false`
    // is an explicit opt-out. No row at all also means "not opted in"
    // (covered by the prior test).
    const { chat, invokeMessage } = makeChat();
    await registerProactiveListener(chat as any, makeLogger(), {
      isEnabled: () => true,
      classify: yesLLM,
      resolveWorkspaceId: defaultResolver,
      getWorkspaceConfig: defaultGetWorkspace,
      getChannelConfigs: makeWorkspaceFetchers(baseWorkspace, [{ channelId: "C-opted-out", allow: false }]).getChannelConfigs,
      ...offUnions,
    });
    const thread = makeThread("C-opted-out");
    await invokeMessage(thread, makeMessage());
    expect(thread._addReaction).not.toHaveBeenCalled();
  });

  it("rate-limits a chatty channel — only the first message reacts", async () => {
    const { chat, invokeMessage } = makeChat();
    await registerProactiveListener(chat as any, makeLogger(), {
      isEnabled: () => true,
      classify: yesLLM,
      resolveWorkspaceId: defaultResolver,
      getWorkspaceConfig: defaultGetWorkspace,
      getChannelConfigs: allowChannels("C-allowed"),
      ...offUnions,
    });
    const thread = makeThread("C-allowed");
    await invokeMessage(thread, makeMessage({ id: "M1" }));
    await invokeMessage(thread, makeMessage({ id: "M2" }));
    expect(thread._addReaction).toHaveBeenCalledTimes(1);
  });

  it("does not react to bot messages", async () => {
    const { chat, invokeMessage } = makeChat();
    await registerProactiveListener(chat as any, makeLogger(), {
      isEnabled: () => true,
      classify: yesLLM,
      resolveWorkspaceId: defaultResolver,
      getWorkspaceConfig: defaultGetWorkspace,
      getChannelConfigs: allowChannels("C-allowed"),
      ...offUnions,
    });
    const thread = makeThread("C-allowed");
    await invokeMessage(thread, makeMessage({ isBot: true }));
    expect(thread._addReaction).not.toHaveBeenCalled();
  });

  it("does not react on low-confidence classification", async () => {
    const { chat, invokeMessage } = makeChat();
    await registerProactiveListener(chat as any, makeLogger(), {
      isEnabled: () => true,
      classify: noLLM,
      resolveWorkspaceId: defaultResolver,
      getWorkspaceConfig: defaultGetWorkspace,
      getChannelConfigs: allowChannels("C-allowed"),
      ...offUnions,
    });
    const thread = makeThread("C-allowed");
    await invokeMessage(thread, makeMessage());
    expect(thread._addReaction).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Reaction-back handler — #2293 happy paths
// ---------------------------------------------------------------------------

describe("registerProactiveListener — reaction-back handler", () => {
  async function setup(opts: {
    userResolver?: ProactiveUserResolver;
    executeQueryProactive?: ProactiveExecuteQuery;
    linkUrl?: string;
  } = {}) {
    const { chat, invokeMessage, invokeReaction, invokeAction } = makeChat();
    const log = makeLogger();
    // #2623 item 1 reshape: assemble the answer-flow union from opts.
    // `mode: "off"` when the test omits the wiring (e.g. the
    // "falls back to unlinked prompt" case below); `linked-only` when
    // a userResolver+executeQueryProactive pair is wired. The legacy
    // "userResolver wired but no executeQueryProactive" combination
    // is no longer representable — the type forces both or neither.
    const answerFlow: AnswerFlowConfig =
      opts.userResolver && opts.executeQueryProactive
        ? linkedOnlyFlow(opts.executeQueryProactive, opts.userResolver)
        : OFF_ANSWER_FLOW;
    await registerProactiveListener(chat as any, log, {
      isEnabled: () => true,
      classify: yesLLM,
      resolveWorkspaceId: defaultResolver,
      getWorkspaceConfig: defaultGetWorkspace,
      getChannelConfigs: allowChannels("C-allowed"),
      ...offUnions,
      answerFlow,
      linkUrl: opts.linkUrl,
    });
    return { chat, log, invokeMessage, invokeReaction, invokeAction };
  }

  it("posts the linked-asker answer card on reaction-back", async () => {
    const executeQueryProactive: ProactiveExecuteQuery = mock(echoExecute);
    const { invokeMessage, invokeReaction } = await setup({
      userResolver: linkedResolver,
      executeQueryProactive,
    });

    const thread = makeThread("C-allowed");
    await invokeMessage(thread, makeMessage({ id: "M1" }));

    await invokeReaction({
      added: true,
      messageId: "M1",
      threadId: thread.id,
      thread,
      user: { isMe: false, isBot: false, userId: "U-other", userName: "bob" },
      emoji: PROACTIVE_REACTION,
      rawEmoji: "robot_face",
      adapter: { name: "slack" },
      raw: {},
    });

    expect(executeQueryProactive).toHaveBeenCalledTimes(1);
    expect(thread.post).toHaveBeenCalledTimes(1);
    expect(thread.subscribe).toHaveBeenCalledTimes(1);
  });

  it("posts the unlinked-asker stub when the resolver returns no atlasUserId", async () => {
    const executeQueryProactive = mock(echoExecute);
    const { invokeMessage, invokeReaction } = await setup({
      userResolver: unlinkedResolver,
      executeQueryProactive,
      linkUrl: "https://app.useatlas.dev/link",
    });

    const thread = makeThread("C-allowed");
    await invokeMessage(thread, makeMessage({ id: "M1" }));
    await invokeReaction({
      added: true,
      messageId: "M1",
      threadId: thread.id,
      thread,
      user: { isMe: false, isBot: false, userId: "U-other", userName: "bob" },
      emoji: PROACTIVE_REACTION,
      rawEmoji: "robot_face",
      adapter: { name: "slack" },
      raw: {},
    });

    expect(executeQueryProactive).not.toHaveBeenCalled();
    expect(thread.post).toHaveBeenCalledTimes(1);
    expect(thread.subscribe).not.toHaveBeenCalled();
  });

  it("skips when the reactor is the bot itself", async () => {
    const executeQueryProactive = mock(echoExecute);
    const { invokeMessage, invokeReaction } = await setup({
      userResolver: linkedResolver,
      executeQueryProactive,
    });
    const thread = makeThread("C-allowed");
    await invokeMessage(thread, makeMessage({ id: "M1" }));
    await invokeReaction({
      added: true,
      messageId: "M1",
      threadId: thread.id,
      thread,
      user: { isMe: true, isBot: true, userId: "B-atlas", userName: "atlas" },
      emoji: PROACTIVE_REACTION,
      rawEmoji: "robot_face",
      adapter: { name: "slack" },
      raw: {},
    });
    expect(executeQueryProactive).not.toHaveBeenCalled();
    expect(thread.post).not.toHaveBeenCalled();
  });

  it("skips when the reaction is on an unknown message", async () => {
    const executeQueryProactive = mock(echoExecute);
    const { invokeReaction } = await setup({
      userResolver: linkedResolver,
      executeQueryProactive,
    });
    const thread = makeThread("C-allowed");
    await invokeReaction({
      added: true,
      messageId: "M-unknown",
      threadId: thread.id,
      thread,
      user: { isMe: false, isBot: false, userId: "U-other", userName: "bob" },
      emoji: PROACTIVE_REACTION,
      rawEmoji: "robot_face",
      adapter: { name: "slack" },
      raw: {},
    });
    expect(executeQueryProactive).not.toHaveBeenCalled();
    expect(thread.post).not.toHaveBeenCalled();
  });

  it("posts the unlinked-asker stub when answerFlow.mode is 'off'", async () => {
    // #2623 item 1: the pre-1.5.2 half-wired state ("userResolver wired
    // but no executeQueryProactive") is now compile-time impossible —
    // the discriminated union forces both or neither. The legitimate
    // shape that exercises the same runtime behaviour is `mode: "off"`,
    // which short-circuits the resolver and posts the link-Atlas stub.
    const { invokeMessage, invokeReaction } = await setup({
      // Both omitted → setup() builds `answerFlow: { mode: "off" }`.
      linkUrl: "https://app.useatlas.dev/link",
    });

    const thread = makeThread("C-allowed");
    await invokeMessage(thread, makeMessage({ id: "M1" }));
    await invokeReaction({
      added: true,
      messageId: "M1",
      threadId: thread.id,
      thread,
      user: { isMe: false, isBot: false, userId: "U-other", userName: "bob" },
      emoji: PROACTIVE_REACTION,
      rawEmoji: "robot_face",
      adapter: { name: "slack" },
      raw: {},
    });

    // Exactly one post — the link-Atlas stub — not an answer card and
    // not an empty card. We pin the *content* (the configured
    // `linkUrl` appears in the post `fallbackText`) so a future
    // regression that accidentally posts an answer card or routes to
    // the agent fails here instead of silently passing on the call
    // count alone.
    expect(thread.post).toHaveBeenCalledTimes(1);
    const postArg = (thread.post as unknown as {
      mock: { calls: unknown[][] };
    }).mock.calls[0]?.[0] as { fallbackText?: string } | undefined;
    expect(postArg?.fallbackText ?? "").toContain("https://app.useatlas.dev/link");
    // `mode: "off"` must not subscribe the thread (that's the answer-
    // delivered tail's responsibility, not the unlinked-stub path).
    expect(thread.subscribe).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Button handlers — #2293 inline "Yes, answer" / "Not now"
// ---------------------------------------------------------------------------

describe("registerProactiveListener — button handlers", () => {
  it("triggers the answer flow when 'Yes, answer' is clicked", async () => {
    const executeQueryProactive: ProactiveExecuteQuery = mock(echoExecute);
    const { chat, invokeMessage, invokeAction } = makeChat();
    await registerProactiveListener(chat as any, makeLogger(), {
      isEnabled: () => true,
      classify: yesLLM,
      resolveWorkspaceId: defaultResolver,
      getWorkspaceConfig: defaultGetWorkspace,
      getChannelConfigs: allowChannels("C-allowed"),
      ...offUnions,
      answerFlow: linkedOnlyFlow(executeQueryProactive),
    });
    const thread = makeThread("C-allowed");
    await invokeMessage(thread, makeMessage({ id: "M1" }));
    await invokeAction(PROACTIVE_ANSWER_ACTION_ID, {
      actionId: PROACTIVE_ANSWER_ACTION_ID,
      adapter: { name: "slack" },
      messageId: "offer-msg",
      thread,
      threadId: thread.id,
      user: { isMe: false, isBot: false, userId: "U-asker", userName: "alice" },
      value: "M1",
      raw: {},
    });
    expect(executeQueryProactive).toHaveBeenCalledTimes(1);
    expect(thread.post).toHaveBeenCalledTimes(1);
  });

  it("consumes the pending entry on 'Not now' without answering", async () => {
    const executeQueryProactive = mock(echoExecute);
    const { chat, invokeMessage, invokeReaction, invokeAction } = makeChat();
    await registerProactiveListener(chat as any, makeLogger(), {
      isEnabled: () => true,
      classify: yesLLM,
      resolveWorkspaceId: defaultResolver,
      getWorkspaceConfig: defaultGetWorkspace,
      getChannelConfigs: allowChannels("C-allowed"),
      ...offUnions,
      answerFlow: linkedOnlyFlow(executeQueryProactive),
    });
    const thread = makeThread("C-allowed");
    await invokeMessage(thread, makeMessage({ id: "M1" }));
    await invokeAction(PROACTIVE_DISMISS_ACTION_ID, {
      actionId: PROACTIVE_DISMISS_ACTION_ID,
      adapter: { name: "slack" },
      messageId: "offer-msg",
      thread,
      threadId: thread.id,
      user: { isMe: false, isBot: false, userId: "U-asker", userName: "alice" },
      value: "M1",
      raw: {},
    });

    // A later reaction-back should now find nothing pending.
    await invokeReaction({
      added: true,
      messageId: "M1",
      threadId: thread.id,
      thread,
      user: { isMe: false, isBot: false, userId: "U-other", userName: "bob" },
      emoji: PROACTIVE_REACTION,
      rawEmoji: "robot_face",
      adapter: { name: "slack" },
      raw: {},
    });
    expect(executeQueryProactive).not.toHaveBeenCalled();
    expect(thread.post).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Feedback button + modal handlers (slice #2298)
// ---------------------------------------------------------------------------

describe("registerProactiveListener — feedback buttons", () => {
  async function setup(collector?: FeedbackCollectorFn) {
    const { chat, invokeAction, invokeModalSubmit } = makeChat();
    const log = makeLogger();
    const calls: unknown[] = [];
    const wrapped: FeedbackCollectorFn = collector
      ? collector
      : async (ev) => {
          calls.push(ev);
        };
    const handle = await registerProactiveListener(chat as any, log, {
      isEnabled: () => true,
      classify: yesLLM,
      resolveWorkspaceId: defaultResolver,
      getWorkspaceConfig: defaultGetWorkspace,
      getChannelConfigs: allowChannels("C-allowed"),
      ...offUnions,
      answerFlow: linkedOnlyFlow(echoExecute),
      feedback: enabledFeedback(wrapped),
    });
    return { chat, log, invokeAction, invokeModalSubmit, calls, handle };
  }

  function makeActionEvent(actionId: string, value = "answer-msg-1") {
    return {
      actionId,
      adapter: { name: "slack" },
      messageId: "answer-msg-1",
      thread: makeThread("C-allowed"),
      threadId: "C-allowed",
      user: { isMe: false, isBot: false, userId: "U-asker", userName: "alice" },
      value,
      openModal: mock(async () => ({ viewId: "V1" })),
      raw: {},
    };
  }

  it("routes the Helpful button to the feedback collector", async () => {
    const { invokeAction, calls } = await setup();
    await invokeAction(PROACTIVE_FB_HELPFUL_ACTION_ID, makeActionEvent(PROACTIVE_FB_HELPFUL_ACTION_ID));
    expect(calls).toHaveLength(1);
    const ev = calls[0] as { outcome: string; source: string };
    expect(ev.outcome).toBe("helpful");
    expect(ev.source).toBe("button");
  });

  it("routes the Not helpful button to the feedback collector", async () => {
    const { invokeAction, calls } = await setup();
    await invokeAction(PROACTIVE_FB_NOT_HELPFUL_ACTION_ID, makeActionEvent(PROACTIVE_FB_NOT_HELPFUL_ACTION_ID));
    expect(calls).toHaveLength(1);
    const ev = calls[0] as { outcome: string };
    expect(ev.outcome).toBe("not-helpful");
  });

  it("opens the wrong-data modal on Wrong data and defers the record to modal submit", async () => {
    const { invokeAction, invokeModalSubmit, calls } = await setup();
    const ev = makeActionEvent(PROACTIVE_FB_WRONG_DATA_ACTION_ID);
    await invokeAction(PROACTIVE_FB_WRONG_DATA_ACTION_ID, ev);

    expect(ev.openModal).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(0);

    await invokeModalSubmit(PROACTIVE_FB_WRONG_DATA_MODAL_ID, {
      adapter: { name: "slack" },
      callbackId: PROACTIVE_FB_WRONG_DATA_MODAL_ID,
      privateMetadata: "answer-msg-1",
      // Post-#2620 the modal-submit handler needs `relatedThread` to
      // resolve the tenant (the modal is opened from the in-thread
      // feedback button, so `relatedThread` is always present in
      // production). Tests synthesise a minimal thread stub.
      relatedThread: makeThread("C-allowed"),
      user: { isMe: false, isBot: false, userId: "U-asker", userName: "alice" },
      values: { [PROACTIVE_FB_WRONG_DATA_INPUT_ID]: "MRR figure is stale" },
      raw: {},
    });

    expect(calls).toHaveLength(1);
    const rec = calls[0] as { outcome: string; context?: string; source: string };
    expect(rec.outcome).toBe("wrong-data");
    expect(rec.context).toBe("MRR figure is stale");
    expect(rec.source).toBe("modal");
  });

  it("records a button click even when the modal cannot be opened", async () => {
    const { invokeAction, calls } = await setup();
    const ev = makeActionEvent(PROACTIVE_FB_WRONG_DATA_ACTION_ID);
    ev.openModal = mock(async () => {
      throw new Error("modals not supported on this platform");
    });
    await invokeAction(PROACTIVE_FB_WRONG_DATA_ACTION_ID, ev);

    expect(calls).toHaveLength(1);
    const rec = calls[0] as { outcome: string; source: string };
    expect(rec.outcome).toBe("wrong-data");
    expect(rec.source).toBe("button");
  });

  it("passes the lite ResolverEvent shape (id + raw, no full Message fields) to resolveWorkspaceId from the action handler (#2623 item 2)", async () => {
    // The PR removed the `as unknown as Message` cast at `listener.ts:1008`.
    // The synthesis site now constructs `{ id: event.messageId, raw: event.raw }`
    // directly. This spy pins the exact shape so a future regression that
    // re-introduces extra fields (or drops `id` / `raw`) fails loudly.
    // The default fixture resolver ignores its argument, so a spy is needed.
    const resolveWorkspaceId = mock(async () => "ws_1");
    const { chat, invokeAction } = makeChat();
    await registerProactiveListener(
      chat as unknown as Parameters<typeof registerProactiveListener>[0],
      makeLogger(),
      {
        isEnabled: () => true,
        classify: yesLLM,
        resolveWorkspaceId,
        getWorkspaceConfig: defaultGetWorkspace,
        getChannelConfigs: allowChannels("C-allowed"),
        ...offUnions,
        answerFlow: linkedOnlyFlow(echoExecute),
        feedback: enabledFeedback(async () => {}),
      },
    );
    const ev = {
      actionId: PROACTIVE_FB_HELPFUL_ACTION_ID,
      adapter: { name: "slack" },
      messageId: "answer-msg-42",
      thread: makeThread("C-allowed"),
      threadId: "C-allowed",
      user: { isMe: false, isBot: false, userId: "U-asker", userName: "alice" },
      value: "answer-msg-42",
      openModal: mock(async () => undefined),
      raw: { team_id: "T-tenant-A" },
    };
    await invokeAction(PROACTIVE_FB_HELPFUL_ACTION_ID, ev);

    expect(resolveWorkspaceId).toHaveBeenCalledTimes(1);
    const arg = (resolveWorkspaceId.mock.calls[0] as unknown[])?.[0] as {
      adapter: { name: string };
      thread: { channelId: string };
      message: { id: string; raw: unknown };
    };
    // Lite shape carries `id` + `raw` only — no `attachments`, `author`,
    // `text`, etc. Compare a strict key-set so an accidental widening
    // (e.g. someone synthesising `{ id, raw, text }` to "be safe") fails.
    expect(Object.keys(arg.message).sort()).toEqual(["id", "raw"]);
    expect(arg.message.id).toBe("answer-msg-42");
    expect(arg.message.raw).toEqual({ team_id: "T-tenant-A" });
    expect(arg.adapter.name).toBe("slack");
    expect(arg.thread?.channelId).toBe("C-allowed");
  });

  it("passes the lite ResolverEvent shape (with empty id) to resolveWorkspaceId from the modal-submit handler (#2623 item 2)", async () => {
    // Same contract pin as the action-handler test above, but for the
    // modal-submit path at `listener.ts:1095`. Modal events legitimately
    // synthesise `id: ""` because there's no original message id on a
    // modal-submit event. The lite shape MUST still be exactly
    // `{ id, raw }` so a future regression that passes the full event
    // raw object (which carries extra fields the resolver shouldn't see)
    // fails loudly.
    const resolveWorkspaceId = mock(async () => "ws_1");
    const { chat, invokeModalSubmit } = makeChat();
    await registerProactiveListener(
      chat as unknown as Parameters<typeof registerProactiveListener>[0],
      makeLogger(),
      {
        isEnabled: () => true,
        classify: yesLLM,
        resolveWorkspaceId,
        getWorkspaceConfig: defaultGetWorkspace,
        getChannelConfigs: allowChannels("C-allowed"),
        ...offUnions,
        feedback: enabledFeedback(async () => {}),
      },
    );
    await invokeModalSubmit(PROACTIVE_FB_WRONG_DATA_MODAL_ID, {
      adapter: { name: "slack" },
      callbackId: PROACTIVE_FB_WRONG_DATA_MODAL_ID,
      privateMetadata: "answer-msg-7",
      relatedThread: makeThread("C-allowed"),
      user: { isMe: false, isBot: false, userId: "U-asker", userName: "alice" },
      values: { [PROACTIVE_FB_WRONG_DATA_INPUT_ID]: "bad data" },
      raw: { team_id: "T-tenant-B" },
    });

    expect(resolveWorkspaceId).toHaveBeenCalledTimes(1);
    const arg = (resolveWorkspaceId.mock.calls[0] as unknown[])?.[0] as {
      message: { id: string; raw: unknown };
    };
    expect(Object.keys(arg.message).sort()).toEqual(["id", "raw"]);
    expect(arg.message.id).toBe("");
    expect(arg.message.raw).toEqual({ team_id: "T-tenant-B" });
  });

  it("silently no-ops when no feedbackCollector is configured", async () => {
    const { chat, invokeAction } = makeChat();
    await registerProactiveListener(chat as any, makeLogger(), {
      isEnabled: () => true,
      classify: yesLLM,
      resolveWorkspaceId: defaultResolver,
      getWorkspaceConfig: defaultGetWorkspace,
      getChannelConfigs: allowChannels("C-allowed"),
      ...offUnions,
      // feedbackCollector deliberately omitted
    });
    // Should not throw even though no collector is wired
    await invokeAction(PROACTIVE_FB_HELPFUL_ACTION_ID, {
      actionId: PROACTIVE_FB_HELPFUL_ACTION_ID,
      adapter: { name: "slack" },
      messageId: "answer-msg-1",
      thread: makeThread("C-allowed"),
      threadId: "C-allowed",
      user: { isMe: false, isBot: false, userId: "U-asker", userName: "alice" },
      value: "answer-msg-1",
      openModal: mock(async () => undefined),
      raw: {},
    });
  });
});

// ---------------------------------------------------------------------------
// handleProactiveFeedbackSlash — `/atlas feedback <text>` (slice #2298)
// ---------------------------------------------------------------------------

describe("handleProactiveFeedbackSlash", () => {
  it("returns false when the args are not a feedback subcommand", async () => {
    const calls: unknown[] = [];
    const handled = await handleProactiveFeedbackSlash({
      text: "how many users last month",
      channelId: "C-allowed",
      workspaceId: assertWorkspaceId("ws_1"),
      asker: { platform: "slack", externalUserId: assertExternalUserId("U-asker"), userName: "alice" },
      config: {
        isEnabled: () => true,
        classify: yesLLM,
        resolveWorkspaceId: defaultResolver,
        getWorkspaceConfig: defaultGetWorkspace,
        getChannelConfigs: defaultGetChannels,
        ...offUnions,
        feedback: enabledFeedback(async (ev) => {
          calls.push(ev);
        }),
      },
      log: makeLogger(),
      recentAnswers: new RecentAnswers(),
    });
    expect(handled).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("routes a feedback subcommand to the collector and falls back to recent answer", async () => {
    const calls: unknown[] = [];
    const recent = new RecentAnswers();
    recent.record("C-allowed", "U-asker", {
      threadId: "T-1",
      answerMessageId: "M-1",
      question: "what was MRR",
      answer: "MRR was $X",
    });
    const handled = await handleProactiveFeedbackSlash({
      text: "feedback figure looks stale",
      channelId: "C-allowed",
      workspaceId: assertWorkspaceId("ws_1"),
      asker: { platform: "slack", externalUserId: assertExternalUserId("U-asker"), userName: "alice" },
      config: {
        isEnabled: () => true,
        classify: yesLLM,
        resolveWorkspaceId: defaultResolver,
        getWorkspaceConfig: defaultGetWorkspace,
        getChannelConfigs: defaultGetChannels,
        ...offUnions,
        feedback: enabledFeedback(async (ev) => {
          calls.push(ev);
        }),
      },
      log: makeLogger(),
      recentAnswers: recent,
    });
    expect(handled).toBe(true);
    expect(calls).toHaveLength(1);
    const ev = calls[0] as { context?: string; source: string; answerMessageId: string; threadId: string };
    expect(ev.context).toBe("figure looks stale");
    expect(ev.source).toBe("slash-command");
    expect(ev.answerMessageId).toBe("M-1");
    expect(ev.threadId).toBe("T-1");
  });

  it("returns false when no feedbackCollector is configured", async () => {
    const handled = await handleProactiveFeedbackSlash({
      text: "feedback some text",
      channelId: "C-allowed",
      workspaceId: assertWorkspaceId("ws_1"),
      asker: { platform: "slack", externalUserId: assertExternalUserId("U-asker"), userName: "alice" },
      config: {
        isEnabled: () => true,
        classify: yesLLM,
        resolveWorkspaceId: defaultResolver,
        getWorkspaceConfig: defaultGetWorkspace,
        getChannelConfigs: defaultGetChannels,
        ...offUnions,
        // feedbackCollector deliberately omitted
      },
      log: makeLogger(),
      recentAnswers: new RecentAnswers(),
    });
    expect(handled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Kill switch (#2295)
// ---------------------------------------------------------------------------

describe("registerProactiveListener — kill switch", () => {
  it("skips classification AND reaction when isPaused returns paused", async () => {
    const isPaused = mock(async () => ({ paused: true, layer: "workspace-kill" as const }));
    const classify = mock(yesLLM);
    const { chat, invokeMessage: invoke } = makeChat();
    await registerProactiveListener(chat as unknown as Parameters<typeof registerProactiveListener>[0], makeLogger(), {
      isEnabled: () => true,
      classify,
      resolveWorkspaceId: defaultResolver,
      getWorkspaceConfig: defaultGetWorkspace,
      getChannelConfigs: allowChannels("C-allowed"),
      ...offUnions,
      killSwitch: enabledKillSwitch(isPaused, mock(async () => {})),
    });
    const thread = makeThread("C-allowed");
    await invoke(thread, makeMessage());
    expect(isPaused).toHaveBeenCalledTimes(1);
    expect(classify).not.toHaveBeenCalled();
    expect(thread._addReaction).not.toHaveBeenCalled();
  });

  it("reacts when isPaused returns not paused + classification is confident", async () => {
    const isPaused = mock(async () => ({ paused: false }));
    const { chat, invokeMessage: invoke } = makeChat();
    await registerProactiveListener(chat as unknown as Parameters<typeof registerProactiveListener>[0], makeLogger(), {
      isEnabled: () => true,
      classify: yesLLM,
      resolveWorkspaceId: defaultResolver,
      getWorkspaceConfig: defaultGetWorkspace,
      getChannelConfigs: allowChannels("C-allowed"),
      ...offUnions,
      killSwitch: enabledKillSwitch(isPaused, mock(async () => {})),
    });
    const thread = makeThread("C-allowed");
    await invoke(thread, makeMessage());
    expect(isPaused).toHaveBeenCalledTimes(1);
    expect(thread._addReaction).toHaveBeenCalledTimes(1);
  });

  it("treats an isPaused throw as paused (fail CLOSED — post-1.5.0 polish)", async () => {
    // Post-1.5.0 the listener inverted its kill-switch posture from
    // fail-open to fail-closed: a callback throw silences the listener
    // for that message and logs at error so on-call sees the registry
    // outage. The product contract is "deliver silence when an admin or
    // user asked for it"; degrading to "keep answering" on a DB blip
    // defeats every layer at once.
    const isPaused = mock(async () => {
      throw new Error("DB down");
    });
    const classify = mock(yesLLM);
    const onMeterEvent = mock(async () => {});
    const { chat, invokeMessage: invoke } = makeChat();
    const log = makeLogger();
    await registerProactiveListener(chat as unknown as Parameters<typeof registerProactiveListener>[0], log, {
      isEnabled: () => true,
      classify,
      resolveWorkspaceId: defaultResolver,
      getWorkspaceConfig: defaultGetWorkspace,
      getChannelConfigs: allowChannels("C-allowed"),
      ...offUnions,
      killSwitch: enabledKillSwitch(isPaused, mock(async () => {})),
      onMeterEvent,
    });
    const thread = makeThread("C-allowed");
    await invoke(thread, makeMessage());
    expect(thread._addReaction).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalled();
    // Fail-closed must short-circuit BEFORE the classifier runs — a
    // future refactor that moves the throw-catch inside the classifier
    // loop would still pass the addReaction assertion but leak LLM
    // cost to a kill-switched workspace.
    expect(classify).not.toHaveBeenCalled();
    // And no meter row should land for a silenced message (no
    // classify/react/anything to record).
    expect(onMeterEvent).not.toHaveBeenCalled();
  });

  it("@atlas pause in a channel writes a channel-24h row and skips classification", async () => {
    const onPauseRequest = mock(async () => {});
    const classify = mock(yesLLM);
    const { chat, invokeMessage: invoke } = makeChat();
    await registerProactiveListener(chat as unknown as Parameters<typeof registerProactiveListener>[0], makeLogger(), {
      isEnabled: () => true,
      classify,
      resolveWorkspaceId: defaultResolver,
      getWorkspaceConfig: defaultGetWorkspace,
      getChannelConfigs: allowChannels("C-allowed"),
      ...offUnions,
      killSwitch: enabledKillSwitch(mock(async () => ({ paused: false })), onPauseRequest),
    });
    const thread = makeThread("C-allowed");
    await invoke(thread, makeMessage({ text: "@atlas pause" }));
    expect(onPauseRequest).toHaveBeenCalledTimes(1);
    expect((onPauseRequest.mock.calls[0] as unknown[])?.[0]).toMatchObject({
      workspaceId: assertWorkspaceId("ws_1"),
      channelId: "C-allowed",
      layer: "channel-24h",
    });
    expect(classify).not.toHaveBeenCalled();
    expect(thread._addReaction).not.toHaveBeenCalled();
  });

  it("DM `unsubscribe` (via onDirectMessage path) writes a user-optout row and skips classification", async () => {
    const onPauseRequest = mock(async () => {});
    const classify = mock(yesLLM);
    const { chat, invokeDM } = makeChat();
    await registerProactiveListener(chat as unknown as Parameters<typeof registerProactiveListener>[0], makeLogger(), {
      isEnabled: () => true,
      classify,
      resolveWorkspaceId: defaultResolver,
      getWorkspaceConfig: defaultGetWorkspace,
      getChannelConfigs: allowChannels("C-allowed"),
      ...offUnions,
      killSwitch: enabledKillSwitch(mock(async () => ({ paused: false })), onPauseRequest),
    });
    const thread = makeThread("D-direct", { isDM: true });
    await invokeDM(thread, makeMessage({ text: "unsubscribe" }));
    expect(onPauseRequest).toHaveBeenCalledTimes(1);
    expect((onPauseRequest.mock.calls[0] as unknown[])?.[0]).toMatchObject({
      workspaceId: assertWorkspaceId("ws_1"),
      channelId: null,
      layer: "user-optout",
      durationMs: null,
    });
    expect(classify).not.toHaveBeenCalled();
  });

  it("non-unsubscribe DM short-circuits before resolveWorkspaceId (cost-control contract)", async () => {
    // The DM handler skips chat-with-bot DMs cheaply — no
    // `resolveWorkspaceId` call, no `isEnabled` read, no classifier.
    // Pre-#2638 DMs never reached the proactive handler at all; the
    // new registration plus the early `isDM && !detectUnsubscribeDM`
    // short-circuit preserve the zero-DB / zero-LLM-cost contract for
    // every chat-with-bot DM. A regression that moves the skip below
    // workspace resolution would silently add two host calls per DM.
    const classify = mock(yesLLM);
    const onPauseRequest = mock(async () => {});
    const resolveWorkspaceId = mock(async () => "ws_1");
    const isEnabled = mock(async () => true);
    const { chat, invokeDM } = makeChat();
    await registerProactiveListener(chat as unknown as Parameters<typeof registerProactiveListener>[0], makeLogger(), {
      isEnabled,
      classify,
      resolveWorkspaceId,
      getWorkspaceConfig: defaultGetWorkspace,
      getChannelConfigs: allowChannels("C-allowed"),
      ...offUnions,
      killSwitch: enabledKillSwitch(mock(async () => ({ paused: false })), onPauseRequest),
    });
    const thread = makeThread("D-direct", { isDM: true });
    // Reset after registration — the listener probes `isEnabled("")`
    // at boot to gate registration, which would otherwise count
    // against the "not called per event" assertion below.
    isEnabled.mockClear();
    await invokeDM(thread, makeMessage({ text: "what was MRR last month?" }));
    expect(resolveWorkspaceId).not.toHaveBeenCalled();
    expect(isEnabled).not.toHaveBeenCalled();
    expect(classify).not.toHaveBeenCalled();
    expect(onPauseRequest).not.toHaveBeenCalled();
  });

  it("does not treat literal `unsubscribe` in a non-DM channel as a pause command", async () => {
    const onPauseRequest = mock(async () => {});
    const { chat, invokeMessage: invoke } = makeChat();
    await registerProactiveListener(chat as unknown as Parameters<typeof registerProactiveListener>[0], makeLogger(), {
      isEnabled: () => true,
      classify: yesLLM,
      resolveWorkspaceId: defaultResolver,
      getWorkspaceConfig: defaultGetWorkspace,
      getChannelConfigs: allowChannels("C-allowed"),
      ...offUnions,
      killSwitch: enabledKillSwitch(mock(async () => ({ paused: false })), onPauseRequest),
    });
    const thread = makeThread("C-allowed");
    await invoke(thread, makeMessage({ text: "unsubscribe" }));
    expect(onPauseRequest).not.toHaveBeenCalled();
  });

  it("@atlas pause write failure is logged but never throws", async () => {
    const onPauseRequest = mock(async () => {
      throw new Error("write failed");
    });
    const { chat, invokeMessage: invoke } = makeChat();
    const log = makeLogger();
    await registerProactiveListener(chat as unknown as Parameters<typeof registerProactiveListener>[0], log, {
      isEnabled: () => true,
      classify: yesLLM,
      resolveWorkspaceId: defaultResolver,
      getWorkspaceConfig: defaultGetWorkspace,
      getChannelConfigs: allowChannels("C-allowed"),
      ...offUnions,
      killSwitch: enabledKillSwitch(mock(async () => ({ paused: false })), onPauseRequest),
    });
    const thread = makeThread("C-allowed");
    await invoke(thread, makeMessage({ text: "@atlas pause" }));
    expect(onPauseRequest).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalled();
  });

  it("skips kill-switch check entirely when resolveWorkspaceId returns null (#2620 multi-tenant)", async () => {
    // Pre-#2620 the listener had a static `workspaceId?` field — when
    // omitted, the kill-switch check was bypassed. Post-#2620 the
    // workspaceId is always resolved per event; null = unknown tenant
    // = silent skip BEFORE any kill-switch / classify call.
    const isPaused = mock(async () => ({ paused: true, layer: "workspace-kill" as const }));
    const classify = mock(yesLLM);
    const { chat, invokeMessage: invoke } = makeChat();
    await registerProactiveListener(chat as unknown as Parameters<typeof registerProactiveListener>[0], makeLogger(), {
      isEnabled: () => true,
      classify,
      resolveWorkspaceId: makeResolver(null), // unknown tenant
      getWorkspaceConfig: defaultGetWorkspace,
      getChannelConfigs: allowChannels("C-allowed"),
      ...offUnions,
      killSwitch: enabledKillSwitch(isPaused, mock(async () => {})),
    });
    const thread = makeThread("C-allowed");
    await invoke(thread, makeMessage());
    expect(isPaused).not.toHaveBeenCalled();
    expect(classify).not.toHaveBeenCalled();
    expect(thread._addReaction).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Monthly quota cap (#2301)
// ---------------------------------------------------------------------------

interface MeterEventRecorded {
  eventType: string;
  metadata?: Record<string, unknown>;
}

describe("registerProactiveListener — monthly quota cap (#2301)", () => {
  it("short-circuits classification + reaction and emits a capReached meter event when the cap is reached", async () => {
    const classify = mock(yesLLM);
    const meterEvents: MeterEventRecorded[] = [];
    const onMeterEvent = mock(async (evt: MeterEventRecorded) => {
      meterEvents.push(evt);
    });
    const getQuotaStatus = mock(async () => ({
      monthlyClassifierCap: 50,
      classifyCountThisMonth: 50,
      capReached: true,
    }));
    const { chat, invokeMessage: invoke } = makeChat();
    await registerProactiveListener(
      chat as unknown as Parameters<typeof registerProactiveListener>[0],
      makeLogger(),
      {
        isEnabled: () => true,
        classify,
        resolveWorkspaceId: defaultResolver,
      getWorkspaceConfig: defaultGetWorkspace,
        getChannelConfigs: allowChannels("C-allowed"),
        ...offUnions,
          getQuotaStatus,
        onMeterEvent,
      },
    );
    const thread = makeThread("C-allowed");
    await invoke(thread, makeMessage());

    expect(getQuotaStatus).toHaveBeenCalledTimes(1);
    expect(classify).not.toHaveBeenCalled();
    expect(thread._addReaction).not.toHaveBeenCalled();
    // One meter event: the capReached marker.
    expect(meterEvents).toHaveLength(1);
    expect(meterEvents[0]!.eventType).toBe("classify");
    expect(meterEvents[0]!.metadata).toMatchObject({
      capReached: true,
      skipped: "monthly-quota",
      classifyCountThisMonth: 50,
      monthlyClassifierCap: 50,
    });
  });

  it("simulates 100 messages on a cap=50 workspace and short-circuits the 51st", async () => {
    const classify = mock(yesLLM);
    let count = 0;
    const cap = 50;
    // Production-faithful: the quota reader reflects whatever the host
    // last wrote to `proactive_meter_events`. Bump `count` from inside
    // the meter callback so the 51st classify actually trips the cap.
    const getQuotaStatus = mock(async () => ({
      monthlyClassifierCap: cap,
      classifyCountThisMonth: count,
      capReached: count >= cap,
    }));
    const meterEvents: MeterEventRecorded[] = [];
    const onMeterEvent = mock(async (evt: MeterEventRecorded) => {
      if (evt.eventType === "classify" && evt.metadata?.capReached !== true) {
        count += 1;
      }
      meterEvents.push(evt);
    });

    const { chat, invokeMessage: invoke } = makeChat();
    await registerProactiveListener(
      chat as unknown as Parameters<typeof registerProactiveListener>[0],
      makeLogger(),
      {
        isEnabled: () => true,
        classify,
        resolveWorkspaceId: defaultResolver,
      getWorkspaceConfig: defaultGetWorkspace,
        getChannelConfigs: allowChannels("C-allowed"),
        ...offUnions,
          getQuotaStatus,
        onMeterEvent,
      },
    );

    // Drive 100 messages through the listener.
    for (let i = 0; i < 100; i++) {
      const thread = makeThread("C-allowed");
      await invoke(thread, makeMessage({ id: `M-${i}` }));
    }

    // First 50 should classify; the remaining 50 should short-circuit.
    expect(classify).toHaveBeenCalledTimes(50);
    expect(getQuotaStatus).toHaveBeenCalledTimes(100);
    const capReachedEvents = meterEvents.filter(
      (e) => e.metadata?.capReached === true,
    );
    expect(capReachedEvents.length).toBe(50);
  });

  it("fails open on getQuotaStatus throw — Atlas keeps answering AND meter row carries quotaReadFailed", async () => {
    const classify = mock(yesLLM);
    const getQuotaStatus = mock(async () => {
      throw new Error("quota read failed");
    });
    const meterEvents: ProactiveMeterEvent[] = [];
    const onMeterEvent = mock(async (e: ProactiveMeterEvent) => {
      meterEvents.push(e);
    });
    const { chat, invokeMessage: invoke } = makeChat();
    const log = makeLogger();
    await registerProactiveListener(
      chat as unknown as Parameters<typeof registerProactiveListener>[0],
      log,
      {
        isEnabled: () => true,
        classify,
        resolveWorkspaceId: defaultResolver,
      getWorkspaceConfig: defaultGetWorkspace,
        getChannelConfigs: allowChannels("C-allowed"),
        ...offUnions,
          getQuotaStatus,
        onMeterEvent,
      },
    );
    const thread = makeThread("C-allowed");
    await invoke(thread, makeMessage());

    expect(getQuotaStatus).toHaveBeenCalledTimes(1);
    // Failed-open: classifier still runs, reaction still fires.
    expect(classify).toHaveBeenCalledTimes(1);
    expect(thread._addReaction).toHaveBeenCalledTimes(1);
    // Post-1.5.0 polish: a quota throw now logs at `error` because
    // the monthly cap is silently bypassed during the outage window.
    expect(log.error).toHaveBeenCalled();
    // Polish round 2 (post-review): the bypass is recorded on the
    // SINGLE post-classification classify meter row as
    // `metadata.quotaReadFailed: true` — NOT a separate bypass row
    // (the earlier two-row pattern double-counted classifies and
    // defeated the cost ceiling). Filtering admin analytics on this
    // flag surfaces every per-message bypass in the rollup.
    const classifyRows = meterEvents.filter((e) => e.eventType === "classify");
    expect(classifyRows.length).toBe(1);
    expect(classifyRows[0]!.metadata?.quotaReadFailed).toBe(true);
  });

  it("proceeds to classifier when capReached=false", async () => {
    const classify = mock(yesLLM);
    const getQuotaStatus = mock(async () => ({
      monthlyClassifierCap: 1000,
      classifyCountThisMonth: 12,
      capReached: false,
    }));
    const { chat, invokeMessage: invoke } = makeChat();
    await registerProactiveListener(
      chat as unknown as Parameters<typeof registerProactiveListener>[0],
      makeLogger(),
      {
        isEnabled: () => true,
        classify,
        resolveWorkspaceId: defaultResolver,
      getWorkspaceConfig: defaultGetWorkspace,
        getChannelConfigs: allowChannels("C-allowed"),
        ...offUnions,
          getQuotaStatus,
      },
    );
    const thread = makeThread("C-allowed");
    await invoke(thread, makeMessage());
    expect(getQuotaStatus).toHaveBeenCalledTimes(1);
    expect(classify).toHaveBeenCalledTimes(1);
    expect(thread._addReaction).toHaveBeenCalledTimes(1);
  });

  it("skips quota check entirely when resolveWorkspaceId returns null (#2620 multi-tenant)", async () => {
    // Pre-#2620 the listener had a static `workspaceId?` field — when
    // omitted, the quota check was bypassed. Post-#2620 the unknown-
    // tenant skip happens BEFORE classification (and quota).
    const getQuotaStatus = mock(async () => ({
      monthlyClassifierCap: 50,
      classifyCountThisMonth: 50,
      capReached: true,
    }));
    const classify = mock(yesLLM);
    const { chat, invokeMessage: invoke } = makeChat();
    await registerProactiveListener(
      chat as unknown as Parameters<typeof registerProactiveListener>[0],
      makeLogger(),
      {
        isEnabled: () => true,
        classify,
        resolveWorkspaceId: makeResolver(null),
        getWorkspaceConfig: defaultGetWorkspace,
          getChannelConfigs: allowChannels("C-allowed"),
          ...offUnions,
        getQuotaStatus,
      },
    );
    const thread = makeThread("C-allowed");
    await invoke(thread, makeMessage());
    expect(getQuotaStatus).not.toHaveBeenCalled();
    expect(classify).not.toHaveBeenCalled();
    expect(thread._addReaction).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Public-dataset gate for unlinked askers (#2297)
// ---------------------------------------------------------------------------

describe("registerProactiveListener — public dataset (#2297)", () => {
  async function setup(opts: {
    userResolver?: ProactiveUserResolver;
    executeQueryProactive?: ProactiveExecuteQuery;
    getPublicDataset?: GetPublicDatasetFn;
    refusalCopy?: string;
    allowAnswerWhenEntitiesUnknown?: boolean;
    onMeterEvent?: (event: unknown) => Promise<void> | void;
  } = {}) {
    const { chat, invokeMessage, invokeReaction } = makeChat();
    const log = makeLogger();
    // #2623 item 1 reshape: collapse the four flat optional fields into
    // an `answerFlow` union. The four constructions correspond to the
    // four legal modes; the half-wired states the old shape allowed
    // (e.g. userResolver without executeQueryProactive) are now
    // compile-impossible.
    let answerFlow: AnswerFlowConfig = OFF_ANSWER_FLOW;
    if (opts.executeQueryProactive) {
      const exec = opts.executeQueryProactive;
      if (opts.userResolver && opts.getPublicDataset) {
        answerFlow = bothFlow({
          executeQueryProactive: exec,
          userResolver: opts.userResolver,
          getPublicDataset: opts.getPublicDataset,
        });
      } else if (opts.userResolver) {
        answerFlow = linkedOnlyFlow(exec, opts.userResolver);
      } else if (opts.getPublicDataset) {
        answerFlow = publicOnlyFlow(exec, opts.getPublicDataset);
      }
    }
    await registerProactiveListener(chat as unknown as Parameters<typeof registerProactiveListener>[0], log, {
      isEnabled: () => true,
      classify: yesLLM,
      resolveWorkspaceId: defaultResolver,
      getWorkspaceConfig: defaultGetWorkspace,
      getChannelConfigs: allowChannels("C-allowed"),
      ...offUnions,
      answerFlow,
      refusalCopy: opts.refusalCopy,
      allowAnswerWhenEntitiesUnknown: opts.allowAnswerWhenEntitiesUnknown,
      onMeterEvent: opts.onMeterEvent as Parameters<typeof registerProactiveListener>[2]["onMeterEvent"],
    });
    return { chat, log, invokeMessage, invokeReaction };
  }

  function triggerReaction(thread: ReturnType<typeof makeThread>, messageId = "M1") {
    return {
      added: true,
      messageId,
      threadId: thread.id,
      thread,
      user: { isMe: false, isBot: false, userId: "U-other", userName: "bob" },
      emoji: PROACTIVE_REACTION,
      rawEmoji: "robot_face",
      adapter: { name: "slack" },
      raw: {},
    };
  }

  it("linked asker bypasses the public dataset entirely", async () => {
    const getPublicDataset = mock(async () => []);
    const executeQueryProactive = mock(echoExecute);
    const { invokeMessage, invokeReaction } = await setup({
      userResolver: linkedResolver,
      executeQueryProactive,
      getPublicDataset,
    });
    const thread = makeThread("C-allowed");
    await invokeMessage(thread, makeMessage({ id: "M1" }));
    await invokeReaction(triggerReaction(thread));
    expect(executeQueryProactive).toHaveBeenCalledTimes(1);
    expect(executeQueryProactive.mock.calls[0]![1].atlasUserId as string).toBe(
      "atlas-user-1",
    );
    // The allowlist lookup is for the unlinked path — linked asker
    // should never trigger it.
    expect(getPublicDataset).not.toHaveBeenCalled();
  });

  it("unlinked asker without a public-dataset wiring falls back to the link prompt", async () => {
    const executeQueryProactive = mock(echoExecute);
    const { invokeMessage, invokeReaction } = await setup({
      userResolver: unlinkedResolver,
      executeQueryProactive,
      // getPublicDataset deliberately omitted
    });
    const thread = makeThread("C-allowed");
    await invokeMessage(thread, makeMessage({ id: "M1" }));
    await invokeReaction(triggerReaction(thread));
    expect(executeQueryProactive).not.toHaveBeenCalled();
    expect(thread.post).toHaveBeenCalledTimes(1);
  });

  it("unlinked asker with an empty allowlist gets the refusal + a meter event", async () => {
    const onMeterEvent = mock(async () => {});
    const getPublicDataset = mock(async () => []);
    const executeQueryProactive = mock(echoExecute);
    const { invokeMessage, invokeReaction } = await setup({
      userResolver: unlinkedResolver,
      executeQueryProactive,
      getPublicDataset,
      onMeterEvent,
    });
    const thread = makeThread("C-allowed");
    await invokeMessage(thread, makeMessage({ id: "M1" }));
    await invokeReaction(triggerReaction(thread));

    expect(executeQueryProactive).not.toHaveBeenCalled();
    // Refusal copy + link prompt = 2 posts.
    expect(thread.post).toHaveBeenCalledTimes(2);

    // Meter wiring landed a `public_refused` event with the empty-allowlist
    // reason, plus the classify/react events from the channel-message phase.
    const meterCalls = onMeterEvent.mock.calls.map(
      (c) =>
        (c as unknown[])[0] as { eventType: string; metadata?: Record<string, unknown> },
    );
    const publicRefused = meterCalls.find((c) => c.eventType === "public_refused");
    expect(publicRefused).toBeDefined();
    expect(publicRefused?.metadata?.reason).toBe("allowlist-empty");
  });

  it("unlinked asker inside the allowlist runs executeQueryProactive", async () => {
    const getPublicDataset = mock(async () => [
      { entityName: "marketing.users", denyMetrics: [] },
    ]);
    const executeQueryProactive = mock(
      async (q: string, _ctx: Parameters<ProactiveExecuteQuery>[1]) => ({
        answer: `Echo: ${q}`,
        entitiesReferenced: ["marketing.users"],
      }),
    );
    const { invokeMessage, invokeReaction } = await setup({
      userResolver: unlinkedResolver,
      executeQueryProactive,
      getPublicDataset,
    });
    const thread = makeThread("C-allowed");
    await invokeMessage(thread, makeMessage({ id: "M1" }));
    await invokeReaction(triggerReaction(thread));

    expect(executeQueryProactive).toHaveBeenCalledTimes(1);
    // The sentinel empty-string atlasUserId tells the host this is the
    // public-dataset path; the host then constrains the agent.
    // Post-1.5.0 polish: `null` sentinel (was `""` previously) so hosts
    // must deliberately handle the unlinked-asker branch — a typo'd
    // empty string from upstream is no longer indistinguishable from
    // "intentional public-dataset call".
    expect(executeQueryProactive.mock.calls[0]![1].atlasUserId).toBeNull();
    // Answer card + subscribe → one thread.post for the answer.
    expect(thread.post).toHaveBeenCalledTimes(1);
    expect(thread.subscribe).toHaveBeenCalledTimes(1);
  });

  it("unlinked asker outside the allowlist gets the refusal + public_refused meter event", async () => {
    const onMeterEvent = mock(async () => {});
    const getPublicDataset = mock(async () => [
      { entityName: "marketing.users", denyMetrics: [] },
    ]);
    const executeQueryProactive = mock(
      async (q: string, _ctx: Parameters<ProactiveExecuteQuery>[1]) => ({
        answer: `Echo: ${q}`,
        entitiesReferenced: ["finance.revenue"],
      }),
    );
    const { invokeMessage, invokeReaction } = await setup({
      userResolver: unlinkedResolver,
      executeQueryProactive,
      getPublicDataset,
      onMeterEvent,
    });
    const thread = makeThread("C-allowed");
    await invokeMessage(thread, makeMessage({ id: "M1" }));
    await invokeReaction(triggerReaction(thread));

    expect(executeQueryProactive).toHaveBeenCalledTimes(1);
    // 2 posts: refusal copy + link prompt. The agent answer is NOT posted.
    expect(thread.post).toHaveBeenCalledTimes(2);

    const meterCalls = onMeterEvent.mock.calls.map(
      (c) =>
        (c as unknown[])[0] as { eventType: string; metadata?: Record<string, unknown> },
    );
    const publicRefused = meterCalls.find((c) => c.eventType === "public_refused");
    expect(publicRefused).toBeDefined();
    expect(publicRefused?.metadata?.reason).toBe("entity-not-in-allowlist");
    expect(publicRefused?.metadata?.entityName).toBe("finance.revenue");
  });

  it("strict join semantics: out-of-allowlist join target refuses the whole query", async () => {
    const onMeterEvent = mock(async () => {});
    // revenue is public, customers is NOT — agent reports both → refuse.
    const getPublicDataset = mock(async () => [
      { entityName: "finance.revenue", denyMetrics: [] },
    ]);
    const executeQueryProactive = mock(
      async (q: string, _ctx: Parameters<ProactiveExecuteQuery>[1]) => ({
        answer: `Echo: ${q}`,
        entitiesReferenced: ["finance.revenue", "finance.customers"],
      }),
    );
    const { invokeMessage, invokeReaction } = await setup({
      userResolver: unlinkedResolver,
      executeQueryProactive,
      getPublicDataset,
      onMeterEvent,
    });
    const thread = makeThread("C-allowed");
    await invokeMessage(thread, makeMessage({ id: "M1" }));
    await invokeReaction(triggerReaction(thread));

    expect(thread.post).toHaveBeenCalledTimes(2); // refusal + link
    const meterCalls = onMeterEvent.mock.calls.map(
      (c) =>
        (c as unknown[])[0] as { eventType: string; metadata?: Record<string, unknown> },
    );
    const publicRefused = meterCalls.find((c) => c.eventType === "public_refused");
    expect(publicRefused).toBeDefined();
    expect(publicRefused?.metadata?.refusedEntities).toEqual(["finance.customers"]);
  });

  it("denyMetrics refuses a touched metric inside an allowlisted entity", async () => {
    const onMeterEvent = mock(async () => {});
    const getPublicDataset = mock(async () => [
      { entityName: "marketing.users", denyMetrics: ["email"] },
    ]);
    const executeQueryProactive = mock(
      async (q: string, _ctx: Parameters<ProactiveExecuteQuery>[1]) => ({
        answer: `Echo: ${q}`,
        entitiesReferenced: ["marketing.users"],
        metricsReferenced: ["signup_date", "email"],
      }),
    );
    const { invokeMessage, invokeReaction } = await setup({
      userResolver: unlinkedResolver,
      executeQueryProactive,
      getPublicDataset,
      onMeterEvent,
    });
    const thread = makeThread("C-allowed");
    await invokeMessage(thread, makeMessage({ id: "M1" }));
    await invokeReaction(triggerReaction(thread));

    expect(thread.post).toHaveBeenCalledTimes(2);
    const meterCalls = onMeterEvent.mock.calls.map(
      (c) =>
        (c as unknown[])[0] as { eventType: string; metadata?: Record<string, unknown> },
    );
    const publicRefused = meterCalls.find((c) => c.eventType === "public_refused");
    expect(publicRefused).toBeDefined();
    expect(publicRefused?.metadata?.refusedEntities).toEqual(["marketing.users"]);
  });

  it("entitiesReferenced-missing → refuse (fail-closed default, post-1.5.0 polish)", async () => {
    // Default posture: a result without `entitiesReferenced` is the
    // exact failure mode #2297 was designed to prevent — agent could
    // be reading data outside the allowlist via a non-entity path
    // (cached results, hallucination, non-entity tool). Refuse with
    // `reason: "entitiesReferenced-missing"` so the discoverability
    // rollup distinguishes "no curation" from "agent didn't introspect".
    const onMeterEvent = mock(async () => {});
    const getPublicDataset = mock(async () => [
      { entityName: "marketing.users", denyMetrics: [] },
    ]);
    const executeQueryProactive = mock(
      async (q: string, _ctx: Parameters<ProactiveExecuteQuery>[1]) => ({
        answer: `Echo: ${q}`,
        // No entitiesReferenced field at all.
      }),
    );
    const { invokeMessage, invokeReaction } = await setup({
      userResolver: unlinkedResolver,
      executeQueryProactive,
      getPublicDataset,
      onMeterEvent,
    });
    const thread = makeThread("C-allowed");
    await invokeMessage(thread, makeMessage({ id: "M1" }));
    await invokeReaction(triggerReaction(thread));

    expect(thread.post).toHaveBeenCalledTimes(2); // refusal + link
    const meterCalls = onMeterEvent.mock.calls.map(
      (c) =>
        (c as unknown[])[0] as { eventType: string; metadata?: Record<string, unknown> },
    );
    const publicRefused = meterCalls.find((c) => c.eventType === "public_refused");
    expect(publicRefused).toBeDefined();
    expect(publicRefused?.metadata?.reason).toBe("entitiesReferenced-missing");
  });

  it("empty entitiesReferenced array also refuses (not a meta-answer hole)", async () => {
    // Same fail-closed posture as missing — an empty array is
    // exploitable for the same reason (agent answered via a non-entity
    // path). Earlier polish let this through as "meta answer"; review
    // flagged it as a hole.
    const onMeterEvent = mock(async () => {});
    const getPublicDataset = mock(async () => [
      { entityName: "marketing.users", denyMetrics: [] },
    ]);
    const executeQueryProactive = mock(
      async (q: string, _ctx: Parameters<ProactiveExecuteQuery>[1]) => ({
        answer: `Echo: ${q}`,
        entitiesReferenced: [], // empty array
      }),
    );
    const { invokeMessage, invokeReaction } = await setup({
      userResolver: unlinkedResolver,
      executeQueryProactive,
      getPublicDataset,
      onMeterEvent,
    });
    const thread = makeThread("C-allowed");
    await invokeMessage(thread, makeMessage({ id: "M1" }));
    await invokeReaction(triggerReaction(thread));

    expect(thread.post).toHaveBeenCalledTimes(2);
    const meterCalls = onMeterEvent.mock.calls.map(
      (c) =>
        (c as unknown[])[0] as { eventType: string; metadata?: Record<string, unknown> },
    );
    const publicRefused = meterCalls.find((c) => c.eventType === "public_refused");
    expect(publicRefused).toBeDefined();
    expect(publicRefused?.metadata?.reason).toBe("entitiesReferenced-missing");
  });

  it("allowAnswerWhenEntitiesUnknown=true bypasses the entity-introspection refusal", async () => {
    // Opt-out for hosts whose agent genuinely can't surface
    // `entitiesReferenced` (and who have a compensating control like
    // RLS or SQL-time allowlist enforcement). Without the flag this
    // path refuses; with the flag the result is allowed through.
    const getPublicDataset = mock(async () => [
      { entityName: "marketing.users", denyMetrics: [] },
    ]);
    const executeQueryProactive = mock(
      async (q: string, _ctx: Parameters<ProactiveExecuteQuery>[1]) => ({
        answer: `Echo: ${q}`,
        // No entitiesReferenced
      }),
    );
    const { invokeMessage, invokeReaction } = await setup({
      userResolver: unlinkedResolver,
      executeQueryProactive,
      getPublicDataset,
      allowAnswerWhenEntitiesUnknown: true,
    });
    const thread = makeThread("C-allowed");
    await invokeMessage(thread, makeMessage({ id: "M1" }));
    await invokeReaction(triggerReaction(thread));

    // With the opt-out, only the answer card is posted via
    // `thread.post` (1 post). The offer card from the channel-message
    // phase goes through `thread.postEphemeral`, not `post`. The
    // refusal+link pair would be 2 posts via `post`, so a count of 1
    // confirms the bypass let the agent answer through.
    expect(thread.post).toHaveBeenCalledTimes(1);
    expect(executeQueryProactive).toHaveBeenCalledTimes(1);
  });

  it("userResolver throw refuses with apology — does NOT downgrade linked askers to public-dataset", async () => {
    // CRITICAL silent-permission-downgrade fix (post-1.5.0 polish).
    // Pre-polish, a userResolver throw produced `atlasUserId: undefined`
    // which the listener treated as "unlinked" → public-dataset path
    // with `atlasUserId: null`. A linked Atlas user whose resolver
    // hiccupped would silently have their RLS bypassed and see an
    // answer constrained to the workspace's public allowlist instead.
    // Now: resolver throw → apology post + return, no public-dataset
    // call at all.
    const throwingResolver: ProactiveUserResolver = mock(async () => {
      throw new Error("user-resolver-DB-down");
    });
    const executeQueryProactive = mock(echoExecute);
    const getPublicDataset = mock(async () => [
      { entityName: "marketing.users", denyMetrics: [] },
    ]);
    const { invokeMessage, invokeReaction, log } = await setup({
      userResolver: throwingResolver,
      executeQueryProactive,
      getPublicDataset,
    });
    const thread = makeThread("C-allowed");
    await invokeMessage(thread, makeMessage({ id: "M1" }));
    await invokeReaction(triggerReaction(thread));

    expect(throwingResolver).toHaveBeenCalled();
    // Apology copy posted; agent NEVER invoked (would silently leak
    // through the public-dataset path under the pre-polish code).
    expect(thread.post).toHaveBeenCalledTimes(1);
    expect(executeQueryProactive).not.toHaveBeenCalled();
    expect(getPublicDataset).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalled();
  });

  it("admin-supplied refusalCopy overrides the default", async () => {
    const getPublicDataset = mock(async () => []);
    const executeQueryProactive = mock(echoExecute);
    const { invokeMessage, invokeReaction } = await setup({
      userResolver: unlinkedResolver,
      executeQueryProactive,
      getPublicDataset,
      refusalCopy: "Custom-refusal-copy-XYZ",
    });
    const thread = makeThread("C-allowed");
    await invokeMessage(thread, makeMessage({ id: "M1" }));
    await invokeReaction(triggerReaction(thread));

    expect(thread.post).toHaveBeenCalledTimes(2);
    // First post is the refusal copy (string), second is the link card.
    const firstArg = thread.post.mock.calls[0]![0];
    expect(firstArg).toBe("Custom-refusal-copy-XYZ");
  });

  it("getPublicDataset failures are treated as an empty allowlist (fail closed)", async () => {
    const onMeterEvent = mock(async () => {});
    const getPublicDataset = mock(async () => {
      throw new Error("DB unreachable");
    });
    const executeQueryProactive = mock(echoExecute);
    const { invokeMessage, invokeReaction, log } = await setup({
      userResolver: unlinkedResolver,
      executeQueryProactive,
      getPublicDataset,
      onMeterEvent,
    });
    const thread = makeThread("C-allowed");
    await invokeMessage(thread, makeMessage({ id: "M1" }));
    await invokeReaction(triggerReaction(thread));

    expect(executeQueryProactive).not.toHaveBeenCalled();
    expect(thread.post).toHaveBeenCalledTimes(2);
    expect(log.warn).toHaveBeenCalled();
    const meterCalls = onMeterEvent.mock.calls.map(
      (c) => (c as unknown[])[0] as { eventType: string },
    );
    expect(meterCalls.some((c) => c.eventType === "public_refused")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// #2620 — multi-tenant per-event resolution
// ---------------------------------------------------------------------------

describe("registerProactiveListener — multi-tenant per-event resolution (#2620)", () => {
  it("silently skips the event when resolveWorkspaceId returns null", async () => {
    const classify = mock(yesLLM);
    const onMeterEvent = mock(async () => {});
    const { chat, invokeMessage } = makeChat();
    await registerProactiveListener(
      chat as unknown as Parameters<typeof registerProactiveListener>[0],
      makeLogger(),
      {
        isEnabled: () => true,
        classify,
        resolveWorkspaceId: makeResolver(null),
        getWorkspaceConfig: defaultGetWorkspace,
          getChannelConfigs: allowChannels("C-allowed"),
          ...offUnions,
        onMeterEvent,
      },
    );
    const thread = makeThread("C-allowed");
    await invokeMessage(thread, makeMessage());
    // Unknown tenant = nothing runs: no classify, no reaction, no meter row.
    expect(classify).not.toHaveBeenCalled();
    expect(thread._addReaction).not.toHaveBeenCalled();
    expect(onMeterEvent).not.toHaveBeenCalled();
  });

  it("silently skips when resolveWorkspaceId throws (fails as null)", async () => {
    // Resolver contract is "never throw"; the safe-wrapper catches and
    // degrades to null so a registry hiccup can't crash the SDK loop.
    const classify = mock(yesLLM);
    const onMeterEvent = mock(async () => {});
    const { chat, invokeMessage } = makeChat();
    const log = makeLogger();
    await registerProactiveListener(
      chat as unknown as Parameters<typeof registerProactiveListener>[0],
      log,
      {
        isEnabled: () => true,
        classify,
        resolveWorkspaceId: async () => {
          throw new Error("slack_installations table missing");
        },
        getWorkspaceConfig: defaultGetWorkspace,
          getChannelConfigs: allowChannels("C-allowed"),
          ...offUnions,
        onMeterEvent,
      },
    );
    const thread = makeThread("C-allowed");
    await invokeMessage(thread, makeMessage());
    expect(classify).not.toHaveBeenCalled();
    expect(thread._addReaction).not.toHaveBeenCalled();
    expect(onMeterEvent).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalled();
  });

  it("skips when getWorkspaceConfig returns null (workspace not opted in)", async () => {
    const classify = mock(yesLLM);
    const onMeterEvent = mock(async () => {});
    const { chat, invokeMessage } = makeChat();
    await registerProactiveListener(
      chat as unknown as Parameters<typeof registerProactiveListener>[0],
      makeLogger(),
      {
        isEnabled: () => true,
        classify,
        resolveWorkspaceId: defaultResolver,
        getWorkspaceConfig: async () => null, // no config row
          getChannelConfigs: allowChannels("C-allowed"),
          ...offUnions,
        onMeterEvent,
      },
    );
    const thread = makeThread("C-allowed");
    await invokeMessage(thread, makeMessage());
    expect(classify).not.toHaveBeenCalled();
    expect(thread._addReaction).not.toHaveBeenCalled();
    expect(onMeterEvent).not.toHaveBeenCalled();
  });

  it("attributes meter rows to the correct workspace across two simulated tenants in the same process", async () => {
    // The core multi-tenant correctness test: pre-#2620 every meter row
    // would have stamped the same baked-in workspaceId regardless of
    // which tenant the message came from. Post-#2620 the listener must
    // read the workspace per event and stamp it onto the meter row.

    // Map (channel id) → workspace id so the resolver can route two
    // distinct tenants through the same Chat instance.
    const channelToWorkspace = new Map<string, string>([
      ["C-tenant-A", "ws-A"],
      ["C-tenant-B", "ws-B"],
    ]);
    const resolveWorkspaceId: ResolveWorkspaceIdFn = async ({ thread }) => {
      // `thread` is `Thread | undefined` per the #2623 item 2 narrowing —
      // channel-message events always carry a real thread, so the
      // optional-chain branch here is the unreachable defensive case.
      return (thread && channelToWorkspace.get(thread.channelId)) ?? null;
    };

    const meterEvents: ProactiveMeterEvent[] = [];
    const onMeterEvent = mock(async (event: ProactiveMeterEvent) => {
      meterEvents.push(event);
    });

    const { chat, invokeMessage } = makeChat();
    await registerProactiveListener(
      chat as unknown as Parameters<typeof registerProactiveListener>[0],
      makeLogger(),
      {
        isEnabled: () => true,
        classify: yesLLM,
        resolveWorkspaceId,
        getWorkspaceConfig: defaultGetWorkspace,
        getChannelConfigs: allowChannels("C-tenant-A", "C-tenant-B"),
        ...offUnions,
        onMeterEvent,
      },
    );

    const threadA = makeThread("C-tenant-A");
    const threadB = makeThread("C-tenant-B");
    await invokeMessage(threadA, makeMessage({ id: "M-A-1" }));
    await invokeMessage(threadB, makeMessage({ id: "M-B-1" }));

    // Both events should land classify + react meter rows.
    const wsA = meterEvents.filter((e) => e.workspaceId === "ws-A");
    const wsB = meterEvents.filter((e) => e.workspaceId === "ws-B");
    expect(wsA.length).toBeGreaterThan(0);
    expect(wsB.length).toBeGreaterThan(0);
    // Pre-#2620 every row would have stamped the same workspaceId
    // (the baked-in one). Post-#2620 they MUST attribute correctly.
    expect(wsA.every((e) => e.workspaceId === "ws-A")).toBe(true);
    expect(wsB.every((e) => e.workspaceId === "ws-B")).toBe(true);
    // And the message ids must not bleed across tenants.
    expect(wsA.some((e) => e.messageId === "M-B-1")).toBe(false);
    expect(wsB.some((e) => e.messageId === "M-A-1")).toBe(false);
  });

  it("does not share rate-limit cooldown across tenants sharing the same channel id", async () => {
    // Two tenants that both have a "C-general" channel must NOT share
    // the in-memory cooldown row — otherwise tenant A reacting in
    // C-general would silence tenant B's C-general for the cooldown
    // window. Cooldown is keyed by `${workspaceId}:${channelId}`.
    const channelToWorkspace = new Map<string, string>([
      ["C-general-A", "ws-A"],
      ["C-general-B", "ws-B"],
    ]);
    const resolveWorkspaceId: ResolveWorkspaceIdFn = async ({ thread }) => {
      // `thread` is `Thread | undefined` per the #2623 item 2 narrowing —
      // channel-message events always carry a real thread, so the
      // optional-chain branch here is the unreachable defensive case.
      return (thread && channelToWorkspace.get(thread.channelId)) ?? null;
    };

    const { chat, invokeMessage } = makeChat();
    await registerProactiveListener(
      chat as unknown as Parameters<typeof registerProactiveListener>[0],
      makeLogger(),
      {
        isEnabled: () => true,
        classify: yesLLM,
        resolveWorkspaceId,
        getWorkspaceConfig: defaultGetWorkspace,
        getChannelConfigs: allowChannels("C-general-A", "C-general-B"),
        ...offUnions,
      },
    );

    const threadA = makeThread("C-general-A");
    const threadB = makeThread("C-general-B");
    await invokeMessage(threadA, makeMessage({ id: "M-A-1" }));
    await invokeMessage(threadB, makeMessage({ id: "M-B-1" }));

    // Both tenants should react — the cooldown is per-tenant.
    expect(threadA._addReaction).toHaveBeenCalledTimes(1);
    expect(threadB._addReaction).toHaveBeenCalledTimes(1);
  });

  it("pause writes carry the per-event workspaceId (two tenants, two channels)", async () => {
    // Stamping the wrong workspaceId on a pause row routes the
    // kill-switch / opt-out to the wrong tenant — the most dangerous
    // multi-tenant regression possible. This test pins onPauseRequest's
    // workspaceId arg to whichever tenant the event resolved to.
    const channelToWorkspace = new Map<string, string>([
      ["C-tenant-A", "ws-A"],
      ["C-tenant-B", "ws-B"],
    ]);
    const resolveWorkspaceId: ResolveWorkspaceIdFn = async ({ thread }) => {
      // `thread` is `Thread | undefined` per the #2623 item 2 narrowing —
      // channel-message events always carry a real thread, so the
      // optional-chain branch here is the unreachable defensive case.
      return (thread && channelToWorkspace.get(thread.channelId)) ?? null;
    };

    const onPauseRequest = mock(async () => {});
    const { chat, invokeMessage } = makeChat();
    await registerProactiveListener(
      chat as unknown as Parameters<typeof registerProactiveListener>[0],
      makeLogger(),
      {
        isEnabled: () => true,
        classify: yesLLM,
        resolveWorkspaceId,
        getWorkspaceConfig: defaultGetWorkspace,
        getChannelConfigs: allowChannels("C-tenant-A", "C-tenant-B"),
        ...offUnions,
        killSwitch: enabledKillSwitch(mock(async () => ({ paused: false })), onPauseRequest),
      },
    );

    const threadA = makeThread("C-tenant-A");
    const threadB = makeThread("C-tenant-B");
    await invokeMessage(threadA, makeMessage({ text: "@atlas pause" }));
    await invokeMessage(threadB, makeMessage({ text: "@atlas pause" }));

    expect(onPauseRequest).toHaveBeenCalledTimes(2);
    expect((onPauseRequest.mock.calls[0] as unknown[])?.[0]).toMatchObject({
      workspaceId: "ws-A",
      channelId: "C-tenant-A",
      layer: "channel-24h",
    });
    expect((onPauseRequest.mock.calls[1] as unknown[])?.[0]).toMatchObject({
      workspaceId: "ws-B",
      channelId: "C-tenant-B",
      layer: "channel-24h",
    });
  });

  it("reaction-back replays the pending entry's workspaceId — not the reaction event's", async () => {
    // The point: a future refactor that swaps `pending.workspaceId` →
    // `safeResolveWorkspace(event)` would silently break multi-tenant
    // correctness because the reaction event's adapter / raw payload
    // may resolve to a DIFFERENT workspace (Slack OAuth shares a single
    // user across workspaces; a wandering reactor could "answer-leak"
    // an answer card across tenants). We pin `isEnabled` to the
    // pending entry's workspaceId.
    const channelToWorkspace = new Map<string, string>([
      ["C-tenant-A", "ws-A"],
      ["C-tenant-B", "ws-B"],
    ]);
    const resolveWorkspaceId: ResolveWorkspaceIdFn = async ({ thread }) => {
      // `thread` is `Thread | undefined` per the #2623 item 2 narrowing —
      // channel-message events always carry a real thread, so the
      // optional-chain branch here is the unreachable defensive case.
      return (thread && channelToWorkspace.get(thread.channelId)) ?? null;
    };

    const isEnabled = mock(async (_: string) => true);
    const executeQueryProactive: ProactiveExecuteQuery = mock(echoExecute);
    const { chat, invokeMessage, invokeReaction } = makeChat();
    await registerProactiveListener(
      chat as unknown as Parameters<typeof registerProactiveListener>[0],
      makeLogger(),
      {
        isEnabled,
        classify: yesLLM,
        resolveWorkspaceId,
        getWorkspaceConfig: defaultGetWorkspace,
        getChannelConfigs: allowChannels("C-tenant-A", "C-tenant-B"),
        ...offUnions,
        answerFlow: linkedOnlyFlow(executeQueryProactive),
      },
    );

    const threadA = makeThread("C-tenant-A");
    const threadB = makeThread("C-tenant-B");
    await invokeMessage(threadA, makeMessage({ id: "M-A-1" }));
    await invokeMessage(threadB, makeMessage({ id: "M-B-1" }));

    // Snapshot the workspaceIds isEnabled saw during registration +
    // channel-message handling so we can isolate the reaction-back calls.
    const isEnabledCallsAfterMessages = isEnabled.mock.calls.length;
    const executeCallsBeforeReactions = (
      executeQueryProactive as unknown as { mock: { calls: unknown[] } }
    ).mock.calls.length;

    // Reaction-back on ws-A's message.
    await invokeReaction({
      added: true,
      messageId: "M-A-1",
      threadId: threadA.id,
      thread: threadA,
      user: { isMe: false, isBot: false, userId: "U-other", userName: "bob" },
      emoji: PROACTIVE_REACTION,
      rawEmoji: "robot_face",
      adapter: { name: "slack" },
      raw: {},
    });
    // Reaction-back on ws-B's message.
    await invokeReaction({
      added: true,
      messageId: "M-B-1",
      threadId: threadB.id,
      thread: threadB,
      user: { isMe: false, isBot: false, userId: "U-other", userName: "bob" },
      emoji: PROACTIVE_REACTION,
      rawEmoji: "robot_face",
      adapter: { name: "slack" },
      raw: {},
    });

    // The two reaction-back calls must hit isEnabled with the pending
    // entry's workspaceId (NOT something re-resolved from the reaction
    // event — though here both happen to match, the assertion is
    // structural: the call comes from the pending entry).
    const reactionIsEnabledCalls = isEnabled.mock.calls.slice(
      isEnabledCallsAfterMessages,
    );
    expect(reactionIsEnabledCalls).toEqual([["ws-A"], ["ws-B"]]);

    // And executeQueryProactive (downstream of the gate) should have
    // received the same per-pending-entry workspaceId on the proactive
    // context (slice options.workspaceId is host-controlled, so we
    // assert via call count alone — both tenants ran).
    const executeCallsAfterReactions = (
      executeQueryProactive as unknown as { mock: { calls: unknown[] } }
    ).mock.calls.length;
    expect(executeCallsAfterReactions - executeCallsBeforeReactions).toBe(2);
  });

  it("getWorkspaceConfig is invoked per-event with the resolver's tenant id (no closure-baked workspaceId)", async () => {
    // Pre-#2620 the workspace config was a static registration field;
    // post-#2620 it's a per-event fetch. This test pins the spy's call
    // args so a regression that re-introduces a closure-baked id (e.g.
    // memoising the first event's workspaceId) fails immediately.
    const channelToWorkspace = new Map<string, string>([
      ["C-tenant-A", "ws-A"],
      ["C-tenant-B", "ws-B"],
    ]);
    const resolveWorkspaceId: ResolveWorkspaceIdFn = async ({ thread }) => {
      // `thread` is `Thread | undefined` per the #2623 item 2 narrowing —
      // channel-message events always carry a real thread, so the
      // optional-chain branch here is the unreachable defensive case.
      return (thread && channelToWorkspace.get(thread.channelId)) ?? null;
    };

    const getWorkspaceConfig = mock(
      async (_workspaceId: string): Promise<WorkspaceProactiveConfig | null> =>
        baseWorkspace,
    );

    const { chat, invokeMessage } = makeChat();
    await registerProactiveListener(
      chat as unknown as Parameters<typeof registerProactiveListener>[0],
      makeLogger(),
      {
        isEnabled: () => true,
        classify: yesLLM,
        resolveWorkspaceId,
        getWorkspaceConfig,
        getChannelConfigs: allowChannels("C-tenant-A", "C-tenant-B"),
        ...offUnions,
      },
    );

    const threadA = makeThread("C-tenant-A");
    const threadB = makeThread("C-tenant-B");
    await invokeMessage(threadA, makeMessage({ id: "M-A-1" }));
    await invokeMessage(threadB, makeMessage({ id: "M-B-1" }));
    await invokeMessage(threadA, makeMessage({ id: "M-A-2" }));

    const callArgs = getWorkspaceConfig.mock.calls.map((c) => c[0]);
    const wsACount = callArgs.filter((id) => id === "ws-A").length;
    const wsBCount = callArgs.filter((id) => id === "ws-B").length;
    expect(wsACount).toBe(2);
    expect(wsBCount).toBe(1);
  });

  it("userResolver receives the pending entry's workspaceId as the second arg (#2624)", async () => {
    // The point of #2624: a multi-tenant host needs the workspaceId
    // to scope the (platform, externalUserId) lookup. Pre-#2624 the
    // resolver received only the asker — two tenants' askers with
    // the same Slack user-id would collide. Now the listener threads
    // the pending entry's workspaceId through as the second arg.
    //
    // We also pin the executeQueryProactive context: the same
    // per-event workspaceId must appear on the proactive context
    // (otherwise the host adapter's tool gates couldn't scope the
    // allowlist correctly either).
    const channelToWorkspace = new Map<string, string>([
      ["C-tenant-A", "ws-A"],
      ["C-tenant-B", "ws-B"],
    ]);
    const resolveWorkspaceId: ResolveWorkspaceIdFn = async ({ thread }) => {
      // `thread` is `Thread | undefined` per the #2623 item 2 narrowing —
      // channel-message events always carry a real thread, so the
      // optional-chain branch here is the unreachable defensive case.
      return (thread && channelToWorkspace.get(thread.channelId)) ?? null;
    };

    const userResolver = mock(
      async (
        _asker: Parameters<ProactiveUserResolver>[0],
        _ctx: Parameters<ProactiveUserResolver>[1],
      ) => ({
        kind: "linked" as const,
        atlasUserId: assertAtlasUserId("atlas-user-1"),
      }),
    ) satisfies ProactiveUserResolver;
    const executeQueryProactive = mock(echoExecute);
    const { chat, invokeMessage, invokeReaction } = makeChat();
    await registerProactiveListener(
      chat as unknown as Parameters<typeof registerProactiveListener>[0],
      makeLogger(),
      {
        isEnabled: async () => true,
        classify: yesLLM,
        resolveWorkspaceId,
        getWorkspaceConfig: defaultGetWorkspace,
        getChannelConfigs: allowChannels("C-tenant-A", "C-tenant-B"),
        ...offUnions,
        answerFlow: linkedOnlyFlow(executeQueryProactive, userResolver),
      },
    );

    const threadA = makeThread("C-tenant-A");
    const threadB = makeThread("C-tenant-B");
    await invokeMessage(threadA, makeMessage({ id: "M-A-1", userId: "U-shared" }));
    await invokeMessage(threadB, makeMessage({ id: "M-B-1", userId: "U-shared" }));

    // Reaction-back drives the answer flow (and therefore the resolver).
    await invokeReaction({
      added: true,
      messageId: "M-A-1",
      threadId: threadA.id,
      thread: threadA,
      user: { isMe: false, isBot: false, userId: "U-shared", userName: "bob" },
      emoji: PROACTIVE_REACTION,
      rawEmoji: "robot_face",
      adapter: { name: "slack" },
      raw: {},
    });
    await invokeReaction({
      added: true,
      messageId: "M-B-1",
      threadId: threadB.id,
      thread: threadB,
      user: { isMe: false, isBot: false, userId: "U-shared", userName: "bob" },
      emoji: PROACTIVE_REACTION,
      rawEmoji: "robot_face",
      adapter: { name: "slack" },
      raw: {},
    });

    // Two resolver invocations, each carrying the originating tenant's
    // workspaceId. Pre-#2624 the second arg didn't exist; assert both
    // the shape and the value to pin the contract.
    expect(userResolver).toHaveBeenCalledTimes(2);
    expect(userResolver.mock.calls[0]![1]).toEqual({
      workspaceId: assertWorkspaceId("ws-A"),
    });
    expect(userResolver.mock.calls[1]![1]).toEqual({
      workspaceId: assertWorkspaceId("ws-B"),
    });

    // ExecuteQueryProactive context carries the same workspaceId so
    // the host adapter can scope its tool gates.
    expect(executeQueryProactive).toHaveBeenCalledTimes(2);
    expect(
      (executeQueryProactive.mock.calls[0]![1] as { workspaceId: string }).workspaceId,
    ).toBe("ws-A");
    expect(
      (executeQueryProactive.mock.calls[1]![1] as { workspaceId: string }).workspaceId,
    ).toBe("ws-B");
  });

  it("pre-#2641 legacy resolver shape now degrades to unlinked at runtime (clean break, no shim)", async () => {
    // Clean-break posture (#2641): the resolver contract is now a
    // discriminated `ResolvedAsker` (`{ kind: "linked"; atlasUserId } |
    // { kind: "unlinked" }`). A pre-#2641 host whose resolver returned
    // the structural `{ atlasUserId: "..." }` shape still type-checks
    // through the `as unknown as ProactiveUserResolver` cast (mirrors
    // the runtime situation when a host upgrades plugins without
    // touching their resolver), but `safeResolveUser`'s runtime
    // discriminator check sees no `kind: "linked"` and routes the
    // asker through the unlinked branch.
    //
    // This is deliberate per the #2641 issue body (pre-customer
    // clean break — no deprecation shim — matches the precedent of
    // #2620 and #2626). The previous incarnation of this test pinned
    // the OPPOSITE — that the legacy shape silently linked the asker.
    // After the discriminator that's a structural mismatch, and the
    // listener fails CLOSED to the unlinked path (no link table is
    // wired here, so the unlinked-asker stub posts).
    const legacyResolver = mock(async (_asker: { externalUserId: string }) => ({
      atlasUserId: "atlas-user-from-legacy",
    }));
    const { chat, invokeMessage, invokeReaction } = makeChat();
    await registerProactiveListener(
      chat as unknown as Parameters<typeof registerProactiveListener>[0],
      makeLogger(),
      {
        isEnabled: async () => true,
        classify: yesLLM,
        resolveWorkspaceId: makeResolver("ws-1"),
        getWorkspaceConfig: defaultGetWorkspace,
        getChannelConfigs: allowChannels("C-allowed"),
        ...offUnions,
        answerFlow: linkedOnlyFlow(
          echoExecute,
          legacyResolver as unknown as ProactiveUserResolver,
        ),
      },
    );

    const thread = makeThread("C-allowed");
    await invokeMessage(thread, makeMessage({ id: "M1" }));
    await invokeReaction({
      added: true,
      messageId: "M1",
      threadId: thread.id,
      thread,
      user: { isMe: false, isBot: false, userId: "U-asker", userName: "asker" },
      emoji: PROACTIVE_REACTION,
      rawEmoji: "robot_face",
      adapter: { name: "slack" },
      raw: {},
    });

    // Legacy resolver fired and the listener passed the per-event
    // workspaceId as the 2nd arg (the runtime invariant survives the
    // contract change). The discriminator check sees no `kind:
    // "linked"` and routes the asker through the unlinked branch —
    // the unlinked-asker stub posts in-thread (`thread.post` called),
    // the linked-asker echo path is NOT taken.
    expect(legacyResolver).toHaveBeenCalledTimes(1);
    expect(legacyResolver.mock.calls[0]![0]).toMatchObject({
      externalUserId: assertExternalUserId("U-asker"),
    });
    const firstCall = legacyResolver.mock.calls[0] as unknown as unknown[];
    expect(firstCall.length).toBe(2);
    expect(firstCall[1]).toEqual({ workspaceId: assertWorkspaceId("ws-1") });
    expect(thread.post).toHaveBeenCalledTimes(1);
    // Echo path NEVER fires when the resolver is structurally invalid.
    const firstPostArg = (thread.post as unknown as {
      mock: { calls: unknown[][] };
    }).mock.calls[0]?.[0];
    expect(String(firstPostArg ?? "")).not.toContain("Echo:");
  });

  it("userResolver throw is per-tenant — logs workspaceId on the apology path", async () => {
    // A resolver hiccup on tenant A must not silently route tenant A's
    // asker through tenant B's workspace context. The listener logs at
    // error with workspaceId so an operator triaging the apology
    // posts can correlate to the right tenant.
    const throwingResolver: ProactiveUserResolver = mock(async () => {
      throw new Error("resolver-DB-down");
    });
    const log = makeLogger();
    const { chat, invokeMessage, invokeReaction } = makeChat();
    await registerProactiveListener(
      chat as unknown as Parameters<typeof registerProactiveListener>[0],
      log,
      {
        isEnabled: async () => true,
        classify: yesLLM,
        resolveWorkspaceId: makeResolver("ws-troubled"),
        getWorkspaceConfig: defaultGetWorkspace,
        getChannelConfigs: allowChannels("C-allowed"),
        ...offUnions,
        answerFlow: linkedOnlyFlow(echoExecute, throwingResolver),
      },
    );

    const thread = makeThread("C-allowed");
    await invokeMessage(thread, makeMessage({ id: "M1" }));
    await invokeReaction({
      added: true,
      messageId: "M1",
      threadId: thread.id,
      thread,
      user: { isMe: false, isBot: false, userId: "U-asker", userName: "asker" },
      emoji: PROACTIVE_REACTION,
      rawEmoji: "robot_face",
      adapter: { name: "slack" },
      raw: {},
    });

    // Apology posted, agent NEVER invoked.
    expect(thread.post).toHaveBeenCalledTimes(1);
    // Resolver received the per-event workspaceId, and the error log
    // carries it (so triage can correlate).
    expect(throwingResolver).toHaveBeenCalledWith(
      expect.objectContaining({ externalUserId: assertExternalUserId("U-asker") }),
      { workspaceId: assertWorkspaceId("ws-troubled") },
    );
    const errorCalls = (log.error as unknown as {
      mock: { calls: ReadonlyArray<ReadonlyArray<unknown>> };
    }).mock.calls;
    const errorCall = errorCalls.find((c) => {
      const payload = c[0] as { workspaceId?: string };
      return payload?.workspaceId === "ws-troubled";
    });
    expect(errorCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// #2641 — brand promotion at the listener's boundaries
// ---------------------------------------------------------------------------

describe("registerProactiveListener — #2641 brand-promotion boundaries", () => {
  it("treats an empty-string workspaceId from resolveWorkspaceId as unknown tenant (silent skip)", async () => {
    // Pinned behaviour: `safeResolveWorkspace` runs `assertWorkspaceId`
    // on the host's `string | null` return; an empty string throws
    // `InvalidProactiveIdentityError` and falls through to the same
    // silent-skip path as `null`. Pre-#2641 an empty string was
    // accepted and propagated, collapsing every event onto a single
    // global tenant.
    const onMeterEvent = mock(async () => {});
    const log = makeLogger();
    const { chat, invokeMessage } = makeChat();
    await registerProactiveListener(
      chat as unknown as Parameters<typeof registerProactiveListener>[0],
      log,
      {
        isEnabled: async () => true,
        classify: yesLLM,
        // Host-side bug: returns "" instead of null on unknown tenant.
        // The listener must NOT treat this as the global path.
        resolveWorkspaceId: makeResolver(""),
        getWorkspaceConfig: defaultGetWorkspace,
        getChannelConfigs: defaultGetChannels,
        ...offUnions,
        onMeterEvent,
      },
    );
    const thread = makeThread("C-allowed");
    await invokeMessage(thread, makeMessage());

    // No classify event, no react, no pending — full silent skip.
    expect(onMeterEvent).not.toHaveBeenCalled();
    expect(thread._addReaction).not.toHaveBeenCalled();
    // The error-log fires so on-call sees the contract violation —
    // not warn, because a persistent empty-id host bug would otherwise
    // hide behind hundreds of identical warns (#2628 history).
    const errorCalls = (log.error as unknown as {
      mock: { calls: ReadonlyArray<ReadonlyArray<unknown>> };
    }).mock.calls;
    const matchingError = errorCalls.find((c) => {
      const payload = c[0] as { rawWorkspaceId?: string };
      return payload?.rawWorkspaceId === "";
    });
    expect(matchingError).toBeDefined();
  });

  it("channel-message handler: missing message.author.userId logs a warn and skips pending registration (orphan reaction)", async () => {
    // `askerFromAuthor` returns `null` when `author.userId` is empty
    // (assert helper throws, caller catches). The channel-message
    // handler must NOT register a pending answer in that state — a
    // pending entry with an empty `externalUserId` would propagate the
    // emptiness into audit/meter/feedback on a later reaction-back.
    // The reaction itself was already posted (cost paid); the asker
    // can never tap-back.
    const log = makeLogger();
    const { chat, invokeMessage, invokeReaction } = makeChat();
    await registerProactiveListener(
      chat as unknown as Parameters<typeof registerProactiveListener>[0],
      log,
      {
        isEnabled: async () => true,
        classify: yesLLM,
        resolveWorkspaceId: makeResolver("ws-1"),
        getWorkspaceConfig: defaultGetWorkspace,
        getChannelConfigs: allowChannels("C-orphan"),
        ...offUnions,
        answerFlow: linkedOnlyFlow(echoExecute),
      },
    );
    const thread = makeThread("C-orphan");
    await invokeMessage(thread, makeMessage({ id: "M-orphan", userId: "" }));

    // Reaction posted (the cost of classification + react had already
    // been paid by the time `askerFromAuthor` was called).
    expect(thread._addReaction).toHaveBeenCalledTimes(1);
    // Warn logged — on-call must see the orphan state.
    const warnCalls = (log.warn as unknown as {
      mock: { calls: ReadonlyArray<ReadonlyArray<unknown>> };
    }).mock.calls;
    const matchingWarn = warnCalls.find((c) => {
      const payload = c[0] as { messageId?: string };
      return payload?.messageId === "M-orphan";
    });
    expect(matchingWarn).toBeDefined();
    // Reaction-back on the same message-id finds nothing pending.
    await invokeReaction({
      added: true,
      messageId: "M-orphan",
      threadId: thread.id,
      thread,
      user: { isMe: false, isBot: false, userId: "U-other", userName: "bob" },
      emoji: PROACTIVE_REACTION,
      rawEmoji: "robot_face",
      adapter: { name: "slack" },
      raw: {},
    });
    expect(thread.post).not.toHaveBeenCalled();
  });

  it("safeResolveUser rejects an empty atlasUserId on the linked branch (plain-JS host RLS-bypass guard)", async () => {
    // Belt-and-braces: the discriminated union forces a `kind: "linked"`
    // construction at the type level, but a plain-JS host (or a TS
    // host that casts `"" as AtlasUserId`) can still propagate an
    // empty id. The listener's `safeResolveUser` calls
    // `assertAtlasUserId` on the resolved id; an empty value throws
    // `InvalidProactiveIdentityError` and routes the asker through the
    // `errored` apology path — NOT the linked path with an empty id
    // that would silently bypass per-user RLS in `executeQueryProactive`.
    const executeQueryProactive = mock(echoExecute);
    const log = makeLogger();
    const { chat, invokeMessage, invokeReaction } = makeChat();
    await registerProactiveListener(
      chat as unknown as Parameters<typeof registerProactiveListener>[0],
      log,
      {
        isEnabled: async () => true,
        classify: yesLLM,
        resolveWorkspaceId: makeResolver("ws-rls"),
        getWorkspaceConfig: defaultGetWorkspace,
        getChannelConfigs: allowChannels("C-rls"),
        ...offUnions,
        // Malformed linked result: kind is correct but atlasUserId is
        // empty. The `as ...` cast mirrors the plain-JS / TS-cast bypass.
        answerFlow: linkedOnlyFlow(
          executeQueryProactive,
          (async () => ({
            kind: "linked",
            atlasUserId: "" as never,
          })) as unknown as ProactiveUserResolver,
        ),
      },
    );
    const thread = makeThread("C-rls");
    await invokeMessage(thread, makeMessage({ id: "M-rls" }));
    await invokeReaction({
      added: true,
      messageId: "M-rls",
      threadId: thread.id,
      thread,
      user: { isMe: false, isBot: false, userId: "U-asker", userName: "asker" },
      emoji: PROACTIVE_REACTION,
      rawEmoji: "robot_face",
      adapter: { name: "slack" },
      raw: {},
    });

    // CRITICAL invariant: executeQueryProactive was NOT invoked. The
    // linked branch with empty atlasUserId would have bypassed per-user
    // RLS inside the host adapter.
    expect(executeQueryProactive).not.toHaveBeenCalled();
    // Apology copy posted (errored ladder, not unlinked path).
    expect(thread.post).toHaveBeenCalledTimes(1);
    const firstPostArg = (thread.post as unknown as {
      mock: { calls: unknown[][] };
    }).mock.calls[0]?.[0];
    expect(String(firstPostArg ?? "")).toMatch(/Sorry — I hit an error/);
  });
});

// ---------------------------------------------------------------------------
// Per-event "called exactly once" sentinel for getWorkspaceConfig (#2623 item 6)
// ---------------------------------------------------------------------------
//
// `types.ts:GetWorkspaceConfigFn` documents the per-event cache contract:
// "the listener caches the result for the lifetime of the single event
// handler call so repeated lookups inside one handler stay cheap."
// Today the channel-message handler reads `getWorkspaceConfig` exactly
// once per event (the `Promise.all` with `getChannelConfigs` at the top
// of the post-pause section). This sentinel pins the invariant so a
// future refactor that adds a second DB read inside the same event
// (e.g. inside the answer flow, or duplicated in the public-dataset
// branch) fails loudly here instead of silently regressing the cost
// contract.
//
// Single-event semantics: one `invokeMessage` call must produce exactly
// one `getWorkspaceConfig` invocation, regardless of how many host
// callbacks downstream (classify / executeQueryProactive / meter) fire.

describe("registerProactiveListener — per-event getWorkspaceConfig cache (#2623 item 6)", () => {
  it("calls getWorkspaceConfig + getChannelConfigs exactly once per channel-message event (happy path)", async () => {
    // `getChannelConfigs` rides the same `Promise.all` as `getWorkspaceConfig`
    // (`listener.ts:661-664`) and has the identical cost-ceiling property —
    // pin both spies so a refactor that adds a second read on EITHER fetcher
    // fails loudly.
    const getWorkspaceConfig = mock(async () => baseWorkspace);
    const channelConfigs: ChannelProactiveConfig[] = [
      { channelId: "C-allowed", allow: true },
    ];
    const getChannelConfigs = mock(async () => channelConfigs);
    const { chat, invokeMessage } = makeChat();
    await registerProactiveListener(
      chat as unknown as Parameters<typeof registerProactiveListener>[0],
      makeLogger(),
      {
        isEnabled: () => true,
        classify: yesLLM,
        resolveWorkspaceId: defaultResolver,
        getWorkspaceConfig,
        getChannelConfigs,
        ...offUnions,
      },
    );
    await invokeMessage(makeThread("C-allowed"), makeMessage());
    expect(getWorkspaceConfig).toHaveBeenCalledTimes(1);
    expect(getChannelConfigs).toHaveBeenCalledTimes(1);
  });

  it("calls getWorkspaceConfig exactly once even when the linked-asker answer flow runs", async () => {
    // The answer flow runs from `onReaction`, not the channel-message
    // handler, so the channel-message event itself MUST still see
    // exactly one workspace-config read. The reaction handler reads
    // the workspaceId off the pending entry (`decision.pending.workspaceId`
    // at `listener.ts:902`) rather than re-resolving — so total
    // `getWorkspaceConfig` invocations stay at 1 across both events.
    // A refactor that called `getWorkspaceConfig` inside `runAnswerFlow`
    // would push the post-reaction count to 2 and fail loudly here.
    const getWorkspaceConfig = mock(async () => baseWorkspace);
    const channelConfigs: ChannelProactiveConfig[] = [
      { channelId: "C-allowed", allow: true },
    ];
    const getChannelConfigs = mock(async () => channelConfigs);
    const executeQueryProactive: ProactiveExecuteQuery = mock(echoExecute);
    const { chat, invokeMessage, invokeReaction } = makeChat();
    await registerProactiveListener(
      chat as unknown as Parameters<typeof registerProactiveListener>[0],
      makeLogger(),
      {
        isEnabled: () => true,
        classify: yesLLM,
        resolveWorkspaceId: defaultResolver,
        getWorkspaceConfig,
        getChannelConfigs,
        ...offUnions,
        answerFlow: linkedOnlyFlow(executeQueryProactive),
      },
    );
    const thread = makeThread("C-allowed");
    await invokeMessage(thread, makeMessage({ id: "M1" }));
    expect(getWorkspaceConfig).toHaveBeenCalledTimes(1);
    expect(getChannelConfigs).toHaveBeenCalledTimes(1);

    // Reaction-back is a separate event; the reaction handler does not
    // (and currently must not) re-read either workspace-scoped fetcher.
    // Pinning the post-reaction counts to 1 catches a regression that
    // would re-read either config inside `runAnswerFlow`.
    await invokeReaction({
      added: true,
      messageId: "M1",
      threadId: thread.id,
      thread,
      user: { isMe: false, isBot: false, userId: "U-other", userName: "bob" },
      emoji: PROACTIVE_REACTION,
      rawEmoji: "robot_face",
      adapter: { name: "slack" },
      raw: {},
    });
    expect(executeQueryProactive).toHaveBeenCalledTimes(1);
    expect(getWorkspaceConfig).toHaveBeenCalledTimes(1);
    expect(getChannelConfigs).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// ResolverEventLite narrowing (#2623 item 2)
// ---------------------------------------------------------------------------
//
// The flip from `message: Message` → `message: ResolverEventLite` is
// only meaningful if a resolver author can no longer read fields
// outside the lite set. Pre-#2623 the parameter type was the full
// `Message` and synthesis sites smuggled a partial shape via a
// structural cast — a resolver that read `event.message.attachments`
// would compile fine and silently return `undefined.length` at
// runtime. The cast hole is closed by the narrowing.
//
// The `void event.message.<field>` statements inside the resolver
// body give each `@ts-expect-error` marker a line to attach to —
// `tsgo --noEmit` (run by `bun run type` and CI) type-checks the body
// regardless of whether `_resolver` is later referenced, so the
// directives are load-bearing as soon as the file compiles. `bun test`
// does NOT enforce `@ts-expect-error` (its transpiler strips types
// without checking); the directives are enforced exclusively by the
// project-level type gate. The `expect(typeof _resolver).toBe("function")`
// line exists so this `describe` block runs through `bun test` and any
// regression appears in the test report — but the type-check is what
// catches a regression first. **Do not** delete the `_resolver` binding
// or replace its body with `void 0`: that would orphan the directives
// and let TS strip them as `TS2578: Unused '@ts-expect-error' directive`.

describe("ResolveWorkspaceIdFn type narrowing (#2623 item 2)", () => {
  it("ts-only: a resolver cannot read fields outside ResolverEventLite", () => {
    const _resolver: ResolveWorkspaceIdFn = async (event) => {
      // OK — `id` and `raw` are the only allowed fields.
      void event.message.id;
      void event.message.raw;
      // @ts-expect-error — `attachments` is on Message but not ResolverEventLite
      void event.message.attachments;
      // @ts-expect-error — `author` is on Message but not ResolverEventLite
      void event.message.author;
      // @ts-expect-error — `text` is on Message but not ResolverEventLite
      void event.message.text;
      // @ts-expect-error — `formatted` is on Message but not ResolverEventLite
      void event.message.formatted;
      // @ts-expect-error — `threadId` is on Message but not ResolverEventLite
      void event.message.threadId;
      // @ts-expect-error — `metadata` is on Message but not ResolverEventLite
      void event.message.metadata;
      // @ts-expect-error — `links` is on Message but not ResolverEventLite
      void event.message.links;
      // @ts-expect-error — `isMention` is on Message but not ResolverEventLite
      void event.message.isMention;
      return null;
    };
    expect(typeof _resolver).toBe("function");
  });

  it("ts-only: ResolverEventLite is structurally a subset of Message", () => {
    // A synthetic lite shape (`{ id, raw }`) satisfies the resolver
    // input without any cast — the listener / bridge synthesis sites
    // rely on this. Real `Message` instances also assign (subtype
    // direction): the listener's channel-message path passes a real
    // `Message` to `safeResolveWorkspace`, which narrows it to
    // `ResolverEventLite` before calling the resolver.
    const lite: ResolverEventLite = { id: "M1", raw: { team_id: "T1" } };
    expect(lite.id).toBe("M1");
  });
});

// ---------------------------------------------------------------------------
// Coupled-feature-group discriminated unions (#2623 item 1)
// ---------------------------------------------------------------------------
//
// `ProactiveListenerConfig` carries three coupled-feature-group unions
// instead of 7 individually optional fields. The contract is "half-
// wired feature groups are compile-impossible" — these `@ts-expect-error`
// directives pin that contract at the type layer. A regression that
// re-introduces the old optional shape (e.g. adding `userResolver?:`
// back onto the interface) silently relaxes the type and makes these
// directives unused, which fails the strict-mode build.

describe("ProactiveListenerConfig discriminated-union contract (#2623 item 1)", () => {
  it("ts-only: half-wired answer flow is a type error (no executeQueryProactive)", () => {
    // @ts-expect-error — `public-only` requires both getPublicDataset
    // AND executeQueryProactive; the mode discriminator forces both
    // or rejects the construction.
    const _half: AnswerFlowConfig = {
      mode: "public-only",
      getPublicDataset: (async () => []) as GetPublicDatasetFn,
    };
    void _half;
  });

  it("ts-only: half-wired answer flow is a type error (no userResolver on linked-only)", () => {
    // @ts-expect-error — `linked-only` requires both userResolver AND
    // executeQueryProactive.
    const _half: AnswerFlowConfig = {
      mode: "linked-only",
      executeQueryProactive: echoExecute,
    };
    void _half;
  });

  it("ts-only: half-wired kill switch is a type error (no onPauseRequest)", () => {
    // @ts-expect-error — `enabled: true` requires both halves of the
    // pair so a kill-switch read can never proceed without a write
    // path and vice versa.
    const _half: KillSwitchConfig = {
      enabled: true,
      isPaused: (async () => ({ paused: false })) as IsPausedFn,
    };
    void _half;
  });

  it("ts-only: half-wired feedback is a type error (no collector)", () => {
    // @ts-expect-error — `enabled: true` requires a collector.
    const _half: FeedbackConfig = {
      enabled: true,
    };
    void _half;
  });

  it("ts-only: extra fields on 'off' modes are rejected (strict-shape contract)", () => {
    // The `off` / `enabled: false` branches carry no callback fields at
    // all. A regression that loosens those branches to accept stray
    // callbacks would defeat the half-wired check above.
    const _flow: AnswerFlowConfig = {
      mode: "off",
      // @ts-expect-error — `mode: "off"` carries no callback fields.
      executeQueryProactive: echoExecute,
    };
    const _kill: KillSwitchConfig = {
      enabled: false,
      // @ts-expect-error — `enabled: false` carries no callback fields.
      isPaused: async () => ({ paused: false }),
    };
    const _fb: FeedbackConfig = {
      enabled: false,
      // @ts-expect-error — `enabled: false` carries no collector.
      collector: async () => {},
    };
    void _flow;
    void _kill;
    void _fb;
  });
});

// ---------------------------------------------------------------------------
// WorkspaceInstallGate (#2655) — outermost per-event gate
// ---------------------------------------------------------------------------
//
// The install gate is the OUTERMOST workspace-scoped check on every
// channel-message event. Pinning behaviour:
//
//   - gate returns true → message flows through to classify/react
//   - gate returns false → silent skip BEFORE classify, isEnabled,
//     workspaceConfig, channelConfigs, killSwitch, or quota are read
//   - gate throws → fail closed (treated as false; no SDK loop crash)
//   - per-event cache: gate is called exactly once per event even when
//     wired multiple times, mirroring the #2623 item 6 sentinel pattern
//
// Acceptance: matches the "Proactive listener gates per-event before
// classify; absent install → silent skip" criterion on #2655.
describe("registerProactiveListener — WorkspaceInstallGate (#2655)", () => {
  // Helper — build the `{ enabled: true, gate, catalogId }` wiring
  // shape from a bare mock function. Replaces the pre-discriminated-
  // union pair (`installGate` + `installCatalogId`) and keeps every
  // test below readable.
  const onGate = (
    gate: import("../types").InstallGateFn,
    catalogId = "slack",
  ): InstallGateConfig => ({ enabled: true, gate, catalogId });

  it("flows through when the install gate returns true", async () => {
    const gate = mock(async () => true);
    const classify = mock(yesLLM);
    const { chat, invokeMessage } = makeChat();
    await registerProactiveListener(chat as any, makeLogger(), {
      isEnabled: () => true,
      classify,
      resolveWorkspaceId: defaultResolver,
      getWorkspaceConfig: defaultGetWorkspace,
      getChannelConfigs: allowChannels("C-allowed"),
      ...offUnions,
      installGate: onGate(gate),
    });
    const thread = makeThread("C-allowed");
    await invokeMessage(thread, makeMessage());
    expect(gate).toHaveBeenCalledTimes(1);
    expect(gate).toHaveBeenCalledWith("ws_1", "slack");
    expect(classify).toHaveBeenCalled();
    expect(thread._addReaction).toHaveBeenCalledTimes(1);
  });

  it("silent-skips before classify when the install gate returns false", async () => {
    const gate = mock(async () => false);
    const classify = mock(yesLLM);
    const isEnabled = mock(() => true);
    const getWorkspaceConfig = mock(async () => baseWorkspace);
    const getChannelConfigs = mock(async () => [
      { channelId: "C-allowed", allow: true } as ChannelProactiveConfig,
    ]);
    const meter: (event: ProactiveMeterEvent) => Promise<void> = mock(
      async () => {},
    );
    const { chat, invokeMessage } = makeChat();
    await registerProactiveListener(chat as any, makeLogger(), {
      isEnabled,
      classify,
      resolveWorkspaceId: defaultResolver,
      getWorkspaceConfig,
      getChannelConfigs,
      onMeterEvent: meter,
      ...offUnions,
      installGate: onGate(gate),
    });
    const thread = makeThread("C-allowed");
    await invokeMessage(thread, makeMessage());

    // Gate runs.
    expect(gate).toHaveBeenCalledTimes(1);
    // Nothing else does past the gate: no classify, no meter, no
    // workspace/channel reads, no per-event isEnabled, no reaction.
    // `isEnabled` IS still called once at registration with the empty
    // sentinel (`registerProactiveListener` probes the boot-time gate);
    // the per-event call (with a real workspaceId) must not fire.
    expect(classify).not.toHaveBeenCalled();
    expect(isEnabled).not.toHaveBeenCalledWith("ws_1");
    expect(getWorkspaceConfig).not.toHaveBeenCalled();
    expect(getChannelConfigs).not.toHaveBeenCalled();
    expect(meter).not.toHaveBeenCalled();
    expect(thread._addReaction).not.toHaveBeenCalled();
  });

  it("fails closed when the install gate throws (no SDK loop crash, no classify)", async () => {
    const gate: import("../types").InstallGateFn = mock(async () => {
      throw new Error("DB outage");
    });
    const classify = mock(yesLLM);
    const { chat, invokeMessage } = makeChat();
    await registerProactiveListener(chat as any, makeLogger(), {
      isEnabled: () => true,
      classify,
      resolveWorkspaceId: defaultResolver,
      getWorkspaceConfig: defaultGetWorkspace,
      getChannelConfigs: allowChannels("C-allowed"),
      ...offUnions,
      installGate: onGate(gate),
    });
    const thread = makeThread("C-allowed");
    // Must not propagate the throw.
    await invokeMessage(thread, makeMessage());
    expect(gate).toHaveBeenCalledTimes(1);
    expect(classify).not.toHaveBeenCalled();
    expect(thread._addReaction).not.toHaveBeenCalled();
  });

  it("does no install gating when installGate.enabled is false (backwards-compat)", async () => {
    // The `enabled: false` branch keeps the listener at pre-#2655
    // behaviour: resolveWorkspaceId → isEnabled → classify → react.
    // No gate function is even required by the type — this is the
    // safe default `offUnions` carries.
    const classify = mock(yesLLM);
    const { chat, invokeMessage } = makeChat();
    await registerProactiveListener(chat as any, makeLogger(), {
      isEnabled: () => true,
      classify,
      resolveWorkspaceId: defaultResolver,
      getWorkspaceConfig: defaultGetWorkspace,
      getChannelConfigs: allowChannels("C-allowed"),
      ...offUnions,
    });
    const thread = makeThread("C-allowed");
    await invokeMessage(thread, makeMessage());
    expect(classify).toHaveBeenCalled();
    expect(thread._addReaction).toHaveBeenCalledTimes(1);
  });

  it("calls installGate exactly once per event (per-event cache sentinel)", async () => {
    // Mirrors the #2623 item 6 sentinel pattern for `getWorkspaceConfig`.
    // One channel-message event = one installGate roundtrip even though
    // the listener may consult the cache through multiple decision
    // points downstream. A regression that re-reads the gate inside
    // the answer flow (or duplicates the call inside the channel-message
    // handler) fails loudly here.
    const gate = mock(async () => true);
    const { chat, invokeMessage } = makeChat();
    await registerProactiveListener(chat as any, makeLogger(), {
      isEnabled: () => true,
      classify: yesLLM,
      resolveWorkspaceId: defaultResolver,
      getWorkspaceConfig: defaultGetWorkspace,
      getChannelConfigs: allowChannels("C-allowed"),
      ...offUnions,
      installGate: onGate(gate),
    });
    await invokeMessage(makeThread("C-allowed"), makeMessage());
    expect(gate).toHaveBeenCalledTimes(1);
  });

  it("allocates a fresh cache per event (admin uninstall takes effect next message)", async () => {
    // Cross-event invariant: a verdict from event A must NOT leak into
    // event B. The listener allocates a fresh `Map` at the top of each
    // event so admin toggle flips (or chat_cache rotations) are picked
    // up immediately. Two invokeMessage calls = two installGate calls.
    const gate = mock(async () => true);
    const { chat, invokeMessage } = makeChat();
    await registerProactiveListener(chat as any, makeLogger(), {
      isEnabled: () => true,
      classify: yesLLM,
      resolveWorkspaceId: defaultResolver,
      getWorkspaceConfig: defaultGetWorkspace,
      getChannelConfigs: allowChannels("C-allowed"),
      ...offUnions,
      installGate: onGate(gate),
    });
    const thread = makeThread("C-allowed");
    await invokeMessage(thread, makeMessage({ id: "M1" }));
    await invokeMessage(thread, makeMessage({ id: "M2" }));
    expect(gate).toHaveBeenCalledTimes(2);
  });
});
