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
}

/** Returned by `classifyMessage`. Adds gating info for testability. */
export interface ClassifyMessageResult extends ClassificationResult {
  /** Whether the prefilter accepted the message (always true in classify-all). */
  candidate: boolean;
  /** Whether the LLM was actually invoked. */
  llmInvoked: boolean;
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
 * classifier failure.
 */
export async function classifyMessage(
  opts: ClassifyMessageOptions,
): Promise<ClassifyMessageResult> {
  const { text, mode, llm } = opts;

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
    const result = await safeClassify(llm, text);
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
  const result = await safeClassify(llm, text);
  return { ...result, candidate: true, llmInvoked: true };
}

async function safeClassify(
  llm: LLMClassifierFn,
  text: string,
): Promise<ClassificationResult> {
  try {
    return await llm(text);
  } catch {
    // Fail closed: classifier errors should never produce an interjection.
    return { isQuestion: false, confidence: 0 };
  }
}
