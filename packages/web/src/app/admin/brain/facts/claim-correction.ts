import type { BrainFactCandidate } from "@/ui/lib/types";
import type { BrainFactCorrectRequest } from "@/ui/lib/admin-schemas";

/**
 * The verb split behind the review queue's correction dialog (#5426,
 * condition 5 of [the PRD](docs/prd/company-atlas.md)).
 *
 * ## Why this module exists
 *
 * Prod had run `brain_fact.retract` four times and `supersede` zero times, and
 * that was not adoption drift: `supersede` was reachable only from the
 * `correct_fact` agent tool. `POST /brain-facts/:id/correct` shipped without a
 * web caller, so the only button in front of a human stamped the tombstone —
 * and `retract` is the verb whose whole purpose is to make the past unreadable
 * (`invalidated_at`, filtered by every fact-serving read including `asOf`,
 * deliberately, per #4916). The record could not accumulate legible history no
 * matter what surface was built over it.
 *
 * ## The interface is the human's question, never the verb
 *
 * Callers express WHAT HAPPENED — {@link CorrectionIntent} — and this module
 * maps it to a verb. The condition's own wording is *"without needing to know
 * either word"*, so the vocabulary must not cross this seam. `retract` and
 * `supersede` appear nowhere in the dialog's copy.
 *
 * ## The offer is an optimization; the API stays the authority
 *
 * {@link canSupersede} mirrors the predicates `lib/brain/correction.ts` refuses
 * on, so the dialog does not walk a human three steps into a dead end. It is
 * deliberately NOT a second gate: every refusal still comes back from the API
 * as prose and is rendered. If the refusal set grows, the worst this predicate
 * can do is offer an option that then explains itself — never permit a write
 * the machinery would have refused. That is the `readStoredSource` discipline
 * (`lib/brain/observation.ts`) applied at the browser: one decider, and the
 * cheap local copy may only ever be MORE conservative than it.
 *
 * ## What this surface can never see
 *
 * Two populations are excluded upstream, so neither needs a guard here:
 *
 *   - **Warehouse-derived observations** refuse `supersede`, `re-authority` and
 *     `pin` (tier-1; only `retract` is admitted, since #5331). They cannot
 *     reach this queue at all — `notAnObservationSql` sits ABOVE the status arm
 *     in `lib/brain/candidates.ts`, on purpose, so `?status=published` cannot
 *     list one. Their surface is `GET /retirable` (#5403), which is retract-only
 *     and shares nothing with the split below.
 *   - **Already-retracted claims**, because `candidates.ts` AND-s
 *     `f.invalidated_at IS NULL` into the queue's WHERE. A tombstoned row never
 *     appears, so "supersede something already withdrawn" is not reachable.
 */

/**
 * What the human says happened to the claim, in their terms.
 *
 * ⚠️ No `reason` field, deliberately. `POST /correct` accepts one and the
 * correction episode records it verbatim, but nothing in #5426 asked for a
 * rationale and no surface collects one — a parameter every caller passes as
 * null is worse than either wiring an input or leaving the seam clean. Whether
 * a correction should REQUIRE a stated reason is a real question, and it wants
 * deciding rather than pre-answering with an unused field.
 */
export type CorrectionIntent =
  | { readonly kind: "never-true" }
  | {
      readonly kind: "changed";
      /** The corrected value. Subject and predicate are inherited from the target. */
      readonly object: string;
      /** `YYYY-MM-DD` from a date input, or null to let the API stamp the correction time. */
      readonly since: string | null;
    };

/**
 * A refused intent carries prose, not a boolean — the human typed the input, so
 * they are the one who can fix it, and a generic failure would tell them
 * nothing (CLAUDE.md: no generic error messages).
 */
export type CorrectionBodyResult =
  | { readonly ok: true; readonly body: BrainFactCorrectRequest }
  | { readonly ok: false; readonly problem: string };

/**
 * May this claim be superseded — i.e. does the row admit the *"it was true and
 * then it changed"* answer at all?
 *
 * ⚠️ **Not "is the window open right now".** `supersede` refuses ANY decided end
 * date, a FUTURE one included (`VALIDITY_ALREADY_CLOSED`), because a second
 * arbitration of the same claim is precisely what it must not permit. Comparing
 * `validTo` against the clock would offer the verb on a claim with a scheduled
 * end and take a 409 — so the test is presence, not order.
 */
export function canSupersede(
  candidate: Pick<BrainFactCandidate, "status" | "validTo">,
): boolean {
  return candidate.status === "published" && candidate.validTo === null;
}

/**
 * Map the human's answer onto the wire body for `POST /brain-facts/:id/correct`.
 *
 * Total and pure: every rejection is a returned {@link CorrectionBodyResult},
 * never a throw, so the dialog renders the problem beside the field that caused
 * it and the request is simply not made.
 */
export function correctionBody(intent: CorrectionIntent): CorrectionBodyResult {
  if (intent.kind === "never-true") {
    return { ok: true, body: { verb: "retract" } };
  }

  const object = intent.object.trim();
  if (!object) {
    return { ok: false, problem: "Enter the new value this claim should carry." };
  }

  if (intent.since === null) {
    return { ok: true, body: { verb: "supersede", replacement: { object } } };
  }

  const validFrom = instantFromDateInput(intent.since);
  if (validFrom === null) {
    return {
      ok: false,
      problem: "That date could not be read. Use the date picker, or leave it blank.",
    };
  }

  return { ok: true, body: { verb: "supersede", replacement: { object, validFrom } } };
}

/**
 * `YYYY-MM-DD` (what `<input type="date">` yields) → an ISO-8601 instant, which
 * is what `BrainFactCorrectRequestSchema` requires.
 *
 * Returns null on anything it cannot read, and the caller refuses rather than
 * degrading: this is a human's stated temporal boundary on a supersession, and
 * a wrong `valid_from` gets baked into an immutable published fact.
 *
 * ⚠️ **Read as UTC midnight, not local midnight.** A date-only value names a
 * day, not an instant, so some convention has to supply the time. UTC keeps the
 * stored boundary identical for every reviewer regardless of where they sit —
 * local midnight would store a different instant for the same typed day
 * depending on the browser's zone, which is the worse surprise on a field
 * nobody re-reads.
 */
function instantFromDateInput(value: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;

  const iso = `${match[1]}-${match[2]}-${match[3]}T00:00:00.000Z`;
  // Round-trips the calendar arithmetic, so `2026-02-31` is rejected rather
  // than silently rolling forward into March the way `Date` would.
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== iso) return null;
  return iso;
}
