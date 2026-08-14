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
 */
export const ENROLLMENT_NAME_MAX = 200;

/** Thrown by {@link normalizeEnrollmentPair}; the route maps it to a 400. */
export class InvalidEnrollmentPairError extends Error {
  override readonly name = "InvalidEnrollmentPairError";
}

/** One `(entity, dimension)` pair — the unit of the producer's reach. */
export interface EnrolledPair {
  readonly entity: string;
  readonly dimension: string;
}

/** An enrollment as the admin surface sees it. */
export interface EnrollmentRow extends EnrolledPair {
  readonly enrolledAt: string;
  readonly enrolledBy: string;
  readonly note: string | null;
}

/**
 * Trim and validate a caller-supplied pair.
 *
 * ONE normalizer for both verbs and the region import, so "enroll validates but
 * un-enroll doesn't" cannot recur. The verbs are asymmetric in consequence —
 * enrolling WIDENS the producer's reach — but a garbage id on the narrowing verb
 * answering `changed: false` instead of a 400 tells an admin their un-enrolment
 * took effect when it matched nothing.
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
  has(entity: string, dimension: string): boolean;
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

interface EnrollmentDbRow {
  readonly entity: string;
  readonly dimension: string;
  readonly enrolled_at: Date | string;
  readonly enrolled_by: string;
  readonly note: string | null;
  // `internalQuery`'s row parameter is bounded by `Record<string, unknown>`, and
  // a closed interface does not satisfy it. Declared rather than reaching for
  // `Record<string, unknown>` outright, so the five columns above stay typed.
  readonly [key: string]: unknown;
}

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
  const pairs: EnrolledPair[] = rows.map((r) => ({ entity: r.entity, dimension: r.dimension }));
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
    throw new InvalidEnrollmentPairError("An enrollment must record who made it.");
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
