/**
 * The composed statement (#5215, ADR-0041) — condition 6's top of page.
 *
 * ## A paragraph, and never a gauge
 *
 * PRD condition 6 asks that an admin be able to STATE what Atlas knows, how much
 * of the company it covers, and what it does not — every part correct, at 4% as
 * clearly as at 80%. ADR-0041 decides the form that takes: *"The top of the page
 * is the composed statement condition 6 demands — classes connected, per-class
 * ratios, map edges — a paragraph, not a KPI."*
 *
 * So this module returns SENTENCES. There is no score here, no percentage, and
 * no field one could be put in — the pressure for a single number will arrive as
 * a dashboard ring or a slide, and the answer is that the layers are
 * incommensurable and any blend needs invented weights. A blended number would
 * also punish honesty twice: excluding units from the perimeter raises it, and
 * widening scopes lowers it.
 *
 * ## Composed from true parts, one per class, in a fixed order
 *
 * Every arm of {@link BrainCoverageClass} gets its own sentence, including the
 * three that carry no counts. That is the load-bearing property: a class with
 * nothing to say must SAY that, because a class silently omitted from the
 * paragraph reads as a class with nothing to worry about. The order is fixed
 * rather than sorted by size, so the statement does not quietly rearrange itself
 * to lead with the flattering class.
 *
 * ## Pure, so it can be falsified
 *
 * No JSX and no hooks: the statement is the page's central claim, and a claim
 * that can only be checked by rendering a tree is a claim nothing checks. The
 * tests drive this function with the arms directly.
 */

import type { BrainCoverage, BrainCoverageSourceClass } from "@/ui/lib/types";
import {
  CLASS_COPY,
  CLASS_ORDER,
  MAP_EDGE_COPY,
  UNIT_CAPTION,
  cannotEstablishClaim,
  datePhrase,
  enumerationNeverSucceededClaim,
  frozenEnumerationClaim,
  neverEnumeratedClaim,
  notSurveyableClaim,
  ratioPhrase,
} from "./vocabulary";

export interface ComposedStatement {
  /**
   * The availability half — one sentence per class, always five, in
   * {@link CLASS_ORDER}.
   */
  readonly availability: readonly string[];
  /**
   * The map edges, as marks. Empty means the map of what these credentials can
   * see is complete — which is only ever true on classes that have a dated
   * enumeration behind them, and is why this list is built solely from those.
   */
  readonly mapEdges: readonly string[];
  /** The authority half — observed, awaiting review, federated elsewhere. */
  readonly authority: readonly string[];
  /**
   * Set when some part of the response cannot be trusted to add up. A
   * qualification ON the statement, never a replacement FOR it: every sentence
   * above is still the best Atlas can say.
   */
  readonly caveat: string | null;
}

/**
 * One class's sentence — every arm answers, including the three with no counts.
 *
 * The CLAIMS come from `vocabulary.ts` so the card and the paragraph cannot
 * drift into two wordings; what belongs here is the `Title — ` prefix and the
 * enumerated arm's ratio prose, which the card renders as structured elements
 * instead of a sentence.
 */
function availabilitySentence(coverage: BrainCoverage, cls: BrainCoverageSourceClass): string {
  const copy = CLASS_COPY[cls];
  const arm = coverage.availability[cls];
  const say = (claim: string) => `${copy.title} — ${claim}`;

  switch (arm.state) {
    case "not-surveyable":
      return say(notSurveyableClaim(copy));
    case "cannot-establish":
      return say(cannotEstablishClaim(copy));
    case "never-enumerated":
      return say(
        arm.reason === "no-cycle-recorded"
          ? neverEnumeratedClaim(copy)
          : enumerationNeverSucceededClaim(arm.lastAttemptAt, arm.unavailableReason),
      );
    case "enumerated": {
      // ⚠️ An UNREADABLE `asOf` still prints, as words. Dropping it would make a
      // corrupt stamp indistinguishable from a class that legitimately has no
      // date — and this arm always has one, so silence here is a fault reading
      // as an ordinary state.
      const asOf = datePhrase(arm.asOf);
      const stamp = asOf === null ? "" : `, as of ${asOf}`;
      const caption = UNIT_CAPTION[arm.ratio.unit];
      // ⚠️ The FROZEN-counts clause belongs in the paragraph, not only on the
      // card. This arm's `unavailable` means the latest cycle failed after the
      // success `asOf` names, and it does NOT clear `countsConsistent` — so
      // without this clause the statement reads "Atlas surveys 3 of 7 … as of
      // 19 Aug" with nothing anywhere to say the counts stopped moving, and no
      // caveat above it either. The paragraph is documented as the standalone
      // answer to condition 6; a reader who reads only it would get the
      // flattering half.
      const frozen =
        arm.unavailable === null
          ? ""
          : ` ${frozenEnumerationClaim(arm.unavailable.since, arm.unavailable.reason)}`;
      if (arm.ratio.enumerable === 0) {
        // A MEASURED emptiness — a cycle ran and found nothing — which is a
        // different statement from "nobody has looked", and reachable only on
        // this arm.
        return `${copy.title} — no ${copy.units} were found ${caption}${stamp}.${frozen}`;
      }
      const ratio = ratioPhrase(arm.ratio.surveyed, arm.ratio.enumerable, copy);
      const idle =
        arm.ratio.inPerimeterWithoutEvidence > 0
          ? ` ${arm.ratio.inPerimeterWithoutEvidence.toLocaleString()} of the rest are in scope but have produced nothing yet.`
          : "";
      return `${copy.title} — Atlas surveys ${ratio} ${caption}${stamp}.${idle}${frozen}`;
    }
  }
}

/**
 * Every map edge the response carries, de-duplicated, in the class order above.
 *
 * De-duplicated because two classes can hit the same arm and the reader learns
 * nothing from the repetition — but never COUNTED, because a count of marks
 * invites reading it as a count of what is beyond them, which is the fabricated
 * denominator ADR-0041 refuses.
 */
function mapEdgeSentences(coverage: BrainCoverage): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const cls of CLASS_ORDER) {
    const arm = coverage.availability[cls];
    if (arm.state !== "enumerated") continue;
    for (const edge of arm.mapEdges) {
      const sentence = MAP_EDGE_COPY[edge];
      if (seen.has(sentence)) continue;
      seen.add(sentence);
      out.push(sentence);
    }
  }
  return out;
}

/**
 * The hidden backlog — the delta the authority arm exists to disclose, spelled
 * ONCE.
 *
 * Exported because it is rendered twice: in the composed statement at the top of
 * the page, and beside the backlog tiles where the publish decision is actually
 * made. Two placements are right — one reader scans the paragraph, the other
 * scans the tiles — and two WORDINGS would be the maintenance hazard, since a
 * later edit would reach one and not the other.
 *
 * `null` when there is nothing to disclose, and also when the response says its
 * own counts do not add up: the two totals are separate statements on a pool, so
 * a brief ingest race can invert them, and a negative backlog rendered as a fact
 * is worse than no backlog line at all.
 */
export function hiddenBacklogSentence(coverage: BrainCoverage): string | null {
  const totals = coverage.authority.workspaceTotals;
  const hidden = totals.awaitingReview - coverage.authority.reviewableAwaitingReview;
  if (!coverage.authority.countsConsistent || hidden <= 0) return null;
  return `${hidden.toLocaleString()} of the drafts awaiting review are not visible to you — they are granted to audiences you do not hold, and publishing promotes them too.`;
}

/** The authority half — `oversight.ts`'s disclosure, spoken. */
function authoritySentences(coverage: BrainCoverage): string[] {
  const totals = coverage.authority.workspaceTotals;
  const out = [
    `Of what Atlas has already observed, ${totals.awaitingReview.toLocaleString()} claims are awaiting review and ${totals.published.toLocaleString()} are published.`,
  ];
  const hidden = hiddenBacklogSentence(coverage);
  if (hidden !== null) out.push(hidden);
  return out;
}

export function composeStatement(coverage: BrainCoverage): ComposedStatement {
  return {
    availability: CLASS_ORDER.map((cls) => availabilitySentence(coverage, cls)),
    mapEdges: mapEdgeSentences(coverage),
    authority: authoritySentences(coverage),
    caveat:
      coverage.countsConsistent && coverage.authority.countsConsistent
        ? null
        : "Some part of this statement could not be made to add up — a count and its own parts disagreed, or an enumeration reported a degraded reading. Every sentence here is still the best Atlas can say; treat the numbers as approximate until the next cycle.",
  };
}
