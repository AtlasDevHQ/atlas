import Link from "next/link";
import { ArrowUpRight, Clock, LayoutDashboard } from "lucide-react";
import { ResultCardErrorBoundary } from "@/ui/components/chat/result-card-base";
import { SharedTile } from "./tile";
import type { SharedDashboard, SharedCard } from "./types";

/**
 * Format a timestamp relative to "now". Computed once on the server (this is a
 * server component) so SSR + hydration agree to the second — no `Date.now()`
 * drift across the boundary.
 */
function timeAgo(iso: string | null): string | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  const diff = Date.now() - t;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

/** Most recent cache time across all cards — one freshness signal beats six. */
function mostRecentCachedAt(cards: SharedCard[]): string | null {
  let latestMs: number | null = null;
  let raw: string | null = null;
  for (const c of cards) {
    if (!c.cachedAt) continue;
    const t = new Date(c.cachedAt).getTime();
    if (Number.isFinite(t) && (latestMs === null || t > latestMs)) {
      latestMs = t;
      raw = c.cachedAt;
    }
  }
  return raw;
}

/**
 * Map a saved tile width (1–24 grid units from the editor) to a 2-column
 * shared-view span. ≥13 = full row; ≤12 = half. Mobile (`<md`) is always
 * single-column — RGL has no responsive breakpoints in our config (project
 * memory note), and the read-only stack drops `overflow-auto` per #1867.
 */
function tileSpanClass(layout: SharedCard["layout"]): string {
  const w = layout?.w ?? 12;
  return w >= 13 ? "md:col-span-2" : "md:col-span-1";
}

function isoOrUndefined(value: string | null): string | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

export function SharedDashboardView({ dashboard }: { dashboard: SharedDashboard }) {
  const lastRefreshed = dashboard.lastRefreshAt ?? mostRecentCachedAt(dashboard.cards);
  const lastRefreshedIso = isoOrUndefined(lastRefreshed);
  const lastRefreshedLabel = timeAgo(lastRefreshed);
  const capturedIso = isoOrUndefined(dashboard.createdAt);
  const capturedDate = capturedIso
    ? new Date(capturedIso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })
    : null;
  const tileCount = dashboard.cards.length;

  return (
    <div className="flex min-h-screen flex-col bg-white dark:bg-zinc-950 print:bg-white print:text-black">
      <main
        id="main"
        tabIndex={-1}
        className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 focus:outline-none print:max-w-full print:p-0"
      >
        <header className="mb-6 border-b border-zinc-200 pb-4 dark:border-zinc-800 print:border-zinc-300">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400">
              <span className="font-medium text-zinc-900 dark:text-zinc-100">Atlas</span>
              <span aria-hidden="true">&middot;</span>
              <span
                className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300 print:bg-transparent print:px-0"
                aria-label="This is a read-only snapshot"
              >
                Read-only
              </span>
              {capturedDate && capturedIso && (
                <>
                  <span aria-hidden="true">&middot;</span>
                  <time dateTime={capturedIso}>Captured {capturedDate}</time>
                </>
              )}
            </div>
            <Link
              href="/signup"
              className="inline-flex items-center gap-1 text-sm font-medium text-teal-700 transition-colors hover:text-teal-800 dark:text-teal-300 dark:hover:text-teal-200 print:hidden"
            >
              Try Atlas free
              <ArrowUpRight className="size-3.5" aria-hidden="true" />
            </Link>
          </div>
          <h1 className="mt-3 text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
            {dashboard.title}
          </h1>
          {dashboard.description && (
            <p className="mt-1 max-w-3xl text-sm text-zinc-600 dark:text-zinc-400">
              {dashboard.description}
            </p>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-600 dark:text-zinc-400">
            <span>
              {tileCount} tile{tileCount === 1 ? "" : "s"}
            </span>
            {lastRefreshedLabel && lastRefreshedIso && (
              <>
                <span aria-hidden="true">&middot;</span>
                <span className="inline-flex items-center gap-1">
                  <Clock className="size-3" aria-hidden="true" />
                  Last refreshed{" "}
                  <time dateTime={lastRefreshedIso}>{lastRefreshedLabel}</time>
                </span>
              </>
            )}
          </div>
        </header>

        {tileCount === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
            <div className="grid size-12 place-items-center rounded-2xl bg-teal-50 text-teal-700 dark:bg-teal-950/40 dark:text-teal-300">
              <LayoutDashboard className="size-6" aria-hidden="true" />
            </div>
            <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
              Nothing to show yet
            </h2>
            <p className="max-w-sm text-sm text-zinc-600 dark:text-zinc-400">
              The dashboard owner hasn&rsquo;t added any tiles to share. Check back later, or build your own with Atlas.
            </p>
            <Link
              href="/signup"
              className="mt-1 inline-flex items-center gap-1 text-sm font-medium text-teal-700 hover:text-teal-800 dark:text-teal-300 dark:hover:text-teal-200 print:hidden"
            >
              Try Atlas free
              <ArrowUpRight className="size-3.5" aria-hidden="true" />
            </Link>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {dashboard.cards.map((card) => {
              // Single-tile dashboards always render full width — a half-width tile
              // floating in a half-empty grid reads like a bug, not intent.
              const spanClass = tileCount === 1 ? "md:col-span-2" : tileSpanClass(card.layout);
              return (
                <ResultCardErrorBoundary key={card.id} label={card.title}>
                  <SharedTile
                    card={card}
                    spanClass={spanClass}
                    cachedLabel={timeAgo(card.cachedAt)}
                    cachedIso={isoOrUndefined(card.cachedAt)}
                  />
                </ResultCardErrorBoundary>
              );
            })}
          </div>
        )}
      </main>

      <footer className="border-t border-zinc-200 px-4 py-4 text-center dark:border-zinc-800 print:hidden">
        <a
          href="https://www.useatlas.dev"
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-zinc-600 transition-colors hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-200"
        >
          Powered by Atlas
        </a>
      </footer>
    </div>
  );
}
