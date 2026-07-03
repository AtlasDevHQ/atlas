/**
 * The audience-class SSOT (PRD #4257, slice #4260).
 *
 * A zero-dependency leaf module — NO `@/` app-graph imports, no React — so it
 * can be imported by BOTH the app graph (`audience-taxonomy.ts`) and the
 * fumadocs config bundle (`source.config.ts`, via a relative import). That keeps
 * the three-value classification set single-sourced instead of duplicated as two
 * hand-synced literals.
 */

/** The three audience classes a content file can belong to. */
export const AUDIENCE_CLASSES = [
  "saas-only",
  "self-hosted-only",
  "shared",
] as const;

export type AudienceClass = (typeof AUDIENCE_CLASSES)[number];
