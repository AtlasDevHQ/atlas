/**
 * WebVTT → episode body (#4965).
 *
 * The property under test is narrower than "does it parse VTT". This module is
 * where the block-vs-flag asymmetry becomes STRUCTURAL: it keeps speaker labels
 * as TEXT and resolves nobody, so the connector has no code path that could
 * turn an unrecognised speaker into a block. The tests that matter are the ones
 * about not inventing attribution.
 */

import { describe, expect, it } from "bun:test";
import { parseVtt, turnsToBody, vttToBody } from "@atlas/api/lib/brain/ingest/zoom/vtt";

const SAMPLE = `WEBVTT

1
00:00:01.000 --> 00:00:04.000
Alice Smith: We decided to

2
00:00:04.000 --> 00:00:07.000
Alice Smith: move the launch to Q3.

3
00:00:07.500 --> 00:00:09.000
Bob Jones: Any blockers?
`;

describe("parseVtt", () => {
  it("extracts speaker turns and drops the timing scaffolding", () => {
    expect(parseVtt(SAMPLE)).toEqual([
      { speaker: "Alice Smith", text: "We decided to" },
      { speaker: "Alice Smith", text: "move the launch to Q3." },
      { speaker: "Bob Jones", text: "Any blockers?" },
    ]);
  });

  it("survives CRLF — a stray \\r would ride into every quoted fact", () => {
    expect(parseVtt(SAMPLE.replace(/\n/g, "\r\n"))).toEqual(parseVtt(SAMPLE));
  });

  it("does NOT read a mid-sentence colon as a speaker", () => {
    // `We tested this: it worked` parsing as a speaker named "We tested this"
    // would flow into the body as an attribution and the extractor would
    // attribute the claim to a person who does not exist. Erring toward "no
    // speaker" is the safe direction — an unlabelled turn is a quality loss, a
    // mis-attributed one is a false fact.
    const turns = parseVtt(
      "WEBVTT\n\n1\n00:00:01.000 --> 00:00:04.000\nSo we tested the whole pipeline end to end and: it worked\n",
    );
    expect(turns).toEqual([
      { speaker: null, text: "So we tested the whole pipeline end to end and: it worked" },
    ]);
  });

  it("does NOT let an unlabelled cue inherit the previous speaker", () => {
    // Inheriting is how a long pause becomes words in someone else's mouth.
    const turns = parseVtt(
      "WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\nAlice: I think so\n\n2\n00:00:03.000 --> 00:00:04.000\nprobably not\n",
    );
    expect(turns).toEqual([
      { speaker: "Alice", text: "I think so" },
      { speaker: null, text: "probably not" },
    ]);
  });

  it("skips a malformed cue rather than refusing the whole transcript", () => {
    // A transcript is evidence. Discarding a whole meeting over one cue with no
    // timing line would lose it permanently.
    const turns = parseVtt(
      "WEBVTT\n\nJUNK WITH NO TIMING\n\n1\n00:00:01.000 --> 00:00:02.000\nAlice: still here\n",
    );
    expect(turns).toEqual([{ speaker: "Alice", text: "still here" }]);
  });

  it("keeps a payload line that is only digits, but drops a cue INDEX", () => {
    // The index precedes the timing line; a bare "5" AFTER one is real speech.
    const turns = parseVtt("WEBVTT\n\n7\n00:00:01.000 --> 00:00:02.000\nAlice: 5\n");
    expect(turns).toEqual([{ speaker: "Alice", text: "5" }]);
  });

  it("drops NOTE blocks and non-speech placeholders", () => {
    const turns = parseVtt(
      "WEBVTT\n\nNOTE this is metadata\n\n1\n00:00:01.000 --> 00:00:02.000\n[silence]\n\n2\n00:00:03.000 --> 00:00:04.000\nAlice: hi\n",
    );
    expect(turns).toEqual([{ speaker: "Alice", text: "hi" }]);
  });

  it("returns nothing for a transcript with no cues at all", () => {
    expect(parseVtt("WEBVTT\n\n")).toEqual([]);
    expect(parseVtt("")).toEqual([]);
  });
});

describe("turnsToBody", () => {
  it("merges CONSECUTIVE same-speaker turns into one paragraph", () => {
    // Zoom splits one sentence across three cues. An extractor reading
    // "Alice: We decided to" alone can produce a claim from half a sentence.
    expect(vttToBody(SAMPLE)).toBe(
      "Alice Smith: We decided to move the launch to Q3.\nBob Jones: Any blockers?",
    );
  });

  it("merges unlabelled turns only with other unlabelled turns", () => {
    // `null` is a distinct speaker here, not a wildcard.
    expect(
      turnsToBody([
        { speaker: "Alice", text: "one" },
        { speaker: null, text: "two" },
        { speaker: null, text: "three" },
        { speaker: "Alice", text: "four" },
      ]),
    ).toBe("Alice: one\ntwo three\nAlice: four");
  });

  it("does not re-merge a speaker who was interrupted", () => {
    expect(
      turnsToBody([
        { speaker: "Alice", text: "one" },
        { speaker: "Bob", text: "two" },
        { speaker: "Alice", text: "three" },
      ]),
    ).toBe("Alice: one\nBob: two\nAlice: three");
  });
});

describe("the entity-resolution boundary (the FLAG side)", () => {
  it("leaves EVERY speaker as raw text — it resolves nobody", () => {
    // The structural guarantee. If this module resolved speakers to Atlas
    // users, every unrecognised name would become a decision at ingest, and the
    // natural home for an unresolvable speaker is the block arm — silently
    // converting a QUALITY failure into a SAFETY one, which is the inversion
    // ADR-0036 §T6's asymmetry forbids.
    //
    // A speaker no directory would ever match must reach the body verbatim, so
    // #4771 can attribute it and flag the fact `provisional` on failure.
    const body = vttToBody(
      "WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\nExternal Guest (Acme Corp): our contract renews in March\n",
    );
    expect(body).toBe("External Guest (Acme Corp): our contract renews in March");
    // And a dial-in with no name at all still yields its words rather than
    // being dropped for being unattributable.
    expect(vttToBody("WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\nwe should ship it\n")).toBe(
      "we should ship it",
    );
  });
});
