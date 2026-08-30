/**
 * ⚠️ MIRROR of `packages/schemas/src/trust-tier.ts`. Edit BOTH (#5451).
 *
 * The canonical table lives in `@useatlas/schemas`, and everything about why
 * the vocabulary is what it is — the ADR-0038 Layer 2 wire rename to
 * `attested` / `on-record` (#5469), why the labels stay on the pre-rename
 * display words ([#5375](https://github.com/AtlasDevHQ/atlas/issues/5375) owns
 * that, and says "do not rename first and test after"), and the legacy alias
 * map for pre-rename persisted rows — is documented there. This file carries
 * values only.
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
  "attested",
  "on-record",
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
  attested: {
    tier: "attested",
    label: "fact",
    meaning: "A reviewed claim a named person read and stood behind.",
    trustTier: 2,
  },
  "on-record": {
    tier: "on-record",
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

/** Pre-rename wire spellings → successors — see the canonical module (#5469). */
export const LEGACY_WIRE_TIER_ALIASES: Readonly<Record<string, AnswerTrustTier>> = {
  fact: "attested",
  "raw-episode": "on-record",
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
  if (isAnswerTrustTier(value)) return TRUST_TIER_PRESENTATION[value];
  if (typeof value === "string" && value in LEGACY_WIRE_TIER_ALIASES) {
    return TRUST_TIER_PRESENTATION[LEGACY_WIRE_TIER_ALIASES[value]!];
  }
  return null;
}
