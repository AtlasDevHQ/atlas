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
 * ## A committed file under `src/`, not a table — and ONE file, not two
 *
 *   - **A table** would make recording a measurement an ordinary write, which is
 *     exactly what #5338's budget forbids — three attempts per set, declared
 *     before the cut. A row nobody reviews is a fourth attempt nobody sees.
 *   - **A file under `packages/api/scripts/`** would put the store outside what
 *     the API image ships (ADR-0025) and turn a page render into disk IO.
 *   - **A committed JSON file beside this module** deploys with the code and
 *     makes appending a record a reviewed diff — the same argument
 *     {@link checkTriageDefaultGate} makes for living in a test rather than on a
 *     boot path: *"enabled by default is a code change, so the gate belongs
 *     where code changes are caught."*
 *
 * ⚠️ **It is JSON rather than a TS literal for one specific reason.**
 * `scripts/measure-triage.ts --record <path>` appends a run, and if the store
 * it appends to were not the store the gate and the page read, a measurement
 * could be recorded to a file nothing consults — the same class of defect as
 * the gate whose only caller passed `[]`, one step further out. The CLI's
 * `--record` now defaults to {@link RECORDED_MEASUREMENTS_PATH}, so the
 * harness's output and the gate's input are the same bytes.
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
import { fileURLToPath } from "node:url";
import type { RecordedMeasurement } from "@atlas/api/lib/brain/triage-measure-record";
// ⚠️ A RELATIVE import, against this package's `@atlas/api/*` convention, and
// deliberately: the alias resolves TypeScript sources and does not carry a
// `.json` extension through, so `@atlas/api/lib/brain/triage-measurements.json`
// does not resolve. The file sits beside this module, so the relative path is
// also the shortest true statement of where it is.
import stored from "./triage-measurements.json";

/**
 * Where the store lives, as a repo-relative string — for MESSAGES only.
 *
 * ⚠️ Never pass this to a filesystem call. It resolves against the process
 * CWD, and the CLI that writes the store can be run from the repo root as
 * easily as from `packages/api`: from the root it would create a second,
 * unread file at `<root>/src/lib/brain/…`, and the "you are recording where
 * nothing reads it" warning would compare the two strings equal and stay
 * silent. That is precisely the defect the warning exists to raise, so the
 * write target is {@link recordedMeasurementsFile} and this string is only
 * ever printed.
 */
export const RECORDED_MEASUREMENTS_PATH = "packages/api/src/lib/brain/triage-measurements.json";

/**
 * The store's absolute path, resolved from this module's own location.
 *
 * CWD-independent by construction, so a caller comparing its `--record`
 * argument against this is comparing files rather than spellings.
 */
export function recordedMeasurementsFile(): string {
  return fileURLToPath(new URL("./triage-measurements.json", import.meta.url));
}

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
export const RECORDED_MEASUREMENTS: readonly RecordedMeasurement[] =
  stored as readonly RecordedMeasurement[];

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
