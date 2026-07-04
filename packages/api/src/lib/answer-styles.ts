/**
 * Answer styles — the named registry of answer voices (#4299, PRD #4292).
 *
 * An answer style is the editorial voice of the agent's ANSWER (the final
 * user-facing text of a turn — CONTEXT.md § Chat turn presentation). Each
 * style resolves to exactly ONE prompt addendum that `buildSystemParam`
 * (lib/agent.ts) appends to the system prompt; everything else in the prompt
 * — the workflow, the rules, the `<suggestions>` contract, the cross-source
 * provenance guidance — is style-independent and identical across styles.
 *
 * This registry generalizes the former hard-wired binary `PresentationMode`
 * ("developer" | "conversational", #2705):
 *
 * - `conversational` (chat-platform default — Slack @mention, proactive) is
 *   now a registry entry whose addendum is byte-identical to the #2705
 *   constant, so chat-platform output is unchanged.
 * - The old addendum-free "developer" voice is superseded by `analyst`, the
 *   tuned answer-first default for the web chat and every other
 *   analyst-grade surface (SDK, MCP, `/api/v1/query`).
 *
 * The canonical term is **answer style** — "mode" is avoided (deploy mode /
 * content mode / routing mode collisions). The registry lives in core
 * (never `/ee`) and reads no env vars. The per-conversation picker (#4302)
 * builds on this seam: {@link ANSWER_STYLE_NAMES} is the vocabulary it will
 * validate against, and lifts to `@useatlas/types` when the style crosses
 * the HTTP boundary.
 */

/** Every registered answer style name, in picker display order. */
export const ANSWER_STYLE_NAMES = [
  "plain-english",
  "analyst",
  "executive",
  "conversational",
] as const;

/** A named answer style — the editorial voice of the agent's answer. */
export type AnswerStyle = (typeof ANSWER_STYLE_NAMES)[number];

/**
 * Default style when a caller doesn't select one: the analyst voice, the
 * answer-first default for the web chat and analyst-grade callers (SDK, MCP,
 * `/api/v1/query`). Chat-platform surfaces pass `"conversational"` explicitly
 * (see `answerStyleForPresentationMode`).
 */
export const DEFAULT_ANSWER_STYLE: AnswerStyle = "analyst";

/** Type guard for validating externally-supplied style names (#4302 seam). */
export function isAnswerStyle(value: unknown): value is AnswerStyle {
  return (
    typeof value === "string" &&
    (ANSWER_STYLE_NAMES as readonly string[]).includes(value)
  );
}

const PLAIN_ENGLISH_ADDENDUM = `## Answer style — plain English

The reader is a business user who wants the answer in plain language, not an analyst's report. Follow these rules for the answer:

- Answer in a few short sentences of plain prose. State the figure or fact directly, with just enough context to make it meaningful.
- No headings, no bullet lists, no emoji, no jargon — write the way you would explain the number to a colleague in person.
- Do not include SQL or describe your methodology unless the user explicitly asks how the answer was produced.
- Express small comparisons in prose ("3 in the US, 1 in EU, 1 in APAC"); use a markdown table only when the user asks for a list or breakdown.
- Cite figures with units ("$1.2M", "14%").`;

/**
 * The analyst voice — the editorial fix that motivated PRD #4292. Answer-first:
 * lead with the result, scale length to the question, no emoji headers, caveats
 * only when material, no unprompted dataset speculation. Worded around "the
 * result" (not "the number") so it composes with the bound dashboard-editor
 * guidance, where a turn's result is an edit rather than a figure.
 */
const ANALYST_ADDENDUM = `## Answer style — analyst

You are writing for a reader who sees your answer as the dominant element of the turn. Be answer-first:

- **Lead with the result.** Your first sentence delivers the answer — the number, the fact, or the outcome of what you did. Method, context, and detail come after it, never before.
- **Scale length to the question.** A simple lookup ("which region grew most?") deserves a sentence or two plus the supporting figure. Save sections and structure for genuinely multi-part analyses.
- **No emoji.** Never use emoji in headings or anywhere else in the answer.
- **Headings must earn their place.** Never use headings on an answer of one or two paragraphs.
- **Caveats only when material.** State a limitation only when it could change how the reader acts on the answer. No generic disclaimers, no methodology essays.
- **Do not speculate about the dataset.** Report what the data you queried shows. Do not guess at what other tables might contain, editorialize about data quality, or propose hypothetical analyses unless the user asked.
- Markdown tables and inline SQL remain appropriate when they carry the answer — this style tunes the prose, not the toolset.`;

const EXECUTIVE_ADDENDUM = `## Answer style — executive

The reader is an executive who may forward your answer without editing it. Lead with the headline and carry the proof:

- **The first line is the headline**: the single number or finding that answers the question, stated plainly. No preamble.
- Follow with at most 3-4 tight supporting points (drivers, change vs. the prior period, notable outliers). Short bullets are fine; essays are not.
- **Carry the provenance**: close with one line naming the data source(s) consulted and how many queries produced the answer (e.g. "Source: orders (Postgres), 2 queries.").
- No emoji, no SQL in the body, no methodology narrative.
- Include at most one compact table when it strengthens the headline; otherwise keep figures inline.`;

/**
 * #2705's conversational addendum, verbatim — heading included. The legacy
 * "Presentation mode" heading is retained deliberately: #4299's acceptance
 * bar is that conversational output is behavior-identical to the pre-registry
 * binary, and the addendum string is the behavior. Do not "fix" the heading
 * to "Answer style" without re-verifying the Slack surface.
 */
const CONVERSATIONAL_ADDENDUM = `## Presentation mode — conversational

You are answering inside a chat platform (Slack/Teams/etc.) where the audience is a non-analyst teammate skimming a thread. Override the standard formatting guidance with the following rules:

- Keep the answer to **1-2 sentences of plain English prose**. No headings, no bullet lists, no preamble.
- **Do NOT include SQL** in the response body. The chat surface attaches a "Show SQL" button that surfaces the query on demand.
- **Do NOT use markdown tables.** Express small comparisons as prose ("3 in the US, 1 in EU, 1 in APAC"); use bare numbers, not formatted tables. For larger result sets, summarize the top line in prose and let the "Show details" button surface the breakdown.
- **Skip the glossary lecture.** Assume the reader already knows what a customer / order / MRR is. Don't define terms.
- Cite figures inline in the prose, with units. ("Revenue grew to $1.2M in March, up 14% from February.")
- End with a single short line offering the analyst view: "Want the SQL or full breakdown? Tap the button below." Do NOT use markdown formatting on this closing line.
`;

const ANSWER_STYLE_ADDENDA: Record<AnswerStyle, string> = {
  "plain-english": PLAIN_ENGLISH_ADDENDUM,
  analyst: ANALYST_ADDENDUM,
  executive: EXECUTIVE_ADDENDUM,
  conversational: CONVERSATIONAL_ADDENDUM,
};

/**
 * Resolve a style to its prompt addendum. Total over {@link AnswerStyle} —
 * every registered style has exactly one addendum, and prompt-assembly tests
 * pin that a built system param contains its style's addendum and no other.
 */
export function resolveAnswerStyleAddendum(style: AnswerStyle): string {
  return ANSWER_STYLE_ADDENDA[style];
}

/**
 * Map the chat-plugin boundary's legacy `presentationMode` signal
 * ("developer" | "conversational", #2705) onto a registry style. The plugin
 * boundary keeps its vocabulary (reshaping it is #4302-adjacent churn, and
 * the field predates the registry); core translates at the seam:
 *
 * - `"conversational"` → `"conversational"` — unchanged chat-platform voice.
 * - `"developer"` → `"analyst"` — the analyst voice supersedes the old
 *   addendum-free analyst-grade view; a bridge that explicitly opted out of
 *   conversational gets the new default voice of that surface.
 * - absent → `fallback`, chosen by the caller: the chat-plugin entrypoint
 *   falls back to `"conversational"` (every call there originates from a
 *   chat platform), the proactive adapter to `"analyst"`.
 */
export function answerStyleForPresentationMode(
  mode: "developer" | "conversational" | undefined,
  fallback: AnswerStyle,
): AnswerStyle {
  if (mode === "conversational") return "conversational";
  if (mode === "developer") return "analyst";
  return fallback;
}
