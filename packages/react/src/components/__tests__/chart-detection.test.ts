import { describe, expect, test } from "bun:test";
import {
  detectCharts,
  categoryFromChartClick,
  categoryFromPieClick,
  resolveThresholdLines,
  resolveAnnotationLines,
  THRESHOLD_LINE_LIGHT,
  THRESHOLD_LINE_DARK,
  ANNOTATION_LINE_LIGHT,
  MAX_THRESHOLD_LINES,
  MAX_ANNOTATION_LINES,
} from "../chart/chart-detection";
import { categoryMatchesSelection } from "../../lib/helpers";

// Smoke coverage for the features newly absorbed from the web copy (#4193).
// The exhaustive classifier / recommendation suites live with the web app
// until its copy is removed in the post-publish follow-up.

describe("detectCharts", () => {
  test("date + numeric columns produce a chartable line recommendation", () => {
    const result = detectCharts(
      ["month", "revenue"],
      [
        ["2026-01", "100"],
        ["2026-02", "200"],
        ["2026-03", "300"],
      ],
    );
    expect(result.chartable).toBe(true);
    if (result.chartable) {
      expect(result.recommendations[0].type).toBe("line");
    }
  });

  test("fewer than 2 rows is not chartable", () => {
    expect(detectCharts(["a", "b"], [["x", "1"]]).chartable).toBe(false);
  });
});

describe("resolveThresholdLines (#3208)", () => {
  test("returns [] for absent or empty thresholds", () => {
    expect(resolveThresholdLines(undefined, false)).toEqual([]);
    expect(resolveThresholdLines([], true)).toEqual([]);
  });

  test("resolves value/color/label; theme fallback for missing color", () => {
    const lines = resolveThresholdLines(
      [
        { value: 1000, color: "#ff0000", label: " Target " },
        { value: 2000 },
      ],
      false,
    );
    expect(lines).toEqual([
      { y: 1000, stroke: "#ff0000", label: "Target" },
      { y: 2000, stroke: THRESHOLD_LINE_LIGHT, label: null },
    ]);
  });

  test("malformed color falls back to the dark theme stroke", () => {
    const lines = resolveThresholdLines([{ value: 5, color: "url(javascript:x)" }], true);
    expect(lines[0].stroke).toBe(THRESHOLD_LINE_DARK);
  });

  test("drops non-finite values and caps at MAX_THRESHOLD_LINES", () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ value: i }));
    expect(resolveThresholdLines([{ value: NaN }, ...many], false).length).toBe(
      MAX_THRESHOLD_LINES,
    );
  });
});

describe("resolveAnnotationLines (#3209)", () => {
  test("returns [] for absent or empty annotations", () => {
    expect(resolveAnnotationLines(undefined, false)).toEqual([]);
    expect(resolveAnnotationLines([], false)).toEqual([]);
  });

  test("trims x, resolves stroke fallback, caps count", () => {
    const lines = resolveAnnotationLines(
      [{ x: " 2026-06-01 ", label: "Launch" }, { x: "", label: "dropped" }],
      false,
    );
    expect(lines).toEqual([{ x: "2026-06-01", stroke: ANNOTATION_LINE_LIGHT, label: "Launch" }]);

    const many = Array.from({ length: 30 }, (_, i) => ({ x: `d${i}`, label: "e" }));
    expect(resolveAnnotationLines(many, false).length).toBe(MAX_ANNOTATION_LINES);
  });
});

describe("click-to-drilldown extractors (#3212)", () => {
  test("categoryFromChartClick reads activeLabel, null for empty clicks", () => {
    expect(categoryFromChartClick({ activeLabel: "Discovery" } as never)).toBe("Discovery");
    expect(categoryFromChartClick({ activeLabel: 2026 } as never)).toBe("2026");
    expect(categoryFromChartClick(null)).toBeNull();
    expect(categoryFromChartClick({ activeLabel: "" } as never)).toBeNull();
  });

  test("categoryFromPieClick reads the category off the sector payload", () => {
    expect(categoryFromPieClick({ payload: { region: "EU", total: 5 } }, "region")).toBe("EU");
    expect(categoryFromPieClick({ payload: {} }, "region")).toBeNull();
    expect(categoryFromPieClick(null, "region")).toBeNull();
  });
});

describe("categoryMatchesSelection (#3219)", () => {
  test("exact match and timestamp-prefix match", () => {
    expect(categoryMatchesSelection("EU", "EU")).toBe(true);
    expect(categoryMatchesSelection("2026-06-04T12:00:00Z", "2026-06-04")).toBe(true);
    expect(categoryMatchesSelection("2026-06-04 12:00:00", "2026-06-04")).toBe(true);
    expect(categoryMatchesSelection("2026-06-05T00:00:00Z", "2026-06-04")).toBe(false);
    expect(categoryMatchesSelection("EU-west", "EU")).toBe(false);
    expect(categoryMatchesSelection(null, "EU")).toBe(false);
  });
});
