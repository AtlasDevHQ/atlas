import { describe, expect, test } from "bun:test";
import { composeStatement } from "@/ui/components/admin/brain-coverage/statement";
import { CLASS_COPY, CLASS_ORDER } from "@/ui/components/admin/brain-coverage/vocabulary";
import type { BrainCoverage } from "@/ui/lib/types";

/**
 * The composed statement (#5215, ADR-0041) — condition 6's top of page, tested
 * as a value rather than through a rendered tree.
 *
 * The statement IS the page's central claim, so it is asserted where it can be
 * falsified cheaply. Four properties, each of which would be a false page if it
 * broke:
 *
 *   - **Every class answers, always, in a fixed order.** A class omitted from
 *     the paragraph reads as a class with nothing to worry about, and sorting by
 *     size would let the statement lead with whichever class looks best today.
 *   - **No percentage, anywhere.** The pressure for one number is what ADR-0041
 *     names as certain to arrive.
 *   - **No date is invented.** An absent date means nobody has ever established
 *     this; substituting a plausible one turns "we have never looked" into "we
 *     looked just now".
 *   - **The map edges are marks, de-duplicated but never counted.**
 */

const AUTHORITY: BrainCoverage["authority"] = {
  buckets: [],
  workspaceTotals: {
    awaitingReview: 7,
    published: 41,
    retracted: 0,
    provisional: 2,
    inTension: 3,
  },
  reviewableAwaitingReview: 4,
  countsConsistent: true,
  distinctAudiences: 0,
  bucketsTruncated: false,
};

function build(overrides: Partial<BrainCoverage> = {}): BrainCoverage {
  return {
    availability: {
      chat: {
        state: "enumerated",
        asOf: "2026-08-19T02:00:00.000Z",
        ratio: {
          surveyed: 3,
          enumerated: 4,
          enumerable: 7,
          inPerimeterWithoutEvidence: 1,
          unit: "chat-channel-roster",
        },
        freshness: { current: 3, stale: 0, unverified: 0 },
        units: [],
        unitsWithheld: 7,
        unitsTruncated: false,
        mapEdges: ["chat-public-roster-truncated"],
        unavailable: null,
      },
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
      warehouse: { state: "cannot-establish", reason: "unresolvable-class" },
      human: { state: "not-surveyable", reason: "non-surveyable-class" },
      ...overrides.availability,
    },
    authority: overrides.authority ?? AUTHORITY,
    countsConsistent: overrides.countsConsistent ?? true,
  };
}

describe("composeStatement — every class answers (ADR-0041)", () => {
  test("produces one sentence per class, in a fixed order, whatever the counts", () => {
    const statement = composeStatement(build());
    expect(statement.availability).toHaveLength(5);
    // The order is the declared one, not sorted by coverage — otherwise the
    // paragraph rearranges itself to lead with its best class.
    expect(statement.availability.map((s) => s.split(":")[0])).toEqual(
      CLASS_ORDER.map((cls) => CLASS_COPY[cls].title),
    );
    // …and the order tuple itself covers the whole class axis, which is what
    // keeps a sixth class from being silently absent from the paragraph. The
    // type-level pin lives in `vocabulary.ts`; this is its runtime half.
    expect(CLASS_ORDER).toHaveLength(statement.availability.length);
  });

  test("the arms with no counts still speak, and say different things", () => {
    const [, transcript, email, warehouse, human] = composeStatement(build()).availability;
    expect(transcript).toContain("never enumerated");
    // Tried and failed is a different sentence from nobody has looked — the
    // second names something to fix and carries the enumerator's own reason.
    expect(email).toContain("has never succeeded");
    expect(email).toContain("Microsoft Graph refused the mailbox listing.");
    expect(warehouse).toContain("cannot establish");
    expect(human).toContain("not a surveyable class");
  });

  test("carries the credential-relative caption and the as-of date on the ratio", () => {
    const [chat] = composeStatement(build()).availability;
    expect(chat).toContain("3 of 7 chat channels");
    expect(chat).toContain("of the channels Atlas's chat credentials can see");
    expect(chat).toContain("as of");
  });

  test("never spells a percentage, in any sentence", () => {
    const statement = composeStatement(build());
    const everything = [
      ...statement.availability,
      ...statement.mapEdges,
      ...statement.authority,
      statement.caveat ?? "",
    ].join(" ");
    expect(everything).not.toContain("%");
    expect(everything.toLowerCase()).not.toContain("percent");
  });
});

describe("composeStatement — no invented dates, no invented denominators", () => {
  test("a class with no attempt on record gets no date at all", () => {
    const [, transcript] = composeStatement(build()).availability;
    expect(transcript).not.toMatch(/\d{4}/);
  });

  test("a MEASURED empty roster reads differently from never having looked", () => {
    const statement = composeStatement(
      build({
        availability: {
          ...build().availability,
          chat: {
            state: "enumerated",
            asOf: "2026-08-19T02:00:00.000Z",
            ratio: {
              surveyed: 0,
              enumerated: 0,
              enumerable: 0,
              inPerimeterWithoutEvidence: 0,
              unit: "chat-channel-roster",
            },
            freshness: { current: 0, stale: 0, unverified: 0 },
            units: [],
            unitsWithheld: 0,
            unitsTruncated: false,
            mapEdges: [],
            unavailable: null,
          },
        },
      }),
    );
    const [chat] = statement.availability;
    // A cycle ran and found nothing — which is a claim, and carries its date.
    expect(chat).toContain("no chat channels were found");
    expect(chat).toContain("as of");
    expect(chat).not.toContain("0 of 0");
  });

  test("de-duplicates map edges across classes and never counts them", () => {
    const base = build();
    const chat = base.availability.chat;
    if (chat.state !== "enumerated") throw new Error("fixture drift: chat must be enumerated");
    const statement = composeStatement(
      build({
        availability: {
          ...base.availability,
          warehouse: { ...chat, mapEdges: ["chat-public-roster-truncated"] },
        },
      }),
    );
    expect(statement.mapEdges).toHaveLength(1);
    expect(statement.mapEdges.join(" ")).not.toMatch(/\d/);
  });

  test("a frozen enumeration says so IN the paragraph, not only on the card", () => {
    // `unavailable` does not clear `countsConsistent`, so nothing else would
    // qualify the sentence — a reader who reads only the paragraph would take
    // dated counts for live ones.
    const base = build();
    const chat = base.availability.chat;
    if (chat.state !== "enumerated") throw new Error("fixture drift: chat must be enumerated");
    const statement = composeStatement(
      build({
        availability: {
          ...base.availability,
          chat: {
            ...chat,
            unavailable: {
              since: "2026-08-19T02:00:00.000Z",
              reason: "Slack returned 429 for the channel listing.",
            },
          },
        },
      }),
    );
    const [sentence] = statement.availability;
    // The counts survive — they are the last that succeeded, not wrong.
    expect(sentence).toContain("3 of 7 chat channels");
    expect(sentence).toContain("Enumeration has been unavailable since then");
    expect(sentence).toContain("Slack returned 429 for the channel listing.");
  });
});

describe("composeStatement — the authority half", () => {
  test("discloses the hidden backlog as a delta the reader can act on", () => {
    const statement = composeStatement(build());
    expect(statement.authority.join(" ")).toContain("7 claims are awaiting review");
    expect(statement.authority.join(" ")).toContain(
      "3 of the drafts awaiting review are not visible to you",
    );
  });

  test("withholds the delta when the response says its own counts do not add up", () => {
    // The two totals are separate statements on a pool, so a brief ingest race
    // can invert them. A negative backlog rendered as a fact is worse than no
    // backlog line at all.
    const statement = composeStatement(
      build({ authority: { ...AUTHORITY, countsConsistent: false } }),
    );
    expect(statement.authority.join(" ")).not.toContain("not visible to you");
  });

  test("a degraded response qualifies the statement rather than replacing it", () => {
    const statement = composeStatement(build({ countsConsistent: false }));
    expect(statement.caveat).not.toBeNull();
    // Every sentence is still there beneath the caveat — this is a banner, not
    // a blank page.
    expect(statement.availability).toHaveLength(5);
    expect(statement.availability[0]).toContain("Atlas surveys");
  });

  test("a degraded AUTHORITY arm raises the same caveat", () => {
    const statement = composeStatement(
      build({ authority: { ...AUTHORITY, countsConsistent: false } }),
    );
    expect(statement.caveat).not.toBeNull();
  });
});
