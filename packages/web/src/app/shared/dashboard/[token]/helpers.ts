// Pure helpers for the shared dashboard surface — no JSX, no React, no client
// hooks. Lives in its own file so `view.tsx` can stay a pure server-component
// renderer and the helpers can be unit-tested without spinning up Next.

import type { SharedCard } from "./types";

/**
 * Format a timestamp relative to "now". Callers run this on the server (`view.tsx`
 * is server-rendered, `page.tsx` uses `cache: "no-store"`) so SSR + hydration
 * agree to the second. If a future caller adds RSC caching upstream, the
 * "X minutes ago" string will go stale silently — pin freshness at the data
 * fetch layer, not here.
 */
export function timeAgo(iso: string | null): string | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) {
    warnInvalidIso(iso, "timeAgo");
    return null;
  }
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
export function mostRecentCachedAt(cards: SharedCard[]): string | null {
  let latestMs: number | null = null;
  let raw: string | null = null;
  for (const c of cards) {
    if (!c.cachedAt) continue;
    const t = new Date(c.cachedAt).getTime();
    if (!Number.isFinite(t)) {
      warnInvalidIso(c.cachedAt, "mostRecentCachedAt");
      continue;
    }
    if (latestMs === null || t > latestMs) {
      latestMs = t;
      raw = c.cachedAt;
    }
  }
  return raw;
}

/**
 * Map a saved tile width (1–24 grid units from the editor) to a 2-column
 * shared-view span. ≥13 = full row; ≤12 = half. Mobile (`<md`) is always
 * single-column; the editor's RGL grid has no responsive breakpoints, so the
 * shared read-only view substitutes its own.
 */
export function tileSpanClass(layout: SharedCard["layout"]): string {
  const w = layout?.w ?? 12;
  return w >= 13 ? "md:col-span-2" : "md:col-span-1";
}

export function isoOrUndefined(value: string | null): string | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    warnInvalidIso(value, "isoOrUndefined");
    return undefined;
  }
  return d.toISOString();
}

function warnInvalidIso(value: string, where: string): void {
  // Backend regression that emits a non-ISO timestamp would otherwise surface
  // as a silently missing chip / "NaNm ago" / dropped `<time dateTime>` attr.
  // One warn per call site is enough — log and move on, don't block render.
  console.warn(`[shared-dashboard] ${where}: invalid timestamp ${JSON.stringify(value)}`);
}
