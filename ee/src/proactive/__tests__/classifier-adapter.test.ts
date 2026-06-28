/**
 * Tests for the proactive classifier adapter (slice 2b of #2607).
 *
 * The adapter is a thin wrapper that:
 *   - Yields `AtlasAiModel` from a `ManagedRuntime` to get the
 *     configured LLM.
 *   - Calls `generateText` with a tight question-detection prompt.
 *   - Parses + Zod-validates the JSON response.
 *   - Fails closed on any error.
 *
 * We inject a fake `generateText` via the adapter's `options.generateText`
 * hook so we control the model's response without needing to instantiate
 * a real provider. The `AtlasAiModel` Tag is satisfied by
 * `createAiModelTestLayer()` from `@atlas/api/lib/effect/ai`. Effect's
 * `ManagedRuntime.make(layer)` materialises the layer once per test.
 */

import { describe, it, expect, beforeEach, mock, type Mock } from "bun:test";
import { ManagedRuntime } from "effect";
import type { generateText } from "ai";

import {
  AtlasAiModel,
  createAiModelTestLayer,
} from "@atlas/api/lib/effect/ai";

// --- Logger mock — silences the warn-on-failure path so test output stays clean,
//     while letting us assert the warn call site fired.
const warnSpy: Mock<(...args: unknown[]) => void> = mock(() => {});
mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    info: () => {},
    warn: warnSpy,
    error: () => {},
    debug: () => {},
  }),
}));

const { createProactiveClassifier, __testing } = await import(
  "../classifier-adapter"
);

// --- Test helpers ---------------------------------------------------------

type GenerateTextResult = { text: string };
type GenerateTextFn = typeof generateText;

/**
 * Build a fake `generateText` function that returns a fixed text body
 * (or throws). The real `generateText` returns dozens of fields the
 * adapter never reads — we cast through `unknown` so the parameter
 * type-checks without re-declaring the SDK's response surface.
 */
function fakeGenerate(
  outcome: { text: string } | { throws: Error },
): GenerateTextFn {
  const fn = async (): Promise<GenerateTextResult> => {
    if ("throws" in outcome) throw outcome.throws;
    return { text: outcome.text };
  };
  return fn as unknown as GenerateTextFn;
}

/**
 * Build a fake `generateText` that records the call options (so tests
 * can assert prompt + temperature invariants) and returns a stub body.
 */
function recordingGenerate(
  body: string,
  sink: Array<Record<string, unknown>>,
): GenerateTextFn {
  const fn = async (opts: Record<string, unknown>): Promise<GenerateTextResult> => {
    sink.push(opts);
    return { text: body };
  };
  return fn as unknown as GenerateTextFn;
}

function makeRuntime(): ManagedRuntime.ManagedRuntime<AtlasAiModel, never> {
  return ManagedRuntime.make(createAiModelTestLayer());
}

beforeEach(() => {
  warnSpy.mockClear();
});

// --- Happy paths ----------------------------------------------------------

describe("createProactiveClassifier — positive cases", () => {
  it("returns isQuestion=true for a confident-question response", async () => {
    const runtime = makeRuntime();
    const classify = createProactiveClassifier(runtime, {
      generateText: fakeGenerate({
        text: JSON.stringify({ isQuestion: true, confidence: 0.9 }),
      }),
    });

    const result = await classify("what was MRR last month?");
    expect(result).toEqual({ isQuestion: true, confidence: 0.9 });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("returns isQuestion=false for a confident-non-question response", async () => {
    const runtime = makeRuntime();
    const classify = createProactiveClassifier(runtime, {
      generateText: fakeGenerate({
        text: JSON.stringify({ isQuestion: false, confidence: 0.95 }),
      }),
    });

    const result = await classify("good morning team!");
    expect(result).toEqual({ isQuestion: false, confidence: 0.95 });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("passes ambiguous low-confidence results through unfiltered (gating lives in the policy layer)", async () => {
    // The adapter must NOT enforce a sensitivity threshold here — that
    // is the listener's `policy.ts` job, gated by workspace
    // `SensitivityPreset`. Filtering at the adapter layer would deny the
    // listener the ability to distinguish "model unsure" from "model
    // certainly no" (both would collapse to isQuestion=false).
    const runtime = makeRuntime();
    const classify = createProactiveClassifier(runtime, {
      generateText: fakeGenerate({
        text: JSON.stringify({ isQuestion: true, confidence: 0.3 }),
      }),
    });

    const result = await classify("anyone seen the dashboard?");
    expect(result).toEqual({ isQuestion: true, confidence: 0.3 });
  });

  it("strips a ```json fence the model may add despite the strict-JSON instruction", async () => {
    const runtime = makeRuntime();
    const classify = createProactiveClassifier(runtime, {
      generateText: fakeGenerate({
        text: "```json\n" + JSON.stringify({ isQuestion: true, confidence: 0.8 }) + "\n```",
      }),
    });

    const result = await classify("what was signups yesterday?");
    expect(result).toEqual({ isQuestion: true, confidence: 0.8 });
  });
});

// --- Fail-closed paths ----------------------------------------------------

describe("createProactiveClassifier — fail-closed cases", () => {
  it("returns FAIL_CLOSED + log.warn when the model invocation throws", async () => {
    const runtime = makeRuntime();
    const classify = createProactiveClassifier(runtime, {
      generateText: fakeGenerate({ throws: new Error("provider 503") }),
    });

    const result = await classify("how many users signed up?");
    expect(result).toEqual(__testing.FAIL_CLOSED);
    expect(warnSpy).toHaveBeenCalledTimes(1);

    // textPreview is the canonical forensic field — assert the
    // call site captured it (and clipped at 80 chars per the spec).
    const [payload] = warnSpy.mock.calls[0] as [{ textPreview: string; err: string }];
    expect(payload.textPreview).toBe("how many users signed up?");
    expect(payload.err).toContain("provider 503");
  });

  it("returns FAIL_CLOSED + log.warn when the model returns malformed JSON", async () => {
    const runtime = makeRuntime();
    const classify = createProactiveClassifier(runtime, {
      generateText: fakeGenerate({ text: "not json {" }),
    });

    const result = await classify("hey what's up?");
    expect(result).toEqual(__testing.FAIL_CLOSED);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("returns FAIL_CLOSED + log.warn when the JSON violates the schema (wrong type)", async () => {
    const runtime = makeRuntime();
    const classify = createProactiveClassifier(runtime, {
      generateText: fakeGenerate({
        text: JSON.stringify({ isQuestion: "yes", confidence: 0.7 }),
      }),
    });

    const result = await classify("is the dashboard broken?");
    expect(result).toEqual(__testing.FAIL_CLOSED);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [payload] = warnSpy.mock.calls[0] as [{ err: string }];
    // The error message should reference the schema validation failure
    // so an operator scanning logs sees the rejection class.
    expect(payload.err).toContain("schema validation");
  });

  it("returns FAIL_CLOSED + log.warn when the JSON violates the schema (confidence out of range)", async () => {
    // Confidence must be in [0, 1]. The Zod schema rejects out-of-range
    // values so a misbehaving model can't propagate a 2.0 into the
    // listener's `policy.decideInterjection` (which would then accept
    // a noise message because the threshold trivially passes).
    const runtime = makeRuntime();
    const classify = createProactiveClassifier(runtime, {
      generateText: fakeGenerate({
        text: JSON.stringify({ isQuestion: true, confidence: 1.5 }),
      }),
    });

    const result = await classify("what is churn?");
    expect(result).toEqual(__testing.FAIL_CLOSED);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("clips the textPreview to 80 chars on long messages so logs stay bounded", async () => {
    const runtime = makeRuntime();
    const classify = createProactiveClassifier(runtime, {
      generateText: fakeGenerate({ throws: new Error("boom") }),
    });

    const longText = "a".repeat(500);
    await classify(longText);
    const [payload] = warnSpy.mock.calls[0] as [{ textPreview: string }];
    expect(payload.textPreview.length).toBeLessThanOrEqual(80);
  });
});

// --- Prompt + config invariants ------------------------------------------

describe("createProactiveClassifier — prompt + config invariants", () => {
  it("uses temperature=0 and a bounded maxOutputTokens for determinism + cost control", async () => {
    const runtime = makeRuntime();
    const callsSeen: Array<Record<string, unknown>> = [];
    const classify = createProactiveClassifier(runtime, {
      generateText: recordingGenerate(
        JSON.stringify({ isQuestion: false, confidence: 0.5 }),
        callsSeen,
      ),
    });

    await classify("what's MRR?");
    expect(callsSeen).toHaveLength(1);
    expect(callsSeen[0].temperature).toBe(0);
    expect(callsSeen[0].maxOutputTokens).toBe(__testing.MAX_OUTPUT_TOKENS);
    expect(callsSeen[0].system).toBe(__testing.CLASSIFIER_SYSTEM_PROMPT);
  });

  it("clamps overlong input before sending it to the model", async () => {
    const runtime = makeRuntime();
    const callsSeen: Array<Record<string, unknown>> = [];
    const classify = createProactiveClassifier(runtime, {
      generateText: recordingGenerate(
        JSON.stringify({ isQuestion: false, confidence: 0.5 }),
        callsSeen,
      ),
    });

    const huge = "x".repeat(__testing.MAX_INPUT_CHARS + 5000);
    await classify(huge);
    const messages = callsSeen[0].messages as Array<{ content: string }> | undefined;
    expect(messages?.[0]?.content.length).toBe(__testing.MAX_INPUT_CHARS);
  });
});
