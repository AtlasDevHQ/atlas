/* Chart detection — pure functions, zero React deps. Kept framework-agnostic for direct unit testing. */

// `MouseHandlerDataParam` is a recharts TYPE only (erased at runtime) — importing
// it here keeps this module free of any recharts runtime dependency, so the
// click extractors below stay unit-testable without evaluating recharts in jsdom.
import type { MouseHandlerDataParam } from "recharts";

type ColumnType = "numeric" | "date" | "categorical" | "unknown";

export type ClassifiedColumn = {
  index: number;
  header: string;
  type: ColumnType;
  uniqueCount: number;
};

export type ChartType = "bar" | "line" | "pie" | "area" | "stacked-bar" | "scatter";

export type ChartRecommendation = {
  type: ChartType;
  categoryColumn: ClassifiedColumn;
  valueColumns: [ClassifiedColumn, ...ClassifiedColumn[]];
  reason: string;
};

export type RechartsRow = Record<string, string | number>;

type NonChartableResult = {
  chartable: false;
  columns: ClassifiedColumn[];
};

type ChartableResult = {
  chartable: true;
  columns: ClassifiedColumn[];
  recommendations: [ChartRecommendation, ...ChartRecommendation[]];
  data: RechartsRow[];
};

export type ChartDetectionResult = NonChartableResult | ChartableResult;

/* ------------------------------------------------------------------ */
/*  Color palettes (Tailwind weights)                                   */
/* ------------------------------------------------------------------ */

export const CHART_COLORS_LIGHT = [
  "#3b82f6", // blue-500
  "#10b981", // emerald-500
  "#f59e0b", // amber-500
  "#ef4444", // red-500
  "#8b5cf6", // violet-500
  "#06b6d4", // cyan-500
  "#f97316", // orange-500
  "#ec4899", // pink-500
];

export const CHART_COLORS_DARK = [
  "#60a5fa", // blue-400
  "#34d399", // emerald-400
  "#fbbf24", // amber-400
  "#f87171", // red-400
  "#a78bfa", // violet-400
  "#22d3ee", // cyan-400
  "#fb923c", // orange-400
  "#f472b6", // pink-400
];

/* ------------------------------------------------------------------ */
/*  Goal lines / thresholds (#3208)                                     */
/*  Pure: resolve a card's raw thresholds into render-ready reference-   */
/*  line specs. The recharts <ReferenceLine> mapping lives in            */
/*  result-chart.tsx; keeping this here makes it unit-testable without   */
/*  booting recharts in jsdom (same split as the rest of this module).   */
/* ------------------------------------------------------------------ */

/** Default goal-line stroke when a threshold sets no explicit colour. Amber
 *  reads as a "target" marker and, dashed, stays distinct from the gridlines. */
export const THRESHOLD_LINE_LIGHT = "#d97706"; // amber-600
export const THRESHOLD_LINE_DARK = "#fbbf24"; // amber-400

/**
 * Max goal lines rendered on a single chart — keeps it readable. A deliberately
 * duplicated literal, kept in lockstep with `DASHBOARD_THRESHOLDS_MAX` in
 * `@useatlas/schemas` (the persist-time bound) rather than imported, so this
 * pure module stays runtime-dependency-free. Re-capping here is defence-in-depth
 * over loosely-parsed cached config, which `rowToCard` JSON-parses without
 * re-running the Zod schema.
 */
export const MAX_THRESHOLD_LINES = 5;

/**
 * Render-side CSS-colour sanity check. Structural mirror of `CSS_COLOR_RE` in
 * `@useatlas/schemas` (the persist-time gate) — re-checked here because
 * `rowToCard` JSON-parses cached `chart_config` WITHOUT re-running Zod, so a
 * structurally-malformed colour from an older schema or a direct DB edit would
 * otherwise reach the SVG `stroke` and render an INVISIBLE line. It accepts a
 * hex / `rgb()`-family / bare-alphabetic colour; it does NOT validate a named
 * colour against the CSS keyword set, so a typo'd-but-well-formed name (`bleu`)
 * still passes — same behaviour as the persist gate, so the two stay symmetric.
 */
const THRESHOLD_COLOR_RE = /^(#[0-9a-fA-F]{3,8}|(?:rgb|rgba|hsl|hsla)\([\d\s.,%/]+\)|[a-zA-Z]+)$/;

/** Structural mirror of `DashboardThreshold` (`@useatlas/types`) — the LOOSE,
 *  pre-validation wire shape (this data arrives via the un-validated `rowToCard`
 *  read path, so `resolveThresholdLines` re-asserts the schema's invariants).
 *  Re-declared locally so this pure module stays free of cross-package imports,
 *  the same approach the rest of chart-detection takes for its shapes. */
export type ThresholdInput = { value: number; color?: string; label?: string };

/** Render-ready goal line: a Y position, a resolved stroke, and a trimmed
 *  label (or null when there's nothing to caption). */
export type ThresholdLine = { y: number; stroke: string; label: string | null };

/**
 * Resolve a card's raw thresholds into reference-line specs: drop non-finite
 * values, cap the count, fall back to a theme stroke for an absent OR
 * structurally-malformed colour, and trim the label. Returns `[]` for an absent
 * / empty list so a chart with no thresholds renders exactly as before (#3208
 * back-compat). Every output field is resolved, so the renderer is a plain map.
 */
export function resolveThresholdLines(
  thresholds: readonly ThresholdInput[] | undefined,
  dark: boolean,
): ThresholdLine[] {
  if (!thresholds || thresholds.length === 0) return [];
  const fallback = dark ? THRESHOLD_LINE_DARK : THRESHOLD_LINE_LIGHT;
  return thresholds
    .filter((t) => Number.isFinite(t.value))
    .slice(0, MAX_THRESHOLD_LINES)
    .map((t) => {
      const color = t.color?.trim();
      const label = t.label?.trim();
      return {
        y: t.value,
        stroke: color && THRESHOLD_COLOR_RE.test(color) ? color : fallback,
        label: label ? label : null,
      };
    });
}

/* ------------------------------------------------------------------ */
/*  Column classification                                               */
/* ------------------------------------------------------------------ */

const DATE_HEADER_HINTS = /^(date|month|year|quarter|week|day|period|time|timestamp)$/i;
const CATEGORICAL_HEADER_HINTS = /^(name|type|category|status|region|country|industry|department|plan|tier|segment|group|label|source|channel)$/i;
const SKIP_HEADER_HINTS = /^(id|uuid|_id|pk|key)$/i;

const ISO_DATE_RE = /^\d{4}-\d{2}/;
const MONTH_NAME_RE = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i;
const YEAR_ONLY_RE = /^(19|20)\d{2}$/;
const QUARTER_RE = /^Q[1-4]\s*\d{4}$/i;

export function classifyColumn(header: string, values: string[]): ColumnType {
  const nonEmpty = values.filter((v) => v !== "" && v != null);
  if (nonEmpty.length === 0) return "unknown";

  // Header hint: skip ID-like columns
  if (SKIP_HEADER_HINTS.test(header)) return "unknown";

  // Numeric check: >80% parse as finite numbers (date check takes priority for overlapping values)
  const numericCount = nonEmpty.filter((v) => {
    const n = Number(v.replace(/,/g, ""));
    return isFinite(n);
  }).length;
  const numericRatio = numericCount / nonEmpty.length;

  // Date check: >70% match date patterns (>30% when header hints match)
  const dateCount = nonEmpty.filter(
    (v) => ISO_DATE_RE.test(v) || MONTH_NAME_RE.test(v) || YEAR_ONLY_RE.test(v) || QUARTER_RE.test(v),
  ).length;
  const dateRatio = dateCount / nonEmpty.length;

  // Header hint tiebreaker: if header matches date keywords...
  //   (a) ...and at least some values look date-like, trust the header
  //   (b) ...and values aren't overwhelmingly numeric (catches year-only values)
  if (DATE_HEADER_HINTS.test(header) && dateRatio > 0.3) return "date";
  if (DATE_HEADER_HINTS.test(header) && numericRatio < 0.9) return "date";

  if (dateRatio > 0.7) return "date";
  if (numericRatio > 0.8) return "numeric";

  // Categorical header hint
  if (CATEGORICAL_HEADER_HINTS.test(header)) return "categorical";

  // Categorical fallback: text values with <50 unique entries (higher cardinality suggests free-text or IDs)
  const unique = new Set(nonEmpty);
  if (unique.size < 50) return "categorical";

  return "unknown";
}

/* ------------------------------------------------------------------ */
/*  Click-to-drilldown value extractors (#3212)                         */
/* ------------------------------------------------------------------ */

/**
 * Pull the clicked category-axis value out of a Recharts categorical chart
 * click (bar / line / area). `activeLabel` is the category/domain value at the
 * clicked tick; `null` means the click landed off any category (empty plot
 * area). Pure — the recharts click itself is not reproducible in jsdom, so this
 * is the unit-tested seam.
 */
export function categoryFromChartClick(
  state: MouseHandlerDataParam | null | undefined,
): string | null {
  const label = state?.activeLabel;
  if (label == null || label === "") return null;
  return String(label);
}

/**
 * Pull the clicked slice's category value out of a Recharts Pie click. The
 * sector carries the original {@link RechartsRow} on `payload`, keyed by header,
 * so we read the category column off it. Pure + unit-tested.
 */
export function categoryFromPieClick(
  data: { payload?: unknown } | null | undefined,
  categoryKey: string,
): string | null {
  const payload = (data?.payload ?? null) as Record<string, unknown> | null;
  const value = payload?.[categoryKey];
  if (value == null || value === "") return null;
  return String(value);
}

/* ------------------------------------------------------------------ */
/*  Chart recommendation engine                                         */
/* ------------------------------------------------------------------ */

export function detectCharts(headers: string[], rows: string[][]): ChartDetectionResult {
  if (headers.length === 0 || rows.length < 2) {
    return { chartable: false, columns: [] };
  }

  // Deduplicate headers so chart dataKey matches transformed data keys
  const seen = new Map<string, number>();
  const dedupedHeaders = headers.map((h) => {
    const count = seen.get(h) ?? 0;
    seen.set(h, count + 1);
    return count > 0 ? `${h}_${count + 1}` : h;
  });

  const columns: ClassifiedColumn[] = dedupedHeaders.map((header, index) => {
    const values = rows.map((r) => r[index] ?? "");
    const type = classifyColumn(header, values);
    const uniqueCount = new Set(values.filter((v) => v !== "")).size;
    return { index, header, type, uniqueCount };
  });

  const dateColumns = columns.filter((c) => c.type === "date");
  const numericColumns = columns.filter((c) => c.type === "numeric");
  const categoricalColumns = columns.filter((c) => c.type === "categorical");

  if (numericColumns.length === 0) {
    return { chartable: false, columns };
  }

  const recommendations: ChartRecommendation[] = [];

  // Line: date + numeric (time-series, highest priority)
  if (dateColumns.length >= 1 && numericColumns.length >= 1) {
    recommendations.push({
      type: "line",
      categoryColumn: dateColumns[0],
      valueColumns: numericColumns as [ClassifiedColumn, ...ClassifiedColumn[]],
      reason: `Time-series: ${dateColumns[0].header} vs ${numericColumns.map((c) => c.header).join(", ")}`,
    });
  }

  // Area: alternative to line for date + numeric (volume/magnitude over time)
  if (dateColumns.length >= 1 && numericColumns.length >= 1) {
    recommendations.push({
      type: "area",
      categoryColumn: dateColumns[0],
      valueColumns: numericColumns as [ClassifiedColumn, ...ClassifiedColumn[]],
      reason: `Volume over time: ${numericColumns.map((c) => c.header).join(", ")} by ${dateColumns[0].header}`,
    });
  }

  // Stacked bar: categorical + multiple numeric columns (part-to-whole comparison)
  if (categoricalColumns.length >= 1 && numericColumns.length >= 2) {
    recommendations.push({
      type: "stacked-bar",
      categoryColumn: categoricalColumns[0],
      valueColumns: numericColumns as [ClassifiedColumn, ...ClassifiedColumn[]],
      reason: `Stacked: ${numericColumns.map((c) => c.header).join(", ")} by ${categoricalColumns[0].header}`,
    });
  }

  // Bar: categorical + numeric
  if (categoricalColumns.length >= 1 && numericColumns.length >= 1) {
    recommendations.push({
      type: "bar",
      categoryColumn: categoricalColumns[0],
      valueColumns: numericColumns as [ClassifiedColumn, ...ClassifiedColumn[]],
      reason: `Comparison: ${numericColumns.map((c) => c.header).join(", ")} by ${categoricalColumns[0].header}`,
    });
  }

  // Pie: first categorical column (2-7 unique values) + first numeric column
  if (categoricalColumns.length >= 1 && numericColumns.length >= 1) {
    const cat = categoricalColumns[0];
    if (cat.uniqueCount >= 2 && cat.uniqueCount <= 7) {
      recommendations.push({
        type: "pie",
        categoryColumn: cat,
        valueColumns: [numericColumns[0]],
        reason: `Distribution: ${numericColumns[0].header} by ${cat.header}`,
      });
    }
  }

  // Scatter: 2+ numeric columns (correlation analysis)
  if (numericColumns.length >= 2) {
    const [xCol, yCol, ...rest] = numericColumns;
    const scatterValues = rest.length > 0
      ? [yCol, ...rest] as [ClassifiedColumn, ...ClassifiedColumn[]]
      : [yCol] as [ClassifiedColumn, ...ClassifiedColumn[]];
    recommendations.push({
      type: "scatter",
      categoryColumn: xCol,
      valueColumns: scatterValues,
      reason: `Correlation: ${xCol.header} vs ${yCol.header}${rest.length > 0 ? ` (size: ${rest[0].header})` : ""}`,
    });
  }

  // Fallback: when all columns are numeric, treat first as category axis (often an index or bucket label)
  if (!recommendations.some((r) => r.type === "bar") && numericColumns.length >= 2) {
    const first = columns[0];
    const rest = numericColumns.filter((c) => c.index !== first.index);
    if (rest.length >= 1) {
      recommendations.push({
        type: "bar",
        categoryColumn: first,
        valueColumns: rest as [ClassifiedColumn, ...ClassifiedColumn[]],
        reason: `Fallback: ${rest.map((c) => c.header).join(", ")} by ${first.header}`,
      });
    }
  }

  // Also allow bar for date columns (as a secondary option after line)
  if (dateColumns.length >= 1 && numericColumns.length >= 1 && !recommendations.some((r) => r.type === "bar")) {
    recommendations.push({
      type: "bar",
      categoryColumn: dateColumns[0],
      valueColumns: numericColumns as [ClassifiedColumn, ...ClassifiedColumn[]],
      reason: `Comparison: ${numericColumns.map((c) => c.header).join(", ")} by ${dateColumns[0].header}`,
    });
  }

  if (recommendations.length === 0) {
    return { chartable: false, columns };
  }

  const data = transformData(rows, recommendations[0]);

  return {
    chartable: true,
    columns,
    recommendations: recommendations as [ChartRecommendation, ...ChartRecommendation[]],
    data,
  };
}

/* ------------------------------------------------------------------ */
/*  Data transform                                                      */
/* ------------------------------------------------------------------ */

function parseNumericValue(raw: string): number {
  const cleaned = raw.replace(/[$%,\s]/g, "");
  if (cleaned === "" || cleaned === "-") return 0;
  const num = Number(cleaned);
  return isFinite(num) ? num : 0;
}

function isFiniteNumeric(raw: string): boolean {
  const cleaned = raw.replace(/[$%,\s]/g, "");
  if (cleaned === "" || cleaned === "-") return false;
  return isFinite(Number(cleaned));
}

export function transformData(
  rows: string[][],
  recommendation: ChartRecommendation,
): RechartsRow[] {
  const catIdx = recommendation.categoryColumn.index;
  const catHeader = recommendation.categoryColumn.header;
  const valIdxs = recommendation.valueColumns.map((c) => c.index);

  // Scatter: both axes are numeric — categoryColumn is x, first valueColumn is y, optional z for size
  // Filter out rows where x or y are non-numeric to avoid misleading zero-origin clusters
  if (recommendation.type === "scatter") {
    const yIdx = recommendation.valueColumns[0].index;
    return rows.flatMap((row) => {
      const rawX = row[catIdx] ?? "";
      const rawY = row[yIdx] ?? "";
      if (!isFiniteNumeric(rawX) || !isFiniteNumeric(rawY)) return [];
      const record: RechartsRow = {};
      record[catHeader] = parseNumericValue(rawX);
      for (const vc of recommendation.valueColumns) {
        record[vc.header] = parseNumericValue(row[vc.index] ?? "0");
      }
      return [record];
    });
  }

  // Cap rows for bar/stacked-bar charts with many categories
  let effectiveRows = rows;
  if ((recommendation.type === "bar" || recommendation.type === "stacked-bar") && rows.length > 30) {
    // Sort by first value column descending, take top 20
    const valIdx = valIdxs[0];
    effectiveRows = [...rows]
      .sort((a, b) => {
        const av = parseNumericValue(a[valIdx] ?? "0");
        const bv = parseNumericValue(b[valIdx] ?? "0");
        return bv - av;
      })
      .slice(0, 20);
  }

  return effectiveRows.map((row) => {
    const record: RechartsRow = {};
    record[catHeader] = row[catIdx] ?? "";
    for (const vc of recommendation.valueColumns) {
      record[vc.header] = parseNumericValue(row[vc.index] ?? "0");
    }
    return record;
  });
}
