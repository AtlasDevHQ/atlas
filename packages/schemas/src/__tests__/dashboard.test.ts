import { describe, expect, test } from "bun:test";
import {
  dashboardParameterSchema,
  dashboardParametersSchema,
  dashboardCardKindSchema,
  dashboardTextCardContentSchema,
  dashboardTextCardSchema,
  DASHBOARD_TEXT_CARD_CONTENT_MAX,
  dashboardChartTypeSchema,
  dashboardKpiConfigSchema,
  dashboardChartConfigSchema,
  dashboardDrilldownConfigSchema,
  dashboardThresholdSchema,
  DASHBOARD_THRESHOLDS_MAX,
  dashboardCardAnnotationSchema,
  dashboardCardAnnotationsSchema,
  DASHBOARD_ANNOTATIONS_MAX,
  sharedDashboardCardSchema,
  sharedDashboardParameterSummaryItemSchema,
  sharedDashboardViewSchema,
} from "../dashboard";

describe("dashboardParameterSchema", () => {
  test("accepts a well-formed date parameter (ISO + relative defaults)", () => {
    expect(
      dashboardParameterSchema.safeParse({ key: "date_from", type: "date", default: "now - 30 days", label: "From" })
        .success,
    ).toBe(true);
    expect(
      dashboardParameterSchema.safeParse({ key: "date_to", type: "date", default: "2026-01-01", label: "To" }).success,
    ).toBe(true);
    expect(
      dashboardParameterSchema.safeParse({ key: "d", type: "date", default: "now()", label: "D" }).success,
    ).toBe(true);
  });

  test("accepts number/text/null defaults of the right type", () => {
    expect(dashboardParameterSchema.safeParse({ key: "n", type: "number", default: 10, label: "N" }).success).toBe(true);
    expect(dashboardParameterSchema.safeParse({ key: "q", type: "text", default: "us", label: "Q" }).success).toBe(true);
    expect(dashboardParameterSchema.safeParse({ key: "q", type: "text", default: null, label: "Q" }).success).toBe(true);
  });

  test("rejects a string default on a number parameter", () => {
    expect(dashboardParameterSchema.safeParse({ key: "n", type: "number", default: "abc", label: "N" }).success).toBe(
      false,
    );
  });

  test("rejects a numeric default on a text parameter", () => {
    expect(dashboardParameterSchema.safeParse({ key: "q", type: "text", default: 42, label: "Q" }).success).toBe(false);
  });

  test("rejects a malformed date default", () => {
    expect(
      dashboardParameterSchema.safeParse({ key: "d", type: "date", default: "last tuesday", label: "D" }).success,
    ).toBe(false);
    expect(dashboardParameterSchema.safeParse({ key: "d", type: "date", default: 42, label: "D" }).success).toBe(false);
  });

  test("rejects a non-identifier key", () => {
    expect(dashboardParameterSchema.safeParse({ key: "Date From", type: "date", default: null, label: "x" }).success).toBe(
      false,
    );
  });
});

describe("dashboardParametersSchema", () => {
  test("rejects duplicate keys", () => {
    const result = dashboardParametersSchema.safeParse([
      { key: "date_from", type: "date", default: "now", label: "A" },
      { key: "date_from", type: "date", default: "now", label: "B" },
    ]);
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Text / section cards (#3138)
// ---------------------------------------------------------------------------

describe("dashboardCardKindSchema", () => {
  test("accepts the two card kinds and rejects anything else", () => {
    expect(dashboardCardKindSchema.safeParse("chart").success).toBe(true);
    expect(dashboardCardKindSchema.safeParse("text").success).toBe(true);
    expect(dashboardCardKindSchema.safeParse("kpi").success).toBe(false);
  });
});

describe("dashboardTextCardSchema", () => {
  test("round-trips a well-formed text card", () => {
    const card = { kind: "text" as const, content: "## Top of funnel\n\nLeads → MQLs → SQLs." };
    const parsed = dashboardTextCardSchema.parse(card);
    // Parse is a no-op transform — the validated value equals the input.
    expect(parsed).toEqual(card);
  });

  test("rejects empty content", () => {
    expect(dashboardTextCardContentSchema.safeParse("").success).toBe(false);
    expect(dashboardTextCardSchema.safeParse({ kind: "text", content: "" }).success).toBe(false);
  });

  test("rejects whitespace-only content (would render as a blank band)", () => {
    expect(dashboardTextCardContentSchema.safeParse("   ").success).toBe(false);
    expect(dashboardTextCardContentSchema.safeParse("\n\n\t").success).toBe(false);
  });

  test("rejects content past the length cap", () => {
    const tooLong = "a".repeat(DASHBOARD_TEXT_CARD_CONTENT_MAX + 1);
    expect(dashboardTextCardContentSchema.safeParse(tooLong).success).toBe(false);
  });

  test("rejects the wrong kind literal", () => {
    expect(dashboardTextCardSchema.safeParse({ kind: "chart", content: "x" }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// KPI / scorecard cards (#3137)
// ---------------------------------------------------------------------------

describe("dashboardChartTypeSchema", () => {
  test("accepts every chart type including the new kpi type", () => {
    for (const t of ["bar", "line", "pie", "area", "scatter", "table", "kpi"]) {
      expect(dashboardChartTypeSchema.safeParse(t).success).toBe(true);
    }
  });

  test("rejects an unknown chart type", () => {
    expect(dashboardChartTypeSchema.safeParse("gauge").success).toBe(false);
  });
});

describe("dashboardKpiConfigSchema", () => {
  test("round-trips a full kpi config (valueFormat + comparison)", () => {
    const kpi = {
      valueFormat: "currency" as const,
      comparisonSql: "SELECT SUM(amount) AS total FROM orders WHERE created_at < :date_from",
      comparisonLabel: "vs. prior period",
    };
    const parsed = dashboardKpiConfigSchema.parse(kpi);
    expect(parsed).toEqual(kpi);
  });

  test("accepts an empty kpi config (every field optional)", () => {
    expect(dashboardKpiConfigSchema.safeParse({}).success).toBe(true);
  });

  test("accepts each valueFormat option", () => {
    for (const valueFormat of ["currency", "number", "percent", "duration"]) {
      expect(dashboardKpiConfigSchema.safeParse({ valueFormat }).success).toBe(true);
    }
  });

  test("rejects an unknown valueFormat", () => {
    expect(dashboardKpiConfigSchema.safeParse({ valueFormat: "scientific" }).success).toBe(false);
  });

  test("rejects an empty comparisonSql (would run an empty query through the guard)", () => {
    expect(dashboardKpiConfigSchema.safeParse({ comparisonSql: "" }).success).toBe(false);
  });

  test("rejects unknown keys (strict — no stray config rides along)", () => {
    expect(
      dashboardKpiConfigSchema.safeParse({ comparisonSql: "SELECT 1 AS n", trend: true }).success,
    ).toBe(false);
  });

  test("rejects a comparisonLabel with no comparisonSql (dead config)", () => {
    expect(dashboardKpiConfigSchema.safeParse({ comparisonLabel: "vs. last month" }).success).toBe(false);
  });

  test("accepts a comparisonLabel alongside a comparisonSql", () => {
    expect(
      dashboardKpiConfigSchema.safeParse({
        comparisonSql: "SELECT 1 AS n",
        comparisonLabel: "vs. last month",
      }).success,
    ).toBe(true);
  });

  // #3207 — automatic period-over-period + inverse coloring.
  test("round-trips an autoComparison config", () => {
    const kpi = { autoComparison: true, comparisonLabel: "vs. prior period", inverse: true };
    expect(dashboardKpiConfigSchema.parse(kpi)).toEqual(kpi);
  });

  test("accepts autoComparison with a custom comparisonDateParams pair", () => {
    expect(
      dashboardKpiConfigSchema.safeParse({
        autoComparison: true,
        comparisonDateParams: { from: "start", to: "end" },
      }).success,
    ).toBe(true);
  });

  test("accepts a comparisonLabel alongside autoComparison (a comparison source exists)", () => {
    expect(
      dashboardKpiConfigSchema.safeParse({
        autoComparison: true,
        comparisonLabel: "vs. prior period",
      }).success,
    ).toBe(true);
  });

  test("rejects comparisonSql and autoComparison together (one source of comparison)", () => {
    expect(
      dashboardKpiConfigSchema.safeParse({
        comparisonSql: "SELECT 1 AS n",
        autoComparison: true,
      }).success,
    ).toBe(false);
  });

  test("rejects comparisonDateParams without autoComparison (only the auto path shifts a window)", () => {
    expect(
      dashboardKpiConfigSchema.safeParse({
        comparisonSql: "SELECT 1 AS n",
        comparisonDateParams: { from: "date_from", to: "date_to" },
      }).success,
    ).toBe(false);
  });

  test("rejects comparisonDateParams whose from equals to (binds the same window twice)", () => {
    expect(
      dashboardKpiConfigSchema.safeParse({
        autoComparison: true,
        comparisonDateParams: { from: "date_from", to: "date_from" },
      }).success,
    ).toBe(false);
  });

  test("rejects an invalid comparisonDateParams key (not a lower-snake identifier)", () => {
    expect(
      dashboardKpiConfigSchema.safeParse({
        autoComparison: true,
        comparisonDateParams: { from: "date from", to: "date_to" },
      }).success,
    ).toBe(false);
  });

  test("accepts inverse on its own (lower-is-better, no comparison source yet)", () => {
    expect(dashboardKpiConfigSchema.safeParse({ inverse: true }).success).toBe(true);
  });
});

describe("dashboardChartConfigSchema", () => {
  test("round-trips a kpi chart config with a comparison query", () => {
    const config = {
      type: "kpi" as const,
      categoryColumn: "label",
      valueColumns: ["total"],
      kpi: {
        valueFormat: "currency" as const,
        comparisonSql: "SELECT SUM(amount) AS total FROM orders WHERE created_at < :date_from",
        comparisonLabel: "Last month",
      },
    };
    const parsed = dashboardChartConfigSchema.parse(config);
    expect(parsed).toEqual(config);
  });

  test("accepts a plain (non-kpi) chart config without a kpi block", () => {
    const config = { type: "bar" as const, categoryColumn: "stage", valueColumns: ["amount"] };
    expect(dashboardChartConfigSchema.parse(config)).toEqual(config);
  });

  test("rejects a config missing valueColumns", () => {
    expect(
      dashboardChartConfigSchema.safeParse({ type: "kpi", categoryColumn: "label", valueColumns: [] }).success,
    ).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Click-to-drilldown (#3212)
  // ---------------------------------------------------------------------------

  test("round-trips a chart config with a drilldown target", () => {
    const config = {
      type: "bar" as const,
      categoryColumn: "region",
      valueColumns: ["revenue"],
      drilldown: { targetParam: "region" },
    };
    expect(dashboardChartConfigSchema.parse(config)).toEqual(config);
  });

  test("a chart config without drilldown stays back-compatible (field absent)", () => {
    const config = { type: "bar" as const, categoryColumn: "stage", valueColumns: ["amount"] };
    const parsed = dashboardChartConfigSchema.parse(config);
    expect(parsed).toEqual(config);
    expect("drilldown" in parsed).toBe(false);
  });

  test("rejects a drilldown target that isn't a lower-snake parameter key", () => {
    expect(
      dashboardChartConfigSchema.safeParse({
        type: "bar",
        categoryColumn: "region",
        valueColumns: ["revenue"],
        drilldown: { targetParam: "Region Filter" },
      }).success,
    ).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Goal lines / thresholds (#3208)
  // ---------------------------------------------------------------------------

  test("round-trips a chart config with thresholds unchanged", () => {
    const config = {
      type: "bar" as const,
      categoryColumn: "month",
      valueColumns: ["revenue"],
      thresholds: [
        { value: 1_000_000, color: "#f59e0b", label: "Target" },
        { value: 500_000 },
      ],
    };
    expect(dashboardChartConfigSchema.parse(config)).toEqual(config);
  });

  test("a chart config without thresholds stays back-compatible (field absent)", () => {
    const config = { type: "line" as const, categoryColumn: "day", valueColumns: ["count"] };
    const parsed = dashboardChartConfigSchema.parse(config);
    expect(parsed).toEqual(config);
    expect("thresholds" in parsed).toBe(false);
  });

  test("rejects more thresholds than the readable bound", () => {
    const tooMany = Array.from({ length: DASHBOARD_THRESHOLDS_MAX + 1 }, (_, i) => ({ value: i }));
    expect(
      dashboardChartConfigSchema.safeParse({
        type: "bar",
        categoryColumn: "m",
        valueColumns: ["v"],
        thresholds: tooMany,
      }).success,
    ).toBe(false);
  });
});

describe("dashboardThresholdSchema", () => {
  test("accepts a bare value (colour + label optional)", () => {
    expect(dashboardThresholdSchema.safeParse({ value: 100 }).success).toBe(true);
  });

  test("accepts hex, rgb(), and named colours", () => {
    expect(dashboardThresholdSchema.safeParse({ value: 1, color: "#10b981" }).success).toBe(true);
    expect(dashboardThresholdSchema.safeParse({ value: 1, color: "rgb(16, 185, 129)" }).success).toBe(true);
    expect(dashboardThresholdSchema.safeParse({ value: 1, color: "tomato" }).success).toBe(true);
  });

  test("rejects a non-finite value (NaN / Infinity can't position a line)", () => {
    expect(dashboardThresholdSchema.safeParse({ value: Number.NaN }).success).toBe(false);
    expect(dashboardThresholdSchema.safeParse({ value: Number.POSITIVE_INFINITY }).success).toBe(false);
  });

  test("rejects a missing value (the line has no position without it)", () => {
    expect(dashboardThresholdSchema.safeParse({ label: "Target" }).success).toBe(false);
  });

  test("rejects a junk colour string", () => {
    expect(dashboardThresholdSchema.safeParse({ value: 1, color: "not a color;" }).success).toBe(false);
  });

  test("rejects unknown keys (strict — no stray config rides along)", () => {
    expect(
      dashboardThresholdSchema.safeParse({ value: 1, fillArea: true }).success,
    ).toBe(false);
  });
});

describe("dashboardCardAnnotationSchema (#3209)", () => {
  test("accepts a bare { x, label } (colour optional)", () => {
    expect(
      dashboardCardAnnotationSchema.safeParse({ x: "2026-01-15", label: "Launch" }).success,
    ).toBe(true);
  });

  test("accepts hex, rgb(), and named colours", () => {
    expect(dashboardCardAnnotationSchema.safeParse({ x: "Jan", label: "A", color: "#10b981" }).success).toBe(true);
    expect(dashboardCardAnnotationSchema.safeParse({ x: "Jan", label: "A", color: "rgb(16, 185, 129)" }).success).toBe(true);
    expect(dashboardCardAnnotationSchema.safeParse({ x: "Jan", label: "A", color: "tomato" }).success).toBe(true);
  });

  test("rejects an empty x (a marker with no axis position)", () => {
    expect(dashboardCardAnnotationSchema.safeParse({ x: "", label: "Launch" }).success).toBe(false);
  });

  test("rejects an empty / missing label (the line has nothing to caption)", () => {
    expect(dashboardCardAnnotationSchema.safeParse({ x: "2026-01-15", label: "" }).success).toBe(false);
    expect(dashboardCardAnnotationSchema.safeParse({ x: "2026-01-15" }).success).toBe(false);
  });

  test("rejects a junk colour string", () => {
    expect(dashboardCardAnnotationSchema.safeParse({ x: "Jan", label: "A", color: "not a color;" }).success).toBe(false);
  });

  test("rejects unknown keys (strict — no stray config rides along)", () => {
    expect(
      dashboardCardAnnotationSchema.safeParse({ x: "Jan", label: "A", y: 5 }).success,
    ).toBe(false);
  });
});

describe("dashboardCardAnnotationsSchema (#3209)", () => {
  test("accepts an empty list (the default — renders as today)", () => {
    expect(dashboardCardAnnotationsSchema.safeParse([]).success).toBe(true);
  });

  test("accepts a list at the cap", () => {
    const atCap = Array.from({ length: DASHBOARD_ANNOTATIONS_MAX }, (_, i) => ({ x: `${i}`, label: `e${i}` }));
    expect(dashboardCardAnnotationsSchema.safeParse(atCap).success).toBe(true);
  });

  test("rejects more than the cap (keeps the chart readable)", () => {
    const tooMany = Array.from({ length: DASHBOARD_ANNOTATIONS_MAX + 1 }, (_, i) => ({ x: `${i}`, label: `e${i}` }));
    expect(dashboardCardAnnotationsSchema.safeParse(tooMany).success).toBe(false);
  });
});

describe("dashboardDrilldownConfigSchema", () => {
  test("accepts a valid parameter-key target", () => {
    expect(dashboardDrilldownConfigSchema.safeParse({ targetParam: "region" }).success).toBe(true);
    expect(dashboardDrilldownConfigSchema.safeParse({ targetParam: "date_from" }).success).toBe(true);
  });

  test("rejects a non-identifier target (would not match the :placeholder scanner)", () => {
    expect(dashboardDrilldownConfigSchema.safeParse({ targetParam: "9region" }).success).toBe(false);
    expect(dashboardDrilldownConfigSchema.safeParse({ targetParam: "" }).success).toBe(false);
  });

  test("rejects unknown keys (strict — no stray config rides along)", () => {
    expect(
      dashboardDrilldownConfigSchema.safeParse({ targetParam: "region", crossFilter: true }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Shared-view projection (#4316 — data-only snapshot)
// ---------------------------------------------------------------------------

describe("sharedDashboardCardSchema (#4316)", () => {
  const validCard = {
    id: "card-1",
    position: 0,
    title: "Revenue",
    kind: "chart" as const,
    chartConfig: { type: "bar", categoryColumn: "month", valueColumns: ["total"] },
    content: null,
    annotations: [],
    cachedColumns: ["month", "total"],
    cachedRows: [{ month: "Jan", total: 1000 }],
    cachedAt: "2026-04-04T00:00:00.000Z",
    layout: { x: 0, y: 0, w: 12, h: 6 },
  };

  test("accepts a minimal data-only card", () => {
    expect(sharedDashboardCardSchema.safeParse(validCard).success).toBe(true);
  });

  test("rejects a card that leaks sql (strict — no query internals on the wire)", () => {
    expect(
      sharedDashboardCardSchema.safeParse({ ...validCard, sql: "SELECT 1" }).success,
    ).toBe(false);
  });

  test("rejects a card that leaks connectionGroupId / dashboardId", () => {
    expect(
      sharedDashboardCardSchema.safeParse({ ...validCard, connectionGroupId: "cg-1" }).success,
    ).toBe(false);
    expect(
      sharedDashboardCardSchema.safeParse({ ...validCard, dashboardId: "d-1" }).success,
    ).toBe(false);
  });
});

describe("sharedDashboardParameterSummaryItemSchema (#4316)", () => {
  test("accepts a frozen { label, displayValue } pair", () => {
    expect(
      sharedDashboardParameterSummaryItemSchema.safeParse({ label: "Region", displayValue: "All" })
        .success,
    ).toBe(true);
  });

  test("rejects a leaked parameter definition field (key/type/default)", () => {
    for (const stray of [{ key: "region" }, { type: "text" }, { default: null }]) {
      expect(
        sharedDashboardParameterSummaryItemSchema.safeParse({
          label: "Region",
          displayValue: "All",
          ...stray,
        }).success,
      ).toBe(false);
    }
  });
});

describe("sharedDashboardViewSchema (#4316)", () => {
  const validView = {
    title: "Revenue",
    description: "Quarterly",
    shareMode: "public" as const,
    cards: [],
    parameterSummary: [{ label: "Date", displayValue: "2026-06-01" }],
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-02T00:00:00.000Z",
    lastRefreshAt: null,
  };

  test("round-trips a valid data-only snapshot", () => {
    const parsed = sharedDashboardViewSchema.safeParse(validView);
    expect(parsed.success).toBe(true);
  });

  test("accepts both public and org share modes", () => {
    expect(sharedDashboardViewSchema.safeParse({ ...validView, shareMode: "org" }).success).toBe(true);
  });

  test("rejects a snapshot that leaks orgId / ownerId / shareToken / refreshSchedule / parameters", () => {
    for (const stray of [
      { orgId: "org-1" },
      { ownerId: "u-1" },
      { shareToken: "tok" },
      { refreshSchedule: "0 * * * *" },
      { parameters: [] },
    ]) {
      expect(sharedDashboardViewSchema.safeParse({ ...validView, ...stray }).success).toBe(false);
    }
  });
});
