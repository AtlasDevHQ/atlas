"use client";

import { useEffect, useRef, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useQueryState } from "nuqs";
import { toast } from "sonner";
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
import { downloadBlob, parseAttachmentFilename } from "@/ui/lib/helpers";
import { DashboardShareDialog } from "./share-dialog";
import { DashboardGrid } from "@/ui/components/dashboards/dashboard-grid";
import { DashboardTopBar } from "@/ui/components/dashboards/dashboard-topbar";
import { DashboardParameterBar, type ParameterValues } from "@/ui/components/dashboards/dashboard-parameter-bar";
import { DashboardFilterChips } from "@/ui/components/dashboards/dashboard-filter-chips";
import {
  DASHBOARD_PARAMS_KEY,
  dashboardParamsParser,
  parseOverrides,
  withOverride,
  toggleOverride,
  normalizeDrilldownValue,
} from "./search-params";
import { activeFilters, incompatibleCardIds } from "./cross-filter";
import { renderDashboardCards } from "./dashboard-card-render";
import { DraftStatusBanner } from "@/ui/components/dashboards/draft-status-banner";
import { PublishDiffModal } from "@/ui/components/dashboards/publish-diff-modal";
import { diffDashboards, type DashboardDiff } from "@/ui/components/dashboards/dashboard-diff";
import { nextTileLayout, withAutoLayout } from "@/ui/components/dashboards/auto-layout";
import { hasKpiComparison, kpiComparisonSignature } from "@/ui/components/dashboards/kpi-card";
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
  KpiComparisonResult,
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

  // #4315 — the canvas renders the caller's DRAFT while editing (the private
  // working copy every edit lands in), the published state otherwise. The URL
  // is the fetch cache key, so toggling Edit re-fetches the correct view. The
  // server overlays the draft only when one exists (non-forking); a viewer or
  // a board with no draft still gets published, so this never leaks.
  const [editing, setEditing] = useState(false);

  const { data: dashboard, loading, error, refetch } = useAdminFetch<DashboardWithCards>(
    editing ? `/api/v1/dashboards/${id}?view=draft` : `/api/v1/dashboards/${id}`,
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

  const [density, setDensity] = useState<Density>("comfortable");
  // #3211 — whole-dashboard export state. `exportError` surfaces a failed
  // render (or a partial-render warning) in the same banner family as the
  // parameter / mutation errors below.
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
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

  // #3212 — page-level handle on the SAME `dparams` URL key the parameter bar
  // owns. Click-to-drilldown WRITES here; the bar — subscribed to the same nuqs
  // key — observes the change and fires the single batched re-render via its
  // onChange effect (so the bar stays the sole render trigger). Read access lets
  // us merge a drilldown value into the current override map.
  const [dparamsRaw, setDparamsRaw] = useQueryState(DASHBOARD_PARAMS_KEY, dashboardParamsParser);

  // #2267 — parameter bar state. `paramResults` holds ephemeral, per-viewer
  // rendered rows keyed by cardId (NOT persisted to the card cache); when set,
  // they overlay the cached snapshot on the grid. Empty override map → show the
  // cached snapshot (rendered server-side with the parameters' defaults).
  const [paramResults, setParamResults] = useState<Record<string, { columns: string[]; rows: Record<string, unknown>[] }>>({});
  const [paramLoading, setParamLoading] = useState(false);
  // #3211 — flips true once the first parameter batch (fired by the parameter
  // bar on mount with the URL's overrides) has settled. The whole-dashboard
  // export's headless render waits on the `data-dashboard-export-ready` signal
  // below so it never captures the cached default board before parameterized
  // renders land.
  const [paramSettledOnce, setParamSettledOnce] = useState(false);
  // Surfaced when one or more cards fail to render with the chosen parameters
  // (e.g. 409 approval_required, 503 connection unavailable) — otherwise the
  // grid would silently fall back to the cached snapshot and the filter would
  // appear to do nothing.
  const [paramError, setParamError] = useState<string | null>(null);

  // #3137 / #3207 — KPI comparison results keyed by cardId. A `kpi` card's delta
  // chip is computed client-side from its primary value vs. this comparison
  // value; both come from the `/render` endpoint, which runs the card's
  // comparison through the same SQL guard — either a hand-written `comparisonSql`
  // (#3137) or the card's own SQL against the auto-derived prior window (#3207).
  // Re-fetched on parameter change so the comparison period tracks the chosen
  // `:date_*` window.
  const [comparisons, setComparisons] = useState<Record<string, KpiComparisonResult | null>>({});

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
    // #4315 — while editing, a single-card refresh runs the DRAFT SQL (server
    // returns fresh rows without persisting to the published cache).
    const viewSuffix = editing ? "?view=draft" : "";
    await mutate({ path: `/api/v1/dashboards/${id}/cards/${cardId}/refresh${viewSuffix}`, method: "POST" });
    setRefreshingCardId(null);
  }

  async function handleRefreshAll() {
    setRefreshingAll(true);
    await mutate({ path: `/api/v1/dashboards/${id}/refresh`, method: "POST" });
    setRefreshingAll(false);
  }

  // #3211 — export the whole board at the viewer's CURRENT parameter values.
  // The override map lives in the URL (`dparams`, written by the parameter
  // bar), so reading it here is the single source of truth — no extra state to
  // keep in sync. We fetch the binary, then trigger a browser download.
  async function handleExport(format: "png" | "pdf") {
    if (!dashboard) return;
    setExporting(true);
    setExportError(null);
    try {
      let parameters: Record<string, string | number | null> = {};
      const raw = searchParams.get("dparams");
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            parameters = parsed as Record<string, string | number | null>;
          }
        } catch {
          // Malformed URL state — export with the parameter defaults.
        }
      }

      const res = await fetch(`${apiUrl}/api/v1/dashboards/${id}/export`, {
        method: "POST",
        credentials: isCrossOrigin ? "include" : "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ format, parameters }),
      });

      if (!res.ok) {
        let message = `Export failed (${res.status}). Please try again.`;
        try {
          const body = (await res.json()) as { message?: string; requestId?: string };
          if (body.message) {
            message = body.requestId ? `${body.message} (request ${body.requestId})` : body.message;
          }
        } catch {
          // Non-JSON error body — keep the status-based message.
        }
        setExportError(message);
        return;
      }

      const blob = await res.blob();
      const filename =
        parseAttachmentFilename(res.headers.get("content-disposition")) ??
        `${dashboard.title || "dashboard"}.${format}`;
      downloadBlob(blob, filename);

      // A partial render still downloads — warn that the file may be incomplete
      // rather than silently shipping a board with a blank tile.
      setExportError(
        res.headers.get("x-atlas-export-partial") === "1"
          ? "Some tiles did not finish rendering — the exported file may be incomplete."
          : null,
      );
    } catch (err) {
      // A fetch-level reject (offline, DNS, CORS) surfaces a cryptic
      // `TypeError: Failed to fetch` — log the detail for debugging and show
      // an actionable message with retry guidance instead of the raw string.
      console.error(
        "[dashboard] export request failed:",
        err instanceof Error ? err.message : String(err),
      );
      setExportError("Could not reach the server to export this dashboard. Check your connection and try again.");
    } finally {
      setExporting(false);
    }
  }

  // #3210 — export a single card's CURRENT parameter-bound result as CSV. The
  // override map in the URL (`dparams`) is the same source of truth the whole-
  // board export reads, so the file reflects exactly what the viewer sees. The
  // server reuses the render pipeline (validation + auto-LIMIT + binding) — this
  // never opens a second SQL path.
  async function handleExportCardCsv(card: DashboardCard) {
    let parameters: Record<string, string | number | null> = {};
    const raw = searchParams.get("dparams");
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          parameters = parsed as Record<string, string | number | null>;
        }
      } catch {
        // Malformed URL state — export with the parameter defaults.
      }
    }

    try {
      // #4315 — export the DRAFT card's data while editing (runs the draft SQL).
      const viewParam = editing ? "&view=draft" : "";
      const res = await fetch(
        `${apiUrl}/api/v1/dashboards/${id}/cards/${card.id}/render?format=csv${viewParam}`,
        {
          method: "POST",
          credentials: isCrossOrigin ? "include" : "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ parameters }),
        },
      );

      if (!res.ok) {
        let message = `Couldn't export "${card.title}" (${res.status}). Please try again.`;
        try {
          const body = (await res.json()) as { message?: string; requestId?: string };
          if (body.message) {
            message = body.requestId ? `${body.message} (request ${body.requestId})` : body.message;
          }
        } catch {
          // Non-JSON error body — keep the status-based message.
        }
        toast.error("CSV export failed", { description: message });
        return;
      }

      const blob = await res.blob();
      const filename =
        parseAttachmentFilename(res.headers.get("content-disposition")) ??
        `${card.title || "card"}.csv`;
      downloadBlob(blob, filename);

      // Auto-LIMIT capped the export — surface it rather than implying the file
      // is the complete result set.
      if (res.headers.get("x-atlas-truncated") === "1") {
        const rowCount = res.headers.get("x-atlas-row-count");
        toast.warning("Export truncated", {
          description: rowCount
            ? `Capped at the ${rowCount}-row limit — narrow the query to export everything.`
            : "The export was capped at the row limit.",
        });
      } else {
        toast.success(`Exported "${card.title}" as CSV`);
      }
    } catch (err) {
      // A fetch-level reject (offline, DNS, CORS) surfaces a cryptic
      // `TypeError: Failed to fetch` — log the detail and show an actionable
      // message rather than the raw string.
      console.error(
        "[dashboard] CSV export request failed:",
        err instanceof Error ? err.message : String(err),
      );
      toast.error("CSV export failed", {
        description: "Could not reach the server. Check your connection and try again.",
      });
    }
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
        // #3209 — copy the source card's event annotations so a duplicated
        // annotated card keeps its markers instead of silently losing them.
        annotations: card.annotations,
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

  // #2267 — overlay ephemeral parameter-rendered rows onto each card's cached
  // fields. The tile reads `cachedColumns`/`cachedRows`, so swapping them in
  // here renders the parameterized result with no tile-level changes. Cards
  // with no rendered result (or when no overrides are active) fall back to the
  // persisted cached snapshot.
  const cardsForGrid: DashboardCard[] = dashboard
    ? dashboard.cards.map((c) => {
        const withLayout = optimisticLayouts[c.id] ? { ...c, layout: optimisticLayouts[c.id] } : c;
        const rendered = paramResults[c.id];
        return rendered
          ? { ...withLayout, cachedColumns: rendered.columns, cachedRows: rendered.rows }
          : withLayout;
      })
    : [];

  // #3213 — cross-filter derivations from the shared `dparams` override map.
  // `activeFilters` keeps only overrides that map to a declared parameter and
  // carry a non-empty value, so the chips, the per-card incompatibility marking,
  // and the per-card "selected" element all read from one source consistent with
  // what the render path actually binds. (React Compiler memoizes these pure
  // derives — no manual useMemo per CLAUDE.md.)
  const overrides = parseOverrides(dparamsRaw);
  const filters = dashboard ? activeFilters(overrides, dashboard.parameters) : [];
  const activeFilterKeys = filters.map((f) => f.key);
  const incompatIds = dashboard
    ? incompatibleCardIds(dashboard.cards, activeFilterKeys)
    : new Set<string>();
  // cardId → the active value of THAT card's own drilldown target param, so its
  // matching bar / slice / row renders "selected" (re-clicking it deselects).
  const selectedValues: Record<string, string> = {};
  if (dashboard) {
    for (const card of dashboard.cards) {
      const targetParam = card.chartConfig?.drilldown?.targetParam;
      if (!targetParam) continue;
      const value = overrides[targetParam];
      if (value !== null && value !== undefined && value !== "") {
        selectedValues[card.id] = String(value);
      }
    }
  }

  // The stage handler fires when the user clicks Accept / Discard in the
  // bound chat drawer. We refetch BOTH the dashboard (the draft cards
  // changed after an accept) AND the stage list (the row is no longer
  // pending). Both calls are cheap (org-scoped GETs).
  function handleStagesChanged() {
    refetch();
    refetchStages();
  }

  // #2267 — re-render every card when the parameter bar commits a change.
  // Renders are ephemeral (not persisted): we POST each card's /render with the
  // override values and overlay the returned rows on the grid. A sequence guard
  // drops stale batches so a slower earlier change can't clobber a newer one.
  const paramReqSeq = useRef(0);
  // #3137 — a SINGLE sequence counter for every write to `comparisons`, shared
  // by both writers (this handler's override path and `loadDefaultComparisons`).
  // Without a shared counter, a slow default-period fetch could land after an
  // override and clobber its delta chips with stale default-period values.
  const comparisonReqSeq = useRef(0);
  async function handleParamsChange(overrides: ParameterValues) {
    if (!dashboard) return;
    // Advance the sequence on EVERY change — including Reset — so an older
    // in-flight render batch can never repopulate `paramResults` after the
    // user has cleared or changed the parameters.
    const seq = ++paramReqSeq.current;
    // No overrides → show the cached snapshot (server-rendered with defaults).
    // KPI deltas still need their comparison query though — re-fetch it against
    // the parameter defaults so resetting the bar restores the default-period
    // delta rather than leaving a stale one from the prior override.
    if (Object.keys(overrides).length === 0) {
      setParamResults({});
      setParamError(null);
      setParamLoading(false);
      setParamSettledOnce(true);
      void loadDefaultComparisons();
      return;
    }
    // #3137 — claim ownership of the shared comparison counter too, so a
    // concurrently in-flight loadDefaultComparisons (from mount or a prior
    // reset) can't land afterward and overwrite this batch's delta chips.
    const cSeq = ++comparisonReqSeq.current;
    setParamLoading(true);
    setParamError(null);
    try {
      // #3138: text cards are skipped inside renderDashboardCards (no SQL).
      // One POST per chart card, binding `overrides` server-side (#3212 drilldown
      // and #2267 manual changes flow through the same batch).
      const entries = await renderDashboardCards(dashboard.cards, overrides, {
        apiUrl,
        dashboardId: id,
        isCrossOrigin,
        // #4315 — the canvas shows the draft while editing; render its SQL.
        view: editing ? "draft" : "published",
      });
      // A newer change superseded this batch — discard its results.
      if (seq !== paramReqSeq.current) return;
      const next: Record<string, { columns: string[]; rows: Record<string, unknown>[] }> = {};
      const nextComparisons: Record<string, KpiComparisonResult | null> = {};
      const errors: string[] = [];
      for (const entry of entries) {
        if (entry.ok) {
          next[entry.cardId] = { columns: entry.columns, rows: entry.rows };
          // `comparison` is undefined for a non-KPI card (the render endpoint
          // omits the field) — record only the KPI cards, whose value is the
          // comparison block or `null` (comparison configured but failed).
          if (entry.comparison !== undefined) nextComparisons[entry.cardId] = entry.comparison;
        } else errors.push(entry.error);
      }
      setParamResults(next);
      // Guarded by the shared comparison counter, not paramReqSeq — a newer
      // default-period fetch must win over this batch's deltas.
      if (cSeq === comparisonReqSeq.current) setComparisons(nextComparisons);
      if (errors.length > 0) {
        const distinct = [...new Set(errors)];
        const shown = distinct.slice(0, 2).join("; ");
        setParamError(
          `${errors.length} card${errors.length > 1 ? "s" : ""} couldn't be updated with these parameters: ${shown}${distinct.length > 2 ? "…" : ""}`,
        );
      } else {
        setParamError(null);
      }
    } finally {
      if (seq === paramReqSeq.current) {
        setParamLoading(false);
        setParamSettledOnce(true);
      }
    }
  }

  // #3212 drilldown + #3213 cross-filter. Clicking a chart element / table row
  // sets the card's drilldown target parameter to the clicked category value by
  // merging it into the shared `dparams` URL key. We don't refetch here: writing
  // the key updates the parameter bar (which reflects the value and lets the user
  // clear/override it) and the bar's onChange effect issues the SINGLE batched
  // /render of every card with the bound value — server-side parameterized, never
  // string-interpolated, one click → one batched refetch (no waterfall). The
  // value binds to EVERY card whose SQL references `:targetParam` (cross-card
  // filtering); cards that don't are visibly marked incompatible below.
  function handleDrilldown(targetParam: string, value: string) {
    if (!dashboard) return;
    // Ignore a target that names no declared parameter — the render endpoint
    // binds declared parameters only, so an unknown key would set dead URL
    // state that no card reads. (A misconfigured card, not an expected path.)
    const param = dashboard.parameters.find((p) => p.key === targetParam);
    if (!param) {
      console.debug("[dashboard] drilldown target is not a declared parameter; ignoring", {
        targetParam,
      });
      return;
    }
    // Normalize for the target type — e.g. a `date` param's DatePicker only
    // reads YYYY-MM-DD, so a timestamp category must be sliced or the bar shows
    // a blank date even though the filter applied.
    const normalized = normalizeDrilldownValue(param.type, value);
    // #3213 — toggle: re-clicking the already-selected value clears it (deselect).
    void setDparamsRaw(toggleOverride(dparamsRaw, targetParam, normalized));
  }

  // #3213 — filter-chips handlers. Both write the shared `dparams` key, so the
  // parameter bar (same key) observes the change and fires the single batched
  // re-render — chip removal / clear-all go through the same one-refetch path as
  // a drilldown click, never N sequential requests.
  function handleRemoveFilter(key: string) {
    void setDparamsRaw(withOverride(dparamsRaw, key, null));
  }
  function handleClearAllFilters() {
    // null clears the whole key — nuqs drops the param entirely.
    void setDparamsRaw(null);
  }

  // #3137 — fetch KPI comparison values against the parameter DEFAULTS. Used on
  // first load and when the bar is reset; interactive overrides are captured
  // inline in handleParamsChange instead (a single /render call carries both the
  // primary rows and the comparison). The shared `comparisonReqSeq` guard drops
  // stale batches (including ones racing an in-flight override write).
  async function loadDefaultComparisons() {
    if (!dashboard) return;
    const kpiCards = dashboard.cards.filter(hasKpiComparison);
    const seq = ++comparisonReqSeq.current;
    if (kpiCards.length === 0) {
      setComparisons({});
      return;
    }
    // #4315 — while editing, the KPI comparison runs the draft card's SQL too.
    const viewParam = editing ? "?view=draft" : "";
    const entries = await Promise.all(
      kpiCards.map(async (card): Promise<[string, KpiComparisonResult | null]> => {
        try {
          const res = await fetch(
            `${apiUrl}/api/v1/dashboards/${id}/cards/${card.id}/render${viewParam}`,
            {
              method: "POST",
              credentials: isCrossOrigin ? "include" : "same-origin",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ parameters: {} }),
            },
          );
          if (!res.ok) {
            // Degrade to no delta chip, but surface the backend reason for
            // debugging — never drop a non-OK response without a trace.
            let reason = `status ${res.status}`;
            try {
              const body = (await res.json()) as { message?: string; error?: string };
              reason = body.message ?? body.error ?? reason;
            } catch {
              // non-JSON error body — keep the status-based reason
            }
            console.debug("[dashboard] KPI comparison render not OK", {
              cardId: card.id,
              status: res.status,
              reason,
            });
            return [card.id, null];
          }
          const json = (await res.json()) as { comparison?: KpiComparisonResult | null };
          return [card.id, json.comparison ?? null];
        } catch (err) {
          // A failed comparison must not break the KPI render — log and drop the
          // delta chip rather than swallowing silently.
          console.debug("[dashboard] KPI comparison fetch failed", {
            cardId: card.id,
            err: err instanceof Error ? err.message : String(err),
          });
          return [card.id, null];
        }
      }),
    );
    if (seq !== comparisonReqSeq.current) return;
    setComparisons(Object.fromEntries(entries));
  }

  // Re-fetch default-period comparisons whenever the set of KPI cards (or their
  // comparison queries) changes — keyed on a derived signature so an unrelated
  // dashboard refetch (stage change, layout save) doesn't re-run it.
  const kpiSignature = kpiComparisonSignature(dashboard?.cards ?? []);
  // Keyed on the derived signature only: loadDefaultComparisons reads
  // dashboard/apiUrl/id/isCrossOrigin, but the signature is the sole input that
  // should re-trigger the fetch (a dashboard refetch with the same KPI set
  // must not re-run it).
  useEffect(() => {
    void loadDefaultComparisons();
  }, [kpiSignature]);

  // #3211 — readiness signal the whole-dashboard export's headless render waits
  // on. "1" once the dashboard has loaded AND, when parameter overrides are
  // active in the URL, the first parameter batch has settled — so a
  // parameterized export never captures the cached default board. A param-less
  // dashboard (or one with no active overrides) is ready as soon as it loads.
  const dparamsActive = (dashboard?.parameters.length ?? 0) > 0 && Boolean(searchParams.get("dparams"));
  const exportReady =
    !loading && !error && Boolean(dashboard) && !paramLoading && (!dparamsActive || paramSettledOnce);

  return (
    <StageProvider value={{ dashboardId: id, onStagesChanged: handleStagesChanged }}>
      <div
        className="flex h-full flex-1 flex-col overflow-auto"
        data-dashboard-export-ready={exportReady ? "1" : "0"}
      >
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
              onExport={handleExport}
              exporting={exporting}
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
              editing={editing}
              onExitEditing={() => setEditing(false)}
            />

            {dashboard.parameters.length > 0 && (
              <DashboardParameterBar
                parameters={dashboard.parameters}
                onChange={handleParamsChange}
                loading={paramLoading}
              />
            )}

            {/* #3213 — active cross-filter chips (self-hides when none are set). */}
            <DashboardFilterChips
              filters={filters}
              onRemove={handleRemoveFilter}
              onClearAll={handleClearAllFilters}
            />

            {paramError && (
              <div className="mx-4 mt-3 flex items-start justify-between gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 sm:mx-6 dark:border-amber-900/50 dark:bg-amber-950/20 dark:text-amber-300">
                <span>{paramError}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 shrink-0 text-xs"
                  onClick={() => setParamError(null)}
                >
                  Dismiss
                </Button>
              </div>
            )}

            {mutationError && (
              <div className="mx-4 mt-3 rounded-md border border-red-200 bg-red-50/60 px-3 py-2 text-xs text-red-700 dark:border-red-900/50 dark:bg-red-950/20 dark:text-red-400 sm:mx-6">
                {friendlyError(mutationError)}
              </div>
            )}

            {exportError && (
              <div className="mx-4 mt-3 flex items-start justify-between gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 sm:mx-6 dark:border-amber-900/50 dark:bg-amber-950/20 dark:text-amber-300">
                <span>{exportError}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 shrink-0 text-xs"
                  onClick={() => setExportError(null)}
                >
                  Dismiss
                </Button>
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
                  comparisons={comparisons}
                  onDrilldown={handleDrilldown}
                  incompatibleCardIds={incompatIds}
                  selectedValues={selectedValues}
                  onLayoutChange={handleLayoutChange}
                  onRefresh={handleRefreshCard}
                  onDuplicate={handleDuplicate}
                  onDelete={setDeleteCardTarget}
                  onUpdateTitle={handleUpdateCardTitle}
                  onExportCsv={handleExportCardCsv}
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
