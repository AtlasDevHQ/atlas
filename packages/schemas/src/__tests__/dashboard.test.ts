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
