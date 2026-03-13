"use client";

import { useState, type ComponentProps } from "react";
import { formatCell } from "../../lib/helpers";
import { ErrorBoundary } from "../error-boundary";

function DataTableInner({
  columns,
  rows,
  maxRows = 10,
}: {
  columns: string[];
  rows: (Record<string, unknown> | unknown[])[];
  maxRows?: number;
}) {
  const [sortCol, setSortCol] = useState<number | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-zinc-200 px-4 py-8 text-center dark:border-zinc-700">
        <p className="text-sm font-medium text-zinc-500 dark:text-zinc-400">
          Query returned no results
        </p>
        <p className="mt-1 text-xs text-zinc-400 dark:text-zinc-500">
          Try adjusting your query filters or criteria
        </p>
      </div>
    );
  }

  const hasMore = rows.length > maxRows;

  const cell = (row: Record<string, unknown> | unknown[], colIdx: number): unknown => {
    if (Array.isArray(row)) return row[colIdx];
    return (row as Record<string, unknown>)[columns[colIdx]];
  };

  const handleSort = (colIdx: number) => {
    if (sortCol === colIdx) {
      if (sortDir === "asc") {
        setSortDir("desc");
      } else {
        setSortCol(null);
        setSortDir("asc");
      }
    } else {
      setSortCol(colIdx);
      setSortDir("asc");
    }
  };

  const sorted = sortCol !== null
    ? [...rows].sort((a, b) => {
        const av = cell(a, sortCol);
        const bv = cell(b, sortCol);
        if (av == null && bv == null) return 0;
        if (av == null) return 1;
        if (bv == null) return -1;
        const aStr = String(av).trim();
        const bStr = String(bv).trim();
        if (aStr === "" && bStr === "") return 0;
        if (aStr === "") return 1;
        if (bStr === "") return -1;
        const an = Number(aStr), bn = Number(bStr);
        if (!isNaN(an) && !isNaN(bn)) {
          return sortDir === "asc" ? an - bn : bn - an;
        }
        const cmp = aStr.localeCompare(bStr);
        return sortDir === "asc" ? cmp : -cmp;
      })
    : rows;
  const display = sorted.slice(0, maxRows);

  return (
    <div className="relative rounded-lg border border-zinc-200 dark:border-zinc-700">
      <div className="overflow-x-auto [&::-webkit-scrollbar]:h-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-zinc-300 dark:[&::-webkit-scrollbar-thumb]:bg-zinc-600">
      <table className="min-w-full text-xs">
        <thead>
          <tr className="border-b border-zinc-200 bg-zinc-100/80 dark:border-zinc-700 dark:bg-zinc-800/80">
            {columns.map((col, i) => (
              <th
                key={i}
                onClick={() => handleSort(i)}
                className="group cursor-pointer select-none whitespace-nowrap px-3 py-2 text-left font-medium text-zinc-500 transition-colors hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
              >
                {col}
                {sortCol === i
                  ? sortDir === "asc" ? " \u25B2" : " \u25BC"
                  : ""}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {display.map((row, i) => (
            <tr
              key={i}
              className={i % 2 === 0 ? "bg-zinc-100/60 dark:bg-zinc-900/60" : "bg-zinc-50/30 dark:bg-zinc-900/30"}
            >
              {columns.map((_, j) => (
                <td key={j} className="whitespace-nowrap px-3 py-1.5 text-zinc-700 dark:text-zinc-300">
                  {formatCell(cell(row, j))}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      </div>
      {hasMore && (
        <div className="border-t border-zinc-200 px-3 py-1.5 text-xs text-zinc-500 dark:border-zinc-700">
          Showing {maxRows} of {rows.length} rows
        </div>
      )}
    </div>
  );
}

export function DataTable(props: ComponentProps<typeof DataTableInner>) {
  return (
    <ErrorBoundary
      fallbackRender={(_error, reset) => (
        <div className="flex items-center justify-between rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900/50 dark:bg-red-950/20 dark:text-red-400">
          <span>Unable to render results.</span>
          <button onClick={reset} className="underline">Retry</button>
        </div>
      )}
    >
      <DataTableInner {...props} />
    </ErrorBoundary>
  );
}
