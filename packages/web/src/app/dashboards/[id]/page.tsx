"use client";

import { useContext, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import dynamic from "next/dynamic";
import { z } from "zod";
import {
  ArrowLeft,
  RefreshCw,
  Trash2,
  Pencil,
  GripVertical,
  Clock,
  Timer,
  LayoutDashboard,
  Check,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
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
  Sortable,
  SortableContent,
  SortableItem,
  SortableItemHandle,
  SortableOverlay,
} from "@/components/ui/sortable";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import { NavBar } from "@/ui/components/tour/nav-bar";
import { DataTable } from "@/ui/components/chat/data-table";
import { DarkModeContext } from "@/ui/hooks/use-dark-mode";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { authClient } from "@/lib/auth/client";
import { DashboardShareDialog } from "./share-dialog";
import type { DashboardWithCards, DashboardCard } from "@/ui/lib/types";

const ResultChart = dynamic(
  () => import("@/ui/components/chart/result-chart").then((m) => ({ default: m.ResultChart })),
  { ssr: false, loading: () => <div className="h-48 animate-pulse rounded-lg bg-zinc-100 dark:bg-zinc-800" /> },
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

/** Convert Record rows to string[][] for ResultChart. */
function toStringRows(columns: string[], rows: Record<string, unknown>[]): string[][] {
  return rows.map((row) => columns.map((col) => (row[col] == null ? "" : String(row[col]))));
}

// ---------------------------------------------------------------------------
// Card Component
// ---------------------------------------------------------------------------

function DashboardCardView({
  card,
  onRefresh,
  onDelete,
  onUpdate,
  refreshingId,
}: {
  card: DashboardCard;
  onRefresh: (cardId: string) => void;
  onDelete: (card: DashboardCard) => void;
  onUpdate: (cardId: string, title: string) => void;
  refreshingId: string | null;
}) {
  const dark = useContext(DarkModeContext);
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState(card.title);
  const isRefreshing = refreshingId === card.id;

  const columns = card.cachedColumns ?? [];
  const rows = (card.cachedRows ?? []) as Record<string, unknown>[];
  const hasData = columns.length > 0 && rows.length > 0;
  const stringRows = hasData ? toStringRows(columns, rows) : [];

  function handleSaveTitle() {
    if (editTitle.trim() && editTitle.trim() !== card.title) {
      onUpdate(card.id, editTitle.trim());
    }
    setEditing(false);
  }

  return (
    <Card className="overflow-hidden">
      {/* Card header */}
      <div className="flex items-center gap-2 border-b border-zinc-100 px-4 py-3 dark:border-zinc-800">
        <SortableItemHandle className="cursor-grab text-zinc-400 hover:text-zinc-600 dark:text-zinc-500 dark:hover:text-zinc-300">
          <GripVertical className="size-4" />
        </SortableItemHandle>

        {editing ? (
          <div className="flex flex-1 items-center gap-1.5">
            <Input
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleSaveTitle(); if (e.key === "Escape") setEditing(false); }}
              className="h-7 text-sm"
              autoFocus
            />
            <Button variant="ghost" size="icon" className="size-7" onClick={handleSaveTitle}>
              <Check className="size-3.5" />
            </Button>
            <Button variant="ghost" size="icon" className="size-7" onClick={() => setEditing(false)}>
              <X className="size-3.5" />
            </Button>
          </div>
        ) : (
          <h3 className="flex-1 text-sm font-medium text-zinc-900 dark:text-zinc-100 line-clamp-1">
            {card.title}
          </h3>
        )}

        <div className="flex items-center gap-1">
          <span className="mr-1 text-xs text-zinc-400 dark:text-zinc-500">
            <Clock className="mr-0.5 inline size-3" />
            {timeAgo(card.cachedAt)}
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={() => onRefresh(card.id)}
            disabled={isRefreshing}
            title="Refresh data"
          >
            <RefreshCw className={`size-3.5 ${isRefreshing ? "animate-spin" : ""}`} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={() => { setEditTitle(card.title); setEditing(true); }}
            title="Edit title"
          >
            <Pencil className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-7 text-zinc-400 hover:text-red-500 dark:hover:text-red-400"
            onClick={() => onDelete(card)}
            title="Remove card"
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      </div>

      {/* Card body — chart + table */}
      {hasData ? (
        <div>
          {card.chartConfig && card.chartConfig.type !== "table" && (
            <div className="px-4 py-3">
              <ResultChart headers={columns} rows={stringRows} dark={dark} />
            </div>
          )}
          <DataTable columns={columns} rows={rows} />
        </div>
      ) : (
        <div className="px-4 py-8 text-center text-xs text-zinc-500 dark:text-zinc-400">
          No cached data. Click refresh to load results.
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function DashboardViewPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const session = authClient.useSession();
  const user = session.data?.user as { role?: string } | undefined;
  const isAdmin = user?.role === "admin" || user?.role === "owner" || user?.role === "platform_admin";

  const { data: dashboard, loading, error, refetch } = useAdminFetch<DashboardWithCards>(
    `/api/v1/dashboards/${id}`,
    {
      schema: z.object({
        id: z.string(),
        title: z.string(),
        description: z.string().nullable().optional(),
        cards: z.array(z.object({
          id: z.string(),
          dashboardId: z.string(),
          position: z.number(),
          title: z.string(),
          sql: z.string(),
          chartConfig: z.unknown().nullable().optional(),
          cachedColumns: z.array(z.string()).nullable().optional(),
          cachedRows: z.array(z.record(z.string(), z.unknown())).nullable().optional(),
          cachedAt: z.string().nullable().optional(),
          connectionId: z.string().nullable().optional(),
          createdAt: z.string(),
          updatedAt: z.string(),
        }).passthrough()),
      }).passthrough(),
    },
  );

  const { mutate } = useAdminMutation({ invalidates: refetch });
  const [refreshingCardId, setRefreshingCardId] = useState<string | null>(null);
  const [refreshingAll, setRefreshingAll] = useState(false);
  const [deleteCardTarget, setDeleteCardTarget] = useState<DashboardCard | null>(null);
  const [deleteDashboard, setDeleteDashboard] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleValue, setTitleValue] = useState("");

  async function handleRefreshCard(cardId: string) {
    setRefreshingCardId(cardId);
    await mutate({
      path: `/api/v1/dashboards/${id}/cards/${cardId}/refresh`,
      method: "POST",
    });
    setRefreshingCardId(null);
  }

  async function handleRefreshAll() {
    setRefreshingAll(true);
    await mutate({
      path: `/api/v1/dashboards/${id}/refresh`,
      method: "POST",
    });
    setRefreshingAll(false);
  }

  async function handleDeleteCard() {
    if (!deleteCardTarget) return;
    await mutate({
      path: `/api/v1/dashboards/${id}/cards/${deleteCardTarget.id}`,
      method: "DELETE",
    });
    setDeleteCardTarget(null);
  }

  async function handleDeleteDashboard() {
    await mutate({
      path: `/api/v1/dashboards/${id}`,
      method: "DELETE",
    });
    router.push("/dashboards");
  }

  async function handleUpdateCardTitle(cardId: string, title: string) {
    await mutate({
      path: `/api/v1/dashboards/${id}/cards/${cardId}`,
      method: "PATCH",
      body: { title },
    });
  }

  async function handleReorder(activeId: string, overId: string) {
    if (!dashboard) return;
    const cards = dashboard.cards;
    const oldIdx = cards.findIndex((c) => c.id === activeId);
    const newIdx = cards.findIndex((c) => c.id === overId);
    if (oldIdx === -1 || newIdx === -1 || oldIdx === newIdx) return;

    await mutate({
      path: `/api/v1/dashboards/${id}/cards/${activeId}`,
      method: "PATCH",
      body: { position: newIdx },
    });
  }

  async function handleSaveDashboardTitle() {
    if (titleValue.trim() && titleValue.trim() !== dashboard?.title) {
      await mutate({
        path: `/api/v1/dashboards/${id}`,
        method: "PATCH",
        body: { title: titleValue.trim() },
      });
    }
    setEditingTitle(false);
  }

  const cards = dashboard?.cards ?? [];

  return (
    <div className="flex min-h-screen flex-col bg-white dark:bg-zinc-950">
      <NavBar isAdmin={isAdmin} />

      <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-8">
        {/* Loading */}
        {loading && (
          <div className="space-y-4">
            <Skeleton className="h-8 w-1/3" />
            <Skeleton className="h-4 w-1/4" />
            <div className="mt-8 space-y-4">
              <Skeleton className="h-64 w-full" />
              <Skeleton className="h-64 w-full" />
            </div>
          </div>
        )}

        {/* Error */}
        {!loading && error && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/20 dark:text-red-400">
            {error.message ?? "Failed to load dashboard."}
            <Button variant="ghost" size="sm" className="ml-2" onClick={refetch}>
              Retry
            </Button>
          </div>
        )}

        {/* Dashboard content */}
        {!loading && !error && dashboard && (
          <>
            {/* Header */}
            <div className="mb-8">
              <Link
                href="/dashboards"
                className="mb-4 inline-flex items-center gap-1 text-xs text-zinc-500 transition-colors hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-300"
              >
                <ArrowLeft className="size-3" />
                All Dashboards
              </Link>

              <div className="flex items-start justify-between">
                <div className="flex-1">
                  {editingTitle ? (
                    <div className="flex items-center gap-2">
                      <Input
                        value={titleValue}
                        onChange={(e) => setTitleValue(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") handleSaveDashboardTitle(); if (e.key === "Escape") setEditingTitle(false); }}
                        className="text-xl font-semibold"
                        autoFocus
                      />
                      <Button variant="ghost" size="icon" onClick={handleSaveDashboardTitle}>
                        <Check className="size-4" />
                      </Button>
                      <Button variant="ghost" size="icon" onClick={() => setEditingTitle(false)}>
                        <X className="size-4" />
                      </Button>
                    </div>
                  ) : (
                    <h1
                      className="cursor-pointer text-xl font-semibold tracking-tight text-zinc-900 hover:text-zinc-700 dark:text-zinc-100 dark:hover:text-zinc-300"
                      onClick={() => { setTitleValue(dashboard.title); setEditingTitle(true); }}
                      title="Click to edit title"
                    >
                      {dashboard.title}
                    </h1>
                  )}
                  {dashboard.description && (
                    <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
                      {dashboard.description}
                    </p>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleRefreshAll}
                    disabled={refreshingAll || cards.length === 0}
                  >
                    <RefreshCw className={`mr-1.5 size-3.5 ${refreshingAll ? "animate-spin" : ""}`} />
                    Refresh All
                  </Button>
                  <Select
                    value={dashboard.refreshSchedule ?? "off"}
                    onValueChange={(v) => {
                      const schedule = v === "off" ? null : v;
                      mutate({
                        path: `/api/v1/dashboards/${id}`,
                        method: "PATCH",
                        body: { refreshSchedule: schedule },
                      });
                    }}
                  >
                    <SelectTrigger className="h-8 w-auto gap-1.5 text-xs">
                      <Timer className="size-3.5 text-zinc-500" />
                      <SelectValue placeholder="Auto-refresh" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="off">Off</SelectItem>
                      <SelectItem value="*/15 * * * *">Every 15 min</SelectItem>
                      <SelectItem value="0 * * * *">Every hour</SelectItem>
                      <SelectItem value="0 */6 * * *">Every 6 hours</SelectItem>
                      <SelectItem value="0 0 * * *">Daily</SelectItem>
                      <SelectItem value="0 9 * * 1">Weekly (Mon 9am)</SelectItem>
                    </SelectContent>
                  </Select>
                  <DashboardShareDialog dashboardId={id} />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setDeleteDashboard(true)}
                    className="text-red-500 hover:text-red-600 dark:text-red-400"
                  >
                    <Trash2 className="mr-1.5 size-3.5" />
                    Delete
                  </Button>
                </div>
              </div>
            </div>

            {/* Empty state */}
            {cards.length === 0 && (
              <div className="flex flex-col items-center justify-center py-24 text-center">
                <div className="mb-4 rounded-xl border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-zinc-900">
                  <LayoutDashboard className="size-8 text-zinc-400 dark:text-zinc-500" />
                </div>
                <h2 className="mb-1 text-base font-medium text-zinc-900 dark:text-zinc-100">
                  No cards yet
                </h2>
                <p className="mb-6 max-w-sm text-sm text-zinc-500 dark:text-zinc-400">
                  Run a query in chat and click the Dashboard button on the result to add it here.
                </p>
                <Button variant="outline" size="sm" asChild>
                  <Link href="/">Go to Chat</Link>
                </Button>
              </div>
            )}

            {/* Sortable cards */}
            {cards.length > 0 && (
              <Sortable
                value={cards.map((c) => c.id)}
                onValueChange={(ids) => {
                  // Find which item moved
                  const oldOrder = cards.map((c) => c.id);
                  for (let i = 0; i < ids.length; i++) {
                    if (ids[i] !== oldOrder[i]) {
                      // First changed index — this is the moved item's new position
                      const movedId = ids[i];
                      handleReorder(movedId, oldOrder[i]);
                      break;
                    }
                  }
                }}
                orientation="vertical"
              >
                <SortableContent className="space-y-4">
                  {cards.map((card) => (
                    <SortableItem key={card.id} value={card.id} asChild>
                      <div>
                        <DashboardCardView
                          card={card}
                          onRefresh={handleRefreshCard}
                          onDelete={setDeleteCardTarget}
                          onUpdate={handleUpdateCardTitle}
                          refreshingId={refreshingCardId}
                        />
                      </div>
                    </SortableItem>
                  ))}
                </SortableContent>
                <SortableOverlay />
              </Sortable>
            )}
          </>
        )}
      </main>

      {/* Delete card confirmation */}
      <AlertDialog open={!!deleteCardTarget} onOpenChange={(open) => { if (!open) setDeleteCardTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove card?</AlertDialogTitle>
            <AlertDialogDescription>
              This will remove &ldquo;{deleteCardTarget?.title}&rdquo; from this dashboard. The underlying query is not affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDeleteCard} className="bg-red-600 text-white hover:bg-red-700">
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete dashboard confirmation */}
      <AlertDialog open={deleteDashboard} onOpenChange={setDeleteDashboard}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete dashboard?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete &ldquo;{dashboard?.title}&rdquo; and all its cards. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDeleteDashboard} className="bg-red-600 text-white hover:bg-red-700">
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
