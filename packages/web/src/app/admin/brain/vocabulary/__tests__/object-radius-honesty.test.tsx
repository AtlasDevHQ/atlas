import { describe, expect, test, afterEach } from "bun:test";
import { render, cleanup } from "@testing-library/react";
import { createElement } from "react";
import type {
  BrainVocabularyBlastRadius,
  BrainVocabularyObjectRadiusSide,
} from "@/ui/lib/types";
import { BlastRadiusPreview } from "../blast-radius";

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

afterEach(cleanup);

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

function renderRadius(radius: BrainVocabularyBlastRadius): string {
  const { container } = render(
    createElement(BlastRadiusPreview, { radius, pending: false, error: null }),
  );
  return container.textContent ?? "";
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
