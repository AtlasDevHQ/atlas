/**
 * Unit coverage for the fusion seam (#4773).
 *
 * The properties that matter are the ones M4 must not break: score
 * accumulation across lists, a TOTAL order over ties, and identity stability
 * for a row that appears in more than one list.
 */

import { describe, expect, it } from "bun:test";
import { fuseRankedLists, RRF_K, type RankedList } from "@atlas/api/lib/brain/fusion";

interface Row {
  readonly id: string;
  readonly tier: number;
  readonly from?: string;
}

const key = (r: Row) => r.id;
const tiebreak = (a: Row, b: Row) => a.tier - b.tier || a.id.localeCompare(b.id);

function list(label: string, ids: readonly string[], tier = 0): RankedList<Row> {
  return { label, items: ids.map((id) => ({ id, tier, from: label })) };
}

describe("fuseRankedLists", () => {
  it("returns an empty array for no lists and for all-empty lists", () => {
    expect(fuseRankedLists<Row>([], { key, tiebreak })).toEqual([]);
    expect(fuseRankedLists([list("a", [])], { key, tiebreak })).toEqual([]);
  });

  it("preserves a single list's order", () => {
    const fused = fuseRankedLists([list("a", ["x", "y", "z"])], { key, tiebreak });
    expect(fused.map(key)).toEqual(["x", "y", "z"]);
  });

  it("round-robins DISJOINT lists — the honest M1 property", () => {
    // Every item appears in exactly one list, so RRF reduces to interleaving by
    // rank position. Pinned rather than left implicit: it is what a fused page
    // actually looks like this milestone, and M4's dense lists are what make
    // the sum non-degenerate.
    const fused = fuseRankedLists(
      [list("facts", ["f1", "f2"], 0), list("docs", ["d1", "d2"], 1)],
      { key, tiebreak },
    );
    expect(fused.map(key)).toEqual(["f1", "d1", "f2", "d2"]);
  });

  it("accumulates score for an item present in several lists — the M4 property", () => {
    // `shared` is second in both lists; `top` is first in one. Two
    // second-places outscore one first place, so the merge is a real sum
    // rather than a positional interleave.
    const fused = fuseRankedLists(
      [list("a", ["top", "shared"]), list("b", ["other", "shared"])],
      { key, tiebreak },
    );
    expect(fused[0].id).toBe("shared");
  });

  it("keeps the FIRST occurrence's item identity when a key repeats", () => {
    // M4 surfaces one row through two readers; the projected payload must not
    // depend on which list happened to be passed first.
    const fused = fuseRankedLists([list("lexical", ["x"]), list("dense", ["x"])], {
      key,
      tiebreak,
    });
    expect(fused).toHaveLength(1);
    expect(fused[0].from).toBe("lexical");
  });

  it("breaks ties with the caller's total order, not insertion order", () => {
    // Both lists' heads tie at 1/(k+1). The tiebreak puts tier 0 first even
    // though the tier-1 list was passed first.
    const fused = fuseRankedLists([list("b", ["late"], 1), list("a", ["early"], 0)], {
      key,
      tiebreak,
    });
    expect(fused.map(key)).toEqual(["early", "late"]);
  });

  it("falls back to insertion order only when the tiebreak reports equality", () => {
    const flat = () => 0;
    const fused = fuseRankedLists([list("a", ["second"]), list("b", ["first"])], {
      key,
      tiebreak: flat,
    });
    expect(fused.map(key)).toEqual(["second", "first"]);
  });

  it("k damps the head: two second places beat one first place for any k > 0, and merely TIE at k = 0", () => {
    // The constant's meaning, pinned at its boundary. `2/(k+2) > 1/(k+1)` holds
    // exactly when `k > 0`; at `k = 0` the two sides are equal and the outcome
    // falls to the tiebreak, which is `other` on id order — so a future "let's
    // simplify k to 0" would silently turn a scored merge into a positional one.
    const lists = [list("a", ["top", "shared"]), list("b", ["other", "shared"])];
    expect(fuseRankedLists(lists, { key, tiebreak, k: 0 }).map(key)).toEqual([
      "other",
      "shared",
      "top",
    ]);
    expect(fuseRankedLists(lists, { key, tiebreak, k: 1 })[0].id).toBe("shared");
    expect(fuseRankedLists(lists, { key, tiebreak, k: RRF_K })[0].id).toBe("shared");
  });
});
