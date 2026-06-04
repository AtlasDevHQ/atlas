import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import type { DashboardCard } from "@/ui/lib/types";
import {
  KpiCard,
  computeKpiDelta,
  extractKpiNumber,
  formatKpiValue,
  hasKpiComparison,
  kpiComparisonSignature,
} from "../kpi-card";

// ---------------------------------------------------------------------------
// computeKpiDelta — the comparison math, including the failure modes the issue
// calls out explicitly (divide-by-zero, null prior period).
// ---------------------------------------------------------------------------

describe("computeKpiDelta", () => {
  test("computes a positive delta (current above prior)", () => {
    expect(computeKpiDelta(120, 100)).toEqual({ pct: 20, direction: "up" });
  });

  test("computes a negative delta (current below prior)", () => {
    expect(computeKpiDelta(80, 100)).toEqual({ pct: -20, direction: "down" });
  });

  test("reports flat when current equals prior", () => {
    expect(computeKpiDelta(100, 100)).toEqual({ pct: 0, direction: "flat" });
  });

  test("reports flat when both are zero (no spurious divide-by-zero)", () => {
    expect(computeKpiDelta(0, 0)).toEqual({ pct: 0, direction: "flat" });
  });

  test("returns null on divide-by-zero (prior is zero, current is not)", () => {
    expect(computeKpiDelta(100, 0)).toBeNull();
  });

  test("returns null when the prior period is null (no comparison data)", () => {
    expect(computeKpiDelta(100, null)).toBeNull();
  });

  test("returns null when the current value is null (nothing to compare)", () => {
    expect(computeKpiDelta(null, 100)).toBeNull();
  });

  test("uses the magnitude of a negative prior for the percentage", () => {
    // -50 → -25 is a +50% move (toward zero), not -50%.
    expect(computeKpiDelta(-25, -50)).toEqual({ pct: 50, direction: "up" });
  });
});

// ---------------------------------------------------------------------------
// extractKpiNumber — pulling the headline number out of a query result row.
// ---------------------------------------------------------------------------

describe("extractKpiNumber", () => {
  test("reads the preferred value column from the (last) row", () => {
    expect(
      extractKpiNumber(["label", "total"], [{ label: "Revenue", total: 1920000 }], "total"),
    ).toBe(1920000);
  });

  test("uses the last row when the query returns a trend (multiple rows)", () => {
    expect(
      extractKpiNumber(
        ["day", "total"],
        [
          { day: "Mon", total: 10 },
          { day: "Tue", total: 30 },
        ],
        "total",
      ),
    ).toBe(30);
  });

  test("coerces a numeric string (pg numeric comes back as a string)", () => {
    expect(extractKpiNumber(["total"], [{ total: "1234.5" }], "total")).toBe(1234.5);
  });

  test("falls back to the first numeric column when the preferred one is non-numeric", () => {
    expect(
      extractKpiNumber(["label", "amount"], [{ label: "Q1", amount: 42 }], "label"),
    ).toBe(42);
  });

  test("returns null when there are no rows", () => {
    expect(extractKpiNumber(["total"], [], "total")).toBeNull();
  });

  test("returns null when no column holds a finite number", () => {
    expect(extractKpiNumber(["label"], [{ label: "n/a" }], "label")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// formatKpiValue — the big-number formatting per valueFormat.
// ---------------------------------------------------------------------------

describe("formatKpiValue", () => {
  test("formats currency in compact notation", () => {
    expect(formatKpiValue(1200000, "currency")).toBe("$1.2M");
  });

  test("formats a plain number in compact notation", () => {
    expect(formatKpiValue(1234, "number")).toBe("1.2K");
  });

  test("formats a percent with a trailing sign", () => {
    expect(formatKpiValue(12.34, "percent")).toBe("12.3%");
  });

  test("formats a duration (seconds) compactly across unit boundaries", () => {
    expect(formatKpiValue(45, "duration")).toBe("45s");
    expect(formatKpiValue(60, "duration")).toBe("1m"); // exact minute — no trailing seconds
    expect(formatKpiValue(3600, "duration")).toBe("1h"); // exact hour — no trailing minutes
    expect(formatKpiValue(3661, "duration")).toBe("1h 1m");
    expect(formatKpiValue(90061, "duration")).toBe("1d 1h"); // multi-day branch
  });

  test("formats a negative percent with its sign", () => {
    expect(formatKpiValue(-4.2, "percent")).toBe("-4.2%");
  });

  test("defaults to compact number formatting when no format is given", () => {
    expect(formatKpiValue(1234)).toBe("1.2K");
  });

  test("renders an em-dash for a null / non-finite value", () => {
    expect(formatKpiValue(null, "currency")).toBe("—");
    expect(formatKpiValue(Number.NaN, "number")).toBe("—");
  });
});

// ---------------------------------------------------------------------------
// hasKpiComparison / kpiComparisonSignature — the page's re-fetch keying.
// ---------------------------------------------------------------------------

describe("hasKpiComparison", () => {
  test("true only for a kpi card with a comparisonSql", () => {
    expect(
      hasKpiComparison({ chartConfig: { type: "kpi", categoryColumn: "l", valueColumns: ["v"], kpi: { comparisonSql: "SELECT 1 AS v" } } }),
    ).toBe(true);
  });
  test("false for a kpi card without a comparisonSql", () => {
    expect(
      hasKpiComparison({ chartConfig: { type: "kpi", categoryColumn: "l", valueColumns: ["v"], kpi: { valueFormat: "number" } } }),
    ).toBe(false);
  });
  test("false for a non-kpi chart card and a text card (null chartConfig)", () => {
    expect(hasKpiComparison({ chartConfig: { type: "bar", categoryColumn: "l", valueColumns: ["v"] } })).toBe(false);
    expect(hasKpiComparison({ chartConfig: null })).toBe(false);
  });
});

describe("kpiComparisonSignature", () => {
  const kpiWith = (id: string, sql: string) => ({
    id,
    chartConfig: { type: "kpi" as const, categoryColumn: "l", valueColumns: ["v"], kpi: { comparisonSql: sql } },
  });

  test("includes only KPI cards with a comparison query, keyed by id + sql", () => {
    const sig = kpiComparisonSignature([
      kpiWith("a", "SELECT 1 AS v"),
      { id: "b", chartConfig: { type: "bar", categoryColumn: "l", valueColumns: ["v"] } },
      kpiWith("c", "SELECT 2 AS v"),
    ]);
    expect(sig).toBe("a:SELECT 1 AS v|c:SELECT 2 AS v");
  });

  test("changes when a comparison query changes, but not on unrelated card churn", () => {
    const before = kpiComparisonSignature([kpiWith("a", "SELECT 1 AS v")]);
    const editedSql = kpiComparisonSignature([kpiWith("a", "SELECT 99 AS v")]);
    const unrelated = kpiComparisonSignature([
      kpiWith("a", "SELECT 1 AS v"),
      { id: "z", chartConfig: { type: "line", categoryColumn: "l", valueColumns: ["v"] } },
    ]);
    expect(editedSql).not.toBe(before);
    expect(unrelated).toBe(before); // a non-comparison card doesn't move the signature
  });
});

// ---------------------------------------------------------------------------
// <KpiCard> render — big number, delta chip, sparkline.
// ---------------------------------------------------------------------------

const kpiCard: DashboardCard = {
  id: "kpi-1",
  dashboardId: "dash-1",
  position: 0,
  title: "Revenue",
  kind: "chart",
  sql: "SELECT 'Revenue' AS label, SUM(amount) AS total FROM orders",
  chartConfig: {
    type: "kpi",
    categoryColumn: "label",
    valueColumns: ["total"],
    kpi: { valueFormat: "currency", comparisonSql: "SELECT 1 AS total", comparisonLabel: "vs. last month" },
  },
  content: null,
  cachedColumns: ["label", "total"],
  cachedRows: [{ label: "Revenue", total: 1200000 }],
  cachedAt: "2026-04-25T12:00:00Z",
  connectionGroupId: null,
  layout: { x: 0, y: 0, w: 6, h: 4 },
  createdAt: "2026-04-25T12:00:00Z",
  updatedAt: "2026-04-25T12:00:00Z",
};

describe("<KpiCard>", () => {
  afterEach(cleanup);

  test("renders the formatted headline number", () => {
    render(<KpiCard card={kpiCard} />);
    expect(screen.getByTestId("kpi-value").textContent).toBe("$1.2M");
  });

  test("renders an up delta chip when the comparison is below the current value", () => {
    render(
      <KpiCard
        card={kpiCard}
        comparison={{ columns: ["total"], rows: [{ total: 1000000 }] }}
      />,
    );
    const chip = screen.getByTestId("kpi-delta");
    expect(chip.getAttribute("data-direction")).toBe("up");
    expect(chip.textContent).toContain("20%");
    expect(screen.getByText("vs. last month")).toBeTruthy();
  });

  test("omits the delta chip when no comparison data is available", () => {
    render(<KpiCard card={kpiCard} />);
    expect(screen.queryByTestId("kpi-delta")).toBeNull();
  });

  test("omits the delta chip when the comparison query divides by zero", () => {
    render(
      <KpiCard card={kpiCard} comparison={{ columns: ["total"], rows: [{ total: 0 }] }} />,
    );
    expect(screen.queryByTestId("kpi-delta")).toBeNull();
  });

  test("renders a down delta chip when the comparison is above the current value", () => {
    render(
      <KpiCard card={kpiCard} comparison={{ columns: ["total"], rows: [{ total: 1500000 }] }} />,
    );
    const chip = screen.getByTestId("kpi-delta");
    expect(chip.getAttribute("data-direction")).toBe("down");
    expect(chip.textContent).toContain("20%");
  });

  test("renders a flat delta chip when current equals the comparison", () => {
    render(
      <KpiCard card={kpiCard} comparison={{ columns: ["total"], rows: [{ total: 1200000 }] }} />,
    );
    expect(screen.getByTestId("kpi-delta").getAttribute("data-direction")).toBe("flat");
  });

  test("renders an em-dash and no chip/sparkline when there is no cached data", () => {
    const empty: DashboardCard = { ...kpiCard, cachedColumns: null, cachedRows: null };
    render(<KpiCard card={empty} comparison={{ columns: ["total"], rows: [{ total: 1000000 }] }} />);
    expect(screen.getByTestId("kpi-value").textContent).toBe("—");
    expect(screen.queryByTestId("kpi-delta")).toBeNull();
    expect(screen.queryByTestId("kpi-sparkline")).toBeNull();
  });

  test("renders a sparkline when the primary query returns a trend (≥2 points)", () => {
    const trendCard: DashboardCard = {
      ...kpiCard,
      cachedColumns: ["day", "total"],
      cachedRows: [
        { day: "Mon", total: 10 },
        { day: "Tue", total: 20 },
        { day: "Wed", total: 15 },
      ],
      chartConfig: { type: "kpi", categoryColumn: "day", valueColumns: ["total"] },
    };
    render(<KpiCard card={trendCard} />);
    expect(screen.getByTestId("kpi-sparkline")).toBeTruthy();
  });

  test("omits the sparkline for a single-row KPI", () => {
    render(<KpiCard card={kpiCard} />);
    expect(screen.queryByTestId("kpi-sparkline")).toBeNull();
  });
});
