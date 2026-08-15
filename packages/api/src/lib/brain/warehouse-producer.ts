/**
 * The **tier-1 warehouse fact producer** (#5042, ADR-0037 §4, ADR-0039).
 *
 * The component ADR-0037 spent four slices designing protections for. Until this
 * module existed, "warehouse-wins" did nothing mechanical, `subject_cmp` was
 * permanently NULL, and the tier guard inside `supersessionCollisionJoin` had no
 * row it could ever hold back. ADR-0037 states that dormancy as its own
 * uncomfortable half; this is the half that wakes it up.
 *
 * ## Its reach is the enrollment set, and it may never widen it
 *
 * ADR-0039: *a human enrolls `(entity, dimension)` pairs, and the producer emits
 * for those and only those.* There is no sweep mode and no discovery step —
 * {@link runWarehouseProducer} reads {@link loadProducerReach} and every pair it
 * emits for came out of that read. `__tests__/enrollment-writers.test.ts` is what
 * keeps this module out of the WRITE half of that table; nothing here inserts a
 * pair, and nothing here may.
 *
 * The arithmetic behind the rule is not taste. Every fact lands `draft` needing a
 * human publish (`reconcile.ts:777`, where migration 0180's default *is* the
 * review gate), so an unenrolled sweep puts an unreviewable queue behind the one
 * gate the product is differentiated by.
 *
 * ## What it emits — the contract, decided by ADR-0037 §4 and not by this file
 *
 *   - **The BARE dimension name** as the predicate. Never `plans.price`, never
 *     `analytics.plans.price`. Entity and connection-group qualification rides in
 *     `provenance.detail` as NON-LOAD-BEARING context: a qualified surface can
 *     never lexically match anything an LLM emits, so qualifying the predicate
 *     would make day-one cross-tier collision count exactly zero — the collision
 *     the whole of M4 was built to arbitrate.
 *   - **Fail-closed on ambiguity.** {@link planWarehouseEmission} refuses a
 *     dimension name that is enrolled on two entities at once. See there for why
 *     the refusal covers BOTH pairs rather than picking one.
 *   - **`single` cardinality, declared structurally.** A dimension of one row
 *     holds one value BY CONSTRUCTION (ADR-0037 §3(d)1), which is why
 *     `warehouse_structural` is one of only three source classes that may put
 *     `single` in the vocabulary. It still only ever PROPOSES — see
 *     {@link proposePredicateCardinalityForSurface}.
 *   - **`subject_cmp`, which no other producer can supply.** The subject is a
 *     warehouse row identified by a primary key, so the producer can hand the
 *     reconcile seam a stable id for it. The extractor never can, for any
 *     subject, ever (ADR-0037 §5).
 *   - **No reserved roots.** A warehouse norm is an ordinary surface and may
 *     itself be aliased away; nothing here special-cases a key by its origin.
 *
 * ## Re-emission is tension-only, and this module adds no mechanism for it
 *
 * A re-run over a changed value mints a fresh draft and — once a human publishes
 * it beside its predecessor — an advisory `in-tension-with` edge. It does NOT
 * stamp `valid_to` on the snapshot it replaces: #5033's tier guard is symmetric,
 * so warehouse↔warehouse supersession is held back exactly as cross-tier is, and
 * a machine invalidating a fact is forbidden outright (#4759 §2). That is
 * ADR-0037 §4's recorded Fog rather than a gap, and #5042's old *"resolve before
 * building"* blocker was retired on those terms. **Do not add a mechanism for
 * it.** `__tests__/warehouse-producer-pg.test.ts` pins both halves against real
 * Postgres.
 *
 * ## What this module is NOT
 *
 * Not the enrollment surface (#5196 — `enrollment.ts`, `admin-brain-enrollment.ts`).
 * It also FEEDS the entity store (#5043) — it builds entries, writes them inside
 * each entity's transaction, and runs the edge pass. The ids below identify a
 * warehouse ROW and reach the two `_cmp` columns and `brain_entity.entity_id`;
 * never a key, a surface column or a join arm. (This line used to say "not the
 * entity store" and "`subject_cmp` and nothing else". Building the store
 * falsified both.)
 * Not a scheduler: the only trigger that ships with it is the operator-initiated
 * `POST /api/v1/admin/brain-enrollment/produce`. A cadence is a second trigger
 * with its own enablement, cadence and audit questions, on the precedent
 * `alias-proposal.ts` sets for exactly the same deferral.
 */

import { createHash } from "node:crypto";
import { BRAIN_WAREHOUSE_REFUSAL_REASONS } from "@useatlas/schemas";
import { createLogger } from "@atlas/api/lib/logger";
import { ORG_PRINCIPAL } from "@atlas/api/lib/brain/acl";
import {
  proposePredicateCardinalityForSurface,
  type CardinalityProposerClass,
} from "@atlas/api/lib/brain/cardinality";
import { loadProducerReach, type ProducerReach } from "@atlas/api/lib/brain/enrollment";
import {
  buildEntityEntry,
  entityEdgeProposals,
  writeEntityEntries,
  ENTITY_EDGE_PRODUCER,
  type EntityStoreEntry,
  type StoredEntity,
} from "@atlas/api/lib/brain/entity-store";
import type {
  AliasProducerCounters,
  AliasProposalInput,
} from "@atlas/api/lib/brain/vocabulary-decide";
import type { ClaimVocabulary } from "@atlas/api/lib/brain/identity";
import {
  reconcileFacts,
  withBrainTransaction,
  type EntityResolver,
  type FactCandidate,
  type ReconcileExecutor,
  type ReconcileTransactionRunner,
} from "@atlas/api/lib/brain/reconcile";
import { WAREHOUSE_SOURCE } from "@atlas/api/lib/brain/sources";

const log = createLogger("brain.warehouse-producer");

/**
 * The producer's own contract broke — a statement and its reader disagree.
 *
 * ⚠️ Its own class because the per-entity `catch` that turns a transaction failure
 * into a refusal would otherwise SWALLOW it. A database failure is an operational
 * event and refusing that entity is right; a `RETURNING` clause the reader cannot
 * parse is a DEFECT, and turning it into a per-entity refusal would make every
 * entity of every run refuse quietly, forever, on a producer that looks merely
 * unlucky. It is the one error that catch RE-THROWS; reach and vocabulary failures
 * propagate too, from outside the loop.
 */
export class WarehouseProducerContractError extends Error {
  override readonly name = "WarehouseProducerContractError";
}

/**
 * The `producer` label stamped into every fact's provenance.
 *
 * Versioned like `extraction:v1` rather than bare, because the emission contract
 * above is the thing a reviewer is trusting and a later change to it has to be
 * distinguishable at rest. A corpus written under two contracts with one label is
 * a corpus nobody can re-derive.
 */
export const WAREHOUSE_PRODUCER = "warehouse:v1";

/**
 * The principal every warehouse claim is attributed to.
 *
 * A SYSTEM principal, not the operator who pressed the button, and the choice is
 * deliberate rather than lazy. `reconcile.ts` blocks a candidate outright when
 * neither the caller nor the episode yields a principal, so something has to be
 * passed; the honest answer is the machine, because the machine is what read the
 * warehouse. The human's authority was spent at ENROLLMENT and is recorded there
 * (`brain_enrollment.enrolled_by`) — attributing the rows to whoever triggered a
 * run would relocate that authority to a button press, and would make the same
 * claim look human-authored the day a cadence trigger presses it instead.
 *
 * Who triggered a given run still travels: {@link WarehouseRunContext.triggeredBy}
 * lands in `provenance.detail`, where it is context rather than authority.
 */
export const WAREHOUSE_PRODUCER_PRINCIPAL = "system:warehouse-producer";

/**
 * The most rows one entity may contribute to one run.
 *
 * ⚠️ **Exceeding it REFUSES the entity; it never truncates.** A truncated
 * snapshot is an arbitrary subset of a warehouse presented as a complete reading
 * of it, and nothing at rest distinguishes the two — a reviewer would publish
 * three hundred account statuses believing they had seen the accounts.
 *
 * The bound exists because enrollment bounds DIMENSIONS and not ROWS, which
 * ADR-0039's arithmetic quietly assumes away: *"ten thousand accounts across
 * eight enrolled dimensions is eighty thousand drafts"* is an argument against
 * the eight, and ten thousand drafts from the one remaining dimension is still a
 * queue no person drains. The review gate is the constraint, so the bound is
 * expressed in units of review rather than of database load.
 *
 * A constant rather than a setting on purpose. Raising it is a claim about how
 * much a human can review, which is the decision ADR-0039 exists to protect —
 * `feedback: env vars are a last resort` applies with extra force where the knob
 * would loosen the product's differentiating gate.
 */
export const WAREHOUSE_ROW_CAP = 1_000;

/**
 * The source class {@link proposePredicateCardinalityForSurface} is called with.
 *
 * ⚠️ The LITERAL, not `CARDINALITY_SOURCE_CLASSES[0]`. That tuple is documented as
 * being *"in the order the ADR names them"* — an ordering kept for readability and
 * therefore one nobody is forbidden from changing. Reordering `correction_event`
 * to the front compiles clean (`CardinalityProposerClass` only excludes `human`)
 * and silently stamps every warehouse proposal with the wrong `source_class`, which
 * is the field a reviewer reads to judge how much authority the row has. `satisfies`
 * keeps the membership check without the positional coupling.
 */
const WAREHOUSE_CARDINALITY_SOURCE = "warehouse_structural" satisfies CardinalityProposerClass;

// ---------------------------------------------------------------------------
// The semantic-layer shape this producer needs
// ---------------------------------------------------------------------------

/** One dimension of an entity, narrowed from the entity YAML. */
export interface WarehouseDimension {
  readonly name: string;
  /** The column expression. `sql:` when the YAML sets one, else the name. */
  readonly sql: string;
  readonly primaryKey: boolean;
}

/**
 * An enrolled entity as this producer reads it.
 *
 * A narrowing of the entity YAML rather than a re-use of `AdminEntityDetail`:
 * this module needs four fields and needs them typed, and the detail type hands
 * back an open `EntityShapeT` whose `dimensions` is `unknown` to a reader.
 *
 * `measures` is a NAME SET and not a shape. A measure is an aggregate over rows
 * where every emission below is per-row, so the producer cannot emit one — but it
 * has to be able to tell *"that is a measure, and this slice does not emit
 * measures"* apart from *"there is no such dimension"*. The enrollment surface
 * offers both (`enrollment-candidates.ts`), so an admin can and will enroll one,
 * and a refusal naming the real reason is the difference between a gap and a bug
 * report.
 */
export interface WarehouseEntity {
  readonly name: string;
  readonly table: string;
  /** The YAML `connection:` group, or `null` for the default group. */
  readonly connection: string | null;
  readonly dimensions: readonly WarehouseDimension[];
  readonly measures: ReadonlySet<string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Pull the named entries out of one of the entity YAML's two accepted shapes.
 *
 * `dimensions` and `measures` are each either an array of objects carrying their
 * own `name`, or a name-keyed map — `enrollment-candidates.ts` normalizes the
 * same pair for the same reason, and the two modules MUST agree: the surface
 * offers what the first one enumerates and the producer emits what this one
 * finds, so a shape one reads and the other does not is an enrollment that looks
 * live and reaches nothing.
 */
function namedEntries(raw: unknown): { name: string; entry: Record<string, unknown> }[] {
  const out: { name: string; entry: Record<string, unknown> }[] = [];
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (!isRecord(entry)) continue;
      const name = nonEmptyString(entry.name);
      if (name !== null) out.push({ name, entry });
    }
  } else if (isRecord(raw)) {
    for (const [key, entry] of Object.entries(raw)) {
      const name = nonEmptyString(key);
      if (name !== null && isRecord(entry)) out.push({ name, entry });
    }
  }
  return out;
}

/**
 * What one enrolled name resolved to.
 *
 * THREE arms, not two, and the third is the one this type exists for. An entity
 * that is published and still unreadable — its name resolves in more than one
 * connection group, or its YAML declares no `table:` — is not
 * `entity-not-published`, and reporting it as such hands the admin the remedy
 * *"publish the entity"* for an entity that is already published. They publish it
 * again, nothing changes, and the actual defect is never named. That is the same
 * distinction this module already insists on between `measure-not-per-row` and
 * `dimension-not-found`.
 */
export type WarehouseEntityLookup =
  | { readonly kind: "found"; readonly entity: WarehouseEntity }
  | { readonly kind: "not-published" }
  /**
   * `cause` beside `why`, and the split earns its two lines. `why` is the sentence
   * the operator reads; `cause` is what the plan, a test, and any future consumer
   * branch on — without it, asserting WHICH cause fired means matching prose, and
   * the refusal could not withhold the driver's text on one arm while keeping it on
   * the other.
   */
  | {
      readonly kind: "unreadable";
      readonly cause: "load-threw" | "no-table";
      readonly why: string;
    };

/**
 * Narrow one entity's YAML to {@link WarehouseEntity}, or `null` when it carries
 * no usable table.
 *
 * The `table` guard is not defensive padding: `getAdminEntity` validates the
 * field through `EntityShape` on the DB path, but this module also has to be
 * callable with a YAML record read from disk, and a table-less entity would build
 * a `FROM` clause out of `undefined`.
 */
export function parseWarehouseEntity(
  name: string,
  raw: Record<string, unknown>,
): WarehouseEntity | null {
  const table = nonEmptyString(raw.table);
  if (table === null) return null;
  const dimensions = namedEntries(raw.dimensions).map(({ name: dimName, entry }) => ({
    name: dimName,
    // The YAML's `sql:` is the column EXPRESSION and the name is only its label;
    // falling back to the name is what the profiler's own output makes correct
    // (it writes `sql: id` beside `name: id`), and a dimension that omits both
    // was already dropped by `namedEntries`.
    sql: nonEmptyString(entry.sql) ?? dimName,
    primaryKey: entry.primary_key === true,
  }));
  return {
    name,
    table,
    connection: nonEmptyString(raw.connection),
    dimensions,
    measures: new Set(namedEntries(raw.measures).map((m) => m.name)),
  };
}

// ---------------------------------------------------------------------------
// The plan — pure, and where the fail-closed rule lives
// ---------------------------------------------------------------------------

/**
 * Why one enrolled pair produced nothing.
 *
 * Every arm is a REFUSAL that reaches the caller, never a silent drop. The
 * distinction matters more here than usual: an enrolled pair that emits nothing
 * and an enrolled pair the producer refused look identical in `brain_facts` — the
 * absence of a row — and only one of them is something an admin can fix.
 *
 * DERIVED from `@useatlas/schemas`'s tuple rather than spelled here, so the wire
 * enum the run report is parsed through and the arms this module produces cannot
 * drift. That tuple carries the per-arm documentation; the dependency runs
 * `lib/` → `@useatlas/schemas`, which is the permitted direction and the one
 * `ENROLLMENT_NAME_MAX` already takes.
 */
export type WarehouseRefusalReason = (typeof BRAIN_WAREHOUSE_REFUSAL_REASONS)[number];

export interface WarehouseRefusal {
  readonly entity: string;
  readonly dimension: string;
  readonly reason: WarehouseRefusalReason;
  /** Operator-facing, and it names what to do rather than what went wrong. */
  readonly message: string;
}

/** One entity's producible pairs, with the column that identifies its rows. */
export interface WarehouseEntityPlan {
  readonly entity: WarehouseEntity;
  readonly primaryKey: WarehouseDimension;
  /**
   * NON-EMPTY, and the tuple says so.
   *
   * `readonly WarehouseDimension[]` admits `[]`, which builds
   * `SELECT pk AS … FROM t LIMIT 1001` — a real read against a customer warehouse
   * that can produce no claim. {@link planWarehouseEmission} never mints one (a
   * bucket is created with its first dimension already in hand), so this costs
   * nothing today; it is written down because the type is EXPORTED and
   * {@link buildSnapshotSql} interpolates its members into SQL.
   */
  readonly dimensions: readonly [WarehouseDimension, ...WarehouseDimension[]];
  /**
   * An INDEX into {@link dimensions} naming this entity's canonical surface, or
   * `null` (#5043, ADR-0037 §5).
   *
   * ⚠️ **An index rather than the `WarehouseDimension` itself, and the change is
   * a guard rather than a tidy-up** (#5232's review). As an object it was
   * resolved back to a position with `dimensions.indexOf(…)`, which is REFERENCE
   * equality — so any path that clones or round-trips a plan (a fixture builder,
   * a structured clone, JSON) yields `-1` while `dimensions` visibly contains the
   * dimension, and every row then lands in `unnamedRows`: the counter whose whole
   * job is to keep "nobody named a surface" apart from "the surface column is
   * empty" reports a third thing as the second. An index cannot disagree with the
   * list it indexes, and the lookup leaves the per-row loop.
   *
   * In-range by construction: {@link planWarehouseEmission} takes it from
   * `findIndex` over the same array it returns.
   *
   * `null` is the ordinary case — nobody named this entity, so the store holds
   * nothing for it, which is ADR-0039's bound inherited rather than a failure.
   * A naming dimension the plan REFUSED also lands `null`, and that one is
   * reported as a `naming-dimension-refused` refusal rather than left silent.
   */
  readonly namingDimensionIndex: number | null;
}

export interface WarehousePlan {
  readonly emit: readonly WarehouseEntityPlan[];
  readonly refused: readonly WarehouseRefusal[];
}

function refusal(
  entity: string,
  dimension: string,
  reason: WarehouseRefusalReason,
  message: string,
): WarehouseRefusal {
  return { entity, dimension, reason, message };
}

/**
 * Turn a reach plus the semantic layer into what the producer will and will not
 * emit. **Pure — it reads no database and runs no query.**
 *
 * ## The order of the two filters is the fail-closed rule's whole meaning
 *
 * ADR-0037 §4 refuses a dimension name *"ambiguous across the entities it is
 * producing from"*, so ambiguity is computed over the pairs that SURVIVE the
 * structural checks, never over the raw enrollment list. A `status` enrolled on
 * `accounts` and on a `contracts` that was deleted from the semantic layer is not
 * ambiguous — the producer is not producing from `contracts` — and treating it as
 * ambiguous would silently switch off a working enrollment because of a stale one
 * beside it.
 *
 * ## Both pairs are refused, not one
 *
 * `Acme Corp / status / active` from `accounts` and `Acme Corp / status / signed`
 * from `contracts` key to the same slot and read as `different`, which is the
 * irreversible direction. Picking a winner needs a rule (first enrolled? most
 * rows? alphabetical?) and every such rule is a machine deciding which of two
 * human enrollments meant what it says. A missing warehouse fact is recoverable;
 * a wrong `valid_to` stamp is not — so both sides refuse and the refusal names
 * the other entity, which is the one thing that makes it fixable by the person
 * who caused it.
 *
 * ⚠️ The comparison is on the BARE name and is case-sensitive, exactly as
 * `brain_enrollment` stores it. Folding case here would call `status` and
 * `Status` one predicate, which is a claim about the workspace's warehouse this
 * function has no evidence for — the enrollment surface preserves case precisely
 * because a warehouse may hold both columns.
 */
export function planWarehouseEmission(
  reach: ProducerReach,
  entities: ReadonlyMap<string, WarehouseEntityLookup>,
): WarehousePlan {
  const refused: WarehouseRefusal[] = [];
  /** Structurally producible pairs, before the ambiguity pass. */
  const producible: { plan: WarehouseEntity; pk: WarehouseDimension; dim: WarehouseDimension }[] =
    [];

  for (const pair of reach.pairs) {
    const lookup = entities.get(pair.entity) ?? { kind: "not-published" as const };
    if (lookup.kind === "not-published") {
      refused.push(
        refusal(
          pair.entity,
          pair.dimension,
          "entity-not-published",
          `"${pair.entity}" is enrolled but is not in this workspace's published semantic layer. ` +
            "Publish the entity, or un-enroll the pair — the producer reads what is live.",
        ),
      );
      continue;
    }
    if (lookup.kind === "unreadable") {
      // ⚠️ NOT `entity-not-published`. This entity IS published; telling the admin
      // to publish it is advice they can follow forever without anything changing.
      refused.push(
        refusal(
          pair.entity,
          pair.dimension,
          "entity-unreadable",
          `"${pair.entity}" is published but could not be read: ${lookup.why}`,
        ),
      );
      continue;
    }
    const entity = lookup.entity;
    const primaryKeys = entity.dimensions.filter((d) => d.primaryKey);
    if (primaryKeys.length === 0) {
      refused.push(
        refusal(
          pair.entity,
          pair.dimension,
          "no-primary-key",
          `"${pair.entity}" declares no primary-key dimension, so nothing identifies one of its rows. ` +
            "A claim needs a subject, and a subject the producer guessed would be a homonym — which " +
            "widens grants at the review gate rather than merely mislabelling a row.",
        ),
      );
      continue;
    }
    if (primaryKeys.length > 1) {
      refused.push(
        refusal(
          pair.entity,
          pair.dimension,
          "composite-primary-key",
          `"${pair.entity}" declares ${primaryKeys.length} primary-key dimensions, so no single column ` +
            "identifies a row. One column of a composite key names a GROUP of rows, and a claim about a " +
            "group written as a claim about a row is the same homonym by another route.",
        ),
      );
      continue;
    }
    const dimension = entity.dimensions.find((d) => d.name === pair.dimension);
    if (dimension === undefined) {
      const isMeasure = entity.measures.has(pair.dimension);
      refused.push(
        refusal(
          pair.entity,
          pair.dimension,
          isMeasure ? "measure-not-per-row" : "dimension-not-found",
          isMeasure
            ? `"${pair.dimension}" is a MEASURE of "${pair.entity}" — an aggregate over rows. Every claim ` +
              "this producer emits is about one row identified by its primary key, so there is no subject " +
              "an aggregate could be attached to. Measure emission is not in this slice; the enrollment " +
              "stays and produces nothing until it is."
            : `"${pair.dimension}" is not a dimension of "${pair.entity}" in the published semantic layer. ` +
              "Names are case-sensitive, because a warehouse may hold two columns that differ only in case.",
        ),
      );
      continue;
    }
    // Destructured rather than `primaryKeys[0]!` — both `length === 0` and
    // `length > 1` refused above, so the assertion was provably safe, and this
    // costs nothing while keeping the file's non-null-assertion count at zero.
    const [primaryKey] = primaryKeys;
    if (primaryKey === undefined) continue;
    producible.push({ plan: entity, pk: primaryKey, dim: dimension });
  }

  // The ambiguity pass, over the producible set and nothing else.
  const entitiesByDimension = new Map<string, Set<string>>();
  for (const item of producible) {
    let owners = entitiesByDimension.get(item.dim.name);
    if (owners === undefined) {
      owners = new Set<string>();
      entitiesByDimension.set(item.dim.name, owners);
    }
    owners.add(item.plan.name);
  }

  const byEntity = new Map<
    string,
    {
      entity: WarehouseEntity;
      pk: WarehouseDimension;
      // The non-empty tuple `WarehouseEntityPlan.dimensions` declares, built here
      // rather than asserted at the `return` — a bucket is only ever created with
      // its first dimension already in hand, which is what makes the tuple true by
      // construction instead of by cast.
      dims: [WarehouseDimension, ...WarehouseDimension[]];
    }
  >();
  for (const item of producible) {
    const owners = entitiesByDimension.get(item.dim.name);
    if (owners !== undefined && owners.size > 1) {
      const others = [...owners].filter((name) => name !== item.plan.name).toSorted();
      refused.push(
        refusal(
          item.plan.name,
          item.dim.name,
          "ambiguous-dimension",
          `"${item.dim.name}" is enrolled on ${owners.size} entities at once (also ${others.join(", ")}). ` +
            "The producer emits the BARE dimension name, so both would key to one predicate and two rows " +
            "about the same subject would read as contradicting each other. Un-enroll it on all but one " +
            "entity — the producer refuses rather than choosing, because choosing wrongly stamps a " +
            "validity window nothing can restore.",
        ),
      );
      continue;
    }
    const bucket = byEntity.get(item.plan.name);
    if (bucket === undefined) {
      byEntity.set(item.plan.name, { entity: item.plan, pk: item.pk, dims: [item.dim] });
      continue;
    }
    bucket.dims.push(item.dim);
  }

  return {
    emit: [...byEntity.values()].map((bucket) => {
      // Resolved against the SURVIVING dimensions, not against the reach — a
      // naming dimension that was refused (not in the semantic layer, ambiguous
      // across two entities) is not in the snapshot's SELECT list, so treating
      // it as named would build an entity-store entry out of a column that was
      // never read. `undefined` there, `null` here: the plan says "this entity
      // has no canonical surface", and the store writes no entry for it.
      const named = reach.namingDimension.get(bucket.entity.name);
      const namingIndex = named === undefined ? -1 : bucket.dims.findIndex((d) => d.name === named);
      // ⚠️ **TWO different facts, and folding them into one `null` DESTROYED
      // DATA silently** (#5232's review). `named === undefined` is "nobody named
      // this entity" — ordinary, and the store simply holds nothing for it.
      // `named !== undefined && namingIndex === -1` is "a human DID name a
      // dimension and the plan refused it" — because it went ambiguous across
      // two entities, or left the semantic layer. Under one `null` the second
      // case produced no entries, and `writeEntityEntries`' unconditional DELETE
      // then removed every entry the entity already had, reporting
      // `entitiesStored: 0` — byte-identical to "never named", while the
      // enrollment surface still showed the badge.
      //
      // Clearing IS correct once the name is unreadable; being quiet about it is
      // not. So it becomes a refusal that reaches the caller, beside the
      // `ambiguous-dimension` row that caused it.
      if (named !== undefined && namingIndex === -1) {
        refused.push(
          refusal(
            bucket.entity.name,
            named,
            "naming-dimension-refused",
            `"${named}" is this entity's naming dimension and the producer refused it, so nothing ` +
              "readable names its rows. Its entity-store entries are cleared the next time this " +
              "entity is snapshotted successfully, after which claims about its rows match on the " +
              "warehouse key alone rather than on what people call them. The refusal for the pair " +
              "itself, beside this one, says why.",
          ),
        );
      }
      return {
        entity: bucket.entity,
        primaryKey: bucket.pk,
        dimensions: bucket.dims,
        namingDimensionIndex: namingIndex === -1 ? null : namingIndex,
      };
    }),
    refused,
  };
}

// ---------------------------------------------------------------------------
// The snapshot
// ---------------------------------------------------------------------------

/** The column alias the subject arrives under. */
export const SUBJECT_ALIAS = "atlas_brain_subject";

/** The per-dimension alias prefix — positional; see {@link buildSnapshotSql}. */
export const DIMENSION_ALIAS_PREFIX = "atlas_brain_d";

/**
 * One entity's snapshot query.
 *
 * ⚠️ **`LIMIT cap + 1`, and the extra row is the whole point.** `LIMIT cap` and a
 * result of exactly `cap` rows cannot be told apart from a warehouse that happens
 * to hold `cap` rows, so the producer would silently emit a truncated reading of
 * a table it could not see the end of. One row over the bound is the evidence
 * {@link WAREHOUSE_ROW_CAP} needs to refuse on.
 *
 * ⚠️ Column expressions are INTERPOLATED, because a dimension's `sql:` is an
 * expression rather than a value and no bind parameter can carry one. That is the
 * same trust boundary `runMetric` and the whitelist sit on — the semantic layer
 * is admin-authored — and it is why the shipped snapshot runner validates the
 * built string through `validateSQL` before it reaches a datasource, rather than
 * trusting that this function only ever concatenates safe things.
 *
 * The aliases are GENERATED (`atlas_brain_d0`, `atlas_brain_d1`, …) rather than
 * taken from the dimension names. A name is warehouse-controlled text that has to
 * survive quoting in three dialects, and reading a result back by its ordinal is
 * what makes the row parser independent of that.
 */
export function buildSnapshotSql(plan: WarehouseEntityPlan, rowCap = WAREHOUSE_ROW_CAP): string {
  const columns = [
    `${plan.primaryKey.sql} AS ${SUBJECT_ALIAS}`,
    ...plan.dimensions.map((dim, index) => `${dim.sql} AS ${DIMENSION_ALIAS_PREFIX}${index}`),
  ];
  return `SELECT ${columns.join(", ")} FROM ${plan.entity.table} LIMIT ${rowCap + 1}`;
}

/** What {@link WarehouseSnapshotRunner} is asked for. */
export interface WarehouseSnapshotRequest {
  readonly workspaceId: string;
  readonly entity: string;
  /** The connection the entity's group routes to; `undefined` is the default connection. */
  readonly connectionId: string | undefined;
  readonly sql: string;
}

/** Reads tier-1. The one seam in this module that touches a customer datasource. */
export type WarehouseSnapshotRunner = (
  request: WarehouseSnapshotRequest,
) => Promise<readonly Record<string, unknown>[]>;

/**
 * A warehouse cell as a claim surface, or `null` when it is not one.
 *
 * ⚠️ **The `default` arm ABSTAINS rather than stringifying.** A `jsonb` column, a
 * `bytea`, an array, a PostGIS point — `String(value)` turns each into
 * `[object Object]` or a byte dump, which lands as a claim surface, keys, and
 * sits in a reviewer's queue looking like a fact about their company. Refusing is
 * lossless in the direction that matters: nothing is invalidated, and the pair
 * simply produces no row for that cell.
 *
 * `Date` is canonicalized to ISO-8601 rather than left to `String`, which yields
 * `Mon Aug 04 2026 …` — a surface `object-cmp.ts` cannot parse, so the comparable
 * value the producer exists to supply would be `null` for every date column in
 * the warehouse.
 */
export function warehouseSurface(value: unknown): string | null {
  switch (typeof value) {
    case "string": {
      const trimmed = value.trim();
      if (trimmed === "") return null;
      // ⚠️ NUL is not whitespace, so it survives the trim — and Postgres refuses it
      // (22021), which aborts the whole entity's transaction rather than dropping one
      // cell. MySQL and ClickHouse `text` both admit it, so this is reachable for two
      // of the three supported dialects. It also silently breaks `ID_SEPARATOR`'s
      // uniqueness argument, which assumes no component can contain one.
      return trimmed.includes("\u0000") ? null : trimmed;
    }
    case "number":
      return Number.isFinite(value) ? String(value) : null;
    case "bigint":
    case "boolean":
      return String(value);
    default:
      if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
      return null;
  }
}

/**
 * Did this cell hold NOTHING, as opposed to something no claim can be made of?
 *
 * ⚠️ The two are the same `null` out of {@link warehouseSurface} and they are NOT
 * the same event, which is why this exists as a separate question rather than a
 * second return arm. A SQL `NULL` asserts nothing and is the ordinary case — a
 * column is empty for most rows and nobody should hear about it. A `jsonb`, a
 * `bytea`, an array or a `NaN` is an **enrollment mistake**: `GET /dimensions`
 * offers every dimension regardless of type, so an admin can enroll
 * `(accounts, metadata)` and get a run that reads nine hundred rows, emits nothing,
 * files no refusal and logs nothing at all — indistinguishable from a column that
 * happens to be empty, and re-runnable forever.
 *
 * Folded together, the module's own rule — *every arm is a REFUSAL that reaches
 * the caller, never a silent drop* — is false for the commonest way an enrollment
 * can be wrong.
 */
function isAbsentCell(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  // ⚠️ A NON-FINITE number and an Invalid Date are ordinary too. `NaN` out of a
  // `double precision` column is that column's null; `0000-00-00` out of MySQL is an
  // Invalid Date. The COLUMN is fine and one row is bad.
  if (typeof value === "number" && !Number.isFinite(value)) return true;
  if (value instanceof Date && Number.isNaN(value.getTime())) return true;
  // ⚠️ A BLANK STRING is absent, not unsurfaceable, and leaving it on the other
  // side reproduced the exact defect this split exists to remove — one layer in.
  // `''` and `'   '` are what a CSV or ETL load writes where a source system has a
  // NOT NULL text default, i.e. the ordinary empty cell by any reading; the
  // enumerated mistakes are a `jsonb`, a `bytea`, an array, a `NaN`. Counted as
  // mistakes, a perfectly benign column inflates `unsurfaceableCells` on every run
  // forever AND makes a real `jsonb` enrollment indistinguishable from it — while
  // the warn sends the operator hunting a `jsonb` column that need not exist.
  return typeof value === "string" && value.trim() === "";
}

/**
 * The component separator inside a row id's digest input.
 *
 * NUL, for `enrollment.ts`'s reason exactly: it is the one byte a Postgres `text`
 * value cannot hold, so no component can contain it and no pair of components can
 * be re-cut into another pair's. With a printable separator, entity `a` + key
 * `b:c` and entity `a:b` + key `c` hash identically — one id for two different
 * rows, which is the false `same` {@link warehouseRowId} exists to make
 * impossible.
 *
 * Written as an escape rather than the literal byte: a NUL in a source file makes
 * the whole file read as binary to `grep`, which silently removes it from every
 * repo-wide guard scan that greps for a pattern.
 */
const ID_SEPARATOR = "\u0000";

/**
 * The stable id for one warehouse row — what reaches `subject_cmp`.
 *
 * ⚠️ **Globally unique, which the resolver seam states as a contract clause
 * rather than an implementation note.** A workspace-scoped counter satisfies
 * "deterministic" and fails this: an id that collides across regions for two
 * DIFFERENT rows is a false `same` at the publish gate, i.e. two distinct
 * entities merged with no inverse. A digest over `(workspace, entity, primary
 * key)` cannot collide for two different rows and is identical for the same row
 * on every run, which is what makes a re-emission corroborate its predecessor
 * instead of contradicting it.
 *
 * NUL-separated — see {@link ID_SEPARATOR}.
 *
 * The id reaches the two `_cmp` columns and `brain_entity.entity_id` (#5043) —
 * never a slot key, a surface column or a join arm. An id at a slot would orphan the existing corpus the moment it
 * started answering (ADR-0037 §5), and that is the resolver seam's rule rather
 * than this function's.
 */
export function warehouseRowId(
  workspaceId: string,
  entity: string,
  primaryKey: string,
): WarehouseRowId {
  const digest = createHash("sha256")
    .update([workspaceId, entity, primaryKey].join(ID_SEPARATOR))
    .digest("hex");
  return `wh_${digest}` as WarehouseRowId;
}

/**
 * An id {@link warehouseRowId} minted — i.e. one the uniqueness argument above
 * actually applies to.
 *
 * ⚠️ **A brand, and it is the repo's own lesson rather than decoration.** The
 * resolver seam states global uniqueness as a CONTRACT CLAUSE (`reconcile.ts`'s
 * `ResolvedEntity`), warning that an id colliding across regions for two different
 * rows is *"a false `same` at the publish gate: two distinct entities merged, with
 * no inverse"*. With `subjectIds` typed `ReadonlyMap<string, string>`, the exported
 * {@link warehouseEntityResolver} accepts `new Map([["Acme Corp", "1"]])` — an
 * unbranded door straight onto `subject_cmp`, which is exactly how #5032's guard
 * was bypassed one column over once the parameter alone was branded.
 *
 * The brand terminates at `ResolvedEntity.entityId: string`; its job is not to
 * travel, it is to make this function the only thing that can build a value the
 * resolver will accept.
 */
export type WarehouseRowId = string & { readonly __warehouseRowId: unique symbol };

/**
 * The SHAPE {@link warehouseRowId} mints — `wh_` plus a sha256 in lowercase hex.
 *
 * Exported so the ONE other writer of `brain_entity` can check it. That writer
 * is the region importer, and until #5232's review it checked only
 * `typeof value === "string" && value !== ""` — so a bundle carrying
 * `entityId: "1"` validated, landed, was read back through a
 * `as WarehouseRowId` cast, and reached `subject_cmp`. That is verbatim the
 * `{ entityId: "1" }` the brand's own docstring says it exists to forbid,
 * arriving one layer down: the same shape as #5032's, which is why the brand
 * exists at all.
 */
export const WAREHOUSE_ROW_ID_PATTERN = /^wh_[0-9a-f]{64}$/;

/**
 * Narrow an untrusted string to a {@link WarehouseRowId} without a cast.
 *
 * ⚠️ **A SHAPE check, deliberately NOT a recomputation.** Re-deriving
 * `warehouseRowId(workspaceId, entity, keySurface)` and comparing would be
 * stronger against a hand-edited bundle — and it would REFUSE every legitimate
 * cross-region migration, because the digest is taken over the workspace id and
 * a bundle's destination org is not its source org — the roundtrip suite migrates
 * one org id into a different one, so recomputation fails there by construction. The shape is what can be checked at a boundary that legitimately
 * sees ids from another workspace.
 */
export function isWarehouseRowId(value: unknown): value is WarehouseRowId {
  return typeof value === "string" && WAREHOUSE_ROW_ID_PATTERN.test(value);
}

/** One row's worth of claims, plus the id its subject resolves to. */
export interface WarehouseClaims {
  readonly candidates: readonly FactCandidate[];
  /** Subject surface → row id, for the episode's {@link EntityResolver}. */
  readonly subjectIds: ReadonlyMap<string, WarehouseRowId>;
  /**
   * The entity-store entries this snapshot implies (#5043).
   *
   * EMPTY when the entity has no naming dimension, which is the ordinary case
   * and ADR-0039's bound inherited rather than a failure. It is also empty for
   * every row {@link unnamedRows} counted.
   */
  readonly entityEntries: readonly EntityStoreEntry[];
  /**
   * Rows that produced claims but no entity-store entry, because their naming
   * dimension held nothing usable — null, blank, an unsurfaceable type, or a
   * value that normalizes away.
   *
   * Counted rather than logged per row: a nullable display-name column is
   * ordinary data. The number is what tells an operator that some of their rows
   * will never resolve by name, which is invisible otherwise — an entity with
   * half its rows named looks exactly like one with all of them named, from
   * inside the code and from the review queue alike.
   *
   * Always `0` when the entity has no naming dimension at all. That case is
   * reported by the plan, not by this counter: *"nobody named a surface"* and
   * *"the surface column is empty"* are different facts with different remedies.
   */
  readonly unnamedRows: number;
  /** Rows whose primary key was not a usable surface and produced nothing. */
  readonly unidentifiedRows: number;
  /**
   * Rows dropped because their primary key resolves to a surface an EARLIER row
   * already owns.
   *
   * Counted apart from {@link unidentifiedRows} rather than folded in, because the
   * two say different things to whoever reads the run report: the first is a
   * warehouse with null or unusable keys, the second is a warehouse whose keys
   * collide once trimmed, or that has genuine duplicates. One is a data-quality
   * note; the other is the reason a row a person expected to see is missing.
   */
  readonly collidingSubjectRows: number;
  /**
   * Cells holding a value no claim surface can be made of. See {@link isAbsentCell}
   * for why this is NOT the same number as "cells that were empty".
   */
  readonly unsurfaceableCells: number;
  /**
   * Rows whose PRIMARY KEY held such a value — the same distinction at the subject
   * position, where it means the enrolled entity's key column is an unusable type
   * and NOTHING about that entity can ever be emitted.
   */
  readonly unsurfaceableKeyRows: number;
  /** Which dimension each unsurfaceable cell belonged to — the log's actionable half. */
  readonly unsurfaceableByDimension: ReadonlyMap<string, number>;
}

/**
 * Turn one entity's snapshot rows into candidates.
 *
 * ## The subject is the PRIMARY KEY's value, and that is a stated limit
 *
 * The semantic layer marks which dimension identifies a row and marks nothing as
 * the row's NAME, so the primary key is the only identifying surface available
 * without a guess. Where a warehouse uses a natural key (an email, a slug, an
 * account name) that surface is already what a person would say, and cross-tier
 * collision with an LLM-extracted claim works on day one. Where it uses a
 * surrogate integer it does not, and the honest consequence is that such rows
 * collide with their own re-emissions and with nothing else — the entity store
 * (#5043) is the slice that gives a surrogate-keyed row a human surface, and it
 * is designed to be fed from exactly these rows.
 *
 * Guessing instead — picking a `name`-ish column by heuristic — is the failure
 * `subject-cmp.ts` calls a confidentiality limit rather than an advisory one: a
 * wrong subject is a homonym, and corroboration is the one identity consumer with
 * no grant arm, so it attaches a public episode to a private fact and publish then
 * widens that fact's audience.
 *
 * ## Every claim declares `single`, and nothing here declares an object type
 *
 * `single` is structural (ADR-0037 §3(d)1) and advisory at this seam — since
 * #5027 the per-claim hint gates `in-tension-with` edges and reaches no `valid_to`
 * stamp. The authoritative half is the `warehouse_structural` proposal
 * {@link runWarehouseProducer} writes, which is `pending` until a human approves it.
 *
 * `objectType` is deliberately omitted. A declaration may only supply what the
 * surface LACKS, and `object-cmp.ts` already parses a bare `499`, `true`,
 * `2026-08-04` and an ISO instant on their own terms — so declaring `number`,
 * `bool`, `date` or `time` would restate the surface rather than add to it. The
 * one declaration that WOULD add information is `money`, and it needs an ISO-4217
 * code the entity YAML does not carry: declaring `money` with a guessed currency
 * is the `599 EUR` case that resolves to `null` at best and to a wrong comparison
 * at worst.
 */
export function buildWarehouseClaims(params: {
  readonly workspaceId: string;
  readonly plan: WarehouseEntityPlan;
  readonly rows: readonly Record<string, unknown>[];
  readonly snapshotAt: Date;
}): WarehouseClaims {
  const { workspaceId, plan, rows, snapshotAt } = params;
  const candidates: FactCandidate[] = [];
  const subjectIds = new Map<string, WarehouseRowId>();
  const entityEntries: EntityStoreEntry[] = [];
  let unnamedRows = 0;
  let unidentifiedRows = 0;
  let collidingSubjectRows = 0;
  let unsurfaceableCells = 0;
  let unsurfaceableKeyRows = 0;
  const unsurfaceableByDimension = new Map<string, number>();

  for (const row of rows) {
    const rawKey = row[SUBJECT_ALIAS];
    const subject = warehouseSurface(rawKey);
    if (subject === null) {
      // The SAME split the cell position makes, and leaving it folded here was the
      // cell fix closing its column rather than its class: a `bytea` primary key
      // produces `unidentifiedRows: 900`, no refusal and no log, which is the
      // "reads nine hundred rows and is indistinguishable from an empty column"
      // sentence this was all written against.
      if (isAbsentCell(rawKey)) unidentifiedRows++;
      else unsurfaceableKeyRows++;
      continue;
    }
    // The id is minted from the RAW key while the subject surface is trimmed, so
    // `42` and ` 42 ` mint different ids. That does NOT drive collision detection —
    // the guard below drops the second row on the trimmed surface and never looks at
    // an id. It decides only which raw spelling the surviving row's id carries, and
    // it is deliberate: deriving the id from the trimmed surface would give two
    // genuinely different warehouse rows one identity, which is a false `same` at
    // `subject_cmp` and the direction that MERGES two entities with no inverse.
    const rowId = warehouseRowId(
      workspaceId,
      plan.entity.name,
      typeof rawKey === "string" ? rawKey : subject,
    );
    // ⚠️ **FIRST WRITER WINS, UNCONDITIONALLY** — the guard does not compare ids,
    // and comparing them was a real hole rather than a redundancy. Two rows whose
    // keys differ only in whitespace get DIFFERENT ids and were caught; two rows
    // with the SAME key get the same id, fell through, and emitted a second full
    // set of candidates for one subject. Nothing counted them, `single` cardinality
    // was proposed for those predicates in the same transaction, and the two
    // candidates either corroborated a fact against itself or landed as a
    // contradicting draft pair.
    //
    // Nothing guarantees a declared primary key is unique: `primary_key: true` is
    // admin-authored YAML, the table may be a view, and `sql:` may be an expression
    // (`left(id,3)`). So the invariant this arm establishes — at most one candidate
    // per `(subject, predicate)` per entity — has to be enforced here or not at all.
    if (subjectIds.has(subject)) {
      collidingSubjectRows++;
      continue;
    }
    subjectIds.set(subject, rowId);

    // The entity-store entry for this row (#5043). Built HERE and not in a
    // second pass over `rows`, because every drop rule above applies to it
    // verbatim: a row with no usable primary key, or one whose key an earlier
    // row already owns, must not resolve to an id either. A separate loop would
    // be a second copy of those rules, and the copy that drifts is always the
    // one that decides what a surface resolves to.
    //
    // `namingDimension === null` is the ordinary case, not an error — see the
    // plan's field. The entity simply has no canonical surface, so the store
    // holds nothing for it and every lookup abstains.
    if (plan.namingDimensionIndex !== null) {
      const canonical = warehouseSurface(
        row[`${DIMENSION_ALIAS_PREFIX}${plan.namingDimensionIndex}`],
      );
      if (canonical === null) {
        // A row whose NAME column is null, blank or of an unsurfaceable type.
        // Counted rather than logged per row: on a nullable display-name column
        // this is ordinary data, and the number is what tells an operator that
        // half their accounts will never resolve by name.
        unnamedRows++;
      } else {
        const entry = buildEntityEntry({
          entityId: rowId,
          entity: plan.entity.name,
          keySurface: subject,
          canonicalSurface: canonical,
        });
        // `null` is the degenerate-norm refusal — a name like `---` norms away to
        // nothing, and a stored empty norm is the one key value that joins every
        // other degenerate row.
        if (entry === null) unnamedRows++;
        else entityEntries.push(entry);
      }
    }

    for (const [index, dim] of plan.dimensions.entries()) {
      const cell = row[`${DIMENSION_ALIAS_PREFIX}${index}`];
      // A NULL cell asserts nothing, and nobody should hear about it. Emitting it
      // as an empty object would be blocked as a malformed claim anyway; emitting
      // the string "null" would be a fact about the company that is not true.
      if (isAbsentCell(cell)) continue;
      const object = warehouseSurface(cell);
      if (object === null) {
        // A value that EXISTS and cannot be made into a claim — the enrollment
        // mistake. Counted PER DIMENSION as well as in total: the operator's action
        // is to un-enroll ONE pair, and a warn naming all eight enrolled dimensions
        // stops one step short of telling them which.
        unsurfaceableCells++;
        unsurfaceableByDimension.set(dim.name, (unsurfaceableByDimension.get(dim.name) ?? 0) + 1);
        continue;
      }
      candidates.push({
        subject,
        // THE BARE NAME. Qualification belongs in `detail` below and nowhere else
        // — see the module header on why a qualified predicate makes cross-tier
        // collision count exactly zero.
        predicate: dim.name,
        object,
        // The snapshot instant, not `now()` at write time: valid time is when the
        // claim held in the world, and what the producer knows is that the
        // warehouse asserted this value when it was read.
        validFrom: snapshotAt,
        predicateCardinality: "single",
        detail: {
          // NON-LOAD-BEARING, and the docstring on `FactCandidate.detail` is what
          // keeps it that way: everything here is merged UNDER the structural
          // provenance keys, so none of it can restate where the claim came from.
          entity: plan.entity.name,
          table: plan.entity.table,
          connectionGroup: plan.entity.connection,
          dimension: dim.name,
          primaryKeyDimension: plan.primaryKey.name,
          primaryKey: subject,
          rowId,
          snapshotAt: snapshotAt.toISOString(),
        },
      });
    }
  }

  return {
    candidates,
    subjectIds,
    entityEntries,
    unnamedRows,
    unidentifiedRows,
    collidingSubjectRows,
    unsurfaceableCells,
    unsurfaceableKeyRows,
    unsurfaceableByDimension,
  };
}

/**
 * The episode's resolver — an answer for the subjects of THIS snapshot only.
 *
 * A `Map` built from one snapshot rather than a live store lookup, which is what
 * makes the batch intra-episode consistent by construction: the seam's contract
 * is one call per episode over the deduplicated surface set, and this one cannot
 * straddle a write because there is nothing to write to.
 *
 * ⚠️ It answers for a surface at EITHER position, and that is the seam's
 * role-invariance rather than an oversight. A dimension value that happens to
 * equal one of this snapshot's primary keys really is that row — `parent_account`
 * holding an account's own key is the ordinary case — and answering differently by
 * position is the thing `EntityResolver` deleted the `role` argument to forbid.
 *
 * Surfaces it was not handed are ABSENT, never blank: an absent key is the honest
 * abstain, and a blank id is a contract violation the seam flags `provisional`.
 */
export function warehouseEntityResolver(
  subjectIds: ReadonlyMap<string, WarehouseRowId>,
): EntityResolver {
  return (surfaces) => {
    const answer = new Map<string, { entityId: string }>();
    for (const surface of surfaces) {
      const entityId = subjectIds.get(surface);
      if (entityId !== undefined) answer.set(surface, { entityId });
    }
    return answer;
  };
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/** Who asked for this run, and against which workspace. */
export interface WarehouseRunContext {
  readonly workspaceId: string;
  /**
   * The principal that TRIGGERED the run — context, not authority. See
   * {@link WAREHOUSE_PRODUCER_PRINCIPAL} for why it is not the attribution.
   */
  readonly triggeredBy: string;
  /**
   * Correlates every log line this run emits with the request that armed it.
   *
   * ⚠️ Not optional decoration. The failures that matter here return **200** — a
   * `snapshot-failed` refusal is a successful response — and the underlying error
   * exists nowhere but the log. Without this, an operator holding a refusal has
   * workspace plus wall-clock and nothing else to give support.
   */
  readonly requestId?: string;
}

declare const snapshotSqlBrand: unique symbol;

/**
 * The SQL gate's verdict — and the PASSING arm is branded.
 *
 * ⚠️ **The brand is the guarantee; without it the seam is the defect it replaced.**
 * Moving `validateSQL` out of `defaultRunSnapshot` stopped a substituted RUNNER
 * from skipping the gate — but with an unbranded `{ valid: boolean }`,
 * `async () => ({ valid: true })` satisfies {@link SnapshotSqlValidator} and skips
 * the whole SELECT-only / single-statement / whitelist invariant, which is the same
 * sentence one field further down the same `deps` literal. `WarehouseRowId` states
 * the repo's answer and cites where ignoring it cost a round (#5032): an unbranded
 * value is an unbranded door.
 *
 * A `valid: true` cannot be written as an object literal. It comes from
 * {@link defaultValidateSnapshotSql}, or from a cast — and a cast is greppable,
 * deliberate, and has to be argued for in review, which is exactly the difference
 * between an invariant enforced by the type and one enforced by convention.
 *
 * ⚠️ **What the brand does and does not close, measured rather than asserted.**
 * REFUSED with no cast: an object literal, `as const`, `satisfies`, a spread of the
 * refusing arm, `unknown`, generic-inference laundering — and, the useful one,
 * `(async () => ({valid: true})) as SnapshotSqlValidator`, which does not compile
 * either. ACCEPTED without a `as SnapshotSqlVerdict` hit: `as unknown as`, and any
 * `any`-typed wiring (`JSON.parse`, an untyped mock, a dynamic `import()` of a
 * plugin). So the bypass list is `as SnapshotSqlVerdict` plus `as unknown as` plus
 * `any` — an earlier draft of this line claimed the first alone was the whole list,
 * which was a comment stating a universal the type does not deliver.
 *
 * `__tests__/warehouse-producer-bypass.test.ts` pins the `as SnapshotSqlVerdict`
 * sites, which is the half a grep can actually hold.
 *
 * The REFUSING arm is deliberately unbranded: refusing more is always safe, so
 * there is no property to forge.
 */
export type SnapshotSqlVerdict =
  | { readonly valid: true; readonly [snapshotSqlBrand]: true }
  // ⚠️ `error` is REQUIRED. The wrapped `SQLValidationResult` makes it required on
  // its failing arm, so an optional here made the seam weaker than the thing it
  // wraps — and the run loop paid for it with a `?? "no reason given"` fallback, on
  // a PERMANENT refusal whose whole message is "re-running will not change this".
  // A generic message is exactly what CLAUDE.md forbids, and the illegal state that
  // produced it is removable for free: every producer already supplies a reason.
  | { readonly valid: false; readonly error: string };

/** The SELECT-only / single-statement / whitelist gate, as a seam. */
export type SnapshotSqlValidator = (
  request: WarehouseSnapshotRequest,
) => Promise<SnapshotSqlVerdict>;

/** Every I/O seam the run touches, each defaulted to its production wiring. */
export interface WarehouseProducerDeps {
  readonly loadReach?: (workspaceId: string) => Promise<ProducerReach>;
  /**
   * The published entity YAML for one enrolled name, or `null` when there is none.
   *
   * ⚠️ It may THROW, and the run treats a throw as `entity-unreadable` for that
   * entity's pairs rather than letting it escape. The shipped implementation throws
   * `AmbiguousEntityError` when a name resolves in more than one connection group
   * (`semantic/entities.ts`), which is an ordinary multi-group workspace — and the
   * lookups run inside a `Promise.all`, so an uncaught one takes down the whole run
   * for every unrelated entity and returns a 500 instead of the report that exists
   * to explain exactly this.
   */
  readonly loadEntity?: (
    workspaceId: string,
    entity: string,
  ) => Promise<Record<string, unknown> | null>;
  readonly validateSnapshotSql?: SnapshotSqlValidator;
  readonly runSnapshot?: WarehouseSnapshotRunner;
  readonly loadVocabulary?: (workspaceId: string) => Promise<ClaimVocabulary>;
  /** The persisted entity store, read once per run for the edge pass (#5043). */
  readonly loadEntityStore?: (workspaceId: string) => Promise<readonly StoredEntity[]>;
  /**
   * The vocabulary's producer batch — propose each edge, route the eligible ones
   * through the decide seam, and tally.
   *
   * A seam rather than a direct call for `loadVocabulary`'s reason: the decide
   * module pulls in the settings registry, the ACL grammar and the whole
   * vocabulary write path, and a suite testing this producer's REACH should not
   * have to stand all three up.
   */
  readonly proposeAliasEdges?: (
    workspaceId: string,
    proposals: readonly AliasProposalInput[],
    requestId?: string,
  ) => Promise<AliasProducerCounters>;
  readonly withTransaction?: ReconcileTransactionRunner;
  readonly now?: () => Date;
  readonly rowCap?: number;
}

/** What one entity's snapshot produced. */
export interface WarehouseEntityOutcome {
  readonly entity: string;
  readonly rows: number;
  readonly candidates: number;
  readonly created: number;
  readonly corroborated: number;
  readonly blocked: number;
  /**
   * `ReconcileReport.comparable` — created facts carrying a non-null **`object_cmp`**.
   *
   * ⚠️ NOT `subject_cmp`. An earlier version of this line said it was, and that is a
   * claim a reader would have used to conclude the producer was doing nothing:
   * warehouse objects are usually unparseable strings, so this number is
   * legitimately 0 on a run that populated `subject_cmp` for every single row.
   * `warehouse-producer-pg.test.ts` asserts the two independently.
   */
  readonly comparable: number;
  readonly unidentifiedRows: number;
  /** See {@link WarehouseClaims.collidingSubjectRows}. */
  readonly collidingSubjectRows: number;
  /** See {@link WarehouseClaims.unsurfaceableCells}. */
  readonly unsurfaceableCells: number;
  /** See {@link WarehouseClaims.unsurfaceableKeyRows}. */
  readonly unsurfaceableKeyRows: number;
  /** Predicates whose `warehouse_structural` cardinality proposal was newly raised. */
  readonly cardinalityProposed: readonly string[];
  /**
   * Entity-store entries written for this entity (#5043).
   *
   * ⚠️ **Reported even when it is 0, and 0 is the number that matters.** An
   * entity with no naming dimension writes no entries, resolves nothing, and is
   * otherwise byte-identical in this report to one whose store is working —
   * which is exactly ADR-0039's *"an empty store and a correctly-working store
   * are indistinguishable from inside the code."* This field is what makes them
   * distinguishable from OUTSIDE it, and it is the number #5197 verifies on
   * prod.
   */
  readonly entitiesStored: number;
  /** See {@link WarehouseClaims.unnamedRows}. */
  readonly unnamedRows: number;
}

export interface WarehouseProducerReport {
  readonly workspaceId: string;
  readonly snapshotAt: string;
  /** Pairs in the reach — the number a coverage surface compares everything else against. */
  readonly enrolled: number;
  readonly entities: readonly WarehouseEntityOutcome[];
  readonly refusals: readonly WarehouseRefusal[];
  readonly created: number;
  readonly corroborated: number;
  /**
   * What the entity-edge producer did with this run's edges (#5043).
   *
   * `null` when the pass PROPOSED nothing — an empty store, or every entry a
   * self-edge or refused — and also when it threw. {@link entityEdgesFailed} is
   * what tells the last case apart.
   *
   * ⚠️ NOT "the run wrote no entries", which is what this line used to say: that
   * held only under the `entitiesStored > 0` gate #5232 removed. The batch comes
   * from the PERSISTED, workspace-wide store, so a run that wrote nothing still
   * reports counters when prior entries exist — and a run that wrote 500
   * natural-key entries reports `null`, because every one is a self-edge.
   *
   * Zeroed counters rather than `null` would read as *"we tried and nothing
   * happened"*. The distinction is ADR-0039's, one level down: nothing to do and
   * nothing achieved must not look alike.
   *
   * ⚠️ `rejected` is THE counter to read on a re-run. A producer whose second
   * pass reports zero there is one whose human removals did not stick — #4507's
   * permanent rejection memory failing open, which re-creates an edge a person
   * deleted and re-keys their corpus with it.
   */
  readonly entityEdges: AliasProducerCounters | null;
  /**
   * The edge pass's failure message, or `null` when it did not fail (#5043).
   *
   * ⚠️ **A SIBLING field because `entityEdges: null` alone MISINFORMS.** That
   * field collapses four outcomes onto one value — nothing named, everything
   * already snapshotted, every proposal refused, and *the pass threw* — and only
   * the last one is a run an operator must act on. Without this, a vocabulary
   * lock timeout reports the same wire value as "nobody has named anything", to
   * the admin whose next action is to go name something.
   *
   * It was caught by the panel through the tests: two cases in
   * `warehouse-producer.test.ts` asserted IDENTICAL state under a comment
   * claiming they distinguished the two. They did not.
   *
   * The fuller answer is a discriminated `EntityEdgeOutcome` union replacing
   * both fields; that is a wire-shape change reaching the OpenAPI surface, so it
   * is deferred (#5233). This is the minimum that stops `null` lying.
   */
  readonly entityEdgesFailed: string | null;
  /**
   * Store entries refused an edge because their name is shared with another
   * entity (#5043).
   *
   * On the report because it is the one consequence of the fail-closed rule a
   * person can actually act on — two `Acme` accounts is ordinary data, and the
   * permanent effect is that neither resolves by name. It was countable only in
   * a `debug` line production does not emit, under a docstring claiming the
   * caller reported it.
   */
  readonly entityEdgesAmbiguous: number;
}

/**
 * Exported so a unit test dispatches on this exact string and the `-pg` suite
 * runs it against the live schema — `reconcile.ts`'s convention for every
 * statement it issues, and for its reason: a test that matches a paraphrase stays
 * green against a statement that was edited.
 */
export const WAREHOUSE_EPISODE_INSERT_SQL = `INSERT INTO brain_episodes
     (workspace_id, source, source_id, source_actor, body, locator, occurred_at, visible_to, extracted_at)
   VALUES ($1, $2, $3, $4, NULL, $5, $6::timestamptz, $7::text[], $6::timestamptz)
   ON CONFLICT (workspace_id, source, source_id) DO NOTHING
   RETURNING id::text AS id`;

/**
 * The snapshot episode — evidence BY REFERENCE, which is what tier-1 evidence is.
 *
 * `locator` carries the exact SQL the snapshot ran and `body` is NULL, because the
 * warehouse rows themselves are not Atlas's to copy into an append-only table: the
 * episode records *what was asked and when*, and the answer lives in the facts a
 * human reviews. `BrainEpisode` calls this the body-XOR-locator split and names
 * the warehouse as the by-reference side.
 *
 * `extracted_at` is stamped AT INSERT, exactly as the correction path does and
 * deliberately opposite to the connector ingest path. Leaving it null would hand
 * a warehouse snapshot to the LLM extraction fiber to be re-derived as a second,
 * machine-guessed claim over rows the producer already read exactly.
 *
 * `ON CONFLICT DO NOTHING` makes a re-run at the SAME instant a no-op rather than
 * a duplicate episode. It cannot mask a real re-run: the source id carries the
 * snapshot instant, so a genuine second reading is a different id.
 */
async function insertSnapshotEpisode(
  tx: ReconcileExecutor,
  params: {
    readonly workspaceId: string;
    readonly entity: string;
    readonly sql: string;
    readonly snapshotAt: Date;
  },
): Promise<{ id: string; sourceId: string } | null> {
  const sourceId = `warehouse:${params.entity}@${params.snapshotAt.toISOString()}`;
  const { rows } = await tx.query(WAREHOUSE_EPISODE_INSERT_SQL, [
    params.workspaceId,
    WAREHOUSE_SOURCE,
    sourceId,
    WAREHOUSE_PRODUCER_PRINCIPAL,
    params.sql,
    params.snapshotAt.toISOString(),
    [ORG_PRINCIPAL],
  ]);
  // ⚠️ `rows.length === 0` is the ONLY silent arm, and separating it from "a row
  // came back that this function cannot read" is the point. Folded together, a
  // statement edited to drop or rename the `RETURNING` makes every entity of every
  // run report *"this snapshot instant is already recorded"* — a false sentence, at
  // `info`, on a producer that would then look like a well-behaved no-op forever.
  // The statement is exported precisely because it is expected to be edited.
  if (rows.length === 0) return null;
  const row = rows[0];
  if (!isRecord(row) || typeof row.id !== "string") {
    throw new WarehouseProducerContractError(
      "WAREHOUSE_EPISODE_INSERT_SQL returned a row with no string id — its RETURNING clause and this " +
        "reader disagree. Refusing to continue: the alternative is reporting the entity as already " +
        "recorded, which is not what happened.",
    );
  }
  return { id: row.id, sourceId };
}

/**
 * Run the producer over one workspace's reach.
 *
 * One transaction per ENTITY, not one per run: an entity whose snapshot fails
 * must not roll back the entities that already landed, and a run over ten enrolled
 * entities holding one connection for all ten is the bounded-pool starvation
 * `withBrainTransaction` warns about. Within an entity the episode, its facts and
 * its cardinality proposals are atomic, which is what stops a snapshot episode
 * existing with no claims hanging off it.
 *
 * Errors from a snapshot, from its validation, from an entity lookup and from an
 * entity's TRANSACTION are caught PER ENTITY and become a typed refusal — the run
 * continues, nothing is stamped, and every pair of that entity is accounted for.
 * Errors from the reach and the vocabulary PROPAGATE: an empty reach and a failed
 * reach read produce identical silence (ADR-0039's *"a producer nobody enrolls
 * anything into leaves M4 exactly as dead as it is today, with every test green"*),
 * and a swallowed one would be indistinguishable from the honest zero.
 */
export async function runWarehouseProducer(
  context: WarehouseRunContext,
  deps: WarehouseProducerDeps = {},
): Promise<WarehouseProducerReport> {
  const { workspaceId, triggeredBy, requestId } = context;
  const now = deps.now ?? (() => new Date());
  // Clamped: the seam is test-only, but `0` and `-1` reach `LIMIT ${rowCap + 1}`
  // and a fractional cap reaches it as `LIMIT 2.5`. One expression is cheaper than
  // a brand for a knob nothing on the wire can set.
  const rowCap = Math.max(1, Math.trunc(deps.rowCap ?? WAREHOUSE_ROW_CAP));
  const loadReach = deps.loadReach ?? loadProducerReach;
  const loadEntity = deps.loadEntity ?? defaultLoadEntity;
  const validateSnapshotSql = deps.validateSnapshotSql ?? defaultValidateSnapshotSql;
  const runSnapshot = deps.runSnapshot ?? defaultRunSnapshot;
  const loadVocabulary = deps.loadVocabulary ?? defaultLoadVocabulary;
  const withTransaction = deps.withTransaction ?? withBrainTransaction;
  const loadStore = deps.loadEntityStore ?? defaultLoadEntityStore;
  const proposeEdges = deps.proposeAliasEdges ?? defaultProposeAliasEdges;
  /** Every log line this run emits carries these, so a 200 refusal is traceable. */
  const runLog = { workspaceId, triggeredBy, requestId };

  const snapshotAt = now();
  const reach = await loadReach(workspaceId);

  // One entity read per DISTINCT entity, not one per pair — `reach.entities` is
  // that set, and it is the same set the fail-closed rule is evaluated across.
  const entityShapes = new Map<string, WarehouseEntityLookup>();
  await Promise.all(
    reach.entities.map(async (name) => {
      // ⚠️ CAUGHT, and the `Promise.all` is why. `getAdminEntity` throws
      // `AmbiguousEntityError` for a name that resolves in more than one connection
      // group — an ordinary multi-group workspace — and an uncaught throw here
      // rejects the whole `Promise.all`, killing the run for every unrelated
      // enrolled entity and returning a 500 in place of the report whose entire job
      // is explaining why a pair produced nothing.
      let raw: Record<string, unknown> | null;
      try {
        raw = await loadEntity(workspaceId, name);
      } catch (err) {
        log.warn(
          { ...runLog, entity: name, err },
          "Warehouse producer: the entity lookup failed — its pairs are refused, the rest of the run continues",
        );
        // ⚠️ TWO things this no longer does. It does not interpolate the caught
        // error's text — that is an internal-DB-backed loader, so a pg failure would put a host,
        // a role or a stack on the wire, and the `snapshot-failed` arm sixty lines
        // down explicitly refuses to do exactly that. And it does not ASSERT the
        // multi-group cause: the cause here is whatever threw, so volunteering the
        // common one sent an admin auditing connection groups after an internal-DB
        // blip. The Error is in the log above; the wire gets advice and a pointer.
        entityShapes.set(name, {
          kind: "unreadable",
          cause: "load-threw",
          why:
            "looking it up failed. A name that resolves in more than one connection group is one " +
            "cause — enrollment stores no group, so this surface cannot tell the two apart — but the " +
            "lookup can also fail transiently. The server log for this run carries the reason.",
        });
        return;
      }
      if (raw === null) {
        entityShapes.set(name, { kind: "not-published" });
        return;
      }
      const entity = parseWarehouseEntity(name, raw);
      entityShapes.set(
        name,
        entity === null
          ? {
              kind: "unreadable",
              cause: "no-table",
              why: "its YAML declares no `table:`, so there is nothing to read FROM. Fix the entity YAML.",
            }
          : { kind: "found", entity },
      );
    }),
  );

  const plan = planWarehouseEmission(reach, entityShapes);
  const refusals: WarehouseRefusal[] = [...plan.refused];
  const outcomes: WarehouseEntityOutcome[] = [];

  /** Refuse every pair of one entity with one reason — the per-entity failure shape. */
  const refuseEntity = (
    entityPlan: WarehouseEntityPlan,
    reason: WarehouseRefusalReason,
    message: string,
  ) => {
    for (const dim of entityPlan.dimensions) {
      refusals.push(refusal(entityPlan.entity.name, dim.name, reason, message));
    }
  };

  let entityEdges: AliasProducerCounters | null = null;
  let entityEdgesFailed: string | null = null;
  let entityEdgesAmbiguous = 0;

  /**
   * The entity-edge producer (#5043).
   *
   * AFTER the entity loop and OUTSIDE every transaction it opened. Both halves
   * are forced:
   *
   *   - After, because ambiguity is a property of the WHOLE store rather than of
   *     one snapshot. `accounts` and `contacts` can each hold an `Acme`, and an
   *     edge emitted per entity would never see the other one — the one case
   *     that merges two distinct entities into a single slot key workspace-wide.
   *   - Outside, because `proposeAliasEdges` opens its own transaction per
   *     proposal and takes the workspace vocabulary lock in each. Calling it
   *     inside the reconcile transaction is the bounded-pool deadlock
   *     `withBrainTransaction` warns about, with a lock-order inversion on top.
   *
   * ⚠️ **A closure so BOTH exits run it, and that is the second half of a fix
   * whose first half was incomplete.** It was gated on `entitiesStored > 0`;
   * removing that gate still left it below the `plan.emit.length === 0` early
   * return, so a run where every enrolled pair was refused — expired warehouse
   * credentials, a renamed table, a dimension gone ambiguous — skipped it while
   * `brain_entity` still held every row. Un-enrolling does not delete entries
   * and no reaper exists yet (#5233), so that is exactly the run on which an
   * operator is asking why their store stopped working, and it reported
   * `entityEdgesAmbiguous: 0` over a store that might be entirely ambiguous.
   *
   * ⚠️ **Its cost, stated honestly rather than as "one indexed read".** On a
   * non-empty store this runs two sequential `proposeAliasEdge` calls per entry
   * that EARNS an edge — up to `2 × entries`, and zero for a wholly natural-key
   * store —
   * each opening a transaction and taking the workspace vocabulary lock, on
   * EVERY run — including a no-op re-run where the old gate cost nothing. At the
   * row cap across several entities that is thousands of serialized
   * lock-taking transactions per button press. A change-detector is the answer
   * and is deliberately not in this slice: it is new machinery, correctness came
   * first, and this producer has one manual trigger rather than a cadence
   * (#5228). Tracked in #5233.
   */
  const runEntityEdgePass = async (): Promise<void> => {
    // Failing here must NOT fail the run. Every fact is committed, and a throw
    // reaches `runEffect` as `500 "Failed to run"` — which invites the one retry
    // that files a second full round of drafts into the review queue.
    try {
      const store = await loadStore(workspaceId);
      const batch = entityEdgeProposals(store);
      entityEdgesAmbiguous = batch.ambiguous;
      if (batch.ambiguous > 0 || batch.unmintedIds > 0) {
        // WARN, because both are permanent consequences rather than hiccups:
        // those surfaces resolve to nothing and no edge is ever raised for them.
        // Ambiguity is ordinary data — two `Acme` accounts — which is precisely
        // why silence would be indistinguishable from a working store. An
        // unminted id has a different remedy (a re-import, not a warehouse
        // edit), so it is counted apart rather than folded in.
        log.warn(
          {
            ...runLog,
            ambiguous: batch.ambiguous,
            unmintedIds: batch.unmintedIds,
            entries: store.length,
          },
          "Entity store: entries share a name with another entity, or hold an id no producer " +
            "could have minted — neither resolves and no vocabulary edge is raised for them, so " +
            "claims about those rows will not match what people call them",
        );
      }
      if (batch.proposals.length > 0) {
        entityEdges = await proposeEdges(workspaceId, batch.proposals, requestId);
      }
    } catch (err) {
      // Recorded as a VALUE, not only a log line. A caught-and-logged failure
      // that leaves the report indistinguishable from a healthy run is the
      // silent failure this whole module argues against, one field over.
      //
      // ⚠️ **A FIXED sentence plus the correlation handle — never `err.message`.**
      // Both throw sources are internal-DB-backed, so the message is a `pg` one:
      // `connection to server at "10.x.x.x" … FATAL: password authentication
      // failed for user "atlas"` puts a host and a role in a 200 body. This file
      // refuses exactly that for `snapshot-failed`; the first cut of this field
      // did not, which is the same defect one field over.
      //
      // ⚠️ It does NOT say "no vocabulary edge was raised". `proposeAliasEdges`
      // COMMITS PER PROPOSAL, so a mid-batch throw leaves approved edges behind
      // — and an auto-approved entity edge re-keys the corpus. Asserting the
      // clean case in a catch is the same false-claim class this round exists to
      // close. The alias-producer's own aborted-batch line carries the counts.
      entityEdgesFailed =
        "The entity-edge pass failed part-way. Any edge it had already proposed is committed — " +
        "the alias-producer log line for this run carries those counts — and every fact and store " +
        `entry is committed too. Re-running is safe. The server log for request ${
          requestId ?? "(none)"
        } carries the reason.`;
      // `err` raw, so pino's serializer emits the stack — for a pool or lock
      // failure the stack is the actionable half, and the per-entity catch
      // already does it this way.
      log.error(
        { ...runLog, err },
        "Warehouse producer: the entity-edge pass failed part-way — facts and store entries are " +
          "committed, and any edge proposed before the failure is too. Re-run to retry",
      );
    }
  };

  if (plan.emit.length === 0) {
    // ⚠️ The edge pass runs HERE TOO. Every enrolled pair being refused does not
    // empty the STORE — un-enrolling deletes no entry and no reaper exists yet —
    // so this is the run an operator is most likely to be staring at. See the
    // closure's own note.
    await runEntityEdgePass();
    log.info(
      { ...runLog, enrolled: reach.pairs.length, refusals: refusals.length },
      "Warehouse producer: nothing to emit — every enrolled pair was refused or the reach is empty",
    );
    return {
      workspaceId,
      snapshotAt: snapshotAt.toISOString(),
      enrolled: reach.pairs.length,
      entities: [],
      refusals,
      entityEdges,
      entityEdgesFailed,
      entityEdgesAmbiguous,
      created: 0,
      corroborated: 0,
    };
  }

  const vocabulary = await loadVocabulary(workspaceId);

  for (const entityPlan of plan.emit) {
    const sql = buildSnapshotSql(entityPlan, rowCap);
    const request: WarehouseSnapshotRequest = {
      workspaceId,
      entity: entityPlan.entity.name,
      connectionId: entityPlan.entity.connection ?? undefined,
      sql,
    };

    // ⚠️ The gate runs HERE, before the seam, and that placement is the guarantee.
    // While it lived inside `defaultRunSnapshot`, any injected runner — a test
    // harness today, a scheduler or self-hosted variant tomorrow — satisfied
    // `WarehouseSnapshotRunner` while skipping the SELECT-only, single-statement,
    // whitelist-scoped check entirely, and nothing in the type said otherwise. The
    // statement is assembled from admin-authored `table:` and `sql:` expressions, so
    // it is exactly the input that check exists for.
    // `try`/`catch` rather than `.catch(…)`: a validator that throws SYNCHRONOUSLY
    // does so before the promise exists, so `.catch` never sees it and the throw
    // escaped the whole run as a 500 — contradicting this function's own "caught
    // PER ENTITY" contract two paragraphs up.
    let validation: SnapshotSqlVerdict;
    try {
      validation = await validateSnapshotSql(request);
    } catch (err) {
      // ⚠️ A THROW IS NOT A VERDICT OF INVALID, and routing it to
      // `snapshot-rejected` inverted this file's own permanence split. The gate's
      // shipped implementation dynamically imports a module and reads settings, so
      // a module-init failure or a briefly-unavailable internal DB throws here —
      // TRANSIENT, and the rejected arm's message says "re-running will not change
      // this" and tells the admin to un-enroll a pair that is fine.
      log.warn(
        { ...runLog, entity: entityPlan.entity.name, err },
        "Warehouse producer: the SQL gate threw rather than answering — the entity's pairs produced nothing and are retried",
      );
      refuseEntity(
        entityPlan,
        "snapshot-failed",
        `Atlas could not check the query it would run against "${entityPlan.entity.table}", so nothing ` +
          "was emitted for it this run. Nothing was invalidated and no window was stamped; the next run " +
          "tries again.",
      );
      continue;
    }
    if (!validation.valid) {
      log.warn(
        { ...runLog, entity: entityPlan.entity.name, reason: validation.error },
        "Warehouse producer: the snapshot query did not pass SQL validation — refused permanently, not retried",
      );
      refuseEntity(
        entityPlan,
        "snapshot-rejected",
        `The query Atlas would run against "${entityPlan.entity.table}" does not pass its SQL gate: ` +
          `${validation.error}. The table is probably outside this workspace's ` +
          "whitelist, or a dimension's `sql:` expression is malformed. **Re-running will not change " +
          "this** — fix the entity or un-enroll the pair.",
      );
      continue;
    }

    let rows: readonly Record<string, unknown>[];
    try {
      rows = await runSnapshot(request);
    } catch (err) {
      // The Error itself, not `.message`. `scrubErrSerializer` emits type, message,
      // stack AND pg's `code` with credentials already stripped — and `42P01` vs
      // `ECONNREFUSED` is the difference between "fix your YAML" and "your warehouse
      // is down". This log line is the only place that survives, because the
      // refusal below deliberately keeps the driver's text off the wire.
      log.warn(
        { ...runLog, entity: entityPlan.entity.name, table: entityPlan.entity.table, err },
        "Warehouse producer: snapshot failed — the entity's pairs produced nothing this run",
      );
      refuseEntity(
        entityPlan,
        "snapshot-failed",
        `Reading "${entityPlan.entity.table}" failed, so nothing was emitted for it this run. ` +
          "Nothing was invalidated and no window was stamped; the next run tries again. " +
          // ⚠️ The message no longer PROMISES that retrying will work, and the
          // difference is not cosmetic. The SQL gate checks SELECT-only,
          // single-statement and the whitelist — it does NOT check that the table or
          // column exists — so a dropped table or a renamed column throws HERE, on
          // every run, forever. "The next run retries the pair" was true and useless;
          // an operator seeing it repeat needs to know the cause may be permanent.
          "If it fails the same way on every run the cause is permanent — usually a table or a " +
          "dimension's column that no longer exists. Fix the entity YAML, or un-enroll the pair.",
      );
      continue;
    }

    if (rows.length > rowCap) {
      // ⚠️ REFUSED, not truncated — see WAREHOUSE_ROW_CAP.
      log.warn(
        { ...runLog, entity: entityPlan.entity.name, rowCap },
        "Warehouse producer: entity exceeds the row cap — refused rather than emitting a truncated snapshot",
      );
      refuseEntity(
        entityPlan,
        "row-cap-exceeded",
        `"${entityPlan.entity.table}" holds more than ${rowCap} rows, and every row becomes a draft a ` +
          "person has to review. The producer refuses rather than emitting an arbitrary subset, which " +
          "would look at rest exactly like a complete reading of the table.",
      );
      continue;
    }

    const claims = buildWarehouseClaims({
      workspaceId,
      plan: entityPlan,
      rows,
      snapshotAt,
    });

    if (claims.unsurfaceableCells > 0) {
      // An enrollment mistake rather than an empty column — see `isAbsentCell`. It
      // does not refuse the pair (some rows may still be surfaceable, and those
      // claims are good), but it must not be silent: the counter reaches the report
      // and this line reaches an operator.
      log.warn(
        {
          ...runLog,
          entity: entityPlan.entity.name,
          unsurfaceableCells: claims.unsurfaceableCells,
          // ⚠️ The GUILTY dimensions, not every enrolled one. The operator's action
          // is to un-enroll ONE pair, so listing all eight stopped one step short of
          // telling them which — and the message no longer names three specific
          // types, because a non-finite number is now absent and the remaining
          // members are open-ended.
          unsurfaceableByDimension: Object.fromEntries(claims.unsurfaceableByDimension),
        },
        "Warehouse producer: cells held values no claim surface can be made of — the named dimensions are probably a jsonb, array or bytea column",
      );
    }

    // ⚠️ Both of these were REPORTED and never LOGGED, while their sibling in the
    // same object literal got a warn. Dropping a row is a data-affecting decision,
    // and an operator asking "why is account 4471 missing from the queue" had
    // nothing to grep — and under a degraded response the counters are withheld
    // too, which made the drop fully silent.
    if (claims.collidingSubjectRows > 0) {
      log.warn(
        {
          ...runLog,
          entity: entityPlan.entity.name,
          collidingSubjectRows: claims.collidingSubjectRows,
          primaryKeyDimension: entityPlan.primaryKey.name,
        },
        "Warehouse producer: rows dropped — their primary key resolves to a surface an earlier row already owns, so the declared key is not unique",
      );
    }
    if (claims.unsurfaceableKeyRows > 0) {
      log.warn(
        {
          ...runLog,
          entity: entityPlan.entity.name,
          unsurfaceableKeyRows: claims.unsurfaceableKeyRows,
          primaryKeyDimension: entityPlan.primaryKey.name,
        },
        "Warehouse producer: rows had a primary key of a type no claim surface can be made of — nothing about this entity can be emitted until its key column changes",
      );
    }

    if (claims.candidates.length === 0) {
      // No episode is written for an entity with no claims, which is what stops a
      // snapshot episode existing with nothing hanging off it. The entity is still
      // REPORTED — an entity that produced nothing and an entity that was never
      // reached must not look alike.
      outcomes.push({
        entity: entityPlan.entity.name,
        rows: rows.length,
        candidates: 0,
        created: 0,
        corroborated: 0,
        blocked: 0,
        comparable: 0,
        unidentifiedRows: claims.unidentifiedRows,
        collidingSubjectRows: claims.collidingSubjectRows,
        unsurfaceableCells: claims.unsurfaceableCells,
        unsurfaceableKeyRows: claims.unsurfaceableKeyRows,
        cardinalityProposed: [],
        // Deliberately NOT `claims.entityEntries.length`. No episode is written
        // and no transaction opens, so nothing was STORED — reporting the
        // entries this snapshot would have implied would be a count of rows that
        // are not in the database.
        entitiesStored: 0,
        unnamedRows: claims.unnamedRows,
      });
      continue;
    }

    const outcome = await withTransaction(async (tx) => {
      const episode = await insertSnapshotEpisode(tx, {
        workspaceId,
        entity: entityPlan.entity.name,
        sql,
        snapshotAt,
      });
      if (episode === null) {
        // The identical snapshot instant is already recorded, so its facts are
        // too. Re-reconciling against a second episode id would attach a fresh
        // evidence pointer to claims that already have one.
        log.info(
          { ...runLog, entity: entityPlan.entity.name, snapshotAt: snapshotAt.toISOString() },
          "Warehouse producer: this snapshot instant is already recorded — skipping the entity",
        );
        return null;
      }

      const report = await reconcileFacts(
        {
          episode: {
            id: episode.id,
            workspaceId,
            source: WAREHOUSE_SOURCE,
            sourceId: episode.sourceId,
            sourceActor: WAREHOUSE_PRODUCER_PRINCIPAL,
            occurredAt: snapshotAt,
            visibleTo: [ORG_PRINCIPAL],
          },
          candidates: claims.candidates,
          producer: WAREHOUSE_PRODUCER,
          // The pass that produced these claims ran at the snapshot instant. Not
          // null: a warehouse claim is derived from a reading, unlike an authored
          // one, and `extracted_at` is what records that a pass happened.
          extractedAt: snapshotAt,
          sourcePrincipal: WAREHOUSE_PRODUCER_PRINCIPAL,
          resolveEntity: warehouseEntityResolver(claims.subjectIds),
          vocabulary,
        },
        { withTransaction: (fn) => fn(tx), now: () => snapshotAt },
      );

      // The entity store, INSIDE this entity's transaction (#5043), so the
      // entries and the facts they describe commit or roll back together. An
      // entity whose transaction fails leaves its previous entries intact, which
      // is the honest state: nothing was read, so nothing is known to have
      // changed.
      //
      // Unconditional, including when `entityEntries` is empty — the DELETE half
      // is what clears the store after a human un-names a dimension. Skipping it
      // on an empty list would leave every prior entry resolving under a name
      // nobody named any more.
      await writeEntityEntries(tx, {
        workspaceId,
        entity: entityPlan.entity.name,
        entries: claims.entityEntries,
        snapshotAt,
      });

      // The authoritative half of `single` — `pending`, one entry per predicate,
      // and a refusal here is the ordinary case rather than an error: the first
      // run raises it and every later one is `already-decided`, which is also how
      // a human's `rejected` stays rejected.
      const proposed: string[] = [];
      for (const dim of entityPlan.dimensions) {
        // Addressed by SURFACE, deliberately: `keys-not-on-the-wire.test.ts`
        // refuses to see a slot key named outside the modules allowlisted for
        // naming a column they cannot address a row without naming, and the
        // alternative — allowlisting this file — would switch off that guard's
        // SELECT arm here too. `cardinality.ts` derives the key and never
        // returns it.
        const result = await proposePredicateCardinalityForSurface(tx, workspaceId, {
          predicateSurface: dim.name,
          cardinality: "single",
          sourceClass: WAREHOUSE_CARDINALITY_SOURCE,
          proposedBy: WAREHOUSE_PRODUCER,
          predicateAlias: vocabulary.predicate,
        });
        if (result.ok) {
          proposed.push(dim.name);
          continue;
        }
        // ⚠️ THREE arms. `cardinality.ts`'s correction-event proposer splits only
        // two ways (`already-decided` at `debug`, everything else at `warn`), and
        // that is not enough here. `already-decided` is genuinely routine — it is
        // what makes a re-run a no-op and what makes a human's `rejected` stick.
        // `degenerate-key` is reachable from real data (a dimension whose norm
        // collapses to nothing) and means this predicate will never get a `single`
        // entry, so the machinery this producer exists to wake up stays dormant for
        // it — that is neither routine nor drift. The remaining two are unreachable
        // from THIS call site (the cardinality is a literal and the producer id is a
        // const), which is why reaching one means the call site drifted.
        //
        // `result.message` travels too: `cardinality.ts` puts the operator-facing
        // text there.
        const line = {
          ...runLog,
          entity: entityPlan.entity.name,
          dimension: dim.name,
          refusal: result.refusal,
          detail: result.message,
        };
        if (result.refusal === "already-decided") {
          log.debug(line, "Warehouse producer: predicate cardinality already adjudicated, no proposal");
        } else if (result.refusal === "degenerate-key") {
          log.warn(
            line,
            "Warehouse producer: this dimension's name normalizes away to nothing, so it can never carry a `single` cardinality entry — supersession stays dormant for it",
          );
        } else {
          log.warn(line, "Warehouse producer: cardinality proposal refused unexpectedly — this call site drifted");
        }
      }

      // ⚠️ One expression, not a ternary on `episodeBlocked`. When an episode is
      // blocked wholesale, `reconcile.ts` sets `blocked[reason] = candidates.length`
      // with every other reason at zero — so the sum ALREADY equals
      // `claims.candidates.length` and the ternary's two arms were the same number.
      // A branch that looks like it compensates for a contract violation, but does
      // not, costs the next reader a trip into `reconcile.ts` to discover it is
      // dead.
      const blocked = Object.values(report.blocked).reduce((sum, n) => sum + n, 0);
      return {
        entity: entityPlan.entity.name,
        rows: rows.length,
        candidates: claims.candidates.length,
        created: report.created,
        corroborated: report.corroborated,
        blocked,
        comparable: report.comparable,
        unidentifiedRows: claims.unidentifiedRows,
        collidingSubjectRows: claims.collidingSubjectRows,
        unsurfaceableCells: claims.unsurfaceableCells,
        unsurfaceableKeyRows: claims.unsurfaceableKeyRows,
        cardinalityProposed: proposed,
        entitiesStored: claims.entityEntries.length,
        unnamedRows: claims.unnamedRows,
      } satisfies WarehouseEntityOutcome;
    }).catch((err: unknown) => {
      // A defect in this module's own contract stays FATAL — see
      // `WarehouseProducerContractError`. Everything below is for OPERATIONAL
      // failures, where refusing one entity is the proportionate answer.
      if (err instanceof WarehouseProducerContractError) throw err;
      // ⚠️ **REFUSED PER ENTITY, NOT RE-THROWN — and this reverses an earlier
      // decision in this file rather than extending it.**
      //
      // "A transaction failure PROPAGATES" was stated before its consequence was
      // traced. The throw reaches `runEffect`, which answers `500 "Failed to run
      // brain warehouse producer."` — while entities 1..N-1 have COMMITTED their
      // episodes, facts and cardinality proposals. The admin reads "failed",
      // presses Run again, `now()` yields a fresh snapshot instant so `ON CONFLICT`
      // dedupes nothing, and every already-committed entity files a second full
      // round of drafts into the queue this producer's whole design exists to keep
      // reviewable. That is verbatim the argument `checkedRun` makes one layer up
      // for the response — left unclosed one function down.
      //
      // It was also the only per-entity failure that refused NOTHING: every other
      // one calls `refuseEntity`, so the pairs are accounted for.
      log.error(
        {
          ...runLog,
          entity: entityPlan.entity.name,
          committedEntities: outcomes.map((o) => o.entity),
          committedCreated: outcomes.reduce((sum, o) => sum + o.created, 0),
          err,
        },
        "Warehouse producer: a transaction failed and rolled back — its entity produced nothing; earlier entities had already committed",
      );
      refuseEntity(
        entityPlan,
        "snapshot-failed",
        `Writing "${entityPlan.entity.table}"'s claims failed and its transaction rolled back, so ` +
          "nothing at all was recorded for it — no episode, no drafts, no proposals. Entities earlier " +
          "in this run DID commit, so a blind re-run re-files their drafts: drain the review queue " +
          "first, then re-run.",
      );
      return "aborted" as const;
    });

    if (outcome === "aborted") continue;

    if (outcome === null) {
      // The entity is reported rather than omitted. An entity that vanishes from
      // BOTH lists reads as "never enrolled", which is the silence this report
      // exists to remove — and a run where every entity conflicted would otherwise
      // be byte-identical to an empty reach.
      refuseEntity(
        entityPlan,
        "snapshot-already-recorded",
        `A snapshot of "${entityPlan.entity.table}" at this exact instant is already recorded, so its ` +
          "claims are too and the entity was skipped. Nothing was lost — re-run to take a fresh " +
          "snapshot at a new instant.",
      );
      continue;
    }
    outcomes.push(outcome);
  }

  const created = outcomes.reduce((sum, o) => sum + o.created, 0);
  const corroborated = outcomes.reduce((sum, o) => sum + o.corroborated, 0);
  const entitiesStored = outcomes.reduce((sum, o) => sum + o.entitiesStored, 0);

  await runEntityEdgePass();

  log.info(
    {
      ...runLog,
      enrolled: reach.pairs.length,
      entities: outcomes.length,
      created,
      corroborated,
      entitiesStored,
      entityEdges,
      entityEdgesFailed,
      entityEdgesAmbiguous,
      refusals: refusals.length,
    },
    "Warehouse producer run complete — every fact landed draft and waits for a human publish",
  );

  return {
    workspaceId,
    snapshotAt: snapshotAt.toISOString(),
    enrolled: reach.pairs.length,
    entities: outcomes,
    refusals,
    created,
    corroborated,
    entityEdges,
    entityEdgesFailed,
    entityEdgesAmbiguous,
  };
}

// ---------------------------------------------------------------------------
// Production wiring
// ---------------------------------------------------------------------------
//
// Dynamically imported, on `loadWorkspaceVocabulary`'s precedent: it keeps the
// semantic layer, the connection registry and the internal pool out of this
// module's static graph, so a suite that partial-mocks one seam does not have to
// re-export the machinery behind the other three.

async function defaultLoadVocabulary(workspaceId: string): Promise<ClaimVocabulary> {
  const { loadWorkspaceVocabulary } = await import("@atlas/api/lib/brain/vocabulary");
  return loadWorkspaceVocabulary(workspaceId);
}

async function defaultLoadEntityStore(
  workspaceId: string,
): Promise<readonly StoredEntity[]> {
  const { loadEntityStore } = await import("@atlas/api/lib/brain/entity-store");
  return loadEntityStore(workspaceId);
}

async function defaultProposeAliasEdges(
  workspaceId: string,
  proposals: readonly AliasProposalInput[],
  requestId?: string,
): Promise<AliasProducerCounters> {
  const { proposeAliasEdges } = await import("@atlas/api/lib/brain/vocabulary-decide");
  return proposeAliasEdges(workspaceId, proposals, ENTITY_EDGE_PRODUCER, { requestId });
}

/**
 * PUBLISHED, never developer.
 *
 * `enrollment-candidates.ts` offers published entities and only published ones,
 * so reading a draft here would let the producer emit for a pair no admin could
 * have enrolled through the surface — and a draft entity's dimensions disappear
 * when the draft is discarded, leaving facts derived from a shape the workspace
 * never adopted.
 */
async function defaultLoadEntity(
  workspaceId: string,
  entity: string,
): Promise<Record<string, unknown> | null> {
  const { getAdminEntity } = await import("@atlas/api/lib/semantic/admin-source");
  const detail = await getAdminEntity({ name: entity, orgId: workspaceId, mode: "published" });
  return detail === null ? null : (detail.entity as Record<string, unknown>);
}

/**
 * The shipped SQL gate — the product's own `validateSQL`, on the BUILT statement.
 *
 * ⚠️ Not ceremony. The statement is assembled from `table:` and `sql:` expressions
 * the semantic layer holds, which are admin-authored TEXT rather than values, so no
 * bind parameter can carry them and this is the same SELECT-only,
 * single-statement, whitelist-scoped check every other query in the product passes.
 *
 * It is a SEPARATE seam from {@link WarehouseSnapshotRunner}, and the split is the
 * guarantee: while the validation lived inside the shipped runner, any substituted
 * runner satisfied the runner type while skipping the gate entirely, and nothing in
 * the type said otherwise. {@link runWarehouseProducer} now calls this before the
 * runner, so a replacement runner cannot reach a datasource with an unvalidated
 * statement.
 *
 * Exported so a test can drive the REAL gate over a REAL built statement.
 *
 * ⚠️ **What that test can and cannot show, stated because the difference matters.**
 * The gate's table check is workspace-whitelist-scoped, so a test workspace with no
 * whitelist is rejected on the TABLE no matter how well-formed the statement is —
 * the test therefore cannot assert `valid === true`. What it does assert is that
 * the statement is never rejected for its FORM (a stray semicolon, an unparseable
 * alias, a non-SELECT), which is the half that would fail in EVERY workspace and
 * would make a producer that refuses every entity in production look from here
 * exactly like one that works. The whitelist half is only observable against a
 * workspace that has one, and it is #5197's prod row count that closes it.
 */
export async function defaultValidateSnapshotSql(
  request: WarehouseSnapshotRequest,
): Promise<SnapshotSqlVerdict> {
  const { validateSQL } = await import("@atlas/api/lib/tools/sql");
  const result = await validateSQL(request.sql, request.connectionId, request.workspaceId);
  // THE cast — the only `as SnapshotSqlVerdict` in production code, which is what
  // `warehouse-producer-bypass.test.ts` pins. This is the single point where
  // "the product's SQL gate said yes" becomes a value the run will act on — see
  // {@link SnapshotSqlVerdict} for why that has to be unforgeable by an object
  // literal rather than merely documented.
  return result.valid
    ? ({ valid: true } as SnapshotSqlVerdict)
    : // `error` is required on both sides — `SQLValidationResult`'s failing arm and
      // this one — so there is nothing to conditionally spread.
      { valid: false, error: result.error };
}

/**
 * The shipped snapshot runner — reads tier-1, and nothing else.
 *
 * It deliberately does NOT validate: the gate ran before it was called, and having
 * it here as well would put the product's one SQL invariant inside a substitutable
 * implementation. See {@link defaultValidateSnapshotSql}.
 */
async function defaultRunSnapshot(
  request: WarehouseSnapshotRequest,
): Promise<readonly Record<string, unknown>[]> {
  const { connections } = await import("@atlas/api/lib/db/connection");
  const connection = connections.getForOrg(request.workspaceId, request.connectionId ?? "default");
  const result = await connection.query(request.sql);
  return result.rows;
}

