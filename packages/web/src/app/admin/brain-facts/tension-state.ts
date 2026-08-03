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
 * Both predicates compare against the browser's clock, so a machine whose clock
 * runs fast by N reads every rival whose window closes within the next N as
 * already superseded — a wider exposure than a knife-edge at the supersession
 * instant, and in the suppressing direction.
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
