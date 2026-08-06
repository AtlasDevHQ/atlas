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
  BrainFactTensionViewSchema,
  BrainFactWillWidenSchema,
  BrainSearchTensionViewSchema,
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
