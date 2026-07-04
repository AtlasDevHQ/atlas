/**
 * Fold a card-render batch into per-tile phases (#4321 — the tile is the unit
 * of trust).
 *
 * The render batch (`renderDashboardCards`) returns one ok/err entry per chart
 * card. The OLD page folded only the successes into an overlay map, so a card
 * whose parameter render FAILED simply fell out of the map and the grid quietly
 * reverted it to its persisted (unfiltered) snapshot — a board silently mixing
 * two windows.
 *
 * This fold is the fix: EVERY entry produces an explicit phase — a success
 * becomes an `ok` overlay, a failure becomes an `error` phase. A failed tile is
 * therefore never dropped; the grid keeps its older data but the tile labels it
 * stale (with its age) and offers a retry, instead of masquerading the old
 * number as the current filtered one.
 *
 * Pure + framework-free so the anti-silent-revert guarantee is unit-testable
 * without mounting the page.
 */
import type { CardRenderEntry } from "./dashboard-card-render";
import type { KpiComparisonResult } from "@/ui/lib/types";

/** The render phase of a single tile after a batch (or a single-tile retry). */
export type TilePhase =
  | { phase: "loading" }
  | { phase: "ok"; columns: string[]; rows: Record<string, unknown>[]; renderedAt: string }
  | { phase: "error"; message: string };

export interface FoldedRender {
  /** cardId → phase. Contains an entry for EVERY card in the batch — successes
   *  as `ok`, failures as `error`. Never omits a failed card. */
  phases: Record<string, TilePhase>;
  /** cardId → KPI comparison block (or null), for the cards that carried one. */
  comparisons: Record<string, KpiComparisonResult | null>;
  /** Ids of the cards whose render failed — the tiles that stay labeled-stale. */
  failedCardIds: string[];
}

/**
 * Fold render entries into tile phases. `renderedAt` stamps every successful
 * tile so its age caption resets to "just now" (a fresh parameter render is not
 * as old as the persisted snapshot it replaced).
 */
export function foldRenderEntries(entries: CardRenderEntry[], renderedAt: string): FoldedRender {
  const phases: Record<string, TilePhase> = {};
  const comparisons: Record<string, KpiComparisonResult | null> = {};
  const failedCardIds: string[] = [];

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
      failedCardIds.push(entry.cardId);
    }
  }

  return { phases, comparisons, failedCardIds };
}
