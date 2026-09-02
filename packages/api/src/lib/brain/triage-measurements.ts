/**
 * The recorded-measurement store — #5338's numbers, where a code change is what
 * records one.
 *
 * `triage-measure.ts` computes a measurement and `triage-measure-record.ts`
 * governs what one may claim. Neither of them holds any, and until this module
 * existed there was nowhere a recorded measurement could live: the gate read a
 * `records` array its only caller (a test) passed as `[]`, so a real failing run
 * had no way of reaching it.
 *
 * ## A module, not a JSON file or a table
 *
 * Three candidates, and the choice is load-bearing:
 *
 *   - **A table** would make recording a measurement an ordinary write, which is
 *     exactly what #5338's budget forbids — three attempts per set, declared
 *     before the cut. A row nobody reviews is a fourth attempt nobody sees.
 *   - **A file under `packages/api/scripts/`** would put the store outside what
 *     the API image ships (ADR-0025) and turn a page render into disk IO.
 *   - **A module** deploys with the code and makes appending a record a
 *     reviewed diff — the same argument {@link checkTriageDefaultGate} makes for
 *     living in a test rather than on a boot path: *"enabled by default is a
 *     code change, so the gate belongs where code changes are caught."*
 *
 * ## Empty is the honest state, and the tests are the enforcement
 *
 * There is no measurement because the scoring set does not exist yet: the first
 * real cut (`scripts/heldout/us-2026-09-02.json`) yielded 9 positives against a
 * Wilson floor of 110. `triage-measurements.test.ts` re-derives every record's
 * verdict from its own numbers ({@link verifyRecordedVerdict}) and holds the
 * budget ({@link checkMeasurementBudget}), so a hand-edited `passed: true` or a
 * fourth attempt on one set fails CI rather than being trusted.
 *
 * @see ./triage-measure-record.ts — what a record may claim
 * @see ./coverage.ts — where the latest record becomes a sentence on the page
 */
import type { RecordedMeasurement } from "@atlas/api/lib/brain/triage-measure-record";

/**
 * Every measurement recorded against #5338's threshold, in the order they were
 * run.
 *
 * ⚠️ **Append only, and never edit a landed entry.** Re-running a set and
 * overwriting its record is the retune-and-remeasure erosion
 * {@link MEASUREMENT_BUDGET} exists to stop, wearing the disguise of a tidy
 * file: the budget counts entries per `setId`, so an overwrite spends nothing
 * and the set's independence walks away unrecorded. A superseding run is a NEW
 * entry — `checkTriageDefaultGate` already reads the latest per set.
 *
 * Empty today. See the header: the scoring set does not exist yet, and a number
 * produced by loosening what counts as a scoring set is the one outcome #5338
 * rules out ahead of time.
 */
export const RECORDED_MEASUREMENTS: readonly RecordedMeasurement[] = [];

/**
 * The newest record by `measuredAt`, or null when nothing has been recorded.
 *
 * Newest OVERALL rather than newest-per-set, which is the one place this
 * disagrees with {@link checkTriageDefaultGate} and does so deliberately. The
 * gate asks *may this dial default on* — a question every set gets a veto over,
 * so it takes the latest of each. This answers *what does Atlas currently know
 * about what triage costs*, which has one answer: the most recent one measured.
 * Reporting a stale set's passing number beside a newer set's failing one would
 * be the flattering half of two true statements.
 *
 * Ties on `measuredAt` keep the EARLIER entry, so the answer does not depend on
 * array order for two records that claim the same instant — a state the budget
 * permits (two candidates measured in one run) and which would otherwise make
 * this function's output depend on how someone pasted the diff.
 */
export function latestRecordedMeasurement(
  records: readonly RecordedMeasurement[] = RECORDED_MEASUREMENTS,
): RecordedMeasurement | null {
  let newest: RecordedMeasurement | null = null;
  for (const record of records) {
    if (newest === null || record.measuredAt > newest.measuredAt) newest = record;
  }
  return newest;
}
