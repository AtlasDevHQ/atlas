"use client";

import {
  ResponsiveContainer,
  BarChart,
  Bar,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
} from "recharts";
import { formatNumber } from "./format";

// Design tokens for light/dark chart theming
const CHART_THEME = {
  light: { grid: "#e4e4e7", axis: "#71717a", bg: "#ffffff", border: "#e4e4e7", text: "#27272a" },
  dark: { grid: "#3f3f46", axis: "#a1a1aa", bg: "#18181b", border: "#3f3f46", text: "#e4e4e7" },
} as const;

export interface DailyUsagePoint {
  period_start: string;
  query_count: number;
  token_count: number;
  active_users: number;
}

function formatDay(value: string) {
  const d = new Date(value);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export default function UsageChart({ data, dark }: { data: DailyUsagePoint[]; dark: boolean }) {
  const t = dark ? CHART_THEME.dark : CHART_THEME.light;

  return (
    <ResponsiveContainer width="100%" height={300}>
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 20, left: 8 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={t.grid} />
        <XAxis
          dataKey="period_start"
          tick={{ fill: t.axis, fontSize: 11 }}
          tickFormatter={formatDay}
        />
        <YAxis
          tick={{ fill: t.axis, fontSize: 11 }}
          tickFormatter={formatNumber}
          allowDecimals={false}
        />
        <Tooltip
          contentStyle={{
            background: t.bg,
            border: `1px solid ${t.border}`,
            borderRadius: 6,
            fontSize: 12,
            color: t.text,
          }}
          labelFormatter={(label) => formatDay(String(label))}
          formatter={(value: number | undefined) => [formatNumber(value ?? 0), undefined]}
        />
        <Legend wrapperStyle={{ fontSize: 12, color: t.axis }} />
        <Bar dataKey="query_count" name="Queries" fill="#3b82f6" radius={[4, 4, 0, 0]} />
        <Bar dataKey="token_count" name="Tokens" fill="#8b5cf6" radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}
