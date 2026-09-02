/**
 * What a measurement is ALLOWED to claim — #5338's acceptance criteria 4, 9 and
 * 10.
 *
 * `triage-measure.ts` computes the numbers. This module governs their standing:
 * which sets may produce a gating number, how many times one set may be
 * measured, what a recorded result has to say, and the gate that fires when the
 * triage dial is defaulted on without one.
 *
 * It exists because every failure mode #5338 warns about is a governance
 * failure rather than an arithmetic one. Nobody fakes a Wilson bound; they
 * re-cut the set, or measure it a fourth time, or quietly promote a smoke
 * fixture into the scoring set, and every step looks reasonable on its own.
 */
import type { HeldoutClass } from "@atlas/api/lib/brain/heldout-manifest";
import {
  evaluateThreshold,
  type LayerMeasurement,
  type LabelledEpisode,
} from "@atlas/api/lib/brain/triage-measure";

/**
 * What a labelled set is FOR. The distinction is enforced, not advisory.
 *
 * ⭐ `smoke` exists because the honest deliverable, when the instrument is built
 * and the data is not yet acquired, is *the instrument plus the name of what is
 * missing* — never a number produced by loosening what counts as real. A smoke
 * fixture proves the harness runs end to end; it may not produce a gating
 * verdict, and {@link assertCanGate} refuses on it rather than trusting a
 * reader to notice the header.
 */
export const FIXTURE_ROLES = ["smoke", "evaluation"] as const;
export type FixtureRole = (typeof FIXTURE_ROLES)[number];

/**
 * Where an evaluation set's labels came from.
 *
 * Required on an `evaluation` fixture and refused when absent, because
 * `practices.md`'s structural rule — *the actor that builds a check may not be
 * its only judge* — has no teeth if a hand-authored file can become the scoring
 * set by having its `role` field edited. A fixture that cannot say where its
 * labels came from is a fixture whose author is unrecorded.
 */
export interface FixtureProvenance {
  /** How the labels were produced — e.g. a held-out manifest's cut, or a named
   *  public corpus with its licence. Free text, but it has to be SOMETHING. */
  readonly labelsFrom: string;
  /** The manifest this set resolves against, when it came from one. */
  readonly manifestCutAt?: string;
  /** Who or what produced it, and when. */
  readonly cutAt: string;
}

export interface MeasurementFixture {
  readonly role: FixtureRole;
  readonly provenance?: FixtureProvenance;
  readonly episodes: readonly LabelledEpisode[];
}

/**
 * Parse a fixture, refusing the shapes that would quietly widen what counts.
 *
 * Strict about three things and relaxed about everything else: the role must be
 * known, an `evaluation` set must carry provenance, and every episode must have
 * a body and one of the three classes. A fixture whose episodes silently lost
 * their labels would measure recall over a denominator of zero, which
 * {@link scoreReplay} already reports as 0 rather than 1 — but failing here
 * names the cause instead of leaving a reader to explain a surprising number.
 */
export function parseMeasurementFixture(raw: unknown): MeasurementFixture {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("measurement fixture: expected a JSON object");
  }
  const obj = raw as Record<string, unknown>;
  const role = obj.role;
  if (role !== "smoke" && role !== "evaluation") {
    throw new Error(
      `measurement fixture: role must be one of ${FIXTURE_ROLES.join(" | ")} — got ` +
        `${JSON.stringify(role)}. A set with no declared role cannot be told apart from the ` +
        `scoring set, which is the whole distinction.`,
    );
  }
  if (!Array.isArray(obj.episodes) || obj.episodes.length === 0) {
    throw new Error("measurement fixture: episodes must be a non-empty array");
  }
  const episodes: LabelledEpisode[] = obj.episodes.map((entry, index) => {
    const e = entry as Record<string, unknown> | null;
    const cls = e?.class;
    // Narrowed through a `HeldoutClass` local rather than inline in the guard:
    // a compound `||` does not narrow `e.class` for the return expression, so
    // the mapped array widens to `string` and the fixture stops type-checking
    // as a labelled set.
    const known: HeldoutClass | null =
      cls === "positive" || cls === "rejected" || cls === "negative" ? cls : null;
    if (
      typeof e?.id !== "string" ||
      typeof e.body !== "string" ||
      e.body.trim() === "" ||
      known === null
    ) {
      throw new Error(
        `measurement fixture: episode ${index} is malformed — every entry is ` +
          `{ id, class: positive|rejected|negative, body } with a non-whitespace body. ` +
          `(Whitespace-only bodies belong to the extraction fiber's no_body skip and never ` +
          `reach a triager, so they cannot be measured here.)`,
      );
    }
    return { id: e.id, class: known, body: e.body };
  });

  if (role === "evaluation") {
    const p = obj.provenance as Record<string, unknown> | undefined;
    if (typeof p?.labelsFrom !== "string" || p.labelsFrom.trim() === "" ||
        typeof p.cutAt !== "string") {
      throw new Error(
        "measurement fixture: an `evaluation` set must carry provenance " +
          "{ labelsFrom, cutAt } — a fixture that cannot say where its labels came from is a " +
          "fixture whose author is unrecorded, and practices.md's structural rule (the actor " +
          "that builds a check may not be its only judge) has no teeth without it.",
      );
    }
  }

  return {
    role,
    episodes,
    ...(obj.provenance !== undefined
      ? { provenance: obj.provenance as FixtureProvenance }
      : {}),
  };
}

/**
 * Refuse to produce a gating verdict from a set that is not the scoring set.
 *
 * Returns the refusal, or null when the fixture may gate.
 */
export function assertCanGate(fixture: MeasurementFixture): string | null {
  if (fixture.role === "evaluation") return null;
  return (
    "This is a SMOKE fixture. It proves the harness runs; it does not produce #5338's number, " +
    "and no threshold verdict computed from it means anything. The scoring set is a frozen " +
    "held-out manifest (packages/api/scripts/heldout/) or a licence-checked public corpus " +
    "(.claude/research/extractor-corpus-acquisition.md). Re-run against one of those."
  );
}

/**
 * The measurement budget — #5338 AC 9, as data rather than as a paragraph
 * somebody remembers.
 *
 * ⚠️ The issue forbids regenerating the held-out set but says nothing about
 * re-measuring against it, and that is the same erosion one step removed:
 * retune-and-remeasure walks a set's independence away one reasonable-seeming
 * attempt at a time. Candidates are declared BEFORE the cut, each is measured
 * once, and needing more than this many attempts means cutting a SECOND set —
 * not measuring this one again until it cooperates.
 */
export const MEASUREMENT_BUDGET = {
  /** Attempts one set may absorb before it is spent. */
  maxAttemptsPerSet: 3,
} as const;

/** One recorded run. Written by the harness, read by the gate. */
export interface RecordedMeasurement {
  /** Which set — a manifest `cutAt`, or a corpus name. Attempts are counted
   *  per set id, which is what makes the budget enforceable. */
  readonly setId: string;
  readonly measuredAt: string;
  /** The candidate declared before the cut — the thing being measured. */
  readonly candidate: string;
  readonly composed: LayerMeasurement;
  readonly baseline: LayerMeasurement;
  readonly passed: boolean;
}

/**
 * The budget check: null when the record is within budget, or the failure.
 *
 * Counts attempts per `setId`, so re-measuring the same set with a different
 * candidate spends the same budget — which is the point. The budget is a
 * property of the SET's independence, not of any one candidate's patience.
 */
export function checkMeasurementBudget(
  records: readonly RecordedMeasurement[],
): string | null {
  const attempts = new Map<string, number>();
  for (const record of records) {
    attempts.set(record.setId, (attempts.get(record.setId) ?? 0) + 1);
  }
  const spent = [...attempts.entries()].filter(
    ([, n]) => n > MEASUREMENT_BUDGET.maxAttemptsPerSet,
  );
  if (spent.length === 0) return null;
  return (
    `Measurement budget exceeded: ${spent
      .map(([setId, n]) => `${setId} measured ${n} times`)
      .join("; ")}. #5338 allows ${MEASUREMENT_BUDGET.maxAttemptsPerSet} attempts per set — past ` +
    `that, cut a SECOND set rather than measuring this one again. Retune-and-remeasure erodes a ` +
    `held-out set as surely as regenerating it.`
  );
}

/**
 * #5338 AC 4's gate: **a test fails if the triage dial's default is `on` while
 * the recorded measurement is below threshold.**
 *
 * ⚠️ It lives here, as a pure function over `(dialDefault, records)`, rather
 * than on a boot path — deliberately. *"Enabled by default"* is a code change,
 * so the gate belongs where code changes are caught; a boot-time check would
 * fail closed in a region that never ran the harness, which punishes the wrong
 * deployment for the wrong reason.
 *
 * ⭐ **It is written so it can fail, and its failing direction is tested.** With
 * the dial defaulting off — today's state — this returns null for every input,
 * which is a gate that is currently vacuous. A vacuously-green check is worth
 * nothing unless someone has watched it go red, so `triage-measure.test.ts`
 * drives the `on` arm with an empty record set, with a failing record, and with
 * a passing one.
 *
 * Returns null when the state is permitted, or the failure.
 */
export function checkTriageDefaultGate(options: {
  /** The settings registry's `default` for ATLAS_BRAIN_EXTRACTION_TRIAGE_ENABLED. */
  readonly dialDefault: string;
  readonly records: readonly RecordedMeasurement[];
}): string | null {
  // Anything but an explicit "true" is off. The registry stores booleans as
  // strings, and treating an unexpected value as ON would fire this gate on a
  // typo; treating it as OFF is the direction that fails safe, because the
  // dial's own resolver requires "true" to enable.
  if (options.dialDefault !== "true") return null;

  if (options.records.length === 0) {
    return (
      "ATLAS_BRAIN_EXTRACTION_TRIAGE_ENABLED defaults to `true`, and no measurement has been " +
      "recorded. #5338 exists so this layer is not defaulted on unmeasured — record a passing " +
      "run (packages/api/scripts/measure-triage.ts) or set the default back to `false`."
    );
  }
  // The LATEST record per set, not any record: an old failing attempt that a
  // later passing run superseded is history, and treating it as live would make
  // the gate impossible to satisfy after any red run.
  const latest = new Map<string, RecordedMeasurement>();
  for (const record of options.records) {
    const prior = latest.get(record.setId);
    if (!prior || record.measuredAt > prior.measuredAt) latest.set(record.setId, record);
  }
  const failing = [...latest.values()].filter((record) => !record.passed);
  if (failing.length > 0) {
    return (
      `ATLAS_BRAIN_EXTRACTION_TRIAGE_ENABLED defaults to \`true\` while the latest recorded ` +
      `measurement on ${failing.map((f) => f.setId).join(", ")} did NOT clear the threshold ` +
      `pair. #5338: a recall failure means keep the cascade and never default it on. Set the ` +
      `default back to \`false\`.`
    );
  }
  return null;
}

/**
 * Recompute a record's verdict from its own numbers.
 *
 * The record carries `passed`, and a record whose stored verdict disagrees with
 * its stored measurements is the one shape {@link checkTriageDefaultGate} could
 * not otherwise catch — a hand-edited `"passed": true` over a failing run.
 * Cheap to verify, so it is verified rather than trusted.
 */
export function verifyRecordedVerdict(record: RecordedMeasurement): string | null {
  const recomputed = evaluateThreshold(record.composed, record.baseline);
  if (recomputed.passed === record.passed) return null;
  return (
    `Recorded measurement for ${record.setId} claims passed=${record.passed}, but its own ` +
    `numbers recompute to passed=${recomputed.passed}` +
    (recomputed.failures.length > 0 ? `: ${recomputed.failures.join(" ")}` : ".")
  );
}
