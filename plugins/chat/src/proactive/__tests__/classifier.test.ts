/**
 * Tests for the proactive `MessageClassifier`.
 *
 * The LLM is mocked at the injection boundary — we never test the
 * prompt or the model's output shape. We test:
 *
 *  - regex prefilter accepts/rejects the right messages
 *  - classify-all mode invokes the LLM on anything substantial
 *  - regex-prefilter mode short-circuits when the prefilter rejects
 *  - LLM exceptions degrade gracefully to "not a question"
 */

import { describe, expect, it, mock } from "bun:test";
import {
  classifyMessage,
  regexPreFilter,
} from "../classifier";
import type { LLMClassifierFn } from "../types";

// ---------------------------------------------------------------------------
// regexPreFilter
// ---------------------------------------------------------------------------

describe("regexPreFilter", () => {
  it("accepts a direct question with a question mark", () => {
    expect(regexPreFilter("what was MRR last month?")).toBe(true);
  });

  it("accepts a question starting with 'how' even without a question mark", () => {
    expect(regexPreFilter("how many signups did we get yesterday")).toBe(true);
  });

  it("accepts a question following a greeting and comma", () => {
    expect(regexPreFilter("Hey, what was MRR last month?")).toBe(true);
  });

  it("rejects a statement without question markers", () => {
    expect(regexPreFilter("we shipped the dashboard rewrite")).toBe(false);
  });

  it("rejects empty or near-empty messages", () => {
    expect(regexPreFilter("")).toBe(false);
    expect(regexPreFilter("hi")).toBe(false);
  });

  it("rejects extremely long messages (cost guard)", () => {
    const long = "this is a long message ".repeat(200) + "?";
    expect(regexPreFilter(long)).toBe(false);
  });

  it("rejects non-string input", () => {
    // @ts-expect-error — deliberate runtime check
    expect(regexPreFilter(null)).toBe(false);
    // @ts-expect-error — deliberate runtime check
    expect(regexPreFilter(undefined)).toBe(false);
  });

  it("accepts messages starting with 'anyone'", () => {
    expect(regexPreFilter("anyone got the latest revenue numbers")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// classifyMessage — regex-prefilter mode
// ---------------------------------------------------------------------------

describe("classifyMessage (regex-prefilter)", () => {
  it("short-circuits without invoking the LLM on a clear non-question", async () => {
    const llm: LLMClassifierFn = mock(async () => ({
      isQuestion: true,
      confidence: 0.99,
    }));

    const result = await classifyMessage({
      text: "shipping the dashboard rewrite tomorrow",
      mode: "regex-prefilter",
      llm,
    });

    expect(result.candidate).toBe(false);
    expect(result.llmInvoked).toBe(false);
    expect(result.isQuestion).toBe(false);
    expect(result.confidence).toBe(0);
    expect(llm).not.toHaveBeenCalled();
  });

  it("invokes the LLM when the prefilter accepts a candidate", async () => {
    const llm: LLMClassifierFn = mock(async () => ({
      isQuestion: true,
      confidence: 0.92,
      reasoning: "explicit MRR question",
    }));

    const result = await classifyMessage({
      text: "what was MRR last month?",
      mode: "regex-prefilter",
      llm,
    });

    expect(result.candidate).toBe(true);
    expect(result.llmInvoked).toBe(true);
    expect(result.isQuestion).toBe(true);
    expect(result.confidence).toBe(0.92);
    expect(result.reasoning).toBe("explicit MRR question");
    expect(llm).toHaveBeenCalledTimes(1);
  });

  it("respects LLM verdict even when prefilter accepts (false-positive guard)", async () => {
    const llm: LLMClassifierFn = mock(async () => ({
      isQuestion: false,
      confidence: 0.1,
    }));

    const result = await classifyMessage({
      text: "is there pizza in the office today?",
      mode: "regex-prefilter",
      llm,
    });

    expect(result.candidate).toBe(true);
    expect(result.llmInvoked).toBe(true);
    expect(result.isQuestion).toBe(false);
    expect(result.confidence).toBe(0.1);
  });

  it("fails closed when the LLM throws", async () => {
    const llm: LLMClassifierFn = mock(async () => {
      throw new Error("model timeout");
    });

    const result = await classifyMessage({
      text: "what was MRR last month?",
      mode: "regex-prefilter",
      llm,
    });

    expect(result.isQuestion).toBe(false);
    expect(result.confidence).toBe(0);
    expect(result.llmInvoked).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// classifyMessage — classify-all mode
// ---------------------------------------------------------------------------

describe("classifyMessage (classify-all)", () => {
  it("invokes the LLM on a message the prefilter would reject", async () => {
    const llm: LLMClassifierFn = mock(async () => ({
      isQuestion: true,
      confidence: 0.78,
      reasoning: "indirect question via 'curious about'",
    }));

    const result = await classifyMessage({
      text: "curious about MRR last month",
      mode: "classify-all",
      llm,
    });

    expect(result.candidate).toBe(true);
    expect(result.llmInvoked).toBe(true);
    expect(result.isQuestion).toBe(true);
    expect(result.confidence).toBe(0.78);
  });

  it("still skips trivially-short messages to avoid wasted LLM spend", async () => {
    const llm: LLMClassifierFn = mock(async () => ({
      isQuestion: true,
      confidence: 0.99,
    }));

    const result = await classifyMessage({
      text: "hi",
      mode: "classify-all",
      llm,
    });

    expect(result.llmInvoked).toBe(false);
    expect(result.isQuestion).toBe(false);
    expect(llm).not.toHaveBeenCalled();
  });
});
