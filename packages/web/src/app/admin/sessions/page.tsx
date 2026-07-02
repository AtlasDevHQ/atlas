"use client";

import type { z } from "zod";
import { useQueryStates } from "nuqs";
import { sessionsSearchParams } from "./search-params";
import { getSessionColumns, type SessionActions } from "./columns";
import type { SessionRow } from "@/ui/lib/admin-schemas";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StatCard } from "@/ui/components/admin/stat-card";
import { ErrorBanner } from "@/ui/components/admin/error-banner";
import { MutationErrorSurface } from "@/ui/components/admin/mutation-error-surface";
import { ServerDataTable } from "@/ui/components/admin/server-data-table";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Monitor, Search, X, Users, Activity, Trash2 } from "lucide-react";
import { useState } from "react";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import { useServerDataTable } from "@/ui/hooks/use-server-data-table";
import { SessionStatsSchema, SessionsListSchema } from "@/ui/lib/admin-schemas";
import { ErrorBoundary } from "@/ui/components/error-boundary";
import { bulkFailureSummary, failedIdsFrom } from "@/ui/components/admin/queue";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

const LIMIT = 50;

export default function SessionsPage() {
  const [params, setParams] = useQueryStates(sessionsSearchParams);
  const { search } = params;

  const [bulkError, setBulkError] = useState<string | null>(null);

  const { mutate: revokeMutate, error: revokeError, isMutating } = useAdminMutation({
    method: "DELETE",
  });

  // Throwing variant used by the bulk revoke path — Promise.allSettled
  // categorizes by rejection, so a failed mutation must throw. The hook's own
  // `error` state is clobbered by concurrent mutations and can't be trusted
  // for bulk.
  async function revokeSessionOrThrow(sessionId: string): Promise<void> {
    const result = await revokeMutate({
      path: `/api/v1/admin/sessions/${sessionId}`,
      itemId: sessionId,
    });
    // useAdminMutation auto-invalidates admin-fetch queries on success, so the
    // list and stats refetch without manual coordination.
    if (!result.ok) {
      throw new Error(result.error.message);
    }
  }

  const sessionActions: SessionActions = {
    // Non-throwing wrapper for the single-row Revoke dialog — failures surface
    // through the hook's `revokeError` state; swallowing the rejection here
    // prevents an unhandled promise rejection without losing signal.
    onRevoke: async (id) => {
      try {
        await revokeSessionOrThrow(id);
      } catch (err) {
        // intentionally ignored: single-row failures surface through
        // useAdminMutation's `revokeError` state and render in the banner
        // below. Debug-log for traceability — the hook's error is the
        // user-facing signal.
        console.debug("revokeSession rejected", err);
      }
    },
    isRevoking: (id: string) => isMutating(id),
  };
  const columns = getSessionColumns(sessionActions);

  const { data: stats } = useAdminFetch("/api/v1/admin/sessions/stats", {
    schema: SessionStatsSchema,
  });

  // The server-data-table module owns pagination, the fetch, pageCount, and the
  // table instance; the sessions list doesn't sort server-side, so only
  // pagination + the `search` filter feed the request URL.
  const {
    table,
    rows,
    loading,
    error,
    refetch,
  } = useServerDataTable<SessionRow, z.infer<typeof SessionsListSchema>>({
    columns,
    getRowId: (row) => row.id,
    defaultPerPage: LIMIT,
    defaultSorting: [{ id: "updatedAt", desc: true }],
    schema: SessionsListSchema,
    select: (r) => ({ rows: r.sessions, total: r.total }),
    buildPath: ({ offset, perPage }) => {
      const qs = new URLSearchParams({
        limit: String(perPage),
        offset: String(offset),
      });
      if (search) qs.set("search", search);
      return `/api/v1/admin/sessions?${qs}`;
    },
  });

  async function revokeSelected() {
    setBulkError(null);
    const selected = table.getSelectedRowModel().rows.map((r) => r.original.id);
    const results = await Promise.allSettled(selected.map((id) => revokeSessionOrThrow(id)));
    const failedIds = failedIdsFrom(results, selected);
    if (failedIds.length === 0) {
      table.resetRowSelection();
      return;
    }
    // Keep only failed rows selected so the operator can retry them.
    table.setRowSelection(Object.fromEntries(failedIds.map((id) => [id, true])));
    setBulkError(bulkFailureSummary(results, selected, "revocations"));
  }

  const hasFilters = !!search;
  const selectedCount = table.getSelectedRowModel().rows.length;

  return (
    <TooltipProvider>
      <div className="p-6">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Sessions</h1>
            <p className="text-sm text-muted-foreground">Manage active user sessions</p>
          </div>
          {selectedCount > 0 && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="destructive" size="sm">
                  <Trash2 className="mr-1.5 size-3.5" />
                  Revoke {selectedCount} selected
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Revoke {selectedCount} session(s)?</AlertDialogTitle>
                  <AlertDialogDescription>
                    These users will be signed out immediately. This cannot be undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={revokeSelected}>Revoke</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>

        <ErrorBoundary>
          <div className="space-y-6">
            {stats && (
              <div className="grid gap-4 sm:grid-cols-3">
                <StatCard title="Total Sessions" value={stats.total.toLocaleString()} icon={<Monitor className="size-4" />} />
                <StatCard title="Active Sessions" value={stats.active.toLocaleString()} icon={<Activity className="size-4" />} />
                <StatCard title="Unique Users" value={stats.uniqueUsers.toLocaleString()} icon={<Users className="size-4" />} />
              </div>
            )}

            <div className="flex flex-wrap items-end gap-3">
              <div className="relative flex-1 min-w-[200px] max-w-sm">
                <Search className="absolute left-2.5 top-2.5 size-3.5 text-muted-foreground" />
                <Input
                  placeholder="Search by email or IP..."
                  value={search}
                  onChange={(e) => {
                    table.setPageIndex(0);
                    setParams({ search: e.target.value });
                  }}
                  className="h-9 pl-8"
                />
              </div>
              {hasFilters && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-9"
                  onClick={() => {
                    table.setPageIndex(0);
                    setParams({ search: "" });
                  }}
                >
                  <X className="mr-1.5 size-3.5" />
                  Clear
                </Button>
              )}
            </div>

            {bulkError && <ErrorBanner message={bulkError} />}
            {!bulkError && <MutationErrorSurface error={revokeError} feature="Sessions" />}
            <ServerDataTable
              table={table}
              loading={loading}
              error={error}
              isEmpty={rows.length === 0}
              onRetry={refetch}
              feature="Sessions"
              loadingMessage="Loading sessions..."
              emptyState={{
                icon: Monitor,
                title: "No active sessions",
                description: "Sessions will appear here when users sign in.",
              }}
              hasFilters={hasFilters}
              onClearFilters={() => {
                table.setPageIndex(0);
                setParams({ search: "" });
              }}
            />
          </div>
        </ErrorBoundary>
      </div>
    </TooltipProvider>
  );
}
