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
  PROACTIVE_REACTION,
  registerProactiveListener,
  resolveChannelAllowlist,
} from "../listener";
import {
  PROACTIVE_ANSWER_ACTION_ID,
  PROACTIVE_DISMISS_ACTION_ID,
} from "../../cards/proactive-answer-card";
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

  const chat = {
    onNewMessage: mock((_pattern: RegExp, handler: AnyHandler) => {
      messageHandler = handler;
    }),
    onReaction: mock((_filter: unknown[], handler: AnyHandler) => {
      reactionHandler = handler;
    }),
    onAction: mock((actionId: string, handler: AnyHandler) => {
      actionHandlers.set(actionId, handler);
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
    isRegistered: () => messageHandler !== null,
    handlerCount: () => actionHandlers.size,
  };
}

interface ThreadDouble {
  channelId: string;
  createSentMessageFromMessage: ReturnType<typeof mock>;
  postEphemeral: ReturnType<typeof mock>;
  post: ReturnType<typeof mock>;
  subscribe: ReturnType<typeof mock>;
  _addReaction: ReturnType<typeof mock>;
}

function makeThread(channelId = "C-allowed"): ThreadDouble {
  const addReaction = mock(async () => {});
  return {
    channelId,
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

  it("registers all three handler types when enabled", async () => {
    const { chat, isRegistered, handlerCount } = makeChat();
    await registerProactiveListener(chat as any, makeLogger(), {
      isEnabled: () => true,
      classify: yesLLM,
      workspace: baseWorkspace,
      channelAllowlist: ["C-allowed"],
    });
    expect(isRegistered()).toBe(true);
    expect(chat.onNewMessage).toHaveBeenCalledTimes(1);
    expect(chat.onReaction).toHaveBeenCalledTimes(1);
    expect(handlerCount()).toBe(2); // Yes,answer + Not now
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
