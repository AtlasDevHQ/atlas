"use client";

import { useContext } from "react";
import dynamic from "next/dynamic";
import { Card } from "@/components/ui/card";
import { DarkModeContext } from "@/ui/hooks/use-dark-mode";
import { DataTable } from "@/ui/components/chat/data-table";
import { ResultCardErrorBoundary } from "@/ui/components/chat/result-card-base";
import { Clock } from "lucide-react";
import type { SharedDashboard, SharedCard } from "./types";

const ResultChart = dynamic(
  () => import("@/ui/components/chart/result-chart").then((m) => ({ default: m.ResultChart })),
  { ssr: false, loading: () => <div className="h-48 animate-pulse rounded-lg bg-zinc-100 dark:bg-zinc-800" /> },
);

function toStringRows(columns: string[], rows: Record<string, unknown>[]): string[][] {
  return rows.map((row) => columns.map((col) => (row[col] == null ? "" : String(row[col]))));
}

function timeAgo(iso: string | null): string {
  if (!iso) return "never";
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

/** Validate that cachedRows entries are actually objects. */
function validateRows(raw: unknown[] | null): Record<string, unknown>[] {
  if (!raw) return [];
  return raw.filter(
    (r): r is Record<string, unknown> => typeof r === "object" && r !== null && !Array.isArray(r),
  );
}

function SharedCardView({ card }: { card: SharedCard }) {
  const dark = useContext(DarkModeContext);
  const columns = card.cachedColumns ?? [];
  const rows = validateRows(card.cachedRows);
  const hasData = columns.length > 0 && rows.length > 0;
  const stringRows = hasData ? toStringRows(columns, rows) : [];
  const chartConfig = card.chartConfig as { type?: string } | null;

  return (
    <Card className="overflow-hidden">
      <div className="flex items-center justify-between border-b border-zinc-100 px-4 py-3 dark:border-zinc-800">
        <h3 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
          {card.title}
        </h3>
        <span className="text-xs text-zinc-400 dark:text-zinc-500">
          <Clock className="mr-0.5 inline size-3" />
          {timeAgo(card.cachedAt)}
        </span>
      </div>
      {hasData ? (
        <div>
          {chartConfig && chartConfig.type && chartConfig.type !== "table" && (
            <ResultCardErrorBoundary label="Chart">
              <div className="px-4 py-3">
                <ResultChart headers={columns} rows={stringRows} dark={dark} />
              </div>
            </ResultCardErrorBoundary>
          )}
          <DataTable columns={columns} rows={rows} />
        </div>
      ) : (
        <div className="px-4 py-8 text-center text-xs text-zinc-500 dark:text-zinc-400">
          No data available for this card.
        </div>
      )}
    </Card>
  );
}

export function SharedDashboardView({ dashboard }: { dashboard: SharedDashboard }) {
  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <header className="mb-8 border-b border-zinc-200 pb-4 dark:border-zinc-800">
        <div className="flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400">
          <span className="font-medium text-zinc-900 dark:text-zinc-100">Atlas</span>
          <span aria-hidden="true">&middot;</span>
          <span>Shared dashboard</span>
          <span aria-hidden="true">&middot;</span>
          <span>{dashboard.cards.length} card{dashboard.cards.length !== 1 ? "s" : ""}</span>
        </div>
        <h1 className="mt-2 text-xl font-semibold text-zinc-900 dark:text-zinc-100">
          {dashboard.title}
        </h1>
        {dashboard.description && (
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            {dashboard.description}
          </p>
        )}
      </header>

      {dashboard.cards.length === 0 ? (
        <p className="py-12 text-center text-sm text-zinc-500 dark:text-zinc-400">
          This dashboard has no cards yet.
        </p>
      ) : (
        <div className="space-y-4">
          {dashboard.cards.map((card) => (
            <ResultCardErrorBoundary key={card.id} label={card.title}>
              <SharedCardView card={card} />
            </ResultCardErrorBoundary>
          ))}
        </div>
      )}
    </div>
  );
}
