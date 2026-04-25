"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { BarChart3, Clock, Plus, Search, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import { friendlyError } from "@/ui/lib/fetch-error";
import { cn } from "@/lib/utils";
import { sortDashboardsByRecent } from "@/app/dashboards/select-recent";
import { NewDashboardDialog } from "./new-dashboard-dialog";
import { timeAgo } from "./time-ago";
import type { Dashboard } from "@/ui/lib/types";

interface ViewAllDashboardsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentId: string;
}

const SEARCH_THRESHOLD = 6;

export function ViewAllDashboardsModal({
  open,
  onOpenChange,
  currentId,
}: ViewAllDashboardsModalProps) {
  const router = useRouter();
  const { data, loading, error, refetch } = useAdminFetch<{
    dashboards: Dashboard[];
    total: number;
  }>("/api/v1/dashboards");

  const {
    mutate: deleteDashboard,
    error: deleteError,
    clearError: clearDeleteError,
  } = useAdminMutation({ invalidates: refetch });

  const [createOpen, setCreateOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Dashboard | null>(null);
  const [search, setSearch] = useState("");

  const sorted = sortDashboardsByRecent(data?.dashboards ?? []);
  const filtered = search.trim()
    ? sorted.filter((d) =>
        d.title.toLowerCase().includes(search.trim().toLowerCase()),
      )
    : sorted;

  const showSearch = sorted.length > SEARCH_THRESHOLD;

  async function handleDelete() {
    if (!deleteTarget) return;
    const wasCurrent = deleteTarget.id === currentId;
    const result = await deleteDashboard({
      path: `/api/v1/dashboards/${deleteTarget.id}`,
      method: "DELETE",
    });
    if (!result.ok) {
      // Keep the alert dialog open so the user sees the failure inline
      // rather than the row silently reappearing under the modal.
      return;
    }
    setDeleteTarget(null);
    if (wasCurrent) {
      onOpenChange(false);
      router.push("/dashboards");
    }
  }

  function handleCardClick(d: Dashboard) {
    onOpenChange(false);
    if (d.id !== currentId) router.push(`/dashboards/${d.id}`);
  }

  function handleCreated(d: Dashboard) {
    onOpenChange(false);
    router.push(`/dashboards/${d.id}`);
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-h-[85vh] overflow-hidden p-0 sm:max-w-3xl">
          <DialogHeader className="px-6 pb-3 pt-5">
            <div className="flex items-end justify-between gap-3">
              <div>
                <DialogTitle className="text-base">All dashboards</DialogTitle>
                <DialogDescription className="text-xs">
                  Manage every dashboard in this workspace.
                </DialogDescription>
              </div>
              <Button size="sm" onClick={() => setCreateOpen(true)}>
                <Plus className="mr-1.5 size-3.5" aria-hidden="true" />
                New
              </Button>
            </div>
            {showSearch && (
              <div className="relative pt-3">
                <Search
                  className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 pt-1.5 text-zinc-400"
                  aria-hidden="true"
                />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search by name…"
                  aria-label="Filter dashboards"
                  className="h-9 pl-8"
                />
              </div>
            )}
          </DialogHeader>

          {deleteError && (
            <div
              role="alert"
              className="mx-6 mt-1 flex items-start gap-2 rounded-md border border-red-200 bg-red-50/80 px-3 py-2 text-xs text-red-700 dark:border-red-900/50 dark:bg-red-950/20 dark:text-red-400"
            >
              <span className="flex-1">
                Couldn&rsquo;t delete dashboard. {friendlyError(deleteError)}
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="h-5 px-1.5 text-xs"
                onClick={() => clearDeleteError()}
              >
                Dismiss
              </Button>
            </div>
          )}

          <div className="max-h-[60vh] overflow-y-auto px-6 pb-6">
            {loading && (
              <div className="hidden grid-cols-2 gap-3 sm:grid lg:grid-cols-3">
                {Array.from({ length: 6 }).map((_, i) => (
                  <Card key={i} className="p-4">
                    <Skeleton className="mb-3 h-4 w-3/4" />
                    <Skeleton className="h-3 w-1/2" />
                  </Card>
                ))}
              </div>
            )}

            {!loading && error && (
              <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900/50 dark:bg-red-950/20 dark:text-red-400">
                {friendlyError(error)}
                <Button
                  variant="ghost"
                  size="sm"
                  className="ml-2 h-6 text-xs"
                  onClick={() => refetch()}
                >
                  Retry
                </Button>
              </div>
            )}

            {!loading && !error && filtered.length === 0 && (
              <div className="py-8 text-center text-sm text-zinc-500 dark:text-zinc-400">
                {search.trim()
                  ? `No dashboards match “${search.trim()}”.`
                  : "No dashboards yet. Create one to get started."}
              </div>
            )}

            {!loading && !error && filtered.length > 0 && (
              <>
                <div className="hidden grid-cols-2 gap-3 sm:grid lg:grid-cols-3">
                  {filtered.map((d) => {
                    const active = d.id === currentId;
                    return (
                      <Card
                        key={d.id}
                        className={cn(
                          "group relative cursor-pointer p-4 transition-colors hover:border-zinc-300 focus-within:border-zinc-300 dark:hover:border-zinc-600 dark:focus-within:border-zinc-600",
                          active &&
                            "border-primary/50 bg-primary/5 dark:border-primary/40 dark:bg-primary/5",
                        )}
                      >
                        <button
                          type="button"
                          onClick={() => handleCardClick(d)}
                          className="absolute inset-0 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                          aria-label={`Open ${d.title}`}
                          aria-current={active ? "page" : undefined}
                        />
                        <h3 className="mb-2 line-clamp-1 pr-7 text-sm font-medium text-zinc-900 dark:text-zinc-100">
                          {d.title}
                        </h3>
                        <div className="flex items-center gap-3 text-[11px] text-zinc-500 dark:text-zinc-400">
                          <span className="inline-flex items-center gap-1 tabular-nums">
                            <BarChart3 className="size-3" aria-hidden="true" />
                            {d.cardCount}
                          </span>
                          <span className="inline-flex items-center gap-1 tabular-nums">
                            <Clock className="size-3" aria-hidden="true" />
                            {timeAgo(d.updatedAt)}
                          </span>
                          {active && (
                            <span className="ml-auto rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                              Current
                            </span>
                          )}
                        </div>

                        <button
                          type="button"
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            setDeleteTarget(d);
                          }}
                          aria-label={`Delete ${d.title}`}
                          className="absolute right-2 top-2 z-10 rounded-md p-1.5 text-zinc-400 opacity-0 transition-opacity hover:bg-zinc-100 hover:text-red-600 focus-visible:opacity-100 group-hover:opacity-100 dark:hover:bg-zinc-800 dark:hover:text-red-400"
                        >
                          <Trash2 className="size-3.5" aria-hidden="true" />
                        </button>
                      </Card>
                    );
                  })}
                </div>

                <ul className="divide-y divide-zinc-200 sm:hidden dark:divide-zinc-800">
                  {filtered.map((d) => {
                    const active = d.id === currentId;
                    return (
                      <li key={d.id} className="flex items-center gap-3 py-2.5">
                        <button
                          type="button"
                          onClick={() => handleCardClick(d)}
                          className={cn(
                            "flex min-w-0 flex-1 flex-col items-start text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                            active && "text-primary",
                          )}
                          aria-current={active ? "page" : undefined}
                        >
                          <span className="line-clamp-1 text-sm font-medium">
                            {d.title}
                          </span>
                          <span className="text-[11px] tabular-nums text-zinc-500 dark:text-zinc-400">
                            {d.cardCount} {d.cardCount === 1 ? "tile" : "tiles"} ·{" "}
                            {timeAgo(d.updatedAt)}
                          </span>
                        </button>
                        <button
                          type="button"
                          onClick={() => setDeleteTarget(d)}
                          aria-label={`Delete ${d.title}`}
                          className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-red-600 dark:hover:bg-zinc-800 dark:hover:text-red-400"
                        >
                          <Trash2 className="size-3.5" aria-hidden="true" />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <NewDashboardDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={handleCreated}
      />

      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(next) => {
          if (!next) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete dashboard?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete &ldquo;{deleteTarget?.title}&rdquo; and
              all its tiles. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-red-600 text-white hover:bg-red-700"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
