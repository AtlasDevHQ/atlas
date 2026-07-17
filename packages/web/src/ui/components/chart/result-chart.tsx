"use client";

import { useMemo, useId, useState } from "react";
import { ErrorBoundary } from "../error-boundary";
import { categoryMatchesSelection } from "../../lib/helpers";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  LineChart,
  Line,
  AreaChart,
  Area,
  ScatterChart,
  Scatter,
  ZAxis,
  PieChart,
  Pie,
  Cell,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  ReferenceLine,
} from "recharts";
import type { MouseHandlerDataParam } from "recharts";
import {
  detectCharts,
  transformData,
  categoryFromChartClick,
  categoryFromPieClick,
  pickChartRecommendation,
  resolveThresholdLines,
  resolveAnnotationLines,
  CHART_COLORS_LIGHT,
  CHART_COLORS_DARK,
  type ChartRecommendation,
  type ChartType,
  type RechartsRow,
  type ChartDetectionResult,
  type ThresholdInput,
  type AnnotationInput,
} from "./chart-detection";

/* ------------------------------------------------------------------ */
/*  Click-to-drilldown (#3212)                                          */
/*  Pure value extractors live in chart-detection.ts (zero React deps,  */
/*  unit-testable without importing recharts into jsdom).               */
/* ------------------------------------------------------------------ */

/** Build a categorical-chart `onClick` that forwards the clicked category value
 *  plus the chart's category-axis column (`categoryKey`, the detected header),
 *  or `undefined` when drilldown is off (so recharts attaches no handler). The
 *  consumer gates on `categoryKey` so a parameter is only ever set from the
 *  card's configured drilldown column (#3212). */
function chartClickHandler(
  onCategoryClick: ((value: string, categoryKey: string) => void) | undefined,
  categoryKey: string,
): ((state: MouseHandlerDataParam) => void) | undefined {
  if (!onCategoryClick) return undefined;
  return (state) => {
    const value = categoryFromChartClick(state);
    if (value != null) onCategoryClick(value, categoryKey);
  };
}

/** Pointer cursor on the chart wrapper signals a card is drillable. */
function drilldownCursor(
  onCategoryClick: ((value: string, categoryKey: string) => void) | undefined,
): React.CSSProperties | undefined {
  return onCategoryClick ? { cursor: "pointer" } : undefined;
}

/**
 * #3213 — cross-filter "selected" state. When a category is the active filter,
 * its bar / slice stays solid and the rest dim, so the clicked element reads as
 * selected (re-clicking it deselects, via the page's toggle). Returns the per-
 * cell `fillOpacity`. The caller only renders `<Cell>` children when a selection
 * is active, so the default (unselected) render is untouched. Matching is
 * date-aware (#3219 Codex review) so a timestamp axis still highlights under a
 * normalized `YYYY-MM-DD` date filter.
 */
function selectedFillOpacity(category: unknown, selectedCategory: string): number {
  return categoryMatchesSelection(category, selectedCategory) ? 1 : 0.25;
}

/**
 * #3219 (Codex review) — should the "selected" dim/highlight paint on THIS axis?
 * `ResultChart` re-detects its category axis from the data, which can diverge
 * from the card's configured drilldown column. The active filter value belongs
 * to that configured column, so we only style when the value is actually present
 * on the rendered axis — otherwise a filter on `region` could dim unrelated
 * `segment` bars. This mirrors the click handler's `categoryKey === categoryColumn`
 * gate without threading the configured column through every view, and also drops
 * the dimming entirely when the selected value was filtered out of this card's
 * current data (nothing to highlight).
 */
function selectionOnAxis(
  data: RechartsRow[],
  catKey: string,
  selectedCategory: string | undefined,
): selectedCategory is string {
  return selectedCategory != null && data.some((d) => categoryMatchesSelection(d[catKey], selectedCategory));
}

/* ------------------------------------------------------------------ */
/*  Goal lines / thresholds (#3208)                                     */
/* ------------------------------------------------------------------ */

/**
 * Build the horizontal goal-line `<ReferenceLine>`s for a cartesian (Y-axis)
 * chart. Returns an array of `<ReferenceLine>` elements rendered inline as
 * children of the chart — the same pattern as the `<Bar>` / `<Line>` series maps
 * in each view. Returns `[]` when there are no thresholds, so a card without them
 * renders exactly as today.
 *
 * `ifOverflow="extendDomain"` so a target beyond the current data range (the
 * "Revenue below $1M target" case) still shows — the axis stretches to fit it.
 *
 * Factored as a standalone helper so a future annotations / reference-line
 * feature (#3209) can add a sibling for vertical lines without reworking each
 * view.
 */
function thresholdLineElements(
  thresholds: ThresholdInput[] | undefined,
  dark: boolean,
): React.ReactElement[] {
  return resolveThresholdLines(thresholds, dark).map((line, i) => (
    <ReferenceLine
      key={`threshold-${i}`}
      y={line.y}
      stroke={line.stroke}
      strokeDasharray="6 4"
      strokeWidth={1.5}
      ifOverflow="extendDomain"
      label={
        line.label
          ? { value: line.label, position: "insideTopRight", fill: line.stroke, fontSize: 11 }
          : undefined
      }
    />
  ));
}

/* ------------------------------------------------------------------ */
/*  Event annotations (#3209)                                          */
/* ------------------------------------------------------------------ */

/**
 * Build the VERTICAL event-marker `<ReferenceLine>`s for a time-series chart —
 * the vertical sibling of {@link thresholdLineElements}. Each marker positions
 * on the category (X) axis at the annotation's `x` value (the same string the
 * axis renders). Returns `[]` when there are no annotations, so a card without
 * them renders exactly as today.
 *
 * Unlike thresholds, there is NO `ifOverflow="extendDomain"`: an annotation
 * whose `x` matches no rendered category is silently dropped by recharts (the
 * default category-axis behaviour) rather than stretching the axis to fit a
 * phantom point — a marker for an event outside the chart's window simply
 * doesn't draw, which is the graceful no-op the issue calls for.
 *
 * Only mounted by the line / area views — bar / pie / scatter ignore
 * annotations (a categorical or numeric X axis has no time context to mark).
 */
function annotationLineElements(
  annotations: AnnotationInput[] | undefined,
  dark: boolean,
): React.ReactElement[] {
  return resolveAnnotationLines(annotations, dark).map((line, i) => (
    <ReferenceLine
      key={`annotation-${i}`}
      x={line.x}
      stroke={line.stroke}
      strokeDasharray="4 3"
      strokeWidth={1.5}
      label={
        line.label
          ? { value: line.label, position: "insideTopRight", fill: line.stroke, fontSize: 11 }
          : undefined
      }
    />
  ));
}

/* ------------------------------------------------------------------ */
/*  Theme helpers                                                       */
/* ------------------------------------------------------------------ */

function getColors(dark: boolean) {
  return dark ? CHART_COLORS_DARK : CHART_COLORS_LIGHT;
}

function themeTokens(dark: boolean) {
  return {
    grid: dark ? "#3f3f46" : "#e4e4e7",
    axis: dark ? "#a1a1aa" : "#71717a",
    tooltipBg: dark ? "#18181b" : "#ffffff",
    tooltipBorder: dark ? "#3f3f46" : "#e4e4e7",
    tooltipText: dark ? "#e4e4e7" : "#27272a",
    legendText: dark ? "#a1a1aa" : "#71717a",
  };
}

/* ------------------------------------------------------------------ */
/*  Number formatter for axis / tooltip                                 */
/* ------------------------------------------------------------------ */

function formatNumber(value: unknown): string {
  const num = Number(value);
  if (!isFinite(num)) return String((value as string | number | boolean | null | undefined) ?? "");
  if (Math.abs(num) >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`;
  if (Math.abs(num) >= 1_000) return `${(num / 1_000).toFixed(1)}K`;
  return Number.isInteger(num) ? num.toLocaleString() : num.toFixed(2);
}

function truncateLabel(label: unknown, maxLen = 12): string {
  const str = String((label as string | number | boolean | null | undefined) ?? "");
  return str.length > maxLen ? str.slice(0, maxLen) + "\u2026" : str;
}

/* ------------------------------------------------------------------ */
/*  Tooltip                                                             */
/* ------------------------------------------------------------------ */

const TOOLTIP_LABEL_STYLE = { fontWeight: 600, marginBottom: 4 } as const;

const tooltipStyleCache = new Map<boolean, React.CSSProperties>();
function getTooltipStyle(dark: boolean): React.CSSProperties {
  let style = tooltipStyleCache.get(dark);
  if (!style) {
    const t = themeTokens(dark);
    style = {
      background: t.tooltipBg,
      border: `1px solid ${t.tooltipBorder}`,
      borderRadius: 6,
      padding: "8px 12px",
      fontSize: 12,
      color: t.tooltipText,
    };
    tooltipStyleCache.set(dark, style);
  }
  return style;
}

function ChartTooltip({ active, payload, label, dark }: {
  active?: boolean;
  payload?: Array<{ name: string; value: number; color: string }>;
  label?: string;
  dark: boolean;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div style={getTooltipStyle(dark)}>
      {label && <p style={TOOLTIP_LABEL_STYLE}>{label}</p>}
      {payload.map((entry, i) => (
        <p key={i} style={{ color: entry.color }}>
          {entry.name}: {typeof entry.value === "number" ? formatNumber(entry.value) : entry.value}
        </p>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Sub-chart components                                                */
/* ------------------------------------------------------------------ */

function BarChartView({
  data,
  rec,
  dark,
  onCategoryClick,
  selectedCategory,
  thresholds,
}: {
  data: RechartsRow[];
  rec: ChartRecommendation;
  dark: boolean;
  onCategoryClick?: (value: string, categoryKey: string) => void;
  selectedCategory?: string;
  thresholds?: ThresholdInput[];
}) {
  const colors = getColors(dark);
  const t = themeTokens(dark);
  const catKey = rec.categoryColumn.header;
  const valKeys = rec.valueColumns.map((c) => c.header);
  const onClick = chartClickHandler(onCategoryClick, catKey);

  return (
    <div className="aspect-[4/3] sm:aspect-[16/9]" style={drilldownCursor(onCategoryClick)}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 40, left: 8 }} onClick={onClick}>
          <CartesianGrid strokeDasharray="3 3" stroke={t.grid} />
          <XAxis
            dataKey={catKey}
            tick={{ fill: t.axis, fontSize: 11 }}
            tickFormatter={(v: string) => truncateLabel(v)}
            angle={-45}
            textAnchor="end"
            height={60}
            interval="preserveStartEnd"
          />
          <YAxis tick={{ fill: t.axis, fontSize: 11 }} tickFormatter={formatNumber} />
          <Tooltip content={<ChartTooltip dark={dark} />} />
          {valKeys.length > 1 && (
            <Legend wrapperStyle={{ fontSize: 12, color: t.legendText }} />
          )}
          {valKeys.map((key, i) => (
            <Bar
              key={key}
              dataKey={key}
              fill={colors[i % colors.length]}
              radius={[4, 4, 0, 0]}
            >
              {/* #3213 — dim non-selected categories when a cross-filter is active.
                  Gated on `selectionOnAxis` (#3219) so a divergent detected axis
                  isn't dimmed by a filter that belongs to another column. */}
              {selectionOnAxis(data, catKey, selectedCategory) &&
                data.map((d, ci) => (
                  <Cell key={ci} fillOpacity={selectedFillOpacity(d[catKey], selectedCategory)} />
                ))}
            </Bar>
          ))}
          {thresholdLineElements(thresholds, dark)}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function LineChartView({
  data,
  rec,
  dark,
  onCategoryClick,
  thresholds,
  annotations,
}: {
  data: RechartsRow[];
  rec: ChartRecommendation;
  dark: boolean;
  onCategoryClick?: (value: string, categoryKey: string) => void;
  thresholds?: ThresholdInput[];
  annotations?: AnnotationInput[];
}) {
  const colors = getColors(dark);
  const t = themeTokens(dark);
  const catKey = rec.categoryColumn.header;
  const valKeys = rec.valueColumns.map((c) => c.header);
  const onClick = chartClickHandler(onCategoryClick, catKey);

  return (
    <div className="aspect-[4/3] sm:aspect-[16/9]" style={drilldownCursor(onCategoryClick)}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 8, bottom: 40, left: 8 }} onClick={onClick}>
          <CartesianGrid strokeDasharray="3 3" stroke={t.grid} />
          <XAxis
            dataKey={catKey}
            tick={{ fill: t.axis, fontSize: 11 }}
            tickFormatter={(v: string) => truncateLabel(v)}
            angle={-45}
            textAnchor="end"
            height={60}
            interval="preserveStartEnd"
          />
          <YAxis tick={{ fill: t.axis, fontSize: 11 }} tickFormatter={formatNumber} />
          <Tooltip content={<ChartTooltip dark={dark} />} />
          {valKeys.length > 1 && (
            <Legend wrapperStyle={{ fontSize: 12, color: t.legendText }} />
          )}
          {valKeys.map((key, i) => (
            <Line
              key={key}
              type="monotone"
              dataKey={key}
              stroke={colors[i % colors.length]}
              strokeWidth={2}
              dot={{ r: 3, fill: colors[i % colors.length] }}
              activeDot={{ r: 5 }}
            />
          ))}
          {thresholdLineElements(thresholds, dark)}
          {annotationLineElements(annotations, dark)}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function PieChartView({
  data,
  rec,
  dark,
  onCategoryClick,
  selectedCategory,
}: {
  data: RechartsRow[];
  rec: ChartRecommendation;
  dark: boolean;
  onCategoryClick?: (value: string, categoryKey: string) => void;
  selectedCategory?: string;
}) {
  const colors = getColors(dark);
  const t = themeTokens(dark);
  const catKey = rec.categoryColumn.header;
  const valKey = rec.valueColumns[0].header;

  const total = data.reduce((sum, d) => sum + (typeof d[valKey] === "number" ? (d[valKey] as number) : 0), 0);

  const hasNegative = data.some(d => typeof d[valKey] === "number" && (d[valKey] as number) < 0);
  if (total <= 0 || hasNegative) {
    return (
      <div className="flex aspect-[4/3] items-center justify-center text-xs text-zinc-400 sm:aspect-[16/9]">
        Pie chart is not suitable for this data.
      </div>
    );
  }

  const onPieClick = onCategoryClick
    ? (sector: { payload?: unknown }) => {
        const value = categoryFromPieClick(sector, catKey);
        if (value != null) onCategoryClick(value, catKey);
      }
    : undefined;

  return (
    <div className="aspect-[4/3] sm:aspect-[16/9]" style={drilldownCursor(onCategoryClick)}>
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie
            data={data}
            dataKey={valKey}
            nameKey={catKey}
            cx="50%"
            cy="50%"
            innerRadius={40}
            outerRadius={100}
            onClick={onPieClick}
            label={({ name, value }: { name?: string; value?: number }) =>
              `${truncateLabel(String(name ?? ""), 10)} ${total > 0 && value != null ? ((value / total) * 100).toFixed(0) : 0}%`
            }
            labelLine={{ stroke: t.axis }}
            fontSize={11}
          >
            {data.map((d, i) => (
              <Cell
                key={i}
                fill={colors[i % colors.length]}
                // #3213 — dim non-selected slices when a cross-filter is active;
                // gated on `selectionOnAxis` (#3219) like the bar views.
                fillOpacity={selectionOnAxis(data, catKey, selectedCategory) ? selectedFillOpacity(d[catKey], selectedCategory) : undefined}
              />
            ))}
          </Pie>
          <Tooltip content={<ChartTooltip dark={dark} />} />
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Area chart                                                           */
/* ------------------------------------------------------------------ */

function AreaChartView({
  data,
  rec,
  dark,
  onCategoryClick,
  thresholds,
  annotations,
}: {
  data: RechartsRow[];
  rec: ChartRecommendation;
  dark: boolean;
  onCategoryClick?: (value: string, categoryKey: string) => void;
  thresholds?: ThresholdInput[];
  annotations?: AnnotationInput[];
}) {
  const chartId = useId();
  const colors = getColors(dark);
  const t = themeTokens(dark);
  const catKey = rec.categoryColumn.header;
  const valKeys = rec.valueColumns.map((c) => c.header);
  const onClick = chartClickHandler(onCategoryClick, catKey);

  return (
    <div className="aspect-[4/3] sm:aspect-[16/9]" style={drilldownCursor(onCategoryClick)}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 40, left: 8 }} onClick={onClick}>
          <defs>
            {valKeys.map((key, i) => (
              <linearGradient key={key} id={`area-grad-${chartId}-${i}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={colors[i % colors.length]} stopOpacity={0.3} />
                <stop offset="95%" stopColor={colors[i % colors.length]} stopOpacity={0.05} />
              </linearGradient>
            ))}
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke={t.grid} />
          <XAxis
            dataKey={catKey}
            tick={{ fill: t.axis, fontSize: 11 }}
            tickFormatter={(v: string) => truncateLabel(v)}
            angle={-45}
            textAnchor="end"
            height={60}
            interval="preserveStartEnd"
          />
          <YAxis tick={{ fill: t.axis, fontSize: 11 }} tickFormatter={formatNumber} />
          <Tooltip content={<ChartTooltip dark={dark} />} />
          {valKeys.length > 1 && (
            <Legend wrapperStyle={{ fontSize: 12, color: t.legendText }} />
          )}
          {valKeys.map((key, i) => (
            <Area
              key={key}
              type="monotone"
              dataKey={key}
              stroke={colors[i % colors.length]}
              strokeWidth={2}
              fill={`url(#area-grad-${chartId}-${i})`}
            />
          ))}
          {thresholdLineElements(thresholds, dark)}
          {annotationLineElements(annotations, dark)}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Stacked bar chart                                                    */
/* ------------------------------------------------------------------ */

function StackedBarChartView({
  data,
  rec,
  dark,
  onCategoryClick,
  selectedCategory,
  thresholds,
}: {
  data: RechartsRow[];
  rec: ChartRecommendation;
  dark: boolean;
  onCategoryClick?: (value: string, categoryKey: string) => void;
  selectedCategory?: string;
  thresholds?: ThresholdInput[];
}) {
  const colors = getColors(dark);
  const t = themeTokens(dark);
  const catKey = rec.categoryColumn.header;
  const valKeys = rec.valueColumns.map((c) => c.header);
  const onClick = chartClickHandler(onCategoryClick, catKey);

  return (
    <div className="aspect-[4/3] sm:aspect-[16/9]" style={drilldownCursor(onCategoryClick)}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 40, left: 8 }} onClick={onClick}>
          <CartesianGrid strokeDasharray="3 3" stroke={t.grid} />
          <XAxis
            dataKey={catKey}
            tick={{ fill: t.axis, fontSize: 11 }}
            tickFormatter={(v: string) => truncateLabel(v)}
            angle={-45}
            textAnchor="end"
            height={60}
            interval="preserveStartEnd"
          />
          <YAxis tick={{ fill: t.axis, fontSize: 11 }} tickFormatter={formatNumber} />
          <Tooltip content={<ChartTooltip dark={dark} />} />
          <Legend wrapperStyle={{ fontSize: 12, color: t.legendText }} />
          {valKeys.map((key, i) => (
            <Bar
              key={key}
              dataKey={key}
              stackId="a"
              fill={colors[i % colors.length]}
              radius={i === valKeys.length - 1 ? [4, 4, 0, 0] : undefined}
            >
              {/* #3213 — dim non-selected categories when a cross-filter is active.
                  Gated on `selectionOnAxis` (#3219) so a divergent detected axis
                  isn't dimmed by a filter that belongs to another column. */}
              {selectionOnAxis(data, catKey, selectedCategory) &&
                data.map((d, ci) => (
                  <Cell key={ci} fillOpacity={selectedFillOpacity(d[catKey], selectedCategory)} />
                ))}
            </Bar>
          ))}
          {thresholdLineElements(thresholds, dark)}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Scatter chart                                                        */
/* ------------------------------------------------------------------ */

function ScatterChartView({
  data,
  rec,
  dark,
}: {
  data: RechartsRow[];
  rec: ChartRecommendation;
  dark: boolean;
}) {
  const colors = getColors(dark);
  const t = themeTokens(dark);
  const xKey = rec.categoryColumn.header;
  const yKey = rec.valueColumns[0].header;
  const zKey = rec.valueColumns.length > 1 ? rec.valueColumns[1].header : undefined;

  return (
    <div className="aspect-[4/3] sm:aspect-[16/9]">
      <ResponsiveContainer width="100%" height="100%">
        <ScatterChart margin={{ top: 8, right: 8, bottom: 40, left: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={t.grid} />
          <XAxis
            dataKey={xKey}
            type="number"
            name={xKey}
            tick={{ fill: t.axis, fontSize: 11 }}
            tickFormatter={formatNumber}
          />
          <YAxis
            dataKey={yKey}
            type="number"
            name={yKey}
            tick={{ fill: t.axis, fontSize: 11 }}
            tickFormatter={formatNumber}
          />
          {zKey && <ZAxis dataKey={zKey} type="number" name={zKey} range={[40, 400]} />}
          <Tooltip
            content={<ChartTooltip dark={dark} />}
            cursor={{ strokeDasharray: "3 3" }}
          />
          <Scatter
            data={data}
            fill={colors[0]}
          />
        </ScatterChart>
      </ResponsiveContainer>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Chart type selector                                                 */
/* ------------------------------------------------------------------ */

const CHART_LABELS: Record<ChartType, string> = {
  bar: "Bar",
  line: "Line",
  pie: "Pie",
  area: "Area",
  "stacked-bar": "Stacked",
  scatter: "Scatter",
};

function ChartTypeSelector({
  recommendations,
  active,
  onChange,
}: {
  recommendations: ChartRecommendation[];
  active: ChartType;
  onChange: (t: ChartType) => void;
}) {
  if (recommendations.length <= 1) return null;

  const seen = new Set<ChartType>();
  const unique = recommendations.filter((r) => {
    if (seen.has(r.type)) return false;
    seen.add(r.type);
    return true;
  });

  if (unique.length <= 1) return null;

  return (
    <div className="flex gap-1">
      {unique.map((rec) => (
        <button
          key={rec.type}
          onClick={() => onChange(rec.type)}
          aria-pressed={active === rec.type}
          className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 ${
            active === rec.type
              ? "bg-background text-foreground shadow-sm ring-1 ring-zinc-300 dark:ring-zinc-700"
              : "text-zinc-700 hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-zinc-100"
          }`}
        >
          {CHART_LABELS[rec.type]}
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Chart renderer (inside error boundary)                               */
/* ------------------------------------------------------------------ */

function ChartRenderer({
  rows,
  rec,
  defaultData,
  defaultRec,
  dark,
  onCategoryClick,
  selectedCategory,
  thresholds,
  annotations,
}: {
  rows: string[][];
  rec: ChartRecommendation;
  defaultData: RechartsRow[];
  defaultRec: ChartRecommendation;
  dark: boolean;
  onCategoryClick?: (value: string, categoryKey: string) => void;
  selectedCategory?: string;
  thresholds?: ThresholdInput[];
  annotations?: AnnotationInput[];
}) {
  // Re-transform data when switching chart type (category axis may differ)
  const chartData = rec === defaultRec ? defaultData : transformData(rows, rec);
  const type = rec.type;

  // Scatter is intentionally not drillable (#3212): both axes are numeric — it
  // has no category to bind a parameter to. Every other view forwards clicks.
  // `selectedCategory` (#3213) only styles the categorical views (bar / stacked /
  // pie); line/area trends have no discrete element to mark. Goal lines (#3208)
  // are horizontal Y-axis references, so they apply to the cartesian views (bar /
  // line / area / stacked-bar) — not pie (no Y axis) or scatter (numeric Y). Event
  // annotations (#3209) are VERTICAL X-axis markers for dated events, so they
  // apply ONLY to the time-series views (line / area) — bar/stacked/pie/scatter
  // ignore them (a categorical or numeric X axis has no time context to mark).
  return (
    <div className="p-2">
      {type === "bar" ? <BarChartView data={chartData} rec={rec} dark={dark} onCategoryClick={onCategoryClick} selectedCategory={selectedCategory} thresholds={thresholds} />
        : type === "line" ? <LineChartView data={chartData} rec={rec} dark={dark} onCategoryClick={onCategoryClick} thresholds={thresholds} annotations={annotations} />
        : type === "area" ? <AreaChartView data={chartData} rec={rec} dark={dark} onCategoryClick={onCategoryClick} thresholds={thresholds} annotations={annotations} />
        : type === "stacked-bar" ? <StackedBarChartView data={chartData} rec={rec} dark={dark} onCategoryClick={onCategoryClick} selectedCategory={selectedCategory} thresholds={thresholds} />
        : type === "scatter" ? <ScatterChartView data={chartData} rec={rec} dark={dark} />
        : <PieChartView data={chartData} rec={rec} dark={dark} onCategoryClick={onCategoryClick} selectedCategory={selectedCategory} />}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main ResultChart component                                          */
/* ------------------------------------------------------------------ */

export function ResultChart({
  headers,
  rows,
  dark,
  detectionResult,
  onCategoryClick,
  selectedCategory,
  thresholds,
  annotations,
  embedded = false,
  chartType,
}: {
  headers: string[];
  rows: string[][];
  dark: boolean;
  detectionResult?: ChartDetectionResult;
  /**
   * #3212 — click-to-drilldown. When provided, clicking a bar / line / area
   * point or pie slice forwards the clicked category-axis value AND the chart's
   * category-axis column header (so the consumer can confirm it matches the
   * card's configured drilldown column before binding). Omitted on the chat
   * surface and on non-drillable dashboard cards (no-op click).
   */
  onCategoryClick?: (value: string, categoryKey: string) => void;
  /**
   * #3213 — cross-filter "selected" state. The active filter's category value;
   * its bar / slice renders solid while the rest dim, so the clicked element
   * reads as selected. Only the categorical views (bar / stacked / pie) honor it.
   * Omitted → no element is marked.
   */
  selectedCategory?: string;
  /**
   * #3208 — goal lines / thresholds from the card's `chartConfig.thresholds`.
   * Each renders as a horizontal `<ReferenceLine>` on the bar / line / area /
   * stacked-bar views. Omitted on the chat surface and on cards with no
   * thresholds, so the chart renders exactly as before.
   */
  thresholds?: ThresholdInput[];
  /**
   * #3209 — event annotations from the card's `annotations` column. Each renders
   * as a VERTICAL `<ReferenceLine>` on the line / area views ONLY (a dated event
   * marker on the time axis); bar / pie / scatter ignore them. Omitted on the
   * chat surface and on cards with none, so the chart renders exactly as before.
   */
  annotations?: AnnotationInput[];
  /**
   * #4688 — dashboard-tile mode. When true, ResultChart renders the PLOT ONLY:
   * its own caption bar ("Time-series: …"), the Line/Area/Bar type toggle, and
   * its border frame are suppressed. A dashboard tile already owns the title +
   * border and the card config pins the chart type, so ResultChart's own chrome
   * would be chrome-in-chrome. The chat surface omits this → keeps toggle +
   * caption. Defaults to false (unchanged chat behaviour).
   */
  embedded?: boolean;
  /**
   * #4688 — pin the rendered chart to the card's configured type instead of the
   * data's auto-detected default. Pass a card's `chartConfig.type` (narrowed via
   * `asEmbeddedChartType`); when the current data has no recommendation for that
   * type the top auto-detected one is used instead (a divergent tile still draws
   * a chart). Omitted → auto-detect (the chat surface). Intended to be paired with
   * `embedded`: passing it alone still pins the chart but leaves the (now inert)
   * in-chart toggle visible, which is not a supported combination.
   */
  chartType?: ChartType;
}) {
  const result = useMemo(
    () => detectionResult ?? detectCharts(headers, rows),
    [headers, rows, detectionResult],
  );

  const [activeType, setActiveType] = useState<ChartType | null>(null);

  if (!result.chartable) return null;

  // #4688 — a pinned `chartType` (a dashboard tile) fixes the rendered chart to
  // the card's configured type and takes precedence over the in-chart toggle
  // (`activeType`, chat-surface only). No pin → the toggle / auto-detect path.
  const pinnedRec = chartType ? pickChartRecommendation(result.recommendations, chartType) : null;
  const currentType = pinnedRec?.type ?? activeType ?? result.recommendations[0].type;
  const currentRec =
    pinnedRec ?? result.recommendations.find((r) => r.type === currentType) ?? result.recommendations[0];

  const chartBody = (
    <ErrorBoundary
      key={currentType}
      fallback={
        <div className="rounded-lg border border-yellow-300 bg-yellow-50 px-3 py-2 text-xs text-yellow-700 dark:border-yellow-900/50 dark:bg-yellow-950/20 dark:text-yellow-400">
          Unable to render chart. Switch to Table view to see your data.
        </div>
      }
    >
      <ChartRenderer
        rows={rows}
        rec={currentRec}
        defaultData={result.data}
        defaultRec={result.recommendations[0]}
        dark={dark}
        onCategoryClick={onCategoryClick}
        selectedCategory={selectedCategory}
        thresholds={thresholds}
        annotations={annotations}
      />
    </ErrorBoundary>
  );

  // #4688 — dashboard tiles render the plot only: no caption bar, no type toggle,
  // no frame (the tile already provides all three). The single wrapping div keeps
  // the height target the tile's ChartSlot `[&>div]:h-full` selector expects.
  if (embedded) {
    return <div className="h-full">{chartBody}</div>;
  }

  return (
    <div className="overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-700">
      <div className="flex items-center justify-between border-b border-zinc-100 bg-zinc-50/50 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900/50">
        <span className="text-xs text-zinc-500 dark:text-zinc-400">{currentRec.reason}</span>
        <ChartTypeSelector
          recommendations={result.recommendations}
          active={currentType}
          onChange={setActiveType}
        />
      </div>
      {chartBody}
    </div>
  );
}
