import type { BrainVocabularyEdgeEntry } from "@/ui/lib/types";

/**
 * Which slot a cardinality write lands in, and whether this page can prove it
 * (#5447).
 *
 * ## The divergence this module exists for
 *
 * `POST /preview` keys its two cardinality arms with `identityKey(predicateSurface)`
 * — normalization only. `POST /cardinality` keys its write with
 * `slotKey(predicateSurface, predicateAlias)` — normalization **and the alias
 * closure**. The two agree for an unaliased predicate and diverge for an aliased
 * one, and `/surfaces` offers aliased norms because it groups by the norm of the
 * observed SURFACE with no closure applied.
 *
 * Both endpoints are correct in isolation. Together they let a page show a count
 * for one slot and write to another, which defeats the single property that
 * justifies offering the retroactive flip at all.
 *
 * ## Why this RESOLVES rather than refuses
 *
 * The first cut simply blocked whenever the picked norm was an alias source, and
 * told the operator to pick the target instead. That was wrong in a way worth
 * recording: the target is in the picker only if some live claim literally spells
 * it, and an alias usually exists *because* claims spell the source. So on
 * exactly the workspaces that curate aliases the capability disappeared rather
 * than degrading — back to the console `fetch` this surface was built to end.
 *
 * Resolving keeps both properties: preview the slot the write will actually land
 * in, and disclose the fold so the operator sees which norm the number is about.
 *
 * ## ⚠️ This mirrors a server-side closure, and that is a real cost
 *
 * `brain_vocabulary_target` stores the closure; this walks the edges. A second
 * implementation of a server rule is normally exactly what this codebase refuses
 * (`norm-picker.tsx`'s header states the rule). Three things make it acceptable
 * *here* and nowhere else:
 *
 *   1. It runs only against a vocabulary the caller has proven COMPLETE — see
 *      {@link PredicateVocabulary}. An incomplete edge list cannot be walked,
 *      and the caller must say so rather than pass a shorter list.
 *   2. The walk terminates or refuses. A cycle is impossible by construction
 *      (0189 enforces the 1-cycle; one norm has one parent) and is still guarded,
 *      because a page that assumed a DB invariant and hung would be worse than one
 *      that says it cannot tell.
 *   3. **The resolved norm is DISPLAYED.** If this walk ever disagrees with the
 *      server's closure, the operator sees a norm that is not the one they expect,
 *      beside a count. That makes a disagreement visible rather than silent, which
 *      is the property the picker's own "the resolved norm is displayed" design
 *      rests on.
 *
 * The better repair is for `/preview` to apply the closure itself, which is API
 * work. Until then this is the honest approximation, and the disclosure is what
 * makes it honest rather than merely convenient.
 */

/**
 * What this page knows about its workspace's predicate-position aliases.
 *
 * ⚠️ Four arms, not a list plus a boolean. The earlier shape was
 * `edges: Edge[]` + `vocabularyKnown: boolean`, and it conflated two states that
 * need opposite copy: `useAdminFetch` returns `data: null` for the whole INITIAL
 * FETCH as well as on failure, so "still loading" rendered as *"could not read …
 * unknown, not clear. Reload before deciding"* — a destructive alert over a
 * request that was in flight and about to succeed, offering a remedy that
 * restarts the load. Pending presented as failed is this area's own invariant
 * inverted.
 *
 * `incomplete` is separate from `failed` for the same reason: the request
 * succeeded and the answer is partial, which is a different sentence.
 */
export type PredicateVocabulary =
  /** The `/in-force` request has not answered yet. */
  | { readonly kind: "loading" }
  /** The `/in-force` request failed, so the alias set is unknown. */
  | { readonly kind: "failed" }
  /**
   * It answered, and this page cannot prove it saw every predicate alias —
   * a page cap bit, or a count could not be established.
   */
  | { readonly kind: "incomplete" }
  /**
   * Every predicate-position alias edge in the workspace.
   *
   * The caller proves this; see `page.tsx`. Passing a partial list here is the
   * one way to make this module lie.
   */
  | { readonly kind: "known"; readonly edges: readonly BrainVocabularyEdgeEntry[] };

/** Where the write goes, and what to tell the operator about it. */
export type SlotResolution =
  /** Nothing picked yet. */
  | { readonly kind: "no-pick" }
  /**
   * The alias set is not established, so which slot the write lands in is
   * unknown — NOT provably the picked one.
   */
  | { readonly kind: "unresolvable"; readonly because: "loading" | "failed" | "incomplete" }
  /** Unaliased: the write and the preview both key on the pick. */
  | { readonly kind: "direct"; readonly previewSurface: string }
  /**
   * Aliased: the write keys on {@link previewSurface}, and so will the preview.
   * `path` is the fold, picked norm first, for the disclosure.
   */
  | {
      readonly kind: "folded";
      readonly previewSurface: string;
      readonly path: readonly string[];
    }
  /** The walk could not terminate. Refused rather than guessed. */
  | { readonly kind: "cyclic"; readonly path: readonly string[] };

/**
 * Longest alias chain this page will walk.
 *
 * A bound rather than a bare `while`, so a malformed edge set costs a refusal
 * instead of a hung tab. Generous next to any real vocabulary: the depth is
 * human-authored, one approval at a time.
 */
const MAX_CHAIN = 32;

/**
 * Resolve the picked norm to the slot `POST /cardinality` will write.
 *
 * Returns a discriminated result rather than a string, because "the write goes
 * here" and "I cannot tell where the write goes" are the two answers the caller
 * must render differently — and a `string | null` would let the second be read
 * as the first by anyone who forgot the null check.
 */
export function resolveWriteSlot(
  vocabulary: PredicateVocabulary,
  pickedNorm: string | null,
): SlotResolution {
  if (pickedNorm === null) return { kind: "no-pick" };
  if (vocabulary.kind !== "known") {
    return { kind: "unresolvable", because: vocabulary.kind };
  }

  // A lookup built per call rather than threaded in. The edge list is at most a
  // page and this runs on a click, so the map is cheaper than the bug where a
  // memoized index outlives the vocabulary it indexed.
  const parent = new Map<string, string>();
  for (const edge of vocabulary.edges) {
    if (edge.position !== "predicate") continue;
    // First writer wins. One norm has one parent by construction; if the wire
    // ever carries two, taking either silently would be a coin flip about which
    // slot a retroactive write lands in — so this keeps the first and the cycle
    // guard below is what catches the resulting nonsense.
    if (!parent.has(edge.fromNorm)) parent.set(edge.fromNorm, edge.toNorm);
  }

  const path: string[] = [pickedNorm];
  const seen = new Set<string>([pickedNorm]);
  let current = pickedNorm;

  for (let hop = 0; hop < MAX_CHAIN; hop += 1) {
    const next = parent.get(current);
    if (next === undefined) {
      // Terminal. `path.length === 1` means nothing folded at all.
      return path.length === 1
        ? { kind: "direct", previewSurface: current }
        : { kind: "folded", previewSurface: current, path };
    }
    if (seen.has(next)) {
      path.push(next);
      return { kind: "cyclic", path };
    }
    seen.add(next);
    path.push(next);
    current = next;
  }
  // Ran past the bound without terminating. Reported as cyclic rather than as a
  // resolution, because the honest content of both is the same: this page cannot
  // tell you which slot the write lands in.
  return { kind: "cyclic", path };
}

/** Whether a resolution establishes the slot, and so may arm a write. */
export function isResolved(
  resolution: SlotResolution,
): resolution is Extract<SlotResolution, { kind: "direct" | "folded" }> {
  return resolution.kind === "direct" || resolution.kind === "folded";
}
