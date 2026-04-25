"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
  LayoutDashboard,
  Plus,
  Sparkles,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
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
import { Badge } from "@/components/ui/badge";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import { friendlyError } from "@/ui/lib/fetch-error";
import { NavBar } from "@/ui/components/tour/nav-bar";
import { authClient } from "@/lib/auth/client";
import { DashboardShareDialog } from "./share-dialog";
import { DashboardGrid } from "@/ui/components/dashboards/dashboard-grid";
import { DashboardTopBar } from "@/ui/components/dashboards/dashboard-topbar";
import { nextTileLayout, withAutoLayout } from "@/ui/components/dashboards/auto-layout";
import type { Density } from "@/ui/components/dashboards/grid-constants";
import type {
  DashboardCard,
  DashboardCardLayout,
  DashboardSuggestion,
  DashboardWithCards,
} from "@/ui/lib/types";

export default function DashboardViewPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const session = authClient.useSession();
  const user = session.data?.user as { email?: string; role?: string } | undefined;
  const isAdmin =
    user?.role === "admin" || user?.role === "owner" || user?.role === "platform_admin";

  const { data: dashboard, loading, error, refetch } = useAdminFetch<DashboardWithCards>(
    `/api/v1/dashboards/${id}`,
  );

  const { mutate, error: mutationError } = useAdminMutation({ invalidates: refetch });

  const [refreshingCardId, setRefreshingCardId] = useState<string | null>(null);
  const [refreshingAll, setRefreshingAll] = useState(false);
  const [deleteCardTarget, setDeleteCardTarget] = useState<DashboardCard | null>(null);
  const [deleteDashboard, setDeleteDashboard] = useState(false);
  const [suggestions, setSuggestions] = useState<DashboardSuggestion[]>([]);
  const [suggestingCards, setSuggestingCards] = useState(false);
  const [suggestError, setSuggestError] = useState<string | null>(null);
  const [addingSuggestion, setAddingSuggestion] = useState<number | null>(null);

  const [editing, setEditing] = useState(false);
  const [density, setDensity] = useState<Density>("comfortable");

  // Optimistic layout — applied on drop/resize end so the UI doesn't wait for
  // the PATCH round-trip. Cleared once `dashboard` reflects the change. On
  // failure the entry is dropped and `mutationError` surfaces in the banner.
  const [optimisticLayouts, setOptimisticLayouts] = useState<Record<string, DashboardCardLayout>>({});

  useEffect(() => {
    if (!dashboard) return;
    const settled: Record<string, DashboardCardLayout> = {};
    for (const card of dashboard.cards) {
      if (card.layout) settled[card.id] = card.layout;
    }
    setOptimisticLayouts((prev) => {
      const remaining: Record<string, DashboardCardLayout> = {};
      for (const [cardId, optimistic] of Object.entries(prev)) {
        const next = settled[cardId];
        if (
          !next
          || next.x !== optimistic.x
          || next.y !== optimistic.y
          || next.w !== optimistic.w
          || next.h !== optimistic.h
        ) {
          remaining[cardId] = optimistic;
        }
      }
      return remaining;
    });
  }, [dashboard]);

  // Skip when typing in inputs.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || target?.isContentEditable) return;
      if (e.key === "e" || e.key === "E") {
        e.preventDefault();
        setEditing((prev) => !prev);
      } else if (e.key === "Escape") {
        setEditing(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  async function handleRefreshCard(cardId: string) {
    setRefreshingCardId(cardId);
    await mutate({ path: `/api/v1/dashboards/${id}/cards/${cardId}/refresh`, method: "POST" });
    setRefreshingCardId(null);
  }

  async function handleRefreshAll() {
    setRefreshingAll(true);
    await mutate({ path: `/api/v1/dashboards/${id}/refresh`, method: "POST" });
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
    await mutate({ path: `/api/v1/dashboards/${id}`, method: "DELETE" });
    router.push("/dashboards");
  }

  async function handleUpdateCardTitle(cardId: string, title: string) {
    await mutate({
      path: `/api/v1/dashboards/${id}/cards/${cardId}`,
      method: "PATCH",
      body: { title },
    });
  }

  async function handleLayoutChange(cardId: string, layout: DashboardCardLayout) {
    setOptimisticLayouts((prev) => ({ ...prev, [cardId]: layout }));
    const result = await mutate({
      path: `/api/v1/dashboards/${id}/cards/${cardId}`,
      method: "PATCH",
      body: { layout },
    });
    if (!result.ok) {
      // Revert optimistic; UI falls back to the server's layout. Error banner
      // surfaces via `mutationError`.
      setOptimisticLayouts((prev) => {
        const { [cardId]: _, ...rest } = prev;
        return rest;
      });
    }
  }

  async function handleDuplicate(cardId: string) {
    if (!dashboard) return;
    const card = dashboard.cards.find((c) => c.id === cardId);
    if (!card) return;
    const placed = withAutoLayout(dashboard.cards).map((c) => c.resolvedLayout);
    await mutate({
      path: `/api/v1/dashboards/${id}/cards`,
      method: "POST",
      body: {
        title: `${card.title} (copy)`,
        sql: card.sql,
        chartConfig: card.chartConfig,
        cachedColumns: card.cachedColumns,
        cachedRows: card.cachedRows,
        connectionId: card.connectionId,
        layout: nextTileLayout(placed),
      },
    });
  }

  async function handleSuggestCards() {
    setSuggestingCards(true);
    setSuggestions([]);
    setSuggestError(null);
    try {
      const result = await mutate({ path: `/api/v1/dashboards/${id}/suggest`, method: "POST" });
      if (result.ok && result.data) {
        const data = result.data as { suggestions?: DashboardSuggestion[] };
        setSuggestions(data.suggestions ?? []);
      } else {
        setSuggestError("Failed to generate suggestions. Please try again.");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.debug("[dashboard] Failed to fetch AI suggestions:", message);
      setSuggestError(message || "Failed to generate suggestions. Please try again.");
    } finally {
      setSuggestingCards(false);
    }
  }

  async function handleAcceptSuggestion(index: number) {
    const suggestion = suggestions[index];
    if (!suggestion || !dashboard) return;
    setAddingSuggestion(index);
    try {
      const placed = withAutoLayout(dashboard.cards).map((c) => c.resolvedLayout);
      const result = await mutate({
        path: `/api/v1/dashboards/${id}/cards`,
        method: "POST",
        body: {
          title: suggestion.title,
          sql: suggestion.sql,
          chartConfig: suggestion.chartConfig,
          layout: nextTileLayout(placed),
        },
      });
      if (result.ok) setSuggestions((prev) => prev.filter((_, i) => i !== index));
    } finally {
      setAddingSuggestion(null);
    }
  }

  function handleDismissSuggestion(index: number) {
    setSuggestions((prev) => prev.filter((_, i) => i !== index));
  }

  async function handleTitleChange(next: string) {
    await mutate({
      path: `/api/v1/dashboards/${id}`,
      method: "PATCH",
      body: { title: next },
    });
  }

  async function handleScheduleChange(value: string) {
    const schedule = value === "off" ? null : value;
    await mutate({
      path: `/api/v1/dashboards/${id}`,
      method: "PATCH",
      body: { refreshSchedule: schedule },
    });
  }

  const cardsForGrid: DashboardCard[] = dashboard
    ? dashboard.cards.map((c) =>
        optimisticLayouts[c.id] ? { ...c, layout: optimisticLayouts[c.id] } : c,
      )
    : [];

  return (
    <div className="flex min-h-screen flex-col bg-white dark:bg-zinc-950">
      <NavBar isAdmin={isAdmin} />

      <main className="flex flex-1 flex-col">
        {loading && (
          <div className="space-y-4 px-4 py-6 sm:px-6">
            <Skeleton className="h-8 w-1/3" />
            <Skeleton className="h-4 w-1/4" />
            <div className="mt-8 grid grid-cols-1 gap-4 md:grid-cols-2">
              <Skeleton className="h-64 w-full" />
              <Skeleton className="h-64 w-full" />
              <Skeleton className="h-64 w-full" />
              <Skeleton className="h-64 w-full" />
            </div>
          </div>
        )}

        {!loading && error && (
          <div className="m-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/20 dark:text-red-400">
            {error.message ?? "Failed to load dashboard."}
            <Button variant="ghost" size="sm" className="ml-2" onClick={() => refetch()}>
              Retry
            </Button>
          </div>
        )}

        {!loading && !error && dashboard && (
          <>
            <DashboardTopBar
              title={dashboard.title}
              cardCount={dashboard.cards.length}
              description={dashboard.description}
              onTitleChange={handleTitleChange}
              refreshing={refreshingAll}
              refreshSchedule={dashboard.refreshSchedule}
              onScheduleChange={handleScheduleChange}
              onRefreshAll={handleRefreshAll}
              onSuggest={handleSuggestCards}
              suggesting={suggestingCards}
              onDelete={() => setDeleteDashboard(true)}
              shareSlot={<DashboardShareDialog dashboardId={id} />}
              editing={editing}
              onEditingChange={setEditing}
              density={density}
              onDensityChange={setDensity}
            />

            {mutationError && (
              <div className="mx-4 mt-3 rounded-md border border-red-200 bg-red-50/60 px-3 py-2 text-xs text-red-700 dark:border-red-900/50 dark:bg-red-950/20 dark:text-red-400 sm:mx-6">
                {friendlyError(mutationError)}
              </div>
            )}

            {suggestError && (
              <div className="mx-4 mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/20 dark:text-amber-300 sm:mx-6">
                {suggestError}
                <Button variant="ghost" size="sm" className="ml-2 h-6 text-xs" onClick={() => setSuggestError(null)}>
                  Dismiss
                </Button>
              </div>
            )}

            {suggestions.length > 0 && (
              <div className="mx-4 mt-4 space-y-2 sm:mx-6">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Sparkles className="size-4 text-primary" />
                    <h2 className="text-sm font-medium tracking-tight text-zinc-900 dark:text-zinc-100">
                      Suggested tiles
                    </h2>
                    <Badge variant="secondary" className="text-xs">{suggestions.length}</Badge>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setSuggestions([])}
                    className="text-xs text-zinc-500"
                  >
                    Dismiss all
                  </Button>
                </div>
                <div className="space-y-2">
                  {suggestions.map((suggestion, idx) => (
                    <Card
                      key={`suggestion-${idx}`}
                      className="border-dashed border-primary/40 bg-primary/5 dark:border-primary/30 dark:bg-primary/5"
                    >
                      <div className="flex items-start gap-3 px-4 py-3">
                        <div className="min-w-0 flex-1">
                          <h3 className="text-sm font-medium tracking-tight">{suggestion.title}</h3>
                          <p className="mt-0.5 line-clamp-2 text-xs text-zinc-500 dark:text-zinc-400">
                            {suggestion.reason}
                          </p>
                          <div className="mt-1.5 flex items-center gap-2">
                            <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
                              {suggestion.chartConfig.type}
                            </Badge>
                            <span className="max-w-[40ch] truncate font-mono text-[10px] text-zinc-400 dark:text-zinc-500">
                              {suggestion.sql.slice(0, 80)}
                              {suggestion.sql.length > 80 ? "..." : ""}
                            </span>
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleAcceptSuggestion(idx)}
                            disabled={addingSuggestion === idx}
                            className="h-7 border-primary/40 text-primary hover:bg-primary/10"
                          >
                            <Plus className="mr-1 size-3" />
                            {addingSuggestion === idx ? "Adding..." : "Add"}
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-7 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
                            onClick={() => handleDismissSuggestion(idx)}
                            title="Dismiss suggestion"
                          >
                            <XCircle className="size-3.5" />
                          </Button>
                        </div>
                      </div>
                    </Card>
                  ))}
                </div>
              </div>
            )}

            {dashboard.cards.length === 0 ? (
              <div className="flex flex-1 flex-col items-center justify-center px-6 py-16 text-center">
                <div className="mb-4 rounded-xl border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-zinc-900">
                  <LayoutDashboard className="size-8 text-zinc-400 dark:text-zinc-500" />
                </div>
                <h2 className="mb-1 text-2xl font-semibold tracking-tight">An empty canvas</h2>
                <p className="mb-6 max-w-sm text-sm text-zinc-500 dark:text-zinc-400">
                  Run a query in chat and click <span className="font-medium">Add to Dashboard</span> on the result to drop your first tile here.
                </p>
                <Button asChild size="sm">
                  <Link href="/">Go to chat</Link>
                </Button>
              </div>
            ) : (
              <div className={`dash-density-${density} flex-1 overflow-auto px-3 py-4 sm:px-5`}>
                <DashboardGrid
                  cards={cardsForGrid}
                  editing={editing}
                  refreshingId={refreshingCardId}
                  onLayoutChange={handleLayoutChange}
                  onRefresh={handleRefreshCard}
                  onDuplicate={handleDuplicate}
                  onDelete={setDeleteCardTarget}
                  onUpdateTitle={handleUpdateCardTitle}
                />
              </div>
            )}
          </>
        )}
      </main>

      <AlertDialog
        open={!!deleteCardTarget}
        onOpenChange={(open) => { if (!open) setDeleteCardTarget(null); }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove tile?</AlertDialogTitle>
            <AlertDialogDescription>
              This will remove &ldquo;{deleteCardTarget?.title}&rdquo; from this dashboard. The
              underlying query is not affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteCard}
              className="bg-red-600 text-white hover:bg-red-700"
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={deleteDashboard} onOpenChange={setDeleteDashboard}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete dashboard?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete &ldquo;{dashboard?.title}&rdquo; and all its tiles.
              This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteDashboard}
              className="bg-red-600 text-white hover:bg-red-700"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
