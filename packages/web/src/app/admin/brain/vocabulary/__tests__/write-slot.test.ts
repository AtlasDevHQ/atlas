import { describe, expect, test } from "bun:test";
import type { BrainVocabularyEdgeEntry } from "@/ui/lib/types";
import { isResolved, resolveWriteSlot, type PredicateVocabulary } from "../write-slot";

/**
 * Which slot a cardinality write lands in (#5447).
 *
 * The property under test is narrow and load-bearing: this function may say
 * "here" only when it can prove it, and every other answer must be
 * distinguishable from that one. A `string | null` return would satisfy the
 * happy paths and lose exactly that distinction, which is why the result is a
 * union and why `isResolved` is tested against every arm rather than the two it
 * accepts.
 */

const edge = (fromNorm: string, toNorm: string, position = "predicate"): BrainVocabularyEdgeEntry =>
  ({
    position,
    fromNorm,
    toNorm,
    approvedBy: "user-1",
    approvedAt: "2026-08-08T00:00:00.000Z",
    hasRejectionMemory: true,
  }) as BrainVocabularyEdgeEntry;

const known = (...edges: BrainVocabularyEdgeEntry[]): PredicateVocabulary => ({
  kind: "known",
  edges,
});

describe("an unaliased predicate resolves to itself", () => {
  test("no edges at all", () => {
    const r = resolveWriteSlot(known(), "reports to");
    expect(r).toEqual({ kind: "direct", previewSurface: "reports to" });
    expect(isResolved(r)).toBe(true);
  });

  test("edges that do not start at the pick", () => {
    const r = resolveWriteSlot(known(edge("led by", "leads")), "reports to");
    expect(r.kind).toBe("direct");
  });

  test("⚠️ an edge at another POSITION does not fold a predicate", () => {
    // The write applies the PREDICATE-position closure. A subject alias that
    // happens to share a norm string must not move it — and the filter is easy to
    // drop, because the caller already hands over a filtered list and this looks
    // redundant.
    const r = resolveWriteSlot(known(edge("reports to", "manages", "subject")), "reports to");
    expect(r).toEqual({ kind: "direct", previewSurface: "reports to" });
  });
});

describe("an aliased predicate folds, and the fold is disclosed", () => {
  test("one hop", () => {
    const r = resolveWriteSlot(known(edge("led by", "leads")), "led by");
    expect(r).toEqual({
      kind: "folded",
      previewSurface: "leads",
      path: ["led by", "leads"],
    });
    expect(isResolved(r)).toBe(true);
  });

  test("⚠️ a MULTI-HOP chain resolves to its end, not to the first hop", () => {
    // This is the case the first cut got wrong in the other direction: it blocked
    // any alias source, so a chain was unreachable. Stopping at the first hop
    // would be worse than blocking — it would preview `b` and write `c`, which is
    // the exact divergence this module exists to close, reintroduced by a walk
    // that quits early.
    const r = resolveWriteSlot(
      known(edge("a", "b"), edge("b", "c"), edge("c", "d")),
      "a",
    );
    expect(r).toEqual({
      kind: "folded",
      previewSurface: "d",
      path: ["a", "b", "c", "d"],
    });
  });

  test("the path starts at the PICK, so the disclosure can name what the operator clicked", () => {
    // Narrowed on the DISCRIMINANT, not through `isResolved` — that guard admits
    // `direct` too, which carries no `path`, so the union it produces has no such
    // property. The compiler catching that is the guard doing its job.
    const r = resolveWriteSlot(known(edge("a", "b"), edge("b", "c")), "a");
    expect(r.kind).toBe("folded");
    if (r.kind !== "folded") throw new Error("expected a folded resolution");
    expect(r.path[0]).toBe("a");
    expect(r.path[r.path.length - 1]).toBe("c");
  });
});

describe("⚠️ what it refuses to answer", () => {
  test("a cycle is refused rather than walked forever", () => {
    // Impossible by construction — 0189 enforces the 1-cycle and one norm has one
    // parent — and guarded anyway. A page that assumed a DB invariant and hung is
    // worse than one that says it cannot tell.
    const r = resolveWriteSlot(known(edge("a", "b"), edge("b", "a")), "a");
    expect(r.kind).toBe("cyclic");
    expect(isResolved(r)).toBe(false);
  });

  test("a self-edge is a cycle too", () => {
    const r = resolveWriteSlot(known(edge("a", "a")), "a");
    expect(r.kind).toBe("cyclic");
  });

  test("a chain longer than the bound is refused, not truncated", () => {
    // Truncating would return `folded` pointing at hop 32 — a confident answer
    // about the wrong slot, which is strictly worse than refusing.
    const long = Array.from({ length: 40 }, (_, i) => edge(`n${i}`, `n${i + 1}`));
    const r = resolveWriteSlot(known(...long), "n0");
    expect(r.kind).toBe("cyclic");
    expect(isResolved(r)).toBe(false);
  });

  test("each not-known vocabulary reports WHICH state it is in", () => {
    // Three arms because they need three sentences. `loading` in particular must
    // never render as `failed`: `useAdminFetch` returns null data for the whole
    // initial fetch, so conflating them put a destructive "could not read …
    // reload before deciding" over a request that was about to succeed.
    for (const because of ["loading", "failed", "incomplete"] as const) {
      const r = resolveWriteSlot({ kind: because }, "reports to");
      expect(r).toEqual({ kind: "unresolvable", because });
      expect(isResolved(r)).toBe(false);
    }
  });

  test("no pick is its own arm, not an unresolvable one", () => {
    // Nothing to say yet, versus something that could not be established. Only
    // the second warrants an alert.
    const r = resolveWriteSlot(known(), null);
    expect(r).toEqual({ kind: "no-pick" });
    expect(isResolved(r)).toBe(false);
  });

  test("no pick wins over an unknown vocabulary", () => {
    // Otherwise the card shows "the alias set could not be read" before the
    // operator has picked anything, which is an alarm about a decision nobody is
    // making.
    expect(resolveWriteSlot({ kind: "failed" }, null)).toEqual({ kind: "no-pick" });
  });
});

describe("duplicate parents", () => {
  test("two edges from one norm do not silently pick a winner that resolves", () => {
    // One norm has one parent by construction. If the wire ever carries two,
    // taking either silently is a coin flip about which slot a RETROACTIVE write
    // lands in. First-writer-wins plus the cycle guard is what turns the
    // resulting nonsense into a refusal in the case that matters.
    const r = resolveWriteSlot(known(edge("a", "b"), edge("a", "c"), edge("b", "a")), "a");
    expect(r.kind).toBe("cyclic");
  });
});
