import type { StarterPrompt } from "@useatlas/types/starter-prompt";

/**
 * Static, schema-agnostic starter prompts shown when the adaptive set hasn't
 * resolved (or comes back empty in a cold-start state).
 *
 * The adaptive list (`GET /api/v1/starter-prompts`) is generated server-side
 * and can take ~15s on a cold semantic index. Until it lands — and whenever
 * it lands empty — a first-time visitor must never face a bare "ask anything"
 * with no suggestions (#3936, cold-start audit §F5). These prompts give the
 * empty state something actionable to render immediately.
 *
 * Deliberately generic so they read sensibly against any business schema
 * (the success page after signup, the public demo, a fresh embed) without
 * promising a column that may not exist. Exported as
 * `DEFAULT_STARTER_PROMPT_TEXTS` so the post-signup success page (#3935 §F4,
 * not yet landed — it currently hardcodes its own divergent copy) can adopt
 * this set and keep the two cold-start surfaces from drifting apart.
 */
export const DEFAULT_STARTER_PROMPT_TEXTS: readonly string[] = [
  "What are our top 10 customers by revenue?",
  "Show me revenue trends over the last 12 months",
  "Which products are selling the most this quarter?",
  "How many new customers did we acquire last month?",
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
