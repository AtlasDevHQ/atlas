/**
 * Tests for the proactive feedback collector pure helpers + `RecentAnswers`
 * registry. End-to-end wiring (button → collector, modal → collector,
 * slash → collector) is exercised in `listener.test.ts`.
 */

import { describe, expect, it } from "bun:test";
import {
  outcomeForActionId,
  parseFeedbackSlashArgs,
  PROACTIVE_FB_HELPFUL_ACTION_ID,
  PROACTIVE_FB_NOT_HELPFUL_ACTION_ID,
  PROACTIVE_FB_WRONG_DATA_ACTION_ID,
  RECENT_ANSWER_TTL_MS,
  RecentAnswers,
} from "../feedback";

// ---------------------------------------------------------------------------
// outcomeForActionId
// ---------------------------------------------------------------------------

describe("outcomeForActionId", () => {
  it("maps each button action id to its outcome", () => {
    expect(outcomeForActionId(PROACTIVE_FB_HELPFUL_ACTION_ID)).toBe("helpful");
    expect(outcomeForActionId(PROACTIVE_FB_NOT_HELPFUL_ACTION_ID)).toBe("not-helpful");
    expect(outcomeForActionId(PROACTIVE_FB_WRONG_DATA_ACTION_ID)).toBe("wrong-data");
  });

  it("returns null for unrelated action ids", () => {
    expect(outcomeForActionId("atlas_run_again")).toBeNull();
    expect(outcomeForActionId("")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseFeedbackSlashArgs
// ---------------------------------------------------------------------------

describe("parseFeedbackSlashArgs", () => {
  it("returns the text after a `feedback ` prefix", () => {
    expect(parseFeedbackSlashArgs("feedback MRR figure is stale")).toEqual({
      kind: "feedback",
      text: "MRR figure is stale",
    });
  });

  it("accepts `feedback: <text>` and `feedback - <text>`", () => {
    expect(parseFeedbackSlashArgs("feedback: please tighten the date range")).toEqual({
      kind: "feedback",
      text: "please tighten the date range",
    });
    expect(parseFeedbackSlashArgs("feedback - too noisy")).toEqual({
      kind: "feedback",
      text: "too noisy",
    });
  });

  it("treats a bare `feedback` (no text) as a feedback invocation with empty body", () => {
    expect(parseFeedbackSlashArgs("feedback")).toEqual({ kind: "feedback", text: "" });
    expect(parseFeedbackSlashArgs("  feedback  ")).toEqual({ kind: "feedback", text: "" });
  });

  it("returns not-feedback for unrelated args", () => {
    expect(parseFeedbackSlashArgs("how many users last month")).toEqual({ kind: "not-feedback" });
    expect(parseFeedbackSlashArgs(undefined)).toEqual({ kind: "not-feedback" });
    expect(parseFeedbackSlashArgs("")).toEqual({ kind: "not-feedback" });
  });

  it("is case-insensitive on the keyword", () => {
    expect(parseFeedbackSlashArgs("Feedback this answer is wrong")).toEqual({
      kind: "feedback",
      text: "this answer is wrong",
    });
  });
});

// ---------------------------------------------------------------------------
// RecentAnswers
// ---------------------------------------------------------------------------

describe("RecentAnswers", () => {
  it("records and looks up a single entry", () => {
    const reg = new RecentAnswers();
    reg.record("C1", "U1", {
      threadId: "T1",
      answerMessageId: "M1",
      question: "what was MRR",
      answer: "MRR was $X",
    });
    const got = reg.lookup("C1", "U1");
    expect(got?.answerMessageId).toBe("M1");
    expect(got?.question).toBe("what was MRR");
  });

  it("namespaces by both channel and user", () => {
    const reg = new RecentAnswers();
    reg.record("C1", "U1", { threadId: "T1", answerMessageId: "M1", question: "a", answer: "A" });
    reg.record("C1", "U2", { threadId: "T1", answerMessageId: "M2", question: "b", answer: "B" });
    reg.record("C2", "U1", { threadId: "T2", answerMessageId: "M3", question: "c", answer: "C" });

    expect(reg.lookup("C1", "U1")?.answerMessageId).toBe("M1");
    expect(reg.lookup("C1", "U2")?.answerMessageId).toBe("M2");
    expect(reg.lookup("C2", "U1")?.answerMessageId).toBe("M3");
    expect(reg.lookup("C2", "U2")).toBeNull();
  });

  it("expires entries past the TTL", () => {
    let now = 1_000;
    const reg = new RecentAnswers(RECENT_ANSWER_TTL_MS, 100, () => now);
    reg.record("C1", "U1", { threadId: "T1", answerMessageId: "M1", question: "q", answer: "a" });
    now += RECENT_ANSWER_TTL_MS + 1;
    expect(reg.lookup("C1", "U1")).toBeNull();
  });

  it("overwrites prior entries for the same (channel, user)", () => {
    const reg = new RecentAnswers();
    reg.record("C1", "U1", { threadId: "T1", answerMessageId: "M1", question: "first", answer: "A" });
    reg.record("C1", "U1", { threadId: "T1", answerMessageId: "M2", question: "second", answer: "B" });
    expect(reg.lookup("C1", "U1")?.answerMessageId).toBe("M2");
    expect(reg.size()).toBe(1);
  });
});
