/**
 * The Coverage Plate's derivation — counts in, marks out (#5422, ADR-0041).
 *
 * ## Why this is a separate module from `plate.tsx`
 *
 * Everything the plate CLAIMS is decided here, and nothing here touches the DOM.
 * The plate is a picture of numbers, so the way it goes wrong is arithmetic, not
 * layout — a run that rounds to nothing, a denominator assembled from two arms
 * that disagree, a quad drawn as surveyed ground when the class was never
 * enumerated. Those are assertions about values, and a test that has to mount
 * React to make them is a test nobody writes the awkward cases for.
 *
 * ## The plate reads COUNTS, never the unit list
 *
 * This is the decision that makes the whole surface possible, and it is worth
 * stating plainly because the obvious implementation is the wrong one.
 *
 * A sounding is ANONYMOUS. It carries no label, so it needs no label, so ADR-0041's
 * two-clause disclosure policy never applies to it: *"Counts are always
 * disclosable. A denominator count carries no claim content and no audience
 * content."* Every mark on the plate comes from {@link BrainCoverageRatio} and
 * {@link BrainCoverageFreshnessCounts} — both of which cover EVERY unit of a
 * class, named and withheld alike.
 *
 * Drawing from `arm.units` instead would have been the natural thing to write and
 * would have been a disclosure leak in a picture: that array is clipped at
 * `COVERAGE_UNITS_MAX` and holds only the units a clause admitted, so a workspace
 * whose mailboxes are all withheld would render an EMPTY quad over a card
 * reporting twelve. The plate would have been drawing the label policy and
 * calling it coverage.
 *
 * ## Marks are not comparable ACROSS quads, and the plate says so
 *
 * A mark on the chat quad is a channel; on the warehouse quad it is an
 * entity–dimension pair. ADR-0041's "No single number, permanently" rests on
 * exactly this incommensurability, so the sheet carries the caption rather than
 * leaving a reader to compare 281 marks against 7 and conclude something. There
 * is no total on this sheet and there is nothing to add up.
 */

import type {
  BrainCoverage,
  BrainCoverageClass,
  BrainCoverageClassAvailable,
  BrainCoverageSourceClass,
} from "@/ui/lib/types";
import { CLASS_ORDER } from "./vocabulary";

/**
 * The most marks one quad may hold before the sheet changes scale.
 *
 * ⚠️ **A DRAWING BOUND, NOT A THRESHOLD** — the same rule `UNIT_ARM_PREVIEW` in
 * `arms.tsx` lives under. Nothing is compared against it, no quad is styled by
 * it, and it changes what is on SCREEN and never what is CLAIMED: every count
 * this plate is derived from is stated in full on the class card below, which
 * renders whatever this is set to.
 *
 * It is 300 rather than something rounder because the shape that produced #5357
 * — 281 entity–dimension pairs — is the largest arm this page is known to carry
 * on real data, and drawing it at 1:1 is worth more than a tidy constant. Above
 * it the sheet re-scales and SAYS the new scale; see {@link PlateSheet.unitsPerMark}.
 */
export const MARKS_PER_QUAD_MAX = 300;

/**
 * What one sounding is.
 *
 * ## Five marks, and the split between them is ADR-0041's, not a palette's
 *
 * The first three are ONE availability state — surveyed — wearing its three
 * freshness renderings, which ADR-0041 requires stay *"three distinct
 * renderings, never a traffic light"*. The last two are the enumerated state
 * split by the M1 sentence: `inPerimeterWithoutEvidence` is *invited, configured,
 * reading nothing*, and folding it into the plain enumerated run would draw it
 * identically to a channel nobody ever touched.
 *
 * ⚠️ There is no mark for ADR-0041's state 3. The unenumerable is a mark with no
 * NUMBER, so it cannot be a sounding — a sounding is a counted thing. It is the
 * quad's torn edge instead ({@link PlateQuadSurveyed.tornEdge}), which carries no
 * quantity at all.
 */
export type PlateMarkKind =
  | "surveyed-current"
  | "surveyed-stale"
  | "surveyed-unverified"
  | "in-scope-no-evidence"
  | "visible-not-in-scope";

/** The order runs are laid down in — fixed, so a quad never reshuffles between renders. */
export const MARK_ORDER = [
  "surveyed-current",
  "surveyed-stale",
  "surveyed-unverified",
  "in-scope-no-evidence",
  "visible-not-in-scope",
] as const satisfies readonly PlateMarkKind[];

/** Compile error if a mark joins the union without joining the order above. */
type _MarkOrderCovers = [Exclude<PlateMarkKind, (typeof MARK_ORDER)[number]>] extends [never]
  ? true
  : never;
const _markOrderCovers: _MarkOrderCovers = true;
void _markOrderCovers;

/**
 * Every way a quad can be drawn — the second half of the vocabulary a reader has
 * to learn, beside {@link MARK_ORDER}.
 *
 * A runtime list rather than only a union, because the thing that needs guarding
 * is a RUNTIME fact: how many distinct things a person looking at this sheet must
 * hold in their head. A type alone cannot be counted by a test.
 *
 * @see ./__tests__/reader-vocabulary.test.ts — the gate that reddens when this changes
 */
export const PLATE_QUAD_RENDERS = [
  "soundings",
  "unsurveyed",
  "off-survey",
  "undrawable",
] as const;

/** Compile error if a quad render joins the union without joining the list above. */
type _QuadRendersCover = [
  Exclude<PlateQuad["render"], (typeof PLATE_QUAD_RENDERS)[number]>,
] extends [never]
  ? true
  : never;

/**
 * One run of like marks in a quad.
 *
 * {@link units} is the real count and {@link marks} is what gets drawn. They are
 * equal at scale 1:1, which is every workspace under {@link MARKS_PER_QUAD_MAX}
 * — the two fields exist so the difference is legible rather than lost inside a
 * rounding expression.
 */
export interface PlateMarkRun {
  readonly kind: PlateMarkKind;
  /** Survey units this run stands for. Always the truth. */
  readonly units: number;
  /** Soundings actually drawn. Never 0 when `units > 0`; see {@link scaleMarks}. */
  readonly marks: number;
}

/** A quad drawn as surveyed ground — the only kind that carries soundings. */
export interface PlateQuadSurveyed {
  readonly render: "soundings";
  readonly sourceClass: BrainCoverageSourceClass;
  readonly runs: readonly PlateMarkRun[];
  readonly markTotal: number;
  /**
   * ADR-0041 state 3, drawn and NEVER counted: the quad's edge is torn where
   * this class's enumeration stopped short of what its credentials can see.
   *
   * A boolean, deliberately. `mapEdges` is a list and its length is a number,
   * and a number about the unenumerable is the fabrication this whole surface
   * refuses. The sentences live on the class card, where they already have copy.
   */
  readonly tornEdge: boolean;
  /** The latest enumeration attempt failed — dated counts, older than they look. */
  readonly frozen: boolean;
}

/**
 * Why a quad has no soundings — four reasons, and they are NOT the same
 * statement.
 *
 * `measured-empty` is the one that has to stay apart from the rest: the class
 * was enumerated, successfully, and there was genuinely nothing there. Every
 * other reason is an absence of looking. Drawing them the same way would be the
 * empty-roster-as-complete-map conflation `coverage.ts` builds a whole arm to
 * prevent, reproduced in a picture.
 */
export type PlateBlankReason =
  | "measured-empty"
  | "never-enumerated"
  | "enumeration-never-succeeded"
  | "cannot-establish";

/** A quad with nothing surveyed in it — hatched, drawn rather than omitted. */
export interface PlateQuadBlank {
  readonly render: "unsurveyed";
  readonly sourceClass: BrainCoverageSourceClass;
  readonly reason: PlateBlankReason;
  /**
   * True for the one blank reason that is a FAULT rather than a state of the
   * world. `cannot-establish` means no class contract resolved in this deploy,
   * so the quad is overprinted in the caution colour: an operator can fix it,
   * and a reader must not read it as ordinary unsurveyed ground.
   */
  readonly fault: boolean;
}

/**
 * A quad that is not on the sheet at all — `not-surveyable`.
 *
 * ⚠️ **This is why it is not hatched.** Hatch means unsurveyed GROUND: a place
 * a survey could go and has not. `human`'s units would be people, and ADR-0041
 * says the class is *"correctly absent from every ratio, forever; not a gap"*.
 * Hatching it would draw an affirmative refusal as an unfilled hole — the one
 * mis-statement this rendering exists to avoid — so it is drawn in the sheet's
 * MARGIN, outside the neatline, present and visibly off-survey.
 */
export interface PlateQuadOffSurvey {
  readonly render: "off-survey";
  readonly sourceClass: BrainCoverageSourceClass;
}

/**
 * A quad whose own counts disagree, drawn as a refusal.
 *
 * The freshness tally sums to `ratio.surveyed` and `enumerable` equals
 * `surveyed + enumerated` — the composer asserts both and clears
 * `countsConsistent` when they fail. When they HAVE failed, there is no honest
 * number of marks: drawing the tally misstates the ratio and drawing the ratio
 * misstates the tally. So the quad draws nothing and says so.
 *
 * ⚠️ Not folded into {@link PlateQuadBlank}. An unsurveyed quad is a true
 * statement about the world; this one is the plate declining to make a
 * statement, and a picture that renders "we cannot draw this" as "there is
 * nothing here" is a silent zero with extra steps.
 */
export interface PlateQuadUndrawable {
  readonly render: "undrawable";
  readonly sourceClass: BrainCoverageSourceClass;
}

export type PlateQuad =
  | PlateQuadSurveyed
  | PlateQuadBlank
  | PlateQuadOffSurvey
  | PlateQuadUndrawable;

const _quadRendersCover: _QuadRendersCover = true;
void _quadRendersCover;

/** The whole sheet, ready to draw. */
export interface PlateSheet {
  /** Inside the neatline, in {@link CLASS_ORDER}. Never re-sorted by coverage. */
  readonly quads: readonly PlateQuad[];
  /** Outside the neatline — {@link PlateQuadOffSurvey}, kept in class order too. */
  readonly margin: readonly PlateQuadOffSurvey[];
  /**
   * Survey units one sounding stands for. 1 on every workspace whose largest
   * quad fits {@link MARKS_PER_QUAD_MAX}, which is the realistic case; above
   * that the sheet re-scales and the header states the new scale, after the
   * chart convention.
   */
  readonly unitsPerMark: number;
  /** Quads carrying at least one sounding — the "three lit quads" of the day-one state. */
  readonly litQuads: number;
}

/**
 * Marks for a run, at a given scale.
 *
 * ⚠️ **A non-zero count NEVER renders as no marks**, which is the one place this
 * function departs from proportionality and it departs deliberately. At 1:4, a
 * surveyed run of 1 rounds to 0 — and a quad drawn with no surveyed soundings
 * over a card reporting one surveyed channel is a silent zero, which ADR-0041
 * calls *"a false statement, not an error state"*. The floor overstates a small
 * run by at most `unitsPerMark - 1` units; the scale is on the sheet so a reader
 * can bound it, and the exact counts are on the card below either way.
 */
export function scaleMarks(units: number, unitsPerMark: number): number {
  if (units <= 0) return 0;
  return Math.max(1, Math.round(units / unitsPerMark));
}

/** Units a quad would draw at 1:1 — the input to the sheet's scale. */
function unitsInQuad(arm: BrainCoverageClassAvailable): number {
  return arm.ratio.enumerable;
}

/**
 * Whether an available arm's counts hold together well enough to draw.
 *
 * Three identities, all of which the composer already asserts server-side. They
 * are re-checked here rather than trusted because this module turns them into a
 * PICTURE, and a picture drawn from counts that do not add up is wrong in a way
 * no caption can qualify — the reader has already read it.
 */
function drawable(arm: BrainCoverageClassAvailable): boolean {
  const { surveyed, enumerated, enumerable, inPerimeterWithoutEvidence } = arm.ratio;
  const tally = arm.freshness.current + arm.freshness.stale + arm.freshness.unverified;
  if (surveyed < 0 || enumerated < 0 || enumerable < 0) return false;
  if (surveyed + enumerated !== enumerable) return false;
  if (tally !== surveyed) return false;
  if (inPerimeterWithoutEvidence < 0 || inPerimeterWithoutEvidence > enumerated) return false;
  return true;
}

/** The five runs of one available arm, in {@link MARK_ORDER}, zero-runs dropped. */
function runsOf(arm: BrainCoverageClassAvailable, unitsPerMark: number): readonly PlateMarkRun[] {
  const { enumerated, inPerimeterWithoutEvidence } = arm.ratio;
  const units: Record<PlateMarkKind, number> = {
    "surveyed-current": arm.freshness.current,
    "surveyed-stale": arm.freshness.stale,
    "surveyed-unverified": arm.freshness.unverified,
    "in-scope-no-evidence": inPerimeterWithoutEvidence,
    "visible-not-in-scope": enumerated - inPerimeterWithoutEvidence,
  };
  return MARK_ORDER.filter((kind) => units[kind] > 0).map((kind) => ({
    kind,
    units: units[kind],
    marks: scaleMarks(units[kind], unitsPerMark),
  }));
}

/** One class's arm, as a quad. */
function quadOf(
  sourceClass: BrainCoverageSourceClass,
  arm: BrainCoverageClass,
  unitsPerMark: number,
): PlateQuad {
  switch (arm.state) {
    case "not-surveyable":
      return { render: "off-survey", sourceClass };
    case "cannot-establish":
      return { render: "unsurveyed", sourceClass, reason: "cannot-establish", fault: true };
    case "never-enumerated":
      return {
        render: "unsurveyed",
        sourceClass,
        reason:
          arm.reason === "no-cycle-recorded" ? "never-enumerated" : "enumeration-never-succeeded",
        fault: false,
      };
    case "enumerated": {
      if (!drawable(arm)) return { render: "undrawable", sourceClass };
      if (arm.ratio.enumerable === 0) {
        // Enumerated successfully, and there was nothing. A MEASURED emptiness,
        // which is the only blank quad on this sheet that is a finding rather
        // than an absence of looking.
        return { render: "unsurveyed", sourceClass, reason: "measured-empty", fault: false };
      }
      const runs = runsOf(arm, unitsPerMark);
      return {
        render: "soundings",
        sourceClass,
        runs,
        markTotal: runs.reduce((sum, run) => sum + run.marks, 0),
        tornEdge: arm.mapEdges.length > 0,
        frozen: arm.unavailable !== null,
      };
    }
  }
}

/**
 * The sheet — the plate's whole input, derived from the wire and nothing else.
 *
 * Class order is {@link CLASS_ORDER}'s, unchanged and never re-sorted: sorting
 * quads by how much is surveyed would let the sheet lead with whichever class
 * happens to look best today, which is the same objection `vocabulary.ts` records
 * against sorting the paragraph.
 */
export function buildSheet(coverage: BrainCoverage): PlateSheet {
  const largest = CLASS_ORDER.reduce((max, cls) => {
    const arm = coverage.availability[cls];
    if (arm.state !== "enumerated" || !drawable(arm)) return max;
    return Math.max(max, unitsInQuad(arm));
  }, 0);
  const unitsPerMark = Math.max(1, Math.ceil(largest / MARKS_PER_QUAD_MAX));

  const all = CLASS_ORDER.map((cls) => quadOf(cls, coverage.availability[cls], unitsPerMark));
  const quads = all.filter((quad) => quad.render !== "off-survey");
  const margin = all.filter((quad): quad is PlateQuadOffSurvey => quad.render === "off-survey");
  const litQuads = quads.filter(
    (quad) => quad.render === "soundings" && quad.markTotal > 0,
  ).length;

  return { quads, margin, unitsPerMark, litQuads };
}
