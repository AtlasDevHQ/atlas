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
 * Not the entity store (#5043): the ids below identify a warehouse ROW, and they
 * reach `subject_cmp` and nothing else — no key, no surface column, no join arm.
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
  CARDINALITY_SOURCE_CLASSES,
  proposePredicateCardinalityForSurface,
} from "@atlas/api/lib/brain/cardinality";
import { loadProducerReach, type ProducerReach } from "@atlas/api/lib/brain/enrollment";
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

/** The source class {@link proposePredicateCardinalityForSurface} is called with. */
const WAREHOUSE_CARDINALITY_SOURCE = CARDINALITY_SOURCE_CLASSES[0];

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
  readonly dimensions: readonly WarehouseDimension[];
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
  entities: ReadonlyMap<string, WarehouseEntity | null>,
): WarehousePlan {
  const refused: WarehouseRefusal[] = [];
  /** Structurally producible pairs, before the ambiguity pass. */
  const producible: { plan: WarehouseEntity; pk: WarehouseDimension; dim: WarehouseDimension }[] =
    [];

  for (const pair of reach.pairs) {
    const entity = entities.get(pair.entity) ?? null;
    if (entity === null) {
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
    producible.push({ plan: entity, pk: primaryKeys[0]!, dim: dimension });
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

  const byEntity = new Map<string, { entity: WarehouseEntity; pk: WarehouseDimension; dims: WarehouseDimension[] }>();
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
    let bucket = byEntity.get(item.plan.name);
    if (bucket === undefined) {
      bucket = { entity: item.plan, pk: item.pk, dims: [] };
      byEntity.set(item.plan.name, bucket);
    }
    bucket.dims.push(item.dim);
  }

  return {
    emit: [...byEntity.values()].map((bucket) => ({
      entity: bucket.entity,
      primaryKey: bucket.pk,
      dimensions: bucket.dims,
    })),
    refused,
  };
}

// ---------------------------------------------------------------------------
// The snapshot
// ---------------------------------------------------------------------------

/** The column alias the subject arrives under. */
export const SUBJECT_ALIAS = "atlas_brain_subject";

/** The per-dimension alias prefix — positional, so no warehouse identifier is interpolated twice. */
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
  readonly table: string;
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
      return trimmed === "" ? null : trimmed;
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
 * NUL-separated for `enrollment.ts`'s reason exactly: it is the one byte a
 * Postgres `text` value cannot hold, so no pair of components can be re-cut to
 * build another pair's id. With a printable separator, entity `a` + key `b:c` and
 * entity `a:b` + key `c` would be one identity.
 *
 * The id reaches `subject_cmp` and NOTHING else — no slot key, no surface column,
 * no join arm. An id at a slot would orphan the existing corpus the moment it
 * started answering (ADR-0037 §5), and that is the resolver seam's rule rather
 * than this function's.
 */
export function warehouseRowId(workspaceId: string, entity: string, primaryKey: string): string {
  const digest = createHash("sha256")
    .update([workspaceId, entity, primaryKey].join(ID_SEPARATOR))
    .digest("hex");
  return `wh_${digest}`;
}

/** One row's worth of claims, plus the id its subject resolves to. */
export interface WarehouseClaims {
  readonly candidates: readonly FactCandidate[];
  /** Subject surface → row id, for the episode's {@link EntityResolver}. */
  readonly subjectIds: ReadonlyMap<string, string>;
  /** Rows whose primary key was not a usable surface and produced nothing. */
  readonly unidentifiedRows: number;
  /**
   * Rows dropped because their primary key trimmed to a surface an EARLIER row
   * already owns.
   *
   * Counted apart from {@link unidentifiedRows} rather than folded in, because the
   * two say different things to whoever reads the run report: the first is a
   * warehouse with null or unusable keys, the second is a warehouse whose keys
   * differ only in whitespace. One is a data-quality note; the other is the reason
   * a row a person expected to see is missing.
   */
  readonly collidingSubjectRows: number;
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
  const subjectIds = new Map<string, string>();
  let unidentifiedRows = 0;
  let collidingSubjectRows = 0;

  for (const row of rows) {
    const rawKey = row[SUBJECT_ALIAS];
    const subject = warehouseSurface(rawKey);
    if (subject === null) {
      // A row whose primary key is NULL, blank, or a shape no surface can be made
      // of. It is not an error — it is a row nothing can be said ABOUT — so it is
      // counted and reported rather than logged per row or thrown on.
      unidentifiedRows++;
      continue;
    }
    // ⚠️ The id is derived from the RAW key and the subject SURFACE is trimmed, so
    // the two deliberately disagree for `42` beside ` 42 `. That disagreement is
    // the detection: those are two different warehouse rows, and deriving the id
    // from the trimmed surface would give them one identity silently — a false
    // `same` at `subject_cmp`, which is the direction that MERGES two entities
    // with no inverse. Passing the raw key makes the collision visible to the
    // guard below instead.
    const rowId = warehouseRowId(
      workspaceId,
      plan.entity.name,
      typeof rawKey === "string" ? rawKey : subject,
    );
    // ⚠️ First writer wins, and this arm is reachable rather than defensive — see
    // the id derivation above. One surface cannot resolve to two ids, so the
    // second row is dropped ENTIRELY: keeping its claims would attach one row's
    // identity to another row's values, which is worse than losing the row.
    const existing = subjectIds.get(subject);
    if (existing !== undefined && existing !== rowId) {
      collidingSubjectRows++;
      continue;
    }
    subjectIds.set(subject, rowId);

    for (const [index, dim] of plan.dimensions.entries()) {
      const object = warehouseSurface(row[`${DIMENSION_ALIAS_PREFIX}${index}`]);
      // A NULL cell asserts nothing. Emitting it as an empty object would be
      // blocked as a malformed claim anyway; emitting the string "null" would be
      // a fact about the company that is not true.
      if (object === null) continue;
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

  return { candidates, subjectIds, unidentifiedRows, collidingSubjectRows };
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
export function warehouseEntityResolver(subjectIds: ReadonlyMap<string, string>): EntityResolver {
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
}

/** Every I/O seam the run touches, each defaulted to its production wiring. */
export interface WarehouseProducerDeps {
  readonly loadReach?: (workspaceId: string) => Promise<ProducerReach>;
  /** The published entity YAML for one enrolled name, or `null` when there is none. */
  readonly loadEntity?: (
    workspaceId: string,
    entity: string,
  ) => Promise<Record<string, unknown> | null>;
  readonly runSnapshot?: WarehouseSnapshotRunner;
  readonly loadVocabulary?: (workspaceId: string) => Promise<ClaimVocabulary>;
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
  /** Created facts carrying a non-null `subject_cmp` — the column this producer exists to fill. */
  readonly comparable: number;
  readonly unidentifiedRows: number;
  /** See {@link WarehouseClaims.collidingSubjectRows}. */
  readonly collidingSubjectRows: number;
  /** Predicates whose `warehouse_structural` cardinality proposal was newly raised. */
  readonly cardinalityProposed: readonly string[];
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
  const row = rows[0] as { id?: unknown } | undefined;
  return typeof row?.id === "string" ? { id: row.id, sourceId } : null;
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
 * Errors from a snapshot are caught PER ENTITY and become a
 * `snapshot-failed` refusal — the run continues, nothing is stamped, and the next
 * run retries the pair. Errors from the reach, the vocabulary or a transaction
 * PROPAGATE: an empty reach and a failed reach read produce identical silence
 * (ADR-0039's *"a producer nobody enrolls anything into leaves M4 exactly as dead
 * as it is today, with every test green"*), and a swallowed one would be
 * indistinguishable from the honest zero.
 */
export async function runWarehouseProducer(
  context: WarehouseRunContext,
  deps: WarehouseProducerDeps = {},
): Promise<WarehouseProducerReport> {
  const { workspaceId } = context;
  const now = deps.now ?? (() => new Date());
  const rowCap = deps.rowCap ?? WAREHOUSE_ROW_CAP;
  const loadReach = deps.loadReach ?? loadProducerReach;
  const loadEntity = deps.loadEntity ?? defaultLoadEntity;
  const runSnapshot = deps.runSnapshot ?? defaultRunSnapshot;
  const loadVocabulary = deps.loadVocabulary ?? defaultLoadVocabulary;
  const withTransaction = deps.withTransaction ?? withBrainTransaction;

  const snapshotAt = now();
  const reach = await loadReach(workspaceId);

  // One entity read per DISTINCT entity, not one per pair — `reach.entities` is
  // that set, and it is the same set the fail-closed rule is evaluated across.
  const entityShapes = new Map<string, WarehouseEntity | null>();
  await Promise.all(
    reach.entities.map(async (name) => {
      const raw = await loadEntity(workspaceId, name);
      entityShapes.set(name, raw === null ? null : parseWarehouseEntity(name, raw));
    }),
  );

  const plan = planWarehouseEmission(reach, entityShapes);
  const refusals: WarehouseRefusal[] = [...plan.refused];
  const outcomes: WarehouseEntityOutcome[] = [];

  if (plan.emit.length === 0) {
    log.info(
      { workspaceId, enrolled: reach.pairs.length, refusals: refusals.length },
      "Warehouse producer: nothing to emit — every enrolled pair was refused or the reach is empty",
    );
    return {
      workspaceId,
      snapshotAt: snapshotAt.toISOString(),
      enrolled: reach.pairs.length,
      entities: [],
      refusals,
      created: 0,
      corroborated: 0,
    };
  }

  const vocabulary = await loadVocabulary(workspaceId);

  for (const entityPlan of plan.emit) {
    const sql = buildSnapshotSql(entityPlan, rowCap);
    let rows: readonly Record<string, unknown>[];
    try {
      rows = await runSnapshot({
        workspaceId,
        entity: entityPlan.entity.name,
        table: entityPlan.entity.table,
        connectionId: entityPlan.entity.connection ?? undefined,
        sql,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(
        { workspaceId, entity: entityPlan.entity.name, err: message },
        "Warehouse producer: snapshot failed — the entity's pairs produced nothing this run",
      );
      for (const dim of entityPlan.dimensions) {
        refusals.push(
          refusal(
            entityPlan.entity.name,
            dim.name,
            "snapshot-failed",
            `Reading "${entityPlan.entity.table}" failed, so nothing was emitted for it this run. ` +
              "Nothing was invalidated and no window was stamped; the next run retries the pair.",
          ),
        );
      }
      continue;
    }

    if (rows.length > rowCap) {
      // ⚠️ REFUSED, not truncated — see WAREHOUSE_ROW_CAP.
      log.warn(
        { workspaceId, entity: entityPlan.entity.name, rowCap },
        "Warehouse producer: entity exceeds the row cap — refused rather than emitting a truncated snapshot",
      );
      for (const dim of entityPlan.dimensions) {
        refusals.push(
          refusal(
            entityPlan.entity.name,
            dim.name,
            "row-cap-exceeded",
            `"${entityPlan.entity.table}" holds more than ${rowCap} rows, and every row becomes a draft a ` +
              "person has to review. The producer refuses rather than emitting an arbitrary subset, which " +
              "would look at rest exactly like a complete reading of the table.",
          ),
        );
      }
      continue;
    }

    const claims = buildWarehouseClaims({
      workspaceId,
      plan: entityPlan,
      rows,
      snapshotAt,
    });

    if (claims.candidates.length === 0) {
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
        cardinalityProposed: [],
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
          { workspaceId, entity: entityPlan.entity.name },
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
        if (result.ok) proposed.push(dim.name);
      }

      const blocked = Object.values(report.blocked).reduce((sum, n) => sum + n, 0);
      return {
        entity: entityPlan.entity.name,
        rows: rows.length,
        candidates: claims.candidates.length,
        created: report.created,
        corroborated: report.corroborated,
        blocked: report.episodeBlocked === undefined ? blocked : claims.candidates.length,
        comparable: report.comparable,
        unidentifiedRows: claims.unidentifiedRows,
        collidingSubjectRows: claims.collidingSubjectRows,
        cardinalityProposed: proposed,
      } satisfies WarehouseEntityOutcome;
    });

    if (outcome !== null) outcomes.push(outcome);
  }

  const created = outcomes.reduce((sum, o) => sum + o.created, 0);
  const corroborated = outcomes.reduce((sum, o) => sum + o.corroborated, 0);
  log.info(
    {
      workspaceId,
      triggeredBy: context.triggeredBy,
      enrolled: reach.pairs.length,
      entities: outcomes.length,
      created,
      corroborated,
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
 * The shipped snapshot runner — validate, then read.
 *
 * ⚠️ **`validateSQL` runs on the BUILT string, and it is not ceremony.** The
 * statement is assembled from `table` and `sql:` expressions the semantic layer
 * holds, which are admin-authored text rather than values — so the same
 * SELECT-only, single-statement, whitelist-scoped gate every other query in the
 * product passes is the thing standing between a mis-authored entity and a
 * statement this producer would otherwise run unattended, with no user in the
 * loop to notice. A rejection throws, which the run turns into a
 * `snapshot-failed` refusal for that entity.
 */
async function defaultRunSnapshot(
  request: WarehouseSnapshotRequest,
): Promise<readonly Record<string, unknown>[]> {
  const [{ validateSQL }, { connections }] = await Promise.all([
    import("@atlas/api/lib/tools/sql"),
    import("@atlas/api/lib/db/connection"),
  ]);
  const validation = await validateSQL(request.sql, request.connectionId, request.workspaceId);
  if (!validation.valid) {
    throw new Error(
      `The snapshot query for "${request.entity}" did not pass SQL validation: ${validation.error ?? "no reason given"}`,
    );
  }
  const connection = connections.getForOrg(request.workspaceId, request.connectionId ?? "default");
  const result = await connection.query(request.sql);
  return result.rows;
}
