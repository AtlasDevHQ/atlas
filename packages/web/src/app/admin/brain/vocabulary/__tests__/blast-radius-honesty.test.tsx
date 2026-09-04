import { describe, expect, test, afterEach } from "bun:test";
import { render, cleanup } from "@testing-library/react";
import { createElement } from "react";
import type {
  BrainVocabularyBlastRadius,
  BrainVocabularyObjectRadiusSide,
} from "@/ui/lib/types";
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

// ---------------------------------------------------------------------------
// Merged from object-radius-honesty.test.tsx (#5088) — same source module
// (`../blast-radius`, BlastRadiusPreview), the `object-position` union arm.
// ---------------------------------------------------------------------------

/**
 * What the OBJECT-position disclosure must and must not say (#5088).
 *
 * ## The sentence this file exists to make impossible
 *
 * Before #5088 an object-position alias rendered as *"Atlas cannot yet show you
 * that"* — a confident silence about the change the alias DOES make. The
 * replacement can fail in the opposite direction, and worse: rendering the
 * corroboration count under supersession wording would tell an approver that
 * merging two object spellings makes published claims replaceable, which is
 * precisely what the collision rule's indifference to `object_key` means it
 * cannot do.
 *
 * So the assertions here are about vocabulary, not layout:
 *
 *   - the copy never says *supersede* / *replace* on this branch;
 *   - every count is a FLOOR (*"at least N"*), because `floor` is a literal
 *     `true` on the wire precisely so the word is assertable;
 *   - the tension side says the flags are NOT withdrawn, because nothing
 *     withdraws them and `staleEdgesPersist` is a literal `true` for that
 *     sentence and no other reason;
 *   - a `withheld` count is stated rather than folded into silence.
 */
const side = (over: Partial<BrainVocabularyObjectRadiusSide> = {}): BrainVocabularyObjectRadiusSide => ({
  total: 0,
  pairs: [],
  withheld: 0,
  truncated: false,
  countsConsistent: true,
  ...over,
});

function objectRadius(
  over: Partial<Extract<BrainVocabularyBlastRadius, { kind: "object-position" }>> = {},
): BrainVocabularyBlastRadius {
  return {
    kind: "object-position",
    corroborating: side(),
    separating: side(),
    tension: side(),
    staleEdgesPersist: true,
    floor: true,
    subtreeTruncated: false,
    ...over,
  };
}


describe("the object-position branch never speaks the supersession vocabulary", () => {
  test("⚠️ never says a claim would be superseded or replaced", () => {
    const text = renderRadius(
      objectRadius({
        corroborating: side({ total: 3 }),
        tension: side({ total: 2 }),
      }),
    );
    // The collision rule never reads the object's identity, so no published
    // claim becomes replaceable. A renderer reusing the supersession `SideLine`
    // would say "become supersedable" over these numbers, which is the specific
    // false sentence the engine split the union to prevent.
    //
    // ⚠️ The banned strings are the CLAIMS, not the word "supersede" — the lead
    // paragraph legitimately uses it in a NEGATION ("the rule that supersedes a
    // published claim never reads the object's identity"), which is the sentence
    // an approver most needs to read. A blanket ban on the stem passed only
    // because the first cut of this test ran before that paragraph existed, and
    // it would have forced the copy to stop explaining itself.
    const lower = text.toLowerCase();
    expect(lower).not.toContain("become supersedable");
    expect(lower).not.toContain("becomes supersedable");
    expect(lower).not.toContain("become safe again");
    expect(lower).not.toContain("would replace");
    // The negation IS present, and pinned — it is the whole reason an approver
    // can read a non-zero number here without concluding beliefs are at risk.
    expect(lower).toContain("never reads the object");
    // …and it does say what DID change, rather than rendering nothing.
    expect(lower).toContain("agree");
  });

  test("states plainly that this decision changes nothing about what replaces what", () => {
    const text = renderRadius(objectRadius({ corroborating: side({ total: 1 }) }));
    expect(text).toContain("changes nothing about what replaces what");
  });
});

describe("every count is rendered as a FLOOR", () => {
  test("⚠️ each non-empty side says `at least`, never a bare total", () => {
    const text = renderRadius(
      objectRadius({
        corroborating: side({ total: 3 }),
        separating: side({ total: 4 }),
        tension: side({ total: 2 }),
      }),
    );
    // `floor: true` is a literal on the wire so this word is ASSERTABLE rather
    // than merely intended. Three sides, three floors — a renderer that got one
    // right and hard-coded the others would pass a single-side assertion.
    expect(text.match(/At least/g) ?? []).toHaveLength(3);
    expect(text).toContain("At least 3");
    expect(text).toContain("At least 4");
    expect(text).toContain("At least 2");
    // The floor's second half: it is not a batch.
    expect(text).toContain("every future claim in the slot");
  });

  test("an all-zero radius says so as a floor too, never as a guarantee", () => {
    const text = renderRadius(objectRadius());
    expect(text).toContain("floor");
    expect(text).not.toContain("At least 0");
  });
});

describe("⚠️ a zero Atlas COULD NOT ESTABLISH is never rendered as an all-clear", () => {
  // THE defect this block exists for, and it survived the first cut of this
  // file: `ObjectSideLine` returned `null` on `total === 0` BEFORE reading
  // `countsConsistent`, so every condition the engine clears that flag for — a
  // pair row that would not narrow, a scoped window that did not read back, the
  // two statements disagreeing, a deny-all clause — rendered as nothing, and the
  // all-clear paragraph then fired. A count Atlas said in-band it could not
  // establish, presented to an approver as "this changes nothing".

  test("a side with an unestablished zero says UNKNOWN, not silence", () => {
    const text = renderRadius(
      objectRadius({ corroborating: side({ total: 0, countsConsistent: false }) }),
    );
    expect(text).toContain("unknown, not zero");
    expect(text).toContain("incomplete");
  });

  test("and the all-clear paragraph does NOT fire beside it", () => {
    const text = renderRadius(
      objectRadius({ tension: side({ total: 0, countsConsistent: false }) }),
    );
    expect(text).not.toContain("Nothing in the corpus agrees or contradicts differently");
  });

  test("POSITIVE CONTROL — a KNOWN zero is still silent, and still says all-clear", () => {
    // Without this, rendering the unknown-zero sentence unconditionally would
    // satisfy both assertions above and the ordinary empty case would shout.
    const text = renderRadius(objectRadius());
    expect(text).not.toContain("unknown, not zero");
    expect(text).toContain("Nothing in the corpus agrees or contradicts differently");
  });
});

describe("⚠️ the stale-flag sentence is READ OFF the wire, not hard-coded", () => {
  test("a radius that does not assert persistence does not claim it", () => {
    // `staleEdgesPersist` is a literal `true` on the wire for exactly one
    // purpose — so this sentence is assertable. While the copy was hard-coded
    // the field was DEAD: flipping it in a fixture changed nothing, so the
    // literal justified a claim nothing checked. Cast through `unknown` because
    // the wire type deliberately cannot express `false`; this models a payload
    // from an API that stopped asserting it.
    const text = renderRadius({
      ...(objectRadius({ tension: side({ total: 2 }) }) as object),
      staleEdgesPersist: false,
    } as unknown as BrainVocabularyBlastRadius);
    expect(text).not.toContain("NOT withdrawn");
    expect(text).toContain("did not report what becomes of those flags");
  });
});

describe("⚠️ the stale-flag sentence, which is the surprising one", () => {
  test("says the existing contradiction flags are NOT withdrawn", () => {
    const text = renderRadius(objectRadius({ tension: side({ total: 2 }) }));
    // The approval rewrites `object_key` and nothing else — nothing deletes an
    // `in-tension-with` edge — so each one is left flagging a contradiction
    // between two claims Atlas now treats as agreeing. `staleEdgesPersist` is a
    // literal `true` for this sentence and no other purpose, so a rewrite that
    // dropped it would leave a dead field and a silent lie.
    expect(text).toContain("NOT withdrawn");
  });

  test("the corroboration side says the merge is not retroactive", () => {
    const text = renderRadius(objectRadius({ corroborating: side({ total: 1 }) }));
    expect(text).toContain("not merged retroactively");
  });
});

describe("the disclosure accounting survives onto this branch", () => {
  test("a withheld count is STATED, never a silent omission", () => {
    const text = renderRadius(
      objectRadius({ corroborating: side({ total: 5, withheld: 4 }) }),
    );
    expect(text).toContain("4 of those");
    expect(text).toContain("cannot read");
  });

  test("inconsistent counts are flagged rather than rendered as facts", () => {
    const text = renderRadius(
      objectRadius({ corroborating: side({ total: 5, countsConsistent: false }) }),
    );
    expect(text).toContain("disagreed");
  });

  test("a truncated subtree is its own sentence, not a count disagreement", () => {
    const text = renderRadius(
      objectRadius({ separating: side({ total: 2 }), subtreeTruncated: true }),
    );
    expect(text).toContain("smaller population");
  });
});

describe("⚠️ each side is described in ITS OWN words, not the neighbouring side's", () => {
  // The panel's round-4 finding, and the object-radius instance of the pattern
  // that has recurred all through this diff: `corroborating`'s detail is pinned,
  // `tension`'s is pinned in both directions, and `separating` — the REMOVAL's
  // half — appeared three times in this file without ever being asserted for its
  // own words. Giving it the corroborating label and detail left every other test in this file
  // green, and an object-position REMOVAL then read *"pairs of live claims would
  // agree about the object … They are not merged retroactively"*: a merge
  // described for the decision that un-merges. Exactly inverted, on the verb
  // whose own engine header warns it is NOT approval inverted.

  test("`separating` says pairs would STOP agreeing, and says what is not written", () => {
    const text = renderRadius(objectRadius({ separating: side({ total: 4 }) }));
    expect(text).toContain("would stop agreeing");
    expect(text).toContain("No contradiction flag is written for them until one is re-observed");
    // …and it must NOT borrow the corroboration sentence.
    expect(text).not.toContain("would agree about the object");
    expect(text).not.toContain("not merged retroactively");
  });

  test("POSITIVE CONTROL — `corroborating` still says the merge sentence", () => {
    // Without this, swapping the two labels satisfies the assertions above.
    const text = renderRadius(objectRadius({ corroborating: side({ total: 4 }) }));
    expect(text).toContain("would agree about the object");
    expect(text).toContain("not merged retroactively");
    expect(text).not.toContain("would stop agreeing");
  });
});

describe("⚠️ a truncated side says what was truncated, on a side that lists nothing", () => {
  // Deleting the truncation clause outright left every other test in this file green — no test set
  // `truncated` on any object side. And the clause itself was wrong on two of the
  // three: only `corroborating` renders its pairs, so *"Only the first N are
  // listed"* on `separating`/`tension` told an approver to look for examples that
  // are not on the page.

  test("`corroborating` lists pairs, so it says how many are listed", () => {
    const text = renderRadius(
      objectRadius({
        corroborating: side({
          total: 40,
          truncated: true,
          pairs: [{ leftId: "a", leftLabel: "A", rightId: "b", rightLabel: "B" }],
        }),
      }),
    );
    expect(text).toContain("Only the first 1 are listed");
  });

  test("`separating` lists none, so it reports a FLOOR rather than a sample size", () => {
    const text = renderRadius(
      objectRadius({ separating: side({ total: 40, truncated: true, pairs: [] }) }),
    );
    expect(text).toContain("More were counted than this page samples");
    expect(text).toContain("floor");
    expect(text).not.toContain("are listed");
  });
});
