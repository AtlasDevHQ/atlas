import { describe, test, expect } from "bun:test";
import { rowToCard, CardLayoutSchema } from "@atlas/api/lib/dashboards";
import type { DashboardChartConfig } from "@atlas/api/lib/dashboard-types";

const baseRow = {
  id: "card-1",
  dashboard_id: "dash-1",
  position: 0,
  title: "Untitled",
  sql: "SELECT 1",
  chart_config: null,
  cached_columns: null,
  cached_rows: null,
  cached_at: null,
  connection_id: null,
  created_at: "2026-04-25T00:00:00Z",
  updated_at: "2026-04-25T00:00:00Z",
};

describe("rowToCard layout parsing", () => {
  test("accepts a valid layout object", () => {
    const card = rowToCard({ ...baseRow, layout: { x: 1, y: 2, w: 12, h: 6 } });
    expect(card.layout).toEqual({ x: 1, y: 2, w: 12, h: 6 });
  });

  test("accepts a JSON-string layout (driver may surface JSONB as text)", () => {
    const card = rowToCard({ ...baseRow, layout: '{"x":3,"y":0,"w":10,"h":5}' });
    expect(card.layout).toEqual({ x: 3, y: 0, w: 10, h: 5 });
  });

  test("discards a layout missing required fields", () => {
    const card = rowToCard({ ...baseRow, layout: { x: 1, y: 2, w: 12 } });
    expect(card.layout).toBeNull();
  });

  test("discards malformed JSON string", () => {
    const card = rowToCard({ ...baseRow, layout: "not json" });
    expect(card.layout).toBeNull();
  });

  test("discards out-of-bounds values that the route schema would reject", () => {
    const card = rowToCard({ ...baseRow, layout: { x: -5, y: 0, w: 12, h: 6 } });
    expect(card.layout).toBeNull();
  });

  test("discards layouts overflowing the 24-col grid via x + w", () => {
    const card = rowToCard({ ...baseRow, layout: { x: 23, y: 0, w: 24, h: 6 } });
    expect(card.layout).toBeNull();
  });

  test("discards NaN/Infinity numbers", () => {
    expect(rowToCard({ ...baseRow, layout: { x: Number.NaN, y: 0, w: 12, h: 6 } }).layout).toBeNull();
    expect(rowToCard({ ...baseRow, layout: { x: 1, y: Number.POSITIVE_INFINITY, w: 12, h: 6 } }).layout).toBeNull();
  });

  test("treats null layout as not-yet-placed", () => {
    expect(rowToCard({ ...baseRow, layout: null }).layout).toBeNull();
    expect(rowToCard({ ...baseRow }).layout).toBeNull();
  });
});

describe("rowToCard chart_config / KPI round-trip (#3137, #3207)", () => {
  test("round-trips a KPI auto-comparison config (object form)", () => {
    const chartConfig: DashboardChartConfig = {
      type: "kpi",
      categoryColumn: "label",
      valueColumns: ["total"],
      kpi: {
        valueFormat: "percent",
        autoComparison: true,
        comparisonDateParams: { from: "start", to: "end" },
        comparisonLabel: "vs. prior period",
        inverse: true,
      },
    };
    const card = rowToCard({ ...baseRow, chart_config: chartConfig });
    // The new #3207 fields survive the read path unchanged (no field-by-field
    // mapping strips them — chart_config is carried through as a whole).
    expect(card.chartConfig).toEqual(chartConfig);
  });

  test("round-trips a KPI auto-comparison config (JSON string form)", () => {
    const chartConfig: DashboardChartConfig = {
      type: "kpi",
      categoryColumn: "label",
      valueColumns: ["total"],
      kpi: { autoComparison: true, inverse: true },
    };
    const card = rowToCard({ ...baseRow, chart_config: JSON.stringify(chartConfig) });
    expect(card.chartConfig).toEqual(chartConfig);
  });
});

describe("rowToCard kind / content derivation (#3138)", () => {
  test("derives kind=text and surfaces content when content is a non-empty string", () => {
    const card = rowToCard({ ...baseRow, content: "## Top of funnel", sql: "" });
    expect(card.kind).toBe("text");
    expect(card.content).toBe("## Top of funnel");
  });

  test("derives kind=chart when content is null", () => {
    const card = rowToCard({ ...baseRow, content: null });
    expect(card.kind).toBe("chart");
    expect(card.content).toBeNull();
  });

  test("treats absent content (pre-#3138 row) as a chart card", () => {
    const card = rowToCard({ ...baseRow });
    expect(card.kind).toBe("chart");
    expect(card.content).toBeNull();
  });

  test("degrades an empty / whitespace-only content to a chart card (no blank text tile)", () => {
    expect(rowToCard({ ...baseRow, content: "" }).kind).toBe("chart");
    expect(rowToCard({ ...baseRow, content: "   \n  " }).kind).toBe("chart");
    expect(rowToCard({ ...baseRow, content: "" }).content).toBeNull();
  });
});

describe("CardLayoutSchema bounds", () => {
  test("accepts a typical layout", () => {
    expect(CardLayoutSchema.safeParse({ x: 0, y: 0, w: 12, h: 10 }).success).toBe(true);
  });

  test("rejects x at the right edge that overflows", () => {
    expect(CardLayoutSchema.safeParse({ x: 23, y: 0, w: 12, h: 10 }).success).toBe(false);
  });

  test("rejects w below minimum", () => {
    expect(CardLayoutSchema.safeParse({ x: 0, y: 0, w: 2, h: 10 }).success).toBe(false);
  });

  test("rejects h below minimum", () => {
    expect(CardLayoutSchema.safeParse({ x: 0, y: 0, w: 12, h: 3 }).success).toBe(false);
  });

  test("rejects fractional values", () => {
    expect(CardLayoutSchema.safeParse({ x: 0.5, y: 0, w: 12, h: 10 }).success).toBe(false);
  });

  test("rejects negative coordinates", () => {
    expect(CardLayoutSchema.safeParse({ x: -1, y: 0, w: 12, h: 10 }).success).toBe(false);
    expect(CardLayoutSchema.safeParse({ x: 0, y: -1, w: 12, h: 10 }).success).toBe(false);
  });
});
