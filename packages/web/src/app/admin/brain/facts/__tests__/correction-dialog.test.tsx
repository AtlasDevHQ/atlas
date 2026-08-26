import { describe, expect, test, afterEach } from "bun:test";
import { render, cleanup, fireEvent } from "@testing-library/react";
import type { BrainFactCandidate } from "@/ui/lib/types";
import { CorrectionDialog } from "../correction-dialog";
import type { CorrectionIntent } from "../claim-correction";

/**
 * What the correction dialog must SAY (#5426), and what it must never say.
 *
 * `claim-correction.test.ts` pins the decision; these prove the SURFACE renders
 * what the predicate decided — the split `tension-state.ts` and
 * `review-honesty.test.tsx` already use in this directory.
 *
 * The load-bearing one is the last: condition 5 asks that a human correcting an
 * outdated claim reaches the right outcome *"without needing to know either
 * word"*, so `retract` and `supersede` appearing in the copy is a regression on
 * the condition itself, not a wording nit.
 */

function candidate(overrides: Partial<BrainFactCandidate> = {}): BrainFactCandidate {
  return {
    id: "fact-1",
    subject: "Series A",
    predicate: "has target raise of",
    object: "6M",
    status: "draft",
    visibleTo: [],
    malformedGrantIndices: [],
    grantReadable: true,
    corroborationCount: 1,
    provenance: {
      source: "slack",
      episodeId: "ep-1",
      producer: "extraction:v1",
      attribution: { visible: false },
      extractedAt: null,
      reconciledAt: null,
      provisional: false,
      unresolved: [],
      payloadComplete: true,
    },
    episode: null,
    tensions: [],
    promotionBlock: null,
    // `unknown` carries no numbers — the schema refuses an age beside it.
    decay: { level: "unknown", ageDays: null, lastObservedAt: null },
    validFrom: null,
    validTo: null,
    extractedAt: null,
    ingestedAt: null,
    updatedAt: null,
    ...overrides,
  };
}

const PUBLISHED_OPEN = candidate({ status: "published", object: "8M" });

function mount(
  target: BrainFactCandidate | null,
  onSubmit: (intent: CorrectionIntent) => void = () => {},
) {
  return render(
    <CorrectionDialog
      target={target}
      busy={false}
      error={null}
      onOpenChange={() => {}}
      onSubmit={onSubmit}
    />,
  );
}

afterEach(cleanup);

describe("CorrectionDialog", () => {
  test("a draft gets today's rejection confirmation, with no question to answer", () => {
    // Guardrail 2 of the design: the default chip is `draft`, and a reviewer's
    // one-click withdrawal must not be taxed to serve a case a draft cannot be
    // in. If this ever renders the radio group, the common path grew a step.
    const { getByText, queryByText } = mount(candidate());
    expect(getByText("Reject this claim?")).toBeDefined();
    expect(queryByText(/It was true/)).toBeNull();
  });

  test("a published claim with an open window is asked what happened", () => {
    const { getByText } = mount(PUBLISHED_OPEN);
    expect(getByText("What happened to this claim?")).toBeDefined();
    expect(getByText(/It shouldn/)).toBeDefined();
    expect(getByText(/It was true/)).toBeDefined();
  });

  test("a published claim whose window is already decided is not asked", () => {
    // `supersede` refuses ANY decided end date, a future one included. Offering
    // the question here would walk the human into a 409.
    const decided = candidate({ status: "published", validTo: "2027-01-01T00:00:00.000Z" });
    const { getByText, queryByText } = mount(decided);
    expect(getByText("Reject this claim?")).toBeDefined();
    expect(queryByText(/It was true/)).toBeNull();
  });

  test("the withdrawal answer is preselected, so the affirmative one is a deliberate act", () => {
    // Asymmetric on purpose: this must never read as "supersede is the good
    // verb". The destructive default is also the honest one — the human has
    // said nothing yet.
    const { getByText, queryByText } = mount(PUBLISHED_OPEN);
    // The action label follows the selected answer, so it is the readable proof
    // of which one is selected on open.
    expect(getByText("Reject")).toBeDefined();
    expect(queryByText("Save new value")).toBeNull();
  });

  test("choosing `it changed` asks for the new value and submits it as an intent", () => {
    let submitted: unknown = null;
    const { getByText, getByLabelText } = mount(PUBLISHED_OPEN, (i) => {
      submitted = i;
    });

    fireEvent.click(getByText(/It was true/));
    fireEvent.change(getByLabelText(/Series A has target raise of/), {
      target: { value: "10M" },
    });
    fireEvent.click(getByText("Save new value"));

    expect(submitted).toEqual({ kind: "changed", object: "10M", since: null, reason: null });
  });

  test("the copy never names a correction verb", () => {
    // The condition's own wording: "without needing to know either word". The
    // verbs are an implementation vocabulary and this seam is where they stop.
    const { container } = mount(PUBLISHED_OPEN);
    const copy = container.textContent ?? "";
    expect(copy.toLowerCase()).not.toContain("retract");
    expect(copy.toLowerCase()).not.toContain("supersede");
  });
});

describe("CorrectionDialog form state across targets", () => {
  test("a corrected value does not survive onto the next claim", () => {
    // Radix fires `onOpenChange` only for changes IT initiates (escape, overlay,
    // cancel). The success path closes this dialog by setting `target` to null
    // from the parent, which is a controlled prop change and does NOT invoke
    // that callback — so a reset hung off it never runs after a correction.
    //
    // Left unfixed, the reviewer corrects one claim to "10M", opens the dialog
    // on a DIFFERENT claim, and finds "It was true — it changed" still selected
    // with "10M" still in the field. One careless confirm supersedes the second
    // claim with the first one's value.
    const { getByText, getByLabelText, queryByText, rerender } = mount(PUBLISHED_OPEN);

    fireEvent.click(getByText(/It was true/));
    fireEvent.change(getByLabelText(/Series A has target raise of/), {
      target: { value: "10M" },
    });

    // The success path: parent nulls the target, then opens on another claim.
    const other = candidate({ id: "fact-2", status: "published", subject: "Series B" });
    rerender(
      <CorrectionDialog
        target={null}
        busy={false}
        error={null}
        onOpenChange={() => {}}
        onSubmit={() => {}}
      />,
    );
    rerender(
      <CorrectionDialog
        target={other}
        busy={false}
        error={null}
        onOpenChange={() => {}}
        onSubmit={() => {}}
      />,
    );

    // Back to the withdrawal answer, with no value carried over.
    expect(getByText("Reject")).toBeDefined();
    expect(queryByText("Save new value")).toBeNull();
  });
});
