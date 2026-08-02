/**
 * Has a tension counterpart already been arbitrated?
 *
 * ONE definition behind BOTH review surfaces — the list's "In tension (N)"
 * count (`columns.tsx`) and the sheet's per-rival badges and strike-through
 * (`candidate-detail.tsx`). They previously disagreed: the sheet labelled a
 * settled rival while the list still counted it, so a fully arbitrated row read
 * as contested with nothing left to resolve (#4961).
 *
 * Extracted from `columns.tsx` for `list-query.ts`'s reason — this is a domain
 * predicate, not badge vocabulary, and pinning its boundary cases should not
 * require mounting the queue page. `__tests__/tension-state.test.ts` covers
 * them directly; `review-honesty.test.tsx` proves the two surfaces then render
 * what the predicate decided.
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
 * conflict from the one person who would have caught it. So each arm resolves
 * an absent, junk, or unknowable stamp to "still open":
 *
 *   - a WITHHELD rival is never settled — its stamps are exactly what the ACL
 *     refused to hand over, and inferring "settled" from their absence is the
 *     guess that suppresses the badge;
 *   - a stamp that is not a string (absent, or drifted) is not a retirement;
 *   - an unparseable stamp yields `NaN`, whose comparison is false;
 *   - a `valid_to` in the FUTURE is a live rival whose end is merely scheduled.
 *
 * ## The client clock, accepted
 *
 * Both predicates compare against the browser's clock, so a machine whose clock
 * runs fast by N reads every rival whose window closes within the next N as
 * already superseded — a wider exposure than a knife-edge at the supersession
 * instant, and in the suppressing direction.
 *
 * Accepted deliberately rather than overlooked. The principled fix is a
 * server-computed boolean on `BrainFactTensionVisible`, decided by the same
 * `now()` the database already uses for `brainFactCurrentClause` — a wire
 * change, and the right one when this is worth hardening. What is NOT an
 * improvement is a client-side skew margin here: #4935 shipped the sheet's
 * badges on this same comparison, so a margin on the count alone would
 * re-create exactly the count-vs-label drift #4961 exists to remove.
 */

import type { BrainFactTensionView, BrainFactTensionVisible } from "@/ui/lib/types";

/**
 * Retracted — the `invalidated_at` tombstone.
 *
 * `typeof === "string"` rather than `!== null`: retraction is the arm whose
 * naive spelling fails toward SILENCE, because an absent field is `!== null`
 * and would suppress the badge. Unreachable today (the list response is
 * schema-parsed and `useAdminFetch` throws on a mismatch), but this predicate
 * is also shaped for `BrainSearchTensionView`'s payload, which has no runtime
 * parse — so the guard is where the drift would land, not where it is today.
 */
export function isTensionWithdrawn(tension: BrainFactTensionVisible): boolean {
  return typeof tension.invalidatedAt === "string";
}

/**
 * Superseded — a `valid_to` window that has actually CLOSED.
 *
 * `brainFactCurrentClause` reads `valid_to IS NULL OR valid_to > now()`, so
 * this uses the same boundary the database does. A future-dated stamp — a
 * region import (`admin-migrate.ts`) can carry one — is a LIVE rival.
 *
 * (The INGEST side asks the same question from the other end:
 * `TENSION_CANDIDATES_SQL` in `reconcile.ts` skips a rival that is already
 * retracted or superseded, "the arbitration already happened at the publish
 * gate". It also skips a FUTURE-dated one, where this predicate keeps it —
 * deliberately, and in the over-reporting direction: ingest is deciding whether
 * to write an edge, this is deciding whether to show a reviewer one that
 * already exists.)
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
