/**
 * Proactive classifier adapter — slice 2b of #2607.
 *
 * Bridges the @useatlas/chat plugin's `LLMClassifierFn` callback shape
 * to Atlas's configured primary LLM (`AtlasAiModel`). The plugin's
 * proactive listener calls `config.classify(text)` for every Slack
 * message that passes the regex prefilter — this adapter is the host
 * implementation that wraps the configured model with a tight question-
 * detection prompt and returns a structured `{ isQuestion, confidence }`.
 *
 * Design decisions (locked in the slice-2 scope-confirm):
 *
 *   - **Reuse the primary model.** No second model knob, no
 *     `ATLAS_PROACTIVE_CLASSIFIER_MODEL` env var. Latency/cost is
 *     bounded by the listener's default `regex-prefilter` mode, which
 *     only invokes the LLM for ambiguous candidates.
 *   - **Deterministic + JSON-shaped output.** `temperature: 0`, system
 *     prompt asks for strict JSON, Zod validates the parsed payload so
 *     a model that hallucinates an extra field or wrong type falls into
 *     the fail-closed branch rather than poisoning the meter.
 *   - **Fail closed.** Any error — model invocation throws, response
 *     isn't JSON, JSON doesn't match the schema — resolves as
 *     `{ isQuestion: false, confidence: 0 }` and logs at warn. The
 *     listener treats this as "not a question" and never reacts, so a
 *     provider outage degrades silently instead of producing rogue
 *     interjections. The plugin's `classifyMessage` further surfaces
 *     `classifierErrored: true` on the meter row when this callback
 *     resolves to the fail-closed shape after invocation.
 */

import { generateText, type LanguageModel } from "ai";
import { Effect, ManagedRuntime } from "effect";
import { z } from "zod";

import { AtlasAiModel } from "@atlas/api/lib/effect/ai";
import { createLogger } from "@atlas/api/lib/logger";
import type {
  ClassificationResult,
  LLMClassifierFn,
} from "@useatlas/chat";

/**
 * Type-only alias for `generateText`. The adapter calls into the real
 * `ai` SDK by default but exposes the call site as a parameter on
 * `invokeClassifier` so tests can inject a fake without resorting to
 * `mock.module("ai", ...)` (which would require re-exporting the
 * SDK's ~120-name surface area to satisfy bun:test's
 * "mock all exports" rule).
 */
type GenerateTextFn = typeof generateText;

const log = createLogger("proactive-classifier-adapter");

// ── Prompt ───────────────────────────────────────────────────────────

/**
 * System prompt — kept tight so a small/cheap primary model can answer
 * reliably and so the cost-per-classify stays low. Asks for strict JSON
 * with two fields; downstream Zod validation rejects anything else.
 */
const CLASSIFIER_SYSTEM_PROMPT = [
  "You classify Slack messages as data questions or not.",
  "A data question is one that could plausibly be answered by querying a connected analytics warehouse (e.g. MRR, signups, conversion, churn, user counts, revenue).",
  "Respond ONLY with strict JSON matching this shape: {\"isQuestion\": boolean, \"confidence\": number}.",
  "confidence is a value in [0, 1] — 1.0 = certain it is a data question, 0.0 = certainly not.",
  "Do not include markdown fences, prose, or any text outside the JSON object.",
].join("\n");

// ── Zod schema for the model's structured output ─────────────────────

const ClassifierResponseSchema = z.object({
  isQuestion: z.boolean(),
  confidence: z.number().min(0).max(1),
});

// ── Fail-closed sentinel ─────────────────────────────────────────────

const FAIL_CLOSED: ClassificationResult = {
  isQuestion: false,
  confidence: 0,
};

// ── Constants ────────────────────────────────────────────────────────

/** Bound on `text` to keep prompt size predictable. The listener's
 *  prefilter already rejects messages > 2000 chars, but defence in
 *  depth: this adapter clamps regardless of caller. */
const MAX_INPUT_CHARS = 2000;

/** Bound on the model's response length — JSON shape is ~50 chars, so
 *  100 leaves room for whitespace + numeric precision without inviting
 *  a model to wander into prose. */
const MAX_OUTPUT_TOKENS = 100;

// ── Public API ───────────────────────────────────────────────────────

/**
 * Build the `LLMClassifierFn` callback wired to the workspace's primary
 * configured Atlas model.
 *
 * The returned callback never throws — failures fold into the
 * fail-closed `{ isQuestion: false, confidence: 0 }` sentinel and log
 * at warn with the first 80 chars of the offending text for forensic
 * correlation (full text is intentionally NOT logged — Slack content
 * is sensitive).
 *
 * `runtime` must be a `ManagedRuntime` whose `R` channel provides
 * `AtlasAiModel` (typically the module-level `getProactiveRuntime()`
 * the chat-plugin wiring constructs at boot).
 *
 * @param runtime ManagedRuntime providing `AtlasAiModel` (and any
 *                additional services the caller wants in scope).
 * @returns The `LLMClassifierFn` to hand to `config.proactive.classify`.
 */
export function createProactiveClassifier<RIn>(
  runtime: ManagedRuntime.ManagedRuntime<RIn | AtlasAiModel, never>,
  options: { generateText?: GenerateTextFn } = {},
): LLMClassifierFn {
  const gen = options.generateText ?? generateText;
  return async (text: string): Promise<ClassificationResult> => {
    // Bound the input so we don't ship a 100KB Slack message to the LLM
    // even if some upstream path bypasses the listener's prefilter.
    const bounded = text.length > MAX_INPUT_CHARS ? text.slice(0, MAX_INPUT_CHARS) : text;

    const program = Effect.gen(function* () {
      const { model } = yield* AtlasAiModel;
      return yield* Effect.tryPromise({
        try: () => invokeClassifier(model, bounded, gen),
        catch: (err) =>
          err instanceof Error ? err : new Error(String(err)),
      });
    });

    try {
      return await runtime.runPromise(program);
    } catch (err) {
      log.warn(
        {
          textPreview: text.slice(0, 80),
          err: err instanceof Error ? err.message : String(err),
        },
        "Proactive classifier failed — falling back to not-a-question (fail-closed)",
      );
      return FAIL_CLOSED;
    }
  };
}

// ── Internal: single classification round-trip ───────────────────────

/**
 * Run the model once with the classifier system prompt and return the
 * parsed-and-validated `ClassificationResult`. Throws on any failure
 * (model error, JSON parse error, schema validation error) so the
 * caller's outer try/catch can map all failure modes to a single
 * fail-closed log + return path.
 */
async function invokeClassifier(
  model: LanguageModel,
  text: string,
  gen: GenerateTextFn,
): Promise<ClassificationResult> {
  const result = await gen({
    model,
    system: CLASSIFIER_SYSTEM_PROMPT,
    messages: [{ role: "user", content: text }],
    temperature: 0,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  });

  const raw = result.text.trim();
  // Defensive: a model may still wrap output in a ```json fence
  // despite the system instruction. Strip before parsing.
  const stripped = raw
    .replace(/^```(?:json)?\s*\n?/i, "")
    .replace(/\n?```\s*$/i, "");

  const json: unknown = JSON.parse(stripped);
  const parsed = ClassifierResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(
      `Classifier response failed schema validation: ${parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
  }

  return {
    isQuestion: parsed.data.isQuestion,
    confidence: parsed.data.confidence,
  };
}

// ── Test surface (for tests in `__tests__/`) ─────────────────────────

/**
 * Internal exports used by unit tests to assert prompt shape without
 * re-declaring magic strings. Not part of the public API.
 *
 * @internal
 */
export const __testing = {
  CLASSIFIER_SYSTEM_PROMPT,
  MAX_INPUT_CHARS,
  MAX_OUTPUT_TOKENS,
  ClassifierResponseSchema,
  FAIL_CLOSED,
};
