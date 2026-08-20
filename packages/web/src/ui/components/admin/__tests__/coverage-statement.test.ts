import { describe, expect, test } from "bun:test";
import { composeStatement } from "@/ui/components/admin/brain-coverage/statement";
import {
  CLASS_COPY,
  CLASS_ORDER,
  cannotEstablishClaim,
  enumerationNeverSucceededClaim,
  neverEnumeratedClaim,
  notSurveyableClaim,
} from "@/ui/components/admin/brain-coverage/vocabulary";
import type { BrainCoverage } from "@/ui/lib/types";
// Shared with `app/admin/brain/__tests__/coverage-honesty.test.tsx`. `build` is
// the local alias this suite already used for the whole-surface builder.
import {
  AUTHORITY,
  chatArm,
  coverage as build,
} from "@/ui/components/admin/brain-coverage/__tests__/_fixtures";

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

describe("composeStatement — every class answers (ADR-0041)", () => {
  test("produces one sentence per class, in a fixed order, whatever the counts", () => {
    const statement = composeStatement(build());
    expect(statement.availability).toHaveLength(5);
    // The order is the declared one, not sorted by coverage — otherwise the
    // paragraph rearranges itself to lead with its best class.
    expect(statement.availability.map((s) => s.split(" — ")[0])).toEqual(
      CLASS_ORDER.map((cls) => CLASS_COPY[cls].title),
    );
    // …and the order tuple itself covers the whole class axis, which is what
    // keeps a sixth class from being silently absent from the paragraph. The
    // type-level pin lives in `vocabulary.ts`; this is its runtime half.
    expect(CLASS_ORDER).toHaveLength(statement.availability.length);
  });

  test("the arms with no counts still speak, and say different things", () => {
    const [, transcript, email, warehouse, human] = composeStatement(build()).availability;
    expect(transcript).toContain("Never enumerated");
    // Tried and failed is a different sentence from nobody has looked — the
    // second names something to fix and carries the enumerator's own reason.
    expect(email).toContain("has never succeeded");
    expect(email).toContain("Microsoft Graph refused the mailbox listing.");
    expect(warehouse).toContain("cannot establish anything about");
    expect(human).toContain("Not a surveyable class");
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

describe("composeStatement — one claim, two placements (ADR-0041)", () => {
  test("the paragraph states the no-count arms in the vocabulary's own words", () => {
    // The drift hazard this file already argues for the backlog line, applied to
    // the four class arms: the card and the paragraph render the SAME builder,
    // so a later edit cannot reach one wording and miss the other.
    const [, transcript, email, warehouse, human] = composeStatement(build()).availability;
    expect(transcript).toContain(neverEnumeratedClaim(CLASS_COPY.transcript));
    expect(warehouse).toContain(cannotEstablishClaim(CLASS_COPY.warehouse));
    expect(human).toContain(notSurveyableClaim(CLASS_COPY.human));
    expect(email).toContain(
      enumerationNeverSucceededClaim(
        "2026-08-19T02:00:00.000Z",
        "Microsoft Graph refused the mailbox listing.",
      ),
    );
  });

  test("an unreadable stamp is stated as words, never dropped into silence", () => {
    // The conflation `readDate` exists to end: a corrupt timestamp used to come
    // back `null` exactly like an absent one, so the caption rendered with no
    // date and a fault read as an ordinary state.
    const base = build();
    const chat = base.availability.chat;
    if (chat.state !== "enumerated") throw new Error("fixture drift: chat must be enumerated");
    const [sentence] = composeStatement(
      build({ availability: { ...base.availability, chat: { ...chat, asOf: "not-a-date" } } }),
    ).availability;
    expect(sentence).toContain("as of an unreadable date");
  });
});

describe("composeStatement — no invented dates, no invented denominators", () => {
  test("the warehouse denominator is the semantic layer, not the enrolled subset", () => {
    // Found by hand on prod at v0.2.13, which is what #5216's verification is
    // for. `coverage-warehouse.ts` walks every (entity, dimension) pair the
    // semantic layer defines and sets `inPerimeter` PER UNIT, so enrollment
    // selects the numerator out of that universe — it does not describe the
    // universe. Calling the denominator "enrolled" asserted that a human had
    // enrolled all 281 while 277 rows underneath read "visible to Atlas, not in
    // scope": the headline and the list contradicted each other, on a page whose
    // whole premise is that every part is separately true.
    const base = build();
    const warehouse = {
      state: "enumerated" as const,
      asOf: "2026-08-20T02:00:00.000Z",
      ratio: {
        surveyed: 4,
        enumerated: 277,
        enumerable: 281,
        inPerimeterWithoutEvidence: 0,
        unit: "semantic-layer-enrollment" as const,
      },
      freshness: { current: 0, stale: 0, unverified: 4 },
      units: [],
      unitsWithheld: 281,
      unitsTruncated: false,
      mapEdges: [],
      unavailable: null,
    };
    const statement = composeStatement(
      build({ availability: { ...base.availability, warehouse } }),
    );
    const sentence = statement.availability[3];
    expect(sentence).toContain("4 of 281 entity–dimension pairs");
    expect(sentence).toContain("your semantic layer defines");
    // The load-bearing negative: no phrasing may claim the DENOMINATOR was
    // enrolled. `enrolled` describing a unit is fine; describing the 281 is not.
    expect(sentence).not.toMatch(/of \d+ enrolled/);
    expect(sentence).not.toContain("pairs a human enrolled");
  });

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
    expect(sentence).toContain("Enumeration has been unavailable since");
    expect(sentence).toContain("These counts are the last that succeeded");
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
