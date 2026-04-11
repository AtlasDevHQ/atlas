"use client";

import { useState, useRef, useEffect } from "react";
import { getToolArgs, getToolResult, isToolComplete } from "../../lib/helpers";
import { useDarkMode } from "../../hooks/use-dark-mode";
import dynamic from "next/dynamic";
import { LoadingCard } from "./loading-card";
import { DataTable } from "./data-table";
import { ResultCardBase, ResultCardErrorBoundary } from "./result-card-base";
import type { ChartDetectionResult, ChartType } from "../chart/chart-detection";

const ResultChart = dynamic(
  () => import("../chart/result-chart").then((m) => ({ default: m.ResultChart })),
  { ssr: false, loading: () => <div className="h-64 animate-pulse rounded-lg bg-zinc-100 dark:bg-zinc-800" /> },
);

interface RechartsChartConfig {
  type: ChartType;
  data: Record<string, unknown>[];
  categoryKey: string;
  valueKeys: string[];
}

interface PythonChart {
  base64: string;
  mimeType: "image/png";
}

/** Progress event from the server's streaming Python execution. */
export type PythonProgressData =
  | { type: "stdout"; content: string }
  | { type: "chart"; chart: PythonChart }
  | { type: "recharts"; chart: RechartsChartConfig };

const ALLOWED_IMAGE_MIME = new Set(["image/png", "image/jpeg"]);

/* ------------------------------------------------------------------ */
/*  Main component                                                     */
/* ------------------------------------------------------------------ */

export function PythonResultCard({ part, progressEvents }: { part: unknown; progressEvents?: PythonProgressData[] }) {
  return (
    <ResultCardErrorBoundary label="Python">
      <PythonResultCardInner part={part} progressEvents={progressEvents} />
    </ResultCardErrorBoundary>
  );
}

function PythonResultCardInner({ part, progressEvents }: { part: unknown; progressEvents?: PythonProgressData[] }) {
  const dark = useDarkMode();
  const args = getToolArgs(part);
  const raw = getToolResult(part);
  const done = isToolComplete(part);
  const outputRef = useRef<HTMLPreElement>(null);

  // Auto-scroll the streaming output to the bottom
  useEffect(() => {
    if (outputRef.current && !done) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [progressEvents, done]);

  // While executing: show progressive output from streaming events
  if (!done) {
    const hasProgress = progressEvents && progressEvents.length > 0;

    if (!hasProgress) {
      return <LoadingCard label="Running Python..." />;
    }

    // Accumulate stdout and charts from progress events
    const stdoutParts: string[] = [];
    const streamCharts: PythonChart[] = [];

    for (const ev of progressEvents) {
      switch (ev.type) {
        case "stdout":
          stdoutParts.push(ev.content);
          break;
        case "chart":
          streamCharts.push(ev.chart);
          break;
        case "recharts":
          // Recharts are rendered from the final result, not during streaming
          break;
      }
    }

    const partialOutput = stdoutParts.join("");

    return (
      <div className="my-2 overflow-hidden rounded-lg border border-emerald-200 bg-emerald-50/50 dark:border-emerald-800/50 dark:bg-emerald-950/20">
        <div className="flex items-center gap-2 px-3 py-2 text-xs">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
          </span>
          <span className="font-medium text-emerald-700 dark:text-emerald-400">
            Running Python...
          </span>
          <span className="flex-1 truncate text-zinc-500 dark:text-zinc-400">
            {String(args.explanation ?? "")}
          </span>
        </div>
        {(partialOutput || streamCharts.length > 0) && (
          <div className="space-y-2 border-t border-emerald-100 px-3 py-2 dark:border-emerald-900/30">
            {partialOutput && (
              <pre
                ref={outputRef}
                className="max-h-64 overflow-y-auto rounded-md bg-zinc-100 px-3 py-2 text-xs whitespace-pre-wrap text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
              >
                {partialOutput}
              </pre>
            )}
            {streamCharts.map((chart, i) => (
              <ChartImage key={i} chart={chart} index={i} />
            ))}
          </div>
        )}
      </div>
    );
  }

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
    <ResultCardBase
      badge="Python"
      badgeClassName="bg-emerald-100 text-emerald-700 dark:bg-emerald-600/20 dark:text-emerald-400"
      title={String(args.explanation ?? "Python result")}
      contentClassName="space-y-2 px-3 py-2"
    >
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
    </ResultCardBase>
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
