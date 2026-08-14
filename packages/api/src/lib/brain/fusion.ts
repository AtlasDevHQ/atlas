/**
 * The fusion seam — how `searchBrain` merges independently-ranked candidate
 * lists into one ordered result set (#4773, ADR-0036 §Retrieval).
 *
 * ## Why a seam and not just a sort
 *
 * ADR-0036 staged retrieval: M1 is FTS-first, and a later milestone adds dense
 * embeddings, RRF, and an optional rerank — with **FTS-only as the permanent
 * self-host floor**, not a degraded mode. The thing that has to be additive
 * across that boundary is the MERGE, so it lives here as one function over a
 * list-of-ranked-lists rather than inline in the query layer.
 *
 * ⚠️ **That deepening is DESCHEDULED as of 2026-08-13** and is not "the next
 * milestone" — see ADR-0036 §The milestone cut's 2026-08-13 amendment. It
 * advances none of the PRD's eight finish conditions, so it returns to the cut
 * only when a real customer's retrieval demonstrably fails. This seam stays
 * because the argument for it (the merge must be additive) is independent of
 * when the deepening lands — not because the deepening is imminent.
 *
 * What that deepening would change: the number and provenance of the input
 * lists (a dense list per store joins the lexical one), and an optional rerank
 * pass AFTER this
 * function. What M4 does NOT change: this signature, or the formula. That is
 * the whole point of the shape.
 *
 * ## The formula, and an honest note about M1
 *
 * Reciprocal rank fusion — an item's score is `Σ 1/(k + rank)` over every list
 * it appears in, with `rank` 1-based (the implementation spells it
 * `k + position + 1` because `position` is the 0-based array index).
 * Position-based, deliberately: a store's `ts_rank` is
 * normalized against its OWN corpus, so comparing a fact's 0.19 to a
 * document's 0.31 is pseudo-precision. Rank position is the only quantity the
 * three stores agree on the meaning of.
 *
 * In M1 the input lists are DISJOINT — a row is a fact or an episode or a
 * document, never two — so every item appears in exactly one list and RRF
 * reduces to round-robin interleaving by position: the best fact, the best
 * episode, and the best document all tie, then the second-best of each, and so
 * on. That is stated plainly rather than dressed up, because it is a real
 * property of this milestone and a reviewer should not have to derive it. It
 * is also the right M1 behavior: for a trust-LABELED read the caller reads the
 * whole page and decides, so a fused page that guarantees representation from
 * every store beats one where a single verbose store crowds the others out.
 * M4's dense lists are what make the sum non-degenerate.
 *
 * ## Trust is a label, not a rank multiplier
 *
 * Ordering is relevance-only. The trust tier enters exactly once, as the
 * deterministic TIEBREAK between rows of equal fused score — which in M1 is
 * every round-robin cohort, so a reviewed fact does lead its cohort. It is
 * never a weight. Boosting tier-2 above a more relevant tier-3 would be
 * arbitration by ranking, and arbitration is M2's — the same rule that makes
 * `in-tension-with` surface both sides and rank neither.
 */

/** Canonical RRF damping constant. Larger `k` flattens the head of each list. */
export const RRF_K = 60;

/**
 * One store's ranked candidates, best first.
 *
 * `label` names the producer (`facts:lexical`, `documents:dense`). Fusion
 * itself is label-blind — adding M4's dense lists cannot change how the
 * existing lexical ones are weighted — so this is carried for the caller's
 * diagnostics and for reading a fused page's provenance, not for the formula.
 */
export interface RankedList<T> {
  readonly label: string;
  /** Best-first. Position in THIS array is the rank the formula consumes. */
  readonly items: readonly T[];
}

export interface FuseOptions<T> {
  /**
   * Stable identity for an item, so the same row appearing in two lists
   * accumulates one score instead of two entries. In M1 the lists are
   * disjoint and this never collides; in M4 it is what makes RRF a sum.
   */
  readonly key: (item: T) => string;
  /**
   * Total order over tied items, applied after the score. Must be a TOTAL
   * order — two items that compare 0 fall back to insertion order, which is
   * stable but arbitrary and would make the fused page depend on which store
   * answered first.
   */
  readonly tiebreak: (a: T, b: T) => number;
  /** Defaults to {@link RRF_K}. */
  readonly k?: number;
}

interface Accumulated<T> {
  readonly item: T;
  score: number;
  /** Insertion order — the last-resort stable fallback. */
  readonly seq: number;
}

/**
 * Fuse ranked lists into one relevance-ordered array.
 *
 * The FIRST occurrence of a key wins the item identity; later lists only
 * contribute score. That matters for M4: a row surfaced by both the lexical
 * and dense readers must not have its projected payload swapped mid-merge
 * depending on which list is passed first.
 */
export function fuseRankedLists<T>(
  lists: readonly RankedList<T>[],
  options: FuseOptions<T>,
): T[] {
  const { key, tiebreak, k = RRF_K } = options;
  const accumulated = new Map<string, Accumulated<T>>();
  let seq = 0;

  for (const list of lists) {
    for (let position = 0; position < list.items.length; position++) {
      const item = list.items[position];
      const id = key(item);
      const contribution = 1 / (k + position + 1);
      const existing = accumulated.get(id);
      if (existing) {
        existing.score += contribution;
      } else {
        accumulated.set(id, { item, score: contribution, seq: seq++ });
      }
    }
  }

  return [...accumulated.values()]
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const broken = tiebreak(a.item, b.item);
      if (broken !== 0) return broken;
      return a.seq - b.seq;
    })
    .map((entry) => entry.item);
}
