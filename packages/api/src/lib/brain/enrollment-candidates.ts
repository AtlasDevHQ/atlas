/**
 * What an admin can enroll — the semantic layer read behind the enrollment
 * surface (#5196, ADR-0039).
 *
 * ## Why the surface picks from a list instead of taking free text
 *
 * ADR-0039's rejected-alternative test is *"whether a person chose the members,
 * not whether a person clicked something"* — and choosing requires a set to
 * choose from. This module is that set. It also closes the quieter failure: a
 * hand-typed `Status` against a warehouse column named `status` enrolls a pair
 * the producer looks up and never finds, so the enrollment sits in the list
 * looking live and reaches nothing. `brain_enrollment` preserves case
 * deliberately (a warehouse may hold both spellings as different columns), which
 * makes the picker the thing that stops the typo rather than a fold.
 *
 * ## This module ENUMERATES; it never enrolls
 *
 * The distance between the two is the ADR. A candidate list is availability —
 * *"the Atlas can see this"* — and it may be computed automatically, on every
 * page load, from whatever the semantic layer currently holds. Turning any of it
 * into an enrollment is the authority arm (ADR-0040) and takes a person. So
 * nothing here writes, and `__tests__/enrollment-writers.test.ts` is what keeps
 * that true as this file grows.
 *
 * ## Published, not developer
 *
 * The producer reads what is live. An entity a human is mid-editing in developer
 * mode is not something the Atlas should be enrolling claims against, and
 * offering its draft dimensions would let a pair be enrolled that disappears
 * when the draft is discarded.
 */

import type { BrainEnrollmentCandidateKind } from "@useatlas/types";
import { createLogger } from "@atlas/api/lib/logger";
import { listAdminEntities, getAdminEntity } from "@atlas/api/lib/semantic/admin-source";

const log = createLogger("brain.enrollment-candidates");

/** One thing the producer could emit for, if a human enrolled it. */
export interface EnrollmentCandidate {
  readonly name: string;
  /**
   * Where the name came from in the entity YAML. ADR-0037 §4's emission contract
   * covers *"the bare dimension name, measure name, or metric id"*, so both
   * belong on this list — but they are labelled rather than merged, because a
   * measure is an aggregate over rows and a dimension is a per-row value, and an
   * admin deciding what the Atlas should hold claims about needs to know which
   * one they are looking at.
   */
  readonly kind: BrainEnrollmentCandidateKind;
  readonly type: string | null;
  readonly description: string | null;
}

/** One enrollable entity, as the picker lists it. */
export interface EnrollmentCandidateEntity {
  readonly name: string;
  /**
   * The connection group it is published under, or `null` for the flat scope
   * (#5286).
   *
   * ⚠️ **Part of the OPTION's identity, not a decoration on it.** A
   * multi-connection-group workspace holds one entity NAME in several groups and
   * `listAdminEntities` returns a row per group — two DIFFERENT entities, over
   * two different databases, that happen to share a label. Offered without this
   * field they were one choice, and whichever the admin meant, the enrollment
   * could not record it.
   */
  readonly group: string | null;
  readonly table: string;
  readonly description: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * Pull named entries out of one of the entity YAML's two accepted shapes.
 *
 * `dimensions` and `measures` are each either an array of objects carrying their
 * own `name`, or a name-keyed map — `okf/export.ts` normalizes the same pair for
 * the same reason. An entry that carries neither form of name is DROPPED rather
 * than given a placeholder: an unnamed candidate cannot be enrolled (the pair is
 * the key), so listing one would offer a choice that fails on click.
 */
function namedEntries(raw: unknown, kind: EnrollmentCandidate["kind"]): EnrollmentCandidate[] {
  const out: EnrollmentCandidate[] = [];
  const push = (name: string, entry: Record<string, unknown>) => {
    if (name === "") return;
    out.push({
      name,
      kind,
      type: asString(entry.type),
      description: asString(entry.description),
    });
  };
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (isRecord(entry) && typeof entry.name === "string") push(entry.name, entry);
    }
  } else if (isRecord(raw)) {
    for (const [name, entry] of Object.entries(raw)) {
      if (isRecord(entry)) push(name, entry);
    }
  }
  return out;
}

/**
 * Every entity a human could enroll a pair from.
 *
 * Errors PROPAGATE. `listAdminEntities` already refuses to let a DB outage
 * masquerade as an empty workspace, and this surface needs that guarantee more
 * than most: an empty candidate list and a failed read render identically, and
 * the second one silently tells an admin their warehouse has nothing worth
 * enrolling.
 */
export async function loadEnrollableEntities(
  orgId: string,
): Promise<readonly EnrollmentCandidateEntity[]> {
  const { entities, warnings } = await listAdminEntities({ orgId, mode: "published" });
  if (warnings.length > 0) {
    // LOGGED rather than destructured away. On the DB path these are always
    // empty and the per-row drops log themselves; on a pure-YAML self-hosted
    // deploy `discoverEntities`' warnings are the ONLY record that an entity was
    // skipped, and this is where they would die. The symptom without them is a
    // picker quietly missing entities with nothing anywhere to explain it.
    log.warn(
      { orgId, warnings },
      "Enrollment candidates: semantic-layer entries were skipped, so the picker offers fewer entities than the workspace authored",
    );
  }
  // ⚠️ **NOT de-duplicated on name, and removing that collapse is the fix
  // (#5286).**
  //
  // This function used to collapse a multi-group workspace's same-named entities
  // to one option, and the comment here argued the collapse was the honest shape
  // *"because the pair this surface stores is `(workspace_id, entity, dimension)`
  // with NO group column, so the duplicates are not a distinction the storage
  // could record even if they picked one."* That premise was true and is now
  // false: migration 0205 put the group in the key.
  //
  // What the collapse actually produced was the failure this whole surface
  // exists to prevent. `test_orders` published under three groups was ONE
  // option; enrolling it wrote a row that stored cleanly, named no group, and
  // the producer refused it on every run afterwards — a live staging workspace
  // whose only producible entity could not be produced.
  //
  // Each row is its own option now, carrying its group, and the pair a click
  // writes names exactly one of them. Duplicate React keys go with it: the
  // option's identity is `(name, group)`, which is `admin-source.ts`'s own dedup
  // key for the same rows.
  //
  // ⚠️ **ONE row is still withheld, and it is the one the producer cannot
  // address: a FLAT-SCOPED row whose name another row also carries.** Offering it
  // would be offering a choice that refuses on every run, which is the shape this
  // module exists to prevent — so the honest surface is not to offer it.
  //
  // The reason it cannot be addressed is that `null` is doing two jobs in the
  // stored column, and only one of them is separable. It means *"the flat
  // scope"* for a workspace that groups nothing, and it means *"this enrollment
  // predates the group column"* for a row migration 0205 could not resolve. Where
  // a name has BOTH a flat row and a grouped one, those two readings pick
  // different databases — so `mapEntitiesToConnectionIds` refuses
  // `ambiguous-group` rather than guess, and it is right to: the alternative is
  // producing claims from the `__global__` demo database into a customer's brain,
  // which is #5284 by another route.
  //
  // The flat row in that situation is essentially always a `__global__` demo
  // entity the workspace has shadowed with its own — `listEntityRows` reads
  // `org_id = $1 OR org_id = '__global__'` — so what is withheld is the demo
  // copy, and the workspace's own grouped entity stays offered beside it. A
  // workspace that genuinely groups nothing has no second row for the name and
  // loses nothing.
  const sharedNames = new Set(
    entities
      .filter((e) => entities.some((other) => other.name === e.name && other !== e))
      .map((e) => e.name),
  );
  return entities
    .filter((e) => e.connectionId !== null || !sharedNames.has(e.name))
    .map((e) => ({
      name: e.name,
      group: e.connectionId,
      table: e.table,
      description: e.description === "" ? null : e.description,
    }));
}

/**
 * The dimensions and measures of one entity.
 *
 * `null` when the entity does not exist in this workspace's published semantic
 * layer — distinct from an entity that exists and declares nothing, which
 * returns `[]`. The route turns the first into a 404 and renders the second as
 * an honest empty list, because *"we have never heard of that entity"* and
 * *"that entity has no columns you could enroll"* are different answers and only
 * one of them is a mistake the admin made.
 */
export async function loadEnrollableDimensions(
  orgId: string,
  entityName: string,
  /**
   * Which of the name's groups to read, or `null` for the flat scope (#5286).
   *
   * ⚠️ **Passing it is what stops this throwing.** `getAdminEntity` refuses a
   * stem-only lookup spanning more than one group — `AmbiguousEntityError`,
   * which the route used to answer as a 409 saying the choice could not be
   * expressed. It can be expressed now, so the caller states it and the lookup
   * resolves.
   *
   * `undefined` is deliberately still reachable and still means the old
   * unique-or-409 path. It is what a pre-0205 flat-scoped enrollment is re-read
   * under: such a row carries no group, and scoping it to `null` would restrict
   * to the legacy null-group rows rather than to whatever single group its
   * workspace actually has.
   */
  connectionGroupId?: string | null,
): Promise<readonly EnrollmentCandidate[] | null> {
  const detail = await getAdminEntity({
    name: entityName,
    orgId,
    mode: "published",
    ...(connectionGroupId !== undefined ? { connectionGroupId } : {}),
  });
  if (detail === null) return null;
  const raw = detail.entity as Record<string, unknown>;
  const candidates = [
    ...namedEntries(raw.dimensions, "dimension"),
    ...namedEntries(raw.measures, "measure"),
  ];
  // Sorted by name so the picker's order does not depend on YAML authoring
  // order, and de-duplicated on name: a dimension and a measure sharing one name
  // are ONE enrollable pair, because the pair is `(entity, name)` and the
  // producer emits the bare name. Listing both would offer the same enrollment
  // twice and make the second click a silent no-op.
  const seen = new Set<string>();
  return candidates
    .filter((c) => (seen.has(c.name) ? false : (seen.add(c.name), true)))
    .toSorted((a, b) => a.name.localeCompare(b.name));
}
