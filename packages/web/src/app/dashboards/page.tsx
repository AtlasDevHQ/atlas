"use client";

import { useState } from "react";
import Link from "next/link";
import {
  LayoutDashboard,
  Plus,
  Trash2,
  Loader2,
  BarChart3,
  Clock,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
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
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import { NavBar } from "@/ui/components/tour/nav-bar";
import { authClient } from "@/lib/auth/client";
import type { Dashboard } from "@/ui/lib/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function timeAgo(iso: string): string {
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

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function DashboardsPage() {
  const session = authClient.useSession();
  const user = session.data?.user as
    | { email?: string; role?: string }
    | undefined;
  const isAdmin = user?.role === "admin" || user?.role === "owner" || user?.role === "platform_admin";

  const { data, loading, error, refetch } = useAdminFetch<{
    dashboards: Dashboard[];
    total: number;
  }>("/api/v1/dashboards");

  const { mutate: createDashboard, saving: creating } = useAdminMutation<Dashboard>({
    invalidates: refetch,
  });
  const { mutate: deleteDashboard } = useAdminMutation({
    invalidates: refetch,
  });

  const [createOpen, setCreateOpen] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Dashboard | null>(null);

  async function handleCreate() {
    if (!newTitle.trim()) return;
    setCreateError(null);
    const result = await createDashboard({
      path: "/api/v1/dashboards",
      method: "POST",
      body: { title: newTitle.trim() },
    });
    if (!result.ok) {
      setCreateError(result.error ?? "Failed to create dashboard.");
      return;
    }
    setNewTitle("");
    setCreateOpen(false);
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    await deleteDashboard({
      path: `/api/v1/dashboards/${deleteTarget.id}`,
      method: "DELETE",
    });
    setDeleteTarget(null);
  }

  const dashboards = data?.dashboards ?? [];

  return (
    <div className="flex min-h-screen flex-col bg-white dark:bg-zinc-950">
      <NavBar isAdmin={isAdmin} />

      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8">
        {/* Header */}
        <div className="mb-8 flex items-end justify-between">
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
              Dashboards
            </h1>
            <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
              Saved query results for ongoing monitoring.
            </p>
          </div>
          <Button size="sm" onClick={() => { setCreateOpen(true); setNewTitle(""); setCreateError(null); }}>
            <Plus className="mr-1.5 size-3.5" />
            New Dashboard
          </Button>
        </div>

        {/* Loading */}
        {loading && (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <Card key={i} className="p-5">
                <Skeleton className="mb-3 h-5 w-3/4" />
                <Skeleton className="mb-2 h-3 w-1/2" />
                <Skeleton className="h-3 w-1/3" />
              </Card>
            ))}
          </div>
        )}

        {/* Error */}
        {!loading && error && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/20 dark:text-red-400">
            {error.message ?? "Failed to load dashboards."}
            <Button variant="ghost" size="sm" className="ml-2" onClick={() => refetch()}>
              Retry
            </Button>
          </div>
        )}

        {/* Empty state */}
        {!loading && !error && dashboards.length === 0 && (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <div className="mb-4 rounded-xl border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-zinc-900">
              <LayoutDashboard className="size-8 text-zinc-400 dark:text-zinc-500" />
            </div>
            <h2 className="mb-1 text-base font-medium text-zinc-900 dark:text-zinc-100">
              No dashboards yet
            </h2>
            <p className="mb-6 max-w-sm text-sm text-zinc-500 dark:text-zinc-400">
              Ask a question in chat, get a result, and click the Dashboard button to pin it here.
            </p>
            <div className="flex gap-3">
              <Button variant="outline" size="sm" asChild>
                <Link href="/">Go to Chat</Link>
              </Button>
              <Button size="sm" onClick={() => { setCreateOpen(true); setNewTitle(""); setCreateError(null); }}>
                <Plus className="mr-1.5 size-3.5" />
                Create Empty Dashboard
              </Button>
            </div>
          </div>
        )}

        {/* Dashboard grid */}
        {!loading && !error && dashboards.length > 0 && (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {dashboards.map((d) => (
              <Link key={d.id} href={`/dashboards/${d.id}`} className="group">
                <Card className="relative h-full p-5 transition-colors hover:border-zinc-300 dark:hover:border-zinc-600">
                  <h3 className="mb-3 font-medium text-zinc-900 dark:text-zinc-100 line-clamp-1">
                    {d.title}
                  </h3>
                  <div className="flex items-center gap-4 text-xs text-zinc-500 dark:text-zinc-400">
                    <span className="inline-flex items-center gap-1">
                      <BarChart3 className="size-3" />
                      {d.cardCount} card{d.cardCount !== 1 ? "s" : ""}
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <Clock className="size-3" />
                      {timeAgo(d.updatedAt)}
                    </span>
                  </div>

                  {/* Delete button — appears on hover */}
                  <button
                    onClick={(e) => { e.preventDefault(); e.stopPropagation(); setDeleteTarget(d); }}
                    className="absolute right-3 top-3 rounded-md p-1.5 text-zinc-400 opacity-0 transition-opacity hover:bg-zinc-100 hover:text-red-500 group-hover:opacity-100 dark:hover:bg-zinc-800 dark:hover:text-red-400"
                    title="Delete dashboard"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </main>

      {/* Create dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>New Dashboard</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3 py-2">
            <Input
              placeholder="Dashboard title"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleCreate(); }}
              autoFocus
            />
            {createError && (
              <p className="text-xs text-red-500 dark:text-red-400">{createError}</p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button onClick={handleCreate} disabled={creating || !newTitle.trim()}>
              {creating && <Loader2 className="mr-2 size-4 animate-spin" />}
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete dashboard?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete &ldquo;{deleteTarget?.title}&rdquo; and all its cards. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} className="bg-red-600 text-white hover:bg-red-700">
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
