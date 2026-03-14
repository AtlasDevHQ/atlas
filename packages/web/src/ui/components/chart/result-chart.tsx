"use client";

import { useMemo, useId, useState } from "react";
import { ErrorBoundary } from "../error-boundary";
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
} from "recharts";
import {
  detectCharts,
  transformData,
  CHART_COLORS_LIGHT,
  CHART_COLORS_DARK,
  type ChartRecommendation,
  type ChartType,
  type RechartsRow,
  type ChartDetectionResult,
} from "./chart-detection";

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
  if (!isFinite(num)) return String(value ?? "");
  if (Math.abs(num) >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`;
  if (Math.abs(num) >= 1_000) return `${(num / 1_000).toFixed(1)}K`;
  return Number.isInteger(num) ? num.toLocaleString() : num.toFixed(2);
}

function truncateLabel(label: unknown, maxLen = 12): string {
  const str = String(label ?? "");
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
}: {
  data: RechartsRow[];
  rec: ChartRecommendation;
  dark: boolean;
}) {
  const colors = getColors(dark);
  const t = themeTokens(dark);
  const catKey = rec.categoryColumn.header;
  const valKeys = rec.valueColumns.map((c) => c.header);

  return (
    <div className="aspect-[4/3] sm:aspect-[16/9]">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 40, left: 8 }}>
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
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function LineChartView({
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
  const catKey = rec.categoryColumn.header;
  const valKeys = rec.valueColumns.map((c) => c.header);

  return (
    <div className="aspect-[4/3] sm:aspect-[16/9]">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 8, bottom: 40, left: 8 }}>
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
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function PieChartView({
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

  return (
    <div className="aspect-[4/3] sm:aspect-[16/9]">
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
            label={({ name, value }: { name?: string; value?: number }) =>
              `${truncateLabel(String(name ?? ""), 10)} ${total > 0 && value != null ? ((value / total) * 100).toFixed(0) : 0}%`
            }
            labelLine={{ stroke: t.axis }}
            fontSize={11}
          >
            {data.map((_, i) => (
              <Cell key={i} fill={colors[i % colors.length]} />
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
}: {
  data: RechartsRow[];
  rec: ChartRecommendation;
  dark: boolean;
}) {
  const chartId = useId();
  const colors = getColors(dark);
  const t = themeTokens(dark);
  const catKey = rec.categoryColumn.header;
  const valKeys = rec.valueColumns.map((c) => c.header);

  return (
    <div className="aspect-[4/3] sm:aspect-[16/9]">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 40, left: 8 }}>
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
}: {
  data: RechartsRow[];
  rec: ChartRecommendation;
  dark: boolean;
}) {
  const colors = getColors(dark);
  const t = themeTokens(dark);
  const catKey = rec.categoryColumn.header;
  const valKeys = rec.valueColumns.map((c) => c.header);

  return (
    <div className="aspect-[4/3] sm:aspect-[16/9]">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 40, left: 8 }}>
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
            />
          ))}
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
              ? "bg-blue-100 text-blue-700 dark:bg-blue-600/20 dark:text-blue-400"
              : "text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
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
}: {
  rows: string[][];
  rec: ChartRecommendation;
  defaultData: RechartsRow[];
  defaultRec: ChartRecommendation;
  dark: boolean;
}) {
  // Re-transform data when switching chart type (category axis may differ)
  const chartData = rec === defaultRec ? defaultData : transformData(rows, rec);
  const type = rec.type;

  return (
    <div className="p-2">
      {type === "bar" ? <BarChartView data={chartData} rec={rec} dark={dark} />
        : type === "line" ? <LineChartView data={chartData} rec={rec} dark={dark} />
        : type === "area" ? <AreaChartView data={chartData} rec={rec} dark={dark} />
        : type === "stacked-bar" ? <StackedBarChartView data={chartData} rec={rec} dark={dark} />
        : type === "scatter" ? <ScatterChartView data={chartData} rec={rec} dark={dark} />
        : <PieChartView data={chartData} rec={rec} dark={dark} />}
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
}: {
  headers: string[];
  rows: string[][];
  dark: boolean;
  detectionResult?: ChartDetectionResult;
}) {
  const result = useMemo(
    () => detectionResult ?? detectCharts(headers, rows),
    [headers, rows, detectionResult],
  );

  const [activeType, setActiveType] = useState<ChartType | null>(null);

  if (!result.chartable) return null;

  const currentType = activeType ?? result.recommendations[0].type;
  const currentRec = result.recommendations.find((r) => r.type === currentType) ?? result.recommendations[0];

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
        />
      </ErrorBoundary>
    </div>
  );
}
