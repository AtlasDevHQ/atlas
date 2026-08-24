/**
 * The quoted-reply parser's failure arm (#5354).
 *
 * Its own file because it replaces `email-reply-parser` in the module registry,
 * and `quoted-reply.ts` constructs its parser at import time — the mock has to
 * be installed before that import runs. Under `bun test --parallel` each file
 * gets a fresh registry, so the substitution cannot leak into the suite next
 * door; in the same file as the happy-path tests it would.
 *
 * What this pins is the DIRECTION of the fallback. The two failure modes are not
 * symmetric: a missed strip costs duplicate extraction, which slot-key dedupe in
 * `reconcile.ts` already absorbs, while an over-eager strip costs a claim that
 * is never extracted at all and whose absence nothing downstream reports. So a
 * parser that throws must cost the full body going to the model — the
 * pre-#5354 behaviour — and never an empty or headers-only view.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";

const CTX = { workspaceId: "ws_1", episodeId: "ep_1" } as const;

const BODY = `Subject: Re: Launch
From: Sam <sam@acme.com>

Shipping Friday.

On Mon, Aug 24, 2026 at 9:14 AM Dana <dana@x.com> wrote:
> Are we ready?`;

/** A parser that fails the way a third party walking untrusted text can. */
const installThrowingParser = async (): Promise<void> => {
  await mock.module("email-reply-parser", () => ({
    default: class {
      read(): never {
        throw new Error("malformed fragment");
      }
    },
  }));
};

describe("strippedForExtraction — the parser throws", () => {
  beforeEach(async () => {
    await installThrowingParser();
  });

  it("falls back to the full body rather than dropping the episode's text", async () => {
    const { strippedForExtraction } = await import("@atlas/api/lib/brain/quoted-reply");

    // Unstripped — quoted history included. Wasteful, and correct: the claim
    // reaches the extractor. A `""` or a headers-only return here would be a
    // silent, permanent loss the queue stamps as successfully extracted.
    expect(strippedForExtraction("outlook", BODY, CTX)).toBe(BODY);
  });

  it("does not reach the parser at all for a non-mail source", async () => {
    // The class gate runs first, so a broken parser cannot take chat down with
    // it: a `slack` body must pass straight through the same throwing mock.
    const { strippedForExtraction } = await import("@atlas/api/lib/brain/quoted-reply");

    expect(strippedForExtraction("slack", BODY, CTX)).toBe(BODY);
  });
});
