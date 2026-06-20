/**
 * Context compaction for long agent turns (PRD #3751, slices #3759 + #3760).
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
 * Scope:
 * - #3759: the fill-fraction trigger + summarize-older-history pass. Default OFF.
 * - #3760 (this slice): the context window is resolved PER MODEL from a static
 *   catalog (Anthropic 200k vs OpenAI 128k vs …), so the same fill fraction means
 *   the same thing on a 128k model as on a 200k one. A model the catalog doesn't
 *   cover falls back to a safe default (never errors the turn). An admin can pin
 *   the window explicitly via the `ATLAS_COMPACTION_CONTEXT_WINDOW_TOKENS`
 *   settings knob, which takes precedence over the catalog.
 *
 * Still out of scope:
 * - The summary runs on the active TURN model; a cheaper dedicated summary model
 *   is #3761.
 * - Single pass per step, no second loop: if the older slice is so large that
 *   summary + pinned-N steps still exceed the window, the turn can still over-
 *   fill it. The cheaper summary model (#3761) shrinks that gap; a re-trigger
 *   loop remains out of scope.
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
  /**
   * Context-window size in tokens the fill-fraction trigger computes against.
   * Resolved per model (#3760): the operator override knob if set, else the
   * static catalog value for the active model, else a safe default.
   */
  readonly contextWindowTokens: number;
  /** How {@link contextWindowTokens} was resolved — for observability/tests. */
  readonly contextWindowSource: "override" | "catalog" | "default";
}

const DEFAULT_FILL_FRACTION = 0.85;
const DEFAULT_PINNED_RECENT_STEPS = 6;
/**
 * Safe fallback window when the catalog has no entry for the active model and no
 * override is set. 200k is the most common modern window (Claude, GPT-4-class)
 * and was the coarse value Compaction 1 (#3759) used unconditionally, so an
 * uncatalogued model degrades to exactly the old behavior rather than erroring.
 */
const DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000;

// Bounds — clamp/reject obviously-broken operator values, mirroring the
// warn-once discipline of getAgentMaxSteps().
const MIN_PINNED_RECENT_STEPS = 1;
const MAX_PINNED_RECENT_STEPS = 100;
const MIN_CONTEXT_WINDOW_TOKENS = 1_000;
// Ceiling on the override too: an absurdly-large value (e.g. 999999999999)
// would push the trigger past anything the coarse estimator ever reports,
// silently disabling compaction. 10M comfortably covers every real window
// (Gemini's 2M is the current largest) with headroom; out-of-range-HIGH
// overrides fall through to the catalog just like too-small / non-numeric ones.
const MAX_CONTEXT_WINDOW_TOKENS = 10_000_000;

// ── Per-model context-window catalog (#3760) ─────────────────────────
//
// The live provider catalogs (`gateway-catalog`, `anthropic-catalog`,
// `bedrock-catalog`, `openai-catalog`) carry a `contextWindow` field, but it is
// either network-backed + async (gateway) or `null` from the upstream
// discovery endpoint (the BYOT providers' `/v1/models` responses don't return
// it). The compaction trigger runs synchronously inside `prepareStep` on every
// step, so it can't await a network fetch. This static table is the synchronous
// source of truth: a model-family → window map matched by substring against the
// resolved model id, which is robust across the id shapes the providers use
// (`claude-opus-4-8`, `anthropic/claude-opus-4.8`, `us.anthropic.claude-…`,
// `gpt-4o`, `gemini-2.0-flash`, …) without an exact-id table that goes stale on
// every model release. First match wins, so order most-specific first.

interface ContextWindowRule {
  /** Lowercased substrings; if ANY appears in the (lowercased) model id, matches. */
  readonly match: readonly string[];
  readonly windowTokens: number;
}

const CONTEXT_WINDOW_RULES: readonly ContextWindowRule[] = [
  // OpenAI long-context families first (more specific than bare "gpt").
  //
  // The 128k GPT-4-Turbo ids (`gpt-4-1106*`, `gpt-4-0125*`) MUST be matched
  // before the 1M GPT-4.1 rule: the 4.1 dash-form needle `gpt-4-1` is a prefix
  // of `gpt-4-1106`, so first-match order is what keeps Turbo at 128k while the
  // real GPT-4.1 (`gpt-4.1`, or a bare `gpt-4-1` with nothing after) still
  // resolves to 1M below.
  { match: ["gpt-4o", "gpt-4-turbo", "gpt-4-1106", "gpt-4-0125"], windowTokens: 128_000 },
  { match: ["gpt-4.1", "gpt-4-1"], windowTokens: 1_000_000 },
  { match: ["o1", "o3", "o4-mini"], windowTokens: 200_000 },
  { match: ["gpt-4-32k"], windowTokens: 32_768 },
  { match: ["gpt-4"], windowTokens: 8_192 },
  { match: ["gpt-3.5-turbo-16k"], windowTokens: 16_384 },
  { match: ["gpt-3.5"], windowTokens: 16_385 },
  // Anthropic — Claude 2.x through the 4.x line are all 200k.
  { match: ["claude"], windowTokens: 200_000 },
  // Google Gemini — 1.5/2.x long context.
  { match: ["gemini-1.5-pro", "gemini-2"], windowTokens: 2_000_000 },
  { match: ["gemini-1.5", "gemini"], windowTokens: 1_000_000 },
  // Mistral large / open models commonly run 32k.
  { match: ["mistral-large", "mistral", "mixtral"], windowTokens: 32_768 },
  // Meta Llama 3.x is 128k.
  { match: ["llama-3", "llama3", "llama"], windowTokens: 128_000 },
];

/**
 * Resolve the active model's context-window size (tokens) from the static
 * catalog by family-substring match. Returns `null` when no rule matches — the
 * caller falls back to the safe default rather than erroring. Pure + sync so the
 * per-step compaction trigger can call it without awaiting a network fetch.
 *
 * @param modelId provider model id (any shape: `claude-opus-4-8`,
 *   `anthropic/claude-opus-4.8`, `us.anthropic.claude-…`, `gpt-4o`, …).
 */
export function resolveModelContextWindow(modelId: string | undefined): number | null {
  if (!modelId) return null;
  const id = modelId.toLowerCase();
  for (const rule of CONTEXT_WINDOW_RULES) {
    if (rule.match.some((needle) => id.includes(needle))) return rule.windowTokens;
  }
  return null;
}

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
 * Resolve the compaction knobs for a turn.
 *
 * `modelId` selects the per-model context window (#3760): the override knob
 * wins if set, else the static catalog value for the model, else a safe
 * default. `orgId` threads the workspace tier (the keys are workspace-scoped);
 * when omitted resolution falls back through platform override > env var >
 * registry default, matching `getAgentMaxSteps`.
 */
export function resolveCompactionSettings(
  modelId?: string,
  orgId?: string,
): CompactionSettings {
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

  // Context window (#3760): override knob > static per-model catalog > default.
  // The knob's registry default is empty, so an unset/blank value means "resolve
  // from the catalog"; only an explicit operator value pins the window.
  const { contextWindowTokens, contextWindowSource } = resolveContextWindow(
    modelId,
    getSetting("ATLAS_COMPACTION_CONTEXT_WINDOW_TOKENS", effectiveOrgId),
  );

  return { enabled, fillFraction, pinnedRecentSteps, contextWindowTokens, contextWindowSource };
}

/**
 * Resolve the context window the trigger computes against: an explicit, valid
 * operator override pins it; otherwise the static per-model catalog
 * ({@link resolveModelContextWindow}); otherwise a safe default. A blank/unset
 * override and a catalog miss both fall through cleanly — never throws, so a
 * model the catalog doesn't cover degrades to the default instead of erroring
 * the turn (logged at debug).
 */
function resolveContextWindow(
  modelId: string | undefined,
  overrideRaw: string | undefined,
): { contextWindowTokens: number; contextWindowSource: CompactionSettings["contextWindowSource"] } {
  // Tier 1 — explicit operator override (settings registry already applied
  // workspace > platform > env precedence). Blank string ⇒ "use the catalog".
  if (overrideRaw !== undefined && overrideRaw.trim() !== "") {
    const override = parseInt(overrideRaw, 10);
    if (
      Number.isFinite(override) &&
      override >= MIN_CONTEXT_WINDOW_TOKENS &&
      override <= MAX_CONTEXT_WINDOW_TOKENS
    ) {
      return { contextWindowTokens: override, contextWindowSource: "override" };
    }
    warnInvalidOnce(
      "ATLAS_COMPACTION_CONTEXT_WINDOW_TOKENS",
      String(overrideRaw),
      `Invalid ATLAS_COMPACTION_CONTEXT_WINDOW_TOKENS; resolving the window from the model catalog instead`,
    );
  }

  // Tier 2 — static per-model catalog.
  const fromCatalog = resolveModelContextWindow(modelId);
  if (fromCatalog !== null) {
    return { contextWindowTokens: fromCatalog, contextWindowSource: "catalog" };
  }

  // Tier 3 — safe default. The catalog has no entry for this model and there is
  // no override; the turn proceeds on the default window rather than failing.
  // Logged unconditionally — a blank/undefined modelId is self-documenting in the
  // payload (it's the value that produced the miss), so the empty case isn't silent.
  log.debug(
    { modelId, defaultWindow: DEFAULT_CONTEXT_WINDOW_TOKENS },
    "No context-window entry for model; using safe default window for compaction trigger",
  );
  return { contextWindowTokens: DEFAULT_CONTEXT_WINDOW_TOKENS, contextWindowSource: "default" };
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
