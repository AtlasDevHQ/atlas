import { describe, expect, test, afterEach } from "bun:test";
import { render, cleanup } from "@testing-library/react";
import { createElement } from "react";
import type { BrainVocabularyBlastRadius } from "@/ui/lib/types";
import { BlastRadiusPreview } from "../blast-radius";

/**
 * What the blast-radius disclosure must never say (#5087, consuming #5086).
 *
 * ## The defect this file exists to catch
 *
 * `BrainVocabularyBlastRadius` is a DISCRIMINATED union, and the engine's own
 * docstring records what the flat shape produced before it was split: a renderer
 * that read `floor` before checking `structurallyEmpty` said *"at least 0 today,
 * and every future claim in this slot"* for an object-position alias. That
 * sentence is false — no future claim in that slot can supersede — and it is the
 * confident false all-clear the whole preview exists to prevent, reachable by
 * reading two fields in the wrong order.
 *
 * The union makes that unrepresentable in the TYPE. These assertions are about
 * the RENDERER, which is the layer that can still flatten it back by reaching
 * for a number that is not on the branch.
 *
 * ## Why "0" is the string under test
 *
 * *"0 pairs"* and *"this decision cannot produce pairs"* are the same number and
 * opposite facts. An approver reading the first concludes the alias is harmless;
 * what is true is that its harm is of a different kind. So the durable assertion
 * is not "the copy mentions object position" — that survives any rewording — but
 * that no count is rendered at all on a branch that has none.
 */

afterEach(cleanup);

function renderRadius(radius: BrainVocabularyBlastRadius | null, opts?: {
  pending?: boolean;
  error?: string | null;
}) {
  const { container } = render(
    createElement(BlastRadiusPreview, {
      radius,
      pending: opts?.pending ?? false,
      error: opts?.error ?? null,
    }),
  );
  return container.textContent ?? "";
}

describe("a structurally-empty radius never renders as a count", () => {
  const REASONS = [
    "object-position",
    "already-single",
    "not-curated",
    "unkeyable-surface",
    "no-such-edge",
  ] as const;

  for (const reason of REASONS) {
    test(`${reason} renders prose, never a number`, () => {
      const text = renderRadius({ kind: "structurally-empty", reason });
      // No digit at all on this branch. Deliberately stricter than "does not
      // say 0": a renderer that reached for `arming.total` on a branch that
      // does not carry it would render `undefined` or `NaN`, and a test that
      // only banned "0" would pass on both.
      expect(text, `"${reason}" rendered a number`).not.toMatch(/\d/);
      // …and it is not empty, which is the other way to render nothing.
      expect(text.length).toBeGreaterThan(40);
    });
  }

  test("object-position on THIS branch is a disagreement, not the answer", () => {
    // ⚠️ This assertion changed with #5088, and the change is the AC landing
    // rather than a rewording. An object-position alias now gets its own
    // `object-position` radius arm carrying the corroboration and tension
    // deltas, so the copy no longer says *"Atlas cannot yet show you that"* —
    // it can, and a page still saying otherwise would be exactly the stale
    // reassurance this file exists to refuse.
    //
    // The `structurally-empty` reason survives for a request that reaches the
    // supersession PLANNER at this position, which is unreachable by
    // construction and guarded anyway. So the honest copy on THIS branch is
    // "the page and the API disagreed about how to ask" — still never a zero.
    const text = renderRadius({ kind: "structurally-empty", reason: "object-position" });
    expect(text).toContain("not a blast radius of zero");
    expect(text).toContain("not the answer you asked for");
    expect(text).toContain("Reload before deciding");
    // The stale promise must be GONE. Without this the copy could drift back to
    // claiming the disclosure does not exist while it sits one branch over.
    expect(text).not.toContain("cannot yet show you");
  });

  test("an unrecognised reason is not rendered as a zero either", () => {
    // Forward compatibility in the honest direction: an API newer than this page
    // must not degrade into the one sentence the surface exists to prevent.
    // Cast THROUGH `unknown`, and the fact that it is now required is the pin
    // working: since `reason` became a typed union, a bare `as` no longer
    // compiles. This value models an API newer than the page — a state the wire
    // type deliberately cannot express, which is exactly why the renderer still
    // needs a `default` arm and why that arm needs a test.
    const text = renderRadius({
      kind: "structurally-empty",
      reason: "some-future-reason",
    } as unknown as BrainVocabularyBlastRadius);
    expect(text).toContain("do not read it as one");
  });
});

describe("a computed radius renders its floor as a floor", () => {
  const computed = (armingTotal: number, over?: Partial<{ withheld: number; consistent: boolean; subtree: boolean }>): BrainVocabularyBlastRadius => ({
    kind: "computed",
    arming: {
      total: armingTotal,
      pairs: [],
      withheld: over?.withheld ?? 0,
      truncated: false,
      countsConsistent: over?.consistent ?? true,
    },
    disarming: { total: 0, pairs: [], withheld: 0, truncated: false, countsConsistent: true },
    targetCardinality: { kind: "not-asked" },
    floor: true,
    subtreeTruncated: over?.subtree ?? false,
  });

  test("says 'at least', because a flip is not a batch", () => {
    // `floor` is a literal `true` on this branch precisely so this word is
    // assertable. Rendering "3 claims become supersedable" full stop is how an
    // approver decides a 3-pair blast radius is small, when it applies to every
    // future claim in the slot as well.
    const text = renderRadius(computed(3));
    expect(text).toContain("At least 3");
    expect(text).toContain("every future claim in the slot");
  });

  test("a genuine zero is stated as a floor too, never as an all-clear", () => {
    // THE distinction this whole file is about, from the other side: a computed
    // zero is a real answer, and it still is not "this is safe".
    const text = renderRadius(computed(0));
    expect(text).toContain("No published claim becomes supersedable");
    expect(text).toContain("floor, not a guarantee");
  });

  test("withheld pairs are counted out loud rather than omitted", () => {
    const text = renderRadius(computed(5, { withheld: 2 }));
    expect(text).toContain("2 of those");
    expect(text).toContain("cannot read");
  });

  test("disagreeing counts are flagged rather than presented as fact", () => {
    const text = renderRadius(computed(5, { consistent: false }));
    expect(text).toContain("disagreed");
  });

  test("a truncated subtree is reported as a smaller POPULATION, not as disagreement", () => {
    // The engine splits these deliberately: `countsConsistent` means two
    // statements disagreed, `subtreeTruncated` means one statement asked about
    // less than you did. They demand different actions from an approver, so a
    // renderer that collapsed them would give the wrong one.
    const text = renderRadius(computed(5, { subtree: true }));
    expect(text).toContain("smaller population");
    expect(text).not.toContain("disagreed");
  });
});

describe("⚠️ a curated-single target is SAID, not just counted (#5093)", () => {
  // The count already followed the cardinality gate through the merge — the
  // engine has done that since #5086. What an approver saw was a LARGER NUMBER
  // WITH NO EXPLANATION OF WHERE IT CAME FROM, which is the *magnitude but not
  // kind* failure this whole surface exists to prevent, on the interaction
  // #5025 called the only place the compound blast radius is visible at all.

  const computed = (
    targetCardinality: Extract<
      BrainVocabularyBlastRadius,
      { kind: "computed" }
    >["targetCardinality"],
    armingTotal = 3,
  ): BrainVocabularyBlastRadius => ({
    kind: "computed",
    arming: {
      total: armingTotal,
      pairs: [],
      withheld: 0,
      truncated: false,
      countsConsistent: true,
    },
    disarming: { total: 0, pairs: [], withheld: 0, truncated: false, countsConsistent: true },
    targetCardinality,
    floor: true,
    subtreeTruncated: false,
  });

  test("names the target predicate and says what the merge does to it", () => {
    const text = renderRadius(
      computed({ kind: "curated-single", targetPredicate: "priced at" }),
    );
    // The NAME, because "the target predicate" is not something an approver can
    // resolve from a preview panel that never shows it.
    expect(text).toContain("priced at");
    expect(text).toContain("curated single-valued");
    // …and the MECHANISM. Without this the sentence is a label; with it, it is
    // the explanation the count on its own cannot give.
    expect(text).toContain("supersession is already armed");
    expect(text).toMatch(/not because a claim changed/);
    // The count is still there — the disclosure explains the number, it does
    // not replace it.
    expect(text).toContain("At least 3");
  });

  test("⚠️ says it for a KNOWN ZERO too — the slot is armed for every future claim", () => {
    // Deliberately not gated on the count. A curated target with nothing
    // colliding today is exactly the case where the `floor` argument bites: the
    // decision applies to every future claim in that slot as well, and an
    // approver reading only "0" concludes the merge is free.
    const text = renderRadius(computed({ kind: "curated-single", targetPredicate: "priced at" }, 0));
    expect(text).toContain("priced at");
    expect(text).toContain("supersession is already armed");
  });

  test("POSITIVE CONTROL — an uncurated target says nothing of the kind", () => {
    // The complement, and it is what makes the assertions above meaningful
    // rather than a claim about a string that is always rendered.
    const text = renderRadius(computed({ kind: "uncurated" }));
    expect(text).not.toContain("curated single-valued");
    expect(text).not.toContain("supersession is already armed");
    expect(text).toContain("At least 3");
  });

  test("POSITIVE CONTROL — `not-asked` says nothing either, and says no NAME", () => {
    // A subject-position alias and both cardinality verbs land here. The
    // dangerous rendering is not the missing sentence — it is a renderer that
    // reached for a `targetPredicate` this arm does not carry and printed
    // `undefined` into prose.
    const text = renderRadius(computed({ kind: "not-asked" }));
    expect(text).not.toContain("curated single-valued");
    expect(text).not.toContain("undefined");
  });
});

describe("a failed preview is never rendered as no impact", () => {
  test("says the impact is UNKNOWN, not zero", () => {
    // A preview that failed and a preview that came back empty are opposite
    // facts, and this surface exists because those two are easy to confuse.
    const text = renderRadius(null, { error: "the server said no" });
    expect(text).toContain("unknown");
    expect(text).not.toMatch(/\bno impact\b/i);
  });

  test("renders nothing at all before a preview has been requested", () => {
    // Not "0 pairs" — an un-asked question has no answer, and rendering one
    // would let an approver satisfy the preview-before-author gate by reading a
    // number that was never computed.
    expect(renderRadius(null)).toBe("");
  });

  test("says it is still computing rather than showing a stale or empty answer", () => {
    expect(renderRadius(null, { pending: true })).toContain("Computing");
  });
});

describe("⚠️ an unestablished side is never silent, even beside a non-zero one", () => {
  // The `computed` branch's gates require BOTH totals to be zero, and `SideLine`
  // was gated on `total > 0` at the call site — so with one side non-zero and
  // the other an unestablished zero, NOTHING on the page mentioned the second
  // side: no line, no "unknown, not zero", and not the "counts disagreed"
  // clause, which lives inside the suppressed `SideLine`. A removal whose
  // disarming statement drifted read as a clean one-sided radius.

  const side = (over: Record<string, unknown> = {}) => ({
    total: 0,
    pairs: [],
    withheld: 0,
    truncated: false,
    countsConsistent: true,
    ...over,
  });

  const computed = (arming: unknown, disarming: unknown): BrainVocabularyBlastRadius =>
    ({
      kind: "computed",
      arming,
      disarming,
      targetCardinality: { kind: "not-asked" },
      floor: true,
      subtreeTruncated: false,
    }) as BrainVocabularyBlastRadius;

  test("says unknown-not-zero for the drifted side while the other reports its count", () => {
    const text = renderRadius(
      computed(side({ total: 5 }), side({ total: 0, countsConsistent: false })),
    );
    expect(text).toContain("At least 5");
    expect(text).toContain("unknown, not zero");
  });

  test("and does so when BOTH sides are unestablished zeros", () => {
    const text = renderRadius(
      computed(side({ countsConsistent: false }), side({ countsConsistent: false })),
    );
    expect(text).toContain("unknown, not zero");
    // ...and the all-clear must not also be on screen.
    expect(text).not.toContain("No published claim becomes supersedable, or safe");
  });

  test("POSITIVE CONTROL — a KNOWN zero stays silent and the all-clear fires", () => {
    const text = renderRadius(computed(side(), side()));
    expect(text).not.toContain("unknown, not zero");
    expect(text).toContain("No published claim becomes supersedable, or safe");
  });
});
