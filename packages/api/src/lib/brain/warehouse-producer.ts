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
 * Still not a scheduler, and the distinction survived #5228 rather than being
 * tidied away: this module runs ONE run when it is called, and the two things
 * that call it — the operator's `POST /api/v1/admin/brain-enrollment/produce`
 * and the cadence fiber (`lib/scheduler/brain-warehouse-cadence.ts`) — own the
 * enablement, cadence and audit answers between them. What DOES bind both is
 * `lib/brain/warehouse-run-lock.ts`: a run must be called under that lock,
 * because two overlapping runs take two snapshot instants and nothing in here
 * can tell them apart afterwards.
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
  /**
   * The YAML `connection:` HINT — an author naming a datasource directly.
   *
   * ⚠️ Not the entity's connection group, and the distinction is the #5197 bug:
   * on a DB-backed semantic layer the scope lives in the row's
   * `connection_group_id` and this field is `null` for every entity, so reading
   * `null` as "the default connection" pointed every SaaS snapshot at the wrong
   * database. {@link defaultResolveConnectionIds} answers the group question;
   * this field only ever overrides it.
   */
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
   * `cause` beside `why`. `why` is the sentence the operator reads.
   *
   * ⚠️ **No production code branches on `cause` today** — {@link planWarehouseEmission}
   * reads only `why` and folds all three into one `entity-unreadable` refusal. It is
   * carried so a consumer CAN branch without matching prose, and so a test can assert
   * which cause fired; the earlier wording here claimed a live branch that has never
   * existed.
   */
  | {
      readonly kind: "unreadable";
      /**
       * ⚠️ `unreadable-shape` is NOT a spelling of `load-threw`, and merging them was
       * measured wrong (#5257). The loader SUCCEEDED and handed back a record this
       * producer cannot parse — permanent, with a concrete remedy — while
       * `load-threw`'s prose offers an ambiguous-name audit and a retry, neither of
       * which can ever help. Same `kind` on the wire, different sentence and different
       * thing to branch on, which is what this field is for.
       */
      readonly cause: "load-threw" | "unreadable-shape" | "no-table";
      readonly why: string;
    }
  /**
   * The NAME is enrolled under more than one connection group (#5286).
   *
   * Its own arm rather than an `unreadable` cause, because nothing about the
   * entity is unreadable — each group's copy reads perfectly, and the sentence
   * `planWarehouseEmission` builds for `unreadable` (*"is published but could
   * not be read"*) would be false. What is ambiguous is the ENROLLMENT, and the
   * remedy is on the enrollment surface rather than in the semantic layer.
   *
   * `groups` carries the collision's members so the refusal can name them; they
   * are group ids the admin sees on the enrollment page beside each entity.
   */
  | { readonly kind: "enrolled-in-two-groups"; readonly groups: readonly (string | null)[] }
  /**
   * Atlas could not work out which datasource this entity reads (#5284), so its
   * pairs are refused before anything is built.
   *
   * ⚠️ **It is a LOOKUP arm rather than a check inside the emit loop, and the
   * move is a bug fix (#5286 review).** The emit loop's own `unplaceable` check
   * is reached only by an entity that made it into `plan.emit` — published,
   * readable, with exactly one primary key. An unplaceable entity that fails ANY
   * of those is refused for that other reason instead, and the placement cause is
   * never reported.
   *
   * That is not a cosmetic ordering. The commonest instance is an enrollment
   * written before 0205 whose name is published under two groups: the lookup is
   * scoped to the flat scope, finds nothing, and the pair is refused
   * `entity-not-published` — *"Publish the entity"* — for an entity that is
   * published twice. The admin can follow that advice forever. Carried here, the
   * refusal names the real condition and its remedy.
   */
  | { readonly kind: "unplaceable"; readonly cause: WarehouseUnplaceableCause };

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
    // ⚠️ FIRST, ahead of every structural arm. An entity Atlas cannot place has
    // no datasource for any other question to be asked against, and the arms
    // below would answer a DIFFERENT true thing about it — with a remedy that
    // cannot work. See the arm's own note on {@link WarehouseEntityLookup}.
    if (lookup.kind === "unplaceable") {
      refused.push(
        refusal(
          pair.entity,
          pair.dimension,
          "connection-unresolved",
          `Atlas could not work out which datasource "${pair.entity}" should be read from, so it ` +
            `read none. ${UNPLACEABLE_REMEDY[lookup.cause]} **Re-running will not change this** — ` +
            "the entity's connection group has to be settled first.",
        ),
      );
      continue;
    }
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
    if (lookup.kind === "enrolled-in-two-groups") {
      // ⚠️ BOTH sides refused, never one, on `ambiguous-dimension`'s rule five
      // arms down and for the identical reason: picking a winner needs a tie-break
      // (first enrolled? more rows? alphabetical?) and every such rule is a machine
      // deciding which of two human enrollments meant what it says. Here the stakes
      // are higher still — the loser's rows would be filed under the winner's
      // entity id, which is a false `same` at the publish gate rather than a
      // mislabelled one.
      const named = lookup.groups
        .map((g) => (g === null ? "the ungrouped scope" : `"${g}"`))
        .toSorted()
        .join(" and ");
      refused.push(
        refusal(
          pair.entity,
          pair.dimension,
          "enrolled-in-two-groups",
          `"${pair.entity}" is enrolled under ${lookup.groups.length} connection groups at once ` +
            `(${named}), which are ${lookup.groups.length} different entities over ` +
            "different databases. Everything Atlas would write about them is filed under the " +
            "entity NAME and carries no group, so their rows would merge into one subject and two " +
            "unrelated rows that happen to share a key would read as the same thing. Un-enroll it " +
            "in all but one group — the producer refuses rather than choosing, because a wrong " +
            "merge at the review gate has no inverse.",
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

/**
 * What {@link WarehouseSnapshotRunner} is asked for.
 *
 * ⚠️ **Every field must stay a PRIMITIVE.** `runWarehouseProducer` freezes this
 * object so a substituted validator cannot rewrite the statement after the gate
 * approved it, and a shallow freeze is total only while nothing here is a reference.
 * An object-typed field added later would leave the freeze looking intact and the
 * guarantee gone.
 */
export interface WarehouseSnapshotRequest {
  readonly workspaceId: string;
  readonly entity: string;
  /**
   * Which datasource to read: the entity YAML's `connection:` hint if its author set
   * one, otherwise the primary member of the entity's connection group.
   *
   * `undefined` is the flat default scope and the ONLY spelling of it. Both arms are
   * normalised at the call site: the literal `"default"` — which the YAML hint may
   * legitimately carry, since that is what the flat root's implied group is called —
   * is collapsed to `undefined` before it reaches this field.
   *
   * ⚠️ **Stated as a property of THE FIELD, because stating it of one arm is how it
   * was first got wrong.** An earlier draft asserted this singleness on the grounds
   * that the group resolver never emits `"default"`, which was true and insufficient:
   * the hint arm beside it does. The two spellings diverge downstream — the runner
   * collapses them (`request.connectionId ?? "default"`), the gate does not
   * (`getDBType("default")` throws where `detectDBType()` does not) — so a field
   * carrying both silently sends flat workspaces to a permanent refusal.
   *
   * An entity whose connection could not be established never reaches this type; it
   * is refused `connection-unresolved` instead.
   */
  readonly connectionId: string | undefined;
  readonly sql: string;
}

declare const validatedSnapshotSql: unique symbol;

/**
 * A snapshot request THE GATE HAS SEEN AND PASSED — the token, and the statement
 * it is a token for, as one value.
 *
 * ⚠️ **The brand is on the REQUEST rather than on a bare verdict, and that is the
 * whole of #5230.** A verdict that merely says *"something passed"* leaves two
 * doors open that no object literal has to walk through:
 *
 * - **Replay.** `cached ??= await validate(BENIGN_REQUEST)` mints one genuine
 *   passing token and hands it back for every entity thereafter. Nothing is
 *   forged; the token is simply about a different statement than the one about to
 *   run. Carrying the request kills it, because {@link runWarehouseProducer}
 *   compares what came back against what it sent and runs only what the gate
 *   actually saw.
 * - **Ordering.** While {@link WarehouseSnapshotRunner} took a bare
 *   {@link WarehouseSnapshotRequest}, validate-then-run was enforced by STATEMENT
 *   ORDER — the same convention the brand was introduced to replace. A reorder, or
 *   a new call site reaching the runner directly, compiled fine. Now the runner's
 *   only input is a value that cannot exist without the gate having produced it.
 *
 * The symbol is module-private and never exported, so this type is minted by
 * {@link defaultValidateSnapshotSql} or by an assertion. FIVE exported names can
 * carry such an assertion — see {@link SnapshotSqlVerdict}'s note for why — and
 * `__tests__/warehouse-producer-bypass.test.ts` pins all five.
 *
 * ## The `@sql-gate-guarded` tag, and what it is NOT (#5255)
 *
 * Every declaration in that set of five carries the tag below. It exists so the
 * membership decision is reviewable HERE, at the definition site, rather than only
 * in a hand-maintained array in a test file three directories away — and the bypass
 * suite asserts set equality in BOTH directions, so a tag added without a list entry
 * reds, and a list entry whose tag was deleted reds.
 *
 * ⚠️ **The tag is not the completeness mechanism, and reading it as one is the trap.**
 * A tag is something a person has to remember, so a sixth brand-carrying type added
 * WITHOUT one would be invisible to it — which is the exact failure #5255 exists to
 * close. The suite therefore also derives the set STRUCTURALLY: it walks this module's
 * top-level exported `type`/`interface`/`class` declarations and takes the transitive
 * closure of "names the brand symbol, or names something already in the closure".
 * That closure is computed from the source and cannot be forgotten. The tag is the
 * human-readable half; the closure is the enforcing half; they are asserted equal.
 *
 * A new exported type that mentions any of the five therefore has to be argued —
 * either it genuinely carries the brand, in which case tag it and list it, or the
 * mention is incidental and the reference should not be there.
 *
 * @sql-gate-guarded
 */
export type ValidatedSnapshotRequest = WarehouseSnapshotRequest & {
  readonly [validatedSnapshotSql]: true;
};

/**
 * Reads tier-1. The one seam in this module that touches a customer datasource.
 *
 * ⚠️ It takes a {@link ValidatedSnapshotRequest}, not a bare request, so no call
 * site — here or in a future scheduler — can reach a datasource with a statement
 * the SELECT-only / single-statement / whitelist-scoped gate has not passed. The
 * ordering is a type, not a convention.
 *
 * ⚠️ **Every seam holding this must be a PROPERTY, never a method shorthand.**
 * `WarehouseProducerDeps.runSnapshot` is a property today and has to stay one:
 * method parameters are bivariant, so `interface S { run(r: WarehouseSnapshotRequest): … }`
 * accepts this runner and then admits a bare request at the call site — measured,
 * and it is the one way the parameter's guarantee can be re-opened without a cast.
 *
 * @sql-gate-guarded
 */
export type WarehouseSnapshotRunner = (
  request: ValidatedSnapshotRequest,
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

/**
 * The SQL gate's verdict — and the PASSING arm carries the request it passed.
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
 * A `valid: true` cannot be written as an object literal, because it needs a
 * {@link ValidatedSnapshotRequest} and that type's symbol is module-private. It
 * comes from {@link defaultValidateSnapshotSql}, or from a cast — and a cast is
 * greppable, deliberate, and has to be argued for in review, which is exactly the
 * difference between an invariant enforced by the type and one enforced by
 * convention.
 *
 * ⚠️ **What the shape does and does not close, measured rather than asserted.**
 * REFUSED with no cast: an object literal, `as const`, `satisfies`, a spread of the
 * refusing arm, `unknown`, and the identity form of generic-inference laundering.
 * ACCEPTED by the compiler: `as unknown as`, any `any`-typed wiring (`JSON.parse`,
 * an untyped mock, a dynamic `import()` of a plugin), a `Partial<T>`-shaped generic
 * builder — and, the one that matters, **an assertion onto any of the five names the
 * bypass matcher takes**: this union, {@link ValidatedSnapshotRequest},
 * {@link SnapshotSqlValidator}, {@link WarehouseProducerDeps} or
 * {@link WarehouseSnapshotRunner}.
 *
 * The mechanism, measured rather than reasoned — the two obvious explanations for it
 * are both wrong: **the brand only ADDS a property**, so
 * `ValidatedSnapshotRequest` is assignable to {@link WarehouseSnapshotRequest}, and
 * `as` succeeds whenever EITHER direction is comparable. The reverse direction
 * carries every one of those spellings. Refused only where the reverse direction
 * also fails — a NULLARY mint (a 1-parameter function type is not assignable to a
 * 0-parameter one), or a literal with an excess property. Pinning `valid` with
 * `as const` does NOT close it. Such a validator hands back its OWN argument, so the
 * run loop's identity check waves it through — which is why the seam names are in
 * the bypass matcher rather than described away here.
 *
 * ⚠️ **FIVE names are in the bypass matcher, and none is redundant.** This union,
 * {@link ValidatedSnapshotRequest}, {@link SnapshotSqlValidator},
 * {@link WarehouseProducerDeps} and {@link WarehouseSnapshotRunner} — every exported
 * name an assertion can land on and reach this authority, for the reason above.
 * `__tests__/warehouse-producer-bypass.test.ts` pins all five, which is the half a
 * grep can actually hold; what it cannot hold is stated there rather than here.
 *
 * ⚠️ **The type still cannot say WHICH statement passed — only the run loop can.**
 * A validator is free to return a genuine token minted for some other request, and
 * a cached one is exactly that. {@link runWarehouseProducer} therefore compares the
 * returned request against the one it submitted and refuses on a mismatch; the
 * type narrows the door, the identity check closes it.
 *
 * The REFUSING arm is deliberately unbranded: refusing more is always safe, so
 * there is no property to forge.
 *
 * @sql-gate-guarded
 */
export type SnapshotSqlVerdict =
  | { readonly valid: true; readonly request: ValidatedSnapshotRequest }
  // ⚠️ `error` is REQUIRED. The wrapped `SQLValidationResult` makes it required on
  // its failing arm, so an optional here made the seam weaker than the thing it
  // wraps — and the run loop paid for it with a `?? "no reason given"` fallback, on
  // a PERMANENT refusal whose whole message is "re-running will not change this".
  // A generic message is exactly what CLAUDE.md forbids, and the illegal state that
  // produced it is removable for free: every producer already supplies a reason.
  | { readonly valid: false; readonly error: string };

/**
 * The SELECT-only / single-statement / whitelist gate, as a seam.
 *
 * @sql-gate-guarded
 */
export type SnapshotSqlValidator = (
  request: WarehouseSnapshotRequest,
) => Promise<SnapshotSqlVerdict>;

/**
 * A resolved datasource id, distinct from the connection GROUP id it came from.
 *
 * ⚠️ **The two are both bare strings and the swap compiles.**
 * `AdminEntitySummary.connectionId` is a `connection_group_id`
 * despite its name, so `out.set(name, summary.connectionId)` reads correctly at
 * every call site in {@link mapEntitiesToConnectionIds} and is wrong. Branding the
 * value position makes it red at the one place a group could be mistaken for a
 * connection, on {@link WarehouseRowId}'s precedent and for its reason.
 *
 * Branded at THIS seam rather than on `resolveGroupPrimaryConnectionId`'s return:
 * that function is shared with the amendment path and its own suites, and
 * the cast belongs where an answer becomes a snapshot's target.
 */
export type WarehouseConnectionId = string & {
  readonly __warehouseConnectionId: unique symbol;
};

/** Why one enrolled entity could not be placed in a connection group. */
export type WarehouseUnplaceableCause =
  /**
   * The name resolves under more than one group in the published catalog, and
   * the enrollment named none of them.
   *
   * ⚠️ Reachable ONLY for an enrollment whose own group is `null` — a row
   * written before 0205, or a genuinely flat workspace. A group-scoped
   * enrollment states which entity it means, so this question is not asked of
   * it. That is #5286's fix at this seam: the inference stays for the rows that
   * predate the column and is bypassed by every row that carries one.
   */
  | "ambiguous-group"
  /** Its single group did not resolve to a visible primary member. */
  | "group-not-visible"
  /** It is absent from the workspace's authoritative (DB-backed) published catalog. */
  | "absent-from-catalog";

/**
 * One enrolled entity to place, and the group its enrollment named (#5286).
 *
 * `group: null` means the enrollment named no group — a pre-0205 row or a flat
 * workspace — and takes {@link mapEntitiesToConnectionIds}' inference path. A
 * string takes the direct path, which is the whole point of the column: the
 * catalog no longer has to be asked a question it cannot answer.
 */
export interface WarehousePlacementTarget {
  readonly entity: string;
  readonly group: string | null;
}

/**
 * The admin-facing remedy per cause — one sentence each, and they differ.
 *
 * ⚠️ One sentence per cause, because the jobs differ: rename or un-enroll, publish
 * the datasource, republish the entity. A shared "check your connection groups" is
 * the generic message CLAUDE.md forbids, on a refusal that says re-running will not
 * help — the admin follows it, nothing changes, and the real defect is never named.
 *
 * No group id or connection id appears here. The cause is on the wire; the
 * identifiers are in the log line beside it.
 */
const UNPLACEABLE_REMEDY: Record<WarehouseUnplaceableCause, string> = {
  "ambiguous-group":
    "This enrollment names no connection group, and more than one database answers to that entity " +
    "name in this workspace — including a workspace entity that shadows a built-in one of the same " +
    "name. Un-enroll the pair and enroll it again: the picker records which one you mean. " +
    "(An enrollment made before Atlas stored the group has none, which is how a pair reaches this " +
    "state; renaming one of the entities also resolves it.)",
  "group-not-visible":
    "Its connection group was not reachable from this workspace on this run: the datasource " +
    "is unpublished, content mode hides it, or Atlas could not read the workspace's " +
    "whitelist. Check the datasource is published, then run again.",
  "absent-from-catalog":
    "It is not in this workspace's published entity list. Republish the entity, or un-enroll " +
    "the pair.",
};

/**
 * Where each enrolled entity's snapshot reads, and which entities have no answer.
 *
 * ⚠️ **Two states, because ABSENCE IS AMBIGUOUS and reading it as one thing is the
 * #5284 defect.** An entity missing from `placed` can mean *"this workspace is flat,
 * the deployment default is correct"* or *"Atlas could not work out which database
 * this is"* — and the second must never be answered with the first. A bare
 * `ReadonlyMap` cannot tell them apart, so the map carries only positive,
 * group-derived answers and everything unanswerable is named in `unplaceable`.
 */
export interface WarehouseConnectionPlacement {
  /**
   * Entity name → the connection its snapshot must read.
   *
   * Group-derived answers ONLY. An entity of a flat, ungrouped workspace is
   * deliberately ABSENT rather than mapped to `"default"`: the literal `"default"`
   * takes a different branch in the SQL gate (`getDBType("default")`, which throws
   * `ConnectionNotRegisteredError` before anything has touched the default pool)
   * than the `undefined` that same workspace produced before this seam existed.
   */
  readonly placed: ReadonlyMap<string, WarehouseConnectionId>;
  /** Entities with no derivable connection. Refused, never defaulted. */
  readonly unplaceable: readonly {
    readonly entity: string;
    readonly cause: WarehouseUnplaceableCause;
  }[];
}

/**
 * Every I/O seam the run touches, each defaulted to its production wiring.
 *
 * @sql-gate-guarded
 */
export interface WarehouseProducerDeps {
  readonly loadReach?: (workspaceId: string) => Promise<ProducerReach>;
  /**
   * The published entity YAML for one enrolled name, or `null` when there is none.
   *
   * ⚠️ It may THROW, and the run treats a throw as `entity-unreadable` for that
   * entity's pairs rather than letting it escape. The shipped implementation throws
   * `AmbiguousEntityError` when a name resolves in more than one connection group
   * (`semantic/entities.ts`) — and the lookups run inside a `Promise.all`, so an
   * uncaught one takes down the whole run for every unrelated entity and returns a
   * 500 instead of the report that exists to explain exactly this.
   *
   * ⚠️ **`group` is what stops the shipped implementation throwing that in the
   * ordinary case (#5286).** It is the group the ENROLLMENT named, passed
   * straight through to `getAdminEntity`'s `connectionGroupId`, so a multi-group
   * workspace resolves the entity its admin actually picked. The guard above
   * stays because the throw is still reachable — `null` (a pre-0205 row, or a
   * flat workspace) takes the unique-or-throw path exactly as before, and the
   * lookup can fail transiently regardless.
   */
  readonly loadEntity?: (
    workspaceId: string,
    entity: string,
    group: string | null,
  ) => Promise<Record<string, unknown> | null>;
  /**
   * Which datasource each enrolled entity's snapshot reads.
   *
   * A seam of its own rather than a field on {@link loadEntity}'s result: the
   * answer is not in the entity YAML at all (see
   * {@link defaultResolveConnectionIds}), so a loader returning the parsed
   * document could not carry it without also becoming a group resolver.
   *
   * ⚠️ **It may THROW, and the throw PROPAGATES — this is the third member of the
   * propagating set named in {@link runWarehouseProducer}'s contract, alongside the
   * reach and the vocabulary, and unlike every per-entity seam around it.** The
   * shipped implementation reads the internal DB, so a transient outage rejects
   * here. Degrading to an empty answer instead would be indistinguishable from *"no
   * entity is group-scoped"* — which is precisely #5284, applied to the whole
   * workspace at once. A run that cannot establish where to read is abandoned
   * rather than pointed at the default datasource.
   */
  readonly resolveConnectionIds?: (
    workspaceId: string,
    entities: readonly WarehousePlacementTarget[],
  ) => Promise<WarehouseConnectionPlacement>;
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

/**
 * What the entity-edge pass did — ONE discriminated union, replacing the three
 * parallel report fields #5043 shipped (#5277).
 *
 * ⚠️ **The three fields could spell states that do not exist, and could not spell
 * one that does.** `entityEdges: AliasProducerCounters | null`,
 * `entityEdgesFailed: string | null` and `entityEdgesAmbiguous: number` are 2 × 2
 * independent shapes, of which "counters AND a failure message" was never a run
 * and "no counters, no message, ambiguous: 0" meant four different things. The
 * one state they could NOT spell is the one that matters most.
 *
 * ⚠️ **PARTIAL PROGRESS, which the old shape could not represent at all.**
 * `proposeAliasEdges` COMMITS PER PROPOSAL and an auto-approved entity edge
 * RE-KEYS THE CORPUS, so a mid-batch throw leaves approved edges behind. Under
 * the old fields, "threw before proposing anything" and "threw after committing
 * 900 edges" were the same two wire values — `entityEdges: null` plus a message
 * — and the prose said so while the type could not. {@link EntityEdgeProgress}
 * is what separates them.
 *
 * ⚠️ **NO NULLABLE FIELDS, and the first cut of this union had three.** That cut
 * put `entries: number | null`, `ambiguous: number | null` and
 * `proposalsAttempted: number` side by side on one `failed` arm, which spells
 * three combinations that are not runs — *counted five in a store never read*,
 * *submitted four without reading*, *submitted before planning*. Its own tests
 * asserted the impossibility in PROSE (`entries: null` … "so
 * `proposalsAttempted` is necessarily 0"), which is the shape #5277 exists to
 * remove, one arm in: 4 illegal states became 3 rather than 0. What actually
 * varies is HOW FAR THE PASS GOT, and that is one discriminant, not three
 * nullable fields — so it is spelled as one.
 */
export type EntityEdgeOutcome =
  // ⚠️ Pinned EXACTLY against `BrainEntityEdgeOutcomeSchema` by
  // `_reportMatchesWireSchema` in `api/routes/admin-brain-enrollment.ts`. Editing
  // this union without the schema reds a route rather than shipping a wire lie —
  // but the pin lives in a third file, so it is named here where someone editing
  // will see it.
  /**
   * The pass ran and had nothing to propose.
   *
   * ⚠️ NOT "the run wrote no entries". The batch comes from the PERSISTED,
   * workspace-wide store, so a run that wrote nothing still proposes when prior
   * entries exist, and a run that wrote 500 natural-key entries lands HERE
   * because every one is a self-edge.
   *
   * ⚠️ **All THREE refusal reasons are carried beside `entries`, and an earlier cut
   * carried only `ambiguous`.** It enumerated three causes in prose and claimed
   * `entries` told them apart;
   * `entries` separates only empty from non-empty, and {@link unmintedIds} was
   * missing from the enumeration entirely. So `{entries: 500, ambiguous: 0}` was
   * byte-identical for a healthy all-natural-key store and for 500 rows whose ids
   * no producer could have minted — one resolves every surface, the other
   * resolves nothing ever, and the remedies are "none" and "re-import". That is
   * this union's own charter failing one counter over.
   */
  | {
      readonly kind: "nothing-to-propose";
      readonly entries: number;
      readonly ambiguous: number;
      readonly selfEdges: number;
      readonly unmintedIds: number;
    }
  /**
   * The batch ran to completion.
   *
   * ⚠️ `counters.rejected` is THE number to read on a re-run. A producer whose
   * second pass reports zero there is one whose human removals did not stick —
   * #4507's permanent rejection memory failing open, which re-creates an edge a
   * person deleted and re-keys their corpus with it.
   */
  | {
      readonly kind: "proposed";
      readonly entries: number;
      readonly ambiguous: number;
      readonly selfEdges: number;
      readonly unmintedIds: number;
      /**
       * ⚠️ `Readonly<…>` because {@link AliasProducerCounters} declares six
       * MUTABLE fields — `vocabulary-decide.ts` builds them by mutation — so a
       * bare `readonly counters` freezes the reference and leaves
       * `report.entityEdges.counters.queued = 0` compiling on a returned report.
       * Every other field on this report is deeply immutable; this was the hole.
       */
      readonly counters: Readonly<AliasProducerCounters>;
    }
  /**
   * The pass threw. Every fact and store entry is still committed — this arm
   * exists so a caught-and-logged failure cannot leave the report
   * indistinguishable from a healthy run.
   *
   * ⚠️ **`message` is a FIXED sentence plus the correlation handle, NEVER
   * `err.message`.** Both throw sources are internal-DB-backed, so the raw message
   * is a `pg` one — `connection to server at "10.x.x.x" … FATAL: password
   * authentication failed for user "atlas"` puts a host and a role in a 200 body.
   * This module refuses exactly that for `snapshot-failed`; #5043's first cut of
   * the old field did not, and this arm inherits the rule rather than re-deciding
   * it.
   */
  | {
      readonly kind: "failed";
      readonly reached: EntityEdgeProgress;
      readonly message: string;
    };

/**
 * How far the pass got before it threw — the knowability boundary, as a type.
 *
 * ⚠️ **Each phase carries exactly the numbers that phase has ESTABLISHED, and no
 * others.** That is the whole design: a field is absent where it is unknown
 * rather than present-and-null, so "the store was never read" cannot be spelled
 * alongside a count of anything, and "four proposals were submitted" cannot be
 * spelled without the census that produced them. The three impossible states the
 * nullable-field version admitted are unrepresentable here rather than refused by
 * a comment.
 *
 * The phases are the pass's three sequential steps, in order.
 */
export type EntityEdgeProgress =
  /**
   * NO STORE WAS OBTAINED — the read threw, or it answered a shape that is not a
   * store. Nothing is known and nothing can have been written, so no count is
   * reported because none was taken.
   *
   * ⚠️ Not "the read threw", which is what this line said until the non-array guard
   * was added below: that guard lands here too, and there the read RETURNED.
   *
   * ⚠️ This is the arm that used to be `entries: null`, and the reason it was
   * right to distinguish: reporting `0` for a store nobody looked at is ADR-0039's
   * invisibility in miniature — "we looked and found nothing", told to an operator
   * whose store may hold every row it ever did.
   */
  | { readonly phase: "store-read" }
  /**
   * The store was read; planning the batch threw.
   *
   * `entityEdgeProposals` is a pure function over an array already in memory, so
   * reaching here means a code defect rather than an operational event — which is
   * exactly why it must be reportable rather than folded into a neighbouring arm.
   * Nothing has been submitted, so nothing can have been committed.
   */
  | { readonly phase: "planning"; readonly entries: number }
  /**
   * The batch was HANDED TO the vocabulary seam, and the seam threw part-way.
   *
   * ⚠️ "Handed to", not "submitted to the database". The assignment happens before
   * the await, so a throw inside the seam's dynamic `import()` lands here having
   * written nothing at all — the phase means the batch left this function, which is
   * the only thing this function can honestly claim.
   *
   * ⚠️ {@link proposalsAttempted} is the count HANDED OVER, not the count
   * COMMITTED. `proposeAliasEdges` returns its counters only on success, so a
   * throw takes them with it — the batch size is the honest UPPER BOUND on the
   * blast radius, and the alias-producer's own aborted-batch log line for this
   * request carries the real counts.
   *
   * ⚠️ **Possibly NONE of them committed**, and an earlier version of this note
   * said an unknown prefix definitely had. An operator reading "an unknown prefix
   * is committed" would go and audit a corpus that was never touched.
   */
  | {
      readonly phase: "proposing";
      readonly entries: number;
      readonly ambiguous: number;
      readonly selfEdges: number;
      readonly unmintedIds: number;
      readonly proposalsAttempted: number;
    };

export interface WarehouseProducerReport {
  readonly workspaceId: string;
  readonly snapshotAt: string;
  /** Pairs in the reach — the number a coverage surface compares everything else against. */
  readonly enrolled: number;
  readonly entities: readonly WarehouseEntityOutcome[];
  readonly refusals: readonly WarehouseRefusal[];
  readonly created: number;
  readonly corroborated: number;
  /** What the entity-edge producer did with this run's edges (#5043, #5277). */
  readonly entityEdges: EntityEdgeOutcome;
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
/**
 * The snapshot episode's `source_id` — `warehouse:<entity>@<ISO instant>`.
 *
 * A stored key, so its format is frozen for the same reason
 * `slackEpisodeSourceId`'s is: a reformat re-reads every entity in every
 * workspace as a fresh snapshot.
 *
 * Exported alongside {@link parseWarehouseEpisodeEntity} because a SECOND reader
 * now exists — the Coverage Surface's warehouse enumeration (#5213) recovers the
 * entity from this id to decide which enrolled pairs have produced evidence. Two
 * hand-written spellings of one format is how a build and a parse drift apart
 * silently; a builder and its inverse in one place is how they cannot.
 */
export function warehouseEpisodeSourceId(entity: string, snapshotAt: Date): string {
  return `warehouse:${entity}@${snapshotAt.toISOString()}`;
}

/**
 * {@link warehouseEpisodeSourceId}'s inverse — the entity, or `null` when the id
 * is not one this producer minted.
 *
 * Splits on the LAST `@` rather than the first: an ISO-8601 instant contains
 * none, so everything after the final one is the timestamp and everything before
 * it is the entity name — which recovers entity names that themselves contain
 * `@`. Splitting on the first would truncate those to their local part and
 * silently attribute their evidence to an entity that does not exist.
 */
export function parseWarehouseEpisodeEntity(sourceId: string): string | null {
  const prefix = "warehouse:";
  if (!sourceId.startsWith(prefix)) return null;
  const at = sourceId.lastIndexOf("@");
  if (at < prefix.length) return null;
  const entity = sourceId.slice(prefix.length, at);
  return entity === "" ? null : entity;
}

async function insertSnapshotEpisode(
  tx: ReconcileExecutor,
  params: {
    readonly workspaceId: string;
    readonly entity: string;
    readonly sql: string;
    readonly snapshotAt: Date;
  },
): Promise<{ id: string; sourceId: string } | null> {
  const sourceId = warehouseEpisodeSourceId(params.entity, params.snapshotAt);
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

/** What {@link seamRead} returns when a seam-controlled accessor THREW. */
const SEAM_THREW = Symbol("seam-threw");

/**
 * Read ONE property off a value the validator seam controls, totally.
 *
 * ⚠️ **Narrowing the container is not enough.** `isRecord(validated)` answers `true`
 * for `{ get entity() { throw … } }`, so the property access itself runs
 * seam-controlled code. The refusal arms of {@link runWarehouseProducer} have NO
 * enclosing `try` — the per-entity catches wrap the validator call, the snapshot and
 * the transaction, and the arms sit between them — so a throw here escapes the loop
 * and turns ONE refused entity into a 500 for the whole run, losing the forensic
 * payload the line exists to produce.
 *
 * Absent and non-record both answer `undefined`, which {@link seamString} renders as
 * `<undefined>`; a throw answers {@link SEAM_THREW}, which renders as `<threw>`. The
 * three stay distinguishable, which is the whole point of the arm.
 */
function seamRead(source: unknown, key: string): unknown {
  try {
    // ⚠️ `isRecord` belongs INSIDE the `try`: it calls `Array.isArray`, which throws
    // on a revoked Proxy rather than answering, while `typeof` and `!== null` pass one
    // cleanly first. The general rule, and it cost three instances to learn:
    // **narrowing is an OPERATION on the seam value, not a fact about it.** Anything
    // that dispatches on the object — a property read, `Array.isArray`, a template
    // literal, `toString` — goes inside the guard, never in front of it.
    if (!isRecord(source)) return undefined;
    return source[key];
  } catch {
    // NOT silence, so this takes a plain comment rather than CLAUDE.md's
    // `intentionally ignored` marker: the sentinel IS the signal, and it reaches the
    // operator on the same log line as the field it replaces, alongside
    // `returnedReadThrew`.
    //
    // The Error is dropped because it comes from the seam under audit, so it is
    // evidence of nothing, and the field's own sentinel already says which read
    // failed. Not because logging it would be unsafe: `scrubErrSerializer` has a
    // total outer catch and renders a hostile one as `[log scrub failed]`.
    return SEAM_THREW;
  }
}

/**
 * A string from the validator seam — total, bounded, and honest about truncating.
 *
 * The mismatch and rejection arms log values the seam controls, and
 * `undefined.slice(0, 200)` on a verdict cast from `{}` threw out of the log call and
 * past the per-entity contract. A sentinel in the payload says what came back; a 500
 * says nothing and loses the other fields too.
 *
 * The length suffix matters on THIS line specifically: its whole job is comparing
 * what came back against what was sent, and a silently truncated 5,000-character
 * value is indistinguishable from a genuine 200-character one.
 *
 * Honest bound: a returned value that literally spells `"<undefined>"` is
 * indistinguishable from an absent one. An operator reading this line is already
 * looking at a gate that answered about the wrong request.
 */
function seamString(value: unknown): string {
  if (value === SEAM_THREW) return "<threw>";
  if (typeof value === "string") {
    return value.length > 200 ? `${value.slice(0, 200)}…(${value.length})` : value;
  }
  // ⚠️ An `Error` is the likeliest non-string a plugin-supplied or future validator
  // puts in `error`, and without this arm it rendered `<object>` — `undefined` with
  // extra steps, on a PERMANENT refusal whose own text says re-running will not
  // help. That is the generic message CLAUDE.md forbids, arriving through the
  // renderer added to remove it. `.message` is itself a seam read, so it is guarded
  // like every other one.
  try {
    if (value instanceof Error) {
      const message = value.message;
      if (typeof message === "string") return seamString(message);
    }
  } catch {
    // Not silence — `<threw>` is the signal, and it is the same sentinel every other
    // failed seam read on this line renders.
    return "<threw>";
  }
  return value === null ? "<null>" : `<${typeof value}>`;
}

/**
 * A one-way fingerprint of a snapshot statement, for the gate-mismatch log line.
 *
 * ⚠️ **A DIGEST, and the statement itself is never an option.** The SELECT is
 * assembled from admin-authored `table:` and `sql:` expressions, so it can carry a
 * column name — and, through a `sql:` expression, a literal — that identifies a
 * customer. CLAUDE.md forbids that reaching a log, and the mismatch arm is exactly
 * where an operator most wants to see the statement, which is what makes writing
 * the rule down here worth the lines.
 *
 * Truncated to 16 hex characters, matching `logger.ts`'s `hashShareToken` and
 * `learn/pattern-analyzer.ts`. This is a CORRELATION fingerprint, not a security
 * primitive: the entity is refused either way, so the only thing a collision buys is
 * a forged statement logged as if it were a replay, and 64 bits against a target the
 * attacker does not choose is not the cheap way to achieve that.
 *
 * ⚠️ **It takes a `string`, and that is the point of the split from
 * {@link seamSqlDigest}.** With one `unknown`-taking function used on both sides, two
 * absent statements digest to the SAME sentinel and `sqlDigestMatch` reports `true` —
 * a forgery logged as a match, the exact inversion this field exists to prevent. The
 * submitted side is a string by construction ({@link buildSnapshotSql} returns one);
 * this signature is what makes that a compile error to break rather than a paragraph
 * to believe.
 */
function sqlDigest(sql: string): string {
  return createHash("sha256").update(sql).digest("hex").slice(0, 16);
}

/**
 * {@link sqlDigest} for the RETURNED side, where the value may be anything.
 *
 * Non-strings render through {@link seamKind}, so `sql` gets the same sentinel
 * vocabulary as every other seam field on the line — `<undefined>`, `<null>` and
 * `<number>` are three different wiring faults in a substituted validator, and `sql`
 * is the field that identifies the forgery class, so it is the last one that should
 * collapse them.
 *
 * ⚠️ **{@link seamKind}, NOT {@link seamString}, and the difference is a hole that
 * was measured open.** `seamString` renders an `Error` by its message, so a verdict
 * carrying `sql: new Error("f52e4d03c838ad9d")` put an attacker-chosen 16-hex string
 * in `returnedSqlDigest` — indistinguishable from a real digest to the operator
 * reading the line, and equal to the submitted one if they copy it. Every value
 * `seamKind` returns is bracketed, so nothing in this function's range can be
 * mistaken for a digest.
 */
function seamSqlDigest(value: unknown): string {
  return typeof value === "string" ? sqlDigest(value) : seamKind(value);
}

/**
 * WHAT KIND a seam value is — never what it CONTAINS.
 *
 * Exists so the shape test is never written inline at a call site: `isRecord(x)` in a
 * log payload is an unguarded seam operation for the reason {@link seamRead} gives,
 * and it read as obviously safe both times it was written that way.
 *
 * ⚠️ **Renders the TYPE, never the value.** Falling through to {@link seamString}
 * echoed a returned request that happened to be a STRING verbatim — and a validator
 * that crosses a wire, or a serialising proxy, answers `JSON.stringify(request)`,
 * which is the whole SELECT with its table and column names. That is the one thing
 * {@link sqlDigest} exists to keep out of the log. Rendering `<string>` loses
 * nothing: the field's job is to tell the malformations the fixture table lists
 * apart, and the bracketed vocabulary still does.
 *
 * Every value in the range is BRACKETED, the record case included: `"object"` beside
 * a sentinel `"<object>"` for an ARRAY was two characters apart with opposite
 * meanings, so a filter written for one silently missed the other.
 */
function seamKind(value: unknown): string {
  // The same sentinel `seamString` uses. Reachable through {@link seamSqlDigest},
  // whose input is a `seamRead` result: without this arm a thrown `sql` read rendered
  // `<symbol>`, which names the marker's implementation rather than what happened.
  if (value === SEAM_THREW) return "<threw>";
  try {
    if (isRecord(value)) return "<record>";
    return value === null ? "<null>" : `<${typeof value}>`;
  } catch {
    // The same non-silence as `seamRead`'s: the sentinel reaches the operator on the
    // log line, and the Error is dropped because it comes from the seam under audit.
    return "<threw>";
  }
}

/**
 * `err instanceof WarehouseProducerContractError`, made total (#5257).
 *
 * ⚠️ **`instanceof` walks the prototype chain, so it is an OPERATION on a value a
 * seam chose — {@link seamRead}'s rule, arriving at the one site written to keep a
 * seam's failure from taking the run down.** The transaction catch classifies
 * whatever `withTransaction` rejected with, and a revoked Proxy there threw out of
 * the classification itself: measured escaping `runWarehouseProducer` with ZERO log
 * lines, from inside the handler whose entire purpose is turning a failed
 * transaction into one refused entity plus an `error` line naming what had already
 * committed.
 *
 * ⚠️ **`false` on a throw, and the direction is the safe one rather than a
 * fallback CLAUDE.md forbids.** `false` routes the value to the per-entity refusal,
 * which LOGS it at `error` and accounts for every pair — so nothing is swallowed.
 * `true` would re-throw, which is the 500-for-the-whole-run this arm exists to
 * prevent, chosen on the strength of a prototype walk that just failed. A hostile
 * value cannot be one of this module's own contract defects anyway: the sole
 * {@link WarehouseProducerContractError} in this file is constructed at its throw
 * expression, so a value that defeats `instanceof` did not come from there.
 *
 * ⚠️ **`threw` travels beside the answer, and dropping it was a measured hole.** This
 * file spends paragraphs keeping "the read THREW" apart from "the read did not
 * match" — {@link SEAM_THREW}, `<threw>`, `returnedReadThrew` — and a bare `boolean`
 * collapsed *the classification itself failed* into *not a contract error*. Measured
 * against the REAL logger rather than the suite's mock, the resulting line said only
 * `err: "[log scrub failed]"`: it named neither what came back nor that the check had
 * failed, which is the generic message CLAUDE.md forbids, on the incident line.
 *
 * ⚠️ **Not a type predicate, and that is a decision rather than an oversight.** There
 * is exactly ONE call site, and it re-throws the value as `unknown`, so a predicate
 * narrows nothing anybody uses — and a predicate cannot also carry `threw`, which is
 * the half with a measurement behind it. Split it if a second call site ever wants
 * the error's fields.
 */
function seamContractCheck(err: unknown): { readonly isContract: boolean; readonly threw: boolean } {
  try {
    return { isContract: err instanceof WarehouseProducerContractError, threw: false };
  } catch {
    // Not silence — `contractCheckThrew` reaches the operator on the error line the
    // caller emits next. See above for why the answer is `false` rather than a
    // re-throw.
    return { isContract: false, threw: true };
  }
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
 * Errors from the reach, the vocabulary and the CONNECTION RESOLUTION PROPAGATE: an
 * empty reach and a failed reach read produce identical silence (ADR-0039's *"a
 * producer nobody enrolls anything into leaves M4 exactly as dead as it is today,
 * with every test green"*), and a swallowed one would be indistinguishable from the
 * honest zero. The third is the same argument on the datasource axis — a resolution
 * that failed and a workspace that scopes nothing by group both look like an empty
 * placement, and reading the first as the second is #5284 applied to every entity at
 * once. Only the connection resolution logs before rethrowing; the reach and the
 * vocabulary reads propagate unlogged.
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
  const resolveConnectionIds = deps.resolveConnectionIds ?? defaultResolveConnectionIds;
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

  // ⚠️ **The group collision is settled BEFORE anything is placed or read, and
  // the entities it names are excluded from both (#5286).**
  //
  // Enrollment is group-scoped since 0205, so an admin can enroll two published
  // `test_orders` — two entities, two databases, one NAME. Every key this
  // producer goes on to write carries that name and no group, so producing both
  // would file two subjects as one. Refused rather than merged; the arm's own
  // sentence in `planWarehouseEmission` carries the argument.
  //
  // Excluded from PLACEMENT as well as from the entity read, because a name with
  // two groups has two right answers there too — and `placed` is a map keyed by
  // name, so the second would silently overwrite the first.
  const collidingGroups = new Map<string, readonly (string | null)[]>();
  const placementTargets: WarehousePlacementTarget[] = [];
  for (const name of reach.entities) {
    const groups = [...(reach.groupsByEntity.get(name) ?? new Set<string | null>())];
    if (groups.length > 1) {
      collidingGroups.set(name, groups);
      continue;
    }
    // `groups[0]` is the enrollment's own group; `undefined` cannot occur for a
    // name that is in `entities` (it is derived from the same pairs) but is
    // handled as the flat scope rather than asserted away, which keeps this
    // file's non-null-assertion count at zero.
    placementTargets.push({ entity: name, group: groups[0] ?? null });
  }
  if (collidingGroups.size > 0) {
    log.warn(
      { ...runLog, entities: Object.fromEntries(collidingGroups) },
      "Warehouse producer: an entity name is enrolled under more than one connection group — every pair naming it is refused, because the keys this producer writes carry the name and not the group",
    );
  }

  // ONE resolution per run, not one per entity — and deliberately not inside the
  // `Promise.all` below: every enrolled entity of one group shares an answer, and
  // the lookup reads the workspace's visible groups each time it is called.
  //
  // ⚠️ Log-and-RETHROW, not the `// intentionally ignored:` marker, which means
  // silence. The throw is the intended behaviour (see the seam's docstring) but it
  // previously left no line carrying this run's own context, so a 500 from a DB blip
  // here was indistinguishable at the log from one raised anywhere else in the run.
  let placement: WarehouseConnectionPlacement;
  try {
    placement = await resolveConnectionIds(workspaceId, placementTargets);
  } catch (err) {
    log.error(
      { ...runLog, err: err instanceof Error ? err.message : String(err) },
      "Warehouse producer: could not resolve which datasource the enrolled entities read — the run is abandoned rather than reading the deployment default for every one of them",
    );
    throw err;
  }
  const connectionIds = placement.placed;
  /** Enrolled name → why it has no connection. Refused below, never defaulted. */
  const unplaceable = new Map(placement.unplaceable.map((u) => [u.entity, u.cause]));

  // ⚠️ The one line an operator has to find when an entity reads the wrong database.
  // This seam chooses WHICH customer datasource is read and logged nothing at all
  // until #5284 — while the refusal messages it can produce point the operator at this
  // run's server log. `unplaced` is the benign flat-scope
  // set; `unplaceable` is the refused one, and they are separate fields because
  // collapsing them is the ambiguity the placement type exists to remove.
  log.info(
    {
      ...runLog,
      placed: Object.fromEntries(connectionIds),
      unplaced: placementTargets
        .map((t) => t.entity)
        .filter((name) => !connectionIds.has(name) && !unplaceable.has(name)),
      unplaceable: Object.fromEntries(unplaceable),
    },
    "Warehouse producer: resolved each enrolled entity's connection group",
  );

  // One entity read per DISTINCT entity, not one per pair — `placementTargets`
  // is that set minus the colliding names filed above, and it is the same set
  // the fail-closed rule is evaluated across.
  const entityShapes = new Map<string, WarehouseEntityLookup>();
  for (const [name, groups] of collidingGroups) {
    entityShapes.set(name, { kind: "enrolled-in-two-groups", groups });
  }
  // ⚠️ **Seeded BEFORE the lookups, and the unplaceable names are skipped rather
  // than read (#5286 review).** Two things this fixes, and the first is the one
  // that matters.
  //
  // A lookup that answers `not-published` OVERWRITES nothing — it would simply
  // be the entry that `planWarehouseEmission` reads, and the pair would be
  // refused *"Publish the entity"* for one that is published under two groups
  // and merely unaddressable. The placement already knows the honest cause; the
  // read cannot improve on it and can only replace it with a worse sentence.
  //
  // The second is that the read is wasted work against the internal DB for an
  // entity nothing will be built from.
  for (const [name, cause] of unplaceable) {
    entityShapes.set(name, { kind: "unplaceable", cause });
    log.warn(
      { ...runLog, entity: name, cause },
      "Warehouse producer: no connection could be resolved for the entity — refused rather than read against the deployment default",
    );
  }
  await Promise.all(
    placementTargets
      .filter(({ entity: name }) => !unplaceable.has(name))
      .map(async ({ entity: name, group }) => {
      // ⚠️ CAUGHT, and the `Promise.all` is why. `getAdminEntity` throws
      // `AmbiguousEntityError` for a name it is asked to resolve WITHOUT a group
      // when more than one answers — and an uncaught throw here rejects the whole
      // `Promise.all`, killing the run for every unrelated enrolled entity and
      // returning a 500 in place of the report whose entire job is explaining why
      // a pair produced nothing.
      //
      // ⚠️ Since #5286 that throw is no longer the ORDINARY multi-group case: the
      // enrollment names its group and `group` above carries it, so a normal
      // multi-group workspace resolves. What remains reachable is a pre-0205
      // flat-scoped row in a workspace that has since grown a second group — a
      // real state, and one whose remedy is to re-enroll the pair against the
      // group it meant.
      let raw: Record<string, unknown> | null;
      try {
        raw = await loadEntity(workspaceId, name, group);
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
            "looking it up failed. If the pair was enrolled before enrollments recorded a connection " +
            "group, and this workspace now publishes that name under more than one, Atlas cannot tell " +
            "which was meant — un-enroll it and enroll it again to pick one. The lookup can also fail " +
            "transiently. The server log for this run carries the reason.",
        });
        return;
      }
      if (raw === null) {
        entityShapes.set(name, { kind: "not-published" });
        return;
      }
      // ⚠️ **A NON-RECORD ANSWER IS AN ATLAS FAULT, AND WITHOUT THIS IT WAS THE
      // QUIETEST ARM IN THE FILE** (#5257 review, round 2). `parseWarehouseEntity`
      // reads `raw.table` through `nonEmptyString`, which answers `undefined` for a
      // string, a number or an array rather than throwing — so a loader returning
      // `"yaml"` or `[]` sailed past the parse guard, landed on the `no-table` arm,
      // and told the admin *"its YAML declares no `table:` … Fix the entity YAML"*
      // with ZERO log lines. That is the misdirection the `unreadable-shape` split was
      // written to remove, surviving one arm over, and worse: the other two arms at
      // least `warn`.
      //
      // `defaultLoadEntity` casts its column to a record unchecked, and this module is
      // documented as callable with a YAML record read from disk, so the shape is a
      // claim rather than a fact.
      if (!isRecord(raw)) {
        log.warn(
          { ...runLog, entity: name, loaderAnswered: seamKind(raw) },
          "Warehouse producer: the entity loader answered something that is not an entity record — its pairs are refused, the rest of the run continues",
        );
        entityShapes.set(name, {
          kind: "unreadable",
          cause: "unreadable-shape",
          why:
            "Atlas could not read the stored entity — its loader answered something that is not an " +
            "entity record. This is an Atlas fault rather than a problem with the entity; the server " +
            "log for this run carries the reason.",
        });
        return;
      }
      // ⚠️ **THE PARSE IS GUARDED, AND IT GETS ITS OWN ARM RATHER THAN SHARING
      // `load-threw`'s (#5257).** {@link parseWarehouseEntity} does `raw.table`,
      // `Object.entries(raw.dimensions)` and `isRecord` — every one an operation on a
      // value this seam returned, per {@link seamRead}'s rule, and unguarded a
      // `{ get table() { throw } }` entity rejected the whole `Promise.all`: the exact
      // 500 the catch above exists to prevent, measured.
      //
      // ⚠️ **A SEPARATE `try`, and folding it into the one above was the first
      // draft's mistake.** `load-threw`'s `why` enumerates two causes — an ambiguous
      // name and a transient lookup failure — and BOTH are wrong here: the lookup
      // SUCCEEDED, and a malformed record fails identically on every run until someone
      // edits the YAML. Sharing the arm would have handed the admin "audit your
      // connection groups" and "wait and retry" for a permanent fault with a concrete
      // remedy, which is the misdirection that arm's own comment says it removed.
      let entity: WarehouseEntity | null;
      try {
        entity = parseWarehouseEntity(name, raw);
      } catch (err) {
        log.warn(
          { ...runLog, entity: name, err },
          "Warehouse producer: the entity's YAML could not be read — its pairs are refused, the rest of the run continues",
        );
        entityShapes.set(name, {
          kind: "unreadable",
          cause: "unreadable-shape",
          why:
            "its stored YAML could not be read — a field of it threw or is not the shape this producer " +
            "parses. This does not change between runs: fix the entity YAML, or un-enroll the pair. The " +
            "server log for this run carries the reason.",
        });
        return;
      }
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

  /**
   * The entity-edge producer (#5043), returning its {@link EntityEdgeOutcome} (#5277).
   *
   * ⚠️ **RETURNS its outcome rather than assigning three closure variables.** The
   * previous shape needed an initial value for each — `null`, `null`, `0` — which
   * is a claim about a pass that has not run, and the `0` in particular was
   * indistinguishable from a real "no ambiguity" answer. Nothing enforced that both
   * exits assign before building their report; the type now does.
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
   * operator is asking why their store stopped working, and it reported the
   * then-flat `entityEdgesAmbiguous: 0` over a store that might be entirely
   * ambiguous.
   *
   * ⚠️ **Its cost, stated honestly rather than as "one indexed read".** On a
   * non-empty store this runs two sequential `proposeAliasEdge` calls per entry
   * that EARNS an edge — up to `2 × entries`, and zero for a wholly natural-key
   * store — each opening a transaction and taking the workspace vocabulary lock,
   * on EVERY run including a no-op re-run. At the row cap across several entities
   * that is thousands of serialized lock-taking transactions per button press.
   *
   * ## The change-detector: DECIDED, not deferred again (#5277)
   *
   * #5233 recorded a detector as "the answer" — skip when no `snapshot_at` moved
   * and the previous run was all `alreadyApproved`/`deduped`. #5277 is the round
   * that had to build it or say why not, and the answer is **the cost is accepted
   * at today's cadence**, for three reasons, in the order that decided it:
   *
   *   1. **That predicate is UNSOUND for the counter the pass exists to report.**
   *      `rejected` is what says a human's removal STUCK — #4507's permanent
   *      rejection memory failing open is the failure it watches for. A human
   *      rejecting an edge between two runs moves no `snapshot_at` and changes no
   *      previous-run counter, so the sketched predicate skips exactly the re-run
   *      that would have reported on it. A detector that silences `rejected` is a
   *      detector that removes this pass's whole observability contribution while
   *      reporting success, which is ADR-0039's invisible failure with a
   *      performance justification attached.
   *   2. **It needs state that does not exist.** "The previous run was all
   *      `alreadyApproved`/`deduped`" is a claim about a PREVIOUS RUN, and no run
   *      is persisted — the report is returned to an HTTP caller and dropped.
   *      `brain_entity` carries no run watermark. So a detector is a new table or
   *      column, a migration, a `schema.ts` mirror and a `-pg` smoke, whose own
   *      staleness failure mode is again the invisible one.
   *   3. **The cost is now per-interval, not per-press** (#5228 landed). The
   *      cadence runs the whole reach on a schedule, so the edge pass's
   *      lock-taking transactions recur whether or not anything moved. What
   *      bounds them is no longer a human's patience but
   *      `ATLAS_BRAIN_WAREHOUSE_CADENCE_INTERVAL_HOURS` — default 24h, floored
   *      at 1h, and OFF unless a workspace and the platform both opt in.
   *
   * ⚠️ **The bound moved; it did not disappear, and this is the line to re-read
   * if the floor is ever lowered.** Points 1 and 2 are unchanged and remain the
   * constraints any change-detector has to satisfy. (This paragraph used to say
   * the decision expired when #5228 landed, and named whoever built the cadence
   * as its owner — that is this note.)
   */
  const runEntityEdgePass = async (): Promise<EntityEdgeOutcome> => {
    // ⚠️ ONE variable declared OUTSIDE the try, advanced as each step ESTABLISHES
    // its numbers, and read by the catch. Three nullable locals were the first cut
    // and they let the catch assemble combinations no step could produce; a single
    // discriminated value can only ever hold what one phase actually knows.
    let reached: EntityEdgeProgress = { phase: "store-read" };
    // Failing here must NOT fail the run. Every fact is committed, and a throw
    // reaches `runEffect` as `500 "Failed to run"` — which invites the one retry
    // that files a second full round of drafts into the review queue.
    try {
      const store = await loadStore(workspaceId);
      // ⚠️ ADDITIVE guard: it can only ever refuse more. A seam resolving a
      // non-array is a lying seam rather than an operational failure, and without
      // this `store.length` is `undefined` — which flows into the report as an
      // `undefined` count, fails `BrainWarehouseRunReportSchema`, and hands the
      // operator "the report could not be serialized" instead of "the entity-edge
      // pass failed". Throwing puts it on the arm that describes it, and the
      // message never reaches the body because the body's sentence is fixed. The
      // sibling snapshot seam is hardened for exactly this reason; this one was not.
      if (!Array.isArray(store)) {
        throw new TypeError("the entity-store seam resolved a non-array");
      }
      // `reached` advances only AFTER the read returned, so a throw above keeps
      // `store-read` and reports no count at all.
      reached = { phase: "planning", entries: store.length };
      const batch = entityEdgeProposals(store);
      // Every reason an entry produced no proposal — THREE of them, disjoint by
      // construction (`entity-store.ts`) — beside the `entries` they partition.
      // Carried together because the report's job is to say WHY there was nothing to
      // do, and all three are invisible in `entries` alone.
      const census = {
        entries: store.length,
        ambiguous: batch.ambiguous,
        selfEdges: batch.selfEdges,
        unmintedIds: batch.unmintedIds,
      };
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
      if (batch.proposals.length === 0) {
        return { kind: "nothing-to-propose", ...census };
      }
      // ⚠️ Advanced BEFORE the await, not after. Its whole job is to be true when
      // the await throws.
      reached = { phase: "proposing", ...census, proposalsAttempted: batch.proposals.length };
      return {
        kind: "proposed",
        ...census,
        counters: await proposeEdges(workspaceId, batch.proposals, requestId),
      };
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
      //
      // ⚠️ The sentence is FIXED — the same bytes on every failure, regardless of
      // how far the pass got or what threw. What varies is the STRUCTURED half
      // beside it ({@link EntityEdgeProgress}), which is where a machine reads
      // partial progress off without a caller parsing prose.
      //
      // ⚠️ **The catch is deliberately broad, so it also catches DETERMINISTIC
      // defects** — a `TypeError` in the planner, a substituted seam of the wrong
      // shape, the non-array guard above. "Re-running is safe" is true about
      // double-writes and says nothing about outcomes, so a defect invites the
      // admin to press Run forever, filing another full round of drafts each time.
      //
      // ⚠️ **The permanence test names a comparison the reader can actually make,
      // and the first cut did not.** It said "if it fails again identically" — but
      // this sentence is byte-identical for EVERY failure by design, so two 200
      // bodies always look identical and the instructed comparison always passes. It
      // was also false for a reachable transient: this pass takes the workspace
      // vocabulary lock up to `2 × entries` times, so two presses during a
      // concurrent run repeat identically and are contention, not a defect. The test
      // now points at `reached`, which is the half that genuinely varies, and
      // excludes contention explicitly.
      //
      // ⚠️ **"This is an Atlas fault" is the module's REGISTER, capital and all.**
      // The sibling refusal arms use it, tests assert that exact string on them, and
      // a case-sensitive grep is what an operator runs; the first cut wrote "this is
      // an Atlas fault rather than a transient one", which that grep misses — on the
      // arm most likely to be grepped for.
      const message =
        "The entity-edge pass failed part-way. Any edge it had already proposed is committed — " +
        "the alias-producer log line for this run carries those counts — and every fact and store " +
        // `"unknown"`, matching every other placeholder in this file. Two spellings of
        // one placeholder means an operator grepping support tickets for one misses
        // the other — the rule the snapshot arm already states, applied to the outlier.
        `entry is committed too. Re-running is safe. The server log for request ${
          requestId ?? "unknown"
        } carries the reason. If a re-run on an otherwise idle workspace stops at the same ` +
        "point, the failure is not transient. This is an Atlas fault rather than a problem with " +
        `your data — report it with request id ${requestId ?? "unknown"}.`;
      // `err` raw, so pino's serializer emits the stack — for a pool or lock
      // failure the stack is the actionable half, and the per-entity catch
      // already does it this way.
      //
      // ⚠️ `reached` travels on the LOG as well as the report, and that pairing is
      // the redaction's counterpart: the body withholds the driver's text and
      // promises this line carries the reason, so the line has to exist and has to
      // carry `err`. `warehouse-producer-logging.test.ts` asserts both halves —
      // without it, deleting `err` here left every suite green while the report
      // went on pointing operators at a line with no reason in it.
      log.error(
        { ...runLog, err, reached },
        "Warehouse producer: the entity-edge pass failed part-way — facts and store entries are " +
          "committed, and any edge proposed before the failure is too. Re-run to retry",
      );
      return { kind: "failed", reached, message };
    }
  };

  if (plan.emit.length === 0) {
    // ⚠️ The edge pass runs HERE TOO. Every enrolled pair being refused does not
    // empty the STORE — un-enrolling deletes no entry and no reaper exists yet —
    // so this is the run an operator is most likely to be staring at. See the
    // closure's own note.
    const entityEdges = await runEntityEdgePass();
    log.info(
      { ...runLog, enrolled: reach.pairs.length, refusals: refusals.length, entityEdges },
      "Warehouse producer: nothing to emit — every enrolled pair was refused or the reach is empty",
    );
    return {
      workspaceId,
      snapshotAt: snapshotAt.toISOString(),
      enrolled: reach.pairs.length,
      entities: [],
      refusals,
      entityEdges,
      created: 0,
      corroborated: 0,
    };
  }

  const vocabulary = await loadVocabulary(workspaceId);

  for (const entityPlan of plan.emit) {
    // ⚠️ **The `unplaceable` check that used to sit here has MOVED to the entity
    // lookup (#5286 review), and the move is a fix rather than tidying.** This
    // loop is reached only by an entity that made it into `plan.emit` — published,
    // readable, exactly one primary key — so an unplaceable entity failing any of
    // those was refused for that other reason and its placement cause never
    // reached the report. It is now a {@link WarehouseEntityLookup} arm, which
    // `planWarehouseEmission` refuses ahead of every structural check.
    const sql = buildSnapshotSql(entityPlan, rowCap);
    // ⚠️ FROZEN, one of three things the identity check below needs. Identity proves
    // the gate answered about THIS OBJECT; freezing stops the object changing under
    // it; capturing the returned request ONCE (below) stops a getter answering the
    // guard and the runner differently. `readonly` is erased at runtime, so a
    // substituted validator could validate, then `Object.assign(request, {sql})` and
    // hand the same reference back — passing the check and reaching a customer's
    // datasource with a statement the gate never saw.
    //
    // Frozen, that write fails CLOSED either way, and the two ways differ: an
    // `Object.assign` throws whatever the caller's strictness and lands on the
    // gate-threw arm below; a plain `request.sql = …` in a sloppy-mode caller
    // silently no-ops, so the run proceeds with the statement the gate DID see.
    // Shallow is total here: every field of {@link WarehouseSnapshotRequest} is a
    // primitive, which is a property of that interface rather than of this line.
    // The YAML hint WINS where an author set one: it names a connection directly,
    // which is more specific than the row's group. Resolved once per entity and
    // carried into the frozen `request`; the mismatch arm reads its submitted sides
    // off `request`, never off this binding — see the note there.
    const resolvedConnection =
      entityPlan.entity.connection ?? connectionIds.get(entityPlan.entity.name);
    // ⚠️ **NORMALISED HERE, at the one point both arms converge — and normalising only
    // the group arm was this fix's own second defect.** `"default"` is a real second
    // spelling of the flat default scope, not a hypothetical one: it is what the flat
    // root's implied group is called in `whitelist.ts`, and `connection: default` is a
    // documented entity YAML value. So an author writing it put the literal straight
    // past a guard that had been placed on the resolver instead of on the field.
    //
    // The two spellings are NOT interchangeable downstream, which is the whole point:
    // `defaultRunSnapshot` collapses them (`request.connectionId ?? "default"`) while
    // the gate does not — `validateSQL` takes `getDBType("default")`, which throws
    // `ConnectionNotRegisteredError` until something has touched the default pool,
    // where `undefined` takes `detectDBType()`. That divergence surfaced as a
    // PERMANENT `snapshot-rejected` ("re-running will not change this", blaming the
    // whitelist) for exactly the flat self-hosted workspace this arm protects.
    // Collapsing to `undefined` makes the gate agree with the runner, which is the
    // invariant {@link WarehouseSnapshotRequest.connectionId} states.
    const submittedConnectionId: string | undefined =
      resolvedConnection === "default" ? undefined : resolvedConnection;
    const request: WarehouseSnapshotRequest = Object.freeze({
      workspaceId,
      entity: entityPlan.entity.name,
      connectionId: submittedConnectionId,
      sql,
    });

    // ⚠️ The gate runs HERE, before the seam — and since #5230 the TYPE says so
    // rather than this statement order. While the check lived inside
    // `defaultRunSnapshot`, any injected runner — a test harness today, a scheduler
    // or self-hosted variant tomorrow — satisfied `WarehouseSnapshotRunner` while
    // skipping the SELECT-only, single-statement, whitelist-scoped check entirely.
    // Moving it out fixed that but left the sequence itself a convention; the runner
    // now takes only a `ValidatedSnapshotRequest`, so a reorder does not compile. The
    // statement is assembled from admin-authored `table:` and `sql:` expressions, so
    // it is exactly the input that check exists for.
    // `try`/`catch` rather than `.catch(…)`: a validator that throws SYNCHRONOUSLY
    // does so before the promise exists, so `.catch` never sees it and the throw
    // escaped the whole run as a 500 — contradicting this function's own "caught
    // PER ENTITY" contract two paragraphs up.
    // ⚠️ **THE SEAM'S RETURN VALUE IS TOUCHED IN EXACTLY ONE PLACE, AND IT IS INSIDE
    // THIS `try`.** That is structural, and it is the ratchet this change owes: the
    // same principle — *narrowing is an operation on the seam value, not a fact about
    // it* — was violated three times here in three different spellings
    // (`undefined.slice`, a getter on `.entity`, `Array.isArray` on a revoked Proxy),
    // and a fourth comment would not have stopped a fourth. Reading `valid`,
    // `error` and `request` HERE means the arms below handle only captured values,
    // so no later edit to them can reach a seam accessor at all.
    //
    // The reads were previously `validation.valid` and `validation.request` at the
    // arms themselves, outside every `try` — so a revoked-Proxy or throwing-getter
    // verdict took down the whole run before this change, not only after it.
    //
    // A verdict that is not an object at all — `null`, a revoked Proxy — throws on
    // the discriminant read below and lands on the gate-threw arm, which is the
    // honest one: the gate did not ANSWER. `snapshot-rejected` would tell the admin
    // "re-running will not change this" and to un-enroll a pair that is fine, which
    // is the wrong advice for a broken gate implementation.
    //
    // ⚠️ Three properties, each read ONCE — the rule is per PROPERTY, which is what
    // lets the discriminant be read in the `if` and keeps TypeScript's narrowing.
    // The branded `request` therefore stays branded, and nothing here needs a cast.
    // Keep it that way by discipline rather than by guard: since #5249 the bypass
    // allowlist is a whole-FILE name scan, so a second cast inside this file would
    // be invisible to it.
    let verdictValid: boolean;
    let verdictError: unknown;
    let verdictRequest: ValidatedSnapshotRequest | undefined;
    // ⚠️ **The payload reads are guarded SEPARATELY from the gate call, and the
    // difference decides which arm reports the event.** Folding them into the outer
    // `try` sent a throwing `.request` to the gate-threw arm — a `warn` reading *"the
    // SQL gate threw rather than answering"*, with no digests, no match booleans, no
    // `returned*` fields at all. Detectability is this change's entire deliverable,
    // so a hostile validator would only have had to throw from `.request` to demote
    // its own forgery to something that looks like a transient module-init blip.
    // Guarded here, an unreadable request stays `undefined`, fails the identity check
    // below, and reaches the mismatch arm with `returnedReadThrew: true` — which is
    // the line that exists to report exactly this.
    let verdictRequestThrew = false;
    try {
      const verdict = await validateSnapshotSql(request);
      if (verdict.valid) {
        verdictValid = true;
        verdictError = undefined;
        try {
          // Captured by REFERENCE — the identity check below is about this object, so
          // nothing here may copy, spread or re-wrap it.
          verdictRequest = verdict.request;
        } catch {
          // Not silence: `verdictRequestThrew` reaches the mismatch line as
          // `returnedReadThrew`, and `undefined` is what routes the entity there.
          verdictRequest = undefined;
          verdictRequestThrew = true;
        }
      } else {
        verdictValid = false;
        verdictRequest = undefined;
        try {
          verdictError = verdict.error;
        } catch {
          // Not silence: `seamString` renders this as `<threw>` in both the log and
          // the operator-facing refusal. The gate DID answer invalid, so the entity
          // keeps that verdict's permanence rather than being demoted to transient
          // because its reason was unreadable.
          verdictError = SEAM_THREW;
        }
      }
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
    if (!verdictValid) {
      // ⚠️ **ONE rendering of a value captured ONCE — the mismatch arm's rule, applied
      // to its twin.** `validation.error` was read TWICE here, once into the log and
      // once into the operator-facing message, so a getter could make the two
      // disagree about why the entity was refused. It is the same seam and the same
      // argument: {@link SnapshotSqlVerdict} makes `error` required on the reasoning
      // that the type closes it, and this arm's neighbour exists because a `{}` cast
      // compiles — both cannot be true. Unguarded, `{ valid: false }` produced
      // *"does not pass its SQL gate: undefined"*, the generic message CLAUDE.md
      // forbids, on a refusal whose own text says re-running will not help; a throwing
      // `toString` escaped the template literal as a 500 for the whole run.
      //
      // Bounded at 200, and the bound BITES: measured against the real parser, three
      // of four realistic parse failures produced messages of 201–254 characters,
      // because it lists every expected token. So the tail — the "but X found" clause
      // and the remediation sentence — is cut on the commonest failure. The `…(n)`
      // suffix is what stops that reading as a complete message. The messages carry
      // the table name (already in the sentence) and blocked function names lifted
      // from the submitted query, never row values.
      const reason = seamString(verdictError);
      log.warn(
        { ...runLog, entity: entityPlan.entity.name, reason },
        "Warehouse producer: the snapshot query did not pass SQL validation — refused permanently, not retried",
      );
      refuseEntity(
        entityPlan,
        "snapshot-rejected",
        `The query Atlas would run against "${entityPlan.entity.table}" does not pass its SQL gate: ` +
          `${reason}. The table is probably outside this workspace's ` +
          "whitelist, or a dimension's `sql:` expression is malformed. **Re-running will not change " +
          "this** — fix the entity or un-enroll the pair.",
      );
      continue;
    }

    // ⚠️ **IDENTITY, not equality, and it is the anti-replay check.** The verdict
    // now carries the request it passed, but nothing stops a validator from handing
    // back a genuine token minted for a DIFFERENT statement — `cached ??= await
    // validate(BENIGN_REQUEST)` compiles, forges nothing, and would otherwise let
    // one benign statement authorize every entity in the run. Comparing object
    // identity against what this iteration submitted is the narrowest possible
    // acceptance: a re-serialized or reconstructed request is refused too, which is
    // correct, because the gate's answer is about the object it was given.
    //
    // Transient (`snapshot-failed`), not `snapshot-rejected`: the statement was
    // never judged, so "re-running will not change this" would be a claim about a
    // check that did not happen. It shares the arm with the gate THROWING for the
    // same reason — in both, the gate declined to answer about this entity.
    // ⚠️ **READ ONCE, and this is the other half of freezing the request.** The
    // verdict comes from the very seam this check defends against, so `.request` is
    // an EXPRESSION the implementer controls: a getter or a Proxy answers the guard
    // with the honest request and the runner with another object. Four read SITES
    // across two paths — guard plus two log fields on the mismatch arm, guard plus
    // the runner argument on the passing one — and a per-site read proves nothing
    // about the next. The swapped object also carries its own
    // `workspaceId`/`connectionId`, and `defaultRunSnapshot` selects the pool from
    // those, so the residual was a cross-tenant read rather than only a gate bypass.
    // Freezing closes mutation; capturing closes aliasing; neither closes the other.
    // `reconcile.ts` states the same rule for the same reason.
    //
    // The single read now happens inside the `try` above — see the note there for why
    // it MOVED rather than merely being captured here.
    const validated = verdictRequest;
    // Redundant — `request` is frozen and never `undefined`, so `undefined !== request`
    // already routes here, and TypeScript narrows without the disjunct. Spelled out
    // because a `.request` getter that threw lands here as `undefined`, and that is a
    // state a reader will look for.
    if (validated === undefined || validated !== request) {
      // ⚠️ **FOUR FIELDS, EACH READ ONCE AND EACH GUARDED — the capture rule above,
      // applied one level down.** `validated` is captured, but its PROPERTIES are
      // still expressions the seam controls: a getter answers `.sql` honestly for the
      // digest and dishonestly for the comparison, which is #5230's aliasing finding
      // reproduced inside the line written to report it. And a getter may THROW rather
      // than lie — see {@link seamRead}, where narrowing the container was measured
      // insufficient. Reading each once, through the guard, is what makes every field
      // below a statement about a value rather than about a property access.
      // ⚠️ **RE-TYPED TO `unknown` FOR THIS ARM (#5257).** Reading every field through
      // `seam` is what keeps this arm's growth going through the guard: the shape that
      // recurred three times through #5256's rounds was a direct property read off the
      // typed request.
      //
      // ⚠️ **What it does NOT do, stated because the first draft of this comment
      // claimed otherwise:** the typed binding is still in scope, so a future edit can
      // simply reach for `validated` and typecheck. This buys "a read written through
      // `seam` cannot skip the guard", not "no unguarded read is possible" — review is
      // still the backstop. Making it structural means lifting the arm into its own
      // function so the typed binding is not in scope at all; that is real machinery
      // and deliberately not in this slice.
      const seam: unknown = validated;
      const returnedEntity = seamRead(seam, "entity");
      const returnedWorkspaceId = seamRead(seam, "workspaceId");
      // ⚠️ `connectionId` is on this line because the capture note above names it as
      // the residual: `defaultRunSnapshot` selects the POOL from the returned
      // workspace and connection, so a verdict identical in workspace, entity and
      // statement text but minted for another connection group is a same-workspace,
      // wrong-datasource read — and it was previously indistinguishable here from a
      // benign re-wrap. Two connection groups exposing identically-named tables is an
      // ordinary workspace; it is why `AmbiguousEntityError` exists.
      const returnedConnectionId = seamRead(seam, "connectionId");
      const returnedSql = seamRead(seam, "sql");
      // ⚠️ **Every submitted side below is read off `request`, and the history is why.**
      // This arm used to recompute `entityPlan.entity.connection ?? undefined` locally,
      // which silently stopped matching the request the moment the submitted side
      // gained the connection-group arm — the compared-against value and the submitted
      // value were two spellings, and two spellings drift. Replacing that one
      // recomputation with a hoisted binding fixed the instance and left `entity`
      // re-reading `entityPlan.entity.name` a third time, which is the same class one
      // line over. Reading all four fields off the frozen object closes the class: a
      // legitimately absent connection on both sides still reads as a match, because
      // `request.connectionId` is the `undefined` that was actually submitted.
      // ⚠️ Digests, never the statements — see {@link sqlDigest}. Read off `request`
      // like every other submitted side in this arm, so all four come from one object
      // rather than from four spellings that have to stay in agreement by hand; its
      // `string` parameter type is what stops two absent statements matching.
      const submittedSqlDigest = sqlDigest(request.sql);
      const returnedSqlDigest = seamSqlDigest(returnedSql);
      // ⚠️ **A MATCH CLAIM REQUIRES A READABLE CONTAINER, and leaving that out
      // reproduced — one field over, in this same object literal — the defect the
      // `sqlDigest(sql: string)` split had just closed.** `seamRead` answers
      // `undefined` both for an absent field AND for a non-record, and
      // `request.connectionId` is `undefined` for every default-connection
      // workspace, which is the ordinary case. So `returnedConnectionIdMatch` read
      // TRUE for a verdict that was `null`, `undefined`, a bare string, an array or a
      // number — *"the gate returned no request at all"* reported as *"the connection
      // matched"*, on the field this arm's own comment calls the alert key. (`{}`
      // still reads true, and correctly so — both sides are genuinely absent; see
      // `returnedRequestMatch` below for why that is safe.)
      const returnedRequestType = seamKind(seam);
      const returnedIsRecord = returnedRequestType === "<record>";
      log.error(
        {
          ...runLog,
          entity: entityPlan.entity.name,
          table: entityPlan.entity.table,
          connectionId: seamString(request.connectionId),
          // ⚠️ What CAME BACK, under its OWN keys so `runLog`'s workspaceId is not
          // shadowed. Without these, the replay this branch exists for (a cached
          // token for the first entity) and a token minted against ANOTHER
          // WORKSPACE's statement log identically — and the second is the one that
          // has to be greppable the day it happens.
          //
          // Bounded by `seamString`: every one comes from the seam rather than from
          // the plan, and nothing else on this line is attacker-shaped.
          returnedEntity: seamString(returnedEntity),
          returnedWorkspaceId: seamString(returnedWorkspaceId),
          returnedConnectionId: seamString(returnedConnectionId),
          // Which malformation it was. Without it the non-record verdicts — null,
          // undefined, a string, an array, a number — produce one identical payload of
          // sentinels, the same collapse this arm exists to undo, one level up.
          returnedRequestType,
          returnedReadThrew:
            verdictRequestThrew ||
            returnedEntity === SEAM_THREW ||
            returnedWorkspaceId === SEAM_THREW ||
            returnedConnectionId === SEAM_THREW ||
            returnedSql === SEAM_THREW,
          sqlDigest: submittedSqlDigest,
          returnedSqlDigest,
          // ⚠️ **THREE MATCH BOOLEANS, and the third is not decoration.** Each is
          // derivable from the pair of fields above it and logged anyway, because an
          // alert rule is a FILTER, not a computation: `sqlDigestMatch: false` is one
          // greppable predicate, while "these two hex fields differ" is a join most
          // log pipelines cannot express.
          //
          // ⚠️ **`sqlDigestMatch: true` means THE SAME STATEMENT TEXT — it does NOT
          // mean "benign".** {@link buildSnapshotSql} emits no workspace and no
          // connection, so two workspaces enrolled on the same table with the same
          // dimension names build BYTE-IDENTICAL statements — the normal case for
          // tenants onboarded from one connector template. A token minted against
          // another workspace's request therefore lands here with the digests EQUAL,
          // and an operator alerting only on `sqlDigestMatch: false` would miss the
          // worst forgery this arm can see. The other two booleans are what that alert
          // actually keys on; the naming is deliberate for the same reason.
          //
          // `typeof` first, and it is the second of two independent guarantees: it is
          // redundant while {@link seamSqlDigest} brackets every non-string, and it is
          // what held when that bracketing was briefly absent — a verdict carrying
          // `sql: new Error(<the submitted digest>)` otherwise reported a match.
          sqlDigestMatch:
            typeof returnedSql === "string" && submittedSqlDigest === returnedSqlDigest,
          // ⚠️ **EVERY submitted side is read off `request` — the frozen object that
          // was actually handed to the gate — rather than re-derived here.** Hoisting
          // one binding per field would work and has already failed once: the
          // connection pair drifted the moment the submitted side gained an arm,
          // because "the same value, spelled twice" stops being the same value
          // silently and the comparison goes on returning a boolean. `entity` was
          // still re-reading `entityPlan.entity.name` a third time after that fix,
          // which is the identical class one line up. One source removes the whole
          // class instead of its instances: `request` IS the submitted request, so
          // these cannot disagree with it by construction.
          //
          // Frozen and captured before the gate ran, so a substituted validator
          // cannot move the target either.
          returnedWorkspaceIdMatch: returnedIsRecord && returnedWorkspaceId === request.workspaceId,
          returnedEntityMatch: returnedIsRecord && returnedEntity === request.entity,
          returnedConnectionIdMatch:
            returnedIsRecord && returnedConnectionId === request.connectionId,
          // ⚠️ **THE PREDICATE AN ALERT KEYS ON — the three components above are
          // DIAGNOSTIC and at least one of them cannot carry the alert alone.**
          // `returnedConnectionIdMatch` is `true` for a verdict of `{}`, and that is
          // literally correct rather than a bug: both sides are absent, because the
          // submitted connection is `undefined` for every default-connection
          // workspace. Requiring the field to be PRESENT instead would report every
          // benign default-connection replay as a connection mismatch — noise on day
          // one, which is the failure the whole field was added to avoid. The
          // conjunction is what distinguishes the two: an empty record fails it on
          // `entity` and `workspaceId`, whose submitted sides are non-empty strings.
          //
          // ⚠️ The `returnedIsRecord` conjunct here is REDUNDANT and recorded as such:
          // removing it was measured green, because a non-record answers `undefined`
          // for every field and the two string comparisons below already fail. It is
          // kept for the same reason as `sqlDigestMatch`'s `typeof` arm — defence in
          // depth against a future edit — and, like that one, it is documented rather
          // than pinned by a test that could not fail.
          returnedRequestMatch:
            returnedIsRecord &&
            returnedWorkspaceId === request.workspaceId &&
            returnedEntity === request.entity &&
            returnedConnectionId === request.connectionId,
        },
        "Warehouse producer: the SQL gate returned a verdict for a different request — refusing rather than reading",
      );
      refuseEntity(
        entityPlan,
        "snapshot-failed",
        `Atlas could not confirm its SQL gate checked the query it would run against ` +
          `"${entityPlan.entity.table}", so nothing was emitted for it this run. Nothing was ` +
          "invalidated and no window was stamped. This is an Atlas wiring fault rather than a problem " +
          // ⚠️ INTERPOLATED, not "this run's request id". The report carries no
          // requestId field and no middleware echoes one back, so an operator told
          // to quote it had workspace plus wall-clock — exactly what
          // `WarehouseRunContext.requestId`'s docstring exists to prevent. Same
          // shape as the entity-edge failure message above.
          // `"unknown"`, matching `vocabulary-preview.ts` and
          // `vocabulary-object-radius.ts`. Two spellings of the same placeholder in
          // one subsystem means an operator grepping support tickets for one misses
          // the other.
          `with the entity — if it repeats, report it with request id ${requestId ?? "unknown"}.`,
      );
      continue;
    }

    /**
     * Everything derived from the snapshot runner's return value, decided INSIDE the
     * `try` below (#5257).
     *
     * ⚠️ **The row-cap read and the claim build used to sit between the snapshot
     * `catch` and the transaction `.catch`, where nothing encloses them.**
     * {@link WarehouseSnapshotRunner} is one of the five names
     * `warehouse-producer-bypass.test.ts` guards, so its return value is a
     * seam value under exactly the threat model #5248 spent its rounds on for the
     * validator — and `rows.length` is an operation on it, not a fact about it.
     *
     * Nine shapes were run against the unfixed producer, and they split three ways
     * rather than the one way the first draft of this comment claimed:
     *
     * - **SEVEN escaped as a whole-run 500 with no log line at all** — `null`,
     *   `undefined`, a throwing `length` getter, a `length` whose `valueOf` throws, a
     *   hostile `Symbol.iterator`, a `null` row, and a row with a throwing
     *   `atlas_brain_subject` getter.
     * - **A bare STRING did not 500 — it produced a phantom entity outcome**, and this
     *   correction is the point of writing the split out. `"rows".length` is 4, which
     *   is under the cap, and the claim builder iterates a string's CHARACTERS without
     *   throwing: measured `rows: 4, candidates: 0, unidentifiedRows: 4`, no refusal,
     *   no 500. An entity reported as read-and-empty when nothing was read is the
     *   silence this module exists to remove, so it is the worse outcome of the two,
     *   and it is the one a 500-shaped description would have hidden.
     * - **A revoked-Proxy array survived**, but only because `await` happened to trap
     *   it inside the `try` that was already here.
     *
     * ⚠️ **What is in scope is a read that THROWS, and the boundary is measured.**
     * {@link buildWarehouseClaims} reads `row[SUBJECT_ALIAS]` and each dimension alias,
     * so a throwing cell getter throws inside this `try` and the entity is refused.
     * Measured over row shapes: only `null` and `undefined` rows throw. An array, a
     * `Date`, a function and a primitive all answer `undefined` for every alias and
     * report `rows: 1, unidentifiedRows: 1` — unchanged by this fix, and left alone
     * deliberately: what an unreadable ROW should cost is a different question from
     * the one this guard answers.
     *
     * **Stated cost:** a genuine defect in this module's own pure claim-building now
     * reports as a failed snapshot — logged at `warn` with the Error, never swallowed,
     * but wearing the wrong label. That is the cheaper of the two mistakes, because
     * the alternative is one hostile cell taking down a run in which earlier entities
     * have committed. The `phase` field below is what keeps the operator-facing
     * message honest about whose fault it was.
     *
     * ⚠️ **NOT in scope: an iterator that never ends.** A `Symbol.iterator` yielding
     * forever hangs inside the `for…of` the claim builder runs, and no `try` catches a
     * hang. The row cap cannot help: `length` is a separate property, so an array
     * reporting `0` can still iterate forever. That is a liveness problem wanting a
     * timeout, not a shape problem wanting a guard — and leaving it unsaid here is the
     * "already handled" silence this comment exists to remove.
     *
     * Two arms rather than a bare `rows`, because the cap is a REFUSAL with its own
     * reason (`row-cap-exceeded`, not `snapshot-failed`) and its own operator message,
     * and folding it into the catch would relabel it.
     */
    let snapshot:
      | {
          readonly kind: "rows";
          /**
           * ⚠️ **THE COUNT, NOT THE ARRAY, and carrying the array was this fix
           * reproducing its own defect one statement over** (#5257 review). The rows
           * are needed only by {@link buildWarehouseClaims}, which now runs inside the
           * `try`; letting them out meant `rows.length` was read again in the
           * no-candidates arm, where nothing encloses it. Measured: a Proxy over an
           * array — `Array.isArray` answers TRUE for one — whose `length` trap throws
           * on a LATER read passed the cap check and then rejected the whole run with
           * no log line, and a trap that merely LIES reported 999,999 rows for an
           * entity the cap had just accepted. One read, inside the guard, is what makes
           * the cap check and the reported count the same number by construction.
           */
          readonly rowCount: number;
          readonly claims: WarehouseClaims;
        }
      /**
       * ⚠️ It carries the count too. The cap arm used to log only `rowCap`, so an
       * operator learned "more than 1000" and could not tell 1,001 from 1.4M — the
       * difference between narrowing an enrollment and abandoning the table. The
       * number was read and validated inside the guard already, so this is free.
       *
       * Honest bound: {@link buildSnapshotSql} emits `LIMIT rowCap + 1`, so against a
       * well-behaved runner this is always exactly `rowCap + 1` and says only "at
       * least". It is worth carrying anyway, because a substituted runner ignores the
       * LIMIT and then the real number is the whole story.
       */
      | { readonly kind: "row-cap"; readonly rowCount: number };
    /**
     * WHICH of the three things inside the `try` failed (#5257 review).
     *
     * ⚠️ **The refusal below tells the admin to fix their entity YAML, and for two of
     * these three that is the wrong person to send.** `run` is the datasource read —
     * a dropped table or a renamed column, the admin's to fix. `shape` and `claims`
     * are Atlas faults. Widening the `try` is what made them reachable here, so the
     * message has to widen with it or the guard buys detectability at the cost of
     * misdirection.
     */
    let phase: "run" | "shape" | "claims" = "run";
    try {
      // `validated`, the value the guard compared — NOT a fresh `validation.request`,
      // which would be a second read of a property the seam controls. See the capture
      // above.
      const returned: unknown = await runSnapshot(validated);
      phase = "shape";
      // ⚠️ **`Array.isArray` FIRST, and it is inside the `try` for the revoked-Proxy
      // reason {@link seamRead} states: it THROWS on one rather than answering.** That
      // throw is wanted here — it lands on the refusal arm below instead of taking the
      // run — but it is only safe because it is guarded, which is the property the
      // three previous instances of this class all lacked. It also buys the diagnosis:
      // `{ length: 5 }` would otherwise pass the cap check and die as *"not iterable"*
      // deep inside the claim builder, and `seamKind` names what actually came back.
      if (!Array.isArray(returned)) {
        throw new TypeError(
          `the snapshot runner answered ${seamKind(returned)} rather than an array of rows`,
        );
      }
      // ⚠️ `readonly unknown[]`, not `readonly Record<string, unknown>[]`, and the
      // difference is honesty rather than pedantry. After `Array.isArray` on an
      // `unknown`, TypeScript infers `any[]` — verified against this repo's own
      // checker, where `const t: string = returned[0]` then compiles — so annotating
      // the element type here would launder an unchecked `any` into a claim about
      // every row, at the one site whose entire premise is not trusting this seam. The
      // element shape is asserted ONCE, visibly, where it is actually needed.
      const rows: readonly unknown[] = returned;
      // ⚠️ ONE read of `length`, and every later use is of THIS number. See the
      // `rowCount` field above for the two measurements that forced it.
      const rowCount = rows.length;
      // ⚠️ **A SEAM-CONTROLLED NUMBER, VALIDATED — and the cap check is not the
      // validation** (#5257 review, round 2). `length` on a Proxy over an array is
      // whatever its trap returns: `NaN > rowCap` is FALSE, so `NaN` flows straight
      // past the cap into the report, where `BrainWarehouseRunReportSchema` requires a
      // non-negative int. One bad `length` therefore blanks the WHOLE run report —
      // every entity's outcome and every refusal replaced by `reportComplete: false` —
      // which is a much larger blast radius than the entity it came from.
      if (!Number.isSafeInteger(rowCount) || rowCount < 0) {
        // The VALUE when it is a number — `NaN`, `-1` and `1.5` are three different
        // wiring faults and `<number>` collapses them. A number cannot carry customer
        // data, so interpolating it is safe here in a way `sql` never is. TypeScript
        // believes `length` is a `number`; the trap is why the arm exists anyway.
        const shown = typeof rowCount === "number" ? String(rowCount) : seamKind(rowCount);
        throw new TypeError(`the snapshot runner's array reported a length of ${shown}`);
      }
      // The cap comparison stays under `shape`.
      const overCap = rowCount > rowCap;
      phase = "claims";
      snapshot =
        overCap
          ? { kind: "row-cap", rowCount }
          : {
              kind: "rows",
              rowCount,
              claims: buildWarehouseClaims({
                workspaceId,
                plan: entityPlan,
                // The one assertion. The element shape is unchecked; what makes it
                // survivable is that every read of it happens inside this `try`. What a
                // non-record row COSTS is in the scope note above, measured.
                rows: rows as readonly Record<string, unknown>[],
                snapshotAt,
              }),
            };
    } catch (err) {
      // ⚠️ **No {@link WarehouseProducerContractError} re-throw here, unlike the
      // transaction handler below, and the asymmetry is deliberate rather than an
      // omission.** This module raises that error in exactly one place —
      // {@link insertSnapshotEpisode}, which runs INSIDE the transaction — so a
      // re-throw on this arm would be unreachable machinery that also converted a
      // seam throwing one into a whole-run 500. Everything reachable here is a seam
      // failure or a hostile row, and one refused entity is the proportionate answer.
      //
      // The Error itself, not `.message`. `scrubErrSerializer` emits type, message,
      // stack AND pg's `code` with credentials already stripped — and `42P01` vs
      // `ECONNREFUSED` is the difference between "fix your YAML" and "your warehouse
      // is down". This log line is the only place that survives, because the
      // refusal below deliberately keeps the driver's text off the wire.
      log.warn(
        { ...runLog, entity: entityPlan.entity.name, table: entityPlan.entity.table, phase, err },
        "Warehouse producer: snapshot failed — the entity's pairs produced nothing this run",
      );
      refuseEntity(
        entityPlan,
        "snapshot-failed",
        phase === "run"
          ? `Reading "${entityPlan.entity.table}" failed, so nothing was emitted for it this run. ` +
              "Nothing was invalidated and no window was stamped; the next run tries again. " +
              // ⚠️ The message no longer PROMISES that retrying will work, and the
              // difference is not cosmetic. The SQL gate checks SELECT-only,
              // single-statement and the whitelist — it does NOT check that the table or
              // column exists — so a dropped table or a renamed column throws HERE, on
              // every run, forever. "The next run retries the pair" was true and useless;
              // an operator seeing it repeat needs to know the cause may be permanent.
              // ⚠️ It no longer ASSERTS the cause, and the reason is that `phase: "run"`
              // covers more than the datasource read: `defaultRunSnapshot` dynamically
              // imports the connection module and looks up a pool BEFORE any query
              // runs, so a module-init failure or a missing pool lands here too. Those
              // are Atlas faults, and "fix the entity YAML" is unfollowable for them —
              // the same misattribution the gate-threw arm was split out to avoid.
              "If it fails the same way on every run the cause is permanent — most often a table or a " +
              "dimension's column that no longer exists. The server log for this run names what " +
              "actually failed; if it is a connection or module failure, that is an Atlas fault rather " +
              "than an entity one."
          : // ⚠️ The ATLAS-fault register, taken from the gate-mismatch arm above —
            // with `fault` where that one says `wiring fault`, since this arm does not
            // know the cause is wiring. NOT "verbatim", which is what this line used to
            // claim: the two strings differ by that word, so a case-sensitive grep for
            // one does not find the other. The shared, greppable substring is
            // "This is an Atlas". These two arms describe the same kind of event: Atlas
            // read the entity fine and then could not process what came back. Sending
            // this admin to "fix the entity YAML" is advice they can follow forever
            // without anything changing.
            `Atlas read "${entityPlan.entity.table}" but could not process the result, so nothing was ` +
              "emitted for it this run. Nothing was invalidated and no window was stamped. This is an " +
              "Atlas fault rather than a problem with the entity — if it repeats, report it with request " +
              `id ${requestId ?? "unknown"}.`,
      );
      continue;
    }

    if (snapshot.kind === "row-cap") {
      // ⚠️ REFUSED, not truncated — see WAREHOUSE_ROW_CAP.
      log.warn(
        { ...runLog, entity: entityPlan.entity.name, rowCap, rowCount: snapshot.rowCount },
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

    // ⚠️ No `rows` here, and its absence is the fix (#5257 review): the array the
    // snapshot seam returned does not survive the `try`, so no later line can read a
    // property off it. `rowCount` was read once, inside the guard, beside the cap
    // comparison it has to agree with.
    const { rowCount, claims } = snapshot;

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
        rows: rowCount,
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

    /**
     * This entity's outcome, taken from a CLOSURE LOCAL rather than from what
     * `withTransaction` resolved with (#5257 review).
     *
     * ⚠️ **The catch below hardens the value the transaction seam REJECTS with;
     * this is the half it resolves with, and leaving it unguarded made the handler
     * READ as though the seam were closed.** `ReconcileTransactionRunner` is
     * `<T>(fn) => Promise<T>` with `T` inferred from our own callback — a claim about
     * a substitutable seam, not a fact about it. Nothing checked that the resolved
     * value was the object the callback built, or that the callback ran at all, and
     * `outcome === "aborted"` / `outcome === null` are identity comparisons that let
     * everything else through to `outcomes.push`. Measured: a runner resolving an
     * object with a throwing `created` getter rejected the whole run from
     * `outcomes.reduce(…)`, AFTER every entity had committed and with no log line
     * naming the entity; a runner that simply forgets to `return` resolves `undefined`
     * and does the same.
     *
     * `undefined` therefore means something a seam cannot fake: our callback never
     * reached either of its exits. Reading the local makes "this outcome came from us"
     * a scope fact instead of a type annotation.
     */
    let producedOutcome: WarehouseEntityOutcome | null | undefined;
    let transactionAborted = false;
    // ⚠️ **`try`/`catch`, NOT `.catch(…)` on the returned value, and the difference is
    // the last unguarded read on this seam** (#5257 review, round 2). `.catch` is
    // itself a property access on whatever `withTransaction` returned: a non-thenable
    // or a revoked Proxy threw THERE, outside every guard, after earlier entities had
    // committed. `await` inside a `try` has no such read — a revoked Proxy throws on
    // the `.then` lookup and lands in the catch, and a plain non-promise simply
    // resolves to itself and leaves `producedOutcome` undefined, which the arm below
    // already reports.
    try {
      await withTransaction(async (tx) => {
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
          producedOutcome = null;
          return;
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
        producedOutcome = {
          entity: entityPlan.entity.name,
          rows: rowCount,
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
      });
    } catch (err: unknown) {
      // A defect in this module's own contract stays FATAL — see
      // `WarehouseProducerContractError`. Everything below is for OPERATIONAL
      // failures, where refusing one entity is the proportionate answer.
      // ⚠️ Through {@link seamContractCheck}, because a bare `instanceof` here walks
      // the prototype chain of a value `withTransaction` chose — a revoked Proxy threw
      // out of this very line and escaped the run with no log at all (#5257).
      const contract = seamContractCheck(err);
      if (contract.isContract) {
        // ⚠️ Logged BEFORE the re-throw. This is the only path that aborts a run
        // mid-way, and it was the one path with no line from this module: `runEffect`
        // logs the message and a requestId, but it knows nothing about which entities
        // already committed — the facts the OPERATIONAL sibling below calls essential,
        // for the same reason. The more serious incident had the thinner record.
        log.error(
          {
            ...runLog,
            entity: entityPlan.entity.name,
            committedEntities: outcomes.map((o) => o.entity),
            committedCreated: outcomes.reduce((sum, o) => sum + o.created, 0),
            err,
          },
          "Warehouse producer: this module's own contract broke — the run is aborted; earlier entities had already committed and their drafts are filed",
        );
        throw err;
      }
      // Set before the reporting below, so the flag that carries "this transaction
      // aborted" is written by the statement that knows it.
      transactionAborted = true;
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
          // ⚠️ These two are the only fields that say anything ABOUT THE REJECTED VALUE
          // when it is hostile: `scrubErrSerializer` renders it as `[log scrub failed]`,
          // measured. `errKind` is bracketed like every other seam sentinel on this
          // file's log lines, and `contractCheckThrew` is the bit the classification
          // would otherwise have swallowed — see {@link seamContractCheck}.
          errKind: seamKind(err),
          contractCheckThrew: contract.threw,
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
    }

    if (transactionAborted) continue;

    // Copied to a `const` before any branch reads it, so the three arms below cannot
    // disagree about what the callback produced.
    const outcome = producedOutcome;

    if (outcome === undefined) {
      // ⚠️ The transaction seam RESOLVED without our callback reaching either exit — a
      // runner that never invoked it, or one that swallowed a throw and resolved
      // anyway. Reported rather than assumed away: silently omitting the entity is the
      // "never enrolled" silence the arm below refuses.
      //
      // ⚠️ **It does NOT claim nothing was written, and the first draft did.** In the
      // swallowed-throw case the callback ran: `insertSnapshotEpisode` may have
      // committed and drafts may be filed, with only the final assignment unreached.
      // The sibling arm above can promise a clean rollback because the real runner
      // ROLLBACKs; that guarantee does not travel here. Asserting the clean case in a
      // catch is the same false-claim class this file closes one closure up.
      log.error(
        {
          ...runLog,
          entity: entityPlan.entity.name,
          committedEntities: outcomes.map((o) => o.entity),
          committedCreated: outcomes.reduce((sum, o) => sum + o.created, 0),
        },
        "Warehouse producer: the transaction runner resolved without running this entity's work — what, if anything, it wrote is unknown",
      );
      refuseEntity(
        entityPlan,
        "snapshot-failed",
        `Atlas could not write "${entityPlan.entity.table}"'s claims: its transaction returned without ` +
          "our work reaching either of its exits, so Atlas cannot confirm what — if anything — was " +
          "recorded for it. Check the review queue for partial drafts before re-running; entities " +
          "earlier in this run DID commit, so a blind re-run re-files their drafts. This is an Atlas " +
          `fault rather than a problem with the entity — if it repeats, report it with request id ${requestId ?? "unknown"}.`,
      );
      continue;
    }

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

  const entityEdges = await runEntityEdgePass();

  log.info(
    {
      ...runLog,
      enrolled: reach.pairs.length,
      entities: outcomes.length,
      created,
      corroborated,
      entitiesStored,
      entityEdges,
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
  group: string | null,
): Promise<Record<string, unknown> | null> {
  const { getAdminEntity } = await import("@atlas/api/lib/semantic/admin-source");
  const detail = await getAdminEntity({
    name: entity,
    orgId: workspaceId,
    mode: "published",
    // ⚠️ **PASSED THROUGH, `null` included — this seam never takes
    // `getAdminEntity`'s `undefined` unique-or-throw path.** `null` is the flat
    // scope here exactly as it is on the enrollment surface, and one meaning for
    // one value across the two is worth more than the case it gives up: a
    // pre-0205 row in a workspace that only publishes group-scoped entities.
    //
    // Migration 0205 is what makes that case rare rather than universal — it
    // resolves every backfilled row whose name has exactly one published group,
    // so what is left under `null` either IS flat or was genuinely ambiguous.
    // The second refuses at `mapEntitiesToConnectionIds`' `ambiguous-group` arm
    // before reaching here, and that arm names the collision.
    connectionGroupId: group,
  });
  return detail === null ? null : (detail.entity as Record<string, unknown>);
}

/**
 * Place each enrolled entity in a connection — the PURE half of the #5284 fix.
 *
 * Exported and separated from {@link defaultResolveConnectionIds} because the I/O
 * half cannot be driven under the unit suite at all: `test-setup.ts` strips
 * `DATABASE_URL` and points `ATLAS_SEMANTIC_ROOT` at an empty directory, so
 * `listAdminEntities` takes its disk branch over an empty root and answers `[]`.
 * Every rule below would then be dead code that no mutation could kill — which is
 * exactly what the review found. The rules live here so they can be tested against
 * hand-built catalogs, and the shell above is left with only the two reads.
 *
 * @param summaries every published entity the workspace can see, with the
 *   `connection_group_id` each one is scoped to (`null` = flat/ungrouped).
 * @param wanted the enrolled names being placed.
 * @param visiblePrimaries group id → its primary member's connection id, from
 *   `loadVisibleGroups`. A group ABSENT from this map is invisible to the
 *   workspace — content mode hid it, it belongs to another workspace, or the
 *   whitelist load degraded.
 * @param catalogIsAuthoritative whether `summaries` is the workspace's real
 *   published list (the DB branch of `listAdminEntities`) rather than the disk
 *   fallback. See {@link WarehouseConnectionPlacement} for why an inference will
 *   not do here.
 */
export function mapEntitiesToConnectionIds(
  summaries: readonly { readonly name: string; readonly connectionId: string | null }[],
  wanted: readonly WarehousePlacementTarget[],
  visiblePrimaries: ReadonlyMap<string, WarehouseConnectionId>,
  catalogIsAuthoritative: boolean,
): WarehouseConnectionPlacement {
  /**
   * Distinct GROUPS per name, not row COUNT — the same definition of "ambiguous"
   * `getEntity` uses ("Ambiguity is *multiple GROUPS*, not multiple rows — a single
   * group with both a published and a draft row is normal overlay state"). Counting
   * rows would refuse an entity for being ordinary.
   */
  const wantedNames = new Set(wanted.map((t) => t.entity));
  const groupsByName = new Map<string, Set<string | null>>();
  for (const summary of summaries) {
    if (!wantedNames.has(summary.name)) continue;
    const groups = groupsByName.get(summary.name) ?? new Set<string | null>();
    groups.add(summary.connectionId);
    groupsByName.set(summary.name, groups);
  }

  const placed = new Map<string, WarehouseConnectionId>();
  const unplaceable: { entity: string; cause: WarehouseUnplaceableCause }[] = [];

  for (const target of wanted) {
    const name = target.entity;
    // ⚠️ **THE DECLARED GROUP SHORT-CIRCUITS THE INFERENCE, and that is #5286's
    // fix at this seam.** The block below exists to work out WHICH group a bare
    // name meant, and its `ambiguous-group` arm is the honest answer when it
    // cannot — but a group-scoped enrollment already answered it, so asking the
    // catalog again could only produce a refusal for a question nobody asked.
    // That is exactly what happened on staging: `test_orders` published under
    // three groups refused every run, including runs whose enrollment named one
    // of the three.
    //
    // The catalog is still CONSULTED, for one thing the enrollment cannot
    // establish on its own: whether the workspace still publishes that name under
    // that group. An enrollment outliving its entity is ordinary (nothing
    // un-enrolls on a semantic-layer sync, by 0199's design), and placing it
    // anyway would point a snapshot at a database that no longer answers for it.
    if (target.group !== null) {
      const publishedHere =
        groupsByName.get(name)?.has(target.group) ??
        false;
      if (!publishedHere && catalogIsAuthoritative) {
        unplaceable.push({ entity: name, cause: "absent-from-catalog" });
        continue;
      }
      const primary = visiblePrimaries.get(target.group);
      if (primary === undefined) {
        unplaceable.push({ entity: name, cause: "group-not-visible" });
        continue;
      }
      placed.set(name, primary);
      continue;
    }

    const groups = groupsByName.get(name);
    if (groups === undefined) {
      // ⚠️ **`catalogIsAuthoritative` is a FACT passed in, and the first cut of this
      // fix inferred it instead — `summaries.some((s) => s.connectionId !== null)`,
      // "does the catalog scope anything by group". That inference reproduced the
      // very defect this function exists to end, because THE VISIBILITY CLAUSE IS
      // WHAT REMOVES GROUP-SCOPED ROWS FROM THE CATALOG.** `listEntityRows` filters a
      // published row out entirely when its `connection_group_id` is not a currently
      // published datasource install; `getEntity` has no such clause. So a workspace
      // whose only group was just unpublished keeps its `__global__` demo rows
      // (`connection_group_id IS NULL`), the inference reads FALSE, and the enrolled
      // group-scoped entity — still found by the loader, still planned — was
      // defaulted to the demo database with nothing refused.
      //
      // The asymmetry is the tell: the SAME condition refuses `group-not-visible`
      // when the row survives the clause and defaulted when the clause deleted it.
      // An empty `.some()` establishes only what the rows it carries are; it
      // establishes nothing about a name the catalog does not carry.
      if (catalogIsAuthoritative) unplaceable.push({ entity: name, cause: "absent-from-catalog" });
      continue;
    }
    if (groups.size > 1) {
      // ⚠️ REFUSED, where an earlier round of this fix fell through to the default datasource
      // on the argument that `getAdminEntity` would throw `AmbiguousEntityError` and
      // the run loop would refuse the entity anyway. It does not always throw: its
      // published lookup is scoped `org_id = $1` with no `__global__` arm, while the
      // catalog read here is `org_id = $1 OR org_id = '__global__'`. So a workspace
      // shadowing a `__global__` demo entity with its own looks ambiguous HERE and
      // resolves cleanly THERE — and the entity was snapshotted against the default
      // datasource with nothing refused and nothing logged.
      //
      // The two seams cannot be made to agree from this data (`AdminEntitySummary`
      // carries no `org_id`, so the org-owned row is not identifiable), so this
      // refuses rather than guesses. That is a live behaviour change for shadowing
      // workspaces — they now get a refusal naming the collision instead of silently
      // correct-looking claims built from the demo database.
      unplaceable.push({ entity: name, cause: "ambiguous-group" });
      continue;
    }
    const [group] = groups;
    // The flat scope stays ABSENT rather than resolving to the literal `"default"`.
    // `resolveGroupPrimaryConnectionId` answers `"default"` for a null group, and
    // that string takes a different branch in the SQL gate than the `undefined` this
    // arm produced before the seam existed: `validateSQL` calls
    // `getDBType("default")`, which throws `ConnectionNotRegisteredError` until
    // something has touched the default pool, where `undefined` takes `detectDBType()`.
    // A fix for group-scoped workspaces must not refuse flat ones.
    if (group === null || group === undefined) continue;
    const primary = visiblePrimaries.get(group);
    if (primary === undefined) {
      // The group is real but invisible. An earlier round of this fix called
      // `resolveGroupPrimaryConnectionId` per group, which degrades to returning the
      // GROUP ID — that id was then submitted as a connection id and
      // surfaced as `Connection "<group>" is not registered` under the TRANSIENT
      // `snapshot-failed` wording ("the next run tries again") for a condition that
      // repeats every run. Named honestly here instead.
      unplaceable.push({ entity: name, cause: "group-not-visible" });
      continue;
    }
    placed.set(name, primary);
  }

  return { placed, unplaceable };
}

/**
 * Which datasource each enrolled entity's snapshot reads (#5284).
 *
 * ⚠️ **The producer used to answer this from {@link WarehouseEntity.connection}
 * alone — the YAML `connection:` hint — and read `null` as "the default
 * connection". On a DB-backed semantic layer that field is null for every
 * entity**, because the scope lives in the row's `connection_group_id` and NOT
 * in the YAML; `admin-source.ts` names the two as distinct fields for exactly
 * this reason. So every group-scoped workspace sent every snapshot to the
 * deployment's `default` datasource — on a stock SaaS deploy, the demo database
 * — and each entity refused with `relation "…" does not exist` while its pairs
 * sat in the enrollment list looking live. It is invisible to a test workspace
 * with no whitelist — see {@link defaultValidateSnapshotSql}'s header.
 *
 * The placement rule is {@link mapEntitiesToConnectionIds}; this function is only
 * the two reads it needs, and both are awaited together.
 *
 * **On `loadVisibleGroups` rather than {@link resolveGroupPrimaryConnectionId}:**
 * that function is the amendment path's resolver (#4513, *"evidence runs where the
 * change lives"*) and this used to call it per group. It is the same derivation —
 * `visible.find((g) => g.id === groupId)?.primary` — but its `Promise<string>`
 * return COLLAPSES the case this fix exists to separate: an invisible group and a
 * successfully resolved one both come back as a plain string, so "could not place"
 * is unrepresentable in its answer. Reading the visible groups directly keeps that
 * distinction, and costs ONE whitelist read for the run instead of one per group.
 *
 * ⚠️ `listAdminEntities` PROPAGATES on failure — see
 * {@link WarehouseProducerDeps.resolveConnectionIds}. `loadVisibleGroups` never throws: it
 * degrades to `[]`, which refuses every group-scoped entity `group-not-visible` rather
 * than defaulting it. Fail-closed in both directions, by two different mechanisms.
 */
async function defaultResolveConnectionIds(
  workspaceId: string,
  entities: readonly WarehousePlacementTarget[],
): Promise<WarehouseConnectionPlacement> {
  const [{ listAdminEntities }, { loadVisibleGroups }, { hasInternalDB }] = await Promise.all([
    import("@atlas/api/lib/semantic/admin-source"),
    import("@atlas/api/lib/group-reach/lookup"),
    import("@atlas/api/lib/db/internal"),
  ]);

  // ⚠️ The SAME condition `listAdminEntities` branches on, read here so the rule
  // below knows WHICH catalog it was handed rather than guessing from its contents.
  // True → these summaries are the workspace's authoritative published list, and a
  // name missing from them is a question Atlas cannot answer. False → the disk
  // fallback (pure-YAML self-hosted, or no workspace in scope), where connection
  // a name MISSING from the catalog is not evidence of anything, so absence is not
  // refused. (A disk catalog can still carry group scoping — ADR-0012 group dirs — and
  // a name PRESENT under one is placed or refused exactly as the DB branch would.)
  const catalogIsAuthoritative = Boolean(workspaceId) && hasInternalDB();

  const [{ entities: summaries }, visible] = await Promise.all([
    listAdminEntities({ orgId: workspaceId, mode: "published" }),
    // `"published"` explicitly, matching the catalog read above. Omitting the mode
    // resolves whatever content mode is ambient, which need not be the scope the
    // entities were listed under — a third scope in a chain whose first two must
    // already agree.
    loadVisibleGroups(workspaceId, "published"),
  ]);

  const visiblePrimaries = new Map<string, WarehouseConnectionId>(
    // The ONE cast that turns a group's primary MEMBER into a connection id, sited
    // where that is what the value means. {@link WarehouseConnectionId} exists so the
    // group id two lines up cannot be written here by accident.
    visible.map((group) => [group.id, group.primary as WarehouseConnectionId]),
  );

  return mapEntitiesToConnectionIds(summaries, entities, visiblePrimaries, catalogIsAuthoritative);
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
 * runner — and since #5230 the runner's parameter is a
 * {@link ValidatedSnapshotRequest}, so a replacement runner cannot reach a
 * datasource with an unvalidated statement even if the call order changes.
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
  // THE cast — the only one in production code, which is what
  // `warehouse-producer-bypass.test.ts` pins. This is the single point where
  // "the product's SQL gate said yes" becomes a value the run will act on — see
  // {@link ValidatedSnapshotRequest} for why that has to be unforgeable by an object
  // literal rather than merely documented.
  //
  // It brands THE REQUEST IT WAS GIVEN, by reference. Constructing a fresh object
  // with the same fields would satisfy the type and fail the run loop's identity
  // check, which is the anti-replay guard — the token has to be about this object.
  return result.valid
    ? { valid: true, request: request as ValidatedSnapshotRequest }
    : // `error` is required on both sides — `SQLValidationResult`'s failing arm and
      // this one — so there is nothing to conditionally spread.
      { valid: false, error: result.error };
}

/**
 * The shipped snapshot runner — reads tier-1, and nothing else.
 *
 * It deliberately does NOT validate: the gate ran before it was called — its
 * parameter type is the proof — and having it here as well would put the product's
 * one SQL invariant inside a substitutable implementation. See
 * {@link defaultValidateSnapshotSql}.
 */
async function defaultRunSnapshot(
  request: ValidatedSnapshotRequest,
): Promise<readonly Record<string, unknown>[]> {
  const { connections } = await import("@atlas/api/lib/db/connection");
  const connection = connections.getForOrg(request.workspaceId, request.connectionId ?? "default");
  const result = await connection.query(request.sql);
  return result.rows;
}

