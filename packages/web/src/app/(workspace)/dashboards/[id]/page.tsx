"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { MessagesSquare, Plus, Sparkles, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { BoundChatDrawer } from "@/ui/components/dashboards/bound-chat-drawer";
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
import { useAtlasConfig } from "@/ui/context";
import { friendlyError } from "@/ui/lib/fetch-error";
import { DashboardShareDialog } from "./share-dialog";
import { DashboardGrid } from "@/ui/components/dashboards/dashboard-grid";
import { DashboardTopBar } from "@/ui/components/dashboards/dashboard-topbar";
import { DraftStatusBanner } from "@/ui/components/dashboards/draft-status-banner";
import { PublishDiffModal } from "@/ui/components/dashboards/publish-diff-modal";
import { diffDashboards, type DashboardDiff } from "@/ui/components/dashboards/dashboard-diff";
import { nextTileLayout, withAutoLayout } from "@/ui/components/dashboards/auto-layout";
import { StageProvider } from "@/ui/components/dashboards/stage-context";
import type { StagedChange } from "@/ui/lib/types";
import { useVisibilityGatedPoll } from "@/ui/hooks/use-visibility-gated-poll";
import { selectNextAfterDelete } from "../select-recent";
import type { Density } from "@/ui/components/dashboards/grid-constants";
import type {
  DashboardCard,
  DashboardCardLayout,
  DashboardSuggestion,
  DashboardWithCards,
} from "@/ui/lib/types";

// #2521 — wire shape returned by `GET /:id/draft/status`. Lightweight
// presence check; never forks a draft.
interface DraftStatusResponse {
  hasDraft: boolean;
  /** Only present when hasDraft is true. */
  publishedBaselineAt?: string;
  dashboardUpdatedAt?: string;
  staleBaseline?: boolean;
  updatedAt?: string;
}

// #2521 — wire shape returned by `GET /:id/draft`. Materialized view +
// draft metadata. We only consume `.view` (a DashboardWithCards) here —
// the snapshot stays server-side.
interface DraftViewResponse {
  draft: {
    userId: string;
    dashboardId: string;
    publishedBaselineAt: string;
    updatedAt: string;
  };
  view: DashboardWithCards;
}

/** Poll interval for draft status. 30s is the same cadence as TanStack
 *  Query's default staleTime in this app, so the window-focus refetch
 *  picks up baseline drift even sooner. */
const DRAFT_STATUS_POLL_MS = 30_000;

export default function DashboardViewPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { apiUrl, isCrossOrigin } = useAtlasConfig();

  const { data: dashboard, loading, error, refetch } = useAdminFetch<DashboardWithCards>(
    `/api/v1/dashboards/${id}`,
  );

  // #2365 — pending destructive stages for THIS user on THIS dashboard.
  // Drives the ghost overlay on the grid (strikethrough + side-by-side
  // diff). Per-user; teammates never see each other's pending stages.
  // Refetched whenever the chat tool fires a stage or the user accepts /
  // discards via `<StageChangeCard>`.
  const { data: stagesData, refetch: refetchStages } = useAdminFetch<{ stages: StagedChange[] }>(
    `/api/v1/dashboards/${id}/stage`,
  );
  const stages: StagedChange[] = stagesData?.stages ?? [];

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
  // #2363 — bound chat drawer state
  const [chatOpen, setChatOpen] = useState(false);

  // #2521 — draft state. `useAdminFetch` powers the badge + baseline-drift
  // detection; we poll on window focus + a 30s tick so a teammate's
  // publish surfaces quickly without blowing the request budget.
  const {
    data: draftStatus,
    refetch: refetchDraftStatus,
  } = useAdminFetch<DraftStatusResponse>(`/api/v1/dashboards/${id}/draft/status`);
  useVisibilityGatedPoll(refetchDraftStatus, DRAFT_STATUS_POLL_MS);

  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);
  const [publishModalOpen, setPublishModalOpen] = useState(false);
  // Draft view materialized server-side — fetched lazily, only when the
  // user opens the Publish modal. Avoids the side-effect cost of `GET
  // /:id/draft` (which forks-on-first-call) on every page load.
  const [draftView, setDraftView] = useState<DashboardWithCards | null>(null);
  const [draftViewLoading, setDraftViewLoading] = useState(false);
  // Separate from the useAdminMutation `draftError` below so a failed
  // GET on the draft view (which doesn't go through the mutation hook)
  // can surface to the Publish modal without colliding with mutation
  // errors. Without this, a failed GET silently produced an empty
  // modal with no diff and a disabled Publish button — invisible to
  // anyone not watching devtools.
  const [draftViewError, setDraftViewError] = useState<string | null>(null);

  // Dedicated mutation hook for draft ops. We want a separate error
  // surface from the shared `mutate` above (which is reused for card +
  // dashboard CRUD) so the banner's "draft-error" copy doesn't mask
  // unrelated mutation errors and vice-versa.
  const {
    mutate: draftMutate,
    error: draftError,
    clearError: clearDraftError,
  } = useAdminMutation({
    invalidates: [refetch, refetchDraftStatus],
  });
  const [publishing, setPublishing] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [rebasing, setRebasing] = useState(false);

  // Optimistic layout — applied on drop/resize end so the UI doesn't wait for
  // the PATCH round-trip. Dropped explicitly when the mutation settles. No
  // effect-driven reconciliation against `dashboard` — the previous version
  // of that pattern cascaded into React #185 once refetches started landing
  // fast enough during multi-drag sessions.
  const [optimisticLayouts, setOptimisticLayouts] = useState<Record<string, DashboardCardLayout>>({});

  // #2369 — creation-to-bound continuity. The chat-side
  // `createDashboard` tool surfaces a "Continue editing" link that
  // navigates here with `?openChat=true`. Auto-open the bound chat
  // drawer once so the same conversation resumes in bound mode, then
  // strip the param so a refresh doesn't keep reopening it.
  useEffect(() => {
    if (searchParams.get("openChat") !== "true") return;
    setChatOpen(true);
    // Replace the URL without the flag — `router.replace` keeps the
    // browser history clean (no "back" landing on the auto-open).
    router.replace(`/dashboards/${id}`);
  }, [searchParams, router, id]);

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
    // Pre-fetch the next-most-recent dashboard so we can land the user on it
    // after the delete settles. We compute `next` BEFORE the delete because
    // `useAdminFetch` invalidations clear the in-memory list first, and we
    // want the navigation target locked in. On failure we fall back to
    // /dashboards which will redirect or show the empty state.
    let nextId: string | null = null;
    try {
      const res = await fetch(`${apiUrl}/api/v1/dashboards`, {
        credentials: isCrossOrigin ? "include" : "same-origin",
      });
      if (res.ok) {
        const json = (await res.json()) as { dashboards?: { id: string; updatedAt: string }[] };
        nextId = selectNextAfterDelete(json.dashboards ?? [], id);
      }
    } catch (err) {
      console.debug(
        "[dashboard] Pre-delete next-dashboard lookup failed; falling back to /dashboards:",
        err instanceof Error ? err.message : String(err),
      );
    }

    const result = await mutate({ path: `/api/v1/dashboards/${id}`, method: "DELETE" });
    if (!result.ok) return;
    router.push(nextId ? `/dashboards/${nextId}` : "/dashboards");
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
    await mutate({
      path: `/api/v1/dashboards/${id}/cards/${cardId}`,
      method: "PATCH",
      body: { layout },
    });
    // Drop the entry whether the PATCH succeeded (server now reflects it) or
    // failed (UI falls back to the server's last-known layout, mutationError
    // surfaces in the banner).
    setOptimisticLayouts((prev) => {
      const { [cardId]: _, ...rest } = prev;
      return rest;
    });
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
        connectionGroupId: card.connectionGroupId,
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

  // -------------------------------------------------------------------
  // #2521 — Publish / Discard / Rebase handlers
  // -------------------------------------------------------------------

  // Fetch the materialized draft view on demand (Publish modal open).
  // We hit the GET endpoint directly rather than going through
  // useAdminFetch because the call is one-shot per open — we don't need
  // the cache machinery, and we want to surface a network error to the
  // modal's own banner rather than the page's.
  async function handleOpenPublishModal() {
    clearDraftError();
    setDraftViewError(null);
    setPublishModalOpen(true);
    setDraftView(null);
    setDraftViewLoading(true);
    try {
      const res = await fetch(`${apiUrl}/api/v1/dashboards/${id}/draft`, {
        credentials: isCrossOrigin ? "include" : "same-origin",
      });
      if (res.ok) {
        const json = (await res.json()) as DraftViewResponse;
        setDraftView(json.view ?? null);
      } else {
        // Surface the failure to the modal banner. Without this the
        // modal opens with no diff, the Publish button stays disabled,
        // and the user has no signal that the fetch failed — the
        // console.debug fallback was invisible to anyone not watching
        // devtools.
        const body = await res.json().catch(() => ({} as Record<string, unknown>));
        const rid = typeof body?.requestId === "string" ? body.requestId : null;
        const msg = typeof body?.message === "string"
          ? body.message
          : `Could not load draft view (${res.status}).`;
        setDraftViewError(rid ? `${msg} (request ${rid})` : msg);
        setDraftView(null);
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      setDraftViewError(`Network error fetching draft view: ${detail}`);
      setDraftView(null);
    } finally {
      setDraftViewLoading(false);
    }
  }

  async function handleConfirmPublish() {
    setPublishing(true);
    const result = await draftMutate({
      path: `/api/v1/dashboards/${id}/draft/publish`,
      method: "POST",
    });
    setPublishing(false);
    if (result.ok) {
      setPublishModalOpen(false);
      setDraftView(null);
    } else if (result.error.status === 409) {
      // Stale baseline OR conflict — close the modal and let the banner
      // surface the rebase affordance. The error is recorded on
      // draftError so the user sees what happened next to the Rebase
      // button. Refetching draft status picks up the staleBaseline
      // flag from the server.
      setPublishModalOpen(false);
      void refetchDraftStatus();
    }
    // Other failures: modal stays open so the user sees the error in
    // its own banner.
  }

  async function handleDiscardConfirm() {
    setDiscarding(true);
    const result = await draftMutate({
      path: `/api/v1/dashboards/${id}/draft/discard`,
      method: "POST",
    });
    setDiscarding(false);
    if (result.ok) {
      setDiscardConfirmOpen(false);
    }
  }

  async function handleRebase() {
    setRebasing(true);
    const result = await draftMutate({
      path: `/api/v1/dashboards/${id}/draft/rebase`,
      method: "POST",
    });
    setRebasing(false);
    if (result.ok) {
      // refetchDraftStatus is wired as an invalidate above; the banner
      // updates automatically as soon as the status returns
      // staleBaseline=false.
    }
  }

  // Compute the diff client-side from the live published view vs the
  // fetched draft view. The modal renders an empty state when these
  // match (`diff.empty`); Publish is disabled in that case.
  const diff: DashboardDiff | null =
    dashboard && draftView ? diffDashboards(dashboard, draftView) : null;

  const cardsForGrid: DashboardCard[] = dashboard
    ? dashboard.cards.map((c) =>
        optimisticLayouts[c.id] ? { ...c, layout: optimisticLayouts[c.id] } : c,
      )
    : [];

  // The stage handler fires when the user clicks Accept / Discard in the
  // bound chat drawer. We refetch BOTH the dashboard (the draft cards
  // changed after an accept) AND the stage list (the row is no longer
  // pending). Both calls are cheap (org-scoped GETs).
  function handleStagesChanged() {
    refetch();
    refetchStages();
  }

  return (
    <StageProvider value={{ dashboardId: id, onStagesChanged: handleStagesChanged }}>
      <div className="flex h-full flex-1 flex-col overflow-auto">
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
              dashboardId={dashboard.id}
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
              chatSlot={
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setChatOpen(true)}
                  aria-label="Edit dashboard with chat"
                >
                  <MessagesSquare className="mr-1.5 size-3.5" aria-hidden="true" />
                  Edit with chat
                </Button>
              }
              editing={editing}
              onEditingChange={setEditing}
              density={density}
              onDensityChange={setDensity}
            />

            <DraftStatusBanner
              hasDraft={!!draftStatus?.hasDraft}
              staleBaseline={!!draftStatus?.staleBaseline}
              discardOpen={discardConfirmOpen}
              onDiscardOpenChange={setDiscardConfirmOpen}
              onPublish={handleOpenPublishModal}
              onDiscardConfirm={handleDiscardConfirm}
              onRebase={handleRebase}
              publishing={publishing}
              discarding={discarding}
              rebasing={rebasing}
              error={draftError}
              onDismissError={clearDraftError}
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
              <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-16 text-center">
                <h2 className="text-2xl font-semibold tracking-tight">An empty canvas</h2>
                <p className="max-w-sm text-sm text-zinc-500 dark:text-zinc-400">
                  Run a query in chat, then click <span className="font-medium">Add to Dashboard</span> to drop your first tile here.
                </p>
                <Button asChild size="sm" className="mt-2">
                  <Link href="/">Go to chat</Link>
                </Button>
              </div>
            ) : (
              <div className={`dash-density-${density} flex-1 px-3 py-4 sm:overflow-auto sm:px-5`}>
                <DashboardGrid
                  cards={cardsForGrid}
                  editing={editing}
                  refreshingId={refreshingCardId}
                  stages={stages}
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
      </div>

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

      {dashboard && (
        <BoundChatDrawer
          open={chatOpen}
          onOpenChange={setChatOpen}
          dashboardId={dashboard.id}
          dashboardTitle={dashboard.title}
          onDashboardMutated={handleStagesChanged}
        />
      )}

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

      <PublishDiffModal
        open={publishModalOpen}
        onOpenChange={setPublishModalOpen}
        diff={diff}
        loading={draftViewLoading}
        publishing={publishing}
        error={draftError}
        viewError={draftViewError}
        onConfirm={handleConfirmPublish}
      />
    </StageProvider>
  );
}
