/**
 * **Enrollment** — the `(entity, dimension)` pairs a human named as the tier-1
 * warehouse producer's reach (#5196, ADR-0039).
 *
 * The producer (#5042) emits claims for enrolled pairs and for nothing else. An
 * unenrolled dimension is not hidden, not filtered, and not pending — it is
 * OUTSIDE THE PRODUCER'S REACH. This module is the whole storage seam for that
 * decision: the admin surface writes through it, the producer reads through it,
 * and nothing else writes it at all.
 *
 * ## The two arms, and which one lives here
 *
 * ADR-0040 states the contract every source class obeys: **availability is
 * automatic, authority never is.** For the warehouse, availability is live
 * tier-1 through the semantic layer, which already works the moment a
 * datasource is connected. Authority is enrollment plus the review gate, and
 * this file is the first half of that. So the absence of an
 * `enrollOnConnect`/`enrollAllDimensions`/`enrollFromProfiler` export is not an
 * omission — it is the decision. ADR-0039's own test: *a bulk affordance a
 * person invokes deliberately over a set they can see is enrollment; one that
 * runs on connect, on profile, or on a schedule is a sweep.*
 *
 * `__tests__/enrollment-writers.test.ts` pins the set of files that write
 * `brain_enrollment`, so a scheduled or on-connect writer has to delete a test
 * before it can exist.
 *
 * ## Un-enrolling is not an invalidation authority
 *
 * {@link unenrollPair} deletes one row here and touches nothing in
 * `brain_facts`. Facts a human already published stay published, stay visible,
 * and keep their validity windows — un-enrolling stops FUTURE emission and does
 * nothing else. A machine invalidating a fact is forbidden outright (#4759 §2,
 * ADR-0036 §T4), and the only invalidation authority in the product is the human
 * at the review gate. `__tests__/enrollment-pg.test.ts` falsifies this against
 * real Postgres rather than leaving it as prose.
 *
 * ## Empty is a real answer, and it is not a failure
 *
 * Every read here throws on a database error rather than degrading to `[]`. That
 * matters more than usual: a workspace that has enrolled nothing and a workspace
 * whose enrollment read failed produce the SAME empty reach, and under an empty
 * reach the producer emits nothing and every test stays green — ADR-0039's own
 * *"a producer nobody enrolls anything into leaves M4 exactly as dead as it is
 * today, with every test green."* A swallowed error here would be
 * indistinguishable from the honest zero.
 */

import { BRAIN_ENROLLMENT_NAME_MAX } from "@useatlas/schemas";
import type { BrainEnrollmentEntry } from "@useatlas/types";
import { internalQuery } from "@atlas/api/lib/db/internal";

/**
 * Upper bound on either half of a pair.
 *
 * Both halves name something in the semantic layer, whose own identifiers are
 * bounded well below this by Postgres's 63-byte limit; the slack is for display
 * names. It exists so a pathological key cannot be written through the API — the
 * table has no length constraint of its own, deliberately, because a stored row
 * that a future looser bound would reject is worse than a bound enforced at the
 * one door.
 *
 * ⚠️ The number lives in `@useatlas/schemas` and this is an ALIAS. It was
 * briefly declared here as a second `200`, on the reasoning that schemas must
 * not depend on `@atlas/api` — true, but the dependency runs the other way and
 * `lib/` already imports from `@useatlas/schemas` in a dozen places. Two
 * constants plus a docstring claiming a test pinned them was the worst of both:
 * the claim was false, and the only other `200` in the tree sat inside a
 * `mock.module()` factory that replaces this module — a fixture that agrees by
 * construction and can never disagree.
 */
export const ENROLLMENT_NAME_MAX = BRAIN_ENROLLMENT_NAME_MAX;

/**
 * The CALLER's input is malformed. {@link normalizeEnrollmentPair} throws it and
 * the route maps it to a 400 carrying the rule.
 */
export class InvalidEnrollmentPairError extends Error {
  override readonly name = "InvalidEnrollmentPairError";
}

/**
 * A SERVER invariant broke — {@link enrollPair} was called with no actor.
 *
 * ⚠️ Deliberately NOT an {@link InvalidEnrollmentPairError}, and the split is
 * the point. The route matches that class BY TYPE to answer 400, and its
 * `catchAll` spans the write as well as the normalize — so one class covering
 * both conditions surfaces *"An enrollment must record who made it"* as a 400
 * for a request body that has no author field to fix. Unactionable, and a
 * 500-class condition wearing a 4xx.
 *
 * The route resolves the principal and refuses before reaching here, so this is
 * unreachable today. It exists so that when it stops being unreachable the
 * answer is a logged 500 with a request id rather than advice nobody can act on.
 */
export class UnattributedEnrollmentError extends Error {
  override readonly name = "UnattributedEnrollmentError";
}

/** One `(entity, dimension)` pair — the unit of the producer's reach. */
export interface EnrolledPair {
  readonly entity: string;
  readonly dimension: string;
}

/**
 * An enrollment as the admin surface sees it.
 *
 * An ALIAS of the wire type rather than a fourth spelling of the same five
 * fields. The list route hands these rows straight into
 * `BrainEnrollmentListResponseSchema`, and `checked()` takes `unknown` — so a
 * field added to one shape and not the other is a runtime 500 on the list
 * endpoint rather than a red build.
 */
export type EnrollmentRow = BrainEnrollmentEntry;

/**
 * Trim and validate a caller-supplied pair.
 *
 * ONE normalizer for BOTH VERBS, so "enroll validates but un-enroll doesn't"
 * cannot recur. The verbs are asymmetric in consequence — enrolling WIDENS the
 * producer's reach — but a garbage id on the narrowing verb answering
 * `changed: false` instead of a 400 tells an admin their un-enrolment took
 * effect when it matched nothing.
 *
 * ⚠️ **The region import CALLS this function, and that is load-bearing.**
 * `admin-migrate.ts` inserts its rows directly rather than through
 * {@link enrollPair}, so its `validateBundle` arm is a second write door — and
 * the destination's CHECK is weaker than this function (`entity <> ''` admits
 * `"   "`), so a bundle policed only by the CHECK lands pairs that look enrolled
 * and reach nothing.
 *
 * It ran its own copy of the rules for exactly one commit, and that commit added
 * a NUL check HERE and not there, under a comment asserting the two carried one
 * rule set. Calling this function makes the claim structural instead:
 * `__tests__/enrollment-writers.test.ts` pins the CALL rather than a list of
 * rules, so a rule added here applies at both doors on the same commit.
 *
 * The import door is stricter on one axis only — it REFUSES what this function
 * repairs, because an untrimmed pair in a bundle is a defect in the source
 * region and silently trimming it would land a pair the source does not have.
 *
 * ⚠️ **Case is preserved, not folded.** A warehouse column set may legitimately
 * contain `status` and `Status` as different columns, and folding would merge
 * two enrollments into one silently. The cost is that a hand-typed `Status`
 * enrolls a pair the producer will never look up — which is why the authoring
 * route validates the pair against the semantic layer rather than accepting free
 * text, and why the surface picks from a list instead of offering an input box.
 */
export function normalizeEnrollmentPair(entity: string, dimension: string): EnrolledPair {
  const trimmedEntity = entity.trim();
  const trimmedDimension = dimension.trim();
  if (trimmedEntity === "" || trimmedDimension === "") {
    throw new InvalidEnrollmentPairError(
      "An enrollment names an entity and a dimension; both are required.",
    );
  }
  if (
    trimmedEntity.length > ENROLLMENT_NAME_MAX ||
    trimmedDimension.length > ENROLLMENT_NAME_MAX
  ) {
    throw new InvalidEnrollmentPairError(
      `An entity or dimension name may be at most ${ENROLLMENT_NAME_MAX} characters.`,
    );
  }
  // NUL is refused HERE rather than left to Postgres, and the reason is the
  // separator below: this module's pair key uses NUL precisely because a `text`
  // column cannot hold one. Postgres agrees — it answers 22021 — but only after
  // the statement is sent, which surfaces a caller's bad input as a generic 500.
  // The enroll verb never reaches it (the semantic-layer check refuses first);
  // the un-enroll verb deliberately has no such check, so this is the door.
  if (trimmedEntity.includes("\u0000") || trimmedDimension.includes("\u0000")) {
    throw new InvalidEnrollmentPairError(
      "An entity or dimension name may not contain a NUL byte — Postgres cannot store one.",
    );
  }
  return { entity: trimmedEntity, dimension: trimmedDimension };
}

/**
 * The producer's reach — the enrolled set, plus the membership test the producer
 * asks per row.
 *
 * `has` is on the object rather than exported beside it because the two must
 * agree by construction: a free function taking `pairs` would let a caller build
 * the set from one read and test membership against another, which is how a
 * producer ends up emitting for a pair that left the reach mid-run.
 *
 * `entities` is the distinct entity list, and it is here because ADR-0037 §4's
 * fail-closed ambiguity rule is evaluated ACROSS THE ENROLLED SET: the producer
 * refuses to emit a dimension name that is ambiguous among the entities it is
 * producing from, and "the entities it is producing from" is exactly this.
 */
export interface ProducerReach {
  readonly pairs: readonly EnrolledPair[];
  readonly entities: readonly string[];
  /**
   * `readonly` and a property, NOT method shorthand.
   *
   * Method shorthand declares a MUTABLE member, so `reach.has = () => true`
   * compiled — a caller could keep `pairs` and swap the membership test, which
   * is the exact split putting `has` on the object was meant to prevent.
   */
  readonly has: (entity: string, dimension: string) => boolean;
}

/**
 * NUL — the one byte a Postgres `text` value cannot hold (the server rejects it
 * on input), so no stored pair can contain the separator.
 *
 * ⚠️ **A printable separator is the trap here, and it is not hypothetical.**
 * With a SPACE, `("customer account", "tier")` and `("customer", "account tier")`
 * build the same key — so enrolling one would make `has()` answer `true` for the
 * other, and the producer would emit for a pair nobody enrolled. Trimming removes
 * leading and trailing spaces and says nothing about the interior, and an
 * entity's display name routinely has one.
 */
const PAIR_SEPARATOR = "\u0000";

function pairKey(entity: string, dimension: string): string {
  return `${entity}${PAIR_SEPARATOR}${dimension}`;
}

/**
 * A `type` alias, not an `interface`, and that is what removes the index
 * signature.
 *
 * `internalQuery<T>` bounds `T` by `Record<string, unknown>`, which a closed
 * INTERFACE does not satisfy — so the first cut added `readonly [key: string]:
 * unknown` to get past it. A type alias gets an implicit index signature and
 * satisfies the same bound with none written, which is strictly better: an
 * explicit one types every misspelled column read as `unknown` instead of
 * erroring, and turns off excess-property checking for any literal of this type.
 */
type EnrollmentDbRow = {
  readonly entity: string;
  readonly dimension: string;
  readonly enrolled_at: Date | string;
  readonly enrolled_by: string;
  readonly note: string | null;
};

const LIST_SQL = `SELECT entity, dimension, enrolled_at, enrolled_by, note
                    FROM brain_enrollment
                   WHERE workspace_id = $1
                   ORDER BY entity, dimension`;

/**
 * Every enrollment in a workspace, for the admin surface.
 *
 * Unpaginated on purpose. The whole argument for enrollment is that the set is
 * small enough for a person to have chosen it and small enough for a person to
 * review what it produces; a listing that needed paging would be evidence the
 * bound had failed, and truncating it silently would hide that.
 */
export async function listEnrollments(workspaceId: string): Promise<readonly EnrollmentRow[]> {
  const rows = await internalQuery<EnrollmentDbRow>(LIST_SQL, [workspaceId]);
  return rows.map((r) => ({
    entity: r.entity,
    dimension: r.dimension,
    enrolledAt: r.enrolled_at instanceof Date ? r.enrolled_at.toISOString() : String(r.enrolled_at),
    enrolledBy: r.enrolled_by,
    note: r.note,
  }));
}

/**
 * The producer's input set (#5042 reads this).
 *
 * A projection of the same rows {@link listEnrollments} returns, from the same
 * table, rather than a second source of truth: the surface an admin reads and
 * the set a producer emits from must not be able to disagree, and two queries
 * with two WHERE clauses is how they start to.
 */
export async function loadProducerReach(workspaceId: string): Promise<ProducerReach> {
  const rows = await internalQuery<{ entity: string; dimension: string }>(
    `SELECT entity, dimension FROM brain_enrollment
      WHERE workspace_id = $1
      ORDER BY entity, dimension`,
    [workspaceId],
  );
  return makeProducerReach(rows.map((r) => ({ entity: r.entity, dimension: r.dimension })));
}

/**
 * Derive a reach from a pair list. **Pure — it writes nothing.**
 *
 * Split out of {@link loadProducerReach} so there is exactly ONE derivation of
 * `entities` and the membership index, reachable without a database. Before the
 * split the only way to obtain a reach was a live query, so every test and every
 * consumer fixture had to hand-build the three fields — and a hand-built one can
 * disagree with itself in precisely the way the type exists to forbid (the route
 * test's `{ pairs: [], entities: [], has: () => false }` is that shape).
 *
 * It is named in `__tests__/enrollment-writers.test.ts`'s export pin as a
 * derivation rather than a writer: it takes pairs a caller already holds and
 * returns a value. Nothing here reaches `brain_enrollment`, so it is not a path
 * by which anything can enroll.
 */
export function makeProducerReach(pairs: readonly EnrolledPair[]): ProducerReach {
  const index = new Set(pairs.map((p) => pairKey(p.entity, p.dimension)));
  const entities = [...new Set(pairs.map((p) => p.entity))];
  return {
    pairs,
    entities,
    has: (entity, dimension) => index.has(pairKey(entity, dimension)),
  };
}

/**
 * Enroll one pair. Idempotent, and it does NOT re-attribute an existing
 * enrollment.
 *
 * Returns whether a NEW enrollment was written; `false` means the pair was
 * already enrolled and nothing — author, note and timestamp included — changed.
 * `brain_slack_channel`'s exclusion verb answers the same split for the same
 * reason: hardcoding `true` would tell an admin their enrollment took effect
 * while the recorded author stayed someone else's.
 *
 * ⚠️ **`actor` is a person, and the caller is responsible for that being true.**
 * The route derives it from `recordedAuthor`, which yields `null` for any
 * principal that does not clear the owner/admin bar and refuses the request
 * before reaching here. This function's own guard is the narrower one — an empty
 * actor — because the table's CHECK would otherwise surface as a 500 carrying a
 * Postgres message.
 */
export async function enrollPair(params: {
  readonly workspaceId: string;
  readonly entity: string;
  readonly dimension: string;
  readonly note: string | null;
  readonly actor: string;
}): Promise<boolean> {
  const pair = normalizeEnrollmentPair(params.entity, params.dimension);
  const actor = params.actor.trim();
  if (actor === "") {
    throw new UnattributedEnrollmentError(
      "enrollPair was called with an empty actor — the route must resolve a principal before writing.",
    );
  }
  const rows = await internalQuery<{ entity: string }>(
    `INSERT INTO brain_enrollment (workspace_id, entity, dimension, enrolled_by, note)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (workspace_id, entity, dimension) DO NOTHING
     RETURNING entity`,
    [params.workspaceId, pair.entity, pair.dimension, actor, params.note],
  );
  // `DO NOTHING` returns no row for the conflict case, which is precisely the
  // no-op this boolean reports. No CTE is needed here (unlike the Slack
  // exclusion verb) because there is no partial state — a row either exists or
  // it does not, and re-enrolling has nothing to update.
  return rows.length > 0;
}

/**
 * Un-enroll one pair — a hard DELETE, and nothing else.
 *
 * Returns whether a row was removed. `false` means the pair was not enrolled,
 * which is a no-op rather than an error: the caller's intent ("this pair is
 * outside the producer's reach") already holds.
 *
 * ⚠️ **This statement touches `brain_enrollment` and only `brain_enrollment`.**
 * It does not stamp `valid_to`, does not change `status`, and does not narrow
 * `visible_to` on any fact the producer already emitted and a human already
 * published. That is not an oversight to be tidied later — see the module
 * header. If a future change gives un-enrolment a second statement, the thing it
 * is reaching for is the review gate, and the review gate belongs to a person.
 */
export async function unenrollPair(params: {
  readonly workspaceId: string;
  readonly entity: string;
  readonly dimension: string;
}): Promise<boolean> {
  const pair = normalizeEnrollmentPair(params.entity, params.dimension);
  const rows = await internalQuery<{ entity: string }>(
    `DELETE FROM brain_enrollment
      WHERE workspace_id = $1 AND entity = $2 AND dimension = $3
      RETURNING entity`,
    [params.workspaceId, pair.entity, pair.dimension],
  );
  return rows.length > 0;
}
