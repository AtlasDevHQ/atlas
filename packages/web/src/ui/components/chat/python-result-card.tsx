"use client";

import { Component, type ReactNode, type ErrorInfo, useContext, useState } from "react";
import { getToolArgs, getToolResult, isToolComplete } from "../../lib/helpers";
import { DarkModeContext } from "../../hooks/use-dark-mode";
import dynamic from "next/dynamic";
import { LoadingCard } from "./loading-card";
import { DataTable } from "./data-table";
import type { ChartDetectionResult } from "../chart/chart-detection";

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
  mimeType: "image/png";
}

const ALLOWED_IMAGE_MIME = new Set(["image/png", "image/jpeg"]);

/* ------------------------------------------------------------------ */
/*  Error boundary                                                     */
/* ------------------------------------------------------------------ */

class PythonErrorBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean; error?: Error }
> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("PythonResultCard rendering failed:", error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="my-2 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900/50 dark:bg-red-950/20 dark:text-red-400">
          Python result could not be rendered: {this.state.error?.message ?? "unknown error"}
        </div>
      );
    }
    return this.props.children;
  }
}

/* ------------------------------------------------------------------ */
/*  Main component                                                     */
/* ------------------------------------------------------------------ */

export function PythonResultCard({ part }: { part: unknown }) {
  return (
    <PythonErrorBoundary>
      <PythonResultCardInner part={part} />
    </PythonErrorBoundary>
  );
}

function PythonResultCardInner({ part }: { part: unknown }) {
  const dark = useContext(DarkModeContext);
  const args = getToolArgs(part);
  const raw = getToolResult(part);
  const done = isToolComplete(part);
  const [open, setOpen] = useState(true);

  if (!done) return <LoadingCard label="Running Python..." />;

  // Structural validation — result must be a non-null object
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return (
      <div className="my-2 rounded-lg border border-yellow-300 bg-yellow-50 px-3 py-2 text-xs text-yellow-700 dark:border-yellow-900/50 dark:bg-yellow-950/20 dark:text-yellow-400">
        Python executed but returned an unexpected result format.
      </div>
    );
  }

  const result = raw as Record<string, unknown>;

  if (!result.success) {
    return (
      <div className="my-2 overflow-hidden rounded-lg border border-red-300 bg-red-50 dark:border-red-900/50 dark:bg-red-950/20">
        <div className="px-3 py-2 text-xs font-medium text-red-700 dark:text-red-400">
          Python execution failed
        </div>
        <pre className="border-t border-red-200 px-3 py-2 text-xs whitespace-pre-wrap text-red-600 dark:border-red-900/50 dark:text-red-300">
          {String(result.error ?? "Unknown error")}
        </pre>
        {!!result.output && (
          <pre className="border-t border-red-200 px-3 py-2 text-xs whitespace-pre-wrap text-red-500 dark:border-red-900/50 dark:text-red-400">
            {String(result.output)}
          </pre>
        )}
      </div>
    );
  }

  const output = result.output ? String(result.output) : null;
  const table = result.table as { columns: string[]; rows: unknown[][] } | undefined;
  const charts = Array.isArray(result.charts) ? (result.charts as PythonChart[]) : undefined;
  const rechartsCharts = Array.isArray(result.rechartsCharts) ? (result.rechartsCharts as RechartsChartConfig[]) : undefined;

  const hasTable = table && Array.isArray(table.columns) && Array.isArray(table.rows)
    && table.columns.length > 0 && table.rows.length > 0;
  const hasCharts = charts && charts.length > 0;
  const hasRechartsCharts = rechartsCharts && rechartsCharts.length > 0;

  // Filter charts to only safe image MIME types
  const safeCharts = hasCharts
    ? charts.filter((c) => c.base64 && ALLOWED_IMAGE_MIME.has(c.mimeType))
    : [];

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

          {safeCharts.length > 0 &&
            safeCharts.map((chart, i) => (
              <ChartImage key={i} chart={chart} index={i} />
            ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Chart image with error handling                                    */
/* ------------------------------------------------------------------ */

function ChartImage({ chart, index }: { chart: PythonChart; index: number }) {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <div className="rounded-lg border border-yellow-300 bg-yellow-50 px-3 py-2 text-xs text-yellow-700 dark:border-yellow-900/50 dark:bg-yellow-950/20 dark:text-yellow-400">
        Chart {index + 1} failed to render.
      </div>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element -- base64 data URL, cannot use next/image optimization
    <img
      src={`data:${chart.mimeType};base64,${chart.base64}`}
      alt={`Python chart ${index + 1}`}
      className="max-w-full rounded-lg border border-zinc-200 dark:border-zinc-700"
      onError={() => setFailed(true)}
    />
  );
}

/* ------------------------------------------------------------------ */
/*  Recharts section — bypasses auto-detection with synthetic result   */
/* ------------------------------------------------------------------ */

function RechartsChartSection({ chart, dark }: { chart: RechartsChartConfig; dark: boolean }) {
  if (!chart.categoryKey || !Array.isArray(chart.valueKeys) || !Array.isArray(chart.data)) {
    return (
      <div className="rounded-lg border border-yellow-300 bg-yellow-50 px-3 py-2 text-xs text-yellow-700 dark:border-yellow-900/50 dark:bg-yellow-950/20 dark:text-yellow-400">
        Chart data is incomplete or malformed.
      </div>
    );
  }

  const headers = [chart.categoryKey, ...chart.valueKeys];
  const rows: string[][] = chart.data.map((row) =>
    headers.map((key) => (row[key] == null ? "" : String(row[key]))),
  );

  // Build a synthetic detection result so ResultChart uses the backend's
  // chart config directly, bypassing auto-detection that might reject it.
  const detectionResult: ChartDetectionResult = {
    chartable: true,
    columns: headers.map((h, i) => ({
      header: h,
      type: i === 0 ? "categorical" as const : "numeric" as const,
      index: i,
      uniqueCount: i === 0 ? chart.data.length : 0,
    })),
    recommendations: [{
      type: chart.type,
      categoryColumn: { header: chart.categoryKey, type: "categorical" as const, index: 0, uniqueCount: chart.data.length },
      valueColumns: chart.valueKeys.map((k, i) => ({
        header: k,
        type: "numeric" as const,
        index: i + 1,
        uniqueCount: 0,
      })) as [{ header: string; type: "numeric"; index: number; uniqueCount: number }, ...{ header: string; type: "numeric"; index: number; uniqueCount: number }[]],
      reason: "Python-generated chart",
    }],
    data: chart.data.map((row) => {
      const out: Record<string, string | number> = {};
      for (const key of headers) {
        const val = row[key];
        out[key] = typeof val === "number" ? val : String(val ?? "");
      }
      return out;
    }),
  };

  return <ResultChart headers={headers} rows={rows} dark={dark} detectionResult={detectionResult} />;
}
