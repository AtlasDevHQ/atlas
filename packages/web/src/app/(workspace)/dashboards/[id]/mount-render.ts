/**
 * Canvas-mount draft render (#4557, ADR-0034 Decision 1) — the lazy half of the
 * seeding decision.
 *
 * Tool-side seeding (#4558) executes each staged card inside the `createDashboard`
 * / bound `addCard` call and writes the draft cache, so a chat-built board
 * arrives showing real data. But a card can be left UNSEEDED — the seeding
 * wall-clock budget elapsed, a transient execution failure, or a legacy draft
 * built before seeding existed. Those cards land on the canvas as "Never run"
 * tiles with no data home.
 *
 * This module is the fallback: when the draft holder's canvas mounts, any
 * never-run draft card fires its OWN draft render, so arrival after an agent
 * build shows data (or an honest per-tile errored / empty state) rather than a
 * wall of "Never run". Kept pure + framework-free so the two load-bearing
 * decisions — WHICH cards to render, and the bounded concurrency that keeps a
 * wide board from firing a dozen simultaneous renders at the datasource — are
 * unit-testable without mounting the page. The page's effect is a thin wrapper
 * that feeds `renderDashboardCard` through `runBounded`.
 */
import type { DashboardCard } from "@/ui/lib/types";
import type { CardRenderEntry } from "./dashboard-card-render";
import { isRenderableCard } from "./dashboard-card-render";
import type { TileRenderPhase } from "@/ui/components/dashboards/tile-status";

/**
 * How many mount renders run at once. A never-run board arrives with every tile
 * unseeded (the whole tool-side batch missed its budget), so an unbounded
 * `Promise.all` would fan a dozen concurrent queries at the datasource on mount.
 * Four keeps the canvas populating promptly without a thundering herd — well
 * under a typical connection pool while still overlapping the round-trips.
 */
export const MOUNT_RENDER_CONCURRENCY = 4;

/**
 * Select the never-run cards that need a canvas-mount draft render. A card
 * qualifies when it is SQL-backed (renderable — not a `text` section block,
 * which has no query) AND has never produced data (`cachedAt == null`, i.e. no
 * draft cache yet). `attempted` excludes cards this session already fired a
 * mount render for — so:
 *
 *   - a dashboard refetch (draft status settling, a sibling mutation, an agent
 *     adding a card mid-session) never re-executes an in-flight card, and
 *   - a mount render that FAILED is not auto-retried into a loop — its tile
 *     reads `errored` with a one-click manual retry instead.
 *
 * Already-seeded tiles (`cachedAt != null`) are never selected, so they do not
 * re-execute on mount.
 */
export function selectMountRenderCards(
  cards: readonly DashboardCard[],
  attempted: ReadonlySet<string>,
): DashboardCard[] {
  return cards.filter(
    (card) => isRenderableCard(card) && card.cachedAt == null && !attempted.has(card.id),
  );
}

/**
 * Whether the canvas-mount draft render should run this pass. The POLICY gate,
 * separate from the data-readiness check (`dashboard` loaded) the caller keeps:
 *
 *   - `showDraftView` — only the draft holder's draft view fires mount renders;
 *     a published-only view is untouched (AC: "Published-only views are
 *     unaffected").
 *   - `!overridesActive` — when parameter overrides are active in the URL, the
 *     parameter bar's mount batch already renders every card (never-run ones
 *     included), so firing here too would double-execute.
 *   - `hasDashboard` — nothing to render until the board has loaded.
 */
export function shouldRunMountRender(input: {
  showDraftView: boolean;
  hasDashboard: boolean;
  overridesActive: boolean;
}): boolean {
  return input.showDraftView && input.hasDashboard && !input.overridesActive;
}

/**
 * Map a settled card-render entry to the tile's render phase. A success reads
 * `ok` (the tile flips to fresh / empty from its freshly overlaid rows); a
 * failure reads `error` — which, on a never-run card with no prior data,
 * resolves to the tile's `errored` state with the existing one-click retry, so a
 * failed mount render is never a silent blank (AC: "A failed mount-render shows
 * the tile's errored state with one-click retry").
 */
export function mountRenderPhaseFor(entry: CardRenderEntry): TileRenderPhase {
  return entry.ok ? "ok" : "error";
}

/**
 * Flip every still-`loading` tile in `ids` to `error` (immutable copy). The
 * defensive path for a rejection escaping the contractually-no-throw render
 * helper: rather than stranding those tiles on the loading placeholder forever,
 * they read `errored` + retry. Tiles that already settled (`ok` / `error`) are
 * left untouched.
 */
export function flipLoadingToError(
  phases: Readonly<Record<string, TileRenderPhase>>,
  ids: readonly string[],
): Record<string, TileRenderPhase> {
  const next = { ...phases };
  for (const id of ids) {
    if (next[id] === "loading") next[id] = "error";
  }
  return next;
}

/**
 * Run `task` over `items` with at most `limit` in flight at once. Resolves once
 * every task settles. `task` is expected to be no-throw (the render helper maps
 * every failure to a result it handles itself); a rejection propagates rather
 * than being swallowed, so a caller can log it.
 */
export async function runBounded<T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  const max = Math.max(1, Math.floor(limit));
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await task(items[index]);
    }
  }
  const workerCount = Math.min(max, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
}
