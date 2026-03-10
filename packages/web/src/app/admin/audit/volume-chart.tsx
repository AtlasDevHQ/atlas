"use client";

import {
  ResponsiveContainer,
  LineChart,
  Line,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
} from "recharts";

interface VolumePoint {
  day: string;
  count: number;
  errors: number;
}

const TOKENS = {
  light: { grid: "#e4e4e7", axis: "#71717a", bg: "#ffffff", border: "#e4e4e7", text: "#27272a" },
  dark: { grid: "#3f3f46", axis: "#a1a1aa", bg: "#18181b", border: "#3f3f46", text: "#e4e4e7" },
} as const;

function formatDay(value: string) {
  const d = new Date(value);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export default function VolumeChart({ data, dark }: { data: VolumePoint[]; dark: boolean }) {
  const t = dark ? TOKENS.dark : TOKENS.light;

  return (
    <ResponsiveContainer width="100%" height={300}>
      <LineChart data={data} margin={{ top: 8, right: 8, bottom: 20, left: 8 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={t.grid} />
        <XAxis
          dataKey="day"
          tick={{ fill: t.axis, fontSize: 11 }}
          tickFormatter={formatDay}
        />
        <YAxis tick={{ fill: t.axis, fontSize: 11 }} allowDecimals={false} />
        <Tooltip
          contentStyle={{
            background: t.bg,
            border: `1px solid ${t.border}`,
            borderRadius: 6,
            fontSize: 12,
            color: t.text,
          }}
          labelFormatter={formatDay}
        />
        <Legend wrapperStyle={{ fontSize: 12, color: t.axis }} />
        <Line
          type="monotone"
          dataKey="count"
          name="Queries"
          stroke="#3b82f6"
          strokeWidth={2}
          dot={{ r: 3 }}
          activeDot={{ r: 5 }}
        />
        <Line
          type="monotone"
          dataKey="errors"
          name="Errors"
          stroke="#ef4444"
          strokeWidth={2}
          dot={{ r: 3 }}
          activeDot={{ r: 5 }}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
