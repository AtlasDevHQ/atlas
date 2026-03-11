import { describe, expect, test } from "bun:test";
import { classifyColumn, detectCharts, transformData, type ChartRecommendation, type ClassifiedColumn } from "../components/chart/chart-detection";

/* ------------------------------------------------------------------ */
/*  classifyColumn                                                      */
/* ------------------------------------------------------------------ */

describe("classifyColumn", () => {
  test("numeric column — integers", () => {
    expect(classifyColumn("revenue", ["100", "200", "300", "400", "500"])).toBe("numeric");
  });

  test("numeric column — with commas", () => {
    expect(classifyColumn("amount", ["1,000", "2,500", "3,000"])).toBe("numeric");
  });

  test("date column — ISO dates", () => {
    expect(classifyColumn("created_at", ["2024-01-15", "2024-02-20", "2024-03-10"])).toBe("date");
  });

  test("date column — month names", () => {
    expect(classifyColumn("month", ["January", "February", "March", "April"])).toBe("date");
  });

  test("date column — quarter format", () => {
    expect(classifyColumn("quarter", ["Q1 2024", "Q2 2024", "Q3 2024", "Q4 2024"])).toBe("date");
  });

  test("date column — year only", () => {
    expect(classifyColumn("year", ["2020", "2021", "2022", "2023", "2024"])).toBe("date");
  });

  test("categorical column — text values", () => {
    expect(classifyColumn("industry", ["Tech", "Finance", "Healthcare", "Retail"])).toBe("categorical");
  });

  test("unknown column — id-like header", () => {
    expect(classifyColumn("id", ["1", "2", "3", "4"])).toBe("unknown");
  });

  test("unknown column — uuid header", () => {
    expect(classifyColumn("uuid", ["abc", "def", "ghi"])).toBe("unknown");
  });

  test("unknown column — empty values", () => {
    expect(classifyColumn("col", [])).toBe("unknown");
  });

  test("year values with non-hint header — classified as date (dateRatio > 0.7 wins)", () => {
    expect(classifyColumn("fiscal_year", ["2020", "2021", "2022", "2023"])).toBe("date");
  });

  test("numeric column with empty values mixed in", () => {
    expect(classifyColumn("revenue", ["100", "", "200", "", "300"])).toBe("numeric");
  });

  test("numeric column with null values", () => {
    expect(classifyColumn("revenue", ["100", null as unknown as string, "200", null as unknown as string, "300"])).toBe("numeric");
  });
});

/* ------------------------------------------------------------------ */
/*  detectCharts                                                        */
/* ------------------------------------------------------------------ */

describe("detectCharts", () => {
  test("categorical + numeric → bar + pie", () => {
    const headers = ["industry", "revenue"];
    const rows = [
      ["Tech", "500000"],
      ["Finance", "300000"],
      ["Healthcare", "200000"],
      ["Retail", "150000"],
      ["Energy", "100000"],
    ];
    const result = detectCharts(headers, rows);
    expect(result.chartable).toBe(true);
    if (!result.chartable) return;
    const types = result.recommendations.map((r) => r.type);
    expect(types).toContain("bar");
    expect(types).toContain("pie");
  });

  test("date + numeric → line + bar", () => {
    const headers = ["month", "sales", "returns"];
    const rows = Array.from({ length: 12 }, (_, i) => [
      `2024-${String(i + 1).padStart(2, "0")}-01`,
      String(1000 + i * 100),
      String(50 + i * 10),
    ]);
    const result = detectCharts(headers, rows);
    expect(result.chartable).toBe(true);
    if (!result.chartable) return;
    const types = result.recommendations.map((r) => r.type);
    expect(types).toContain("line");
  });

  test("ISO date column + numeric → line", () => {
    const headers = ["date", "value"];
    const rows = Array.from({ length: 30 }, (_, i) => [
      `2024-01-${String(i + 1).padStart(2, "0")}`,
      String(100 + i),
    ]);
    const result = detectCharts(headers, rows);
    expect(result.chartable).toBe(true);
    if (!result.chartable) return;
    expect(result.recommendations[0].type).toBe("line");
  });

  test("single row → not chartable", () => {
    const headers = ["id", "value"];
    const rows = [["1", "100"]];
    const result = detectCharts(headers, rows);
    expect(result.chartable).toBe(false);
  });

  test("all text → not chartable", () => {
    const headers = ["name", "description"];
    const rows = [
      ["Alice", "Engineer"],
      ["Bob", "Designer"],
    ];
    const result = detectCharts(headers, rows);
    expect(result.chartable).toBe(false);
  });

  test("many categories (>7) → bar only, no pie", () => {
    const headers = ["country", "count"];
    const rows = Array.from({ length: 25 }, (_, i) => [
      `Country_${i + 1}`,
      String(100 + i * 10),
    ]);
    const result = detectCharts(headers, rows);
    expect(result.chartable).toBe(true);
    if (!result.chartable) return;
    const types = result.recommendations.map((r) => r.type);
    expect(types).toContain("bar");
    expect(types).not.toContain("pie");
  });

  test("empty headers → not chartable", () => {
    const result = detectCharts([], []);
    expect(result.chartable).toBe(false);
  });

  test("data array has correct numeric values — all 3 rows", () => {
    const headers = ["category", "amount"];
    const rows = [
      ["A", "1,000"],
      ["B", "2,500"],
      ["C", "3,000"],
    ];
    const result = detectCharts(headers, rows);
    expect(result.chartable).toBe(true);
    if (!result.chartable) return;
    expect(result.data[0].category).toBe("A");
    expect(result.data[0].amount).toBe(1000);
    expect(result.data[1].category).toBe("B");
    expect(result.data[1].amount).toBe(2500);
    expect(result.data[2].category).toBe("C");
    expect(result.data[2].amount).toBe(3000);
  });

  test("fallback bar chart for numeric-only columns", () => {
    const headers = ["x_val", "y_val"];
    const rows = [
      ["10", "200"],
      ["20", "400"],
      ["30", "600"],
    ];
    const result = detectCharts(headers, rows);
    expect(result.chartable).toBe(true);
    if (!result.chartable) return;
    const types = result.recommendations.map((r) => r.type);
    // Scatter is recommended for 2+ numerics; bar is fallback
    expect(types).toContain("scatter");
    expect(types).toContain("bar");
  });

  test("area chart: recommended as alternative to line for date + numeric", () => {
    const headers = ["date", "revenue"];
    const rows = Array.from({ length: 12 }, (_, i) => [
      `2024-${String(i + 1).padStart(2, "0")}-01`,
      String(1000 + i * 100),
    ]);
    const result = detectCharts(headers, rows);
    expect(result.chartable).toBe(true);
    if (!result.chartable) return;
    const types = result.recommendations.map((r) => r.type);
    expect(types).toContain("line");
    expect(types).toContain("area");
  });

  test("stacked bar: recommended for categorical + multiple numeric columns", () => {
    const headers = ["region", "revenue", "cost", "profit"];
    const rows = [
      ["East", "500", "200", "300"],
      ["West", "600", "250", "350"],
      ["North", "400", "180", "220"],
      ["South", "550", "230", "320"],
    ];
    const result = detectCharts(headers, rows);
    expect(result.chartable).toBe(true);
    if (!result.chartable) return;
    const types = result.recommendations.map((r) => r.type);
    expect(types).toContain("stacked-bar");
    expect(types).toContain("bar");
  });

  test("stacked bar: NOT recommended for categorical + single numeric", () => {
    const headers = ["region", "revenue"];
    const rows = [
      ["East", "500"],
      ["West", "600"],
      ["North", "400"],
    ];
    const result = detectCharts(headers, rows);
    expect(result.chartable).toBe(true);
    if (!result.chartable) return;
    const types = result.recommendations.map((r) => r.type);
    expect(types).not.toContain("stacked-bar");
  });

  test("scatter: recommended for 2+ numeric columns", () => {
    const headers = ["weight", "height", "bmi"];
    const rows = [
      ["70", "175", "22.9"],
      ["85", "180", "26.2"],
      ["60", "160", "23.4"],
      ["90", "185", "26.3"],
    ];
    const result = detectCharts(headers, rows);
    expect(result.chartable).toBe(true);
    if (!result.chartable) return;
    const types = result.recommendations.map((r) => r.type);
    expect(types).toContain("scatter");
    const scatterRec = result.recommendations.find((r) => r.type === "scatter")!;
    expect(scatterRec.categoryColumn.header).toBe("weight");
    expect(scatterRec.valueColumns[0].header).toBe("height");
    expect(scatterRec.reason).toContain("size: bmi");
  });

  test("scatter: 2 numeric columns, no size encoding", () => {
    const headers = ["x", "y"];
    const rows = [
      ["10", "20"],
      ["30", "40"],
      ["50", "60"],
    ];
    const result = detectCharts(headers, rows);
    expect(result.chartable).toBe(true);
    if (!result.chartable) return;
    const scatterRec = result.recommendations.find((r) => r.type === "scatter")!;
    expect(scatterRec.valueColumns).toHaveLength(1);
    expect(scatterRec.reason).not.toContain("size:");
  });

  test("date + categorical + numeric → line and bar recommendations", () => {
    const headers = ["month", "region", "sales"];
    const rows = [
      ["2024-01-01", "East", "1000"],
      ["2024-02-01", "West", "2000"],
      ["2024-03-01", "East", "1500"],
      ["2024-04-01", "West", "2500"],
      ["2024-05-01", "East", "1200"],
    ];
    const result = detectCharts(headers, rows);
    expect(result.chartable).toBe(true);
    if (!result.chartable) return;
    const types = result.recommendations.map((r) => r.type);
    expect(types).toContain("line");
    expect(types).toContain("bar");

    const lineRec = result.recommendations.find((r) => r.type === "line")!;
    expect(lineRec.categoryColumn.header).toBe("month");
    expect(lineRec.valueColumns[0].header).toBe("sales");

    const barRec = result.recommendations.find((r) => r.type === "bar")!;
    expect(barRec.categoryColumn.header).toBe("region");
    expect(barRec.valueColumns[0].header).toBe("sales");
  });

  test("pie chart boundary: exactly 2 categories → pie included", () => {
    const headers = ["status", "count"];
    const rows = [
      ["Active", "150"],
      ["Inactive", "50"],
    ];
    const result = detectCharts(headers, rows);
    expect(result.chartable).toBe(true);
    if (!result.chartable) return;
    const types = result.recommendations.map((r) => r.type);
    expect(types).toContain("pie");
  });

  test("pie chart boundary: exactly 8 categories → no pie", () => {
    const headers = ["department", "headcount"];
    const rows = Array.from({ length: 8 }, (_, i) => [
      `Dept_${i + 1}`,
      String((i + 1) * 10),
    ]);
    const result = detectCharts(headers, rows);
    expect(result.chartable).toBe(true);
    if (!result.chartable) return;
    const types = result.recommendations.map((r) => r.type);
    expect(types).not.toContain("pie");
  });

  test("columns metadata correctness", () => {
    const headers = ["region", "date", "revenue", "cost"];
    const rows = [
      ["East", "2024-01-01", "500", "200"],
      ["West", "2024-02-01", "600", "250"],
      ["East", "2024-03-01", "550", "220"],
    ];
    const result = detectCharts(headers, rows);
    expect(result.columns).toHaveLength(4);

    expect(result.columns[0].header).toBe("region");
    expect(result.columns[0].type).toBe("categorical");
    expect(result.columns[0].uniqueCount).toBe(2);

    expect(result.columns[1].header).toBe("date");
    expect(result.columns[1].type).toBe("date");
    expect(result.columns[1].uniqueCount).toBe(3);

    expect(result.columns[2].header).toBe("revenue");
    expect(result.columns[2].type).toBe("numeric");
    expect(result.columns[2].uniqueCount).toBe(3);

    expect(result.columns[3].header).toBe("cost");
    expect(result.columns[3].type).toBe("numeric");
    expect(result.columns[3].uniqueCount).toBe(3);
  });
});

/* ------------------------------------------------------------------ */
/*  transformData                                                       */
/* ------------------------------------------------------------------ */

describe("transformData", () => {
  test("duplicate header deduplication at classification time", () => {
    const headers = ["name", "name", "count"];
    const rows = [
      ["Alice", "Engineer", "100"],
      ["Bob", "Designer", "200"],
      ["Charlie", "Manager", "300"],
    ];
    const result = detectCharts(headers, rows);
    expect(result.chartable).toBe(true);
    if (!result.chartable) return;

    const headerNames = result.columns.map((c) => c.header);
    expect(headerNames).toEqual(["name", "name_2", "count"]);

    const data = result.data;
    for (const row of data) {
      expect(Object.keys(row).length).toBeGreaterThanOrEqual(2);
    }
  });

  test("bar chart row capping — >30 rows → top 20 sorted descending", () => {
    const catCol: ClassifiedColumn = { index: 0, header: "name", type: "categorical", uniqueCount: 50 };
    const valCol: ClassifiedColumn = { index: 1, header: "value", type: "numeric", uniqueCount: 50 };
    const recommendation: ChartRecommendation = {
      type: "bar",
      categoryColumn: catCol,
      valueColumns: [valCol],
      reason: "test",
    };

    const rows = Array.from({ length: 50 }, (_, i) => [
      `Item_${i + 1}`,
      String(i + 1),
    ]);

    const data = transformData(rows, recommendation);
    expect(data).toHaveLength(20);

    expect(data[0].value).toBe(50);
    expect(data[1].value).toBe(49);
    expect(data[19].value).toBe(31);
  });

  test("line chart does NOT cap rows", () => {
    const catCol: ClassifiedColumn = { index: 0, header: "date", type: "date", uniqueCount: 50 };
    const valCol: ClassifiedColumn = { index: 1, header: "sales", type: "numeric", uniqueCount: 50 };
    const recommendation: ChartRecommendation = {
      type: "line",
      categoryColumn: catCol,
      valueColumns: [valCol],
      reason: "test",
    };

    const rows = Array.from({ length: 50 }, (_, i) => [
      `2024-01-${String(i + 1).padStart(2, "0")}`,
      String((i + 1) * 100),
    ]);

    const data = transformData(rows, recommendation);
    expect(data).toHaveLength(50);
  });

  test("non-numeric values become 0", () => {
    const catCol: ClassifiedColumn = { index: 0, header: "name", type: "categorical", uniqueCount: 3 };
    const valCol: ClassifiedColumn = { index: 1, header: "amount", type: "numeric", uniqueCount: 3 };
    const recommendation: ChartRecommendation = {
      type: "bar",
      categoryColumn: catCol,
      valueColumns: [valCol],
      reason: "test",
    };

    const rows = [
      ["Alice", "not-a-number"],
      ["Bob", "100"],
    ];

    const data = transformData(rows, recommendation);
    expect(data[0].amount).toBe(0);
    expect(data[1].amount).toBe(100);
  });

  test("currency and percentage stripping", () => {
    const catCol: ClassifiedColumn = { index: 0, header: "item", type: "categorical", uniqueCount: 3 };
    const valCol: ClassifiedColumn = { index: 1, header: "value", type: "numeric", uniqueCount: 3 };
    const recommendation: ChartRecommendation = {
      type: "bar",
      categoryColumn: catCol,
      valueColumns: [valCol],
      reason: "test",
    };

    const rows = [
      ["A", "$500"],
      ["B", "45%"],
      ["C", "1,000"],
    ];

    const data = transformData(rows, recommendation);
    expect(data[0].value).toBe(500);
    expect(data[1].value).toBe(45);
    expect(data[2].value).toBe(1000);
  });

  test("scatter chart transforms both axes as numeric", () => {
    const xCol: ClassifiedColumn = { index: 0, header: "weight", type: "numeric", uniqueCount: 4 };
    const yCol: ClassifiedColumn = { index: 1, header: "height", type: "numeric", uniqueCount: 4 };
    const recommendation: ChartRecommendation = {
      type: "scatter",
      categoryColumn: xCol,
      valueColumns: [yCol],
      reason: "test",
    };

    const rows = [
      ["70", "175"],
      ["85", "180"],
      ["60", "160"],
    ];

    const data = transformData(rows, recommendation);
    expect(data).toHaveLength(3);
    expect(data[0].weight).toBe(70);
    expect(data[0].height).toBe(175);
    expect(typeof data[0].weight).toBe("number");
  });

  test("stacked-bar chart caps rows like bar", () => {
    const catCol: ClassifiedColumn = { index: 0, header: "name", type: "categorical", uniqueCount: 50 };
    const val1: ClassifiedColumn = { index: 1, header: "a", type: "numeric", uniqueCount: 50 };
    const val2: ClassifiedColumn = { index: 2, header: "b", type: "numeric", uniqueCount: 50 };
    const recommendation: ChartRecommendation = {
      type: "stacked-bar",
      categoryColumn: catCol,
      valueColumns: [val1, val2],
      reason: "test",
    };

    const rows = Array.from({ length: 50 }, (_, i) => [
      `Item_${i + 1}`,
      String(i + 1),
      String(100 - i),
    ]);

    const data = transformData(rows, recommendation);
    expect(data).toHaveLength(20);
  });

  test("short rows (ragged CSV) — missing values default to 0", () => {
    const catCol: ClassifiedColumn = { index: 0, header: "name", type: "categorical", uniqueCount: 3 };
    const valCol: ClassifiedColumn = { index: 1, header: "score", type: "numeric", uniqueCount: 3 };
    const recommendation: ChartRecommendation = {
      type: "bar",
      categoryColumn: catCol,
      valueColumns: [valCol],
      reason: "test",
    };

    const rows = [
      ["Alice", "100"],
      ["Bob"],
    ];

    const data = transformData(rows, recommendation);
    expect(data).toHaveLength(2);
    expect(data[0].score).toBe(100);
    expect(data[1].score).toBe(0);
    expect(data[1].name).toBe("Bob");
  });
});
