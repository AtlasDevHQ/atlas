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
import { BrainFactTensionViewSchema, BrainSearchTensionViewSchema } from "../brain";

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
