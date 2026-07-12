import { describe, test, expect } from "bun:test";
// eligible-set is PURE — zero db/settings/logger imports — so it imports directly
// with no `mock.module()` at all (#4571), like `pattern-ranking` and
// `rolling-mean`.
import {
  ELIGIBLE_SET_ORDER_BY_SQL,
  ELIGIBLE_SET_SAFETY_CAP,
  isHumanApproved,
  isEligibleForInjection,
  compareEligibleOrder,
  selectEligiblePatterns,
  type EligibilityFields,
} from "@atlas/api/lib/learn/eligible-set";

/** Minimal eligible-set row: an id (for identity asserts) plus the decision
 *  fields. Extra fields ride through `selectEligiblePatterns`'s generic. */
type Row = EligibilityFields & { id: string };

function row(over: Partial<Row> & { id: string }): Row {
  return {
    confidence: 0.5,
    auto_promoted: true, // machine by default; opt into human-approved explicitly
    last_seen_at: null,
    ...over,
  };
}

const THRESHOLD = 0.7;

describe("isHumanApproved", () => {
  test("auto_promoted === false is human-approved", () => {
    expect(isHumanApproved({ auto_promoted: false })).toBe(true);
  });

  test("auto_promoted === true is the machine road", () => {
    expect(isHumanApproved({ auto_promoted: true })).toBe(false);
  });

  test("a partial row missing the flag is treated as machine (never grants the bypass)", () => {
    // A fixture that forgot the flag must NOT accidentally earn the confidence
    // bypass — fail closed to the gated road.
    expect(isHumanApproved({} as { auto_promoted: boolean })).toBe(false);
  });
});

describe("isEligibleForInjection — approval bypasses the confidence gate", () => {
  test("a human-approved pattern below threshold is eligible (the bypass)", () => {
    expect(isEligibleForInjection(row({ id: "h", auto_promoted: false, confidence: 0.01 }), THRESHOLD)).toBe(true);
  });

  test("a machine-promoted pattern below threshold is NOT eligible (the gate)", () => {
    expect(isEligibleForInjection(row({ id: "m", auto_promoted: true, confidence: 0.69 }), THRESHOLD)).toBe(false);
  });

  test("a machine-promoted pattern at/above threshold is eligible", () => {
    expect(isEligibleForInjection(row({ id: "m", auto_promoted: true, confidence: 0.7 }), THRESHOLD)).toBe(true);
    expect(isEligibleForInjection(row({ id: "m2", auto_promoted: true, confidence: 0.95 }), THRESHOLD)).toBe(true);
  });
});

describe("compareEligibleOrder / selectEligiblePatterns — ordering", () => {
  test("human-approved first, even below a lower-confidence machine peer", () => {
    const humanLow = row({ id: "human-low", auto_promoted: false, confidence: 0.1 });
    const machineHigh = row({ id: "machine-high", auto_promoted: true, confidence: 0.99 });
    const ordered = selectEligiblePatterns([machineHigh, humanLow], THRESHOLD);
    expect(ordered.map((r) => r.id)).toEqual(["human-low", "machine-high"]);
  });

  test("within a road, confidence DESC", () => {
    const a = row({ id: "a", auto_promoted: false, confidence: 0.4 });
    const b = row({ id: "b", auto_promoted: false, confidence: 0.9 });
    const c = row({ id: "c", auto_promoted: false, confidence: 0.6 });
    const ordered = selectEligiblePatterns([a, b, c], THRESHOLD);
    expect(ordered.map((r) => r.id)).toEqual(["b", "c", "a"]);
  });

  test("last-observed DESC breaks confidence ties (saturation tiebreak)", () => {
    const older = row({ id: "older", auto_promoted: false, confidence: 0.8, last_seen_at: "2026-01-01T00:00:00Z" });
    const newer = row({ id: "newer", auto_promoted: false, confidence: 0.8, last_seen_at: "2026-06-01T00:00:00Z" });
    const ordered = selectEligiblePatterns([older, newer], THRESHOLD);
    expect(ordered.map((r) => r.id)).toEqual(["newer", "older"]);
  });

  test("a never-observed (null last_seen_at) row sorts last among confidence ties", () => {
    const seen = row({ id: "seen", auto_promoted: false, confidence: 0.8, last_seen_at: "2026-01-01T00:00:00Z" });
    const unseen = row({ id: "unseen", auto_promoted: false, confidence: 0.8, last_seen_at: null });
    const ordered = selectEligiblePatterns([unseen, seen], THRESHOLD);
    expect(ordered.map((r) => r.id)).toEqual(["seen", "unseen"]);
  });

  test("compareEligibleOrder returns 0 for two never-observed confidence ties (stable, no NaN)", () => {
    const a = row({ id: "a", auto_promoted: false, confidence: 0.8, last_seen_at: null });
    const b = row({ id: "b", auto_promoted: false, confidence: 0.8, last_seen_at: null });
    expect(compareEligibleOrder(a, b)).toBe(0);
  });

  test("last-observed tiebreak parses the real Postgres timestamptz::text format", () => {
    // Production feeds `last_seen_at::text` — space-separated with a `+00` offset,
    // NOT the strict-ISO `…T…Z` the other tests use. Pin that the comparator
    // orders it chronologically (Date.parse handles it).
    const older = row({ id: "older", auto_promoted: false, confidence: 0.8, last_seen_at: "2026-01-01 00:00:00+00" });
    const newer = row({ id: "newer", auto_promoted: false, confidence: 0.8, last_seen_at: "2026-06-01 12:30:00+00" });
    const ordered = selectEligiblePatterns([older, newer], THRESHOLD);
    expect(ordered.map((r) => r.id)).toEqual(["newer", "older"]);
  });
});

describe("selectEligiblePatterns — eligibility filter", () => {
  test("drops machine-promoted rows below threshold, keeps human-approved ones", () => {
    const humanLow = row({ id: "human-low", auto_promoted: false, confidence: 0.05 });
    const machineLow = row({ id: "machine-low", auto_promoted: true, confidence: 0.05 });
    const machineHigh = row({ id: "machine-high", auto_promoted: true, confidence: 0.9 });
    const eligible = selectEligiblePatterns([machineLow, machineHigh, humanLow], THRESHOLD);
    expect(eligible.map((r) => r.id)).toEqual(["human-low", "machine-high"]);
    expect(eligible.some((r) => r.id === "machine-low")).toBe(false);
  });

  test("no pre-relevance truncation can drop a human-approved pattern — library larger than the old 100-row cap", () => {
    // Old behavior pre-cut to the top 100 by confidence DESC, which would push a
    // low-confidence human-approved pattern out. The eligible set keeps it (and
    // orders it first) regardless of how many higher-confidence machine rows exist.
    const machineRows = Array.from({ length: 150 }, (_, i) =>
      row({ id: `machine-${i}`, auto_promoted: true, confidence: 0.9 }),
    );
    const humanLow = row({ id: "human-low", auto_promoted: false, confidence: 0.01 });
    const eligible = selectEligiblePatterns([...machineRows, humanLow], THRESHOLD);
    expect(eligible).toHaveLength(151);
    expect(eligible[0].id).toBe("human-low");
    expect(eligible.some((r) => r.id === "human-low")).toBe(true);
  });

  test("does not mutate its input array", () => {
    const input = [
      row({ id: "a", auto_promoted: true, confidence: 0.9 }),
      row({ id: "b", auto_promoted: false, confidence: 0.1 }),
    ];
    const snapshot = input.map((r) => r.id);
    selectEligiblePatterns(input, THRESHOLD);
    expect(input.map((r) => r.id)).toEqual(snapshot);
  });
});

describe("shared ordering + cap constants", () => {
  test("the SQL ORDER BY fragment matches the in-memory comparator's clauses", () => {
    // The two must agree by construction; pin the SQL fragment's shape so a change
    // to one is a visible diff against the other.
    expect(ELIGIBLE_SET_ORDER_BY_SQL).toBe(
      "(auto_promoted = false) DESC, confidence DESC, learned_patterns.last_seen_at DESC NULLS LAST",
    );
  });

  test("the safety cap is well above the old arbitrary 100-row pre-cut", () => {
    expect(ELIGIBLE_SET_SAFETY_CAP).toBeGreaterThan(100);
  });
});
