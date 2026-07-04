/**
 * Fold a render batch into per-tile phases (#4321).
 *
 * The load-bearing guarantee: a partial-failure batch keeps the FAILED tiles as
 * an explicit `error` phase — it never drops them, which is what used to let the
 * grid silently revert a failed tile to its old unfiltered snapshot (a board
 * quietly mixing two windows). These tests pin that guarantee.
 */
import { describe, expect, test } from "bun:test";
import { foldRenderEntries } from "../tile-phases";
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
    const { phases, failedCardIds } = foldRenderEntries([ok("a"), err("b"), ok("c")], RENDERED_AT);
    // Every card is present — the failed one is NOT silently omitted.
    expect(Object.keys(phases).sort()).toEqual(["a", "b", "c"]);
    expect(phases.b).toEqual({ phase: "error", message: "connection unavailable" });
    expect(failedCardIds).toEqual(["b"]);
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

  test("an all-success batch reports no failures", () => {
    const { failedCardIds } = foldRenderEntries([ok("a"), ok("b")], RENDERED_AT);
    expect(failedCardIds).toEqual([]);
  });
});
