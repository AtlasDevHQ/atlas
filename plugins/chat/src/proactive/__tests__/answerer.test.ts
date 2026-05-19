/**
 * Tests for the reaction-to-answer registry + gating logic.
 *
 * The `PendingAnswers` registry is in-memory and TTL-pruned; the
 * `shouldAnswerOnReaction` function is a pure decision over the
 * cartesian product of (added/removed × self/other × known/unknown).
 */

import { describe, expect, it } from "bun:test";
import {
  PendingAnswers,
  PENDING_ANSWER_TTL_MS,
  shouldAnswerOnReaction,
  type ProactiveAsker,
} from "../answerer";
import {
  assertExternalUserId,
  assertWorkspaceId,
} from "../identity";

const ASKER: ProactiveAsker = {
  platform: "slack",
  externalUserId: assertExternalUserId("U-asker"),
  userName: "alice",
};
const WS_1 = assertWorkspaceId("ws-1");

// ---------------------------------------------------------------------------
// PendingAnswers
// ---------------------------------------------------------------------------

describe("PendingAnswers", () => {
  it("records and consumes a single entry", () => {
    const reg = new PendingAnswers();
    reg.record("T1", "M1", { text: "what was MRR last month?", asker: ASKER, workspaceId: WS_1 });
    expect(reg.size()).toBe(1);

    const peek = reg.peek("T1", "M1");
    expect(peek?.text).toBe("what was MRR last month?");

    const consumed = reg.consume("T1", "M1");
    expect(consumed?.text).toBe("what was MRR last month?");
    expect(reg.consume("T1", "M1")).toBeNull();
    expect(reg.size()).toBe(0);
  });

  it("expires entries past the TTL", () => {
    let now = 1_000_000;
    const reg = new PendingAnswers(PENDING_ANSWER_TTL_MS, 100, () => now);
    reg.record("T1", "M1", { text: "q?", asker: ASKER, workspaceId: WS_1 });

    now += PENDING_ANSWER_TTL_MS + 1;
    expect(reg.peek("T1", "M1")).toBeNull();
    expect(reg.consume("T1", "M1")).toBeNull();
  });

  it("evicts the oldest entry when over the cap", () => {
    const reg = new PendingAnswers(PENDING_ANSWER_TTL_MS, 2);
    reg.record("T1", "M1", { text: "first", asker: ASKER, workspaceId: WS_1 });
    reg.record("T1", "M2", { text: "second", asker: ASKER, workspaceId: WS_1 });
    reg.record("T1", "M3", { text: "third", asker: ASKER, workspaceId: WS_1 });

    expect(reg.peek("T1", "M1")).toBeNull();
    expect(reg.peek("T1", "M2")?.text).toBe("second");
    expect(reg.peek("T1", "M3")?.text).toBe("third");
    expect(reg.size()).toBe(2);
  });

  it("namespaces entries by thread and message id", () => {
    const reg = new PendingAnswers();
    reg.record("T1", "M1", { text: "a", asker: ASKER, workspaceId: WS_1 });
    reg.record("T2", "M1", { text: "b", asker: ASKER, workspaceId: WS_1 });
    expect(reg.consume("T1", "M1")?.text).toBe("a");
    expect(reg.consume("T2", "M1")?.text).toBe("b");
  });
});

// ---------------------------------------------------------------------------
// shouldAnswerOnReaction
// ---------------------------------------------------------------------------

describe("shouldAnswerOnReaction", () => {
  const pending = { text: "q?", asker: ASKER, workspaceId: WS_1, recordedAt: 0 };

  it("answers when a non-bot user adds the reaction to a known message", () => {
    const decision = shouldAnswerOnReaction({
      added: true,
      reactor: { isMe: false, isBot: false, userId: "U-other" },
      pending,
    });
    expect(decision.action).toBe("answer");
  });

  it("skips when the reaction is removed (not added)", () => {
    const decision = shouldAnswerOnReaction({
      added: false,
      reactor: { isMe: false, isBot: false, userId: "U-other" },
      pending,
    });
    expect(decision).toEqual({ action: "skip", reason: "removed" });
  });

  it("skips when the reactor is the bot itself", () => {
    const decision = shouldAnswerOnReaction({
      added: true,
      reactor: { isMe: true, isBot: true, userId: "B-atlas" },
      pending,
    });
    expect(decision).toEqual({ action: "skip", reason: "self-reaction" });
  });

  it("skips when the reactor is another bot", () => {
    const decision = shouldAnswerOnReaction({
      added: true,
      reactor: { isMe: false, isBot: true, userId: "B-other" },
      pending,
    });
    expect(decision).toEqual({ action: "skip", reason: "self-reaction" });
  });

  it("skips when there is no pending entry (e.g. expired or unrelated message)", () => {
    const decision = shouldAnswerOnReaction({
      added: true,
      reactor: { isMe: false, isBot: false, userId: "U-other" },
      pending: null,
    });
    expect(decision).toEqual({ action: "skip", reason: "unknown-message" });
  });
});
