/**
 * Request-path builder for the fact review queue.
 *
 * Extracted from `page.tsx` so the filter → query-string threading is unit
 * testable without mounting a large client tree; the page's
 * `useServerDataTable` call delegates its `buildPath` here.
 *
 * There is no sort mapping. The queue's order is the read model's — stale
 * claims first (#4914's surfacing hint, a boolean float-to-top, not an age
 * sort), then newest ingest, with a deterministic id tiebreaker — and it is
 * not reviewer-selectable in this slice. That is not an oversight: the one
 * ordering a reviewer might reach for is "most contested first", and ranking
 * claims by anything derived from their conflicts is the auto-arbitration
 * ADR-0036 explicitly refuses to do (M2 owns arbitration). Decay ordering is
 * different in kind — it surfaces age for a human, it never arbitrates between
 * claims — which is why it is the one derived signal allowed near ORDER BY.
 */

import type { BrainFactStatusFilter } from "@/ui/lib/admin-schemas";

/** Page-owned filter state threaded into the list request (a read-only input). */
export interface BrainFactsFilters {
  readonly status: BrainFactStatusFilter;
  readonly provisional: boolean;
  readonly tension: boolean;
  readonly q: string;
}

/**
 * The pagination binding `useServerDataTable` passes to `buildPath` — an
 * intentional decoupled subset, so this module stays free of the hook's
 * generic `TData`.
 */
export interface BrainFactsBinding {
  readonly offset: number;
  readonly perPage: number;
}

/**
 * True when a filter NARROWS the queue, driving the "Clear" affordance and the
 * empty-state copy.
 *
 * `status` counts only when it is not the default `draft`: landing on the
 * review queue IS the draft view, so offering to "clear" it would suggest the
 * reviewer had applied something they hadn't.
 */
export function hasBrainFactFilters(filters: BrainFactsFilters): boolean {
  return (
    filters.status !== "draft" || filters.provisional || filters.tension || filters.q.trim() !== ""
  );
}

/** Build the `/api/v1/admin/brain-facts` request path from binding + filters. */
export function buildBrainFactsPath(
  binding: BrainFactsBinding,
  filters: BrainFactsFilters,
): string {
  const qs = new URLSearchParams({
    limit: String(binding.perPage),
    offset: String(binding.offset),
  });
  if (filters.status) qs.set("status", filters.status);
  // Emitted only when ON. Both are widening-free narrowing filters whose OFF
  // state is the route's default, so sending `false` would only add noise to a
  // URL a reviewer is expected to share.
  if (filters.provisional) qs.set("provisional", "true");
  if (filters.tension) qs.set("tension", "true");
  const q = filters.q.trim();
  if (q) qs.set("q", q);

  return `/api/v1/admin/brain-facts?${qs}`;
}
