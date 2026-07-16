"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { LayoutDashboard, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  NewDashboardDialog,
  defaultOnDashboardCreated,
} from "@/ui/components/dashboards/new-dashboard-dialog";

interface DashboardsEmptyStateProps {
  /**
   * Called synchronously before the creation navigation fires, so the parent
   * redirect-index page can convert its own `router.replace` into the same
   * intent-preserving `?openChat=true` navigation — the post-creation list
   * refetch would otherwise race the push and strip the editor-open intent
   * (#4563).
   */
  onCreationNavigate?: () => void;
}

/**
 * #4563 — the dashboards surface is a first-class creation origin: the empty
 * state invites creating right here (the new board opens with the bound
 * editor ready), instead of bouncing the user to main chat.
 */
export function DashboardsEmptyState({
  onCreationNavigate,
}: DashboardsEmptyStateProps) {
  const router = useRouter();
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <>
      <div className="mx-auto w-full max-w-2xl flex-1 px-4 py-8">
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <div className="mb-4 rounded-xl border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-zinc-900">
            <LayoutDashboard className="size-8 text-zinc-400 dark:text-zinc-500" />
          </div>
          <h1 className="mb-1 text-base font-medium text-zinc-900 dark:text-zinc-100">
            No dashboards yet
          </h1>
          <p className="mb-6 max-w-sm text-sm text-zinc-500 dark:text-zinc-400">
            Create a dashboard and describe what you want to see — the agent
            builds the charts right on the canvas.
          </p>
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="mr-1.5 size-3.5" />
            Create your first dashboard
          </Button>
        </div>
      </div>

      <NewDashboardDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(d) => {
          onCreationNavigate?.();
          defaultOnDashboardCreated(router)(d);
        }}
      />
    </>
  );
}
