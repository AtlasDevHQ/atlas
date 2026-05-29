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

  it("requires whitespace or a `:`/`-` separator after the keyword", () => {
    // The keyword must abut end-of-string or one of {whitespace, :, -}.
    // Trailing word chars or other punctuation are not invocations.
    expect(parseFeedbackSlashArgs("feedbackhello")).toEqual({ kind: "not-feedback" });
    expect(parseFeedbackSlashArgs("feedback123")).toEqual({ kind: "not-feedback" });
    expect(parseFeedbackSlashArgs("feedback.note")).toEqual({ kind: "not-feedback" });
    expect(parseFeedbackSlashArgs("feedback@x")).toEqual({ kind: "not-feedback" });
  });

  it("treats a bare separator (no body) as an empty feedback invocation", () => {
    expect(parseFeedbackSlashArgs("feedback:")).toEqual({ kind: "feedback", text: "" });
    expect(parseFeedbackSlashArgs("feedback -")).toEqual({ kind: "feedback", text: "" });
  });

  it("handles a huge whitespace-only body without choking", () => {
    // The original `js/polynomial-redos` finding is on the regex *shape*
    // (`(?:\s*[:-]\s*|\s+)(.+)`); CodeQL guards reintroduction since it
    // flags that pattern directly. This case just exercises the strips on
    // a large separator run — they consume it in one anchored pass and
    // collapse to an empty body. (An absolute-time assertion would be a
    // false guard here anyway: the leading `args.trim()` already neutered
    // every catastrophic input for the old regex too.)
    const input = `feedback${"\t".repeat(100_000)}`;
    expect(parseFeedbackSlashArgs(input)).toEqual({ kind: "feedback", text: "" });
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
