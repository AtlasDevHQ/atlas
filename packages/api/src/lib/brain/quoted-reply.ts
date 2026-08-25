/**
 * Quoted reply chains and signatures → the text the extractor reads (#5354).
 *
 * A 12-message mail thread means the 12th message's body contains the text of
 * messages 1–11. Extracted as stored, the same claim is read on every reply:
 * slot-key dedupe in `reconcile.ts` collapses the results onto one fact, so
 * this is COST AND PROVENANCE NOISE rather than corruption — ~12× the model
 * spend and ~12 provenance edges hung on a claim made once. Quadratic in thread
 * depth, and it lands on exactly the spend #5334 exists to reduce.
 *
 * ## Why this is a view and not an edit
 *
 * `brain_episodes` is append-only evidence (migration 0180) — evidence that can
 * be rewritten cannot back a provenance claim. So the episode keeps the FULL
 * body and this produces a view of it for the model. The cost is a little
 * storage; what it buys is that a parser bug is recoverable by re-extracting
 * rather than being a silent, permanent loss of text nobody can reconstruct.
 * `ingest/outlook/api.ts` already draws this line for HTML stripping — "a
 * half-stripped message reads as a whole message to everything downstream" —
 * and the same argument applies with more force here, because a quoted-reply
 * parser has far more edge cases than a tag stripper.
 *
 * ## Why a library
 *
 * Quoted-reply detection is a solved problem with a long tail of known edge
 * cases (localised `On … wrote:` variants, Outlook's divider, mobile-client
 * footers, nested forwards). `email-reply-parser` is the maintained JS port of
 * GitHub's `EmailReplyParser`. Mailgun's Talon is more thorough — it does
 * ML-assisted signature detection — but it is Python, and a sidecar is not
 * worth it for a cost-reduction pass. Revisit if the measured gaps below start
 * to matter.
 *
 * The one call this module makes is `read(body).getVisibleText()`, and the
 * method matters more than the package: `getVisibleText` keeps the fragments
 * where `isHidden()` is false, and the parser derives `isHidden` as `isQuoted
 * || isSignature || isEmpty` (`parser/emailparser.js`, `addFragment`). So BOTH
 * halves this needs — quoted history and signatures — come off one call, and
 * neither flag is read directly here. Naming the derivation rather than the two
 * predicates is deliberate: a version that split them would change what this
 * module strips without changing a line of it.
 *
 * ## Measured limitations, deliberately not closed here
 *
 * Both were confirmed against 2.3.9 and are pinned as expected-failure fixtures
 * in `__tests__/quoted-reply.test.ts`, so a version bump reports whether they
 * closed rather than leaving it to be rediscovered:
 *
 *   1. A legal disclaimer with no `--` delimiter survives into the visible
 *      text. Accepted: a disclaimer is a fixed per-message tail — LINEAR, not
 *      quadratic — so it is not the cost this exists to remove, and closing it
 *      means hand-rolled regexes, which is what the library is here to avoid.
 *      This is the one half of #5354's criteria left undone, so it is tracked in
 *      #5420 rather than only here — first criterion there is to MEASURE the
 *      token share before choosing a fix, since linear is not the same as free.
 *
 *      ⚠️ STILL OPEN, and the entry stays until a reading closes it. What
 *      exists now is only the INSTRUMENT: `boilerplate-tail.ts` plus
 *      `scripts/measure-disclaimer-share.ts`, which measure the repeated-tail
 *      share without matching a word of English. **No reading has been taken.**
 *      No workspace in this repo has ingested mail and ADR-0044 bars the one
 *      public corpus from ever being committed, so the number has to come from
 *      a human running that script against a local corpus or a live workspace.
 *      Do not read "the instrument is written" as "the cost is known" — the
 *      whole point of #5420's first criterion is that nobody has measured this.
 *   2. A `---------- Forwarded message ---------` header block survives (the
 *      quoted body beneath it is still stripped). Small, per-forward, and mildly
 *      attribution-confusing — the one gap worth revisiting first.
 *
 * And one that is not a parse gap but a runtime property of the same choice:
 * the package uses the RE2 engine for ReDoS protection WHEN AVAILABLE and falls
 * back to native `RegExp` when it is not. `re2` is an OPTIONAL peer and this
 * repo does not install it (it is a native addon, which is a real cost for the
 * `create-atlas` templates), so every body here is matched by native `RegExp` —
 * up to `MAX_EMAIL_BODY_BYTES` (1 MB, `ingest/outlook/client.ts`) of text whose
 * shape a sender chooses. The `catch` below covers a THROW, not a hang, so this
 * is a bounded-spend argument rather than a covered one: the extraction fiber is
 * unattended, so a pathological body costs a stalled worker rather than a
 * request. Installing `re2` is the fix if that ever shows up.
 *
 * ## Email class only
 *
 * Gated on the source's CLASS, never on `=== "outlook"`: a second mail vendor
 * arrives as its own stored value under the same class (see `sources.ts` on why
 * the shared Message-ID does not license a shared stored value), and it would
 * inherit this without a code change. Chat and transcript bodies have no quoted
 * reply chains to strip, and running a mail parser over a Zoom transcript is a
 * way to lose a speaker turn to a false `--` match.
 */

import EmailReplyParser from "email-reply-parser";
import { createLogger } from "@atlas/api/lib/logger";
import { EMAIL_CLASS, episodeSourceClassOf } from "@atlas/api/lib/brain/sources";

const log = createLogger("brain.extract");

/** One parser instance; it holds no per-message state. */
const PARSER = new EmailReplyParser();

/**
 * The RFC header block `composeEmailBody` prepends to every mail episode.
 *
 * Matched so {@link hasNovelText} can ask whether a strip left anything the
 * model has not already been shown. The coupling to `ingest/outlook/client.ts`
 * is real but deliberate and one-directional: this reads a shape that file
 * writes, and a new header field appearing there costs a false "no novel text"
 * (which falls back to the FULL body — the safe direction), not a silent drop.
 *
 * It matches MORE than `composeEmailBody` writes — `Bcc`, `Sent` and `Reply-To`
 * are not in that header block. That is not dead breadth: `Sent:` heads the
 * lines inside Outlook's `-----Original Message-----` divider, and the extra
 * arms cost nothing in the only direction this is read (a line wrongly called a
 * header can only make {@link hasNovelText} answer false, which keeps the full
 * body). Do not read the list as a mirror of that function.
 */
const HEADER_LINE = /^(?:Subject|From|To|Cc|Bcc|Date|Sent|Reply-To):/i;

/**
 * Does this text carry anything beyond the header block?
 *
 * The header block is never quoted, so it always survives the strip. A message
 * whose entire content was quoted history therefore strips down to headers
 * alone, and that case must NOT be handed to the extractor — see
 * {@link strippedForExtraction}.
 */
function hasNovelText(text: string): boolean {
  return text
    .split("\n")
    .some((line) => line.trim() !== "" && !HEADER_LINE.test(line.trim()));
}

/**
 * The body as the extractor should read it: quoted history and signatures
 * removed for mail, everything else returned untouched.
 *
 * Falls back to the FULL body — never to empty, never to headers alone — in
 * both failure directions, because the failure modes are not symmetric. A
 * missed strip costs duplicate extraction, which dedupe already absorbs; an
 * over-eager strip costs a claim that is never extracted at all, and nothing
 * downstream would report its absence.
 */
export function strippedForExtraction(
  source: string,
  body: string,
  episodeContext: { readonly workspaceId: string; readonly episodeId: string },
): string {
  if (episodeSourceClassOf(source) !== EMAIL_CLASS) return body;

  let visible: string;
  try {
    visible = PARSER.read(body).getVisibleText();
  } catch (err) {
    // The parser is a third party walking untrusted text. A throw here must not
    // cost the episode its extraction, so the full body goes to the model — the
    // pre-#5354 behaviour — and the operator gets told which episode paid for it.
    log.warn(
      {
        ...episodeContext,
        source,
        err: err instanceof Error ? err.message : String(err),
      },
      "brain extraction: quoted-reply parser failed — extracting from the full body, including any quoted history",
    );
    return body;
  }

  if (!hasNovelText(visible)) {
    // Everything below the headers was quoted. Two very different things look
    // like this, and only one of them is safe to drop:
    //
    //   - a bare "FYI" forward of a thread already in this mailbox, where every
    //     quoted message is its own episode and dropping the quote loses nothing;
    //   - a thread forwarded in from OUTSIDE, where the quoted text is the only
    //     copy that will ever reach the store.
    //
    // Nothing in the body distinguishes them, so this keeps the full body. It
    // is the expensive answer to the cheap case and the correct one to the
    // costly case, and re-extracting what a sibling episode already covered is
    // absorbed by slot-key dedupe.
    log.debug(
      { ...episodeContext, source, bodyChars: body.length },
      "brain extraction: stripping quoted history would leave only the header block — extracting from the full body instead",
    );
    return body;
  }

  return visible;
}
