/**
 * The Coverage Surface's wire schemas (#5215, ADR-0041).
 *
 * Tested as NEGATIVES, for `brain.test.ts`'s reason: a green "the valid shape
 * parses" proves nothing about the refusals these schemas exist for. Each arm
 * below is a statement the page would render as true if the parse let it
 * through — a class silently missing, a zero where a refusal belongs, a `stale`
 * badge with no arithmetic behind it, a withheld unit's identity riding along on
 * an arm that has no field for it.
 *
 * The server/client split is asserted rather than assumed: every cross-check is
 * server-side ONLY, because on the browser a producer's already-shipped
 * arithmetic bug must not take down the map edges and the "cannot establish"
 * arms — the parts of this surface that exist to be seen when things are wrong.
 */
import { describe, expect, test } from "bun:test";
import {
  BRAIN_COVERAGE_SOURCE_CLASSES,
  BrainCoverageClientSchema,
  BrainCoverageSchema,
} from "../brain";

const AUTHORITY = {
  buckets: [],
  workspaceTotals: {
    awaitingReview: 4,
    published: 12,
    retracted: 1,
    provisional: 2,
    inTension: 0,
  },
  reviewableAwaitingReview: 3,
  countsConsistent: true,
  distinctAudiences: 0,
  bucketsTruncated: false,
};

/** A chat class with one named surveyed unit and one withheld enumerated one. */
function chatArm() {
  return {
    state: "enumerated" as const,
    asOf: "2026-08-19T02:00:00.000Z",
    ratio: {
      surveyed: 1,
      enumerated: 1,
      enumerable: 2,
      inPerimeterWithoutEvidence: 0,
      unit: "chat-channel-roster" as const,
    },
    freshness: { current: 1, stale: 0, unverified: 0 },
    units: [
      {
        state: "surveyed" as const,
        unitId: "C0001",
        label: "#general",
        clause: "vendor-public" as const,
        newestEvidenceAt: "2026-08-18T09:00:00.000Z",
        freshness: { kind: "current" as const, checkedAt: "2026-08-19T01:00:00.000Z" },
      },
    ],
    unitsWithheld: 1,
    unitsTruncated: false,
    mapEdges: [],
    unavailable: null,
  };
}

/**
 * The whole surface, with per-class overrides MERGED rather than replacing the
 * record — a spread that replaced `availability` wholesale would leave four
 * classes missing, and every negative below would then pass for the wrong
 * reason (the totality refusal, not the one it names).
 */
function coverage(
  overrides: { availability?: Record<string, unknown>; countsConsistent?: boolean } = {},
) {
  const { availability, ...envelope } = overrides;
  return {
    availability: {
      chat: chatArm(),
      transcript: {
        state: "never-enumerated",
        reason: "no-cycle-recorded",
        lastAttemptAt: null,
        unavailableReason: null,
      },
      email: {
        state: "never-enumerated",
        reason: "no-successful-cycle",
        lastAttemptAt: "2026-08-19T02:00:00.000Z",
        unavailableReason: "Microsoft Graph refused the mailbox listing.",
      },
      warehouse: warehouseArm(),
      human: { state: "not-surveyable", reason: "non-surveyable-class" },
      ...availability,
    } as Record<string, unknown>,
    authority: AUTHORITY as Record<string, unknown>,
    countsConsistent: true,
    ...envelope,
  };
}

/** A class with a real cycle, an empty roster, and a map edge. */
function warehouseArm() {
  return {
    state: "enumerated" as const,
    asOf: "2026-08-19T02:00:00.000Z",
    ratio: {
      surveyed: 0,
      enumerated: 0,
      enumerable: 0,
      inPerimeterWithoutEvidence: 0,
      unit: "semantic-layer-enrollment" as const,
    },
    freshness: { current: 0, stale: 0, unverified: 0 },
    units: [] as unknown[],
    unitsWithheld: 0,
    unitsTruncated: false,
    mapEdges: ["warehouse-entity-unreadable"] as unknown[],
    unavailable: null,
  };
}

describe("BrainCoverageSchema — totality (#5215)", () => {
  test("the round trip preserves every class, both arms, and the map edges", () => {
    const parsed = BrainCoverageSchema.parse(coverage());
    expect(Object.keys(parsed.availability).sort()).toEqual(
      [...BRAIN_COVERAGE_SOURCE_CLASSES].sort(),
    );
    expect(parsed.availability.warehouse).toMatchObject({
      mapEdges: ["warehouse-entity-unreadable"],
    });
    expect(parsed.authority.workspaceTotals.awaitingReview).toBe(4);
  });

  test("a class missing from `availability` is refused, not defaulted", () => {
    // The failure the `Record<EpisodeSourceClass, …>` typing exists to prevent,
    // enforced at the boundary too: an absent key renders as a class with
    // nothing to say, which is the opposite statement from one that has nothing
    // to say.
    const payload = coverage() as { availability: Record<string, unknown> };
    delete payload.availability.email;
    expect(() => BrainCoverageSchema.parse(payload)).toThrow();
    expect(() => BrainCoverageClientSchema.parse(payload)).toThrow();
  });

  test("a class the wire union does not declare is a producer bug, so the server refuses it", () => {
    const payload = coverage();
    (payload.availability as Record<string, unknown>).voicemail = {
      state: "not-surveyable",
      reason: "non-surveyable-class",
    };
    expect(() => BrainCoverageSchema.parse(payload)).toThrow();
  });

  test("…and the CLIENT renders the classes it knows rather than blanking the surface", () => {
    // The opposite skew: an API that has learned a new class before this bundle
    // has. Refusing would take the map edges and the cannot-establish arms down
    // with it — the parts that exist to be seen when something is wrong — so the
    // five known classes render and the unknown one is dropped until the next
    // web deploy.
    const payload = coverage();
    (payload.availability as Record<string, unknown>).voicemail = {
      state: "not-surveyable",
      reason: "non-surveyable-class",
    };
    const parsed = BrainCoverageClientSchema.parse(payload);
    expect(Object.keys(parsed.availability).sort()).toEqual(
      [...BRAIN_COVERAGE_SOURCE_CLASSES].sort(),
    );
    expect(parsed.availability.chat.state).toBe("enumerated");
  });
});

describe("BrainCoverageSchema — the authority arm's cross-checks survive the move (#5215)", () => {
  test("refuses a reader total above the workspace total", () => {
    // `BrainFactOversightSchema` cannot be the field on this envelope — it
    // requires the two publish previews `loadCoverage` never composes — so its
    // cross-checks are restated here. Without them the hidden backlog computes
    // NEGATIVE and the page's `<= 0` guard drops the disclosure silently.
    const payload = coverage();
    payload.authority = { ...AUTHORITY, reviewableAwaitingReview: 12 };
    expect(() => BrainCoverageSchema.parse(payload)).toThrow(/compute negative/);
    // The client still renders — a producer's shipped bug must not take the map
    // edges and the cannot-establish arms down with it.
    expect(BrainCoverageClientSchema.parse(payload).authority.reviewableAwaitingReview).toBe(12);
  });

  test("admits the same skew once the authority arm says its counts are untrustworthy", () => {
    const payload = coverage();
    payload.authority = {
      ...AUTHORITY,
      reviewableAwaitingReview: 12,
      countsConsistent: false,
    };
    expect(BrainCoverageSchema.parse(payload).authority.countsConsistent).toBe(false);
  });

  test("refuses an audience cardinality below the buckets it shipped", () => {
    const payload = coverage();
    payload.authority = {
      ...AUTHORITY,
      buckets: [
        {
          labelPolicy: "intrinsic",
          key: "org",
          kind: "org",
          label: "org",
          awaitingReview: 1,
          published: 0,
          retracted: 0,
          provisional: 0,
          inTension: 0,
        },
      ],
      distinctAudiences: 0,
    };
    expect(() => BrainCoverageSchema.parse(payload)).toThrow(/understates a cardinality/);
  });
});

describe("BrainCoverageSchema — no zero where a refusal belongs (#5215)", () => {
  test("a `never-enumerated` arm cannot carry counts", () => {
    // `surveyed: 0` on this arm reads as a measured empty roster rather than an
    // absent one. Strict arms make it a parse failure instead of a stripped
    // field somebody later widens the type for.
    const payload = coverage({
      availability: {
        transcript: {
          state: "never-enumerated",
          reason: "no-cycle-recorded",
          lastAttemptAt: null,
          unavailableReason: null,
          surveyed: 0,
        },
      },
    });
    expect(() => BrainCoverageSchema.parse(payload)).toThrow();
    expect(() => BrainCoverageClientSchema.parse(payload)).toThrow();
  });

  test("a map edge cannot carry a number", () => {
    const payload = coverage({
      availability: {
        warehouse: { ...warehouseArm(), mapEdges: [{ kind: "estimate", n: 40 }] },
      },
    });
    expect(() => BrainCoverageSchema.parse(payload)).toThrow();
    expect(() => BrainCoverageClientSchema.parse(payload)).toThrow();
  });

  test("a map-edge arm this bundle cannot render is refused, never dropped", () => {
    // The flattering direction: a dropped mark makes the map read complete.
    const payload = coverage({
      availability: {
        warehouse: { ...warehouseArm(), mapEdges: ["email-scope-unreadable"] },
      },
    });
    expect(() => BrainCoverageSchema.parse(payload)).toThrow();
    expect(() => BrainCoverageClientSchema.parse(payload)).toThrow();
  });
});

describe("BrainCoverageSchema — the ACL boundary (#5215)", () => {
  test("a unit's arm cannot carry a key the clause did not admit", () => {
    const arm = chatArm();
    const payload = coverage({
      availability: {
        chat: {
          ...arm,
          units: [{ ...arm.units[0], recordedBy: "dana@example.com" }],
        },
      },
    });
    // Strict on BOTH schemas: a browser that passed an unexpected key through
    // to the DOM is the leak; losing the arm in a deploy window is not.
    expect(() => BrainCoverageSchema.parse(payload)).toThrow();
    expect(() => BrainCoverageClientSchema.parse(payload)).toThrow();
  });

  test("an `enumerated` unit cannot carry a freshness verdict", () => {
    // A unit nobody has observed has no measured lag — and `current` on one
    // would be an all-clear about a source Atlas has never read.
    const payload = coverage({
      availability: {
        chat: {
          ...chatArm(),
          units: [
            {
              state: "enumerated",
              unitId: "C0002",
              label: "#incidents",
              clause: "vendor-public",
              inPerimeter: false,
              freshness: { kind: "current", checkedAt: "2026-08-19T01:00:00.000Z" },
            },
          ],
          unitsWithheld: 1,
        },
      },
    });
    expect(() => BrainCoverageSchema.parse(payload)).toThrow();
    expect(() => BrainCoverageClientSchema.parse(payload)).toThrow();
  });
});

describe("BrainCoverageSchema — the cross-checks are server-side only (#5215)", () => {
  test("a denominator that is not its own two states is a server 500, not a browser blank", () => {
    const payload = coverage({
      availability: {
        chat: { ...chatArm(), ratio: { ...chatArm().ratio, enumerable: 9 } },
      },
    });
    expect(() => BrainCoverageSchema.parse(payload)).toThrow(/parts do not make up its whole/);
    // The client renders it. A ratio that disagrees with itself is somebody
    // else's shipped bug; refusing here would take the map edges down with it.
    expect(BrainCoverageClientSchema.parse(payload)).toMatchObject({ countsConsistent: true });
  });

  test("a short freshness tally is refused while `countsConsistent` claims the numbers add up", () => {
    const payload = coverage({
      availability: {
        chat: { ...chatArm(), freshness: { current: 0, stale: 0, unverified: 0 } },
      },
    });
    expect(() => BrainCoverageSchema.parse(payload)).toThrow(/under-reports/);
  });

  test("…and is ADMITTED once the response says the arithmetic is untrustworthy", () => {
    // The degradation is the disclosure. Refusing here would turn a reported
    // inconsistency into a blank page, which is the same failure the flag
    // exists to avoid.
    const payload = coverage({
      countsConsistent: false,
      availability: {
        chat: { ...chatArm(), freshness: { current: 0, stale: 0, unverified: 0 } },
      },
    });
    expect(BrainCoverageSchema.parse(payload).countsConsistent).toBe(false);
  });

  test("a `stale` verdict whose lag does not beat the cadence is refused", () => {
    // ADR-0041 admits stale only as a MEASURED divergence. A verdict whose own
    // arithmetic does not support it is a badge, and the page would render it
    // identically to a real one.
    const arm = chatArm();
    const payload = coverage({
      availability: {
        chat: {
          ...arm,
          freshness: { current: 0, stale: 1, unverified: 0 },
          units: [
            {
              ...arm.units[0],
              freshness: {
                kind: "stale",
                vendorActivityAt: "2026-08-18T10:00:00.000Z",
                newestEvidenceAt: "2026-08-18T09:00:00.000Z",
                lagMs: 3_600_000,
                cadenceMs: 3_600_000,
              },
            },
          ],
        },
      },
    });
    expect(() => BrainCoverageSchema.parse(payload)).toThrow(/badge wearing a measurement/);
  });

  test("named plus withheld must make up the roster, unless the listing was clipped", () => {
    const payload = coverage({
      availability: { chat: { ...chatArm(), unitsWithheld: 0 } },
    });
    expect(() => BrainCoverageSchema.parse(payload)).toThrow(/hides that units were withheld/);

    // Clipped is the one state where the identity legitimately fails — the
    // counts are exact, the listing is not.
    const clipped = coverage({
      availability: { chat: { ...chatArm(), unitsWithheld: 0, unitsTruncated: true } },
    });
    expect(BrainCoverageSchema.parse(clipped).availability.chat).toMatchObject({
      unitsTruncated: true,
    });
  });
});
