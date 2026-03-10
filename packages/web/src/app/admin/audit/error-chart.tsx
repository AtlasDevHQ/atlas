"use client";

import {
  ResponsiveContainer,
  BarChart,
  Bar,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
} from "recharts";

interface ErrorGroup {
  error: string;
  count: number;
}

const TOKENS = {
  light: { grid: "#e4e4e7", axis: "#71717a", bg: "#ffffff", border: "#e4e4e7", text: "#27272a" },
  dark: { grid: "#3f3f46", axis: "#a1a1aa", bg: "#18181b", border: "#3f3f46", text: "#e4e4e7" },
} as const;

function truncate(s: string, max = 30) {
  return s.length > max ? s.slice(0, max) + "\u2026" : s;
}

export default function ErrorChart({ data, dark }: { data: ErrorGroup[]; dark: boolean }) {
  const t = dark ? TOKENS.dark : TOKENS.light;

  return (
    <ResponsiveContainer width="100%" height={Math.max(200, data.length * 32 + 40)}>
      <BarChart data={data} layout="vertical" margin={{ top: 8, right: 8, bottom: 8, left: 8 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={t.grid} horizontal={false} />
        <XAxis type="number" tick={{ fill: t.axis, fontSize: 11 }} allowDecimals={false} />
        <YAxis
          type="category"
          dataKey="error"
          tick={{ fill: t.axis, fontSize: 11 }}
          tickFormatter={(v: string) => truncate(v)}
          width={180}
        />
        <Tooltip
          contentStyle={{
            background: t.bg,
            border: `1px solid ${t.border}`,
            borderRadius: 6,
            fontSize: 12,
            color: t.text,
          }}
        />
        <Bar dataKey="count" fill="#ef4444" radius={[0, 4, 4, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}
