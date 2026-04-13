"use client";

import { useMemo, useState } from "react";
import { getToolArgs, getToolResult, isToolComplete, downloadCSV, downloadExcel, toCsvString } from "../../lib/helpers";
import { FileDown, FileSpreadsheet, LayoutDashboard } from "lucide-react";
import { useDarkMode } from "../../hooks/use-dark-mode";
import { detectCharts } from "../chart/chart-detection";
import dynamic from "next/dynamic";
import { useDashboardBridge } from "../notebook/dashboard-bridge-context";
import type { PreviousExecution } from "../notebook/types";

const ResultChart = dynamic(
  () => import("../chart/result-chart").then((m) => ({ default: m.ResultChart })),
  { ssr: false, loading: () => <div className="h-64 animate-pulse rounded-lg bg-zinc-100 dark:bg-zinc-800" /> },
);
import { LoadingCard } from "./loading-card";
import { DataTable } from "./data-table";
import { SQLBlock } from "./sql-block";
import { ResultCardBase, ResultCardErrorBoundary } from "./result-card-base";

/** Convert structured rows (Record<string, unknown>[]) to string[][] for chart detection. */
function toStringRows(columns: string[], rows: Record<string, unknown>[]): string[][] {
  return rows.map((row) => columns.map((col) => (row[col] == null ? "" : String(row[col]))));
}


export function SQLResultCard({ part, previousExecution }: { part: unknown; previousExecution?: PreviousExecution }) {
  return (
    <ResultCardErrorBoundary label="SQL">
      <SQLResultCardInner part={part} previousExecution={previousExecution} />
    </ResultCardErrorBoundary>
  );
}

const AddToDashboardDialog = dynamic(
  () => import("./add-to-dashboard-dialog").then((m) => ({ default: m.AddToDashboardDialog })),
  { ssr: false, loading: () => null },
);

/** Build a human-readable comparison string, e.g. "was 3.4s" or "was 512 rows · 3.4s" (row count shown only when changed). */
function formatPreviousExecution(
  prev: PreviousExecution,
  currentRowCount: number,
): string | null {
  const parts: string[] = [];

  // Show previous row count only if it differs from current
  if (prev.rowCount != null && prev.rowCount !== currentRowCount) {
    parts.push(`${prev.rowCount} row${prev.rowCount !== 1 ? "s" : ""}`);
  }

  if (Number.isFinite(prev.executionMs)) {
    parts.push(`${(prev.executionMs! / 1000).toFixed(1)}s`);
  }

  return parts.length > 0 ? `was ${parts.join(" · ")}` : null;
}

function SQLResultCardInner({ part, previousExecution }: { part: unknown; previousExecution?: PreviousExecution }) {
  const dark = useDarkMode();
  const bridge = useDashboardBridge();
  const args = getToolArgs(part);
  const result = getToolResult(part) as Record<string, unknown> | null;
  const done = isToolComplete(part);
  const [sqlOpen, setSqlOpen] = useState(false);
  const [viewMode, setViewMode] = useState<"both" | "chart" | "table">("both");
  const [excelError, setExcelError] = useState(false);
  const [dashboardDialogOpen, setDashboardDialogOpen] = useState(false);

  // In notebook context, track which cell this result belongs to
  const cellId = bridge?.cellId ?? null;
  const isOnDashboard = cellId ? !!bridge?.dashboardCards[cellId] : false;

  function handleDashboardAdded(dashboardId: string, cardId: string) {
    if (!bridge) return; // Not in notebook context
    if (!cellId) {
      console.warn("Dashboard card added but cellId is null in bridge context — tracking skipped.");
      return;
    }
    bridge.onDashboardCardAdded(cellId, { dashboardId, cardId });
  }

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
    <ResultCardBase
      badge="SQL"
      badgeClassName="bg-primary/15 text-primary dark:bg-primary/20 dark:text-primary"
      title={String(args.explanation ?? "Query result")}
      headerExtra={
        <span className="flex items-center gap-1.5 text-zinc-500">
          {isOnDashboard && (
            <span
              className="inline-flex items-center gap-1 rounded bg-emerald-100 px-1.5 py-0.5 text-emerald-700 dark:bg-emerald-600/20 dark:text-emerald-400"
              title="Added to dashboard"
            >
              <LayoutDashboard className="size-3" />
            </span>
          )}
          {rows.length} row{rows.length !== 1 ? "s" : ""}
          {result.truncated ? "+" : ""}
          {Number.isFinite(result.executionMs) && (
            <> · {result.cached ? "cached" : `${(result.executionMs / 1000).toFixed(1)}s`}</>
          )}
          {previousExecution && (() => {
            const comparison = formatPreviousExecution(previousExecution, rows.length);
            return comparison ? <span className="text-zinc-400 dark:text-zinc-500"> ({comparison})</span> : null;
          })()}
        </span>
      }
    >
      {hasData && chartResult.chartable && (
        <div className="flex gap-1 px-3 pt-2">
          {(["chart", "both", "table"] as const).map((mode) => (
            <button
              key={mode}
              onClick={() => setViewMode(mode)}
              className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
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

      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        {sql && (
          <button
            onClick={() => setSqlOpen(!sqlOpen)}
            className="rounded border border-zinc-200 px-2 py-1.5 text-xs text-zinc-500 transition-colors hover:border-zinc-400 hover:text-zinc-800 dark:border-zinc-700 dark:text-zinc-400 dark:hover:border-zinc-500 dark:hover:text-zinc-200"
          >
            {sqlOpen ? "Hide SQL" : "Show SQL"}
          </button>
        )}
        {hasData && (
          <button
            onClick={() => downloadCSV(toCsvString(columns, rows))}
            className="inline-flex items-center gap-1.5 rounded border border-zinc-200 px-2 py-1.5 text-xs text-zinc-500 transition-colors hover:border-zinc-400 hover:text-zinc-800 dark:border-zinc-700 dark:text-zinc-400 dark:hover:border-zinc-500 dark:hover:text-zinc-200"
            title="Download CSV"
          >
            <FileDown className="size-3.5" />
            <span className="hidden sm:inline">CSV</span>
          </button>
        )}
        {hasData && (
          <button
            onClick={() => {
              setExcelError(false);
              downloadExcel(columns, rows).catch((err: unknown) => {
                console.warn("Excel download failed:", err);
                setExcelError(true);
              });
            }}
            className="inline-flex items-center gap-1.5 rounded border border-zinc-200 px-2 py-1.5 text-xs text-zinc-500 transition-colors hover:border-zinc-400 hover:text-zinc-800 dark:border-zinc-700 dark:text-zinc-400 dark:hover:border-zinc-500 dark:hover:text-zinc-200"
            title="Download Excel"
          >
            <FileSpreadsheet className="size-3.5" />
            <span className="hidden sm:inline">Excel</span>
          </button>
        )}
        {hasData && (
          <button
            onClick={() => setDashboardDialogOpen(true)}
            className="inline-flex items-center gap-1.5 rounded border border-zinc-200 px-2 py-1.5 text-xs text-zinc-500 transition-colors hover:border-zinc-400 hover:text-zinc-800 dark:border-zinc-700 dark:text-zinc-400 dark:hover:border-zinc-500 dark:hover:text-zinc-200"
            title="Add to dashboard"
          >
            <LayoutDashboard className="size-3.5" />
            <span className="hidden sm:inline">Dashboard</span>
          </button>
        )}
        {excelError && (
          <span className="text-xs text-red-500 dark:text-red-400">Excel download failed</span>
        )}
      </div>
      {hasData && dashboardDialogOpen && (
        <ResultCardErrorBoundary label="Dashboard dialog">
          <AddToDashboardDialog
            open={dashboardDialogOpen}
            onOpenChange={setDashboardDialogOpen}
            sql={sql}
            columns={columns}
            rows={rows}
            chartResult={chartResult}
            explanation={String(args.explanation ?? "")}
            onAdded={handleDashboardAdded}
          />
        </ResultCardErrorBoundary>
      )}
      {sqlOpen && sql && (
        <div className="px-3 pb-2">
          <SQLBlock sql={sql} />
        </div>
      )}
    </ResultCardBase>
  );
}
