import { describe, expect, test, afterEach } from "bun:test";
import { render, cleanup } from "@testing-library/react";
import { createElement } from "react";
import type { BrainVocabularyCoverage, BrainVocabularyPositionCounts } from "@/ui/lib/types";
import { CoverageStatement } from "../coverage-statement";

/**
 * What the Claim Vocabulary's empty state must SAY, and the one sentence it
 * must never say (#5087).
 *
 * The sibling `facts/__tests__/review-honesty.test.tsx` is the model: every
 * assertion is a place where a quiet UI would mislead an approver.
 *
 * ## ⚠️ "You're all caught up" is the defect, not a wording preference
 *
 * There is no caught-up state for a vocabulary — only what has been decided and
 * what has not yet been observed. Empty is the PRIMARY state for a while,
 * because the structural proposer fires only on claims with a comparable object
 * (#5034: *"on day one it returns zero rows"*) and the cardinality proposer
 * needs three repeated corrections. Meanwhile direct authoring works from day
 * one and is the only route by which some entries are ever written at all.
 *
 * So a congratulation reports **nothing to do** on the surface whose day-one job
 * is the thing only a human can do. Same failure mode as the M1 dogfood, where
 * the sync reported green because the flag was on and only a row count
 * separated that from a source never connected.
 *
 * A label assertion is defeated by rewording, so the durable form is BOTH: a
 * prohibition on the congratulatory vocabulary AND a positive requirement that
 * the specific gate and its number appear.
 */

const EMPTY_COVERAGE: BrainVocabularyCoverage = {
  liveFacts: 47,
  comparableFacts: 0,
  pendingProposals: 0,
  pendingCardinalities: 0,
};

const COUNTS: readonly BrainVocabularyPositionCounts[] = [
  {
    position: "predicate",
    scope: "unscoped",
    total: 0,
    scoped: 0,
    withheld: 0,
    countsConsistent: true,
  },
  {
    position: "subject",
    scope: "reader-scoped",
    total: 0,
    scoped: 0,
    withheld: 0,
    countsConsistent: true,
  },
];

function renderCoverage(overrides?: {
  coverage?: Partial<BrainVocabularyCoverage>;
  counts?: readonly BrainVocabularyPositionCounts[];
  edgeCount?: number;
  cardinalityCount?: number;
}) {
  const { container } = render(
    createElement(CoverageStatement, {
      coverage: { ...EMPTY_COVERAGE, ...overrides?.coverage },
      counts: overrides?.counts ?? COUNTS,
      edgeCount: overrides?.edgeCount ?? 0,
      cardinalityCount: overrides?.cardinalityCount ?? 0,
    }),
  );
  return container.textContent ?? "";
}

afterEach(cleanup);

describe("the empty state is a coverage statement, never a congratulation", () => {
  test("never says any form of 'caught up'", () => {
    // THE prohibition. Broad on purpose — it catches the reword as well as the
    // literal string, because the defect is the CLAIM that there is nothing to
    // do, not the particular phrasing of it.
    const text = renderCoverage().toLowerCase();
    for (const banned of [
      "caught up",
      "all clear",
      "nothing to do",
      "nothing to review",
      "you're done",
      "no action needed",
    ]) {
      expect(text, `the empty state says "${banned}"`).not.toContain(banned);
    }
  });

  test("states what is IN FORCE even when the answer is zero", () => {
    // Point 1 of the AC. "Plainly zero" is a requirement, not a fallback: an
    // approver has to be told the vocabulary is empty rather than left to infer
    // it from an absent table.
    const text = renderCoverage();
    expect(text).toContain("Nothing is shaping identity yet");
  });

  test("states what is in force when there IS something — the positive control", () => {
    // Without this, a component that rendered the "nothing yet" sentence
    // unconditionally would satisfy the assertion above.
    const text = renderCoverage({ edgeCount: 3, cardinalityCount: 1 });
    expect(text).toContain("3 aliases");
    expect(text).toContain("1 curated predicate");
    expect(text).toContain("are shaping identity");
  });

  test("says why Pending is empty SPECIFICALLY, with the number", () => {
    // Point 2. A generic "no proposals right now" is the sentence that reads as
    // an all-clear; naming the gate and the count is what turns a dead page
    // into a legible one — and it is the difference between "the producer found
    // nothing" and "the producer had nothing to read".
    const text = renderCoverage();
    expect(text).toContain("comparable objects");
    expect(text).toContain("0 of your 47 live claims");
  });

  test("distinguishes an empty corpus from a corpus the proposer cannot read", () => {
    // Two different zeros. "You have no claims" and "none of your claims
    // qualify" demand different next actions — connect a source, versus wait or
    // author by hand — and one sentence for both would send an approver to the
    // wrong one.
    const noCorpus = renderCoverage({ coverage: { liveFacts: 0, comparableFacts: 0 } });
    expect(noCorpus).toContain("no live claims yet");

    const noQualifying = renderCoverage({ coverage: { liveFacts: 47, comparableFacts: 0 } });
    expect(noQualifying).not.toContain("no live claims yet");
    expect(noQualifying).toContain("0 of your 47 live claims");
  });

  test("points at authoring as the thing that works today", () => {
    // The ordering argument, in prose: authoring does not wait for either
    // producer, and an empty state that did not say so would leave an approver
    // believing the page is inert until Atlas proposes something.
    expect(renderCoverage()).toContain("Authoring below does not wait");
  });

  test("reports pending work when there is some, rather than always explaining emptiness", () => {
    const text = renderCoverage({ coverage: { pendingProposals: 2, pendingCardinalities: 1 } });
    expect(text).toContain("3 proposals are awaiting review");
    expect(text).not.toContain("comparable objects");
  });
});

describe("withheld entries are stated, never silently omitted", () => {
  test("says how many entries the approver cannot see", () => {
    // ADR-0037 §6: an approver must be able to tell "12 entity edges you cannot
    // see" from "none". A scoped list renders those two identically, so the
    // count is the only thing that distinguishes them.
    const text = renderCoverage({
      counts: [
        { ...COUNTS[0]!, total: 4, scoped: 4 },
        { ...COUNTS[1]!, total: 12, scoped: 0, withheld: 12 },
      ],
    });
    expect(text).toContain("12 entries are in force that you cannot see");
    // …and says WHY it is also a recovery problem, because an entry you cannot
    // see is one you cannot remove here either.
    expect(text).toContain("cannot remove");
  });

  test("says nothing about withholding when nothing is withheld", () => {
    // The negative control for the arm above: a component that always rendered
    // the withheld sentence would alarm every approver on every load, and an
    // alarm that always fires is one nobody reads.
    expect(renderCoverage()).not.toContain("that you cannot see");
  });

  test("warns when the two counts disagreed rather than presenting the delta as fact", () => {
    // `loadFactOversight`'s recorded lesson: silently clamping renders as
    // "nothing is hidden from you", which is the pre-#4825 defect reproduced by
    // its own fix.
    const text = renderCoverage({
      counts: [{ ...COUNTS[1]!, total: 2, scoped: 5, withheld: 0, countsConsistent: false }],
    });
    expect(text).toContain("disagreed");
  });
});
