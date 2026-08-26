/**
 * ⚠️ MIRROR of `packages/schemas/src/trust-tier.ts`. Edit BOTH (#5451).
 *
 * The canonical table lives in `@useatlas/schemas`, and everything about why
 * the vocabulary is what it is — including why the labels are today's wire
 * words rather than ADR-0038's proposed *Surveyed / Attested / On the record*
 * ([#5375](https://github.com/AtlasDevHQ/atlas/issues/5375) owns that, and says
 * "do not rename first and test after") — is documented there. This file
 * carries values only.
 *
 * ## Why a copy exists at all
 *
 * This package is published to npm and resolves `@useatlas/types` to the
 * PUBLISHED tarball, not the workspace; it does not depend on
 * `@useatlas/schemas` (which is internal-only and never publishes) at all. So
 * the widget physically cannot import the canonical table. The alternative was
 * to publish `@useatlas/schemas`, which is a bigger decision than one badge.
 *
 * The duplication is a packaging constraint, and the thing that keeps it from
 * becoming a second thing to keep true is
 * `src/components/__tests__/trust-tier-mirror.test.ts` — it imports the
 * canonical module by relative path and fails on any drift in tier, label,
 * meaning, or trust rank. When the widget's own dependency story changes, this
 * file and that test both go away.
 */

export const ANSWER_TRUST_TIERS = [
  "warehouse",
  "fact",
  "raw-episode",
  "document",
] as const;

export type AnswerTrustTier = (typeof ANSWER_TRUST_TIERS)[number];

export interface TrustTierPresentation {
  readonly tier: AnswerTrustTier;
  readonly label: string;
  readonly meaning: string;
  readonly trustTier: 1 | 2 | 3 | null;
}

export const TRUST_TIER_PRESENTATION: Readonly<
  Record<AnswerTrustTier, TrustTierPresentation>
> = {
  warehouse: {
    tier: "warehouse",
    label: "warehouse",
    meaning:
      "Read live from your warehouse by this query — it cannot go stale between readings.",
    trustTier: 1,
  },
  fact: {
    tier: "fact",
    label: "fact",
    meaning: "A reviewed claim a named person read and stood behind.",
    trustTier: 2,
  },
  "raw-episode": {
    tier: "raw-episode",
    label: "raw episode",
    meaning:
      "Source material — what someone said, unedited. Evidence of what was said, not of what is true.",
    trustTier: 3,
  },
  document: {
    tier: "document",
    label: "document",
    meaning:
      "A hosted knowledge-base document. Descriptive prose, not a claim about the world.",
    trustTier: null,
  },
};

/** Narrow an untrusted value to the render vocabulary. */
export function isAnswerTrustTier(value: unknown): value is AnswerTrustTier {
  return (
    typeof value === "string" && (ANSWER_TRUST_TIERS as readonly string[]).includes(value)
  );
}

/**
 * Resolve a wire value to its presentation, or `null` when it is not one this
 * build knows. Callers must render something VISIBLE for `null` — see
 * `TierBadge`.
 */
export function answerTrustTierPresentation(
  value: unknown,
): TrustTierPresentation | null {
  return isAnswerTrustTier(value) ? TRUST_TIER_PRESENTATION[value] : null;
}
