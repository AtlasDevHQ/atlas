"use client";

/**
 * Cross-filter chips bar (#3213).
 *
 * A glanceable summary of the active cross-filters — the parameter overrides set
 * by clicking a chart element / table row (drilldown, #3212) or the parameter
 * bar. Each chip shows `<label>: <value>` with a per-chip remove (×) and a
 * Clear-all. Purely presentational: the page derives `filters` from the shared
 * `dparams` URL state (so the bar is URL-shareable + survives reload) and wires
 * the handlers back to the same nuqs key. Removing a chip / clearing flows
 * through the parameter bar's single batched re-render, so one action triggers
 * one refetch — never N sequential requests.
 */

import { Filter, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ActiveFilter } from "@/app/(workspace)/dashboards/[id]/cross-filter";

interface DashboardFilterChipsProps {
  /** Active cross-filters, one chip each. Empty → the bar renders nothing. */
  filters: ActiveFilter[];
  /** Remove a single filter (its declared parameter key). */
  onRemove: (key: string) => void;
  /** Clear every active cross-filter at once. */
  onClearAll: () => void;
}

export function DashboardFilterChips({ filters, onRemove, onClearAll }: DashboardFilterChipsProps) {
  if (filters.length === 0) return null;

  return (
    <div
      role="group"
      aria-label="Active filters"
      data-testid="dashboard-filter-chips"
      className="mx-4 mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-zinc-200 bg-zinc-50/60 px-3 py-2 sm:mx-6 dark:border-zinc-800 dark:bg-zinc-900/40"
    >
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-zinc-500 dark:text-zinc-400">
        <Filter className="size-3.5" aria-hidden="true" />
        Filters
      </span>

      {filters.map((f) => (
        <Badge
          key={f.key}
          variant="secondary"
          className="gap-1 py-1 pr-1 pl-2 text-xs"
          data-testid={`filter-chip-${f.key}`}
        >
          <span className="text-zinc-500 dark:text-zinc-400">{f.label}:</span>
          <span className="font-medium">{f.value}</span>
          <button
            type="button"
            aria-label={`Remove ${f.label} filter`}
            onClick={() => onRemove(f.key)}
            className={cn(
              "ml-0.5 inline-flex size-4 items-center justify-center rounded-full text-zinc-500 transition-colors",
              "hover:bg-zinc-300/70 hover:text-zinc-800 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
              "dark:hover:bg-zinc-700 dark:hover:text-zinc-100",
            )}
          >
            <X className="size-3" aria-hidden="true" />
          </button>
        </Badge>
      ))}

      <Button
        variant="ghost"
        size="sm"
        className="h-7 text-xs text-zinc-500"
        onClick={onClearAll}
      >
        Clear all
      </Button>
    </div>
  );
}
