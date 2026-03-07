"use client";

import { useContext, useState } from "react";
import { getToolArgs, getToolResult, isToolComplete } from "../../lib/helpers";
import { DarkModeContext } from "../../hooks/use-dark-mode";
import dynamic from "next/dynamic";
import { LoadingCard } from "./loading-card";
import { DataTable } from "./data-table";

const ResultChart = dynamic(
  () => import("../chart/result-chart").then((m) => ({ default: m.ResultChart })),
  { ssr: false, loading: () => <div className="h-64 animate-pulse rounded-lg bg-zinc-100 dark:bg-zinc-800" /> },
);

interface RechartsChartConfig {
  type: "line" | "bar" | "pie";
  data: Record<string, unknown>[];
  categoryKey: string;
  valueKeys: string[];
}

interface PythonChart {
  base64: string;
  mimeType: string;
}

export function PythonResultCard({ part }: { part: unknown }) {
  const dark = useContext(DarkModeContext);
  const args = getToolArgs(part);
  const result = getToolResult(part) as Record<string, unknown> | null;
  const done = isToolComplete(part);
  const [open, setOpen] = useState(true);

  if (!done) return <LoadingCard label="Running Python..." />;

  if (!result) {
    return (
      <div className="my-2 rounded-lg border border-yellow-300 bg-yellow-50 px-3 py-2 text-xs text-yellow-700 dark:border-yellow-900/50 dark:bg-yellow-950/20 dark:text-yellow-400">
        Python executed but no result was returned.
      </div>
    );
  }

  if (!result.success) {
    return (
      <div className="my-2 overflow-hidden rounded-lg border border-red-300 bg-red-50 dark:border-red-900/50 dark:bg-red-950/20">
        <div className="px-3 py-2 text-xs font-medium text-red-700 dark:text-red-400">
          Python execution failed
        </div>
        <pre className="border-t border-red-200 px-3 py-2 text-xs whitespace-pre-wrap text-red-600 dark:border-red-900/50 dark:text-red-300">
          {String(result.error ?? "Unknown error")}
        </pre>
        {result.output && (
          <pre className="border-t border-red-200 px-3 py-2 text-xs whitespace-pre-wrap text-red-500 dark:border-red-900/50 dark:text-red-400">
            {String(result.output)}
          </pre>
        )}
      </div>
    );
  }

  const output = result.output ? String(result.output) : null;
  const table = result.table as { columns: string[]; rows: unknown[][] } | undefined;
  const charts = result.charts as PythonChart[] | undefined;
  const rechartsCharts = result.rechartsCharts as RechartsChartConfig[] | undefined;

  const hasTable = table && table.columns?.length > 0 && table.rows?.length > 0;
  const hasCharts = charts && charts.length > 0;
  const hasRechartsCharts = rechartsCharts && rechartsCharts.length > 0;

  return (
    <div className="my-2 overflow-hidden rounded-lg border border-zinc-200 bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-zinc-100/60 dark:hover:bg-zinc-800/60"
      >
        <span className="rounded bg-emerald-100 px-1.5 py-0.5 font-medium text-emerald-700 dark:bg-emerald-600/20 dark:text-emerald-400">
          Python
        </span>
        <span className="flex-1 truncate text-zinc-500 dark:text-zinc-400">
          {String(args.explanation ?? "Python result")}
        </span>
        <span className="text-zinc-400 dark:text-zinc-600">{open ? "\u25BE" : "\u25B8"}</span>
      </button>

      {open && (
        <div className="space-y-2 border-t border-zinc-100 px-3 py-2 dark:border-zinc-800">
          {output && (
            <pre className="rounded-md bg-zinc-100 px-3 py-2 text-xs whitespace-pre-wrap text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
              {output}
            </pre>
          )}

          {hasTable && <DataTable columns={table.columns} rows={table.rows} />}

          {hasRechartsCharts &&
            rechartsCharts.map((chart, i) => (
              <RechartsChartSection key={i} chart={chart} dark={dark} />
            ))}

          {hasCharts &&
            charts.map((chart, i) => (
              <img
                key={i}
                src={`data:${chart.mimeType};base64,${chart.base64}`}
                alt={`Python chart ${i + 1}`}
                className="max-w-full rounded-lg border border-zinc-200 dark:border-zinc-700"
              />
            ))}
        </div>
      )}
    </div>
  );
}

function RechartsChartSection({ chart, dark }: { chart: RechartsChartConfig; dark: boolean }) {
  // Transform rechartsCharts config into headers + string[][] rows for ResultChart
  const headers = [chart.categoryKey, ...chart.valueKeys];
  const rows: string[][] = chart.data.map((row) =>
    headers.map((key) => (row[key] == null ? "" : String(row[key]))),
  );

  return <ResultChart headers={headers} rows={rows} dark={dark} />;
}
