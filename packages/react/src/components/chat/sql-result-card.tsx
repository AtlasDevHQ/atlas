"use client";

import { lazy, Suspense, useContext, useMemo, useState, type ReactNode } from "react";
import { getToolArgs, getToolResult, isToolComplete, downloadCSV, downloadExcel, toCsvString } from "../../lib/helpers";
import { FileDown, FileSpreadsheet } from "lucide-react";
import { DarkModeContext } from "../../hooks/use-dark-mode";
import { detectCharts, type ChartDetectionResult } from "../chart/chart-detection";
import { LoadingCard } from "./loading-card";
import { DataTable } from "./data-table";
import { SQLBlock } from "./sql-block";
import { ResultCardBase, ResultCardErrorBoundary } from "./result-card-base";

const ResultChart = lazy(() => import("../chart/result-chart").then((m) => ({ default: m.ResultChart })));
const ChartFallback = <div className="h-64 animate-pulse rounded-lg bg-zinc-100 dark:bg-zinc-800" />;

/** Convert structured rows (Record<string, unknown>[]) to string[][] for chart detection. */
function toStringRows(columns: string[], rows: Record<string, unknown>[]): string[][] {
  return rows.map((row) => columns.map((col) => (row[col] == null ? "" : String(row[col]))));
}

/** Snapshot of a prior SQL execution for rerun comparison display. */
export interface PreviousExecution {
  executionMs?: number;
  rowCount?: number;
}

/**
 * Everything a host-provided action slot needs to act on the rendered result —
 * the parsed tool output plus the chart detection over it. Handed to
 * `renderActions` so e.g. @atlas/web can mount its add-to-dashboard button /
 * dialog without this card knowing dashboards exist.
 */
export interface SqlResultActionContext {
  sql: string;
  columns: string[];
  rows: Record<string, unknown>[];
  chartResult: ChartDetectionResult;
  explanation: string;
}

export interface SQLResultCardProps {
  part: unknown;
  /** Rerun comparison metadata — renders "(was …)" next to the timing. */
  previousExecution?: PreviousExecution;
  /** Total occurrences when the page-level renderer has collapsed identical failures. >= 2 renders a "Tried N times" badge; otherwise omitted. */
  repeatedCount?: number;
  /**
   * Per-side dark-mode seam: hosts with their own theme store pass the
   * resolved value; omitted, it falls back to the package's `DarkModeContext`.
   * The resolved value is re-provided to descendants (SQLBlock, charts).
   */
  dark?: boolean;
  /** Slot rendered at the start of the header meta span (e.g. web's "on dashboard" badge). */
  headerBadge?: ReactNode;
  /**
   * Slot rendered after the built-in CSV / Excel buttons in the actions row —
   * only when the result has data. The host owns any state it needs (e.g. a
   * dialog's open flag) inside the returned element.
   */
  renderActions?: (ctx: SqlResultActionContext) => ReactNode;
  /** Host override for loading the optional `exceljs` peer — see `downloadExcel`. */
  loadExcelJS?: () => Promise<unknown>;
}

export function SQLResultCard(props: SQLResultCardProps) {
  return (
    <ResultCardErrorBoundary label="SQL">
      <SQLResultCardInner {...props} />
    </ResultCardErrorBoundary>
  );
}

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

  const ms = prev.executionMs;
  if (typeof ms === "number" && Number.isFinite(ms)) {
    parts.push(`${(ms / 1000).toFixed(1)}s`);
  }

  return parts.length > 0 ? `was ${parts.join(" · ")}` : null;
}

function SQLResultCardInner({
  part,
  previousExecution,
  repeatedCount,
  dark,
  headerBadge,
  renderActions,
  loadExcelJS,
}: SQLResultCardProps) {
  const ctxDark = useContext(DarkModeContext);
  const isDark = dark ?? ctxDark;
  const args = getToolArgs(part);
  const result = getToolResult(part) as Record<string, unknown> | null;
  const done = isToolComplete(part);
  const [sqlOpen, setSqlOpen] = useState(false);
  const [viewMode, setViewMode] = useState<"both" | "chart" | "table">("both");
  const [excelError, setExcelError] = useState(false);

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
    const errorMessage =
      typeof result.error === "string" && result.error.trim()
        ? result.error
        : "Query failed.";
    const explanation =
      typeof args.explanation === "string" && args.explanation.trim()
        ? args.explanation
        : null;
    const repeatBadge =
      typeof repeatedCount === "number" && repeatedCount > 1
        ? `Tried ${repeatedCount} times`
        : null;
    return (
      <div className="rounded-md border border-red-300 bg-red-50 px-3 py-1.5 text-xs text-red-700 dark:border-red-900/50 dark:bg-red-950/20 dark:text-red-400">
        <div className="flex items-start justify-between gap-2">
          {explanation && <p className="font-medium">{explanation}</p>}
          {repeatBadge && (
            <span className="shrink-0 rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-red-700 dark:bg-red-950/40 dark:text-red-400">
              {repeatBadge}
            </span>
          )}
        </div>
        <p className={explanation ? "mt-0.5 opacity-80" : ""}>{errorMessage}</p>
        {sql && (
          <pre className="mt-1.5 max-h-24 overflow-auto whitespace-pre-wrap rounded bg-red-100/60 px-2 py-1 font-mono text-xs leading-snug text-red-900 dark:bg-red-950/40 dark:text-red-300">
            {sql}
          </pre>
        )}
      </div>
    );
  }

  const hasData = columns.length > 0 && rows.length > 0;
  const showChart = chartResult.chartable && (viewMode === "chart" || viewMode === "both");
  const showTable = viewMode === "table" || viewMode === "both" || !chartResult.chartable;

  return (
    // Re-provide the resolved dark value so context-reading descendants
    // (SQLBlock's syntax theme, host action slots) agree with the charts.
    <DarkModeContext.Provider value={isDark}>
      <ResultCardBase
        badge="SQL"
        badgeClassName="bg-primary/15 text-primary dark:bg-primary/20 dark:text-primary"
        title={String(args.explanation ?? "Query result")}
        headerExtra={
          <span className="flex items-center gap-1.5 text-zinc-500">
            {headerBadge}
            {rows.length} row{rows.length !== 1 ? "s" : ""}
            {result.truncated ? "+" : ""}
            {typeof result.executionMs === "number" && Number.isFinite(result.executionMs) && (
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
            <Suspense fallback={ChartFallback}>
              <ResultChart headers={columns} rows={stringRows} dark={isDark} detectionResult={chartResult} />
            </Suspense>
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
                downloadExcel(columns, rows, undefined, loadExcelJS).catch((err: unknown) => {
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
          {hasData &&
            renderActions?.({
              sql,
              columns,
              rows,
              chartResult,
              explanation: String(args.explanation ?? ""),
            })}
          {excelError && (
            <span className="text-xs text-red-500 dark:text-red-400">Excel download failed</span>
          )}
        </div>
        {sqlOpen && sql && (
          <div className="px-3 pb-2">
            <SQLBlock sql={sql} />
          </div>
        )}
      </ResultCardBase>
    </DarkModeContext.Provider>
  );
}
