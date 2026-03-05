"use client";

import { Component, type ReactNode, type ErrorInfo, useMemo, useState } from "react";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  LineChart,
  Line,
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
/*  Error boundary                                                       */
/* ------------------------------------------------------------------ */

class ChartErrorBoundary extends Component<
  { children: ReactNode; fallback?: ReactNode },
  { hasError: boolean }
> {
  constructor(props: { children: ReactNode; fallback?: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): { hasError: boolean } {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Chart rendering failed:", error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback ?? (
        <div className="rounded-lg border border-yellow-300 bg-yellow-50 px-3 py-2 text-xs text-yellow-700 dark:border-yellow-900/50 dark:bg-yellow-950/20 dark:text-yellow-400">
          Chart could not be rendered. Switch to Table view to see your data.
        </div>
      );
    }
    return this.props.children;
  }
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
      <p style={TOOLTIP_LABEL_STYLE}>{label}</p>
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
    <ResponsiveContainer width="100%" height={300}>
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 40, left: 8 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={t.grid} />
        <XAxis
          dataKey={catKey}
          tick={{ fill: t.axis, fontSize: 11 }}
          tickFormatter={(v: string) => truncateLabel(v)}
          angle={-45}
          textAnchor="end"
          height={60}
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
    <ResponsiveContainer width="100%" height={300}>
      <LineChart data={data} margin={{ top: 8, right: 8, bottom: 40, left: 8 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={t.grid} />
        <XAxis
          dataKey={catKey}
          tick={{ fill: t.axis, fontSize: 11 }}
          tickFormatter={(v: string) => truncateLabel(v)}
          angle={-45}
          textAnchor="end"
          height={60}
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
      <div className="flex h-[300px] items-center justify-center text-xs text-zinc-400">
        Pie chart is not suitable for this data.
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={300}>
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
  );
}

/* ------------------------------------------------------------------ */
/*  Chart type selector                                                 */
/* ------------------------------------------------------------------ */

const CHART_LABELS: Record<ChartType, string> = { bar: "Bar", line: "Line", pie: "Pie" };

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
          className={`rounded px-2 py-0.5 text-xs font-medium transition-colors ${
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

  // Re-transform data when switching chart type (category axis may differ)
  const chartData = currentRec === result.recommendations[0]
    ? result.data
    : transformData(rows, currentRec);

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
      <ChartErrorBoundary key={currentType}>
        <div className="p-2">
          {currentType === "bar" ? <BarChartView data={chartData} rec={currentRec} dark={dark} />
            : currentType === "line" ? <LineChartView data={chartData} rec={currentRec} dark={dark} />
            : <PieChartView data={chartData} rec={currentRec} dark={dark} />}
        </div>
      </ChartErrorBoundary>
    </div>
  );
}
