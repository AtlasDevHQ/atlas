/**
 * Fold + merge a render batch into per-tile phases/overlays (#4321).
 *
 * The load-bearing guarantee has two halves, both pinned here:
 *   1. `foldRenderEntries` — a partial-failure batch keeps the FAILED tiles as
 *      an explicit `error` phase; it never drops them.
 *   2. `mergeOverlays` — a failed tile KEEPS its prior overlay (the retention
 *      path), so after `filter A` succeeds and `filter B` fails the tile still
 *      shows window A labeled-stale rather than silently reverting to the
 *      persisted unfiltered snapshot (a board quietly mixing two windows).
 */
import { describe, expect, test } from "bun:test";
import { foldRenderEntries, mergeOverlays, phaseTag, type TileOverlay, type TilePhase } from "../tile-phases";
import type { CardRenderEntry } from "../dashboard-card-render";

const RENDERED_AT = "2026-07-04T12:00:00.000Z";

function ok(cardId: string, rows: Record<string, unknown>[] = [{ n: 1 }]): CardRenderEntry {
  return { cardId, ok: true, columns: ["n"], rows };
}
function err(cardId: string, error = "connection unavailable"): CardRenderEntry {
  return { cardId, ok: false, error };
}

describe("foldRenderEntries", () => {
  test("a partial-failure batch keeps failed tiles as an explicit error phase (NOT dropped)", () => {
    const { phases } = foldRenderEntries([ok("a"), err("b"), ok("c")], RENDERED_AT);
    // Every card is present — the failed one is NOT silently omitted.
    expect(Object.keys(phases).sort()).toEqual(["a", "b", "c"]);
    expect(phases.b).toEqual({ phase: "error", message: "connection unavailable" });
  });

  test("a failed tile never yields an `ok` overlay — it can't masquerade as fresh", () => {
    const { phases } = foldRenderEntries([err("b")], RENDERED_AT);
    expect(phases.b.phase).toBe("error");
    // No columns/rows on an error phase → the grid cannot overlay stale numbers
    // as if they were the current filtered result.
    expect("rows" in phases.b).toBe(false);
  });

  test("a successful tile carries its rows + the batch timestamp (age resets)", () => {
    const { phases } = foldRenderEntries([ok("a", [{ n: 5 }])], RENDERED_AT);
    expect(phases.a).toEqual({ phase: "ok", columns: ["n"], rows: [{ n: 5 }], renderedAt: RENDERED_AT });
  });

  test("KPI comparison blocks are recorded only for cards that carry one", () => {
    const withComparison: CardRenderEntry = {
      cardId: "kpi",
      ok: true,
      columns: ["total"],
      rows: [{ total: 100 }],
      comparison: { columns: ["total"], rows: [{ total: 80 }] },
    };
    const { comparisons } = foldRenderEntries([withComparison, ok("plain")], RENDERED_AT);
    expect(comparisons.kpi).toEqual({ columns: ["total"], rows: [{ total: 80 }] });
    // A non-KPI card (comparison undefined) is not recorded.
    expect("plain" in comparisons).toBe(false);
  });

  test("phaseTag narrows a folded phase to its render-phase discriminant", () => {
    expect(phaseTag({ phase: "ok", columns: [], rows: [], renderedAt: RENDERED_AT })).toBe("ok");
    expect(phaseTag({ phase: "error", message: "x" })).toBe("error");
  });
});

describe("mergeOverlays — the anti-silent-revert retention path", () => {
  const overlayA: TileOverlay = { columns: ["n"], rows: [{ n: "window-A" }], renderedAt: "2026-07-04T11:00:00.000Z" };

  test("a FAILED tile keeps its prior overlay (window A) — never reverts to the persisted snapshot", () => {
    // filter A already succeeded for the tile (overlay A is live)…
    const prev: Record<string, TileOverlay> = { tile: overlayA };
    // …then filter B fails for it.
    const phases: Record<string, TilePhase> = { tile: { phase: "error", message: "boom" } };
    const next = mergeOverlays(prev, phases);
    // The tile STILL shows window A — the retention guarantee. Dropping it here
    // would revert the grid to the persisted unfiltered snapshot (the bug).
    expect(next.tile).toEqual(overlayA);
  });

  test("a SUCCEEDED tile refreshes its overlay (+ new timestamp)", () => {
    const prev: Record<string, TileOverlay> = { tile: overlayA };
    const phases: Record<string, TilePhase> = {
      tile: { phase: "ok", columns: ["n"], rows: [{ n: "window-B" }], renderedAt: RENDERED_AT },
    };
    const next = mergeOverlays(prev, phases);
    expect(next.tile).toEqual({ columns: ["n"], rows: [{ n: "window-B" }], renderedAt: RENDERED_AT });
  });

  test("a mixed batch: the ok tile advances to window B, the failed tile retains window A", () => {
    const prev: Record<string, TileOverlay> = { ok: overlayA, bad: overlayA };
    const phases: Record<string, TilePhase> = {
      ok: { phase: "ok", columns: ["n"], rows: [{ n: "window-B" }], renderedAt: RENDERED_AT },
      bad: { phase: "error", message: "boom" },
    };
    const next = mergeOverlays(prev, phases);
    expect(next.ok.rows).toEqual([{ n: "window-B" }]);
    expect(next.bad).toEqual(overlayA); // retained — not reverted, not advanced
  });

  test("does not mutate the previous overlay map", () => {
    const prev: Record<string, TileOverlay> = { tile: overlayA };
    mergeOverlays(prev, { tile: { phase: "error", message: "boom" } });
    expect(prev).toEqual({ tile: overlayA });
  });
});
