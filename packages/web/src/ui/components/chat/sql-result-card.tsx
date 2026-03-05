"use client";

import { useContext, useMemo, useState } from "react";
import { getToolArgs, getToolResult, isToolComplete, downloadCSV, toCsvString } from "../../lib/helpers";
import { DarkModeContext } from "../../hooks/use-dark-mode";
import { detectCharts } from "../chart/chart-detection";
import dynamic from "next/dynamic";

const ResultChart = dynamic(
  () => import("../chart/result-chart").then((m) => ({ default: m.ResultChart })),
  { ssr: false, loading: () => <div className="h-64 animate-pulse rounded-lg bg-zinc-100 dark:bg-zinc-800" /> },
);
import { LoadingCard } from "./loading-card";
import { DataTable } from "./data-table";
import { SQLBlock } from "./sql-block";

/** Convert structured rows (Record<string, unknown>[]) to string[][] for chart detection. */
function toStringRows(columns: string[], rows: Record<string, unknown>[]): string[][] {
  return rows.map((row) => columns.map((col) => (row[col] == null ? "" : String(row[col]))));
}


export function SQLResultCard({ part }: { part: unknown }) {
  const dark = useContext(DarkModeContext);
  const args = getToolArgs(part);
  const result = getToolResult(part) as Record<string, unknown> | null;
  const done = isToolComplete(part);
  const [open, setOpen] = useState(true);
  const [sqlOpen, setSqlOpen] = useState(false);
  const [viewMode, setViewMode] = useState<"both" | "chart" | "table">("both");

  const columns = useMemo(
    () => (done && result?.success ? ((result.columns as string[]) ?? []) : []),
    [done, result],
  );
  const rows = useMemo(
    () => (done && result?.success ? ((result.rows as Record<string, unknown>[]) ?? []) : []),
    [done, result],
  );
  const sql = String(args.sql ?? "");

  const stringRows = useMemo(() => toStringRows(columns, rows), [columns, rows]);
  const chartResult = useMemo(
    () => (columns.length > 0 ? detectCharts(columns, stringRows) : { chartable: false as const, columns: [] }),
    [columns, stringRows],
  );

  if (!done) return <LoadingCard label="Executing query..." />;

  if (!result) {
    return (
      <div className="my-2 rounded-lg border border-yellow-300 bg-yellow-50 text-yellow-700 dark:border-yellow-900/50 dark:bg-yellow-950/20 dark:text-yellow-400 px-3 py-2 text-xs">
        Query completed but no result was returned.
      </div>
    );
  }

  if (!result.success) {
    return (
      <div className="my-2 rounded-lg border border-red-300 bg-red-50 text-red-700 dark:border-red-900/50 dark:bg-red-950/20 dark:text-red-400 px-3 py-2 text-xs">
        Query failed. Check the query and try again.
      </div>
    );
  }

  const hasData = columns.length > 0 && rows.length > 0;
  const showChart = chartResult.chartable && (viewMode === "chart" || viewMode === "both");
  const showTable = viewMode === "table" || viewMode === "both" || !chartResult.chartable;

  return (
    <div className="my-2 overflow-hidden rounded-lg border border-zinc-200 bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-zinc-100/60 dark:hover:bg-zinc-800/60"
      >
        <span className="rounded bg-blue-100 text-blue-700 dark:bg-blue-600/20 dark:text-blue-400 px-1.5 py-0.5 font-medium">
          SQL
        </span>
        <span className="flex-1 truncate text-zinc-500 dark:text-zinc-400">
          {String(args.explanation ?? "Query result")}
        </span>
        <span className="text-zinc-500">
          {rows.length} row{rows.length !== 1 ? "s" : ""}
          {result.truncated ? "+" : ""}
        </span>
        <span className="text-zinc-400 dark:text-zinc-600">{open ? "\u25BE" : "\u25B8"}</span>
      </button>
      {open && (
        <div className="border-t border-zinc-100 dark:border-zinc-800">
          {hasData && chartResult.chartable && (
            <div className="flex gap-1 px-3 pt-2">
              {(["chart", "both", "table"] as const).map((mode) => (
                <button
                  key={mode}
                  onClick={() => setViewMode(mode)}
                  className={`rounded px-2 py-0.5 text-xs font-medium transition-colors ${
                    viewMode === mode
                      ? "bg-zinc-200 text-zinc-800 dark:bg-zinc-700 dark:text-zinc-200"
                      : "text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
                  }`}
                >
                  {mode === "chart" ? "Chart" : mode === "both" ? "Both" : "Table"}
                </button>
              ))}
            </div>
          )}

          {hasData && showChart && (
            <div className="px-3 py-2">
              <ResultChart headers={columns} rows={stringRows} dark={dark} detectionResult={chartResult} />
            </div>
          )}

          {hasData && showTable && <DataTable columns={columns} rows={rows} />}

          {!hasData && (
            <div className="px-3 py-2 text-xs text-zinc-500 dark:text-zinc-400">
              Query returned 0 rows.
            </div>
          )}

          <div className="flex items-center gap-2 px-3 py-2">
            {sql && (
              <button
                onClick={() => setSqlOpen(!sqlOpen)}
                className="rounded border border-zinc-200 px-2 py-1 text-xs text-zinc-500 transition-colors hover:border-zinc-400 hover:text-zinc-800 dark:border-zinc-700 dark:text-zinc-400 dark:hover:border-zinc-500 dark:hover:text-zinc-200"
              >
                {sqlOpen ? "Hide SQL" : "Show SQL"}
              </button>
            )}
            {hasData && (
              <button
                onClick={() => downloadCSV(toCsvString(columns, rows))}
                className="rounded border border-zinc-200 px-2 py-1 text-xs text-zinc-500 transition-colors hover:border-zinc-400 hover:text-zinc-800 dark:border-zinc-700 dark:text-zinc-400 dark:hover:border-zinc-500 dark:hover:text-zinc-200"
              >
                Download CSV
              </button>
            )}
          </div>
          {sqlOpen && sql && (
            <div className="px-3 pb-2">
              <SQLBlock sql={sql} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
