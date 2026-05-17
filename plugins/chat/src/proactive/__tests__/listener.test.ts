/**
 * Tests for the proactive listener wiring.
 *
 * We exercise the handler by capturing the function passed to
 * `chat.onNewMessage(/.+/, handler)` and invoking it directly with
 * fake thread + message objects. That keeps the test free of any real
 * Chat SDK plumbing while still proving the wiring is correct.
 */

import { describe, expect, it, mock } from "bun:test";
import {
  registerProactiveListener,
  resolveChannelAllowlist,
  PROACTIVE_REACTION,
} from "../listener";
import type { LLMClassifierFn, WorkspaceProactiveConfig } from "../types";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

type ChannelMessageHandler = (
  thread: ReturnType<typeof makeThread>,
  message: ReturnType<typeof makeMessage>,
) => Promise<void> | void;

function makeLogger() {
  return {
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
    debug: mock(() => {}),
  };
}

function makeChat() {
  let captured: ChannelMessageHandler | null = null;
  const chat = {
    onNewMessage: mock((_pattern: RegExp, handler: ChannelMessageHandler) => {
      captured = handler;
    }),
  };
  return {
    chat,
    invoke: async (
      thread: ReturnType<typeof makeThread>,
      message: ReturnType<typeof makeMessage>,
    ) => {
      if (!captured) throw new Error("listener never registered a handler");
      await captured(thread, message);
    },
    isRegistered: () => captured !== null,
  };
}

function makeThread(channelId = "C-allowed", reaction?: ReturnType<typeof mock>) {
  const addReaction = reaction ?? mock(async () => {});
  return {
    channelId,
    createSentMessageFromMessage: mock(() => ({
      addReaction,
    })),
    _addReaction: addReaction,
  };
}

function makeMessage(opts: {
  id?: string;
  text?: string;
  isBot?: boolean | "unknown";
  isMe?: boolean;
} = {}) {
  return {
    id: opts.id ?? "M1",
    text: opts.text ?? "what was MRR last month?",
    author: {
      isBot: opts.isBot ?? false,
      isMe: opts.isMe ?? false,
      userId: "U1",
      userName: "asker",
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

  it("registers when isEnabled() is true", async () => {
    const { chat, isRegistered } = makeChat();
    await registerProactiveListener(chat as any, makeLogger(), {
      isEnabled: () => true,
      classify: yesLLM,
      workspace: baseWorkspace,
      channelAllowlist: ["C-allowed"],
    });
    expect(isRegistered()).toBe(true);
    expect(chat.onNewMessage).toHaveBeenCalledTimes(1);
  });
});

describe("registerProactiveListener — handler behaviour", () => {
  it("adds a reaction when the channel is allowed and the classifier is confident", async () => {
    const { chat, invoke } = makeChat();
    await registerProactiveListener(chat as any, makeLogger(), {
      isEnabled: () => true,
      classify: yesLLM,
      workspace: baseWorkspace,
      channelAllowlist: ["C-allowed"],
    });
    const thread = makeThread("C-allowed");
    await invoke(thread, makeMessage());
    expect(thread._addReaction).toHaveBeenCalledTimes(1);
    expect(thread._addReaction).toHaveBeenCalledWith(PROACTIVE_REACTION);
  });

  it("does not react when the channel is outside the allowlist", async () => {
    const { chat, invoke } = makeChat();
    await registerProactiveListener(chat as any, makeLogger(), {
      isEnabled: () => true,
      classify: yesLLM,
      workspace: baseWorkspace,
      channelAllowlist: ["C-allowed"],
    });
    const thread = makeThread("C-other");
    await invoke(thread, makeMessage());
    expect(thread._addReaction).not.toHaveBeenCalled();
  });

  it("does not react when the gate flips off between registration and the message", async () => {
    let gateOn = true;
    const { chat, invoke } = makeChat();
    await registerProactiveListener(chat as any, makeLogger(), {
      isEnabled: () => gateOn,
      classify: yesLLM,
      workspace: baseWorkspace,
      channelAllowlist: ["C-allowed"],
    });
    gateOn = false;
    const thread = makeThread("C-allowed");
    await invoke(thread, makeMessage());
    expect(thread._addReaction).not.toHaveBeenCalled();
  });

  it("does not react to messages from bots", async () => {
    const { chat, invoke } = makeChat();
    await registerProactiveListener(chat as any, makeLogger(), {
      isEnabled: () => true,
      classify: yesLLM,
      workspace: baseWorkspace,
      channelAllowlist: ["C-allowed"],
    });
    const thread = makeThread("C-allowed");
    await invoke(thread, makeMessage({ isBot: true }));
    expect(thread._addReaction).not.toHaveBeenCalled();
  });

  it("does not react when the classifier returns low confidence", async () => {
    const { chat, invoke } = makeChat();
    await registerProactiveListener(chat as any, makeLogger(), {
      isEnabled: () => true,
      classify: noLLM,
      workspace: baseWorkspace,
      channelAllowlist: ["C-allowed"],
    });
    const thread = makeThread("C-allowed");
    await invoke(thread, makeMessage());
    expect(thread._addReaction).not.toHaveBeenCalled();
  });

  it("rate-limits a chatty channel — only one reaction inside the cooldown", async () => {
    const { chat, invoke } = makeChat();
    await registerProactiveListener(chat as any, makeLogger(), {
      isEnabled: () => true,
      classify: yesLLM,
      workspace: baseWorkspace,
      channelAllowlist: ["C-allowed"],
    });
    const thread = makeThread("C-allowed");
    await invoke(thread, makeMessage({ id: "M1" }));
    await invoke(thread, makeMessage({ id: "M2" }));
    expect(thread._addReaction).toHaveBeenCalledTimes(1);
  });

  it("does not throw when addReaction fails — failures are best-effort", async () => {
    const reaction = mock(async () => {
      throw new Error("slack rate limit");
    });
    const { chat, invoke } = makeChat();
    const log = makeLogger();
    await registerProactiveListener(chat as any, log, {
      isEnabled: () => true,
      classify: yesLLM,
      workspace: baseWorkspace,
      channelAllowlist: ["C-allowed"],
    });
    const thread = makeThread("C-allowed", reaction);
    await invoke(thread, makeMessage());
    expect(log.warn).toHaveBeenCalled();
  });
});
