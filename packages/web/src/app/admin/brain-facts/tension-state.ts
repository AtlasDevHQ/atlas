/**
 * Has a tension counterpart already been arbitrated?
 *
 * ONE definition behind BOTH review surfaces — the list's "In tension (N)"
 * count (`columns.tsx`) and the sheet's per-rival badges and strike-through
 * (`candidate-detail.tsx`). They previously disagreed: the sheet labelled a
 * settled rival while the list still counted it, so a fully arbitrated row read
 * as contested with nothing left to resolve (#4961).
 *
 * Its own module for `list-query.ts`'s reason — this is a domain predicate, not
 * badge vocabulary, and pinning its boundary cases should not require mounting
 * the queue page. `__tests__/tension-state.test.ts` covers them directly;
 * `review-honesty.test.tsx` proves the two surfaces then render what the
 * predicate decided.
 *
 * ## Why the READER decides this, and not the API
 *
 * `lib/brain/tensions.ts` deliberately filters NEITHER temporal axis and
 * carries both stamps raw: a rival that was retracted or superseded is still
 * why this claim was contested, so dropping it server-side would make a
 * conflict vanish the moment somebody resolved one side, and the sheet would
 * lose the record. "Only the reader can decide whether a window has actually
 * closed" is that module's own statement of this seam — #4961 names
 * `tensions.ts` as where settled-vs-contested is decided, and it is not. This
 * is.
 *
 * ## Labels, not a ranking
 *
 * #4935's invariant holds unchanged. Nothing here sorts, scores, or picks a
 * winner, and no ordering key is introduced; these answer only "is there
 * anything left to resolve".
 *
 * ## Every ambiguous input errs toward REPORTING a conflict
 *
 * Over-reporting costs a reviewer a second look; under-reporting hides a live
 * conflict from the one person who would have caught it. So on both axes, a
 * stamp that is absent, empty, or malformed resolves to "still open" — and a
 * WITHHELD rival is never settled at all, because its stamps are exactly what
 * the ACL refused to hand over and inferring "settled" from their absence is
 * the guess that suppresses the badge.
 *
 * Both axes can be stamped on one rival, and each is tested independently:
 * supersede-then-retract is reachable, so an implementation that SUBTRACTED
 * per axis rather than testing per rival would discount that rival twice.
 *
 * ## The client clock, accepted
 *
 * The SUPERSESSION predicate compares against the browser's clock (the
 * retraction one is a parseability check and has no `now()` in it), so a machine
 * whose clock runs fast by N reads every rival whose window closes within the
 * next N as already superseded — a wider exposure than a knife-edge at the
 * supersession instant.
 *
 * ⚠️ That used to be purely the SUPPRESSING direction: the worst a skewed clock
 * could do was drop a badge. Since #4995 the same skew also drives an
 * AFFIRMATIVE claim — a row whose last live rival falls inside the window now
 * renders "Conflict resolved", asserting an arbitration that has not happened.
 *
 * That breaks the symmetry the argument below rests on, so read it with the
 * amendment: a margin no longer merely trades one window for another of equal
 * width, it converts a false ASSERTION into an over-report of an open conflict,
 * which is the direction this module prefers everywhere else. It is still
 * declined, but on weaker grounds than before — a margin narrows the affirmative
 * window without closing it, and only deciding the boundary server-side removes
 * the class. That last point is now worth more than when it was written.
 *
 * Accepted deliberately rather than overlooked, and NOT for the tempting
 * reason. A skew margin added here would not desynchronize the two surfaces —
 * they now share this predicate, which is what the extraction bought. It is
 * declined because a margin only trades a suppression window for an
 * over-reporting window of the same width; it removes no case. What removes the
 * class is deciding the boundary in Postgres, on the same clock the reads use.
 * `correctionTargetSql` already does exactly that for the correction verbs
 * (`NOT brainFactCurrentClause("f") AS window_closed`, #4939) and states the
 * argument in full; the equivalent here is a computed boolean per counterpart
 * on `BrainFactTensionVisible`.
 *
 * A wire change, and it trades rather than only removes — like every fetch-time
 * verdict it is fixed until refetch, so a window closing while the reviewer
 * holds the page open keeps the badge up, where the client comparison
 * re-evaluates each render. That is the same bound `correctionTargetSql` draws
 * around its own claim: what a server boundary eliminates is the clock-SOURCE
 * skew, which is the part that can be eliminated. Worth doing when this is
 * worth hardening beyond an advisory badge.
 */

import type { BrainFactTensionView, BrainFactTensionVisible } from "@/ui/lib/types";

/**
 * Retracted — the `invalidated_at` tombstone.
 *
 * A stamp that DECODES, rather than merely a non-`null` one. The obvious
 * spelling `invalidatedAt !== null` is the one arm of this module that fails
 * toward SILENCE — an absent field is `!== null`, so it would report a
 * retraction and suppress the badge — and `typeof === "string"` only moves that
 * hazard from an absent field to an empty or malformed one, which a serializer
 * coalescing `null → ""` produces. Parseability is the boundary that makes the
 * module's directional property true on BOTH axes rather than one.
 *
 * Nothing on the queue's own path can reach it: `invalidatedAt` is a required
 * `z.string().nullable()` on the parsed list response, and `useAdminFetch`
 * throws rather than render a payload that failed to parse. The guard is for
 * the shape, not for a caller — this is the retirement question asked of a
 * counterpart payload, and the schema is the only thing currently making the
 * field trustworthy.
 */
export function isTensionWithdrawn(tension: BrainFactTensionVisible): boolean {
  if (typeof tension.invalidatedAt !== "string") return false;
  return Number.isFinite(Date.parse(tension.invalidatedAt));
}

/**
 * Superseded — a `valid_to` window that has actually CLOSED.
 *
 * `brainFactCurrentClause` reads `valid_to IS NULL OR valid_to > now()`, so
 * this uses the same boundary the database does, and a future-dated stamp is a
 * LIVE rival. What either stamp MEANS, and why past-vs-future is the whole
 * question, is on `BrainFactTensionVisible.validTo` — the canonical statement,
 * pointed at rather than restated here for the reason `lib/brain/tensions.ts`
 * points at it too.
 *
 * (The INGEST side asks the same question from the other end:
 * `TENSION_CANDIDATES_SQL` in `packages/api/src/lib/brain/reconcile.ts` skips a
 * rival that is already retracted or superseded — "the arbitration already
 * happened at the publish gate". It also skips a FUTURE-dated one, where this
 * predicate keeps it. Deliberate, and in the over-reporting direction: ingest
 * is deciding whether to WRITE an edge, this is deciding whether to show a
 * reviewer one that already exists.)
 */
export function isTensionSuperseded(tension: BrainFactTensionVisible): boolean {
  if (typeof tension.validTo !== "string") return false;
  return Date.parse(tension.validTo) <= Date.now();
}

/**
 * Is this rival still a reason to hold the claim — i.e. does the list count it?
 *
 * The one predicate that takes the WHOLE union, because the withheld arm is
 * part of the answer and belongs here rather than at each call site. Its
 * complement is exactly the set the sheet strikes through.
 */
export function isTensionOpen(tension: BrainFactTensionView): boolean {
  if (!tension.visible) return true;
  return !isTensionWithdrawn(tension) && !isTensionSuperseded(tension);
}

/**
 * Was this claim contested, and is every counterpart now settled? (#4995)
 *
 * The list's "In tension (N)" badge counts open rivals, so #4961 correctly left
 * a fully arbitrated row wearing NO badge — which made it indistinguishable
 * from a row nothing ever contradicted, and dropped the arbitration history out
 * of the list entirely. This is the predicate behind the muted "Conflict
 * resolved" badge that tells those two apart.
 *
 * Defined HERE rather than inline in `columns.tsx` for the module's founding
 * reason: settled-vs-open gets one definition, not two. It is the exact
 * MUTUALLY EXCLUSIVE with the count by construction — `some(isTensionOpen)` and
 * this can never both be true — rather than by two conditions a later edit could
 * drift apart. Not its complement, though: on an empty rival list, or under the
 * cap, BOTH are false and the row wears nothing. Those are the two warnings
 * below, and they are the whole safety property.
 *
 * ⚠️ **The emptiness check is a safety property, not a tidiness one.**
 * `![].some(...)` is `true` (as is the `every` spelling), so dropping the length
 * test would badge every uncontested claim in the queue as "resolved" —
 * inventing an arbitration history, and the one mutation that leaves a naive
 * test green.
 *
 * Inherits the module's directional bias unchanged: a WITHHELD rival reads as
 * open, so a claim whose only counterpart the ACL hid is never reported as
 * resolved. Absence of evidence is not arbitration.
 *
 * ⚠️ **It takes the ROW, not the rival list, and that is the safety property.**
 * A `true` here is only meaningful if the list is COMPLETE: on a page where
 * `TENSION_FANOUT_CAP` bit, a row can arrive holding some of its rivals, and if
 * the ones that arrived happen to be settled then a list-only predicate reports
 * an arbitration a dropped rival contradicts. That flag is page-level, so an
 * earlier draft of this took `readonly BrainFactTensionView[]` and left the
 * check to the caller — which makes the ONE way to misuse this function the
 * shortest way to call it, and makes the failure silent. Folding it in means
 * forgetting the cap is not expressible.
 *
 * Precisely: it makes OMITTING the check inexpressible. A caller can still
 * hand over a structural literal with `pageTensionsTruncated: false` hard-coded
 * — the unit tests' own `row()` helper does — so this buys "you cannot forget",
 * not "you cannot lie".
 *
 * Structural parameter rather than an import of `BrainFactCandidateRow`: this
 * module stays a domain predicate that `columns.tsx` depends on, never the
 * reverse.
 */
export function isFullyArbitrated(row: {
  readonly tensions: readonly BrainFactTensionView[];
  readonly pageTensionsTruncated: boolean;
}): boolean {
  // `!== false`, not `!`, so a flag that ever arrives absent or drifted
  // SUPPRESSES the badge rather than enabling it. Unreachable today — the wire
  // schema makes it a required boolean and `useAdminFetch` throws on a parse
  // failure — but this is the module whose stated bias is that every ambiguous
  // input errs toward reporting a conflict, and this was the one guard in it
  // that failed open.
  if (row.pageTensionsTruncated !== false) return false;
  if (row.tensions.length === 0) return false;
  return !row.tensions.some(isTensionOpen);
}
