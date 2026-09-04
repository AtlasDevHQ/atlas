/**
 * The extraction cascade's measurement — #5338 acceptance criteria 3, 4, 5, 9.
 *
 * Pure arithmetic and pure governance: no database, no fixture file, no model.
 * Three things here are worth more than the rest.
 *
 *   1. **The Wilson bound is checked against the ISSUE'S OWN CLAIM about set
 *      size**, and the claim does not survive. #5338 says *"by the rule of
 *      three, zero observed misses clears a 95% lower bound only at n ≥ 60"* —
 *      that is the rule-of-three figure, and the criterion it is attached to is
 *      a WILSON bound, which is stricter. The tests derive the real minima
 *      rather than asserting the issue's, so the number someone cuts a set
 *      against is the one the gate actually enforces.
 *   2. **The yield half is shown to reject a no-op.** That was the defect the
 *      grill found in the original ACs — a triage layer that drops nothing
 *      scores 100% recall — so the test that a tie against the baseline FAILS
 *      is the test this whole threshold exists to make possible.
 *   3. **The AC-4 gate is driven in its failing direction.** With the dial
 *      defaulting off it is vacuous today, and a vacuously-green check is worth
 *      nothing until someone has watched it go red.
 */
import { describe, expect, it } from "bun:test";
import {
  RECALL_MIN,
  WILSON_LCB_MIN,
  evaluateThreshold,
  replayTriage,
  scoreReplay,
  syntheticEpisodeRow,
  tasteAlarm,
  wilsonLowerBound,
  type LabelledEpisode,
  type LayerMeasurement,
} from "@atlas/api/lib/brain/triage-measure";
import {
  MEASUREMENT_BUDGET,
  assertCanGate,
  checkMeasurementBudget,
  checkTriageDefaultGate,
  parseMeasurementFixture,
  verifyRecordedVerdict,
  type RecordedMeasurement,
} from "@atlas/api/lib/brain/triage-measure-record";
import { deterministicTriager, type Triager } from "@atlas/api/lib/brain/triage";
import { getSettingDefinition } from "@atlas/api/lib/settings";
import { RECORDED_MEASUREMENTS } from "@atlas/api/lib/brain/triage-measurements";

const TRIAGE_DIAL_KEY = "ATLAS_BRAIN_EXTRACTION_TRIAGE_ENABLED";

/** The smallest n at which `successes = n - misses` clears the LCB floor. */
function minimumPositivesFor(misses: number): number {
  for (let n = misses + 1; n <= 5_000; n += 1) {
    if (wilsonLowerBound(n - misses, n) >= WILSON_LCB_MIN) return n;
  }
  throw new Error("no n below 5000 clears the bound");
}

function layer(over: Partial<LayerMeasurement> = {}): LayerMeasurement {
  return {
    yieldRate: 0.4,
    dropped: 40,
    total: 100,
    recall: 1,
    positivesKept: 120,
    positives: 120,
    recallLowerBound: 0.97,
    diagnosticRecall: 1,
    misses: [],
    byReason: {},
    ...over,
  };
}

// ---------------------------------------------------------------------------

describe("wilson lower bound", () => {
  it("is 0 for an empty sample, never a vacuous 1", () => {
    // "No positives to miss" is not "missed none". A vacuous 1.0 would let an
    // empty or badly-labelled set clear the gate, which is the single most
    // dangerous way for this arithmetic to be wrong.
    expect(wilsonLowerBound(0, 0)).toBe(0);
  });

  it("keeps a FINITE width at a perfect score, unlike the normal approximation", () => {
    // The whole reason #5338 names Wilson. `p̂ ± z·√(p̂(1-p̂)/n)` collapses to
    // zero width at p̂ = 1, so 60/60 would report a lower bound of exactly 1.0
    // and clear any threshold — nonsense, since 60 trials cannot establish a
    // rate that high.
    expect(wilsonLowerBound(60, 60)).toBeLessThan(1);
    expect(wilsonLowerBound(60, 60)).toBeGreaterThan(0.9);
  });

  it("tightens monotonically as n grows at a fixed rate", () => {
    expect(wilsonLowerBound(50, 50)).toBeLessThan(wilsonLowerBound(500, 500));
    expect(wilsonLowerBound(99, 100)).toBeLessThan(wilsonLowerBound(990, 1000));
  });

  it("is bounded to [0, 1]", () => {
    expect(wilsonLowerBound(0, 30)).toBeGreaterThanOrEqual(0);
    expect(wilsonLowerBound(1, 1)).toBeLessThanOrEqual(1);
  });

  it("⭐ needs MORE positives than #5338's acceptance criteria state", () => {
    // The issue says: "by the rule of three, zero observed misses clears a 95%
    // lower bound only at n ≥ 60, and tolerating one miss needs n ≥ ~100".
    //
    // The rule of three is an approximation to an EXACT (Clopper-Pearson-style)
    // bound; the criterion is written against a WILSON bound, which is
    // stricter here. At a perfect score Wilson reduces to n/(n + z²), so the
    // floor is n ≥ z²·0.95/0.05 ≈ 73 — not 60. One miss needs ~110, not ~100.
    //
    // Asserted as DERIVED values rather than as literals, so whoever cuts a set
    // reads the number the gate actually enforces rather than the number the
    // issue estimated.
    const zeroMiss = minimumPositivesFor(0);
    const oneMiss = minimumPositivesFor(1);

    expect(zeroMiss).toBeGreaterThan(60);
    expect(zeroMiss).toBeLessThanOrEqual(80);
    expect(oneMiss).toBeGreaterThan(100);
    expect(oneMiss).toBeLessThanOrEqual(120);

    // And the boundary is real in both directions, not an off-by-one.
    expect(wilsonLowerBound(zeroMiss, zeroMiss)).toBeGreaterThanOrEqual(WILSON_LCB_MIN);
    expect(wilsonLowerBound(zeroMiss - 1, zeroMiss - 1)).toBeLessThan(WILSON_LCB_MIN);
  });
});

// ---------------------------------------------------------------------------

describe("scoring a replay", () => {
  const keepAll: Triager = () => null;
  const dropAll: Triager = () => ({ stage: 0, reason: "everything" });

  const set: readonly LabelledEpisode[] = [
    { id: "p1", class: "positive", body: "Priya leads Payments." },
    { id: "p2", class: "positive", body: "Billing runs in us-east-1." },
    { id: "r1", class: "rejected", body: "maybe the api is slow" },
    { id: "n1", class: "negative", body: "+1" },
    { id: "n2", class: "negative", body: "thanks" },
  ];

  it("a keep-everything layer scores perfect recall and ZERO yield", async () => {
    const m = scoreReplay(await replayTriage(keepAll, set));
    expect(m.recall).toBe(1);
    expect(m.yieldRate).toBe(0);
    expect(m.misses).toEqual([]);
  });

  it("a drop-everything layer scores zero recall and names every miss", async () => {
    const m = scoreReplay(await replayTriage(dropAll, set));
    expect(m.recall).toBe(0);
    expect(m.yieldRate).toBe(1);
    // The misses are NAMED, not counted: a recall number with no way to see
    // which facts it lost is not reviewable.
    expect(m.misses).toEqual(["p1", "p2"]);
    expect(m.byReason).toEqual({ everything: 5 });
  });

  it("reports recall 0 — never 1 — when the set holds no positives", async () => {
    const m = scoreReplay(await replayTriage(keepAll, [{ id: "n", class: "negative", body: "ok" }]));
    expect(m.recall).toBe(0);
    expect(m.recallLowerBound).toBe(0);
  });

  it("separates the gating denominator from the ungated diagnostic", async () => {
    // Drops the rejected episode only: every positive survives, so gating
    // recall is perfect while the positives+rejected diagnostic is not.
    const dropRejected: Triager = (e) =>
      e.body.startsWith("maybe") ? { stage: 1, reason: "learned_taste" } : null;
    const m = scoreReplay(await replayTriage(dropRejected, set));
    expect(m.recall).toBe(1);
    expect(m.diagnosticRecall).toBeCloseTo(2 / 3, 5);
    // AC 5's named alarm: dropping what a reviewer SAW and rejected while
    // keeping what a reviewer approved is a filter that learned reviewer TASTE
    // rather than claim PRESENCE — a different artefact from the one #5334
    // asked for, and invisible on the gating number alone.
    expect(tasteAlarm(m)).toBe(true);
  });

  it("does not raise the taste alarm when the two track each other", async () => {
    expect(tasteAlarm(scoreReplay(await replayTriage(keepAll, set)))).toBe(false);
  });

  it("hands the triager a row carrying nothing but the body to key on", () => {
    // Stage 0 is body-shape-only by design. A stage-1 adapter that started
    // reading `source` or `occurred_at` would be measured against constants
    // here and would look better than it is — so the synthetic row is one
    // named function rather than an inline literal.
    const row = syntheticEpisodeRow({ id: "x", class: "positive", body: "hello" });
    expect(row.body).toBe("hello");
    expect(row.source).toBe("synthetic");
    expect(row.occurred_at).toBeNull();
    expect(row.source_actor).toBeNull();
  });

  it("scores the SHIPPED stage-0 rules, not a copy of them", async () => {
    // Composed from `deterministicTriager` itself, so a rule added to
    // `TRIAGE_RULES` is measured without touching this harness.
    const m = scoreReplay(
      await replayTriage(deterministicTriager, [
        { id: "a", class: "negative", body: "+1" },
        { id: "b", class: "positive", body: "The warehouse is Snowflake." },
      ]),
    );
    expect(m.dropped).toBe(1);
    expect(m.recall).toBe(1);
    expect(Object.keys(m.byReason)).toEqual(["known_ack"]);
  });
});

// ---------------------------------------------------------------------------

describe("the threshold pair", () => {
  const baseline = layer({ yieldRate: 0.3, recall: 1, recallLowerBound: 0.97 });

  it("⭐ FAILS a no-op that merely ties the baseline", () => {
    // The defect the grill found in the original ACs: a triage layer that drops
    // nothing scores 100% recall, so a recall-only threshold cannot fail in the
    // direction that matters. This is the half that can.
    const verdict = evaluateThreshold(layer({ yieldRate: 0.3 }), baseline);
    expect(verdict.passed).toBe(false);
    expect(verdict.failures.join(" ")).toContain("does not beat the stage-0 baseline");
  });

  it("fails a layer that buys yield with lost facts", () => {
    const verdict = evaluateThreshold(
      layer({ yieldRate: 0.8, recall: 0.9, recallLowerBound: 0.85, misses: ["p1"] }),
      baseline,
    );
    expect(verdict.passed).toBe(false);
    const joined = verdict.failures.join(" ");
    expect(joined).toContain("below the 0.99 floor");
    expect(joined).toContain("worse than the stage-0 baseline");
  });

  it("fails a small set even when its point estimate is perfect", () => {
    // The set-size clause doing its job: a perfect 30/30 is a real number and
    // still cannot establish a 99% rate.
    const small = layer({
      yieldRate: 0.5,
      recall: 1,
      positives: 30,
      positivesKept: 30,
      recallLowerBound: wilsonLowerBound(30, 30),
    });
    const verdict = evaluateThreshold(small, baseline);
    expect(verdict.passed).toBe(false);
    expect(verdict.failures.join(" ")).toContain("Cut a larger set; do NOT lower the bound");
  });

  it("passes a layer that beats the baseline at an adequately-bounded recall", () => {
    const good = layer({
      yieldRate: 0.55,
      recall: 1,
      positives: 200,
      positivesKept: 200,
      recallLowerBound: wilsonLowerBound(200, 200),
    });
    expect(evaluateThreshold(good, baseline)).toEqual({ passed: true, failures: [] });
    expect(good.recall).toBeGreaterThanOrEqual(RECALL_MIN);
  });
});

// ---------------------------------------------------------------------------

describe("what a fixture is allowed to claim", () => {
  const episodes = [{ id: "a", class: "positive", body: "The warehouse is Snowflake." }];

  it("refuses a set with no declared role", () => {
    expect(() => parseMeasurementFixture({ episodes })).toThrow(/role must be one of/);
  });

  it("refuses an evaluation set that cannot say where its labels came from", () => {
    // practices.md's structural rule has no teeth if a hand-authored file can
    // become the scoring set by having one field edited.
    expect(() => parseMeasurementFixture({ role: "evaluation", episodes })).toThrow(
      /must carry provenance/,
    );
  });

  it("accepts an evaluation set that does", () => {
    const fixture = parseMeasurementFixture({
      role: "evaluation",
      provenance: { labelsFrom: "heldout manifest us-2026-09", cutAt: "2026-09-02T00:00:00Z" },
      episodes,
    });
    expect(assertCanGate(fixture)).toBeNull();
  });

  it("⭐ refuses to let a SMOKE fixture produce a gating verdict", () => {
    const fixture = parseMeasurementFixture({ role: "smoke", episodes });
    const refusal = assertCanGate(fixture);
    expect(refusal).toContain("does not produce #5338's number");
  });

  it("refuses an episode with no class, or a whitespace-only body", () => {
    expect(() =>
      parseMeasurementFixture({ role: "smoke", episodes: [{ id: "a", body: "x" }] }),
    ).toThrow(/malformed/);
    expect(() =>
      parseMeasurementFixture({
        role: "smoke",
        episodes: [{ id: "a", class: "positive", body: "   " }],
      }),
    ).toThrow(/malformed/);
  });

  it("refuses an empty set", () => {
    expect(() => parseMeasurementFixture({ role: "smoke", episodes: [] })).toThrow(/non-empty/);
  });
});

// ---------------------------------------------------------------------------

describe("the measurement budget", () => {
  function record(setId: string, over: Partial<RecordedMeasurement> = {}): RecordedMeasurement {
    return {
      setId,
      measuredAt: "2026-09-02T00:00:00.000Z",
      candidate: "c",
      composed: layer(),
      baseline: layer({ yieldRate: 0.2 }),
      passed: true,
      ...over,
    };
  }

  it("permits the budgeted number of attempts", () => {
    const records = Array.from({ length: MEASUREMENT_BUDGET.maxAttemptsPerSet }, () =>
      record("set-a"),
    );
    expect(checkMeasurementBudget(records)).toBeNull();
  });

  it("fails the attempt past it, and names the set", () => {
    // Retune-and-remeasure erodes a held-out set as surely as regenerating it,
    // one reasonable-seeming attempt at a time.
    const records = Array.from({ length: MEASUREMENT_BUDGET.maxAttemptsPerSet + 1 }, () =>
      record("set-a"),
    );
    const failure = checkMeasurementBudget(records);
    expect(failure).toContain("set-a measured 4 times");
    expect(failure).toContain("cut a SECOND set");
  });

  it("counts per SET, so a second candidate spends the same budget", () => {
    // The budget is a property of the set's independence, not of any one
    // candidate's patience.
    const records = [
      record("set-a", { candidate: "qwen" }),
      record("set-a", { candidate: "nova" }),
      record("set-a", { candidate: "distilled" }),
      record("set-a", { candidate: "distilled-v2" }),
    ];
    expect(checkMeasurementBudget(records)).not.toBeNull();
  });

  it("catches a hand-edited verdict that its own numbers contradict", () => {
    const tampered = record("set-a", {
      passed: true,
      composed: layer({ yieldRate: 0.1 }),
      baseline: layer({ yieldRate: 0.3 }),
    });
    expect(verifyRecordedVerdict(tampered)).toContain("recompute to passed=false");
  });

  it("is silent on a record whose verdict matches its numbers", () => {
    expect(verifyRecordedVerdict(record("set-a"))).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe("AC 4 — the dial may not default ON below threshold", () => {
  function record(over: Partial<RecordedMeasurement> = {}): RecordedMeasurement {
    return {
      setId: "set-a",
      measuredAt: "2026-09-02T00:00:00.000Z",
      candidate: "c",
      composed: layer(),
      baseline: layer({ yieldRate: 0.2 }),
      passed: true,
      ...over,
    };
  }

  it("⭐ the SHIPPED registry default keeps this gate satisfied", () => {
    // The live assertion, and BOTH of its inputs are now the real ones.
    // `getSettingDefinition` reads the real registry, so flipping the dial's
    // default in `settings.ts` without recording a passing measurement turns
    // this test red — which is where a code change belongs, rather than on a
    // boot path that would fail closed in a region that never ran the harness.
    //
    // `RECORDED_MEASUREMENTS` is the other half, and it was `[]` until #5338's
    // AC 8 gave records somewhere to live: with a literal there, a landed
    // FAILING measurement could not have reached this gate at all, so the half
    // of the criterion about a recorded result below threshold was unreachable.
    const definition = getSettingDefinition(TRIAGE_DIAL_KEY);
    expect(definition).toBeDefined();
    expect(
      checkTriageDefaultGate({
        dialDefault: definition?.default ?? "false",
        records: RECORDED_MEASUREMENTS,
      }),
    ).toBeNull();
  });

  it("⭐ FAILS when the dial defaults on with nothing recorded", () => {
    // Driven in its failing direction, because the arm above is vacuous today
    // and a vacuously-green check is worth nothing until someone has watched it
    // go red.
    const failure = checkTriageDefaultGate({ dialDefault: "true", records: [] });
    expect(failure).toContain("no measurement has been recorded");
  });

  it("FAILS when the dial defaults on and the latest run did not clear the pair", () => {
    const failure = checkTriageDefaultGate({
      dialDefault: "true",
      records: [record({ passed: false })],
    });
    expect(failure).toContain("did NOT clear the threshold pair");
    expect(failure).toContain("never default it on");
  });

  it("permits the dial on when the latest run passed", () => {
    expect(checkTriageDefaultGate({ dialDefault: "true", records: [record()] })).toBeNull();
  });

  it("reads the LATEST run per set, so a superseded failure is history", () => {
    // Treating any historical failure as live would make the gate impossible to
    // satisfy after a single red run, which is a gate nobody can use.
    expect(
      checkTriageDefaultGate({
        dialDefault: "true",
        records: [
          record({ measuredAt: "2026-09-01T00:00:00.000Z", passed: false }),
          record({ measuredAt: "2026-09-02T00:00:00.000Z", passed: true }),
        ],
      }),
    ).toBeNull();
  });

  it("treats an unexpected default value as OFF rather than firing on a typo", () => {
    // The dial's own resolver requires the literal "true" to enable, so
    // anything else is off — and firing this gate on a typo would be a red test
    // about a dial that is not on.
    expect(checkTriageDefaultGate({ dialDefault: "yes", records: [] })).toBeNull();
  });
});
