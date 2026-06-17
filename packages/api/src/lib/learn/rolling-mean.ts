/**
 * Incremental rolling mean for learned-pattern latency (PRD #3617 B-1).
 *
 * The canonical definition of the `avg_duration_ms` arithmetic. The seed
 * (INSERT, `insertLearnedPattern`) path is genuinely derived from it — it calls
 * `foldRollingMean(null, 0, sample)` directly, so that path cannot diverge. The
 * fold (UPDATE, `incrementPatternCount`) path re-implements the same arithmetic
 * as an inline SQL `CASE` (it must stay SQL so the fold is atomic with the
 * `repetition_count` bump — see that function). That `CASE` mirrors this
 * function clause-for-clause, but the coupling is *manual*: no compile-time
 * check or test links them, and `rolling-mean.test.ts` exercises only this TS
 * function. Editing the SQL `CASE` without updating this function (or vice
 * versa) will silently diverge — keep the two in lockstep by hand.
 *
 * The new average weights the existing mean by the *old* observation count —
 * `(avg * n + sample) / (n + 1)` — which converges to the true arithmetic mean
 * across repetitions.
 *
 * @param oldAvg   The prior rolling mean, or `null` when not yet observed.
 * @param oldCount The number of observations already folded into `oldAvg`.
 * @param sample   The new measurement (ms), or `null` for "no measurement".
 * @returns The updated rolling mean, or `null` when still not-yet-observed.
 */
export function foldRollingMean(oldAvg: number | null, oldCount: number, sample: number | null): number | null {
  // No measurement → leave the average untouched. A null sample must never
  // fabricate a 0 and skew the mean (#3616); the count is the DB's concern.
  // `sample === 0` is a finite, valid measurement and falls through to fold.
  if (sample === null) return oldAvg;

  // First-ever observation: nothing to weight against, so the sample is the mean.
  if (oldAvg === null) return sample;

  // Incremental fold, weighting the prior mean by the old observation count.
  return (oldAvg * oldCount + sample) / (oldCount + 1);
}
