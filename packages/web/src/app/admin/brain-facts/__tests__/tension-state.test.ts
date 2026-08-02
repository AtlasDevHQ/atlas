import { describe, expect, test } from "bun:test";
import type { BrainFactTensionVisible, BrainFactTensionView } from "@/ui/lib/types";
import { isTensionOpen, isTensionSuperseded, isTensionWithdrawn } from "../tension-state";

/**
 * The lifecycle predicate behind the review queue's "In tension (N)" count and
 * the sheet's strike-through (#4961).
 *
 * Unit-level on purpose. `review-honesty.test.tsx` proves the two SURFACES
 * render what this decided; these pin the decision itself, including the two
 * arms a render fixture cannot reach without the `drifted()` cast — a junk
 * stamp and a stamp missing from the payload. Both are documented in
 * `tension-state.ts` as safety properties, and a documented safety property
 * that no test pins is one refactor from silently inverting.
 */

const PAST = "2026-07-01T00:00:00.000Z";
const FUTURE = new Date(Date.now() + 86_400_000).toISOString();

function visible(overrides: Partial<BrainFactTensionVisible> = {}): BrainFactTensionVisible {
  return {
    visible: true,
    factId: "fact-2",
    edgeDirection: "to",
    subject: "Acme",
    predicate: "uses",
    object: "MySQL",
    status: "published",
    validFrom: null,
    validTo: null,
    ingestedAt: PAST,
    invalidatedAt: null,
    corroborationCount: 1,
    provenance: {
      source: "slack",
      episodeId: "ep-1",
      producer: "extraction:v1",
      attribution: { visible: true, sourceId: "C1/17", actor: "U1", occurredAt: PAST },
      extractedAt: PAST,
      reconciledAt: PAST,
      provisional: false,
      unresolved: [],
      payloadComplete: true,
    },
    ...overrides,
  };
}

/**
 * A payload that DRIFTED from the wire schema — a stamp the server stopped
 * sending, or sent as something other than a string.
 *
 * Cast because the whole point is a value the type forbids: the guards exist
 * for exactly the inputs a well-typed fixture cannot express, so a test that
 * could only build well-typed inputs could not reach them at all.
 *
 * The keys are bound to the wire type through `Extract` rather than spelled as
 * free string literals: renaming one stamp upstream narrows this to the
 * SURVIVING key, and the call site passing the renamed one fails as an unknown
 * property. A free literal would instead leave the spread setting a phantom
 * property, the real field keeping its `null` from `visible()`, and both drift
 * tests passing while testing nothing. (Renaming BOTH at once narrows to
 * `never`, which `Partial<Record<…>>` widens back to `{}` — that case is not
 * caught, and `visible()`'s typed literal is what fails instead.)
 */
function drifted(
  stamps: Partial<
    Record<Extract<keyof BrainFactTensionVisible, "invalidatedAt" | "validTo">, unknown>
  >,
): BrainFactTensionVisible {
  return { ...visible(), ...stamps } as BrainFactTensionVisible;
}

describe("isTensionWithdrawn", () => {
  test("is true only for a real retraction stamp", () => {
    expect(isTensionWithdrawn(visible({ invalidatedAt: PAST }))).toBe(true);
    expect(isTensionWithdrawn(visible({ invalidatedAt: null }))).toBe(false);
  });

  test("treats a MISSING stamp as not-retracted, not as retracted", () => {
    // The arm whose naive spelling (`!== null`) fails toward silence: an absent
    // field is `!== null`, so a drifted payload would suppress the badge on a
    // live conflict. Every other arm in this module errs the other way, and so
    // must this one.
    expect(isTensionWithdrawn(drifted({ invalidatedAt: undefined }))).toBe(false);
  });

  test("treats an EMPTY or malformed stamp as not-retracted either", () => {
    // `typeof === "string"` alone only moves the hazard from an absent field to
    // an empty one — a serializer coalescing `null → ""` reads as a tombstone
    // and suppresses the badge. Parseability is what makes this axis agree with
    // the supersession axis, whose `NaN` comparison already falls through to
    // open, so the module's "errs toward reporting" claim is true of both.
    expect(isTensionWithdrawn(visible({ invalidatedAt: "" }))).toBe(false);
    expect(isTensionWithdrawn(visible({ invalidatedAt: "n/a" }))).toBe(false);
  });
});

describe("isTensionSuperseded", () => {
  test("is true for a window that has CLOSED", () => {
    expect(isTensionSuperseded(visible({ validTo: PAST }))).toBe(true);
  });

  test("is false for a window still open, stamped or not", () => {
    // `brainFactCurrentClause` is `valid_to IS NULL OR valid_to > now()`, so a
    // future-dated stamp — a region import can carry one — is a LIVE rival
    // whose end is merely scheduled. Calling it settled would hide an open
    // conflict, which is worse than the bug #4961 fixes.
    expect(isTensionSuperseded(visible({ validTo: FUTURE }))).toBe(false);
    expect(isTensionSuperseded(visible({ validTo: null }))).toBe(false);
  });

  test("treats an UNPARSEABLE stamp as still open", () => {
    // `Date.parse` yields NaN and every comparison with NaN is false, so this
    // falls through to live. Pinned because the equivalent-looking rewrite
    // `!(Date.parse(...) > Date.now())` inverts exactly this case and nothing
    // else — it would pass every render fixture in the suite.
    expect(isTensionSuperseded(visible({ validTo: "infinity" }))).toBe(false);
  });

  test("treats a MISSING stamp as still open", () => {
    // A different arm from the one above, reached earlier: this returns at the
    // `typeof` guard and never sees `Date.parse`. Separated so that removing
    // either guard fails its own assertion.
    expect(isTensionSuperseded(drifted({ validTo: undefined }))).toBe(false);
  });
});

describe("isTensionOpen", () => {
  test("counts a rival the reader is not allowed to SEE", () => {
    // Its stamps are exactly what the ACL refused to hand over. Inferring
    // "settled" from their absence is the guess that suppresses the badge, and
    // "there is a rival you cannot see" is precisely what should stop a
    // reviewer approving.
    const withheld: BrainFactTensionView = {
      visible: false,
      factId: "fact-2",
      edgeDirection: "to",
    };
    expect(isTensionOpen(withheld)).toBe(true);
  });

  test("closes on EITHER axis, and on both at once", () => {
    // Supersede-then-retract is reachable (the reverse is not), and the two are
    // independent — an implementation that counted axes instead of testing them
    // would double-subtract this rival.
    expect(isTensionOpen(visible({ invalidatedAt: PAST }))).toBe(false);
    expect(isTensionOpen(visible({ validTo: PAST }))).toBe(false);
    expect(isTensionOpen(visible({ invalidatedAt: PAST, validTo: PAST }))).toBe(false);
  });

  test("leaves a live rival open", () => {
    // The negative that keeps every assertion above from being satisfied by a
    // predicate that simply always closes.
    expect(isTensionOpen(visible())).toBe(true);
    expect(isTensionOpen(visible({ validTo: FUTURE }))).toBe(true);
  });

  test("is exactly the complement of the two axes the sheet badges", () => {
    // The invariant that stops the count and the strike-through drifting apart
    // — the whole reason this module exists rather than two inline copies.
    // Fixture-bound, so it catches a change to EITHER existing axis but not a
    // third one added to `isTensionOpen` with no matching sheet badge; a new
    // axis has to join this list, which is the point at which someone notices
    // the sheet needs a badge for it.
    for (const t of [
      visible(),
      visible({ invalidatedAt: PAST }),
      visible({ validTo: PAST }),
      visible({ validTo: FUTURE }),
      visible({ invalidatedAt: PAST, validTo: PAST }),
    ]) {
      expect(isTensionOpen(t)).toBe(!isTensionWithdrawn(t) && !isTensionSuperseded(t));
    }
  });
});
