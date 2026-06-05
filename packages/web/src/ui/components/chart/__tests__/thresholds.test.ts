import { describe, expect, test } from "bun:test";
import {
  resolveThresholdLines,
  MAX_THRESHOLD_LINES,
  THRESHOLD_LINE_LIGHT,
  THRESHOLD_LINE_DARK,
  type ThresholdInput,
} from "../chart-detection";

// ---------------------------------------------------------------------------
// resolveThresholdLines (#3208) — the pure logic that decides which horizontal
// reference lines a chart renders. The recharts <ReferenceLine> mapping in
// result-chart.tsx is a thin map over these specs; we test the logic here
// without booting recharts in jsdom (same split as the rest of chart-detection).
// ---------------------------------------------------------------------------

describe("resolveThresholdLines", () => {
  test("returns no lines when thresholds are absent (back-compat — renders as today)", () => {
    expect(resolveThresholdLines(undefined, false)).toEqual([]);
  });

  test("returns no lines for an empty list", () => {
    expect(resolveThresholdLines([], false)).toEqual([]);
  });

  test("produces one reference-line spec per threshold (the line the chart renders)", () => {
    const thresholds: ThresholdInput[] = [{ value: 1_000_000 }, { value: 500_000 }];
    const lines = resolveThresholdLines(thresholds, false);
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => l.y)).toEqual([1_000_000, 500_000]);
  });

  test("resolves the theme default stroke when a threshold sets no colour", () => {
    expect(resolveThresholdLines([{ value: 10 }], false)[0].stroke).toBe(THRESHOLD_LINE_LIGHT);
    expect(resolveThresholdLines([{ value: 10 }], true)[0].stroke).toBe(THRESHOLD_LINE_DARK);
  });

  test("keeps an explicit colour + label (trimmed)", () => {
    const [line] = resolveThresholdLines([{ value: 1, color: "  #10b981  ", label: "  Target  " }], false);
    expect(line.stroke).toBe("#10b981");
    expect(line.label).toBe("Target");
  });

  test("falls back to the theme stroke for a structurally-malformed cached colour (no invisible line)", () => {
    // `rowToCard` JSON-parses cached config without Zod, so a junk colour can
    // reach the renderer; it must degrade to a visible theme stroke, not an
    // invisible SVG stroke.
    expect(resolveThresholdLines([{ value: 1, color: "not-a-color;" }], false)[0].stroke).toBe(
      THRESHOLD_LINE_LIGHT,
    );
    expect(resolveThresholdLines([{ value: 1, color: "" }], true)[0].stroke).toBe(THRESHOLD_LINE_DARK);
    expect(resolveThresholdLines([{ value: 1, color: "   " }], false)[0].stroke).toBe(THRESHOLD_LINE_LIGHT);
  });

  test("a threshold with no label yields a null label (no caption drawn)", () => {
    expect(resolveThresholdLines([{ value: 1 }], false)[0].label).toBeNull();
  });

  test("a whitespace-only label is treated as no label", () => {
    expect(resolveThresholdLines([{ value: 1, label: "   " }], false)[0].label).toBeNull();
  });

  test("caps the rendered set at MAX_THRESHOLD_LINES so the chart stays readable", () => {
    const tooMany: ThresholdInput[] = Array.from({ length: MAX_THRESHOLD_LINES + 3 }, (_, i) => ({ value: i }));
    expect(resolveThresholdLines(tooMany, false)).toHaveLength(MAX_THRESHOLD_LINES);
  });

  test("drops a non-finite value (defends against loosely-parsed cached config)", () => {
    const lines = resolveThresholdLines(
      [{ value: Number.NaN }, { value: 42 }, { value: Number.POSITIVE_INFINITY }],
      false,
    );
    expect(lines).toHaveLength(1);
    expect(lines[0].y).toBe(42);
  });
});
