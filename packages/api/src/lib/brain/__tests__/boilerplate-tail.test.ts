/**
 * The repeated-tail instrument (#5420, gating criterion 1).
 *
 * The property under test is NOT "does it find disclaimers" — it cannot know
 * what a disclaimer is, deliberately, because #5420 forbids matching English
 * legal boilerplate. It is narrower and has two halves:
 *
 *   1. A tail that repeats verbatim across enough messages from one sender is
 *      found, and its character share is EXACT — the number is the deliverable,
 *      so an off-by-a-newline is a wrong reading, not a cosmetic slip.
 *   2. Text that does not repeat is never attributed. This is the direction
 *      that matters: the number decides whether work happens, and an instrument
 *      that counts genuine content as boilerplate argues for stripping claims.
 *
 * What turns these red (named, per `docs/agents/practices.md`, so "there is a
 * test" and "the test can fail" are not the same claim):
 *
 *   - dropping the `+ 1` in `lineChars` → every char assertion below falls short
 *     by the tail's line count;
 *   - `next.count < minRepeats` → `<=` → the two-copy fixtures start reporting
 *     tails at the default threshold;
 *   - removing guard 1 (`tail >= lines.length`) → `wholeMessageRepeats` goes to
 *     zero and `share` jumps to 1 on the duplicate fixture;
 *   - grouping globally instead of per `sample.group` → the cross-group fixture
 *     reports a tail where each sender sent the footer once.
 */

import { describe, expect, it } from "bun:test";
import {
  measureBoilerplateTails,
  type TailSample,
} from "@atlas/api/lib/brain/boilerplate-tail";
import { strippedForExtraction } from "@atlas/api/lib/brain/quoted-reply";

/** Characters a block of lines costs in a body, newlines included. */
const cost = (lines: readonly string[]): number =>
  lines.reduce((sum, line) => sum + line.length + 1, 0);

/**
 * A three-line legal footer, plus the blank line that separates it from the
 * message. The separator IS part of the tail and the tests assert it: it
 * repeats exactly as the footer does, and a fix that removed the footer while
 * leaving a dangling blank line would not have removed the whole tail.
 */
const DISCLAIMER = [
  "",
  "This email and any attachments are confidential and intended solely for the",
  "addressee. If you have received this in error, please notify the sender.",
  "Acme Corp, 1 Example Way, registered in England no. 1234567.",
];

const withDisclaimer = (novel: string): string => `${novel}\n${DISCLAIMER.join("\n")}`;

const sample = (group: string, text: string): TailSample => ({ group, text });

describe("measureBoilerplateTails — finds a repeated tail", () => {
  it("attributes exactly the repeated lines and nothing above them", () => {
    const novel = [
      "Confirmed, the migration ran clean.",
      "Numbers look right to me.",
      "Shipping Friday, then.",
      "Agreed on the rollback plan.",
    ];
    const report = measureBoilerplateTails(
      novel.map((line) => sample("acme.com", withDisclaimer(line))),
    );

    expect(report.messagesWithTail).toBe(4);
    expect(report.wholeMessageRepeats).toBe(0);
    // Four messages, each carrying the footer once. Exact, not approximate.
    expect(report.tailChars).toBe(4 * cost(DISCLAIMER));
    expect(report.totalChars).toBe(4 * cost(DISCLAIMER) + cost(novel));
    expect(report.share).toBeCloseTo(report.tailChars / report.totalChars, 12);
    // The novel text is short and the footer is long — this is the shape #5420
    // is about, and the share should be visibly large here rather than a
    // rounding artefact.
    expect(report.share).toBeGreaterThan(0.7);
  });

  it("lands a four-line footer in the 4–8 band, not the sign-off band", () => {
    // Guard 2: an aggregate share that cannot tell "Thanks, Sam" from a legal
    // block would answer #5420's question wrongly in the expensive direction.
    const report = measureBoilerplateTails(
      ["one", "two", "three"].map((n) => sample("acme.com", withDisclaimer(`Novel ${n}.`))),
    );

    const band = report.bands.find((b) => b.minLines === 4);
    expect(band?.messages).toBe(3);
    expect(band?.chars).toBe(3 * cost(DISCLAIMER));
    expect(report.bands.find((b) => b.minLines === 1)?.messages).toBe(0);
    expect(report.bands.find((b) => b.minLines === 2)?.messages).toBe(0);
  });

  it("separates a one-line sign-off into its own band", () => {
    const report = measureBoilerplateTails(
      ["Yes.", "No.", "Maybe.", "Ship it."].map((n) => sample("acme.com", `${n}\nSent from my phone`)),
    );

    expect(report.bands.find((b) => b.minLines === 1)?.messages).toBe(4);
    expect(report.bands.find((b) => b.minLines === 4)?.messages).toBe(0);
  });
});

describe("measureBoilerplateTails — never attributes text that does not repeat", () => {
  it("reports nothing when every message ends differently", () => {
    const report = measureBoilerplateTails([
      sample("acme.com", "The Q3 migration finished Tuesday."),
      sample("acme.com", "Dana now owns the billing service."),
      sample("acme.com", "We moved the launch to the 14th."),
      sample("acme.com", "Priya is the on-call for next week."),
    ]);

    expect(report.tailChars).toBe(0);
    expect(report.share).toBe(0);
    expect(report.messagesWithTail).toBe(0);
    expect(report.totalChars).toBeGreaterThan(0);
  });

  it("holds the threshold — two copies is not a repeated tail by default", () => {
    const two = ["Novel one.", "Novel two."].map((n) => sample("acme.com", withDisclaimer(n)));

    expect(measureBoilerplateTails(two).tailChars).toBe(0);
    // …and the same input IS a tail once the threshold is lowered to match it,
    // so the zero above is the threshold doing work rather than the detector
    // failing to see the footer at all.
    expect(measureBoilerplateTails(two, { minRepeats: 2 }).tailChars).toBe(2 * cost(DISCLAIMER));
  });

  it("does not match across groups — a footer sent once per sender is not a tail", () => {
    // Every message carries the same footer, but no single sender repeats it.
    // Grouping globally would call this boilerplate; grouping per sender does
    // not, and per sender is the claim the module makes.
    const report = measureBoilerplateTails([
      sample("acme.com", withDisclaimer("Novel one.")),
      sample("beta.com", withDisclaimer("Novel two.")),
      sample("gamma.com", withDisclaimer("Novel three.")),
      sample("delta.com", withDisclaimer("Novel four.")),
    ]);

    expect(report.groups).toBe(4);
    expect(report.tailChars).toBe(0);
  });

  it("counts a wholly-duplicated message as a duplicate, not as boilerplate", () => {
    // Guard 1. An automated notification sent verbatim four times has no novel
    // text to protect, so stripping is not the fix and it must not inflate the
    // number that decides whether stripping happens.
    const body = "Your nightly export completed.\nRows: 1200";
    const report = measureBoilerplateTails(
      [1, 2, 3, 4].map(() => sample("reports.acme.com", body)),
    );

    expect(report.wholeMessageRepeats).toBe(4);
    expect(report.messagesWithTail).toBe(0);
    expect(report.tailChars).toBe(0);
    expect(report.share).toBe(0);
  });
});

describe("measureBoilerplateTails — normalisation a mail transport could do itself", () => {
  it("matches across CRLF and trailing whitespace", () => {
    const crlf = withDisclaimer("Novel one.").replace(/\n/g, "\r\n");
    const padded = withDisclaimer("Novel two.")
      .split("\n")
      .map((line) => `${line}  `)
      .join("\n");
    const plain = withDisclaimer("Novel three.");

    const report = measureBoilerplateTails([
      sample("acme.com", crlf),
      sample("acme.com", padded),
      sample("acme.com", plain),
    ]);

    expect(report.messagesWithTail).toBe(3);
    expect(report.tailChars).toBe(3 * cost(DISCLAIMER));
  });

  it("ignores trailing blank lines rather than splitting one footer in two", () => {
    const report = measureBoilerplateTails([
      sample("acme.com", `${withDisclaimer("Novel one.")}\n\n\n`),
      sample("acme.com", withDisclaimer("Novel two.")),
      sample("acme.com", `${withDisclaimer("Novel three.")}\n`),
    ]);

    expect(report.messagesWithTail).toBe(3);
    expect(report.tailChars).toBe(3 * cost(DISCLAIMER));
  });
});

describe("measureBoilerplateTails — degenerate input", () => {
  it("reports a zero share rather than dividing by zero", () => {
    const report = measureBoilerplateTails([]);
    expect(report.messages).toBe(0);
    expect(report.groups).toBe(0);
    expect(report.totalChars).toBe(0);
    expect(report.share).toBe(0);
  });

  it("echoes the threshold it used, clamped to the floor the method requires", () => {
    // A recorded number that does not carry its threshold cannot be read later,
    // and a threshold of 1 would make every message its own boilerplate.
    expect(measureBoilerplateTails([], { minRepeats: 1 }).minRepeats).toBe(2);
    expect(measureBoilerplateTails([], { minRepeats: 7 }).minRepeats).toBe(7);
    expect(measureBoilerplateTails([]).minRepeats).toBe(3);
  });

  it("falls back to the default on a non-finite threshold instead of zeroing out", () => {
    // `Math.max(2, NaN)` is NaN, which makes the depth test false everywhere:
    // every walk runs to the message's full length, every message is called a
    // whole-message duplicate, and the report reads `share: 0` with `minRepeats`
    // serialising as `null`. A zero meaning "your argument was garbage" is
    // indistinguishable from one meaning "there is no boilerplate here", and
    // that is the exact distinction #5420 turns on.
    const withFooter = ["one", "two", "three", "four"].map((n) =>
      sample("acme.com", withDisclaimer(`Novel ${n}.`)),
    );

    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const report = measureBoilerplateTails(withFooter, { minRepeats: bad });
      expect(report.minRepeats).toBe(3);
      expect(report.wholeMessageRepeats).toBe(0);
      expect(report.tailChars).toBe(4 * cost(DISCLAIMER));
    }
  });
});

describe("the instrument sees the gap `quoted-reply.ts` pins as unclosed", () => {
  // This is the join between the two files. `quoted-reply.test.ts` asserts that
  // the disclaimer SURVIVES `strippedForExtraction` — that assertion is #5420's
  // subject and must not be flipped until the fix lands. What is missing there
  // is any statement of how much that costs, and this supplies it: the same
  // fixture, post-strip, measured.
  //
  // If the library ever closes the gap, `quoted-reply.test.ts` goes red first
  // and this goes red second, which is the right order.
  const HEADER = `Subject: Re: Launch readiness
From: Sam Reyes <sam@acme.com>
To: Dana Kim <dana@x.com>
Date: 2026-08-24T09:20:00Z`;

  const pinned = (novel: string): string =>
    `${HEADER}

${novel}

Best,
Sam

This email and any attachments are confidential and intended solely for the
addressee. If you have received this in error, please notify the sender.`;

  it("measures the surviving disclaimer as a repeated tail", () => {
    const bodies = [
      "Confirmed, the migration ran clean.",
      "Numbers look right to me.",
      "Shipping Friday, then.",
    ].map((novel) => pinned(novel));

    // Post-strip, exactly as the extractor reads it. The disclaimer is still
    // there — that is the defect — and `Best,\nSam` rides along with it,
    // undelimited, for the same reason.
    const stripped = bodies.map((body, i) =>
      strippedForExtraction("outlook", body, { workspaceId: "ws_1", episodeId: `ep_${i}` }),
    );
    for (const text of stripped) {
      expect(text).toContain("confidential and intended solely");
    }

    const report = measureBoilerplateTails(stripped.map((text) => sample("acme.com", text)));

    expect(report.messagesWithTail).toBe(3);
    // Blank + "Best," + "Sam" + blank + two disclaimer lines.
    expect(report.bands.find((b) => b.minLines === 4)?.messages).toBe(3);
    expect(report.share).toBeGreaterThan(0.5);
  });
});
