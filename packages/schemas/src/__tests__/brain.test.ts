/**
 * The tension-cluster wire schemas' ACL-boundary property (#4913).
 *
 * The withheld arms are `z.strictObject` so a producer that attaches the claim
 * payload to a `visible: false` variant FAILS THE PARSE instead of shipping
 * the data it was supposed to withhold. That is the enforcement — TypeScript's
 * excess-property check covers object literals only, so a spread or a widened
 * variable slips past it — and it is worth a test because "strict" is one
 * keyword away from the envelope schemas' deliberately-stripping `z.object`.
 *
 * Tested as NEGATIVES: a green "valid shapes parse" proves nothing about the
 * refusals this pattern exists for.
 */
import { describe, expect, test } from "bun:test";
import {
  BrainFactOversightClientSchema,
  BrainFactOversightSchema,
  BrainFactTensionSweepResponseSchema,
  BrainFactTensionViewSchema,
  BrainFactWillWidenSchema,
  BrainSearchTensionViewSchema,
  BRAIN_CENSUS_ISSUES,
  BrainEntityEdgeOutcomeSchema,
} from "../brain";

const visibleCounterpart = {
  visible: true as const,
  factId: "f-2",
  edgeDirection: "to" as const,
  subject: "billing pipeline",
  predicate: "owned_by",
  object: "platform team",
  status: "published" as const,
  validFrom: null,
  ingestedAt: "2026-06-01T00:00:00.000Z",
  invalidatedAt: null,
  validTo: null,
  corroborationCount: 2,
  provenance: {
    source: "slack",
    episodeId: "ep-1",
    producer: "extraction:v1",
    attribution: {
      visible: true as const,
      sourceId: "C1:1799999999.001",
      actor: "U1",
      occurredAt: "2026-05-30T00:00:00.000Z",
    },
    extractedAt: "2026-05-30T00:05:00.000Z",
    reconciledAt: "2026-05-30T00:06:00.000Z",
    provisional: false,
    unresolved: [],
    payloadComplete: true,
  },
};

describe("BrainSearchTensionViewSchema — the searchBrain cluster entry", () => {
  test("parses a visible counterpart carrying claim + provenance", () => {
    expect(BrainSearchTensionViewSchema.parse(visibleCounterpart)).toEqual(visibleCounterpart);
  });

  test("REFUSES a visible counterpart missing validTo — the label is required, not optional (#4935)", () => {
    // `.parse(x)).toEqual(x)` above pins that the FIELD exists, but a schema
    // relaxed to `.optional()` still round-trips. `apps/docs/openapi.json`
    // lists `validTo` in `required`, and a client that treats "absent" as
    // "live" reads an arbitrated conflict as open — the whole defect.
    const { validTo: _dropped, ...withoutValidTo } = visibleCounterpart;
    expect(() => BrainSearchTensionViewSchema.parse(withoutValidTo)).toThrow();
  });

  test("parses the withheld count", () => {
    expect(BrainSearchTensionViewSchema.parse({ visible: false, withheldCount: 3 })).toEqual({
      visible: false,
      withheldCount: 3,
    });
  });

  test("REFUSES a withheld arm smuggling the claim payload — the strictObject is the boundary", () => {
    const smuggled = {
      visible: false,
      withheldCount: 1,
      subject: "billing pipeline",
      object: "platform team",
    };
    expect(() => BrainSearchTensionViewSchema.parse(smuggled)).toThrow();
  });

  test("REFUSES a withheld arm carrying provenance", () => {
    expect(() =>
      BrainSearchTensionViewSchema.parse({
        visible: false,
        withheldCount: 1,
        provenance: visibleCounterpart.provenance,
      }),
    ).toThrow();
  });

  test("REFUSES a zero count — an empty withheld entry would render as a conflict that is not there", () => {
    expect(() =>
      BrainSearchTensionViewSchema.parse({ visible: false, withheldCount: 0 }),
    ).toThrow();
  });
});

describe("BrainFactTensionViewSchema — the review-surface entry", () => {
  test("parses a per-rival withheld handle", () => {
    const withheld = { visible: false as const, factId: "f-9", edgeDirection: "from" as const };
    expect(BrainFactTensionViewSchema.parse(withheld)).toEqual(withheld);
  });

  test("REFUSES a withheld arm smuggling the claim payload", () => {
    expect(() =>
      BrainFactTensionViewSchema.parse({
        visible: false,
        factId: "f-9",
        edgeDirection: "from",
        subject: "billing pipeline",
      }),
    ).toThrow();
  });
});

/**
 * The will-widen envelope's cross-check, and WHERE it applies (#5032).
 *
 * This block exists because the whole of #5032's schema work measured zero: the
 * `superRefine` had no test at all, and neither did the server-required /
 * client-optional asymmetry that the docstrings argue for at length. Panel round
 * 4 also found the refinement riding onto the CLIENT schema, where its failure
 * mode is inverted — so the split it forced is asserted here in both directions.
 */
// `added` is typed as the non-empty TUPLE the schema infers, not `string[]`.
// Widening it here would make the round-trip assertions below a compile error —
// which is the encoding working, and worth leaving visible rather than casting
// away: `z.tuple([z.string()], z.string())` exists precisely so this axis is
// checked instead of passing vacuously under `.nonempty()`.
const willWidenEntry: { factId: string; label: string; added: [string, ...string[]] } = {
  factId: "f-1",
  label: "acme corp status active",
  added: ["org"],
};
const oversightEnvelope = {
  buckets: [],
  workspaceTotals: {
    awaitingReview: 3,
    published: 12,
    retracted: 0,
    provisional: 1,
    inTension: 1,
  },
  reviewableAwaitingReview: 3,
  countsConsistent: true,
  distinctAudiences: 1,
  bucketsTruncated: false,
  willSupersede: { total: 0, pairs: [], withheld: 0, truncated: false },
};
const willWiden = { total: 1, entries: [willWidenEntry], truncated: false, incomplete: false };

describe("BrainFactWillWidenSchema — the headline may not understate a visible list", () => {
  test("parses a consistent envelope", () => {
    expect(BrainFactWillWidenSchema.parse(willWiden)).toEqual(willWiden);
  });

  test("REFUSES a total below the entries it summarizes", () => {
    // The one direction this surface must not fail in: a headline saying "1
    // fact" over a list of three ACL changes the reader can see. Server-side
    // that is a 500 with a requestId, not something the panel patches over.
    expect(() =>
      BrainFactWillWidenSchema.parse({ ...willWiden, total: 0 }),
    ).toThrow();
  });

  test("REFUSES an empty `added` — an entry that widens to nobody is not a widening", () => {
    // The tuple encoding's runtime arm. `z.tuple([z.string()], z.string())` is
    // used precisely because zod v4 infers `string[]` from `.nonempty()`, which
    // made the `satisfies` pass vacuously — but the runtime refusal is a
    // separate property from the inferred type, and only this asserts it.
    expect(() =>
      BrainFactWillWidenSchema.parse({
        ...willWiden,
        entries: [{ ...willWidenEntry, added: [] }],
      }),
    ).toThrow();
  });
});

describe("the will-widen envelope is REQUIRED server-side and OPTIONAL client-side", () => {
  test("the server schema refuses a response that dropped the disclosure", () => {
    // A server that stopped emitting this retires the review-gate widening
    // notice — the only thing standing between an unresolvable subject homonym
    // and a private claim's body reaching a public audience. Enforced as a
    // parse, so it cannot be retired by deleting a line.
    expect(() => BrainFactOversightSchema.parse(oversightEnvelope)).toThrow();
    expect(
      BrainFactOversightSchema.parse({ ...oversightEnvelope, willWiden }),
    ).toMatchObject({ willWiden });
  });

  test("the client schema accepts the same response — the deploy-skew window", () => {
    // The asymmetry IS the design: during a deploy an older API omits the field
    // and the panel renders the pre-#5032 page rather than losing the whole
    // oversight surface, hidden-backlog alert included.
    expect(BrainFactOversightClientSchema.parse(oversightEnvelope)).toMatchObject({
      countsConsistent: true,
    });
  });

  test("⚠️ the client schema does NOT carry the cross-check", () => {
    // Panel round 4. The refinement rode onto the client via `.optional()`,
    // which defends the field being ABSENT and does nothing about it being
    // present and inconsistent. A producer-side arithmetic bug — one that can
    // only under-state a single headline — then failed `safeParse` on the whole
    // envelope, and `useAdminFetch` hard-throws on that, taking down the
    // hidden-backlog alert and the supersession preview with it.
    //
    // Server: refuse. Client: render, because somebody else's shipped bug must
    // not black out three disclosures.
    const inconsistent = { ...willWiden, total: 0 };
    expect(() =>
      BrainFactOversightSchema.parse({ ...oversightEnvelope, willWiden: inconsistent }),
    ).toThrow();
    expect(
      BrainFactOversightClientSchema.parse({ ...oversightEnvelope, willWiden: inconsistent }),
    ).toMatchObject({ willWiden: inconsistent });
  });

  test("…and still rejects unknown keys inside it — strictness is a leak guard, not a cross-check", () => {
    // The half the client KEEPS. Dropping `strictObject` along with the
    // refinement is the plausible over-correction, and it is the one that
    // matters: unknown-key rejection is what stops a withheld arm smuggling a
    // payload, which is this file's opening argument.
    expect(() =>
      BrainFactOversightClientSchema.parse({
        ...oversightEnvelope,
        willWiden: { ...willWiden, leaked: "audience:private" },
      }),
    ).toThrow();
  });
});

/**
 * The tension sweep's report (#5029) — the ONE `z.strictObject` on a
 * WORKSPACE-WIDE write.
 *
 * Its neighbours on `/api/v1/admin/brain-facts` are `z.object`, which strips.
 * That is right for them: every one is reader-scoped, so an extra field is
 * noise. This response is not scoped to anybody, so the field a future producer
 * would attach — the pairs it minted, which is the obvious answer to *"in
 * tension with what?"* — would be claim text from every audience in the
 * workspace at once.
 *
 * Tested as NEGATIVES for this file's stated reason: a green "the valid shape
 * parses" proves nothing about the refusal the strictness exists for.
 */
describe("BrainFactTensionSweepResponseSchema (#5029)", () => {
  const report = { minted: 4, truncated: true };

  test("parses the two counts", () => {
    expect(BrainFactTensionSweepResponseSchema.parse(report)).toEqual(report);
  });

  test("REFUSES a report that attaches the pairs it minted — the strictObject is the boundary", () => {
    // The disclosure this schema exists to stop, spelled as the thing somebody
    // would actually add.
    expect(() =>
      BrainFactTensionSweepResponseSchema.parse({
        ...report,
        pairs: [{ from: "fact-a", to: "fact-b", subject: "acme", predicate: "priced at" }],
      }),
    ).toThrow();
  });

  test("REFUSES any extra field at all, including a harmless-looking one", () => {
    // `z.object` would STRIP this and pass, so a relaxation to the neighbours'
    // spelling is invisible without a field that carries nothing: the pairs
    // case above would also be caught by a reviewer reading the diff, and this
    // one is what makes the keyword itself load-bearing.
    expect(() =>
      BrainFactTensionSweepResponseSchema.parse({ ...report, sweptAt: "2026-08-10T00:00:00Z" }),
    ).toThrow();
  });

  test("REFUSES a fractional `minted` — it is a row count", () => {
    // `.int()` was the one keyword in this schema with no falsifier. `minted` is
    // `rows.length` off a `RETURNING`, so a fraction means the producer computed
    // it rather than counted it.
    expect(() =>
      BrainFactTensionSweepResponseSchema.parse({ minted: 1.5, truncated: false }),
    ).toThrow();
  });

  test("REFUSES a negative `minted`, and a missing `truncated`", () => {
    // `minted` is a count of rows written; a negative one is a producer that
    // subtracted something. And `truncated` absent — rather than `false` —
    // reads to a client as "not truncated", which is the reassuring direction
    // and therefore the wrong one to allow by omission.
    expect(() =>
      BrainFactTensionSweepResponseSchema.parse({ minted: -1, truncated: false }),
    ).toThrow();
    expect(() => BrainFactTensionSweepResponseSchema.parse({ minted: 4 })).toThrow();
  });
});

/**
 * The entity-edge census's cross-field invariants (#5277), tested WHERE THEY LIVE.
 *
 * ⚠️ **These existed only as route tests, and that is why two of the branches could
 * mask each other undetected.** Through the route every refusal collapses onto one
 * `reportComplete: false`, so no assertion could name WHICH invariant fired — and an
 * over-count on an idle arm trips two branches at once, leaving either individually
 * deletable with the whole suite green. Naming the message is the whole point.
 *
 * The other thing this closes: nothing anywhere proved the refinements RUN AT ALL.
 * `z.discriminatedUnion` has to carry a `superRefine`-wrapped member's discriminator
 * through, and if it did not, every census check and `positive()` would be dead while
 * every existing test stayed green.
 */
describe("the entity-edge census invariants (#5277)", () => {
  const census = (over: Record<string, number> = {}) => ({
    entries: 10,
    ambiguous: 2,
    selfEdges: 3,
    unmintedIds: 1,
    ...over,
  });
  const counters = {
    queued: 0,
    autoApproved: 0,
    deduped: 0,
    alreadyApproved: 0,
    rejected: 0,
    refused: 0,
  };
  /** The first issue message a parse produced, or `null` when it succeeded. */
  const refusal = (value: unknown): string | null => {
    const parsed = BrainEntityEdgeOutcomeSchema.safeParse(value);
    return parsed.success ? null : (parsed.error.issues[0]?.message ?? "");
  };

  test("the refinements RUN — a discriminatedUnion member keeps its checks", () => {
    // ⚠️ The load-bearing assertion. If `z.discriminatedUnion` dropped a
    // `superRefine`-wrapped option's checks, every other assertion in this block
    // would still pass on the happy path and every invariant added this round would
    // be silently unenforced.
    expect(
      refusal({
        kind: "nothing-to-propose",
        ...census({ entries: 5, ambiguous: 0, selfEdges: 0, unmintedIds: 0 }),
      }),
    ).toBe(BRAIN_CENSUS_ISSUES.unaccountedYetIdle);
    // ...and the control: a well-formed census on the same arm parses.
    expect(refusal({ kind: "nothing-to-propose", ...census({ entries: 6 }) })).toBeNull();
  });

  test("over-counting is refused ON EVERY ARM, and names its own issue", () => {
    // ⚠️ The branch that was individually deletable. It is the ONLY thing refusing an
    // over-count on the two arms that DID propose — where the idle-arm branch cannot
    // apply — so each arm needs its own case or the deletion hides behind a sibling.
    expect(refusal({ kind: "nothing-to-propose", ...census({ entries: 3, ambiguous: 4 }) })).toBe(
      BRAIN_CENSUS_ISSUES.overCounted,
    );
    expect(
      refusal({ kind: "proposed", ...census({ entries: 3, ambiguous: 4 }), counters }),
    ).toBe(BRAIN_CENSUS_ISSUES.overCounted);
    expect(
      refusal({
        kind: "failed",
        reached: {
          phase: "proposing",
          ...census({ entries: 3, ambiguous: 4 }),
          proposalsAttempted: 2,
        },
        message: "…",
      }),
    ).toBe(BRAIN_CENSUS_ISSUES.overCounted);
  });

  test("a batch submitted from a store where NOTHING earned an edge is refused", () => {
    // 2 + 3 + 1 = 6 refusals out of 6 entries, so no entry earned an edge — yet the
    // arm says a batch went out. Distinct from over-counting: the sum is EXACT here,
    // so the over-count branch cannot fire and cannot mask this one.
    expect(refusal({ kind: "proposed", ...census({ entries: 6 }), counters })).toBe(
      BRAIN_CENSUS_ISSUES.allRefusedYetProposed,
    );
    expect(refusal({ kind: "nothing-to-propose", ...census({ entries: 6 }) })).toBeNull();
  });

  test("an idle arm with entries left over is refused — they would have earned edges", () => {
    // The mirror of the case above. The sum is SHORT of `entries` here, so again the
    // over-count branch is inapplicable and this branch is measured alone.
    expect(refusal({ kind: "nothing-to-propose", ...census({ entries: 9 }) })).toBe(
      BRAIN_CENSUS_ISSUES.unaccountedYetIdle,
    );
    expect(refusal({ kind: "proposed", ...census({ entries: 9 }), counters })).toBeNull();
  });

  test("fewer proposals than earners is refused — `positive()` closed only zero", () => {
    // ⚠️ 10 entries, 6 refused, so FOUR earned an edge and at least four proposals
    // must have gone out. `positive()` admits 1, 2 and 3 — and a fixture in this very
    // diff claimed 4 submissions for 7 earners, under a comment asserting it was
    // arithmetically possible.
    expect(
      refusal({
        kind: "failed",
        reached: { phase: "proposing", ...census(), proposalsAttempted: 3 },
        message: "…",
      }),
    ).toBe(BRAIN_CENSUS_ISSUES.tooFewProposals);
    // One per earner parses, and so does the real producer's two-per-earner. The
    // exact multiple is deliberately NOT enforced — see `checkCensus`.
    for (const proposalsAttempted of [4, 8]) {
      expect(
        refusal({
          kind: "failed",
          reached: { phase: "proposing", ...census(), proposalsAttempted },
          message: "…",
        }),
      ).toBeNull();
    }
  });

  test("zero proposals on the submitted phase is refused by `positive()`, not by the census", () => {
    // ⚠️ A DIFFERENT mechanism from the case above, and easy to conflate now that the
    // count relation exists. Asserting the issue is NOT the census one is what keeps
    // `positive()` independently falsifiable.
    const zero = {
      kind: "failed",
      reached: { phase: "proposing", ...census(), proposalsAttempted: 0 },
      message: "…",
    };
    expect(BrainEntityEdgeOutcomeSchema.safeParse(zero).success).toBe(false);
    expect(refusal(zero)).not.toBe(BRAIN_CENSUS_ISSUES.tooFewProposals);
  });

  test("the phases that establish no census are not census-checked", () => {
    // `store-read` carries nothing and `planning` carries only `entries`, so there is
    // no partition to assert. A refinement attached to them would refuse every real
    // failure of those kinds.
    for (const reached of [{ phase: "store-read" }, { phase: "planning", entries: 11 }]) {
      expect(refusal({ kind: "failed", reached, message: "…" })).toBeNull();
    }
  });

  test("an empty store is not mistaken for an unaccounted one", () => {
    // The boundary the equality branch must ADMIT: 0 = 0. This is the commonest real
    // outcome of all, so a `>=` in place of the `!== 0` would refuse almost every
    // healthy idle run.
    expect(
      refusal({
        kind: "nothing-to-propose",
        entries: 0,
        ambiguous: 0,
        selfEdges: 0,
        unmintedIds: 0,
      }),
    ).toBeNull();
  });
});
