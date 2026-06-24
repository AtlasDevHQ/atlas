import type { StarterPrompt } from "@useatlas/types/starter-prompt";

/**
 * Static fallback starter prompts shown when the adaptive set hasn't resolved
 * (or comes back empty in a cold-start state).
 *
 * The adaptive list (`GET /api/v1/starter-prompts`) is generated server-side
 * and can take ~15s on a cold semantic index. Until it lands — and whenever
 * it lands empty — a first-time visitor must never face a bare "ask anything"
 * with no suggestions (#3936, cold-start audit §F5). These prompts give the
 * empty state something actionable to render immediately.
 *
 * Drawn from the canonical NovaMart e-commerce question set
 * (`eval/canonical-questions/questions.yml`, locked in #2021) — the same
 * dataset the public demo renders, so the fallback matches the connected
 * schema rather than reading as a generic SaaS placeholder.
 *
 * Lives in `@useatlas/react` because it is the only package both consumers can
 * import: the demo empty state renders through `<AtlasChat>` here, and the
 * post-signup success page (`@atlas/web`, #3935 §F4) depends on this package.
 * Putting it in `@atlas/web` would be unreachable from the widget. Exported as
 * `DEFAULT_STARTER_PROMPT_TEXTS` so both cold-start surfaces draw from this one
 * source instead of re-hardcoding divergent sets.
 */
export const DEFAULT_STARTER_PROMPT_TEXTS: readonly string[] = [
  "What is our total GMV?",
  "Who are our top customers by spend?",
  "What is our revenue broken down by category?",
  "How has our GMV changed by month?",
  "What is our average order value?",
  "How are our shipping carriers performing?",
] as const;

/**
 * The shared fallback set as `StarterPrompt` objects, ready to render in the
 * widget empty state. Tagged `cold-start` provenance — these are the
 * client-side stand-in for the server's (empty) cold-start tier, not a
 * personalized list, so they render without the favorite pin marker.
 */
export const DEFAULT_STARTER_PROMPTS: readonly StarterPrompt[] =
  DEFAULT_STARTER_PROMPT_TEXTS.map((text, idx) => ({
    id: `fallback:${idx}`,
    text,
    provenance: "cold-start" as const,
  }));
