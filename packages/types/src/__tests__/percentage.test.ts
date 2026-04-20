/**
 * Branded-numeric helper tests (#1685).
 *
 * Two layers of invariant:
 *
 *   1. Runtime — the converters return the expected numeric values.
 *      `asPercentage` / `asRatio` pass through without modification.
 *      `percentageToRatio` divides by 100; `ratioToPercentage` multiplies
 *      by 100. These are trivial but pin the conversion direction so a
 *      future edit can't swap them.
 *   2. Compile-time — `Percentage` and `Ratio` are nominally distinct.
 *      The `@ts-expect-error` guards below fail the build if a future
 *      refactor erases the brand and makes either type structurally
 *      assignable to the other or to plain `number`.
 */

import { describe, test, expect } from "bun:test";
import {
  asPercentage,
  asRatio,
  percentageToRatio,
  ratioToPercentage,
  type Percentage,
  type Ratio,
} from "../percentage";

describe("Percentage / Ratio runtime conversions", () => {
  // `.toBe<number>(literal)` is the explicit widening for comparing a
  // branded value against a plain number literal. The brand stays intact
  // at compile time; this tests only the runtime math.
  test("asPercentage brands without modifying the value", () => {
    expect(asPercentage(0)).toBe<number>(0);
    expect(asPercentage(50)).toBe<number>(50);
    expect(asPercentage(100)).toBe<number>(100);
  });

  test("asRatio brands without modifying the value", () => {
    expect(asRatio(0)).toBe<number>(0);
    expect(asRatio(0.5)).toBe<number>(0.5);
    expect(asRatio(1)).toBe<number>(1);
  });

  test("percentageToRatio divides by 100", () => {
    expect(percentageToRatio(asPercentage(50))).toBe<number>(0.5);
    expect(percentageToRatio(asPercentage(0))).toBe<number>(0);
    expect(percentageToRatio(asPercentage(100))).toBe<number>(1);
  });

  test("ratioToPercentage multiplies by 100", () => {
    expect(ratioToPercentage(asRatio(0.5))).toBe<number>(50);
    expect(ratioToPercentage(asRatio(0))).toBe<number>(0);
    expect(ratioToPercentage(asRatio(1))).toBe<number>(100);
  });

  test("round-trip conversion preserves value at 2-decimal precision", () => {
    // 50.04% is the threshold-boundary case from PR #1681 — guard against
    // the rounding regression that would have flipped
    // `counters.errorRatePct / 100 > 0.5` off at 50.04%.
    const p = asPercentage(50.04);
    const r = percentageToRatio(p);
    expect(r > 0.5).toBe(true);
    const back = ratioToPercentage(r);
    expect(back).toBeCloseTo(50.04, 10);
  });
});

// Runtime validation (#1685 follow-up from PR review): `asPercentage` and
// `asRatio` used to be no-op casts. That left a real silent-failure path —
// a corrupted DB column or a scale-drifted SQL aggregate could brand
// nonsense values (150%, -50, NaN, Infinity) and feed them straight into
// operator-facing gauges without warning. The constructors now validate
// non-finite + range with a small tolerance for IEEE-754 slop.
describe("asPercentage / asRatio runtime validation", () => {
  test("asPercentage throws on NaN / Infinity", () => {
    expect(() => asPercentage(NaN)).toThrow(/non-finite/);
    expect(() => asPercentage(Infinity)).toThrow(/non-finite/);
    expect(() => asPercentage(-Infinity)).toThrow(/non-finite/);
  });

  test("asPercentage throws on out-of-range inputs (scale mixup guard)", () => {
    // `asPercentage(1.5)` is the exact scale mixup the brand exists to
    // surface — a caller who confused Ratio and Percentage.
    expect(() => asPercentage(150)).toThrow(/out of range/);
    expect(() => asPercentage(-50)).toThrow(/out of range/);
    expect(() => asPercentage(101)).toThrow(/out of range/);
  });

  test("asPercentage tolerates SQL rounding overshoot at the 100% boundary", () => {
    // `ROUND(0.9999 * 100, 2)` sometimes produces 100.00000001 in IEEE-754.
    // The tolerance must accept this without flagging a scale mixup.
    expect(asPercentage(100.0001)).toBe<number>(100.0001);
    expect(asPercentage(-0.0001)).toBe<number>(-0.0001);
  });

  test("asRatio throws on NaN / Infinity", () => {
    expect(() => asRatio(NaN)).toThrow(/non-finite/);
    expect(() => asRatio(Infinity)).toThrow(/non-finite/);
  });

  test("asRatio throws on out-of-range inputs (scale mixup guard)", () => {
    expect(() => asRatio(1.5)).toThrow(/out of range/);
    expect(() => asRatio(50)).toThrow(/out of range/);
    expect(() => asRatio(-0.5)).toThrow(/out of range/);
  });

  test("asRatio tolerates tiny IEEE-754 overshoot at the 1.0 boundary", () => {
    expect(asRatio(1.000001)).toBe<number>(1.000001);
  });
});

describe("Percentage / Ratio compile-time invariants", () => {
  // These tests are compile-time, not runtime. `@ts-expect-error` fails
  // the build if the following lines ever typecheck — i.e., if the brand
  // is accidentally erased and cross-scale comparisons become structural.

  test("plain number is not assignable to Percentage", () => {
    // @ts-expect-error plain number must not satisfy the Percentage brand
    const p: Percentage = 50;
    expect(p).toBe<number>(50);
  });

  test("plain number is not assignable to Ratio", () => {
    // @ts-expect-error plain number must not satisfy the Ratio brand
    const r: Ratio = 0.5;
    expect(r).toBe<number>(0.5);
  });

  test("Percentage is not assignable to Ratio without conversion", () => {
    const p = asPercentage(50);
    // @ts-expect-error Percentage must not cross-assign to Ratio — use percentageToRatio
    const r: Ratio = p;
    expect(r).toBe<number>(50);
  });

  test("Ratio is not assignable to Percentage without conversion", () => {
    const r = asRatio(0.5);
    // @ts-expect-error Ratio must not cross-assign to Percentage — use ratioToPercentage
    const p: Percentage = r;
    expect(p).toBe<number>(0.5);
  });
});
