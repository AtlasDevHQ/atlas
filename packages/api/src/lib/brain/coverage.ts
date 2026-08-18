/**
 * The Coverage Surface's composition layer (#5214, ADR-0041).
 *
 * ## What this module is
 *
 * ADR-0041 asks for one page from which an admin states what Atlas knows, how
 * much it covers, and what it does not know — *"every part correct, at 4% as
 * clearly as at 80%"*. This is the module that assembles that statement. It
 * COMPOSES and does not re-derive: the numerators come from `oversight.ts`, the
 * dated denominators from `coverage-enumeration.ts` (#5213), the per-class
 * policy answers from `class-contract.ts` (#5212). Nothing here decides what a
 * class may disclose, what its universe is, or whether it can measure a lag —
 * three questions with one declaration site each, and this file is a consumer of
 * all three.
 *
 * ## A SIBLING of `oversight.ts`, never folded into it
 *
 * ADR-0041 is explicit: *"A sibling module composing oversight, never folded
 * into it … the dependency is one-way."* Oversight answers *what has Atlas
 * observed and who is it federated to*; this answers *is it surveyed at all*.
 * They share a discipline and not a remit, and the import arrow points this way
 * only. An `import … from "./coverage"` appearing in `oversight.ts` is the
 * signal that the two remits merged.
 *
 * ## What it inherits from oversight, wholesale
 *
 * Not by resemblance — by the same failure argument, restated for denominators:
 *
 *   - **No silent zeros.** A degraded counter travels to the wire
 *     ({@link BrainCoverage.countsConsistent}) rather than being clamped to the
 *     reassuring value. Every degradation on this surface flatters: a smaller
 *     denominator RAISES a ratio, a dropped map edge makes the map read
 *     complete, a missing snapshot reads as "nothing to see".
 *   - **Dropped rows are loud.** A roster row this deploy cannot interpret is
 *     an under-report, and an under-report here is the flattering direction.
 *   - **A missing snapshot is a sentence, never zero.** "Enumeration
 *     unavailable since \<date\>" and "never enumerated" are separate arms with
 *     no counts on them, so a zero cannot be spelled where a refusal belongs.
 *   - **The false-all-clear direction throws.** One state qualifies and it is
 *     narrow: a class that DECLARES a denominator but whose roster this deploy
 *     cannot read. See {@link CoverageCompositionError}.
 *
 * ## The three shapes that carry the honesty model
 *
 * Stated here because each is a decision that looks like a style choice:
 *
 *   1. **`Record<EpisodeSourceClass, …>`, not a list.** A class added without a
 *      coverage answer is a compile error. In a list, an absent class and a
 *      class with nothing to say are the same row — opposite statements.
 *   2. **A ratio carries its unit.** Blending needs two ratios whose `unit`
 *      differs, and no two classes share one. ADR-0041's "No single number,
 *      permanently" is a property of the shape rather than a rule someone has to
 *      remember downstream.
 *   3. **The unit list holds only NAMABLE units.** Withheld units are a count
 *      and a freshness tally, never a row with a hidden identity. The wire has
 *      no field a mailbox address could occupy.
 *
 * @see ../../../../../docs/adr/0041-the-coverage-surface-counts-what-it-can-see.md
 * @see ./oversight.ts — the authority arm, composed unchanged
 * @see ./coverage-enumeration.ts — the dated denominators this reads
 * @see ./class-contract.ts — vendor-public, staleness capability, denominator source
 */

import { createLogger } from "@atlas/api/lib/logger";
import type { BrainPrincipalContext } from "@atlas/api/lib/brain/acl";
import type { BrainCandidateReader } from "@atlas/api/lib/brain/candidates";
import { loadFactOversight } from "@atlas/api/lib/brain/oversight";
import {
  classDenominator,
  coverageLabelPolicy,
  stalenessVerdict,
  type ClassContractLogMeta,
} from "@atlas/api/lib/brain/class-contract";
import {
  readCoverageSnapshot,
  readCoverageUnits,
  surveyableClassOf,
  type CoverageClassSnapshot,
  type CoverageUnitRow,
  type SurveyableSourceClass,
} from "@atlas/api/lib/brain/coverage-enumeration";
import { EPISODE_SOURCE_CLASSES, type EpisodeSourceClass } from "@atlas/api/lib/brain/sources";
import type {
  BrainCoverage,
  BrainCoverageClass,
  BrainCoverageFreshness,
  BrainCoverageLabelClause,
  BrainCoverageMapEdge,
  BrainCoverageNamedUnit,
  BrainCoverageSourceClass,
  BrainCoverageUnitOrigin,
  BrainFactOversight,
} from "@useatlas/types";

const log = createLogger("brain-coverage");

// ---------------------------------------------------------------------------
// The mirrors, pinned
// ---------------------------------------------------------------------------

/**
 * Mutual assignability — BOTH directions are errors, exactly as
 * `class-contract.ts`'s `_CONTRACT_KEYS_IN_SYNC` needs and for its reason.
 *
 * A one-way `extends` would let the wire union GROW silently: a
 * `BrainCoverageSourceClass` member with no class behind it is a key the
 * `Record` can never hold, so the page would carry a row nothing can ever fill
 * and a client would render a permanently blank class.
 */
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

/**
 * ⚠️ **The pin `@useatlas/types` cannot carry itself.** That package is
 * published and imports nothing from `@atlas/api`, so its
 * {@link BrainCoverageSourceClass} is a hand-written mirror of the class axis
 * and only this line makes it one. Deleting it does not break a test — it
 * silently permits the two to diverge, and the divergence's symptom is a class
 * missing from a page whose entire promise is that no class can be missing.
 */
const _COVERAGE_CLASS_AXIS_IN_SYNC: MutuallyAssignable<
  BrainCoverageSourceClass,
  EpisodeSourceClass
> = true;
void _COVERAGE_CLASS_AXIS_IN_SYNC;

/**
 * The unit vocabulary's mirror, pinned for a sharper reason than the class
 * axis's: {@link BrainCoverageUnitOrigin} is what makes a blended percentage
 * unspellable. If the wire union drifted to carry a member the contract does not
 * declare — or, worse, if one member were spelled the same on two classes — the
 * "no two classes share a unit" guarantee would be gone with nothing red.
 */
const _COVERAGE_UNIT_AXIS_IN_SYNC: MutuallyAssignable<
  BrainCoverageUnitOrigin,
  SurveyUnitOriginOfContract
> = true;
void _COVERAGE_UNIT_AXIS_IN_SYNC;

/** The origins the class contract actually declares — read off the map, not restated. */
type SurveyUnitOriginOfContract = Extract<
  ReturnType<typeof classDenominator>,
  { surveyable: true }
>["enumeratedFrom"];

/**
 * The map-edge mirror. Its drift direction is the flattering one: an arm this
 * deploy's wire union does not carry is a mark that vanishes, and a vanished
 * mark reads as *"the map is complete"*.
 */
const _COVERAGE_MAP_EDGE_AXIS_IN_SYNC: MutuallyAssignable<
  BrainCoverageMapEdge,
  CoverageClassSnapshot["degraded"][number]
> = true;
void _COVERAGE_MAP_EDGE_AXIS_IN_SYNC;

/**
 * The label-clause mirror — the fourth, and the one whose drift is a DISCLOSURE
 * rather than a number.
 *
 * `CoverageLabelDecision` carries which of ADR-0041's two clauses admitted a
 * unit rather than a bare boolean, precisely so a change that swaps which clause
 * is doing the work is visible; that is worth nothing if the wire union can
 * quietly gain a third member the contract never mints, or lose one the contract
 * still does.
 */
const _COVERAGE_CLAUSE_AXIS_IN_SYNC: MutuallyAssignable<
  BrainCoverageLabelClause,
  Extract<ReturnType<typeof coverageLabelPolicy>, { policy: "name" }>["clause"]
> = true;
void _COVERAGE_CLAUSE_AXIS_IN_SYNC;

// ---------------------------------------------------------------------------
// Bounds and failures
// ---------------------------------------------------------------------------

/**
 * Most NAMABLE units one class's listing carries.
 *
 * A bound, not a policy — `OVERSIGHT_BUCKET_MAX`'s argument one surface over. A
 * chat roster is bounded by a workspace's channel count and a warehouse roster
 * by enrolled (entity, dimension) pairs, neither of which has a ceiling at rest.
 * Overrun is REPORTED (`unitsTruncated`), never silent: a clipped list reads as
 * the whole roster, and the counts beside it would then look like they disagreed
 * with the rows.
 *
 * The COUNTS are unaffected — they are tallied over every row read, before the
 * clip — so the top-line statement stays exact when the listing is not.
 */
export const COVERAGE_UNITS_MAX = 200;

/**
 * The one false-all-clear this module throws on.
 *
 * A class whose contract DECLARES an enumerable universe but which
 * `coverage-enumeration.ts` cannot hold a roster for — `surveyableClassOf`
 * returns `null` — is a class the page has no true sentence for. Every available
 * answer is a false statement in the flattering direction: `never-enumerated`
 * says nobody has looked, when the contract says there is something to look at;
 * an empty `enumerated` arm says the map is complete and empty. So the request
 * fails with a requestId an operator can correlate, which is ADR-0041's
 * *"the false-all-clear direction throws"* applied to the only state that
 * qualifies.
 *
 * Unreachable through the declarations as they stand — `coverage-enumeration.test.ts`
 * pins `SURVEYABLE_SOURCE_CLASSES` against `CLASS_CONTRACTS`, so the two agree —
 * which is precisely why this is a throw rather than a degraded arm. It cannot
 * fire on a healthy deploy, and if it ever does, the alternative is a page that
 * quietly stops accounting for a whole class.
 */
export class CoverageCompositionError extends Error {
  constructor(
    readonly workspaceId: string,
    readonly sourceClass: string,
    readonly requestId?: string,
  ) {
    super(
      `brain coverage: source class ${sourceClass} declares an enumerable universe but holds no roster in this deploy ` +
        `(workspace ${workspaceId}, request ${requestId ?? "unknown"}) — refusing to render a coverage statement that omits it`,
    );
    this.name = "CoverageCompositionError";
  }
}

// ---------------------------------------------------------------------------
// The composition
// ---------------------------------------------------------------------------

/** Mutable cell for the wire's one degradation signal — `oversight.ts`'s `DegradedCounters`. */
interface CoverageDegraded {
  hit: boolean;
}

/**
 * The Coverage Surface, composed.
 *
 * ## One request, not one snapshot
 *
 * `loadFactOversight`'s own caveat, inherited: the authority read, the cycle
 * read and each class's roster read are separate statements on a pool, so they
 * land at different LSNs. What that buys is that both arms of the page cannot
 * drift between two CLIENT fetches. What it does not buy is transactional
 * consistency — a cycle committing between the cycle read and a roster read can
 * legitimately make the two disagree, which is reported through
 * {@link BrainCoverage.countsConsistent} rather than clamped or thrown on.
 *
 * @throws {BrainReaderUnresolvedError} from `loadFactOversight`, unchanged: a
 *   reader whose identity did not resolve must not be served the workspace's
 *   shape, and its paired `reviewableAwaitingReview` would be a fabricated zero.
 * @throws {CoverageCompositionError} see that class — the one false-all-clear.
 */
export async function loadCoverage(
  db: BrainCandidateReader,
  ctx: BrainPrincipalContext,
  requestId?: string,
): Promise<BrainCoverage> {
  const workspaceId = ctx.workspaceId;

  // Both arms in flight together. The authority read is the one that can refuse
  // outright (an unresolved reader), and letting it race the denominators costs
  // nothing: a rejection here rejects the whole load, which is the intent.
  const [authority, snapshots] = await Promise.all([
    loadFactOversight(db, ctx, requestId),
    readCoverageSnapshot(workspaceId),
  ]);

  // Every surveyable class's roster, in parallel — a serial loop here would be
  // four round trips deep on a page whose whole content is these four answers.
  //
  // ⚠️ COST, stated because a page render is the wrong time to discover it: this
  // reads EVERY roster row, uncapped, and the listing is clipped afterwards. The
  // cap cannot move into the SQL, and the reason is the identity that makes a
  // withheld unit's staleness disclosable at all — the freshness tally is
  // computed over the same pass and must sum to `ratio.surveyed`, so a capped
  // read would tally a capped subset and quietly under-report how much of a
  // class is stale. Bounded in practice by a workspace's channel count and its
  // enrolled (entity, dimension) pairs; the warehouse side is the one that grows
  // without a vendor ceiling, and it wants a SQL-side tally — not a smaller read
  // — well before it is a problem.
  const dated = new Set(snapshots.filter((s) => s.asOf !== null).map((s) => s.sourceClass));
  const rosterClasses = EPISODE_SOURCE_CLASSES.flatMap((cls) => {
    const surveyable = surveyableClassOf(cls);
    // A class with no SUCCESSFUL cycle has never established a roster, so the
    // read would be a round trip for zero rows — and `composeCoverage` refuses
    // to reach a roster for such a class anyway.
    return surveyable !== null && dated.has(surveyable) ? [surveyable] : [];
  });
  const rosters = new Map<SurveyableSourceClass, readonly CoverageUnitRow[]>(
    await Promise.all(
      rosterClasses.map(
        async (cls) => [cls, await readCoverageUnits(workspaceId, cls)] as const,
      ),
    ),
  );

  return composeCoverage({ workspaceId, requestId, authority, snapshots, rosters, at: new Date() });
}

/** Everything the composition needs, with the reads already done. */
export interface CoverageComposition {
  readonly workspaceId: string;
  readonly requestId?: string;
  /** `loadFactOversight`'s payload — the authority arm, carried through unchanged. */
  readonly authority: BrainFactOversight;
  /** One cycle row per class this workspace has ever enumerated. */
  readonly snapshots: readonly CoverageClassSnapshot[];
  /** Per class, the stored roster. A class absent here has none. */
  readonly rosters: ReadonlyMap<SurveyableSourceClass, readonly CoverageUnitRow[]>;
  /**
   * The instant this statement is made — required, never defaulted here.
   *
   * A `current` verdict is a claim about the PRESENT resting on a vendor reading
   * taken in the past, so the reading's own age has to be measurable, and that
   * needs a now. Taken as a parameter rather than read from `Date.now()` inside
   * because the whole point of this seam is that a fixture can drive it: with a
   * hidden clock, "the reading expired" is a case a test can only reach by
   * waiting.
   */
  readonly at: Date;
}

/**
 * The composition itself, with no IO — the seam every honesty claim is asserted
 * through.
 *
 * Split out of {@link loadCoverage} deliberately, and not merely for
 * testability. ADR-0041's fixture charter requires that *"test vendor rosters
 * are authored independently of the snapshots the page reads"*, and a suite that
 * had to reach these inputs through `mock.module` on `coverage-enumeration.ts`
 * would be authoring both sides through one mock — the *fixtures that agree by
 * construction* class the charter exists to refuse. Here the inputs are
 * ordinary values, so a fixture can build a vendor-side truth, derive the stored
 * rows from it, and then break the derivation on purpose.
 */
export function composeCoverage(input: CoverageComposition): BrainCoverage {
  const { workspaceId, requestId, authority } = input;
  const meta: ClassContractLogMeta = {
    workspaceId,
    ...(requestId !== undefined ? { requestId } : {}),
  };
  const degraded: CoverageDegraded = { hit: false };
  const byClass = indexSnapshots(input.snapshots, workspaceId, requestId, degraded);
  const rosters = input.rosters;

  const availability = {} as Record<BrainCoverageSourceClass, BrainCoverageClass>;
  for (const cls of EPISODE_SOURCE_CLASSES) {
    availability[cls] = composeClass({
      cls,
      at: input.at,
      snapshot: byClass.get(cls),
      rosters,
      workspaceId,
      requestId,
      meta,
      degraded,
    });
  }

  // ⚠️ There is deliberately NO runtime totality guard behind the loop above.
  // One was written — `if (availability[cls] === undefined) throw` — and it
  // cannot fire: the loop that assigns and the loop that would check both
  // iterate `EPISODE_SOURCE_CLASSES`, and `EpisodeSourceClass` IS
  // `(typeof EPISODE_SOURCE_CLASSES)[number]`, so the divergence it claimed to
  // catch is unrepresentable. `class-contract.ts` states the rule it broke: a
  // second guard behind an exhaustive one is "an arm no input can reach,
  // carrying a comment claiming it does work" — and this one also threw
  // `CoverageCompositionError`, whose message asserts a different diagnosis
  // entirely, so the impossible case would have misdirected the operator
  // correlating on its requestId. The `Record` type is the guarantee.
  return {
    availability,
    authority,
    // The authority arm's own verdict is folded in rather than restated beside
    // it: a client showing one banner should not have to know there are two
    // fields that mean "the arithmetic disagreed". `authority.countsConsistent`
    // stays on the wire untouched for a client that wants to say WHICH arm.
    countsConsistent: !degraded.hit && authority.countsConsistent,
  };
}

/**
 * Index the cycle rows by class, and refuse to let a duplicate pass quietly.
 *
 * `brain_coverage_cycle` is keyed `(workspace_id, source_class)`, so a duplicate
 * is unreachable through the writers. Logged rather than thrown because the
 * arbitrary winner is still a real reading — but LOUD, because the two rows
 * would carry different dates, and "which of two `as of` stamps is on the page"
 * is not a question a reader can answer from the page.
 */
function indexSnapshots(
  snapshots: readonly CoverageClassSnapshot[],
  workspaceId: string,
  requestId: string | undefined,
  degraded: CoverageDegraded,
): Map<string, CoverageClassSnapshot> {
  const byClass = new Map<string, CoverageClassSnapshot>();
  for (const snapshot of snapshots) {
    if (byClass.has(snapshot.sourceClass)) {
      degraded.hit = true;
      log.error(
        { workspaceId, requestId, sourceClass: snapshot.sourceClass },
        "brain coverage: two cycle rows came back for one class — the page's 'as of' date for it is arbitrary, and its counts may belong to the other reading",
      );
      continue;
    }
    byClass.set(snapshot.sourceClass, snapshot);
  }
  return byClass;
}

/** Everything one class's arm is composed from. */
interface ClassComposition {
  readonly cls: EpisodeSourceClass;
  /** See {@link CoverageComposition.at}. */
  readonly at: Date;
  readonly snapshot: CoverageClassSnapshot | undefined;
  readonly rosters: ReadonlyMap<SurveyableSourceClass, readonly CoverageUnitRow[]>;
  readonly workspaceId: string;
  readonly requestId: string | undefined;
  readonly meta: ClassContractLogMeta;
  readonly degraded: CoverageDegraded;
}

/**
 * One class's answer — the three states, plus the two ways there is no answer.
 *
 * Order is load-bearing and reads top-down as the questions get more specific:
 * *does this class have a universe at all* (the contract), *has anything ever
 * been established* (the cycle row), *what did it establish* (the roster). Each
 * refusal is answered from the narrowest source that can answer it, so a class
 * with no universe never reaches a roster read and a class with no cycle never
 * reaches a count.
 */
function composeClass(input: ClassComposition): BrainCoverageClass {
  const { cls, snapshot, meta, workspaceId, requestId, degraded } = input;

  const denominator = classDenominator(cls, meta);
  if (!denominator.surveyable) {
    // Two refusals, deliberately not collapsed: `human` DECIDED it has no
    // enumerable universe (its units would be people), and an unresolvable class
    // is a deploy that does not know what this is. Same absence from every
    // ratio, different sentences, and only one of them is a bug.
    //
    // The second is unreachable while `CLASS_CONTRACTS` is total over
    // `EPISODE_SOURCE_CLASSES` — the `satisfies` in `class-contract.ts` is what
    // makes it so, and this loop iterates that same list. It is rendered rather
    // than asserted away because ADR-0041 asks the page for a "cannot establish"
    // arm, and the alternative to having one is a class that silently reports
    // nothing.
    return denominator.reason === "non-surveyable-class"
      ? { state: "not-surveyable", reason: "non-surveyable-class" }
      : { state: "cannot-establish", reason: "unresolvable-class" };
  }

  const surveyable = surveyableClassOf(cls);
  if (surveyable === null) {
    // The declarations disagree — see {@link CoverageCompositionError}. There is
    // no honest arm to return, so nothing is returned.
    throw new CoverageCompositionError(workspaceId, cls, requestId);
  }

  if (snapshot === undefined) {
    return {
      state: "never-enumerated",
      reason: "no-cycle-recorded",
      lastAttemptAt: null,
      unavailableReason: null,
    };
  }
  if (snapshot.asOf === null) {
    // A cycle EXISTS and has never once succeeded. Distinct from the arm above
    // because this one has an attempt to report and a reason to render, and
    // because "we have tried and failed" is a different sentence from "nobody
    // has looked". Neither carries counts: `CoverageClassSnapshot` would happily
    // hand over `surveyed: 0`, and a zero here would read as a measured empty
    // roster rather than as an absent one.
    return {
      state: "never-enumerated",
      reason: "no-successful-cycle",
      lastAttemptAt: snapshot.lastAttemptAt,
      unavailableReason: snapshot.unavailableReason,
    };
  }

  return composeAvailable({ ...input, snapshot, surveyable, asOf: snapshot.asOf, degraded });
}

/** The available arm — the only one that carries numbers. */
function composeAvailable(
  input: ClassComposition & {
    readonly snapshot: CoverageClassSnapshot;
    readonly surveyable: SurveyableSourceClass;
    readonly asOf: string;
  },
): BrainCoverageClass {
  const { cls, at, snapshot, surveyable, asOf, meta, workspaceId, requestId, degraded } = input;
  const rows = input.rosters.get(surveyable) ?? [];

  const verdict = stalenessVerdict(cls, meta);
  // ADR-0041 puts a sick pipe on the SAME sentence as a class that cannot ask:
  // "Where activity metadata doesn't exist, OR the pipe is sick, the unit is
  // 'unverified since <date of last successful cycle>'". A failed latest attempt
  // means nobody looked this cycle, so no reading taken before it may be
  // reported as a current verdict about now.
  const pipeSick = snapshot.unavailableReason !== null;

  let surveyed = 0;
  let enumerated = 0;
  let inPerimeterWithoutEvidence = 0;
  let current = 0;
  let stale = 0;
  let unverified = 0;
  let withheld = 0;
  // ⚠️ COUNTED and reported ONCE, never per row. The trigger is a CONTRACT-wide
  // change — a class argued shut on `vendorPublic` — so it fires for every row
  // carrying a stored label, on every page load, until the next enumeration
  // cycle rewrites them. Per row that is thousands of identical lines per
  // request on a large roster, which buries the `workspaceId` the line exists to
  // carry. `coverageLabelPolicy` makes the same choice one seam over, in the
  // same words: bound the volume by the fault rather than by unit count.
  let refusedStoredLabels = 0;
  const named: BrainCoverageNamedUnit[] = [];

  for (const row of rows) {
    const decision = coverageLabelPolicy(cls, row.disclosure, meta);
    if (decision.policy !== "name" && row.label !== null) refusedStoredLabels++;
    const label = nameFor(row, decision);

    // ⚠️ **Green needs BOTH halves, and this line is the only place that is
    // decided.** ADR-0040 rule 3: green is evidence, never configuration — and
    // its converse, which is the half a reader forgets: evidence is not green
    // either. A unit carries a `newest_evidence_at` for as long as the row
    // lives, so a channel the bot was REMOVED from keeps the date of the last
    // thing Atlas read there. Reading the date alone would leave it green
    // forever, on a source nobody can read any more.
    //
    // Written as one narrowing rather than as a boolean plus a re-test at the
    // use site. Measured: with the second `evidenceAt !== null` in the branch,
    // this mutation was absorbed — dropping the state half changed nothing and
    // the mutation table read `0` for a rule the module header calls
    // load-bearing.
    const evidenceAt = row.state === "surveyed" ? row.newestEvidenceAt : null;
    if (row.state === "surveyed" && evidenceAt === null) {
      degraded.hit = true;
      log.error(
        { workspaceId, requestId, sourceClass: cls },
        "brain coverage: a roster row is stored as surveyed with no evidence behind it — counting it as unsurveyed, because the other direction would report a green unit Atlas has never read",
      );
    }

    if (evidenceAt !== null) {
      surveyed++;
      const freshness = freshnessOf({
        row,
        at,
        evidenceAt,
        verdict,
        pipeSick,
        asOf,
        cls,
        workspaceId,
        requestId,
        degraded,
      });
      if (freshness.kind === "current") current++;
      else if (freshness.kind === "stale") stale++;
      else unverified++;
      if (label !== null) {
        named.push({
          state: "surveyed",
          unitId: row.unitId,
          label: label.label,
          clause: label.clause,
          newestEvidenceAt: evidenceAt,
          freshness,
        });
      } else {
        withheld++;
      }
      continue;
    }

    enumerated++;
    if (row.inPerimeter) inPerimeterWithoutEvidence++;
    if (label !== null) {
      named.push({
        state: "enumerated",
        unitId: row.unitId,
        label: label.label,
        clause: label.clause,
        inPerimeter: row.inPerimeter,
      });
    } else {
      withheld++;
    }
  }

  if (refusedStoredLabels > 0) {
    // A stored disclosure the current policy refuses. The write path ran the same
    // policy before the insert, so the two disagreeing means the contract changed
    // since — and the rows keep the labels at rest until the next cycle rewrites
    // them, which is why the count is worth an operator's attention rather than
    // just being silently dropped on the way to the wire.
    log.warn(
      { workspaceId, requestId, sourceClass: cls, units: refusedStoredLabels },
      "brain coverage: stored unit labels are no longer admitted by any clause — they are withheld from the response, and the roster still holds them until the next enumeration cycle rewrites those rows",
    );
  }

  // Two independent statements about the same rows: the aggregate the cycle read
  // computed in SQL, and the tally over the rows this composition classified.
  // They can differ for an innocent reason — a cycle committing between the two
  // reads, `loadFactOversight`'s non-transactional caveat one table over — and
  // for a guilty one, which is why the disagreement is reported rather than
  // resolved. The TALLY is what ships, because the freshness counts are computed
  // from the same pass and must sum to it.
  if (snapshot.degradedIncomplete) {
    // The stored marks held arms this deploy has no sentence for, so `mapEdges`
    // below is itself incomplete — and its empty case is the one that renders as
    // *"the map of what these credentials can see is complete"*. Reachable by a
    // rollback below the build that first wrote the arm. Travels as a
    // degradation of the whole statement rather than as a fourth kind of mark:
    // what is unknown is WHICH edges exist, not where one is, and inventing a
    // mark for it would be a map edge nobody enumerated.
    degraded.hit = true;
  }

  if (
    snapshot.surveyed !== surveyed ||
    snapshot.enumerated !== enumerated ||
    // The M1 number — "invited, configured, reading nothing" — is guarded too,
    // and it needs saying because it is the one an earlier cut left out. It is
    // derived by a different SQL expression from the other two
    // (`state = 'enumerated' AND in_perimeter`), so a mis-derivation of it alone
    // is exactly the shape that would ship under two green comparisons.
    snapshot.inPerimeterWithoutEvidence !== inPerimeterWithoutEvidence
  ) {
    degraded.hit = true;
    log.warn(
      {
        workspaceId,
        requestId,
        sourceClass: cls,
        aggregate: {
          surveyed: snapshot.surveyed,
          enumerated: snapshot.enumerated,
          inPerimeterWithoutEvidence: snapshot.inPerimeterWithoutEvidence,
        },
        tallied: { surveyed, enumerated, inPerimeterWithoutEvidence },
      },
      "brain coverage: the cycle aggregate and the roster rows disagree about this class — expected only as a brief race with a committing cycle; if it persists the two reads disagree about the workspace and the ratio is not trustworthy",
    );
  }

  const truncated = named.length > COVERAGE_UNITS_MAX;
  if (truncated) {
    log.warn(
      { workspaceId, requestId, sourceClass: cls, cap: COVERAGE_UNITS_MAX, namable: named.length },
      "brain coverage: this class has more namable units than one response carries — the listing is clipped, the counts are not",
    );
  }

  return {
    state: "enumerated",
    asOf,
    ratio: {
      surveyed,
      enumerated,
      // Carried rather than left to the client, so the denominator on the page is
      // the denominator this module computed. A client that adds two numbers is
      // one edit from adding two CLASSES' numbers, which is the blend ADR-0041
      // refuses.
      enumerable: surveyed + enumerated,
      inPerimeterWithoutEvidence,
      unit: denominatorUnitOf(cls),
    },
    freshness: { current, stale, unverified },
    units: truncated ? named.slice(0, COVERAGE_UNITS_MAX) : named,
    unitsWithheld: withheld,
    unitsTruncated: truncated,
    mapEdges: snapshot.degraded,
    // "Enumeration unavailable since <date>" OVER dated counts, not instead of
    // them: the counts are still the best Atlas has, they are simply older than
    // the page's freshness would suggest. `since` is the last SUCCESS — the date
    // the counts are true as of — never the failed attempt's time.
    unavailable:
      snapshot.unavailableReason === null
        ? null
        : { since: asOf, reason: snapshot.unavailableReason },
  };
}

/** The unit a class's ratio is counted in — read off the contract, never restated. */
function denominatorUnitOf(cls: EpisodeSourceClass): BrainCoverageUnitOrigin {
  const denominator = classDenominator(cls);
  if (!denominator.surveyable) {
    // Unreachable: `composeClass` returns on the non-surveyable arms before this
    // is called, and the class value is the same one. A throw rather than a
    // fallback literal, because every fallback here is a unit slug that would
    // make two classes' ratios look addable.
    throw new Error(
      `brain coverage: denominatorUnitOf was asked for a non-surveyable class (${cls}) — the composition reached a ratio for a class with no universe`,
    );
  }
  return denominator.enumeratedFrom;
}

/**
 * A unit's name and the clause that admitted it, or `null` for
 * counted-never-named.
 *
 * The read-time half of ADR-0041's label rule. The write path already ran the
 * same policy before the insert and stored `NULL` when it refused; running it
 * again over the stored disclosure facts is what stops a stored label OUTLIVING
 * the clause that admitted it, because the row keeps whatever the contract said
 * on the day it was written until the next cycle rewrites it.
 *
 * Silent by design — the caller counts the refusals and reports them once per
 * class. See the loop.
 */
function nameFor(
  row: CoverageUnitRow,
  decision: ReturnType<typeof coverageLabelPolicy>,
): { readonly label: string; readonly clause: BrainCoverageLabelClause } | null {
  if (decision.policy !== "name") return null;
  // The policy admits a name and there is none to show. Not a defect: an
  // enumerator with no human-readable surface for a unit stores NULL by design
  // (`EnumeratedSurveyUnit.label`), and a clause that WOULD admit a name it does
  // not have is simply a unit with nothing to render. Counted, like the rest.
  if (row.label === null) return null;
  return { label: row.label, clause: decision.clause };
}

/**
 * ADR-0041's staleness rules, in the order they refuse.
 *
 * Read as a sequence of refusals rather than as a classification: the word
 * "stale" is licensed last and only by a measurement, and every earlier arm is a
 * reason we are not entitled to it. That order is the decision — inverted, the
 * cheapest arm to reach would be the confident one.
 */
function freshnessOf(input: {
  readonly row: CoverageUnitRow;
  /** See {@link CoverageComposition.at}. */
  readonly at: Date;
  readonly evidenceAt: string;
  readonly verdict: ReturnType<typeof stalenessVerdict>;
  readonly pipeSick: boolean;
  readonly asOf: string;
  readonly cls: EpisodeSourceClass;
  readonly workspaceId: string;
  readonly requestId: string | undefined;
  readonly degraded: CoverageDegraded;
}): BrainCoverageFreshness {
  const { row, at, evidenceAt, verdict, pipeSick, asOf, cls, workspaceId, requestId, degraded } =
    input;

  // 1. The pipe is sick. Checked FIRST, ahead of the class's capability, because
  //    a class that CAN measure a lag still did not look this cycle — and a
  //    reading taken before a failed cycle says nothing about now.
  if (pipeSick) {
    return { kind: "unverified-since", since: asOf, reason: "enumeration-unavailable" };
  }
  // 2. The class cannot ask. `warehouse` and `human` declare it, and that is the
  //    arm this reaches in practice.
  //
  //    ⚠️ The `unresolvable-class` half is UNREACHABLE from here today, and is
  //    kept rather than collapsed. `composeClass` returns `cannot-establish`
  //    before any roster is read, so a class whose contract does not resolve
  //    never gets as far as a unit — the two arms would have to stop agreeing
  //    about what "unresolvable" means for this to fire. Collapsing it to
  //    `no-activity-metadata` would then say a class DECLARED it cannot ask, on
  //    the one occasion nobody declared anything, which is the distinction a
  //    page can render and a log line cannot.
  if (verdict.kind === "unverified-since") {
    return {
      kind: "unverified-since",
      since: asOf,
      reason: verdict.reason === "unresolvable-class" ? "unresolvable-class" : "no-activity-metadata",
    };
  }
  // 3. Nobody has asked about this unit yet. The probe rotation is bounded, so an
  //    unprobed unit is expected rather than a fault — but it is emphatically not
  //    "current", which would be an all-clear about a source nobody queried.
  if (!row.activity.probed) {
    return { kind: "unverified-since", since: asOf, reason: "not-probed" };
  }
  // 4. We asked — but longer ago than the class's cadence, so the answer no
  //    longer supports a present-tense verdict.
  //
  //    ⚠️ This arm is what stops "current" resting on a reading of unbounded
  //    age, and the rotation makes that age REAL rather than theoretical:
  //    `CHAT_ACTIVITY_PROBES_PER_CYCLE` is 20 per hourly cycle and the upsert
  //    deliberately carries an unprobed unit's previous reading forward, so a
  //    5,000-channel workspace re-probes each unit roughly every ten days. Both
  //    arms below would then compare a ten-day-old vendor answer against a
  //    24-hour threshold and return `current` — a confident all-clear about a
  //    channel that may have been moving daily since we last looked.
  //
  //    Refused rather than called stale: we do not know whether the source
  //    moved, and guessing in EITHER direction is what ADR-0041 puts on this
  //    sentence. `since` is the reading's own date, which is both the stronger
  //    statement and the one the rotation can act on.
  const checkedAtMs = Date.parse(row.activity.checkedAt);
  if (!Number.isFinite(checkedAtMs)) {
    degraded.hit = true;
    log.error(
      { workspaceId, requestId, sourceClass: cls },
      "brain coverage: a unit's probe timestamp did not parse — reporting it unverified rather than current, because a green unit is the direction this cannot be wrong in",
    );
    return { kind: "unverified-since", since: asOf, reason: "unreadable-reading" };
  }
  if (at.getTime() - checkedAtMs > verdict.syncCadenceMs) {
    return {
      kind: "unverified-since",
      since: row.activity.checkedAt,
      reason: "reading-expired",
    };
  }

  // 5. Asked recently, and the vendor reports no activity at all. ADR-0041:
  //    "Quiet ≠ stale: a source that hasn't moved is current, however old its
  //    newest evidence." This is the arm that makes that true, and it is the one
  //    a reasonable implementation gets wrong by treating a NULL reading as
  //    missing rather than as an answer.
  if (row.activity.at === null) return { kind: "current", checkedAt: row.activity.checkedAt };

  const movedAt = Date.parse(row.activity.at);
  const observedAt = Date.parse(evidenceAt);
  if (!Number.isFinite(movedAt) || !Number.isFinite(observedAt)) {
    // A reading we hold and cannot read. Never "current" — that is the flattering
    // direction and the one this whole module is organised against — and never
    // "stale" either, which would assert a lag nothing measured.
    degraded.hit = true;
    log.error(
      { workspaceId, requestId, sourceClass: cls },
      "brain coverage: a unit's stored timestamps did not parse — reporting it unverified rather than current, because a green unit is the direction this cannot be wrong in",
    );
    return { kind: "unverified-since", since: asOf, reason: "unreadable-reading" };
  }

  // 6. The measurement. ADR-0041: stale is "vendor activity metadata shows source
  //    movement newer than our newest observed evidence by MORE THAN the class's
  //    sync cadence". Strictly greater — a lag exactly one cadence long is the
  //    sync arriving on time, which is the system working rather than failing.
  const lagMs = movedAt - observedAt;
  if (lagMs <= verdict.syncCadenceMs) {
    return { kind: "current", checkedAt: row.activity.checkedAt };
  }
  return {
    kind: "stale",
    vendorActivityAt: row.activity.at,
    newestEvidenceAt: evidenceAt,
    lagMs,
    // The threshold travels with the verdict so a reader can check the
    // arithmetic. A badge with no denominator is exactly the "judgment wearing a
    // measurement's clothes" ADR-0041 rejects thresholds for.
    cadenceMs: verdict.syncCadenceMs,
  };
}
