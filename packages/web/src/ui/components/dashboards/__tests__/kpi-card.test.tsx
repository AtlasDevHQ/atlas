import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import type { DashboardCard } from "@/ui/lib/types";
import {
  KpiCard,
  computeKpiDelta,
  deltaTone,
  extractKpiNumber,
  formatKpiValue,
  hasKpiComparison,
  kpiComparisonSignature,
  sparklineGeometry,
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
    expect(formatKpiValue(Number.POSITIVE_INFINITY, "currency")).toBe("—");
  });

  // #3207 — formatter hardening: negative + very-large + zero across formats.
  test("formats a negative currency in compact notation with its sign", () => {
    expect(formatKpiValue(-1200000, "currency")).toBe("-$1.2M");
  });

  test("formats a negative compact number with its sign", () => {
    expect(formatKpiValue(-1234, "number")).toBe("-1.2K");
  });

  test("compacts billions", () => {
    expect(formatKpiValue(2_400_000_000, "number")).toBe("2.4B");
    expect(formatKpiValue(2_400_000_000, "currency")).toBe("$2.4B");
  });

  test("formats zero cleanly across formats (no NaN / divide artifacts)", () => {
    expect(formatKpiValue(0, "number")).toBe("0");
    expect(formatKpiValue(0, "currency")).toBe("$0");
    expect(formatKpiValue(0, "percent")).toBe("0%");
    expect(formatKpiValue(0, "duration")).toBe("0s");
  });
});

// ---------------------------------------------------------------------------
// deltaTone (#3207) — maps a delta direction to a colour tone, honouring the
// `inverse` (lower-is-better) flag. The arrow still follows direction; only the
// colour tone flips.
// ---------------------------------------------------------------------------

describe("deltaTone", () => {
  test("higher-is-better: up is positive, down is negative", () => {
    expect(deltaTone("up", false)).toBe("positive");
    expect(deltaTone("down", false)).toBe("negative");
  });

  test("lower-is-better (inverse): down is positive, up is negative", () => {
    expect(deltaTone("down", true)).toBe("positive");
    expect(deltaTone("up", true)).toBe("negative");
  });

  test("flat is always neutral regardless of inverse", () => {
    expect(deltaTone("flat", false)).toBe("neutral");
    expect(deltaTone("flat", true)).toBe("neutral");
  });

  test("defaults to higher-is-better when inverse is omitted", () => {
    expect(deltaTone("up")).toBe("positive");
    expect(deltaTone("down")).toBe("negative");
  });
});

// ---------------------------------------------------------------------------
// sparklineGeometry (#3207) — the pure geometry behind the sparkline. A flat
// series must sit at the vertical centre (not glued to an edge), and a series
// with <2 finite points has no line to draw.
// ---------------------------------------------------------------------------

describe("sparklineGeometry", () => {
  test("returns null for fewer than two finite points", () => {
    expect(sparklineGeometry([])).toBeNull();
    expect(sparklineGeometry([5])).toBeNull();
    expect(sparklineGeometry([Number.NaN, Number.POSITIVE_INFINITY])).toBeNull();
  });

  test("centres a flat series vertically instead of pinning it to an edge", () => {
    const points = sparklineGeometry([10, 10, 10], 100, 28);
    expect(points).not.toBeNull();
    // pad = 2 → centre y = 28 - 2 - 0.5 * (28 - 4) = 14.
    for (const pair of points!.split(" ")) {
      expect(pair.split(",")[1]).toBe("14.0");
    }
  });

  test("spans the full width and reflects the latest value at the right edge", () => {
    const points = sparklineGeometry([0, 5, 10], 100, 28)!.split(" ");
    // Last x is the full width; ascending series → last point is the highest
    // (smallest y, near the top padding).
    const [lastX, lastY] = points[points.length - 1].split(",").map(Number);
    expect(lastX).toBeCloseTo(100, 5);
    expect(lastY).toBeCloseTo(2, 5);
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

  // #3207 — an autoComparison card produces a delta too, even without comparisonSql.
  test("true for a kpi card with autoComparison and no comparisonSql", () => {
    expect(
      hasKpiComparison({ chartConfig: { type: "kpi", categoryColumn: "l", valueColumns: ["v"], kpi: { autoComparison: true } } }),
    ).toBe(true);
  });

  test("false for a kpi card with autoComparison explicitly false", () => {
    expect(
      hasKpiComparison({ chartConfig: { type: "kpi", categoryColumn: "l", valueColumns: ["v"], kpi: { autoComparison: false, inverse: true } } }),
    ).toBe(false);
  });
});

describe("kpiComparisonSignature", () => {
  const kpiWith = (id: string, sql: string) => ({
    id,
    chartConfig: { type: "kpi" as const, categoryColumn: "l", valueColumns: ["v"], kpi: { comparisonSql: sql } },
  });

  test("includes only KPI cards with a comparison query", () => {
    const withChart = kpiComparisonSignature([
      kpiWith("a", "SELECT 1 AS v"),
      { id: "b", chartConfig: { type: "bar", categoryColumn: "l", valueColumns: ["v"] } },
      kpiWith("c", "SELECT 2 AS v"),
    ]);
    const onlyKpi = kpiComparisonSignature([kpiWith("a", "SELECT 1 AS v"), kpiWith("c", "SELECT 2 AS v")]);
    // The non-comparison chart card contributes nothing.
    expect(withChart).toBe(onlyKpi);
  });

  test("is order-independent (a card reorder must not refetch)", () => {
    const a = kpiComparisonSignature([kpiWith("a", "SELECT 1 AS v"), kpiWith("c", "SELECT 2 AS v")]);
    const reordered = kpiComparisonSignature([kpiWith("c", "SELECT 2 AS v"), kpiWith("a", "SELECT 1 AS v")]);
    expect(reordered).toBe(a);
  });

  test("is collision-safe when SQL contains delimiter characters (:, |)", () => {
    // A naive `id:sql` join with `|` would conflate these two distinct sets.
    const s1 = kpiComparisonSignature([kpiWith("a", "SELECT 1"), kpiWith("b|x", "WHERE t > 0")]);
    const s2 = kpiComparisonSignature([kpiWith("a", "SELECT 1|b|x:WHERE t > 0"), kpiWith("", "")]);
    expect(s1).not.toBe(s2);
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

  // #3207 — autoComparison cards belong in the signature; toggling the
  // client-only `inverse` colour must NOT move it (it doesn't change the fetch).
  const kpiAuto = (id: string, kpi: Record<string, unknown>) => ({
    id,
    chartConfig: { type: "kpi" as const, categoryColumn: "l", valueColumns: ["v"], kpi },
  });

  test("includes an autoComparison card", () => {
    const withAuto = kpiComparisonSignature([kpiAuto("a", { autoComparison: true })]);
    const empty = kpiComparisonSignature([
      { id: "a", chartConfig: { type: "kpi", categoryColumn: "l", valueColumns: ["v"], kpi: { valueFormat: "number" } } },
    ]);
    expect(withAuto).not.toBe(empty);
  });

  test("does not move when only the inverse colour flips", () => {
    const off = kpiComparisonSignature([kpiAuto("a", { autoComparison: true, inverse: false })]);
    const on = kpiComparisonSignature([kpiAuto("a", { autoComparison: true, inverse: true })]);
    expect(on).toBe(off);
  });

  test("moves when the comparison date-param pair changes", () => {
    const a = kpiComparisonSignature([kpiAuto("a", { autoComparison: true })]);
    const b = kpiComparisonSignature([kpiAuto("a", { autoComparison: true, comparisonDateParams: { from: "s", to: "e" } })]);
    expect(b).not.toBe(a);
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

  // #3207 — colour tone. Direction (the arrow) reflects the actual change; the
  // tone (colour) is what the `inverse` flag flips.
  test("a default (higher-is-better) increase reads as a positive tone", () => {
    render(
      <KpiCard card={kpiCard} comparison={{ columns: ["total"], rows: [{ total: 1000000 }] }} />,
    );
    const chip = screen.getByTestId("kpi-delta");
    expect(chip.getAttribute("data-direction")).toBe("up");
    expect(chip.getAttribute("data-tone")).toBe("positive");
  });

  test("a lower-is-better (inverse) DECREASE reads as a positive tone, arrow still down", () => {
    const churnCard: DashboardCard = {
      ...kpiCard,
      chartConfig: {
        type: "kpi",
        categoryColumn: "label",
        valueColumns: ["total"],
        kpi: { valueFormat: "percent", autoComparison: true, inverse: true },
      },
    };
    render(
      <KpiCard card={churnCard} comparison={{ columns: ["total"], rows: [{ total: 1500000 }] }} />,
    );
    const chip = screen.getByTestId("kpi-delta");
    // current 1.2M < prior 1.5M → direction down, but inverse → positive tone.
    expect(chip.getAttribute("data-direction")).toBe("down");
    expect(chip.getAttribute("data-tone")).toBe("positive");
  });

  test("a lower-is-better (inverse) INCREASE reads as a negative tone", () => {
    const churnCard: DashboardCard = {
      ...kpiCard,
      chartConfig: {
        type: "kpi",
        categoryColumn: "label",
        valueColumns: ["total"],
        kpi: { valueFormat: "percent", autoComparison: true, inverse: true },
      },
    };
    render(
      <KpiCard card={churnCard} comparison={{ columns: ["total"], rows: [{ total: 1000000 }] }} />,
    );
    const chip = screen.getByTestId("kpi-delta");
    expect(chip.getAttribute("data-direction")).toBe("up");
    expect(chip.getAttribute("data-tone")).toBe("negative");
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
