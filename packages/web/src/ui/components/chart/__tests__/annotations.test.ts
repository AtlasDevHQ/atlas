import { describe, expect, test } from "bun:test";
import {
  resolveAnnotationLines,
  MAX_ANNOTATION_LINES,
  ANNOTATION_LINE_LIGHT,
  ANNOTATION_LINE_DARK,
  type AnnotationInput,
} from "../chart-detection";

// ---------------------------------------------------------------------------
// resolveAnnotationLines (#3209) — the pure logic that decides which VERTICAL
// reference lines a time-series chart renders. The recharts <ReferenceLine x=...>
// mapping in result-chart.tsx is a thin map over these specs; we test the logic
// here without booting recharts in jsdom (the vertical sibling of the
// resolveThresholdLines tests, same split as the rest of chart-detection).
// ---------------------------------------------------------------------------

describe("resolveAnnotationLines", () => {
  test("returns no lines when annotations are absent (back-compat — renders as today)", () => {
    expect(resolveAnnotationLines(undefined, false)).toEqual([]);
  });

  test("returns no lines for an empty list", () => {
    expect(resolveAnnotationLines([], false)).toEqual([]);
  });

  test("produces one reference-line spec per annotation (the line the chart renders)", () => {
    const annotations: AnnotationInput[] = [
      { x: "2026-01-15", label: "Launch" },
      { x: "2026-03-01", label: "Campaign" },
    ];
    const lines = resolveAnnotationLines(annotations, false);
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => l.x)).toEqual(["2026-01-15", "2026-03-01"]);
    expect(lines.map((l) => l.label)).toEqual(["Launch", "Campaign"]);
  });

  test("resolves the theme default stroke when an annotation sets no colour", () => {
    expect(resolveAnnotationLines([{ x: "Jan", label: "A" }], false)[0].stroke).toBe(ANNOTATION_LINE_LIGHT);
    expect(resolveAnnotationLines([{ x: "Jan", label: "A" }], true)[0].stroke).toBe(ANNOTATION_LINE_DARK);
  });

  test("keeps an explicit colour + label (both trimmed)", () => {
    const [line] = resolveAnnotationLines([{ x: "Jan", label: "  Launch  ", color: "  #10b981  " }], false);
    expect(line.stroke).toBe("#10b981");
    expect(line.label).toBe("Launch");
  });

  test("trims a whitespace-padded x so it matches the chart's axis domain", () => {
    const [line] = resolveAnnotationLines([{ x: "  2026-01-15  ", label: "Launch" }], false);
    expect(line.x).toBe("2026-01-15");
  });

  test("falls back to the theme stroke for a structurally-malformed colour", () => {
    const [line] = resolveAnnotationLines([{ x: "Jan", label: "A", color: "not a color;" }], false);
    expect(line.stroke).toBe(ANNOTATION_LINE_LIGHT);
  });

  test("drops a marker with no X position (can't be placed on the axis)", () => {
    const lines = resolveAnnotationLines(
      [{ x: "", label: "Empty" }, { x: "  ", label: "Whitespace" }, { x: "Feb", label: "Real" }],
      false,
    );
    expect(lines).toHaveLength(1);
    expect(lines[0].x).toBe("Feb");
  });

  test("trims an empty label to null (line renders without a caption)", () => {
    const [line] = resolveAnnotationLines([{ x: "Jan", label: "   " }], false);
    expect(line.label).toBeNull();
  });

  test("caps the rendered set at MAX_ANNOTATION_LINES", () => {
    const many: AnnotationInput[] = Array.from({ length: MAX_ANNOTATION_LINES + 5 }, (_, i) => ({
      x: `${i}`,
      label: `e${i}`,
    }));
    expect(resolveAnnotationLines(many, false)).toHaveLength(MAX_ANNOTATION_LINES);
  });
});
