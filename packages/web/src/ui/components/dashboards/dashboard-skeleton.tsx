import { Skeleton } from "@/components/ui/skeleton";

/**
 * Loading skeletons for the dashboard surface (#4323 — first-impression polish).
 *
 * The point is CLS, not decoration: the skeleton reserves the SAME vertical
 * regions the loaded page occupies — a sticky top-bar row, a banner-strip row,
 * and a tile grid — so the real content lands in place instead of the grid
 * jumping down as the top bar, draft banner, and tiles paint in. Replaces the
 * blank `null` / bare-list loading states the route rendered before.
 */

/** A single tile placeholder that mirrors the real tile chrome: head row,
 *  body, and footer caption — so the grid doesn't reflow when tiles arrive. */
function TileSkeleton() {
  return (
    <div className="flex h-64 flex-col overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex items-center gap-2 border-b border-zinc-100 px-3 py-2 dark:border-zinc-800/80">
        <Skeleton className="h-4 flex-1" />
        <Skeleton className="size-6 shrink-0 rounded" />
      </div>
      <div className="min-h-0 flex-1 p-4">
        <Skeleton className="h-full w-full" />
      </div>
      <div className="flex items-center justify-between border-t border-zinc-100 px-3 py-1.5 dark:border-zinc-800/80">
        <Skeleton className="h-3 w-16" />
        <Skeleton className="h-3 w-10" />
      </div>
    </div>
  );
}

/**
 * Full detail-page skeleton: a top-bar row, a reserved banner strip, and a
 * grid of tile skeletons. Used by the `/dashboards/[id]` loading branch AND
 * the route-level `loading.tsx`, so a hard navigation and a client fetch show
 * the same layout-matching placeholder.
 */
export function DashboardDetailSkeleton() {
  return (
    <div
      className="flex h-full flex-1 flex-col overflow-hidden"
      data-testid="dashboard-detail-skeleton"
      aria-hidden="true"
    >
      {/* Top bar — mirrors the sticky DashboardTopBar row (title + actions). */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800 sm:px-6">
        <div className="flex min-w-0 flex-col gap-1.5">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-3 w-32" />
        </div>
        <div className="flex items-center gap-2">
          <Skeleton className="h-8 w-24 rounded-md" />
          <Skeleton className="h-8 w-20 rounded-md" />
          <Skeleton className="h-8 w-20 rounded-md" />
        </div>
      </div>

      {/* Reserved banner strip — the draft / parameter / filter rows land here
          once their async data arrives, so the grid below doesn't jump. */}
      <div className="px-4 pt-3 sm:px-6">
        <Skeleton className="h-9 w-full rounded-md" />
      </div>

      {/* Tile grid — 2-up on desktop, matching the default 12-col tiles. */}
      <div className="grid flex-1 grid-cols-1 gap-4 px-3 py-4 sm:px-5 md:grid-cols-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <TileSkeleton key={i} />
        ))}
      </div>
    </div>
  );
}

/**
 * Compact skeleton for the redirect-only `/dashboards` index. It forwards to
 * the most-recent board, but the fetch is a real round-trip — this fills the
 * gap with a top-bar + tile-grid placeholder instead of a blank frame so the
 * redirect never flashes an empty screen.
 */
export function DashboardListSkeleton() {
  return (
    <div
      className="flex h-full flex-1 flex-col overflow-hidden"
      data-testid="dashboard-list-skeleton"
      aria-hidden="true"
    >
      <div className="flex items-center justify-between gap-3 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800 sm:px-6">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-8 w-24 rounded-md" />
      </div>
      <div className="grid flex-1 grid-cols-1 gap-4 px-3 py-4 sm:px-5 md:grid-cols-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <TileSkeleton key={i} />
        ))}
      </div>
    </div>
  );
}
