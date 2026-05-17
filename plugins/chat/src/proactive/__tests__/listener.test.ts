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
  resolveChannelAllowlist,
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
  LLMClassifierFn,
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
  createSentMessageFromMessage: ReturnType<typeof mock>;
  postEphemeral: ReturnType<typeof mock>;
  post: ReturnType<typeof mock>;
  subscribe: ReturnType<typeof mock>;
  _addReaction: ReturnType<typeof mock>;
}

function makeThread(channelId = "C-allowed", opts: { isDM?: boolean } = {}): ThreadDouble {
  const addReaction = mock(async () => {});
  return {
    channelId,
    isDM: opts.isDM ?? false,
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
// resolveChannelAllowlist
// ---------------------------------------------------------------------------

describe("resolveChannelAllowlist", () => {
  it("prefers explicit config over env var", () => {
    const set = resolveChannelAllowlist(["C-a", "C-b"], {
      ATLAS_PROACTIVE_CHANNELS: "C-x,C-y",
    } as NodeJS.ProcessEnv);
    expect(Array.from(set).sort()).toEqual(["C-a", "C-b"]);
  });

  it("parses ATLAS_PROACTIVE_CHANNELS comma-separated values", () => {
    const set = resolveChannelAllowlist(undefined, {
      ATLAS_PROACTIVE_CHANNELS: " C-a , C-b ,, C-c ",
    } as NodeJS.ProcessEnv);
    expect(Array.from(set).sort()).toEqual(["C-a", "C-b", "C-c"]);
  });

  it("returns an empty set when neither source is provided", () => {
    const set = resolveChannelAllowlist(undefined, {} as NodeJS.ProcessEnv);
    expect(set.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Listener registration
// ---------------------------------------------------------------------------

describe("registerProactiveListener — gating", () => {
  it("does not register when isEnabled() is false at boot", async () => {
    const { chat, isRegistered } = makeChat();
    await registerProactiveListener(chat as any, makeLogger(), {
      isEnabled: () => false,
      classify: yesLLM,
      workspace: baseWorkspace,
      channelAllowlist: ["C-allowed"],
    });
    expect(isRegistered()).toBe(false);
    expect(chat.onNewMessage).not.toHaveBeenCalled();
  });

  it("registers all expected handler types when enabled", async () => {
    const { chat, isRegistered, handlerCount, modalCount } = makeChat();
    await registerProactiveListener(chat as any, makeLogger(), {
      isEnabled: () => true,
      classify: yesLLM,
      workspace: baseWorkspace,
      channelAllowlist: ["C-allowed"],
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
      workspace: baseWorkspace,
      channelAllowlist: ["C-allowed"],
    });
    const thread = makeThread("C-allowed");
    await invokeMessage(thread, makeMessage());
    expect(thread._addReaction).toHaveBeenCalledTimes(1);
    expect(thread._addReaction).toHaveBeenCalledWith(PROACTIVE_REACTION);
    expect(thread.postEphemeral).toHaveBeenCalledTimes(1);
  });

  it("does not react in a non-allowlisted channel", async () => {
    const { chat, invokeMessage } = makeChat();
    await registerProactiveListener(chat as any, makeLogger(), {
      isEnabled: () => true,
      classify: yesLLM,
      workspace: baseWorkspace,
      channelAllowlist: ["C-allowed"],
    });
    const thread = makeThread("C-other");
    await invokeMessage(thread, makeMessage());
    expect(thread._addReaction).not.toHaveBeenCalled();
    expect(thread.postEphemeral).not.toHaveBeenCalled();
  });

  it("rate-limits a chatty channel — only the first message reacts", async () => {
    const { chat, invokeMessage } = makeChat();
    await registerProactiveListener(chat as any, makeLogger(), {
      isEnabled: () => true,
      classify: yesLLM,
      workspace: baseWorkspace,
      channelAllowlist: ["C-allowed"],
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
      workspace: baseWorkspace,
      channelAllowlist: ["C-allowed"],
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
      workspace: baseWorkspace,
      channelAllowlist: ["C-allowed"],
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
      workspace: baseWorkspace,
      channelAllowlist: ["C-allowed"],
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
      workspace: baseWorkspace,
      channelAllowlist: ["C-allowed"],
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
      workspace: baseWorkspace,
      channelAllowlist: ["C-allowed"],
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
      workspace: baseWorkspace,
      channelAllowlist: ["C-allowed"],
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
      workspace: baseWorkspace,
      channelAllowlist: ["C-allowed"],
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
      asker: { platform: "slack", externalUserId: "U-asker", userName: "alice" },
      config: {
        isEnabled: () => true,
        classify: yesLLM,
        workspace: baseWorkspace,
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
      asker: { platform: "slack", externalUserId: "U-asker", userName: "alice" },
      config: {
        isEnabled: () => true,
        classify: yesLLM,
        workspace: baseWorkspace,
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
      asker: { platform: "slack", externalUserId: "U-asker", userName: "alice" },
      config: {
        isEnabled: () => true,
        classify: yesLLM,
        workspace: baseWorkspace,
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
      workspace: baseWorkspace,
      channelAllowlist: ["C-allowed"],
      workspaceId: "ws_1",
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
      workspace: baseWorkspace,
      channelAllowlist: ["C-allowed"],
      workspaceId: "ws_1",
      isPaused,
      onPauseRequest: mock(async () => {}),
    });
    const thread = makeThread("C-allowed");
    await invoke(thread, makeMessage());
    expect(isPaused).toHaveBeenCalledTimes(1);
    expect(thread._addReaction).toHaveBeenCalledTimes(1);
  });

  it("treats an isPaused throw as not paused (fail open)", async () => {
    const isPaused = mock(async () => {
      throw new Error("DB down");
    });
    const { chat, invokeMessage: invoke } = makeChat();
    const log = makeLogger();
    await registerProactiveListener(chat as unknown as Parameters<typeof registerProactiveListener>[0], log, {
      isEnabled: () => true,
      classify: yesLLM,
      workspace: baseWorkspace,
      channelAllowlist: ["C-allowed"],
      workspaceId: "ws_1",
      isPaused,
      onPauseRequest: mock(async () => {}),
    });
    const thread = makeThread("C-allowed");
    await invoke(thread, makeMessage());
    expect(thread._addReaction).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalled();
  });

  it("@atlas pause in a channel writes a channel-24h row and skips classification", async () => {
    const onPauseRequest = mock(async () => {});
    const classify = mock(yesLLM);
    const { chat, invokeMessage: invoke } = makeChat();
    await registerProactiveListener(chat as unknown as Parameters<typeof registerProactiveListener>[0], makeLogger(), {
      isEnabled: () => true,
      classify,
      workspace: baseWorkspace,
      channelAllowlist: ["C-allowed"],
      workspaceId: "ws_1",
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
      workspace: baseWorkspace,
      channelAllowlist: ["C-allowed"],
      workspaceId: "ws_1",
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
      workspace: baseWorkspace,
      channelAllowlist: ["C-allowed"],
      workspaceId: "ws_1",
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
      workspace: baseWorkspace,
      channelAllowlist: ["C-allowed"],
      workspaceId: "ws_1",
      isPaused: mock(async () => ({ paused: false })),
      onPauseRequest,
    });
    const thread = makeThread("C-allowed");
    await invoke(thread, makeMessage({ text: "@atlas pause" }));
    expect(onPauseRequest).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalled();
  });

  it("is a no-op for kill-switch checks when workspaceId is omitted", async () => {
    const isPaused = mock(async () => ({ paused: true, layer: "workspace-kill" as const }));
    const { chat, invokeMessage: invoke } = makeChat();
    await registerProactiveListener(chat as unknown as Parameters<typeof registerProactiveListener>[0], makeLogger(), {
      isEnabled: () => true,
      classify: yesLLM,
      workspace: baseWorkspace,
      channelAllowlist: ["C-allowed"],
      // No workspaceId — listener should NOT call isPaused.
      isPaused,
    });
    const thread = makeThread("C-allowed");
    await invoke(thread, makeMessage());
    expect(isPaused).not.toHaveBeenCalled();
    expect(thread._addReaction).toHaveBeenCalledTimes(1);
  });
});
