/**
 * The extraction cascade's measurement, as arithmetic — #5338's acceptance
 * criteria 3, 4 and 5.
 *
 * `heldout-manifest.ts` names the set. This module turns a labelled set plus a
 * {@link Triager} into the two numbers #5338 exists to produce, and decides
 * whether they clear the threshold. It touches no database and no model: the
 * harness in `packages/api/scripts/measure-triage.ts` is the CLI around it, on
 * the same split `gate-export.ts` / `ops-gate-export.ts` uses, so the
 * arithmetic is testable without a fixture file or a process.
 *
 * ## Why recall has to be measured COUNTERFACTUALLY
 *
 * `gate-export`'s negative arm requires `extracted_at IS NOT NULL`, and triage
 * runs *before* extraction — so a triaged-out episode never appears in any
 * bundle at all. You cannot observe triage's misses by looking at what triage
 * let through. The only honest measurement replays the layer over a set cut
 * from a window in which it was off, and asks what it WOULD have dropped. That
 * is what {@link replayTriage} does, and it is why the manifest's dial
 * precondition is load-bearing rather than ceremonial.
 *
 * ## ⭐ The threshold is a PAIR, and the second half is what makes it fail-able
 *
 * Recall alone is satisfiable by a no-op: a triage layer that drops nothing
 * scores 100%. Stage 0 with every rule disabled passes a recall-only criterion
 * perfectly while delivering none of what #5334 exists for. So the gate is:
 *
 *   1. **Recall** ≥ {@link RECALL_MIN} observed, **and** its 95% Wilson lower
 *      bound ≥ {@link WILSON_LCB_MIN}. The lower-bound clause is what makes the
 *      number non-arbitrary rather than chosen: by the rule of three, zero
 *      observed misses clears a 95% lower bound only at n ≥ 60, and tolerating
 *      one miss needs n ≥ ~100 — so the SET SIZE falls out of the threshold
 *      instead of being picked separately.
 *   2. **Yield**, relatively: the composed layer must drop **strictly more**
 *      episodes than the stage-0 baseline at **no worse** recall. Relative and
 *      not absolute because nobody has measured what fraction of a real channel
 *      is noise, and a "≥30%" would be a number wearing a measurement's
 *      clothes. *"Beat the rules you already shipped"* is a bar that can
 *      genuinely fail.
 *
 * ⚠️ **This is a COST threshold, not a safety one**, and only because #5336
 * stage 1 is constrained to mark-never-discard: a miss becomes a visible,
 * re-queueable backlog (`triaged_out_at` + #5534's requeue surface) rather than
 * a lost fact. If that constraint is ever relaxed, the honest threshold is
 * near-1 and this arithmetic is the wrong arithmetic.
 *
 * ## The recall denominator is EPISODES, not claims
 *
 * #5338: *"denominator = episodes yielding a published, non-retracted fact"*.
 * Triage drops episodes, so the question is per-episode — which is exactly the
 * grain {@link HeldoutClass} carries after `heldout-manifest.ts`'s collapse.
 * `positive` is the gating denominator; `positive` ∪ `rejected` is the ungated
 * diagnostic ({@link TriageMeasurement.diagnosticRecall}) with its own named
 * alarm: materially below the gating number means the filter learned reviewer
 * TASTE rather than claim PRESENCE, which is a different and worse thing to
 * have built.
 */
import type { HeldoutClass } from "@atlas/api/lib/brain/heldout-manifest";
import type { TriageableEpisode, Triager, TriageVerdict } from "@atlas/api/lib/brain/triage";

/** Observed recall the composed layer must clear. */
export const RECALL_MIN = 0.99;

/**
 * Lower bound the 95% Wilson interval on that recall must clear.
 *
 * 99% rather than 100% for the observed rate because 100% is unfalsifiable in
 * practice and any single ambiguous item fails it — which is precisely the
 * pressure that gets a held-out set quietly regenerated.
 */
export const WILSON_LCB_MIN = 0.95;

/**
 * z for a 95% two-sided normal interval.
 *
 * Spelled to six places rather than `1.96`: the rounded value shifts the bound
 * in the third decimal, and this bound is compared against a constant that
 * decides whether a filter ships.
 */
export const WILSON_Z_95 = 1.959964;

/**
 * The Wilson score interval's lower bound for a binomial proportion.
 *
 * ⚠️ **Wilson and not the normal approximation, and the difference is the whole
 * point at this end of the scale.** The textbook `p̂ ± z·√(p̂(1-p̂)/n)` collapses
 * to a zero-width interval at `p̂ = 1` — so a perfect 60/60 would report a lower
 * bound of exactly 1.0 and clear any threshold, which is nonsense: 60 trials
 * cannot establish a rate that high. Wilson keeps a finite width at the
 * boundary, which is why the issue names it specifically and why the set size
 * falls out of it.
 *
 * Returns 0 for `n = 0` — an empty sample bounds nothing, and returning 1
 * (vacuous truth over no trials) would let a set with no positives at all
 * report a passing recall.
 */
export function wilsonLowerBound(successes: number, n: number, z: number = WILSON_Z_95): number {
  if (n <= 0) return 0;
  const p = successes / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  const lower = (centre - margin) / denominator;
  // Clamp: the algebra can emit a hair below 0 at p̂ = 0 through floating point,
  // and a negative probability in a report reads as a bug in the measurement
  // rather than as the zero it is.
  return Math.max(0, Math.min(1, lower));
}

/** One labelled episode: the manifest's class, plus the body triage sees. */
export interface LabelledEpisode {
  readonly id: string;
  readonly class: HeldoutClass;
  readonly body: string;
}

/** What one triager did to one labelled episode. */
export interface ReplayOutcome {
  readonly episode: LabelledEpisode;
  /** Null means the episode reached the model — triage kept it. */
  readonly verdict: TriageVerdict | null;
}

/**
 * The drain row a triager is handed, built from a labelled body.
 *
 * The synthetic half of "a pure synthetic harness with no DB": every field a
 * `TriageableEpisode` requires, and nothing a triage rule may key on beyond the
 * body. Stage 0 is body-shape-only by design (`triage.ts` — channel scope and
 * thread position are deliberately deferred), so a stage-1 adapter that started
 * reading `source` or `occurred_at` would be measured here against constants,
 * and would look better than it is. Named rather than inlined so that the day
 * that changes, it changes in one place and loudly.
 */
export function syntheticEpisodeRow(episode: LabelledEpisode): TriageableEpisode {
  return {
    id: episode.id,
    workspace_id: "synthetic",
    source: "synthetic",
    source_id: episode.id,
    source_actor: null,
    body: episode.body,
    locator: null,
    occurred_at: null,
    visible_to: ["org"],
  };
}

/** Replay a triage layer over a labelled set. Sequential on purpose — a
 *  stage-1 adapter batching against a local model must not be handed the whole
 *  set at once by an implementation detail of this loop. */
export async function replayTriage(
  triager: Triager,
  episodes: readonly LabelledEpisode[],
): Promise<readonly ReplayOutcome[]> {
  const outcomes: ReplayOutcome[] = [];
  for (const episode of episodes) {
    outcomes.push({ episode, verdict: await triager(syntheticEpisodeRow(episode)) });
  }
  return outcomes;
}

/** One layer's numbers over one labelled set. */
export interface LayerMeasurement {
  /** Episodes the layer dropped, over all episodes. The cost saving. */
  readonly yieldRate: number;
  readonly dropped: number;
  readonly total: number;
  /** Positives the layer KEPT, over all positives. The number that matters. */
  readonly recall: number;
  readonly positivesKept: number;
  readonly positives: number;
  /** The 95% Wilson lower bound on `recall`. */
  readonly recallLowerBound: number;
  /**
   * Recall over `positive` ∪ `rejected` — AC 5's UNGATED diagnostic.
   *
   * ⚠️ Its alarm is named rather than left to a reader: materially below
   * {@link recall} means the layer is dropping episodes a reviewer SAW and
   * rejected while keeping the ones a reviewer approved — i.e. it learned
   * reviewer taste rather than claim presence. That is a different artefact
   * from the one #5334 asked for, and it would look like success on the gating
   * number alone.
   */
  readonly diagnosticRecall: number;
  /** The positives this layer dropped, by id — the misses, named. */
  readonly misses: readonly string[];
  /** How many episodes each reason id accounted for. */
  readonly byReason: Readonly<Record<string, number>>;
}

/** Score one replay. Pure. */
export function scoreReplay(outcomes: readonly ReplayOutcome[]): LayerMeasurement {
  let dropped = 0;
  let positives = 0;
  let positivesKept = 0;
  let decided = 0;
  let decidedKept = 0;
  const misses: string[] = [];
  const byReason: Record<string, number> = {};

  for (const { episode, verdict } of outcomes) {
    const isPositive = episode.class === "positive";
    const isDecided = isPositive || episode.class === "rejected";
    if (isPositive) positives += 1;
    if (isDecided) decided += 1;

    if (verdict === null) {
      if (isPositive) positivesKept += 1;
      if (isDecided) decidedKept += 1;
      continue;
    }
    dropped += 1;
    byReason[verdict.reason] = (byReason[verdict.reason] ?? 0) + 1;
    // A dropped positive is a MISS — an episode that carried a fact a human
    // published, which the layer would have routed past the extractor.
    if (isPositive) misses.push(episode.id);
  }

  const total = outcomes.length;
  return {
    yieldRate: total === 0 ? 0 : dropped / total,
    dropped,
    total,
    // ⚠️ Zero positives reports recall 0, never 1. "No positives to miss" is
    // not "missed none": a vacuous 1.0 here would let an empty or badly-labelled
    // set clear the gate, which is the single most dangerous way for this
    // arithmetic to be wrong.
    recall: positives === 0 ? 0 : positivesKept / positives,
    positivesKept,
    positives,
    recallLowerBound: wilsonLowerBound(positivesKept, positives),
    diagnosticRecall: decided === 0 ? 0 : decidedKept / decided,
    misses,
    byReason,
  };
}

/** Why a threshold verdict failed. Each is a sentence an operator can act on. */
export interface ThresholdVerdict {
  readonly passed: boolean;
  readonly failures: readonly string[];
}

/**
 * The threshold pair, applied to a composed layer against its baseline.
 *
 * `baseline` is the stage-0 layer measured over the SAME set — not a recorded
 * number from another run. The yield half is a comparison, and a comparison
 * against a figure measured on a different population is not a comparison.
 */
export function evaluateThreshold(
  composed: LayerMeasurement,
  baseline: LayerMeasurement,
): ThresholdVerdict {
  const failures: string[] = [];

  if (composed.recall < RECALL_MIN) {
    failures.push(
      `Recall ${composed.recall.toFixed(4)} is below the ${RECALL_MIN} floor — the layer dropped ` +
        `${composed.misses.length} episode(s) that carried a published fact. #5338: a recall ` +
        `failure means keep the cascade and never default it on.`,
    );
  }
  if (composed.recallLowerBound < WILSON_LCB_MIN) {
    failures.push(
      `The 95% Wilson lower bound on recall is ${composed.recallLowerBound.toFixed(4)}, below ` +
        `${WILSON_LCB_MIN}. With ${composed.positives} positive(s) the set cannot establish a ` +
        `rate this high whatever the point estimate says — by the rule of three this needs ` +
        `n ≥ ~100 positives. Cut a larger set; do NOT lower the bound.`,
    );
  }
  if (composed.yieldRate <= baseline.yieldRate) {
    failures.push(
      `Yield ${composed.yieldRate.toFixed(4)} does not beat the stage-0 baseline ` +
        `${baseline.yieldRate.toFixed(4)}. A layer that drops no more than the rules already ` +
        `shipped is not worth its complexity — this is the half of the threshold a no-op cannot ` +
        `pass, and it is doing its job.`,
    );
  }
  if (composed.recall < baseline.recall) {
    failures.push(
      `Recall ${composed.recall.toFixed(4)} is worse than the stage-0 baseline ` +
        `${baseline.recall.toFixed(4)}. Extra yield bought with lost facts is not a trade #5338 ` +
        `permits at any price.`,
    );
  }

  return { passed: failures.length === 0, failures };
}

/**
 * How far below the gating recall the ungated diagnostic may sit before it is
 * worth saying out loud.
 *
 * Not a gate — AC 5 calls the diagnostic explicitly ungated, and gating on it
 * would be inventing a criterion the issue declined. Five points is a
 * reporting threshold for prose, chosen to be loose enough that sampling noise
 * on a few hundred episodes does not trip it.
 */
export const TASTE_ALARM_MARGIN = 0.05;

/** Whether the ungated diagnostic is far enough below the gating recall to
 *  raise AC 5's named alarm. */
export function tasteAlarm(measurement: LayerMeasurement): boolean {
  return measurement.recall - measurement.diagnosticRecall > TASTE_ALARM_MARGIN;
}
