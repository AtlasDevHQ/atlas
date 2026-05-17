/**
 * Pure message classifier for proactive chat.
 *
 * Given a message text, decides whether it looks like an answerable
 * data question. Two flavours:
 *
 *  - `regex-prefilter` (default): cheap regex check first; LLM only on
 *    candidates. Cuts classifier cost roughly an order of magnitude.
 *  - `classify-all`: always run the LLM. Catches indirect questions
 *    ("curious about MRR last month") at the cost of more spend.
 *
 * The LLM is injected via {@link LLMClassifierFn} so this module stays
 * pure and testable — boundary mocking only.
 */

import type { PluginLogger } from "@useatlas/plugin-sdk";
import type {
  ClassificationResult,
  LLMClassifierFn,
  WorkspaceProactiveConfig,
} from "./types";

// ---------------------------------------------------------------------------
// Regex pre-filter
// ---------------------------------------------------------------------------

/**
 * Question-word prefixes that mark a message as a candidate for the
 * full LLM classifier. Kept conservative on purpose — false positives
 * just trigger one extra LLM call, false negatives mean we miss a
 * question entirely.
 */
const QUESTION_WORDS = [
  "what",
  "what's",
  "whats",
  "how",
  "how's",
  "hows",
  "how many",
  "how much",
  "why",
  "when",
  "where",
  "who",
  "which",
  "is",
  "are",
  "do",
  "does",
  "did",
  "can",
  "could",
  "would",
  "should",
  "any",
  "anyone",
];

/** Maximum message length the prefilter / classifier will consider. */
const MAX_MESSAGE_CHARS = 2000;

/** Minimum message length below which we never classify (e.g. ":+1:"). */
const MIN_MESSAGE_CHARS = 4;

/**
 * Cheap regex check that returns true when a message *might* be a
 * question. Used to filter the firehose down to LLM-eligible
 * candidates.
 *
 * Heuristics:
 * - Ends in `?` after trimming punctuation/emoji.
 * - First word matches a known question prefix.
 *
 * Pure function — no I/O, no side effects.
 */
export function regexPreFilter(text: string): boolean {
  if (typeof text !== "string") return false;
  const trimmed = text.trim();
  if (trimmed.length < MIN_MESSAGE_CHARS) return false;
  if (trimmed.length > MAX_MESSAGE_CHARS) return false;

  // Question mark anywhere in the last 5 chars (after trim) is a strong
  // signal — covers "what was MRR last month?" and "any idea on signups?"
  const tail = trimmed.slice(-5);
  if (tail.includes("?")) return true;

  // First-word question prefix. Lowercase and strip leading non-letters
  // so "Hey, what was MRR" still triggers on "what".
  const firstWord = trimmed.toLowerCase().replace(/^[^a-z]+/, "").split(/\s+/)[0] ?? "";
  if (!firstWord) return false;
  return QUESTION_WORDS.includes(firstWord);
}

// ---------------------------------------------------------------------------
// classifyMessage
// ---------------------------------------------------------------------------

export interface ClassifyMessageOptions {
  /** The message text to classify. */
  text: string;
  /** Workspace classifier mode (controls whether prefilter is applied). */
  mode: WorkspaceProactiveConfig["classifierMode"];
  /** Injected LLM classifier — called only on candidates. */
  llm: LLMClassifierFn;
  /**
   * Optional logger. When provided, an LLM classifier exception is
   * logged at `warn` (with type-narrowed error) before the result
   * falls back to "not a question". Without a logger the failure is
   * still represented on the result via `classifierErrored: true` but
   * leaves no operator-visible trail — callers SHOULD pass a logger
   * in production so a provider outage surfaces in logs rather than
   * as a silent classification regression.
   */
  log?: PluginLogger;
}

/** Returned by `classifyMessage`. Adds gating info for testability. */
export interface ClassifyMessageResult extends ClassificationResult {
  /** Whether the prefilter accepted the message (always true in classify-all). */
  candidate: boolean;
  /** Whether the LLM was actually invoked. */
  llmInvoked: boolean;
  /**
   * True when the LLM call threw and the result was downgraded to
   * "not a question" by `safeClassify`. Surfaces the failure mode
   * to callers (listener emits it into the `classify` meter row's
   * `metadata` so an admin can distinguish "classifier silent because
   * provider down" from "classifier silent because message was not a
   * question").
   *
   * Meaningful ONLY when `llmInvoked === true`. Regex-prefilter
   * rejection (where `llmInvoked === false`) never sets this flag —
   * the LLM was never called, so there's nothing to error on. Admin
   * analytics filtering on this should always combine with
   * `llmInvoked = true` to avoid attributing prefilter rejections to
   * an LLM outage.
   */
  classifierErrored?: boolean;
}

/**
 * Run the full classifier pipeline.
 *
 * `regex-prefilter` mode: returns `{ isQuestion: false, confidence: 0 }`
 * immediately on prefilter rejection, otherwise delegates to the LLM.
 *
 * `classify-all` mode: skips the prefilter and always invokes the LLM.
 *
 * Errors from the injected LLM are caught and converted to a "not a
 * question" result so the listener fails closed — never react on a
 * classifier failure. The error is logged via `opts.log` (if provided)
 * and surfaced on the result as `classifierErrored: true` so the meter
 * can distinguish "silent because not a question" from "silent because
 * the classifier provider is down".
 */
export async function classifyMessage(
  opts: ClassifyMessageOptions,
): Promise<ClassifyMessageResult> {
  const { text, mode, llm, log } = opts;

  if (mode === "regex-prefilter") {
    const candidate = regexPreFilter(text);
    if (!candidate) {
      return {
        isQuestion: false,
        confidence: 0,
        candidate: false,
        llmInvoked: false,
      };
    }
    const result = await safeClassify(llm, text, log);
    return { ...result, candidate: true, llmInvoked: true };
  }

  // classify-all
  if (text.trim().length < MIN_MESSAGE_CHARS) {
    return {
      isQuestion: false,
      confidence: 0,
      candidate: false,
      llmInvoked: false,
    };
  }
  const result = await safeClassify(llm, text, log);
  return { ...result, candidate: true, llmInvoked: true };
}

async function safeClassify(
  llm: LLMClassifierFn,
  text: string,
  log: PluginLogger | undefined,
): Promise<ClassificationResult & { classifierErrored?: boolean }> {
  try {
    return await llm(text);
  } catch (err) {
    // Fail closed: classifier errors should never produce an interjection.
    // Log + surface `classifierErrored: true` so a sustained outage shows
    // up in logs AND in the meter's per-event metadata.
    if (log) {
      log.warn(
        { err: err instanceof Error ? err : new Error(String(err)) },
        "Proactive classifier LLM call threw — downgrading to not-a-question",
      );
    }
    return { isQuestion: false, confidence: 0, classifierErrored: true };
  }
}
