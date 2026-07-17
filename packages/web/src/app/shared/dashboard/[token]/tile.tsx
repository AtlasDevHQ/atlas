"use client";

import dynamic from "next/dynamic";
import { Clock } from "lucide-react";
import { Card } from "@/components/ui/card";
import { useDarkMode } from "@/ui/hooks/use-dark-mode";
import { DataTable } from "@/ui/components/chat/data-table";
import { Markdown } from "@/ui/components/chat/markdown";
import { KpiCard } from "@/ui/components/dashboards/kpi-card";
import { ResultCardErrorBoundary } from "@/ui/components/chat/result-card-base";
import type { SharedCard } from "./types";

const ResultChart = dynamic(
  () => import("@/ui/components/chart/result-chart").then((m) => ({ default: m.ResultChart })),
  { ssr: false, loading: () => <div className="h-48 animate-pulse rounded-lg bg-zinc-100 dark:bg-zinc-800" /> },
);

function toStringRows(columns: string[], rows: Record<string, unknown>[]): string[][] {
  return rows.map((row) => columns.map((col) => (row[col] == null ? "" : String(row[col] as string))));
}

/** Cached rows come from a JSONB column — drop anything that isn't a plain object so a stale or corrupt row can't crash render. */
function validateRows(raw: unknown[] | null): Record<string, unknown>[] {
  if (!raw) return [];
  return raw.filter(
    (r): r is Record<string, unknown> => typeof r === "object" && r !== null && !Array.isArray(r),
  );
}

export interface SharedTileProps {
  card: SharedCard;
  spanClass: string;
  /** Pre-computed on the server so SSR text matches client text exactly (no `Date.now()` drift). */
  cachedLabel: string | null;
  cachedIso: string | undefined;
  /**
   * Forced chart theme for the embed surface. The chrome themes off the embed's
   * `.dark` wrapper, but the chart is JS-themed (`useDarkMode()` resolves from
   * the visitor's OWN preference — localStorage mode + `prefers-color-scheme` —
   * never the wrapper's `.dark` class), so a forced `?theme=` embed must pass its
   * resolved theme here or the chart would disagree with the chrome. `undefined`
   * → follow the visitor's system theme.
   */
  forcedDark?: boolean;
}

export function SharedTile({ card, spanClass, cachedLabel, cachedIso, forcedDark }: SharedTileProps) {
  const systemDark = useDarkMode();
  const dark = forcedDark ?? systemDark;

  // #3138 — a text / section-block card renders sanitized markdown (no data, no
  // chart, no cached-at footer) so a shared-link viewer sees the same headers
  // the owner authored — not the empty-data placeholder.
  //   - Full-width (`md:col-span-2`) regardless of the inherited `spanClass`:
  //     the shared view doesn't run `withAutoLayout`, so a text card with
  //     `layout: null` would otherwise inherit the default half-width span and
  //     stop reading as a banner over the charts beneath it.
  //   - `disallowImages`: this is an unauthenticated surface, so block markdown
  //     image fetches (tracking-pixel / IP-leak vector — see Markdown docs).
  if (card.kind === "text") {
    return (
      <Card
        className="md:col-span-2 overflow-hidden px-4 py-3 text-sm leading-relaxed print:col-span-2 print:break-inside-avoid print:border-zinc-300 print:shadow-none"
        data-card-kind="text"
      >
        <Markdown content={card.content ?? ""} disallowImages />
      </Card>
    );
  }

  const columns = card.cachedColumns ?? [];
  const rows = validateRows(card.cachedRows);
  const hasData = columns.length > 0 && rows.length > 0;
  const stringRows = hasData ? toStringRows(columns, rows) : [];
  const chartType = card.chartConfig?.type;
  // #3137 — a KPI card renders the compact scorecard (big number + sparkline)
  // from cached data. The shared view has no /render endpoint, so there's no
  // comparison delta here — just the headline value.
  const isKpi = chartType === "kpi";
  const showChart = hasData && chartType && chartType !== "table" && !isKpi;

  return (
    <Card className={`${spanClass} overflow-hidden print:col-span-2 print:break-inside-avoid print:border-zinc-300 print:shadow-none`}>
      <div className="flex items-center justify-between gap-3 border-b border-zinc-100 px-4 py-3 dark:border-zinc-800 print:border-zinc-300">
        <h2 className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">
          {card.title}
        </h2>
        {cachedLabel && (
          <time
            dateTime={cachedIso}
            className="inline-flex shrink-0 items-center gap-1 text-xs text-zinc-600 dark:text-zinc-400"
          >
            <Clock className="size-3" aria-hidden="true" />
            {cachedLabel}
          </time>
        )}
      </div>
      {hasData ? (
        isKpi ? (
          <div className="px-4 py-5">
            <KpiCard card={card} />
          </div>
        ) : (
          <div>
            {showChart && (
              <ResultCardErrorBoundary label="Chart">
                <div className="px-4 py-3">
                  <ResultChart
                    headers={columns}
                    rows={stringRows}
                    dark={dark}
                    thresholds={card.chartConfig?.thresholds}
                    annotations={card.annotations}
                  />
                </div>
              </ResultCardErrorBoundary>
            )}
            <DataTable columns={columns} rows={rows} />
          </div>
        )
      ) : (
        <div className="px-4 py-8 text-center text-xs text-zinc-600 dark:text-zinc-400">
          No data available for this tile.
        </div>
      )}
    </Card>
  );
}
