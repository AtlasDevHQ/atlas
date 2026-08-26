/**
 * The trust tier as a UI-renderable thing — one table, four entries (#5451).
 *
 * [ADR-0036](../../../docs/adr/0036-atlas-as-company-brain.md) makes this a
 * permanent product invariant:
 *
 * > every retrieval result **and every UI surface** must carry the tier label,
 * > or the wedge (trust over breadth) is invisible and the "worse Glean" trap
 * > re-opens.
 *
 * The first clause held from M1. The second was met by nothing: the tier
 * reached a person only through the model's prose, at its discretion, phrased
 * differently each turn — a property that must be TRUE carried by a model
 * instruction, which is the failure shape `lib/brain/segmentation.ts` names one
 * layer down ("it holds statistically and cannot be relied on"). This module is
 * the render-side half, so a surface can state the tier structurally.
 *
 * ## Why here and not in `@useatlas/types`
 *
 * Same reason `BRAIN_RESULT_TIERS` lives in `./brain` rather than there: this
 * has to exist at runtime, and a value export from the published types package
 * forces a publish-first merge dance. `@useatlas/schemas` is the repo's home
 * for shared runtime vocabulary.
 *
 * ⚠️ `@useatlas/react` resolves `@useatlas/types` to the PUBLISHED tarball and
 * does not depend on this package at all, so the embeddable widget cannot
 * import this table. It carries a hand-mirrored copy at
 * `packages/react/src/lib/trust-tier.ts`, and
 * `packages/react/src/components/__tests__/trust-tier-mirror.test.ts` fails if
 * the two drift. The duplication is a packaging constraint; the test is what
 * keeps it from being a second thing to keep true.
 *
 * ## Why the labels are the WIRE vocabulary and not ADR-0038's display names
 *
 * [ADR-0038](../../../docs/adr/0038-the-atlas-is-the-product-the-brain-is-the-category.md)
 * proposes *Surveyed / Attested / On the record*, and the `searchBrain` tool
 * description already teaches the model those words. They are deliberately NOT
 * used here. [#5375](https://github.com/AtlasDevHQ/atlas/issues/5375) owns
 * whether they ship, and says so in as many words:
 *
 * > **Do not rename first and test after.** Testing the current state is what
 * > produces evidence about which words are needed; shipping the proposed three
 * > names first turns this into a check of a guess.
 *
 * So this ships the render SITE those names would need in order to exist at
 * all, carrying today's vocabulary. If #5375 adopts the proposed names, the
 * `label` fields below (and the mirror) are the entire edit.
 */

import type { BrainResultTier } from "@useatlas/types";

/**
 * Every tier a person can be shown for an answer, in ADR-0036's trust order.
 *
 * Strictly wider than {@link BrainResultTier}: `warehouse` is tier 1, which has
 * no row representation in the brain at all — it resolves live through the
 * semantic layer and belongs to `executeSQL`. A table that only covered the
 * three `searchBrain` classes would leave the tier the wedge most depends on
 * unlabelled, which is the specific hole #5451 calls out.
 */
export const ANSWER_TRUST_TIERS = [
  "warehouse",
  "fact",
  "raw-episode",
  "document",
] as const;

export type AnswerTrustTier = (typeof ANSWER_TRUST_TIERS)[number];

/**
 * Compile error if a `searchBrain` result class exists that no surface can
 * label.
 *
 * The direction matters: every {@link BrainResultTier} must be an
 * {@link AnswerTrustTier}, not the reverse. Adding a fourth wire class then
 * fails HERE, at the render vocabulary, rather than at whichever card first
 * tries to draw it — and the `never`-tupling avoids the distribute-and-collapse
 * trap a bare `extends never` falls into.
 */
type _WireTierNotRenderable = Exclude<BrainResultTier, AnswerTrustTier>;
const _everyWireTierIsRenderable: [_WireTierNotRenderable] extends [never]
  ? true
  : _WireTierNotRenderable = true;
void _everyWireTierIsRenderable;

export interface TrustTierPresentation {
  readonly tier: AnswerTrustTier;
  /**
   * The chip text. Short, lowercase at the source; surfaces style it, they do
   * not rewrite it — a second spelling is a second vocabulary.
   */
  readonly label: string;
  /**
   * One plain sentence saying what the tier means, in a person's words rather
   * than the repo's. This is the chip's ACCESSIBLE NAME and its tooltip, so it
   * is not optional decoration: a bare "fact" chip is meaningless to a screen
   * reader, and "carries the tier label" is not satisfied by a word nobody can
   * resolve.
   */
  readonly meaning: string;
  /**
   * ADR-0036's numeric trust ordering, or `null` for the class that sits
   * outside it.
   *
   * `document` is `null` rather than an invented 4 for the reason
   * {@link BrainResultTier} states: a KB document is descriptive prose, not a
   * claim about the world, and a number would imply "less authoritative than a
   * raw episode", which is not what it is.
   */
  readonly trustTier: 1 | 2 | 3 | null;
}

/**
 * The table. Keyed by the tier union, so a new tier fails to compile here
 * instead of rendering as a blank chip.
 */
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
 * build knows.
 *
 * `null` rather than a silent default, and callers are expected to render
 * something VISIBLE for it. A tier value that reaches a render path unlabelled
 * is the bug; a card that quietly drops the chip for an unrecognized tier
 * reproduces it one version later.
 */
export function answerTrustTierPresentation(
  value: unknown,
): TrustTierPresentation | null {
  return isAnswerTrustTier(value) ? TRUST_TIER_PRESENTATION[value] : null;
}
