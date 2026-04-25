"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, Check, ChevronDown, LayoutGrid, Plus } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { friendlyError } from "@/ui/lib/fetch-error";
import { cn } from "@/lib/utils";
import { sortDashboardsByRecent } from "@/app/dashboards/select-recent";
import { NewDashboardDialog, defaultOnDashboardCreated } from "./new-dashboard-dialog";
import { ViewAllDashboardsModal } from "./view-all-modal";
import type { Dashboard } from "@/ui/lib/types";

interface DashboardSwitcherProps {
  currentId: string;
}

export function DashboardSwitcher({ currentId }: DashboardSwitcherProps) {
  const router = useRouter();
  const [createOpen, setCreateOpen] = useState(false);
  const [viewAllOpen, setViewAllOpen] = useState(false);

  const { data, loading, error, refetch } = useAdminFetch<{ dashboards: Dashboard[] }>(
    "/api/v1/dashboards",
  );

  const sorted = sortDashboardsByRecent(data?.dashboards ?? []);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="Switch dashboard"
            className="-ml-1 inline-flex size-7 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
          >
            <ChevronDown className="size-4" aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="w-72 max-w-[90vw] p-1"
          // Don't auto-focus the active item — keyboard users land on the first
          // item, which is the most-recently-updated dashboard. The active one
          // is marked visually for orientation.
        >
          <DropdownMenuLabel className="px-2 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
            Dashboards
          </DropdownMenuLabel>
          {error ? (
            <div
              role="alert"
              className="space-y-1.5 px-2 py-2 text-xs text-red-700 dark:text-red-400"
            >
              <div className="flex items-start gap-1.5">
                <AlertCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                <span>{friendlyError(error)}</span>
              </div>
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  refetch();
                }}
                className="ml-5 underline hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Retry
              </button>
            </div>
          ) : loading && sorted.length === 0 ? (
            <div className="px-2 py-2 text-xs text-zinc-500 dark:text-zinc-400">
              Loading…
            </div>
          ) : sorted.length === 0 ? (
            <div className="px-2 py-2 text-xs text-zinc-500 dark:text-zinc-400">
              No other dashboards yet.
            </div>
          ) : (
            <div className="max-h-64 overflow-y-auto">
              {sorted.map((d) => {
                const active = d.id === currentId;
                return (
                  <DropdownMenuItem
                    key={d.id}
                    onSelect={() => {
                      if (!active) router.push(`/dashboards/${d.id}`);
                    }}
                    className={cn(
                      "cursor-pointer gap-2 pl-2 pr-2",
                      active && "bg-zinc-100/70 dark:bg-zinc-800/70",
                    )}
                    aria-current={active ? "page" : undefined}
                  >
                    <span className="flex size-4 shrink-0 items-center justify-center text-primary">
                      {active ? <Check className="size-3.5" aria-hidden="true" /> : null}
                    </span>
                    <span className="flex-1 truncate text-sm">{d.title}</span>
                    <span className="shrink-0 text-[11px] tabular-nums text-zinc-400 dark:text-zinc-500">
                      {d.cardCount}
                    </span>
                  </DropdownMenuItem>
                );
              })}
            </div>
          )}

          <DropdownMenuSeparator />

          <DropdownMenuItem
            onSelect={() => setCreateOpen(true)}
            className="cursor-pointer gap-2 text-sm"
          >
            <Plus className="size-4 text-zinc-500" aria-hidden="true" />
            New dashboard
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => setViewAllOpen(true)}
            className="cursor-pointer gap-2 text-sm"
          >
            <LayoutGrid className="size-4 text-zinc-500" aria-hidden="true" />
            View all
            {!loading && !error && sorted.length > 0 && (
              <span className="ml-auto text-[11px] tabular-nums text-zinc-400 dark:text-zinc-500">
                {sorted.length}
              </span>
            )}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <NewDashboardDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={defaultOnDashboardCreated(router)}
      />
      <ViewAllDashboardsModal
        open={viewAllOpen}
        onOpenChange={setViewAllOpen}
        currentId={currentId}
      />
    </>
  );
}
