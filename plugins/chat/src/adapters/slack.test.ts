/**
 * Mention-detection regression tests for the Slack adapter wrapper (#4909).
 *
 * The bug: in multi-workspace deploys an @-mention that arrives as a plain
 * `message` event (which happens whenever `message.channels` /
 * `message.groups` are subscribed alongside `app_mention` — Slack sends
 * BOTH, and the SDK dedupes them by shared `ts`, so only the first-processed
 * one survives) was never recognised as a mention, and fell through to the
 * pattern handlers instead of the mention handler.
 *
 * These drive the REAL `Chat` dispatch rather than reimplementing
 * `detectMention`, so they fail if the SDK changes how `isMention` is
 * resolved — which is the thing worth knowing about.
 */

import { describe, expect, it } from "bun:test";
import { createSlackAdapter } from "./slack";
import { DEFAULT_BOT_USER_NAME } from "../config";

const BASE = {
  signingSecret: "x".repeat(32),
  clientId: "cid",
  clientSecret: "csec",
  encryptionKey: Buffer.alloc(32).toString("base64"),
};

describe("createSlackAdapter — mention detection wiring", () => {
  it("sets userName so it does not fall back to the adapter's 'bot' default", () => {
    const a = createSlackAdapter(BASE) as unknown as { userName: string };
    // "bot" is `@chat-adapter/slack`'s ctor default, replaced only inside
    // initialize() from auth.test — which multi-workspace never runs. It is
    // truthy, so it SHADOWS chat.userName in `adapter.userName ||
    // chat.userName` and makes name matching impossible.
    expect(a.userName).not.toBe("bot");
    expect(a.userName).toBe(DEFAULT_BOT_USER_NAME);
  });

  it("honours an explicit userName override for a renamed bot", () => {
    const a = createSlackAdapter({ ...BASE, userName: "datapal" }) as unknown as {
      userName: string;
    };
    expect(a.userName).toBe("datapal");
  });
});

describe("Chat dispatch — @-mention arriving as a plain message event", () => {
  /**
   * Build a real `Chat` around the real Slack adapter and record which
   * handler chain a message lands in.
   */
  async function dispatch(text: string) {
    const { Chat } = await import("chat");
    const { createStateAdapter } = await import("../state");
    const state = createStateAdapter({ backend: "memory" }, null);
    await state.connect();

    const adapter = createSlackAdapter(BASE);
    const chat = new Chat({
      userName: DEFAULT_BOT_USER_NAME,
      adapters: { slack: adapter },
      state,
    });

    const hits: string[] = [];
    chat.onNewMention(async () => { hits.push("mention"); });
    chat.onNewMessage(/.+/, async () => { hits.push("pattern"); });

    // A plain `message` event — `isMention` unset, exactly what Slack
    // delivers for message.channels. The bot's own <@id> has already been
    // rewritten to its display name by resolveInlineMentions, so no user
    // id survives in the text; name matching is the only route left.
    const msg = (adapter as unknown as {
      parseSlackMessageSync: (e: unknown, t: string) => unknown;
    }).parseSlackMessageSync(
      { ts: "1700000000.0001", text, user: "U0HUMAN", channel: "C1" },
      "slack:C1:1700000000.0001",
    );

    chat.processMessage(
      adapter as never,
      "slack:C1:1700000000.0001",
      msg as never,
    );
    // processMessage is fire-and-forget; let its async chain settle.
    await new Promise((r) => setTimeout(r, 150));
    await chat.shutdown?.();
    return hits;
  }

  it("routes a display-name mention to the mention handler, not the pattern chain", async () => {
    // What production actually sees post-resolveInlineMentions.
    expect(await dispatch("@Atlas what is MRR?")).toContain("mention");
  });

  it("still routes an unrelated message to the pattern chain", async () => {
    // The negative: proactive must keep seeing ordinary channel chatter,
    // or this "fix" would silently swallow the proactive pillar's input.
    const hits = await dispatch("deploy went out this morning");
    expect(hits).toContain("pattern");
    expect(hits).not.toContain("mention");
  });
});
