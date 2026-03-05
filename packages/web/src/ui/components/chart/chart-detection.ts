/* Chart detection — pure functions, zero React deps. Kept framework-agnostic for direct unit testing. */

export type ColumnType = "numeric" | "date" | "categorical" | "unknown";

export type ClassifiedColumn = {
  index: number;
  header: string;
  type: ColumnType;
  uniqueCount: number;
};

export type ChartType = "bar" | "line" | "pie";

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

  // Fallback: when all columns are numeric, treat first as category axis (often an index or bucket label)
  if (recommendations.length === 0 && numericColumns.length >= 2) {
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

export function transformData(
  rows: string[][],
  recommendation: ChartRecommendation,
): RechartsRow[] {
  const catIdx = recommendation.categoryColumn.index;
  const catHeader = recommendation.categoryColumn.header;
  const valIdxs = recommendation.valueColumns.map((c) => c.index);

  // Cap rows for bar charts with many categories
  let effectiveRows = rows;
  if (recommendation.type === "bar" && rows.length > 30) {
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
