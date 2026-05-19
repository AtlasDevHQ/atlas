/**
 * Tests for the proactive listener wiring.
 *
 * We capture the functions passed to `chat.onNewMessage`, `chat.onReaction`,
 * and `chat.onAction` and invoke them directly with stand-in thread,
 * message, reaction-event, and action-event objects. That keeps the
 * test free of any real Chat SDK plumbing while still proving the
 * wiring is correct.
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
  ChannelProactiveConfig,
  LLMClassifierFn,
  ProactiveMeterEvent,
  ResolveWorkspaceIdFn,
  WorkspaceProactiveConfig,
} from "../types";
import type {
  ProactiveExecuteQuery,
  ProactiveUserResolver,
} from "../answerer";

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
  let reactionHandler: AnyHandler | null = null;
  const actionHandlers = new Map<string, AnyHandler>();
  const modalSubmitHandlers = new Map<string, AnyHandler>();

  const chat = {
    onNewMessage: mock((_pattern: RegExp, handler: AnyHandler) => {
      messageHandler = handler;
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
    handlerCount: () => actionHandlers.size,
    modalCount: () => modalSubmitHandlers.size,
  };
}

interface ThreadDouble {
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
  opts: { isDM?: boolean; adapterName?: string } = {},
): ThreadDouble {
  const addReaction = mock(async () => {});
  return {
    channelId,
    isDM: opts.isDM ?? false,
    // Post-#2620: the listener reads `thread.adapter` to pass to the
    // host-supplied `resolveWorkspaceId`. Test threads supply a minimal
    // adapter stub (name only — the default fixture resolver returns a
    // constant workspaceId, so it doesn't actually inspect the adapter).
    adapter: { name: opts.adapterName ?? "slack" },
    createSentMessageFromMessage: mock(() => ({ addReaction })),
    postEphemeral: mock(async () => ({ id: "E1", threadId: channelId, raw: {} })),
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

const linkedResolver: ProactiveUserResolver = async () => ({ atlasUserId: "atlas-user-1" });
const unlinkedResolver: ProactiveUserResolver = async () => ({});

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
// Listener registration
// ---------------------------------------------------------------------------

describe("registerProactiveListener — gating", () => {
  it("does not register when isEnabled() is false at boot", async () => {
    const { chat, isRegistered } = makeChat();
    await registerProactiveListener(chat as any, makeLogger(), {
      isEnabled: () => false,
      classify: yesLLM,
      resolveWorkspaceId: defaultResolver,
      getWorkspaceConfig: defaultGetWorkspace,
      getChannelConfigs: allowChannels("C-allowed"),
    });
    expect(isRegistered()).toBe(false);
    expect(chat.onNewMessage).not.toHaveBeenCalled();
  });

  it("registers all expected handler types when enabled", async () => {
    const { chat, isRegistered, handlerCount, modalCount } = makeChat();
    await registerProactiveListener(chat as any, makeLogger(), {
      isEnabled: () => true,
      classify: yesLLM,
      resolveWorkspaceId: defaultResolver,
      getWorkspaceConfig: defaultGetWorkspace,
      getChannelConfigs: allowChannels("C-allowed"),
    });
    expect(isRegistered()).toBe(true);
    expect(chat.onNewMessage).toHaveBeenCalledTimes(1);
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
    await registerProactiveListener(chat as any, log, {
      isEnabled: () => true,
      classify: yesLLM,
      resolveWorkspaceId: defaultResolver,
      getWorkspaceConfig: defaultGetWorkspace,
      getChannelConfigs: allowChannels("C-allowed"),
      userResolver: opts.userResolver,
      executeQueryProactive: opts.executeQueryProactive,
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
      threadId: thread.channelId,
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
      threadId: thread.channelId,
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
      threadId: thread.channelId,
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
      threadId: thread.channelId,
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

  it("falls back to unlinked prompt when executeQueryProactive is not configured", async () => {
    const { invokeMessage, invokeReaction, log } = await setup({
      userResolver: linkedResolver,
      // executeQueryProactive deliberately omitted
    });

    const thread = makeThread("C-allowed");
    await invokeMessage(thread, makeMessage({ id: "M1" }));
    await invokeReaction({
      added: true,
      messageId: "M1",
      threadId: thread.channelId,
      thread,
      user: { isMe: false, isBot: false, userId: "U-other", userName: "bob" },
      emoji: PROACTIVE_REACTION,
      rawEmoji: "robot_face",
      adapter: { name: "slack" },
      raw: {},
    });

    expect(thread.post).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalled();
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
      userResolver: linkedResolver,
      executeQueryProactive,
    });
    const thread = makeThread("C-allowed");
    await invokeMessage(thread, makeMessage({ id: "M1" }));
    await invokeAction(PROACTIVE_ANSWER_ACTION_ID, {
      actionId: PROACTIVE_ANSWER_ACTION_ID,
      adapter: { name: "slack" },
      messageId: "offer-msg",
      thread,
      threadId: thread.channelId,
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
      userResolver: linkedResolver,
      executeQueryProactive,
    });
    const thread = makeThread("C-allowed");
    await invokeMessage(thread, makeMessage({ id: "M1" }));
    await invokeAction(PROACTIVE_DISMISS_ACTION_ID, {
      actionId: PROACTIVE_DISMISS_ACTION_ID,
      adapter: { name: "slack" },
      messageId: "offer-msg",
      thread,
      threadId: thread.channelId,
      user: { isMe: false, isBot: false, userId: "U-asker", userName: "alice" },
      value: "M1",
      raw: {},
    });

    // A later reaction-back should now find nothing pending.
    await invokeReaction({
      added: true,
      messageId: "M1",
      threadId: thread.channelId,
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
      userResolver: linkedResolver,
      executeQueryProactive: echoExecute,
      feedbackCollector: wrapped,
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

  it("silently no-ops when no feedbackCollector is configured", async () => {
    const { chat, invokeAction } = makeChat();
    await registerProactiveListener(chat as any, makeLogger(), {
      isEnabled: () => true,
      classify: yesLLM,
      resolveWorkspaceId: defaultResolver,
      getWorkspaceConfig: defaultGetWorkspace,
      getChannelConfigs: allowChannels("C-allowed"),
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
      workspaceId: "ws_1",
      asker: { platform: "slack", externalUserId: "U-asker", userName: "alice" },
      config: {
        isEnabled: () => true,
        classify: yesLLM,
        resolveWorkspaceId: defaultResolver,
        getWorkspaceConfig: defaultGetWorkspace,
        getChannelConfigs: defaultGetChannels,
        feedbackCollector: async (ev) => {
          calls.push(ev);
        },
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
      workspaceId: "ws_1",
      asker: { platform: "slack", externalUserId: "U-asker", userName: "alice" },
      config: {
        isEnabled: () => true,
        classify: yesLLM,
        resolveWorkspaceId: defaultResolver,
        getWorkspaceConfig: defaultGetWorkspace,
        getChannelConfigs: defaultGetChannels,
        feedbackCollector: async (ev) => {
          calls.push(ev);
        },
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
      workspaceId: "ws_1",
      asker: { platform: "slack", externalUserId: "U-asker", userName: "alice" },
      config: {
        isEnabled: () => true,
        classify: yesLLM,
        resolveWorkspaceId: defaultResolver,
        getWorkspaceConfig: defaultGetWorkspace,
        getChannelConfigs: defaultGetChannels,
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
      isPaused,
      onPauseRequest: mock(async () => {}),
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
      isPaused,
      onPauseRequest: mock(async () => {}),
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
      isPaused,
      onPauseRequest: mock(async () => {}),
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
      isPaused: mock(async () => ({ paused: false })),
      onPauseRequest,
    });
    const thread = makeThread("C-allowed");
    await invoke(thread, makeMessage({ text: "@atlas pause" }));
    expect(onPauseRequest).toHaveBeenCalledTimes(1);
    expect((onPauseRequest.mock.calls[0] as unknown[])?.[0]).toMatchObject({
      workspaceId: "ws_1",
      channelId: "C-allowed",
      layer: "channel-24h",
    });
    expect(classify).not.toHaveBeenCalled();
    expect(thread._addReaction).not.toHaveBeenCalled();
  });

  it("DM `unsubscribe` writes a user-optout row and skips classification", async () => {
    const onPauseRequest = mock(async () => {});
    const classify = mock(yesLLM);
    const { chat, invokeMessage: invoke } = makeChat();
    await registerProactiveListener(chat as unknown as Parameters<typeof registerProactiveListener>[0], makeLogger(), {
      isEnabled: () => true,
      classify,
      resolveWorkspaceId: defaultResolver,
      getWorkspaceConfig: defaultGetWorkspace,
      getChannelConfigs: allowChannels("C-allowed"),
      isPaused: mock(async () => ({ paused: false })),
      onPauseRequest,
    });
    const thread = makeThread("D-direct", { isDM: true });
    await invoke(thread, makeMessage({ text: "unsubscribe" }));
    expect(onPauseRequest).toHaveBeenCalledTimes(1);
    expect((onPauseRequest.mock.calls[0] as unknown[])?.[0]).toMatchObject({
      workspaceId: "ws_1",
      channelId: null,
      layer: "user-optout",
      durationMs: null,
    });
    expect(classify).not.toHaveBeenCalled();
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
      isPaused: mock(async () => ({ paused: false })),
      onPauseRequest,
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
      isPaused: mock(async () => ({ paused: false })),
      onPauseRequest,
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
      isPaused,
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
    getPublicDataset?: (input: { workspaceId: string }) => Promise<
      ReadonlyArray<{ entityName: string; denyMetrics: string[] }>
    >;
    refusalCopy?: string;
    allowAnswerWhenEntitiesUnknown?: boolean;
    onMeterEvent?: (event: unknown) => Promise<void> | void;
  } = {}) {
    const { chat, invokeMessage, invokeReaction } = makeChat();
    const log = makeLogger();
    await registerProactiveListener(chat as unknown as Parameters<typeof registerProactiveListener>[0], log, {
      isEnabled: () => true,
      classify: yesLLM,
      resolveWorkspaceId: defaultResolver,
      getWorkspaceConfig: defaultGetWorkspace,
      getChannelConfigs: allowChannels("C-allowed"),
      userResolver: opts.userResolver,
      executeQueryProactive: opts.executeQueryProactive,
      getPublicDataset: opts.getPublicDataset,
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
      threadId: thread.channelId,
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
    expect(executeQueryProactive.mock.calls[0]![1].atlasUserId).toBe(
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
      async (q: string, _ctx: { threadId: string; asker: { externalUserId: string }; atlasUserId: string | null; workspaceId: string }) => ({
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
      async (q: string, _ctx: { threadId: string; asker: { externalUserId: string }; atlasUserId: string | null; workspaceId: string }) => ({
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
      async (q: string, _ctx: { threadId: string; asker: { externalUserId: string }; atlasUserId: string | null; workspaceId: string }) => ({
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
      async (q: string, _ctx: { threadId: string; asker: { externalUserId: string }; atlasUserId: string | null; workspaceId: string }) => ({
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
      async (q: string, _ctx: { threadId: string; asker: { externalUserId: string }; atlasUserId: string | null; workspaceId: string }) => ({
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
      async (q: string, _ctx: { threadId: string; asker: { externalUserId: string }; atlasUserId: string | null; workspaceId: string }) => ({
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
      async (q: string, _ctx: { threadId: string; asker: { externalUserId: string }; atlasUserId: string | null; workspaceId: string }) => ({
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
      return channelToWorkspace.get(thread.channelId) ?? null;
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
      return channelToWorkspace.get(thread.channelId) ?? null;
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
      return channelToWorkspace.get(thread.channelId) ?? null;
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
        isPaused: mock(async () => ({ paused: false })),
        onPauseRequest,
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
      return channelToWorkspace.get(thread.channelId) ?? null;
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
        userResolver: linkedResolver,
        executeQueryProactive,
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
      threadId: threadA.channelId,
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
      threadId: threadB.channelId,
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
      return channelToWorkspace.get(thread.channelId) ?? null;
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
      return channelToWorkspace.get(thread.channelId) ?? null;
    };

    const userResolver = mock(
      async (
        _asker: { externalUserId: string },
        _ctx: { workspaceId: string },
      ) => ({ atlasUserId: "atlas-user-1" }),
    );
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
        userResolver,
        executeQueryProactive,
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
      threadId: threadA.channelId,
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
      threadId: threadB.channelId,
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
    expect(userResolver.mock.calls[0]![1]).toEqual({ workspaceId: "ws-A" });
    expect(userResolver.mock.calls[1]![1]).toEqual({ workspaceId: "ws-B" });

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

  it("legacy 1-arg userResolver still runs (TS contravariance) but receives the workspaceId at runtime", async () => {
    // Pinned behaviour: a pre-#2624 host whose resolver was declared
    // as `(asker) => Promise<...>` still type-checks against the new
    // `(asker, ctx) => Promise<...>` shape (TypeScript parameter
    // contravariance allows fewer params). At runtime the listener
    // passes the second arg unconditionally; a 1-arg fn silently
    // ignores it. This is the silent-collision path the contract
    // change addresses: a self-hosted user who upgrades plugins
    // without touching their resolver gets the old global-lookup
    // behaviour with no compile or runtime warning.
    //
    // This test documents that posture deliberately. If a future
    // change adds a runtime guard (e.g. resolver.length === 1 warn),
    // update this test to assert the warn fires.
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
        // Cast: pre-#2624 hosts had this exact 1-arg shape, and
        // TypeScript still accepts it via contravariance. The cast
        // mirrors the runtime situation.
        userResolver: legacyResolver as unknown as ProactiveUserResolver,
        executeQueryProactive: echoExecute,
      },
    );

    const thread = makeThread("C-allowed");
    await invokeMessage(thread, makeMessage({ id: "M1" }));
    await invokeReaction({
      added: true,
      messageId: "M1",
      threadId: thread.channelId,
      thread,
      user: { isMe: false, isBot: false, userId: "U-asker", userName: "asker" },
      emoji: PROACTIVE_REACTION,
      rawEmoji: "robot_face",
      adapter: { name: "slack" },
      raw: {},
    });

    // Legacy resolver fired and returned its atlasUserId — listener
    // accepted the link and routed through the linked path. The
    // second arg was passed (it would silently be undefined inside
    // the 1-arg function body) but didn't influence the outcome.
    expect(legacyResolver).toHaveBeenCalledTimes(1);
    expect(legacyResolver.mock.calls[0]![0]).toMatchObject({
      externalUserId: "U-asker",
    });
    // The listener still passes the 2nd arg at the runtime call site;
    // assert it's there even though TS contravariance lets the body
    // ignore it. This pins the runtime invariant against an
    // optimization that might drop the 2nd arg.
    const firstCall = legacyResolver.mock.calls[0] as unknown as unknown[];
    expect(firstCall.length).toBe(2);
    expect(firstCall[1]).toEqual({ workspaceId: "ws-1" });
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
        userResolver: throwingResolver,
        executeQueryProactive: echoExecute,
      },
    );

    const thread = makeThread("C-allowed");
    await invokeMessage(thread, makeMessage({ id: "M1" }));
    await invokeReaction({
      added: true,
      messageId: "M1",
      threadId: thread.channelId,
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
      expect.objectContaining({ externalUserId: "U-asker" }),
      { workspaceId: "ws-troubled" },
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
