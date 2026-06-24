/**
 * Static fallback starter prompts.
 *
 * The adaptive starter surface (`/api/v1/starter-prompts`) derives prompts
 * from the connected workspace's semantic layer (the demo-industry library
 * tier, favorites, and approved popular suggestions). When that resolver
 * returns an empty list — a brand-new workspace whose semantic layer hasn't
 * produced library prompts yet, or a transient backend fault that soft-fails
 * to `[]` — surfaces that want a non-empty "try one of these" affordance fall
 * back to this static set instead of showing nothing.
 *
 * The questions are drawn from the canonical NovaMart e-commerce question set
 * (`eval/canonical-questions/questions.yml`, locked in #2021) — the same
 * dataset the demo path and the cold-start audit (#3925 §F4) walk through, so
 * the fallback matches the connected schema rather than the generic SaaS
 * placeholders ("churn risk by plan tier") it replaces. They read sensibly as
 * a first-question set for any commerce-shaped dataset.
 *
 * Shared so the success page (#3935) and the demo empty-state (#3936 / §F5)
 * draw from one source rather than re-hardcoding divergent sets.
 */
export const STATIC_STARTER_PROMPTS = [
  "What is our total GMV?",
  "Who are our top customers by spend?",
  "What is our revenue broken down by category?",
  "How has our GMV changed by month?",
  "What is our average order value?",
  "How are our shipping carriers performing?",
] as const;
