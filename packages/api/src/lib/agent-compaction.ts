/**
 * Context compaction for long agent turns (PRD #3751, slice 1 / #3759).
 *
 * When a single agent turn accumulates enough history that the assembled
 * context crosses a configurable fill fraction of the model's context window,
 * the older portion of the message history is collapsed into ONE generated
 * summary message while the most-recent N steps are pinned verbatim. The
 * system prompt (which carries the semantic index + glossary) is passed to the
 * model separately and is therefore inherently pinned — it never enters the
 * message array this module rewrites.
 *
 * This is **summarization, not eviction**: nothing is dropped, the older turns
 * are folded into a summary the model still sees. The pass lives at the shared
 * `runAgent` layer (wired via `streamText`'s `prepareStep`), so web / MCP /
 * chat-plugin turns inherit it with no per-surface wiring.
 *
 * Scope of THIS slice:
 * - The context window is resolved COARSELY — a single configured/default value.
 *   Accurate per-model window resolution lands in #3760.
 * - The summary runs on the active TURN model; a cheaper dedicated summary model
 *   is #3761.
 * - Default OFF. With the flag off the loop behaves exactly as before.
 * - Single pass per step, no second loop: if the older slice is so large that
 *   summary + pinned-N steps still exceed the window, the turn can still over-
 *   fill it. Accurate windows (#3760) + the cheaper summary model (#3761) shrink
 *   that gap; a re-trigger loop is out of scope for the thinnest slice.
 *
 * All knobs resolve through the settings registry (workspace > platform > env >
 * default, hot-reloadable) — see `ATLAS_COMPACTION_*` in `settings.ts`.
 */

import { generateText, type LanguageModel, type ModelMessage } from "ai";
import type { Attributes } from "@opentelemetry/api";
import { createLogger, getRequestContext } from "./logger";
import { getSetting } from "./settings";

const log = createLogger("agent:compaction");

// ── Settings resolution ──────────────────────────────────────────────

/** Resolved, validated compaction knobs for a single turn. */
export interface CompactionSettings {
  /** Master on/off. Default off — no compaction unless explicitly enabled. */
  readonly enabled: boolean;
  /** Trigger threshold as a fraction (0,1] of the context window. */
  readonly fillFraction: number;
  /** How many of the most-recent steps to pin verbatim (never summarize). */
  readonly pinnedRecentSteps: number;
  /** Coarse context-window size in tokens for this slice (see #3760). */
  readonly contextWindowTokens: number;
}

const DEFAULT_FILL_FRACTION = 0.85;
const DEFAULT_PINNED_RECENT_STEPS = 6;
const DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000;

// Bounds — clamp/reject obviously-broken operator values, mirroring the
// warn-once discipline of getAgentMaxSteps().
const MIN_PINNED_RECENT_STEPS = 1;
const MAX_PINNED_RECENT_STEPS = 100;
const MIN_CONTEXT_WINDOW_TOKENS = 1_000;

const warnedOnce = new Set<string>();
function warnInvalidOnce(key: string, raw: string, fallbackMsg: string): void {
  const sig = `${key}=${raw}`;
  if (warnedOnce.has(sig)) return;
  warnedOnce.add(sig);
  log.warn({ key, value: raw }, fallbackMsg);
}

function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  return raw === "true" || raw === "1";
}

/**
 * Resolve the compaction knobs for a turn. `orgId` threads the workspace tier
 * (the keys are workspace-scoped); when omitted resolution falls back through
 * platform override > env var > registry default, matching `getAgentMaxSteps`.
 */
export function resolveCompactionSettings(orgId?: string): CompactionSettings {
  // Fall back to the request-context org when the caller omits it, matching
  // getAgentMaxSteps — so a future caller that forgets to thread orgId still
  // hits the workspace tier instead of silently resolving platform-wide.
  const effectiveOrgId = orgId ?? getRequestContext()?.user?.activeOrganizationId;
  const enabled = parseBoolean(getSetting("ATLAS_COMPACTION_ENABLED", effectiveOrgId), false);

  const fillRaw = getSetting("ATLAS_COMPACTION_FILL_FRACTION", effectiveOrgId);
  let fillFraction = fillRaw !== undefined ? Number(fillRaw) : DEFAULT_FILL_FRACTION;
  if (!Number.isFinite(fillFraction) || fillFraction <= 0 || fillFraction > 1) {
    warnInvalidOnce(
      "ATLAS_COMPACTION_FILL_FRACTION",
      String(fillRaw),
      `Invalid ATLAS_COMPACTION_FILL_FRACTION; using default ${DEFAULT_FILL_FRACTION}`,
    );
    fillFraction = DEFAULT_FILL_FRACTION;
  }

  const stepsRaw = getSetting("ATLAS_COMPACTION_PINNED_RECENT_STEPS", effectiveOrgId);
  let pinnedRecentSteps = stepsRaw !== undefined ? parseInt(stepsRaw, 10) : DEFAULT_PINNED_RECENT_STEPS;
  if (
    !Number.isFinite(pinnedRecentSteps) ||
    pinnedRecentSteps < MIN_PINNED_RECENT_STEPS ||
    pinnedRecentSteps > MAX_PINNED_RECENT_STEPS
  ) {
    warnInvalidOnce(
      "ATLAS_COMPACTION_PINNED_RECENT_STEPS",
      String(stepsRaw),
      `Invalid ATLAS_COMPACTION_PINNED_RECENT_STEPS; using default ${DEFAULT_PINNED_RECENT_STEPS}`,
    );
    pinnedRecentSteps = DEFAULT_PINNED_RECENT_STEPS;
  }

  const windowRaw = getSetting("ATLAS_COMPACTION_CONTEXT_WINDOW_TOKENS", effectiveOrgId);
  let contextWindowTokens = windowRaw !== undefined ? parseInt(windowRaw, 10) : DEFAULT_CONTEXT_WINDOW_TOKENS;
  if (!Number.isFinite(contextWindowTokens) || contextWindowTokens < MIN_CONTEXT_WINDOW_TOKENS) {
    warnInvalidOnce(
      "ATLAS_COMPACTION_CONTEXT_WINDOW_TOKENS",
      String(windowRaw),
      `Invalid ATLAS_COMPACTION_CONTEXT_WINDOW_TOKENS; using default ${DEFAULT_CONTEXT_WINDOW_TOKENS}`,
    );
    contextWindowTokens = DEFAULT_CONTEXT_WINDOW_TOKENS;
  }

  return { enabled, fillFraction, pinnedRecentSteps, contextWindowTokens };
}

// ── Token estimation (coarse) ────────────────────────────────────────

/**
 * Characters-per-token heuristic. Deliberately coarse for this slice: a true
 * tokenizer is not worth the dependency when the window itself is approximate
 * (#3760). ~4 chars/token is the standard rough estimate for English + JSON.
 */
const CHARS_PER_TOKEN = 4;

function systemText(system: string | { content: string } | undefined): string {
  if (system === undefined) return "";
  return typeof system === "string" ? system : system.content;
}

/**
 * Estimate the assembled-context size (system prompt + all messages) in tokens.
 * Coarse — serializes each message to JSON so tool calls/results count toward
 * the total, then applies the chars-per-token heuristic.
 */
export function estimateContextTokens(
  system: string | { content: string } | undefined,
  messages: readonly ModelMessage[],
): number {
  let chars = systemText(system).length;
  for (const m of messages) chars += JSON.stringify(m).length;
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/** True when an enabled turn has crossed its fill-fraction trigger. */
export function shouldCompact(estimatedTokens: number, settings: CompactionSettings): boolean {
  if (!settings.enabled) return false;
  return estimatedTokens >= settings.fillFraction * settings.contextWindowTokens;
}

// ── Compaction ───────────────────────────────────────────────────────

/**
 * Index of the first message belonging to the most-recent `n` steps. Steps are
 * counted by assistant messages from the end (each agent step emits one
 * assistant message plus its tool results); the returned index points AT the
 * n-th-from-last assistant message, so `messages.slice(index)` is the pinned
 * recent slice and `messages.slice(0, index)` is the older history.
 *
 * Returns 0 when there are fewer than `n` assistant turns — there is no older
 * history to summarize, so the caller treats it as "nothing to compact".
 */
export function pinBoundaryIndex(messages: readonly ModelMessage[], n: number): number {
  if (n <= 0) return messages.length;
  let assistantCount = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") {
      assistantCount++;
      if (assistantCount >= n) return i;
    }
  }
  return 0;
}

/** Prefix that frames the injected summary message for the model. */
export const COMPACTION_SUMMARY_PREFIX =
  "[Earlier conversation summary — the start of this turn was compacted to fit the context window. The summary below stands in for the older steps; the most recent steps follow verbatim.]";

export interface CompactionOutcome {
  /** The rewritten message array: one summary message + the pinned recent slice. */
  readonly messages: ModelMessage[];
  /** The generated summary text. */
  readonly summary: string;
  /** How many older messages were folded into the summary. */
  readonly summarizedMessageCount: number;
  /** How many messages were pinned verbatim. */
  readonly pinnedMessageCount: number;
}

/**
 * Collapse the older portion of `messages` into one summary message, pinning
 * the most-recent `pinnedRecentSteps` steps verbatim. Returns `null` when there
 * is nothing to compact (fewer than `pinnedRecentSteps` steps of history).
 *
 * The summary is injected as a `user` message so the pinned slice (which begins
 * with an assistant message) follows a valid user→assistant ordering. The
 * assistant→tool-result pairing inside the pinned slice is preserved because the
 * boundary always lands on an assistant message whose tool results are pinned
 * alongside it.
 */
export async function compactOlderHistory(opts: {
  messages: readonly ModelMessage[];
  pinnedRecentSteps: number;
  summarize: (older: ModelMessage[]) => Promise<string>;
}): Promise<CompactionOutcome | null> {
  const { messages, pinnedRecentSteps, summarize } = opts;
  const boundary = pinBoundaryIndex(messages, pinnedRecentSteps);
  if (boundary <= 0) return null;

  const older = messages.slice(0, boundary);
  const pinned = messages.slice(boundary);
  const summary = await summarize(older);

  const summaryMessage: ModelMessage = {
    role: "user",
    content: `${COMPACTION_SUMMARY_PREFIX}\n\n${summary}`,
  };

  return {
    messages: [summaryMessage, ...pinned],
    summary,
    summarizedMessageCount: older.length,
    pinnedMessageCount: pinned.length,
  };
}

// ── Observability ────────────────────────────────────────────────────

/** Inputs for the `atlas.compaction.*` span attributes. */
export interface CompactionSpanInput {
  readonly beforeTokens: number;
  readonly afterTokens: number;
  readonly beforeMessages: number;
  readonly afterMessages: number;
  readonly summarizedMessages: number;
}

/**
 * Build the `atlas.compaction.*` attributes recorded on the enclosing
 * `atlas.agent` span when a compaction pass runs. Pure (precedent:
 * `profileSpanAttributes`, `buildStripeWebhookSpanAttributes`) so the contract
 * is unit-testable without wiring an in-memory span exporter. Only ever called
 * inside the "a pass ran" branch — a non-compacting turn records none of these.
 */
export function compactionSpanAttributes(input: CompactionSpanInput): Attributes {
  return {
    "atlas.compaction.ran": true,
    "atlas.compaction.before_tokens": input.beforeTokens,
    "atlas.compaction.after_tokens": input.afterTokens,
    "atlas.compaction.before_messages": input.beforeMessages,
    "atlas.compaction.after_messages": input.afterMessages,
    "atlas.compaction.summarized_messages": input.summarizedMessages,
  };
}

// ── Summarization on the turn model ──────────────────────────────────

const SUMMARY_SYSTEM_PROMPT = `You compress the earlier portion of a data-analyst AI agent's working transcript so the agent can keep going within its context window. Produce a faithful, information-dense summary that preserves everything the agent needs to continue the current task:
- The user's original question(s) and any clarifications or constraints they gave.
- Which tables/columns and semantic-layer entities were explored, and what was learned about them.
- SQL that was run, whether it succeeded, and the key results/figures returned (keep concrete numbers).
- Decisions, assumptions, and dead-ends already taken, so the agent does not repeat them.
Do not invent facts. Do not add commentary. Output only the summary.`;

/**
 * Incremental (rolling) variant. Folds only the steps that crossed the pin
 * boundary since the last pass into the existing running summary, instead of
 * re-reading the entire older slice every step. Same fidelity contract as the
 * full prompt above.
 */
const SUMMARY_INCREMENTAL_SYSTEM_PROMPT = `${SUMMARY_SYSTEM_PROMPT}

You are given an existing running summary of the agent's earlier work followed by additional newer steps that have since aged out of the live context. Produce an UPDATED running summary that folds the new steps into the existing one — preserve every still-relevant fact from the prior summary and integrate the new steps. Do not drop facts from the prior summary just because they are old.`;

/**
 * Render a transcript of older messages for the summarizer prompt. Coarse but
 * lossless-enough: each message becomes a role-tagged block; non-text content
 * (tool calls/results) is JSON-serialized so the summarizer sees what ran.
 */
function renderTranscript(messages: readonly ModelMessage[]): string {
  return messages
    .map((m) => {
      const body = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      return `<${m.role}>\n${body}\n</${m.role}>`;
    })
    .join("\n");
}

/**
 * Hard ceiling on a single summarization call. runAgent threads no abort signal
 * into the turn (so a client disconnect can't cancel an in-flight summary), and
 * `prepareStep` latency eats into the step budget — so bound the call itself: a
 * stuck summary fails fast and the fail-soft branch in `agent.ts` continues the
 * turn with full context rather than hanging the step.
 */
const SUMMARY_TIMEOUT_MS = 25_000;

/**
 * Summarize older history using the active turn model (this slice runs on the
 * turn model; a dedicated cheaper model is #3761).
 */
export async function summarizeOlderHistory(
  model: LanguageModel,
  older: readonly ModelMessage[],
): Promise<string> {
  const { text } = await generateText({
    model,
    system: SUMMARY_SYSTEM_PROMPT,
    prompt: `Summarize the earlier portion of this agent transcript:\n\n${renderTranscript(older)}`,
    temperature: 0,
    maxOutputTokens: 1024,
    abortSignal: AbortSignal.timeout(SUMMARY_TIMEOUT_MS),
  });
  return text.trim();
}

/**
 * Roll a prior running summary forward over only the `newer` steps that have
 * aged past the pin boundary since the last pass. Keeps per-step summarization
 * input bounded by (prior summary + delta) instead of re-reading the whole
 * older slice each step — older history grows monotonically within a turn, so
 * the delta is just the steps that crossed the boundary. Same turn model and
 * timeout discipline as {@link summarizeOlderHistory}.
 */
export async function summarizeIncremental(
  model: LanguageModel,
  priorSummary: string,
  newer: readonly ModelMessage[],
): Promise<string> {
  const { text } = await generateText({
    model,
    system: SUMMARY_INCREMENTAL_SYSTEM_PROMPT,
    prompt: `Existing running summary:\n\n${priorSummary}\n\nNewer steps to fold in:\n\n${renderTranscript(newer)}`,
    temperature: 0,
    maxOutputTokens: 1024,
    abortSignal: AbortSignal.timeout(SUMMARY_TIMEOUT_MS),
  });
  return text.trim();
}
