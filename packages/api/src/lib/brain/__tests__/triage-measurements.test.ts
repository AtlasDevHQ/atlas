/**
 * The recorded-measurement store's own gate (#5338 AC 4, 9).
 *
 * `triage-measurements.ts` is a committed array, so every failure mode it has is
 * a diff somebody wrote: a hand-edited verdict, a fourth attempt on a spent set,
 * an overwritten entry. None of those is caught by types, and all of them look
 * reasonable in review — which is exactly the class of erosion #5338 says the
 * budget exists to stop. So the store is checked here, where a code change is
 * caught, on {@link checkTriageDefaultGate}'s own argument for living in a test
 * rather than on a boot path.
 *
 * ⚠️ Most of what follows currently runs over an EMPTY store, which makes those
 * assertions vacuous today. They are written against the store rather than
 * against a fixture on purpose: the first recorded measurement is the moment
 * they stop being vacuous, and a check somebody has to remember to add at that
 * moment is a check that will not be there. The failing directions are driven
 * with fixtures below so that none of this is a green nobody has seen go red.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  RECORDED_MEASUREMENTS,
  RECORDED_MEASUREMENTS_PATH,
  latestRecordedMeasurement,
} from "@atlas/api/lib/brain/triage-measurements";
import {
  MEASUREMENT_BUDGET,
  checkMeasurementBudget,
  checkTriageDefaultGate,
  verifyRecordedVerdict,
  type RecordedMeasurement,
} from "@atlas/api/lib/brain/triage-measure-record";
import type { LayerMeasurement } from "@atlas/api/lib/brain/triage-measure";

function layer(over: Partial<LayerMeasurement> = {}): LayerMeasurement {
  return {
    yieldRate: 0.4,
    dropped: 40,
    total: 100,
    recall: 1,
    positivesKept: 120,
    positives: 120,
    recallLowerBound: 0.969,
    diagnosticRecall: 1,
    misses: [],
    byReason: {},
    ...over,
  };
}

function record(over: Partial<RecordedMeasurement> = {}): RecordedMeasurement {
  return {
    setId: "us-2026-09-02",
    measuredAt: "2026-09-02T12:00:00.000Z",
    candidate: "stage-0",
    composed: layer(),
    baseline: layer({ yieldRate: 0.38 }),
    passed: true,
    ...over,
  };
}

describe("the store itself", () => {
  test("every landed record's verdict recomputes from its own numbers", () => {
    // A hand-edited `"passed": true` over a failing run is the one shape
    // `checkTriageDefaultGate` cannot catch — it reads the field it would have
    // to distrust.
    for (const landed of RECORDED_MEASUREMENTS) {
      expect(verifyRecordedVerdict(landed)).toBeNull();
    }
  });

  test("the landed store is within the measurement budget", () => {
    expect(checkMeasurementBudget(RECORDED_MEASUREMENTS)).toBeNull();
  });

  test("it is empty, and that is the state #5338 predicted", () => {
    // ⭐ Not a placeholder assertion. The scoring set does not exist: the first
    // real cut yielded 9 positives against a Wilson floor of 110, so a number
    // in this store today could only have come from loosening what counts as a
    // scoring set. When a real measurement lands this test is DELETED along
    // with this comment — it is not to be "fixed" by relaxing it, and the two
    // checks above are what survive.
    expect(RECORDED_MEASUREMENTS).toHaveLength(0);
  });
});

describe("one store, not two", () => {
  test("⭐ the path the harness records to IS the array the gate reads", () => {
    // The defect this pins was live for one commit: `measure-triage.ts
    // --record <path>` appended to an arbitrary JSON file while the gate and
    // the Coverage Surface read a separate TS literal, so a recorded run —
    // including a FAILING one — could land somewhere nothing consults. Same
    // class as the gate whose only caller passed `[]`, one step further out,
    // and equally invisible from either side alone.
    const onDisk: unknown = JSON.parse(
      readFileSync(new URL(`../../../../${RECORDED_MEASUREMENTS_PATH}`, import.meta.url), "utf8"),
    );
    expect(Array.isArray(onDisk)).toBe(true);
    expect(onDisk).toEqual(RECORDED_MEASUREMENTS as unknown as unknown[]);
  });
});

describe("the checks the store will be held to", () => {
  test("a hand-edited verdict is caught", () => {
    const failing = record({
      composed: layer({ recall: 0.5, recallLowerBound: 0.4 }),
      passed: true,
    });
    expect(verifyRecordedVerdict(failing)).toContain("claims passed=true");
  });

  test("a fourth attempt on one set is caught", () => {
    const spent = Array.from({ length: MEASUREMENT_BUDGET.maxAttemptsPerSet + 1 }, (_, i) =>
      record({ measuredAt: `2026-09-0${i + 1}T00:00:00.000Z` }),
    );
    expect(checkMeasurementBudget(spent)).toContain("Measurement budget exceeded");
  });

  test("a second SET is how you get more attempts, and it is not a budget breach", () => {
    const two = [
      ...Array.from({ length: 3 }, () => record({ setId: "set-a" })),
      ...Array.from({ length: 3 }, () => record({ setId: "set-b" })),
    ];
    expect(checkMeasurementBudget(two)).toBeNull();
  });
});

describe("latestRecordedMeasurement", () => {
  test("an empty store answers null rather than a zero-valued record", () => {
    expect(latestRecordedMeasurement([])).toBeNull();
    expect(latestRecordedMeasurement()).toBeNull();
  });

  test("newest by measuredAt, ACROSS sets", () => {
    // Deliberately different from the gate's newest-per-set. The gate asks "may
    // this dial default on", which every set gets a veto over; this asks "what
    // does Atlas currently know", which has one answer. Reporting an older
    // set's passing number beside a newer set's failing one would be the
    // flattering half of two true statements.
    const newest = latestRecordedMeasurement([
      record({ setId: "old", measuredAt: "2026-09-01T00:00:00.000Z", passed: true }),
      record({ setId: "new", measuredAt: "2026-09-05T00:00:00.000Z", passed: false }),
    ]);
    expect(newest?.setId).toBe("new");
  });

  test("array order does not decide a tie", () => {
    const at = "2026-09-02T00:00:00.000Z";
    const first = latestRecordedMeasurement([
      record({ setId: "a", measuredAt: at }),
      record({ setId: "b", measuredAt: at }),
    ]);
    const reversed = latestRecordedMeasurement([
      record({ setId: "b", measuredAt: at }),
      record({ setId: "a", measuredAt: at }),
    ]);
    // Each keeps its own first entry — the point is that neither invents a
    // winner from paste order; the two are the same instant and the tie is real.
    expect(first?.setId).toBe("a");
    expect(reversed?.setId).toBe("b");
  });
});

describe("the default gate reads the real store (#5338 AC 4)", () => {
  test("the shipped store cannot arm the gate, because the dial defaults off", () => {
    expect(
      checkTriageDefaultGate({ dialDefault: "false", records: RECORDED_MEASUREMENTS }),
    ).toBeNull();
  });

  test("defaulting the dial ON against the SHIPPED store fails", () => {
    // ⭐ The reason this file passes the real array rather than `[]`: until now
    // nothing read the store, so a landed failing measurement could not have
    // reached the gate at all. With the store empty this is the
    // "no measurement has been recorded" arm; with a failing one landed it
    // becomes the other, and neither needs a test edit.
    const failure = checkTriageDefaultGate({
      dialDefault: "true",
      records: RECORDED_MEASUREMENTS,
    });
    expect(failure).not.toBeNull();
  });
});
