/**
 * #3750 — chat resume-deliverer factory.
 *
 * Pins the integration seam that wires `resumeChatTurn` → `postToThread`:
 *   - unknown platform slug → `failed` (no actor guess);
 *   - `answered` → posts the answer, returns `delivered`;
 *   - `blocked` → posts the user-safe block notice, returns `blocked` (a
 *     fail-closed security refusal, kept distinct from `delivered`);
 *   - `nothing_to_resume` / `failed` from resume pass through (no post);
 *   - a failed post → `failed{thread_post_failed}`;
 *   - the actor binding (externalId/externalUserId) is forwarded to resume.
 */

import { describe, it, expect, beforeEach, mock, type Mock } from "bun:test";
import type { ResumeChatTurnResult } from "../resume-turn";
import type { PostToThread } from "../resume-deliverer-factory";

const mockResumeChatTurn: Mock<(i: unknown) => Promise<ResumeChatTurnResult>> = mock(async () => ({
  status: "answered",
  answer: "the answer",
}));

void mock.module("@atlas/api/lib/chat-plugin/resume-turn", () => ({
  resumeChatTurn: mockResumeChatTurn,
}));

const { buildChatResumeDeliverer } = await import("../resume-deliverer-factory");

const INPUT = {
  conversationId: "conv_1",
  orgId: "org_1",
  platform: "slack",
  threadId: "C1:1.1",
  externalId: "T0123",
  externalUserId: "U999",
};

function delivererWithPost(post: PostToThread) {
  return buildChatResumeDeliverer({ postToThread: post });
}

beforeEach(() => {
  mockResumeChatTurn.mockReset();
  mockResumeChatTurn.mockResolvedValue({ status: "answered", answer: "the answer" });
});

describe("buildChatResumeDeliverer (#3750)", () => {
  it("posts the answer and returns delivered on an answered resume", async () => {
    const posts: Array<[string, string, string]> = [];
    const deliverer = delivererWithPost(async (p, t, m) => {
      posts.push([p, t, m]);
      return { messageId: "m1" };
    });

    const outcome = await deliverer.deliverResumedTurn(INPUT);
    expect(outcome).toEqual({ status: "delivered" });
    expect(posts).toEqual([["slack", "C1:1.1", "the answer"]]);

    // The actor binding is forwarded to resume.
    const resumeArg = mockResumeChatTurn.mock.calls[0]![0] as Record<string, unknown>;
    expect(resumeArg).toMatchObject({
      conversationId: "conv_1",
      orgId: "org_1",
      platform: "slack",
      externalId: "T0123",
      externalUserId: "U999",
    });
  });

  it("posts the block notice and returns blocked (distinct from delivered) on a blocked resume", async () => {
    mockResumeChatTurn.mockResolvedValueOnce({ status: "blocked", message: "Workspace suspended." });
    const posts: string[] = [];
    const deliverer = delivererWithPost(async (_p, _t, m) => {
      posts.push(m);
      return { messageId: "m2" };
    });

    const outcome = await deliverer.deliverResumedTurn(INPUT);
    expect(outcome).toEqual({ status: "blocked" });
    // The user-safe block reason is what gets posted, not an answer.
    expect(posts).toEqual(["Workspace suspended."]);
  });

  it("fails on an unknown platform slug without calling resume", async () => {
    const deliverer = delivererWithPost(async () => ({ messageId: "x" }));
    const outcome = await deliverer.deliverResumedTurn({ ...INPUT, platform: "irc" });
    expect(outcome).toEqual({ status: "failed", reason: "unknown_platform:irc" });
    expect(mockResumeChatTurn).not.toHaveBeenCalled();
  });

  it("passes through nothing_to_resume without posting", async () => {
    mockResumeChatTurn.mockResolvedValueOnce({ status: "nothing_to_resume" });
    let posted = false;
    const deliverer = delivererWithPost(async () => { posted = true; return { messageId: "x" }; });
    const outcome = await deliverer.deliverResumedTurn(INPUT);
    expect(outcome).toEqual({ status: "nothing_to_resume" });
    expect(posted).toBe(false);
  });

  it("passes through a failed resume without posting", async () => {
    mockResumeChatTurn.mockResolvedValueOnce({ status: "failed", reason: "agent_run_error" });
    const deliverer = delivererWithPost(async () => ({ messageId: "x" }));
    const outcome = await deliverer.deliverResumedTurn(INPUT);
    expect(outcome).toEqual({ status: "failed", reason: "agent_run_error" });
  });

  it("returns failed{thread_post_failed} when the post fails", async () => {
    const deliverer = delivererWithPost(async () => null);
    const outcome = await deliverer.deliverResumedTurn(INPUT);
    expect(outcome).toEqual({ status: "failed", reason: "thread_post_failed" });
  });

  it("omits externalUserId from the resume call when absent", async () => {
    const deliverer = delivererWithPost(async () => ({ messageId: "x" }));
    const { externalUserId: _omit, ...noUser } = INPUT;
    await deliverer.deliverResumedTurn(noUser);
    const resumeArg = mockResumeChatTurn.mock.calls[0]![0] as Record<string, unknown>;
    expect(resumeArg).not.toHaveProperty("externalUserId");
  });
});
