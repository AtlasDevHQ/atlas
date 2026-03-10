"use client";

import {
  ResponsiveContainer,
  AreaChart,
  Area,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
} from "recharts";

const TOKENS = {
  light: { grid: "#e4e4e7", axis: "#71717a", bg: "#ffffff", border: "#e4e4e7", text: "#27272a" },
  dark: { grid: "#3f3f46", axis: "#a1a1aa", bg: "#18181b", border: "#3f3f46", text: "#e4e4e7" },
} as const;

export interface TrendPoint {
  day: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  requestCount: number;
}

function formatDay(value: string) {
  const d = new Date(value);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatNumber(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}

export default function TokenChart({ data, dark }: { data: TrendPoint[]; dark: boolean }) {
  const t = dark ? TOKENS.dark : TOKENS.light;

  return (
    <ResponsiveContainer width="100%" height={300}>
      <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 20, left: 8 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={t.grid} />
        <XAxis
          dataKey="day"
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
          formatter={(value: number) => [formatNumber(value), undefined]}
        />
        <Legend wrapperStyle={{ fontSize: 12, color: t.axis }} />
        <Area
          type="monotone"
          dataKey="promptTokens"
          name="Prompt"
          stroke="#3b82f6"
          fill="#3b82f6"
          fillOpacity={0.15}
          strokeWidth={2}
        />
        <Area
          type="monotone"
          dataKey="completionTokens"
          name="Completion"
          stroke="#8b5cf6"
          fill="#8b5cf6"
          fillOpacity={0.15}
          strokeWidth={2}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
