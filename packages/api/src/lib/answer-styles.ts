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
 *   now a registry entry that assembles a byte-identical prompt: the #2705
 *   constant's leading blank-line separator moved into `buildSystemParam`'s
 *   `"\n\n"` join and the rest of the string is retained verbatim, so
 *   chat-platform output is unchanged.
 * - The old addendum-free "developer" voice is superseded by `analyst`, the
 *   tuned answer-first default for the web chat and every other
 *   analyst-grade surface (SDK, MCP, `/api/v1/query`).
 *
 * The canonical term is **answer style** — "mode" is avoided (deploy mode /
 * content mode / routing mode collisions). The registry lives in core
 * (never `/ee`) and reads no env vars. The per-conversation picker (#4302)
 * builds on this seam: {@link ANSWER_STYLE_NAMES} is the vocabulary the
 * chat route validates against, and the `AnswerStyle` union lives in
 * `@useatlas/types` (lifted by #4302) because the style crosses the HTTP
 * boundary on the chat request + conversation record. The workspace default
 * ("house voice", #4303) builds on it too, from the OTHER side: the
 * `ATLAS_DEFAULT_ANSWER_STYLE` settings-registry entry offers
 * {@link WORKSPACE_DEFAULT_STYLE_OPTIONS} (the registry minus
 * {@link NON_HOUSE_VOICE_STYLES}), and `resolveWorkspaceDefaultAnswerStyle`
 * (lib/agent.ts) validates the stored value with
 * {@link isWorkspaceDefaultAnswerStyle} at every ingress (admin write AND
 * env var) — precedence: explicit style > workspace default > surface
 * default.
 */

import type { AnswerStyle } from "@useatlas/types/conversation";

import { createLogger } from "./logger";

const log = createLogger("answer-styles");

/**
 * Every registered answer style name (#4302 picker display order). The
 * member TYPE is the wire union in `@useatlas/types` (the style crosses the
 * HTTP boundary since #4302); this array remains the canonical runtime
 * vocabulary — validation (`isAnswerStyle`, the chat route's `z.enum`)
 * derives from it. The `satisfies` clause forbids an entry outside the wire
 * union; the `_everyWireStyleRegistered` assertion below forbids a wire
 * union member missing here — so registry and wire type cannot drift in
 * either direction.
 */
export const ANSWER_STYLE_NAMES = [
  "plain-english",
  "analyst",
  "executive",
  "conversational",
] as const satisfies readonly AnswerStyle[];

// Compile-time drift tripwire (reverse direction of the `satisfies` above):
// if `@useatlas/types` ever adds a style this array doesn't register, the
// `Exclude` stops being `never` and this constant fails to compile.
const _everyWireStyleRegistered: Exclude<
  AnswerStyle,
  (typeof ANSWER_STYLE_NAMES)[number]
> extends never
  ? true
  : never = true;
void _everyWireStyleRegistered;

/**
 * A named answer style — the editorial voice of the agent's answer.
 * Re-exported from the wire types (`@useatlas/types`, lifted by #4302) so
 * the registry stays the single import site API code needs.
 */
export type { AnswerStyle };

/**
 * The SURFACE default — the last tier of the precedence chain: the analyst
 * voice, the answer-first default for the web chat and analyst-grade callers
 * (SDK, MCP, `/api/v1/query`). Chat-platform surfaces pass `"conversational"`
 * explicitly (see `answerStyleForPresentationMode`). A workspace default
 * (#4303, the `ATLAS_DEFAULT_ANSWER_STYLE` setting) applies before this one
 * when no explicit style is chosen — see
 * `resolveWorkspaceDefaultAnswerStyle` (lib/agent.ts).
 */
export const DEFAULT_ANSWER_STYLE = "analyst" satisfies AnswerStyle;

/** Type guard for validating externally-supplied style names (#4302 seam). */
export function isAnswerStyle(value: unknown): value is AnswerStyle {
  return (
    typeof value === "string" &&
    (ANSWER_STYLE_NAMES as readonly string[]).includes(value)
  );
}

/**
 * Styles never offered as the workspace default ("house voice", #4303):
 * `conversational` is a chat-platform voice — its addendum references Slack
 * affordances ("Show SQL" / "Tap the button below") that don't exist on
 * analyst-grade surfaces. This constant is the single statement of that
 * curation: the settings knob's admin `options` and the resolution-side
 * guard ({@link isWorkspaceDefaultAnswerStyle}, used by
 * `resolveWorkspaceDefaultAnswerStyle` in lib/agent.ts) both derive from it,
 * so the env-var ingress (`ATLAS_DEFAULT_ANSWER_STYLE` set as an env var,
 * which bypasses the admin write validation) cannot install a non-offered
 * voice either.
 */
export const NON_HOUSE_VOICE_STYLES = [
  "conversational",
] as const satisfies readonly AnswerStyle[];

/** An answer style legal as the workspace default ("house voice", #4303). */
export type WorkspaceDefaultAnswerStyle = Exclude<
  AnswerStyle,
  (typeof NON_HOUSE_VOICE_STYLES)[number]
>;

/**
 * Guard for the workspace-default ingress points (admin select write, env
 * var read): a registered style that is also offered as a house voice.
 */
export function isWorkspaceDefaultAnswerStyle(
  value: unknown,
): value is WorkspaceDefaultAnswerStyle {
  return (
    isAnswerStyle(value) &&
    !(NON_HOUSE_VOICE_STYLES as readonly string[]).includes(value)
  );
}

/**
 * The styles offered as a workspace default, in registry order — the
 * `ATLAS_DEFAULT_ANSWER_STYLE` setting's `options` list. Derived (not
 * hand-listed) so a future registry style is house-voice-eligible by
 * default; opting one out is an explicit {@link NON_HOUSE_VOICE_STYLES}
 * entry, never a second list to keep in sync.
 */
export const WORKSPACE_DEFAULT_STYLE_OPTIONS: readonly WorkspaceDefaultAnswerStyle[] =
  ANSWER_STYLE_NAMES.filter(isWorkspaceDefaultAnswerStyle);

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
 * #2705's conversational addendum — heading included, body verbatim. The
 * retired constant's leading `\n\n` separator now lives in
 * `buildSystemParam`'s `"\n\n"` join, so the ASSEMBLED prompt is
 * byte-identical to the pre-registry output. Two details are load-bearing
 * for that identity and for #4299's acceptance bar (conversational output
 * behavior-identical — no Slack regression):
 *
 * - the legacy "Presentation mode" heading — do not "fix" it to
 *   "Answer style" without re-verifying the Slack surface;
 * - the trailing newline (the only addendum that has one) — do not
 *   "normalize" it away.
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
 *
 * Fails loud on an out-of-vocabulary value: the type makes that unreachable
 * for in-repo callers, but the style crosses validated wire boundaries
 * (#4302), and a route that forgets the {@link isAnswerStyle} guard must
 * surface as an error — never as the literal text "undefined" silently
 * appended to the system prompt.
 */
export function resolveAnswerStyleAddendum(style: AnswerStyle): string {
  const addendum = ANSWER_STYLE_ADDENDA[style];
  // `=== undefined` (not falsiness): an empty-string addendum would be a
  // registry bug, but "Unknown answer style" would be the wrong error for it.
  if (addendum === undefined) {
    throw new Error(
      `Unknown answer style "${String(style)}" — expected one of: ${ANSWER_STYLE_NAMES.join(", ")}`,
    );
  }
  return addendum;
}

/**
 * Map the chat-plugin boundary's legacy `presentationMode` signal
 * ("developer" | "conversational", #2705) onto a registry style. The plugin
 * boundary keeps its vocabulary (reshaping it is #4302-adjacent churn, and
 * the field predates the registry); core translates at the seam:
 *
 * - `"conversational"` → `"conversational"` — unchanged chat-platform voice.
 * - `"developer"` → `"analyst"` — the analyst voice supersedes the retired
 *   addendum-free developer view; a bridge that explicitly opted out of
 *   conversational gets the analyst-grade successor of what it opted into.
 * - absent → `fallback`, chosen by the caller: the chat-plugin entrypoint
 *   falls back to `"conversational"` (every call there originates from a
 *   chat platform), the proactive adapter to `"analyst"`.
 *
 * `mode`'s inline union deliberately does NOT import `PresentationMode` from
 * `@useatlas/chat`: the duplication is compile-time drift detection. Both
 * call seams pass values typed from the published boundary, so if the plugin
 * union ever widens, the call seams stop compiling — and widening this
 * signature to match trips the `never` check in the `default` branch — so a
 * new arm always forces an explicit mapping decision here instead of falling
 * through to the runtime warn-and-fallback. It also keeps the registry free
 * of plugin imports.
 */
export function answerStyleForPresentationMode(
  mode: "developer" | "conversational" | undefined,
  fallback: AnswerStyle,
): AnswerStyle {
  switch (mode) {
    case "conversational":
      return "conversational";
    case "developer":
      return "analyst";
    case undefined:
      return fallback;
    default: {
      // Compile-time tripwire: if this signature's union is ever widened to
      // track a widened plugin `PresentationMode`, this line stops compiling
      // until the new arm gets an explicit case above — the widened value
      // must never silently route to `fallback`.
      const _exhaustive: never = mode;
      void _exhaustive;
      // Runtime reality can exceed the compile-time union: the value
      // originates from the published `@useatlas/chat` bridge, so a
      // version-skewed or third-party bridge may send a token TypeScript
      // never saw. Falling back is the right behavior, but never silently
      // (CLAUDE.md) — leave a breadcrumb for the day a bridge "intended
      // conversational" and got the fallback voice instead.
      log.warn(
        { presentationMode: String(mode), fallback },
        "Unrecognized presentationMode from chat-plugin bridge — using fallback answer style",
      );
      return fallback;
    }
  }
}
