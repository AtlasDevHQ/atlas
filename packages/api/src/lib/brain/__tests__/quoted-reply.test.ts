/**
 * Quoted reply chains and signatures → the extractor's view (#5354).
 *
 * The property under test is NOT "does it parse email". It is narrower and has
 * two halves:
 *
 *   1. An N-message thread costs one message's worth of novel text, not N. That
 *      is the whole point of the issue — the cost is quadratic in thread depth
 *      and lands on the spend #5334 exists to reduce.
 *   2. A strip never costs a claim. Every failure direction — parser throw,
 *      forward with no new text, non-mail source — falls back to the FULL body,
 *      because a missed strip is absorbed by slot-key dedupe while an
 *      over-eager one loses a claim silently and forever.
 *
 * ⚠️ Every fixture here is HAND-WRITTEN. The Enron corpus is the obvious place
 * to find real thread shapes and it must not be committed to this repo — it is
 * real people's private mail, and committing it republishes it under AGPL
 * (#5339). Synthetic input is right here for the same reason it is wrong for
 * training a model: a parser either handles a divider or it does not, so this
 * needs SHAPE coverage, not distributional realism.
 */

import { describe, expect, it } from "bun:test";
import { strippedForExtraction } from "@atlas/api/lib/brain/quoted-reply";
import { extractionExcerpt, MAX_BODY_CHARS } from "@atlas/api/lib/brain/extract-contract";
import type { ReconcileEpisodeRef } from "@atlas/api/lib/brain/reconcile";

const CTX = { workspaceId: "ws_1", episodeId: "ep_1" } as const;

/** The header block `composeEmailBody` prepends to every mail episode. */
const HEADER = `Subject: Re: Launch readiness
From: Sam Reyes <sam@acme.com>
To: Dana Kim <dana@x.com>
Date: 2026-08-24T09:20:00Z`;

const mail = (body: string): string => `${HEADER}\n\n${body}`;

const strip = (body: string, source = "outlook"): string =>
  strippedForExtraction(source, body, CTX);

describe("strippedForExtraction — quoted history", () => {
  it("drops an `On … wrote:` chain and keeps the new message", () => {
    const out = strip(
      mail(`Yes, ship it Friday.

On Mon, Aug 24, 2026 at 9:14 AM Dana <dana@x.com> wrote:
> Are we ready for Friday?`),
    );
    expect(out).toContain("Yes, ship it Friday.");
    expect(out).not.toContain("Are we ready for Friday?");
  });

  it("drops Outlook's `-----Original Message-----` divider", () => {
    const out = strip(
      mail(`Approved.

-----Original Message-----
From: Dana <dana@x.com>
Sent: Monday, August 24, 2026 9:14 AM
Subject: Launch readiness

Are we ready?`),
    );
    expect(out).toContain("Approved.");
    expect(out).not.toContain("Are we ready?");
  });

  it("drops a non-English divider — the localised variants are why this is a library", () => {
    // French. A hand-rolled `/On .* wrote:/` regex passes every test above and
    // silently fails this one, which is the whole argument for not writing one.
    const out = strip(
      mail(`Oui, c'est bon pour vendredi.

Le lundi 24 août 2026, Dana <dana@x.com> a écrit :
> Est-ce qu'on est prêts ?`),
    );
    expect(out).toContain("Oui, c'est bon pour vendredi.");
    expect(out).not.toContain("Est-ce qu'on est prêts ?");
  });

  it("drops a `--`-delimited signature", () => {
    const out = strip(
      mail(`Numbers look right to me.

--
Sam Reyes
VP Engineering | Acme Corp
sam@acme.com`),
    );
    expect(out).toContain("Numbers look right to me.");
    expect(out).not.toContain("VP Engineering");
  });

  it("KEEPS the header block — attribution is evidence, not decoration", () => {
    // `composeEmailBody`'s own comment: "who said this, to whom, when" is the
    // question every extracted fact from a mail depends on. A strip that took
    // the headers with the quote would trade one defect for a worse one.
    const out = strip(mail("Shipping Friday.\n\nOn Mon Dana wrote:\n> ok?"));
    expect(out).toContain("From: Sam Reyes <sam@acme.com>");
    expect(out).toContain("Subject: Re: Launch readiness");
    expect(out).toContain("Date: 2026-08-24T09:20:00Z");
  });
});

describe("strippedForExtraction — the measured win", () => {
  /** Message N quotes messages N-1 … 1, the way a real reply chain accumulates. */
  const thread = (depth: number): string => {
    let body = "Kicking this off: are we ready for Friday?";
    for (let i = 2; i <= depth; i += 1) {
      body = `Reply number ${i} says something new.

On Mon, Aug ${i}, 2026 at 9:14 AM Dana <dana@x.com> wrote:
${body
  .split("\n")
  .map((line) => `> ${line}`)
  .join("\n")}`;
    }
    return mail(body);
  };

  it("costs one message's novel text at depth 12, not twelve", () => {
    const deep = strip(thread(12));
    const shallow = strip(thread(2));

    // The stored bodies diverge hard — that is the defect.
    expect(thread(12).length).toBeGreaterThan(thread(2).length * 5);

    // The extracted views do not. Both are headers + one message.
    expect(deep.length).toBeLessThan(shallow.length * 1.2);
    expect(deep).toContain("Reply number 12 says something new.");
    expect(deep).not.toContain("Kicking this off");
    expect(deep).not.toContain("Reply number 11");
  });

  it("is flat in thread depth — the cost stops being quadratic", () => {
    const lengths = [2, 6, 12, 24].map((d) => strip(thread(d)).length);
    const spread = Math.max(...lengths) - Math.min(...lengths);
    // Only the two-digit reply numbers differ between these.
    expect(spread).toBeLessThan(20);
  });
});

describe("strippedForExtraction — a strip never costs a claim", () => {
  it("returns the FULL body when the strip would leave only headers", () => {
    // A thread forwarded in from outside: the quoted text is the only copy that
    // will ever reach the store, and nothing in the body distinguishes it from
    // a bare FYI forward of messages already ingested. Keeping the body is the
    // expensive answer to the cheap case and the correct one to the costly case.
    const body = mail(`On Mon, Aug 24, 2026 at 9:14 AM Dana <dana@x.com> wrote:
> The Q3 migration finished Tuesday.`);
    expect(strip(body)).toBe(body);
  });

  it("leaves a body with no quoted history untouched", () => {
    const body = mail("Warehouse migration finished Tuesday.");
    expect(strip(body)).toBe(body);
  });

  it("leaves an empty body untouched rather than inventing text", () => {
    expect(strip("")).toBe("");
  });
});

describe("strippedForExtraction — email class only", () => {
  // Gated on CLASS, never `=== "outlook"`. A second mail vendor inherits this
  // with no code change; a transcript must never reach a mail parser, where a
  // speaker turn beginning `--` would read as a signature.
  it.each(["slack", "zoom", "warehouse", "human"])("leaves %s bodies untouched", (source) => {
    const body = `Alice Smith: We decided to move the launch.

--
not a signature, a speaker turn`;
    expect(strip(body, source)).toBe(body);
  });

  it("leaves an unrecognised stored source untouched", () => {
    // The region-import fail-open lane restores a bundle's `source` verbatim, so
    // an out-of-vocabulary value reaches here. Declining to strip is the safe arm.
    const body = mail("Something.\n\nOn Mon Dana wrote:\n> anything?");
    expect(strip(body, "gmail")).toBe(body);
  });
});

describe("strippedForExtraction — known gaps, pinned so a bump reports them", () => {
  // ⚠️ These assert the CURRENT (wrong) behaviour of email-reply-parser 2.3.9.
  // A failure here is GOOD NEWS — the library closed the gap. Flip the
  // assertion; do not add a regex to force it.

  it("does NOT strip an undelimited legal disclaimer", () => {
    const out = strip(
      mail(`Confirmed, the migration ran clean.

Best,
Sam

This email and any attachments are confidential and intended solely for the
addressee. If you have received this in error, please notify the sender.`),
    );
    // Accepted: linear per-message tail, not the quadratic cost this targets.
    expect(out).toContain("confidential and intended solely");
  });

  it("does NOT strip a `Forwarded message` header block", () => {
    const out = strip(
      mail(`See below.

---------- Forwarded message ---------
From: Dana <dana@x.com>
Subject: Launch

On Sun, Aug 23, Kim <kim@x.com> wrote:
> original question`),
    );
    expect(out).toContain("---------- Forwarded message ---------");
    // The quoted body beneath it IS still stripped — the gap is the header only.
    expect(out).not.toContain("original question");
  });
});

describe("extractionExcerpt — strip runs before the cap", () => {
  const episode = (source: string): ReconcileEpisodeRef => ({
    id: "ep_1",
    workspaceId: "ws_1",
    source,
    sourceId: "msg_1",
    sourceActor: null,
    occurredAt: null,
    visibleTo: [],
  });

  it("spends the budget on new content, not on quoted history", () => {
    // Quoted history alone overruns the cap; the new message is one line. Cap
    // first and the model sees history it has already been shown, with the only
    // novel sentence falling off the end.
    const history = "> The migration ran on Tuesday and everything looked fine.\n".repeat(300);
    const body = mail(
      `Confirmed, we are go for Friday.\n\nOn Mon, Aug 24, 2026 at 9:14 AM Dana <dana@x.com> wrote:\n${history}`,
    );
    expect(body.length).toBeGreaterThan(MAX_BODY_CHARS);

    const excerpt = extractionExcerpt(episode("outlook"), body);
    expect(excerpt).toContain("Confirmed, we are go for Friday.");
    expect(excerpt).not.toContain("[truncated at");
    expect(excerpt.length).toBeLessThan(MAX_BODY_CHARS);
  });

  it("still truncates — and still signals it — when real content overruns the cap", () => {
    const body = mail("Genuinely long analysis. ".repeat(1_000));
    const excerpt = extractionExcerpt(episode("outlook"), body);
    expect(excerpt).toContain(`[truncated at ${MAX_BODY_CHARS} characters]`);
  });

  it("leaves a non-mail source on exactly its pre-#5354 behaviour", () => {
    const body = "Alice Smith: short turn.";
    expect(extractionExcerpt(episode("slack"), body)).toBe(body);
  });
});
