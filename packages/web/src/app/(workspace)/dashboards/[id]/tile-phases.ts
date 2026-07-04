/**
 * Fold a card-render batch into per-tile phases + overlays (#4321 — the tile is
 * the unit of trust).
 *
 * The render batch (`renderDashboardCards`) returns one ok/err entry per chart
 * card. The OLD page folded only the successes into an overlay map, so a card
 * whose parameter render FAILED simply fell out of the map and the grid quietly
 * reverted it to its persisted (unfiltered) snapshot — a board silently mixing
 * two windows.
 *
 * This module is the fix, split into two pure steps:
 *   1. `foldRenderEntries` — EVERY entry becomes an explicit phase (`ok` overlay
 *      or `error`), so a failed tile is never dropped.
 *   2. `mergeOverlays` — merges the batch's `ok` overlays over the prior ones
 *      while a failed (`error`) tile KEEPS its prior overlay, labeled-stale,
 *      instead of masquerading the old unfiltered number as the current one.
 *
 * Both are framework-free so the anti-silent-revert guarantee is unit-testable
 * without mounting the page.
 */
import type { CardRenderEntry } from "./dashboard-card-render";
import type { KpiComparisonResult } from "@/ui/lib/types";
import type { TileRenderPhase } from "@/ui/components/dashboards/tile-status";

/** A tile's ephemeral, per-viewer rendered rows + the time they were rendered
 *  (so the age caption resets to "just now" for a fresh parameter render). */
export interface TileOverlay {
  columns: string[];
  rows: Record<string, unknown>[];
  renderedAt: string;
}

/**
 * The render phase of a single tile after a batch. `foldRenderEntries` only ever
 * emits `ok` / `error` (a batch entry is one or the other); the `loading` phase
 * lives in {@link TileRenderPhase}, set on the page BEFORE a batch resolves.
 */
export type TilePhase =
  | { phase: "ok"; columns: string[]; rows: Record<string, unknown>[]; renderedAt: string }
  | { phase: "error"; message: string };

export interface FoldedRender {
  /** cardId → phase. Contains an entry for EVERY card in the batch — successes
   *  as `ok`, failures as `error`. Never omits a failed card. */
  phases: Record<string, TilePhase>;
  /** cardId → KPI comparison block (or null), for the cards that carried one. */
  comparisons: Record<string, KpiComparisonResult | null>;
}

/**
 * Fold render entries into tile phases. `renderedAt` stamps every successful
 * tile so its age caption resets to "just now" (a fresh parameter render is not
 * as old as the persisted snapshot it replaced).
 */
export function foldRenderEntries(entries: CardRenderEntry[], renderedAt: string): FoldedRender {
  const phases: Record<string, TilePhase> = {};
  const comparisons: Record<string, KpiComparisonResult | null> = {};

  for (const entry of entries) {
    if (entry.ok) {
      phases[entry.cardId] = {
        phase: "ok",
        columns: entry.columns,
        rows: entry.rows,
        renderedAt,
      };
      // `comparison` is undefined for a non-KPI card (the render endpoint omits
      // the field); record only the KPI cards, whose value is the block or null.
      if (entry.comparison !== undefined) comparisons[entry.cardId] = entry.comparison;
    } else {
      // A failed card is kept as an explicit error phase — NOT dropped. This is
      // the anti-silent-revert guarantee: the tile stays labeled-stale rather
      // than reverting to its old unfiltered number as if nothing failed.
      // (`entry.error` is already a plain string reason from the render helper.)
      const message = entry.error;
      phases[entry.cardId] = { phase: "error", message };
    }
  }

  return { phases, comparisons };
}

/**
 * Merge a batch's `ok` overlays over the prior overlay map. A card that
 * SUCCEEDED refreshes its overlay (+ timestamp); a card that FAILED (`error`
 * phase) KEEPS its prior overlay untouched, so its retained data stays visible
 * and labeled-stale rather than reverting to the persisted unfiltered snapshot.
 *
 * This is the load-bearing anti-silent-revert step: after `filter A` succeeds
 * (overlay A) and `filter B` then fails for the tile, the tile must keep showing
 * window A labeled-stale — NOT silently fall back to the unfiltered cache.
 */
export function mergeOverlays(
  prev: Record<string, TileOverlay>,
  phases: Record<string, TilePhase>,
): Record<string, TileOverlay> {
  const next = { ...prev };
  for (const [cardId, phase] of Object.entries(phases)) {
    if (phase.phase === "ok") {
      next[cardId] = { columns: phase.columns, rows: phase.rows, renderedAt: phase.renderedAt };
    }
    // `error`: intentionally leave `next[cardId]` as-is — the retained overlay
    // stays labeled-stale. Dropping it here would reintroduce the silent revert.
  }
  return next;
}

/** The tile-render phase discriminant a folded phase contributes to the page's
 *  `renderPhases` map. Kept as a helper so the coupling `TilePhase["phase"]` ⊆
 *  {@link TileRenderPhase} is explicit rather than incidental. */
export function phaseTag(phase: TilePhase): TileRenderPhase {
  return phase.phase;
}
