/**
 * The entity store — `surface → stable id`, and the vocabulary edges that put a
 * surrogate-keyed warehouse row in the same slot as a human's spelling of it
 * (#5043, ADR-0037 §5, bounded by ADR-0039).
 *
 * ## What it is
 *
 * Brain-owned, workspace-scoped, internal-DB-resident. The semantic layer and
 * the warehouse are its highest-quality INPUT, never the store — they are
 * type-level where the brain names instances, `connection_group`-scoped where
 * the brain is workspace-scoped, and unjoinable as one opaque YAML blob.
 *
 * > **The rule this module exists to keep true, derived twice in ADR-0037: the
 * > brain never reads tier-1 live, at any position, for any purpose.** Nothing
 * > here touches `ConnectionRegistry`. Entries arrive by the producer, the same
 * > way warehouse facts do, and every read below is against the internal pool.
 *
 * ## The contract, four properties
 *
 * 1. **Emits vocabulary edges.** `lexicalNorm(key surface) → lexicalNorm(canonical
 *    surface)`, an ordinary `brain_vocabulary_edge` row at both entity positions.
 *    That is the store's whole SLOT-side contribution — it is not consulted at
 *    reconcile time for the slot at all, which is what made ADR-0037 §5 keep one
 *    version axis instead of two.
 * 2. **Answers `surface → stable id`** — workspace-scoped, deterministic,
 *    batched, role-invariant, absent-means-abstain, and GLOBALLY UNIQUE.
 * 3. **Versioned jointly with the vocabulary** for (1): the edge is the only
 *    thing that reaches a key, so there is no second version to stamp.
 * 4. **Fails closed** — unreconstructable matches nothing. See
 *    {@link resolvableIds}.
 *
 * ## The prohibition
 *
 * **The store may do nothing clever at read time.** No fuzzy matching, no
 * embedding lookup, no LLM disambiguation. Every equivalence is a precomputed,
 * approved edge, and every lookup below is an EXACT match on `lexicalNorm`.
 * This makes the store less powerful than the phrase "entity resolution"
 * normally promises, and it is written as a prohibition rather than left as an
 * omission because someone will propose read-time matching later — the same
 * posture that already refuses stemming in the lexical layer and near-miss
 * detection in the proposal query.
 *
 * ## An empty store and a working store are indistinguishable from in here
 *
 * ADR-0039's consequence, stated where it bites: every read abstains in both
 * cases, and every test passes in both cases. That is why M5 closes on prod row
 * counts (#5197) rather than on merge, and why this module's suite carries a
 * POSITIVE control that actually resolves something rather than only asserting
 * that abstention is quiet.
 */

import { createLogger } from "@atlas/api/lib/logger";
import { internalQuery } from "@atlas/api/lib/db/internal";
import { lexicalNorm } from "@atlas/api/lib/brain/identity";
import type { EntityResolver, ReconcileExecutor } from "@atlas/api/lib/brain/reconcile";
import type { AliasProposalInput } from "@atlas/api/lib/brain/vocabulary-decide";
// TYPE-ONLY, and it has to stay that way: `warehouse-producer.ts` imports this
// module for values, so a value import here would close a runtime cycle. The
// brand is erased at build time, which is exactly what makes it importable in
// the direction the cycle forbids.
import type { WarehouseRowId } from "@atlas/api/lib/brain/warehouse-producer";

const log = createLogger("brain-entity-store");

/**
 * The two positions an entity edge is emitted at.
 *
 * BOTH, and not one: the vocabulary is position-scoped (a predicate approval
 * must not re-key subjects workspace-wide), and an entity genuinely appears at
 * both — the producer writes it as a subject, an extractor writes `Alice / works
 * at / Acme Corp` with it as an object. Emitting at one position would leave the
 * other half of the corpus unmerged, silently.
 */
export const ENTITY_EDGE_POSITIONS = ["subject", "object"] as const;

/**
 * What the entity-edge producer records as its author.
 *
 * A producer NAME rather than a user id, on `brainVocabularyEdge.approvedBy`'s
 * three-valued reasoning: this is the machine path, and the edges it raises are
 * auto-approve-ELIGIBLE (`warehouse_key` at an entity position) rather than
 * auto-approved by this string.
 */
export const ENTITY_EDGE_PRODUCER = "brain-entity-store";

/**
 * A `warehouse_key` edge is CERTAIN — two surfaces are the same warehouse row,
 * joined by that row's primary key rather than by a guess about spelling.
 *
 * `1` and not a tuned number. The confidence field is the threshold half of the
 * auto-approve knob, and anything below `1` here would mean "this primary key
 * might not identify its own row", which is not a state the producer can be in.
 */
export const ENTITY_EDGE_CONFIDENCE = 1;

/**
 * One entity, as the store holds it — a SNAPSHOT of one warehouse row.
 *
 * Two accepted costs ride on the word snapshot, both from ADR-0037 §5 rather
 * than discovered here: a deleted or renamed warehouse row leaves a stale entry
 * until the producer re-runs (and a re-keyed one when it does), and an entity's
 * canonical surface changing re-keys brain facts workspace-wide — a blast radius
 * reachable from a warehouse rename nobody thinks of as a brain operation.
 */
/**
 * The three fields {@link resolvableIds} reads — an id and its two handles.
 *
 * Split out of {@link EntityStoreEntry} so the resolver's projection (which
 * selects exactly these columns) can be passed to the fail-closed rule without
 * inventing empty surfaces to satisfy a type the rule does not read. Inventing
 * them is how a `""` surface reaches a function that later starts caring.
 */
export interface EntityNorms {
  /**
   * `warehouseRowId`'s digest. BRANDED, and the brand is the repo's own lesson
   * rather than decoration: with a bare `string` here, `{ entityId: "1" }` is an
   * unbranded door straight onto `subject_cmp`, which is how #5032's guard was
   * bypassed one column over once only the parameter was branded.
   */
  readonly entityId: WarehouseRowId;
  readonly keyNorm: string;
  readonly canonicalNorm: string;
}

export interface EntityStoreEntry extends EntityNorms {
  /** `semantic_entities.name` — which enrolled entity produced this row. */
  readonly entity: string;
  /** The primary key's surface, verbatim as the producer emitted it. */
  readonly keySurface: string;
  /** The naming dimension's value, verbatim — the human surface. */
  readonly canonicalSurface: string;
}

/**
 * Build one entry, or `null` when it cannot be one.
 *
 * Both surfaces arrive ALREADY TRIMMED by the producer's own `warehouseSurface`,
 * so this function normalizes and refuses; it does not re-derive a surface. The
 * split keeps the "what counts as a cell value" rules in one place (the
 * producer, where `isAbsentCell` lives) and the "what counts as an entry" rules
 * here.
 *
 * The refusals are the degenerate-norm case in both columns. A surface like
 * `"---"` trims to something non-empty and norms to `""`, and a stored empty
 * norm is migration 0187's `DEFAULT ''` hazard through the front door: it is the
 * one key value that joins every other degenerate row, so two unrelated
 * placeholder entities would resolve to one id.
 */
export function buildEntityEntry(params: {
  readonly entityId: WarehouseRowId;
  readonly entity: string;
  readonly keySurface: string;
  readonly canonicalSurface: string;
}): EntityStoreEntry | null {
  const { entityId, entity, keySurface, canonicalSurface } = params;
  if (entityId === "" || entity === "" || keySurface === "" || canonicalSurface === "") return null;
  const keyNorm = lexicalNorm(keySurface);
  const canonicalNorm = lexicalNorm(canonicalSurface);
  if (keyNorm === "" || canonicalNorm === "") return null;
  return { entityId, entity, keySurface, keyNorm, canonicalSurface, canonicalNorm };
}

// ---------------------------------------------------------------------------
// Fail-closed: what a norm resolves to
// ---------------------------------------------------------------------------

/**
 * Norm → the ONE id it names, for every norm that names exactly one.
 *
 * ⚠️ **This is the whole fail-closed clause, and it is ONE function on purpose
 * because two consumers must not be able to disagree about it.** The resolver
 * abstains for a norm this map omits; the edge producer refuses to emit an edge
 * whose endpoints this map omits. Written twice, the two would drift into a
 * store that resolves a surface it refused to write an edge for, or worse the
 * reverse — an edge merging two entities the resolver knows are distinct.
 *
 * Both columns feed it. `key_norm` and `canonical_norm` are alternative handles
 * for the same entity, and role-invariance means a surface resolves the same way
 * wherever it appears — so a norm that is one entity's key and another's name is
 * ambiguous exactly as two identical names are.
 *
 * **Why ambiguity abstains instead of picking.** Two `Acme` accounts are
 * ordinary data, not corruption, so dropping one at write time would lie about
 * coverage and picking one would attach a claim to the wrong entity. At the
 * resolver a wrong id is a false `same`/`different` at the publish gate; at the
 * edge producer it is worse — `1 → acme` and `2 → acme` are each legal under
 * `brain_vocabulary_edge`'s at-most-one-parent key (the parent is per
 * `from_norm`), and together they merge two distinct entities into ONE slot key
 * workspace-wide, with no inverse.
 */
export function resolvableIds(
  // The THREE fields the rule needs, not `EntityStoreEntry`. `EntityStoreEntry`
  // satisfies it structurally, and the lookup path — which selects the id and
  // the two norms and nothing else — can pass its rows without inventing empty
  // surfaces to satisfy a type it does not read.
  entries: readonly EntityNorms[],
): ReadonlyMap<string, WarehouseRowId> {
  const byNorm = new Map<string, WarehouseRowId | null>();
  const note = (norm: string, id: WarehouseRowId): void => {
    if (!byNorm.has(norm)) {
      byNorm.set(norm, id);
      return;
    }
    const seen = byNorm.get(norm);
    // `null` is the poisoned marker — already ambiguous, and nothing un-poisons
    // it. Deleting the key instead would let a THIRD entry with the same norm
    // re-insert it as unambiguous, which is the same defect the marker exists to
    // prevent, reached by arrival order.
    if (seen !== id) byNorm.set(norm, null);
  };
  for (const entry of entries) {
    note(entry.keyNorm, entry.entityId);
    note(entry.canonicalNorm, entry.entityId);
  }
  const resolved = new Map<string, WarehouseRowId>();
  for (const [norm, id] of byNorm) {
    if (id !== null) resolved.set(norm, id);
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// The write path
// ---------------------------------------------------------------------------

/** Exported so the `-pg` suite runs the exact statement, not a paraphrase. */
export const ENTITY_STORE_DELETE_SQL = `DELETE FROM brain_entity WHERE workspace_id = $1 AND entity = $2`;

/** Exported for {@link ENTITY_STORE_DELETE_SQL}'s reason. */
export const ENTITY_STORE_INSERT_SQL = `INSERT INTO brain_entity
     (workspace_id, entity_id, entity, key_surface, key_norm, canonical_surface, canonical_norm, snapshot_at)
   SELECT $1, e.entity_id, $2, e.key_surface, e.key_norm, e.canonical_surface, e.canonical_norm, $3::timestamptz
     FROM unnest($4::text[], $5::text[], $6::text[], $7::text[], $8::text[])
       AS e(entity_id, key_surface, key_norm, canonical_surface, canonical_norm)
   ON CONFLICT (workspace_id, entity_id) DO UPDATE SET
     entity = EXCLUDED.entity,
     key_surface = EXCLUDED.key_surface,
     key_norm = EXCLUDED.key_norm,
     canonical_surface = EXCLUDED.canonical_surface,
     canonical_norm = EXCLUDED.canonical_norm,
     snapshot_at = EXCLUDED.snapshot_at`;

/**
 * Replace one entity's entries with this snapshot's.
 *
 * DELETE-then-INSERT rather than a pure upsert, and the DELETE is the half that
 * carries meaning: it is what makes an entry a SNAPSHOT rather than an
 * accumulation. A warehouse row that has gone, or whose primary key stopped
 * being surfaceable, must stop resolving — otherwise the store answers for an
 * entity that no longer exists and nothing ever removes it.
 *
 * It also clears correctly when a human UNMARKS the naming dimension: the
 * producer still processes the entity, {@link buildEntityEntry} produces nothing
 * without a canonical surface, and the DELETE runs anyway. An upsert alone would
 * leave every prior entry resolving under a name nobody named any more.
 *
 * ⚠️ Runs INSIDE the entity's reconcile transaction, so the entries and the
 * facts they describe commit or roll back together. An entity whose transaction
 * fails leaves its previous entries intact, which is the honest state: nothing
 * was read, so nothing is known to have changed.
 *
 * The `ON CONFLICT` arm is not dead code the DELETE makes unreachable — it is
 * what keeps the statement correct if two entities ever legitimately claim one
 * id, and it is one line against a duplicate-key 500 in a transaction that also
 * holds the run's facts.
 */
export async function writeEntityEntries(
  tx: ReconcileExecutor,
  params: {
    readonly workspaceId: string;
    readonly entity: string;
    readonly entries: readonly EntityStoreEntry[];
    readonly snapshotAt: Date;
  },
): Promise<void> {
  const { workspaceId, entity, entries, snapshotAt } = params;
  await tx.query(ENTITY_STORE_DELETE_SQL, [workspaceId, entity]);
  if (entries.length === 0) return;
  await tx.query(ENTITY_STORE_INSERT_SQL, [
    workspaceId,
    entity,
    snapshotAt.toISOString(),
    entries.map((e) => e.entityId),
    entries.map((e) => e.keySurface),
    entries.map((e) => e.keyNorm),
    entries.map((e) => e.canonicalSurface),
    entries.map((e) => e.canonicalNorm),
  ]);
}

// ---------------------------------------------------------------------------
// The read path
// ---------------------------------------------------------------------------

/** Exported for {@link ENTITY_STORE_DELETE_SQL}'s reason. */
export const ENTITY_STORE_LOAD_SQL = `SELECT entity_id, entity, key_surface, key_norm, canonical_surface, canonical_norm
   FROM brain_entity
  WHERE workspace_id = $1
  ORDER BY entity, entity_id`;

/** Exported for {@link ENTITY_STORE_DELETE_SQL}'s reason. */
export const ENTITY_STORE_LOOKUP_SQL = `SELECT entity_id, key_norm, canonical_norm
   FROM brain_entity
  WHERE workspace_id = $1
    AND (key_norm = ANY($2::text[]) OR canonical_norm = ANY($2::text[]))`;

interface EntityStoreDbRow extends Record<string, unknown> {
  entity_id: string;
  entity: string;
  key_surface: string;
  key_norm: string;
  canonical_surface: string;
  canonical_norm: string;
}

/**
 * Every entry in one workspace.
 *
 * Unpaginated, on `listEnrollments`'s argument: the store is bounded by the
 * enrolled set times the producer's row cap, and a store that needed paging
 * would be evidence ADR-0039's bound had failed rather than a listing to
 * truncate.
 *
 * The cast is the DB boundary's, not a type-system escape: the columns are all
 * `text NOT NULL` and the CHECKs make every one of them non-empty, so the row
 * shape is guaranteed by the schema this module ships with.
 */
export async function loadEntityStore(
  workspaceId: string,
): Promise<readonly EntityStoreEntry[]> {
  const rows = await internalQuery<EntityStoreDbRow>(ENTITY_STORE_LOAD_SQL, [workspaceId]);
  return rows.map((r) => ({
    entityId: r.entity_id as WarehouseRowId,
    entity: r.entity,
    keySurface: r.key_surface,
    keyNorm: r.key_norm,
    canonicalSurface: r.canonical_surface,
    canonicalNorm: r.canonical_norm,
  }));
}

interface EntityLookupDbRow extends Record<string, unknown> {
  entity_id: string;
  key_norm: string;
  canonical_norm: string;
}

/** The one I/O seam {@link entityStoreResolver} needs, defaulted to production. */
export interface EntityStoreResolverDeps {
  readonly lookup?: (
    workspaceId: string,
    norms: readonly string[],
  ) => Promise<readonly EntityLookupDbRow[]>;
}

async function defaultLookup(
  workspaceId: string,
  norms: readonly string[],
): Promise<readonly EntityLookupDbRow[]> {
  return internalQuery<EntityLookupDbRow>(ENTITY_STORE_LOOKUP_SQL, [workspaceId, [...norms]]);
}

/**
 * The store as an {@link EntityResolver} — the seam `reconcile.ts` has held open
 * since #5031, finally with something behind it.
 *
 * ## One statement per episode, and the batching is CORRECTNESS
 *
 * The seam's unit is the episode's deduplicated surface set for a reason that is
 * not performance: two lookups for one surface can straddle a store write and
 * key the two rows differently WITHIN a single episode, producing rows that fail
 * to collide with each other. One statement makes intra-episode consistency
 * structural. It is also why the call sits above the candidate loop and before
 * the transaction opens — it may check out its own connection safely there,
 * whereas inside the reconcile transaction that is the bounded-pool starvation
 * deadlock `withBrainTransaction` warns about.
 *
 * ## Role-invariant by construction
 *
 * There is no `role` to key on — `EntityResolver` deleted the argument so the
 * invariant holds by TYPE. This function could not answer differently by
 * position if it wanted to, which is the point.
 *
 * ## It THROWS on a database failure, deliberately
 *
 * A caught error returning an empty map would be a LIE, and a specific one: an
 * absent key is the honest abstain, which `reconcile.ts` treats as *"this will
 * not change on replay"* and leaves unflagged. A store that was unreachable WILL
 * change on replay, and the only way to say so is to fail — the seam catches it
 * and marks the episode `provisional`, whose one remaining job is exactly *"this
 * row's `object_cmp` is worth recomputing"*. Swallowing here would make those
 * rows unfindable: `object_cmp IS NULL` matches every honest abstain too.
 */
export function entityStoreResolver(deps: EntityStoreResolverDeps = {}): EntityResolver {
  const lookup = deps.lookup ?? defaultLookup;
  return async (surfaces, context) => {
    // Norm the request first. A surface that norms away asserts nothing and can
    // match nothing — sending it would be asking the database for `''`, the one
    // value that joins every degenerate row.
    const normOf = new Map<string, string>();
    for (const surface of surfaces) {
      const norm = lexicalNorm(surface);
      if (norm !== "") normOf.set(surface, norm);
    }
    const answer = new Map<string, { entityId: string }>();
    if (normOf.size === 0) return answer;

    const wanted = [...new Set(normOf.values())];
    const rows = await lookup(context.workspaceId, wanted);

    // Re-derived through the SAME function the edge producer uses, over the rows
    // that came back. `resolvableIds` is what abstains on ambiguity, and it must
    // not be re-implemented here — see its docstring.
    //
    // The cast is the DB boundary's: `entity_id` is `text NOT NULL` with a
    // non-empty CHECK, and every value in it was written by `warehouseRowId`
    // through {@link writeEntityEntries}, which takes the branded type.
    const ids = resolvableIds(
      rows.map((r) => ({
        entityId: r.entity_id as WarehouseRowId,
        keyNorm: r.key_norm,
        canonicalNorm: r.canonical_norm,
      })),
    );

    for (const [surface, norm] of normOf) {
      const id = ids.get(norm);
      // ⚠️ EXACT match on the norm and nothing else. No prefix, no similarity,
      // no fallback to a "close enough" entry. See this module's prohibition.
      if (id !== undefined) answer.set(surface, { entityId: id });
    }
    return answer;
  };
}

// ---------------------------------------------------------------------------
// The entity-edge producer
// ---------------------------------------------------------------------------

/**
 * The vocabulary edges this store's entries imply.
 *
 * `key norm → canonical norm`, at both entity positions, `warehouse_key`-classed
 * so ADR-0037 §6's auto-approve split can reach them — a warehouse primary key
 * is evidence a machine can be certain of, which is the whole basis for that
 * arm, and the workspace's own opt-out still governs whether it fires.
 *
 * ## The direction is not arbitrary
 *
 * The CANONICAL surface is the target. `42 → acme corp` keys the producer's own
 * facts (whose subject surface is `42`) onto the same slot an extracted mention
 * of `Acme Corp` keys onto — which is exactly the cross-tier collision
 * `warehouse-producer.ts` records as not working for a surrogate-keyed row. The
 * reverse, `acme corp → 42`, would re-key every human mention onto an opaque id
 * and reproduce in the vocabulary the corpus-orphaning ADR-0037 §5 kept ids out
 * of the slot to prevent.
 *
 * `directed: true` for the same reason: a primary key genuinely says which
 * spelling names the row, so there is nothing for an approver to disambiguate.
 *
 * ## What it refuses
 *
 * - **A self-edge.** A natural-key table (`account_name` as the primary key)
 *   makes the two norms equal. That pair proposes nothing, and the seam would
 *   refuse it — but refusing here keeps the run's log from carrying one warn per
 *   row for a table that is behaving correctly.
 * - **Either endpoint ambiguous.** See {@link resolvableIds}. This is the
 *   fail-closed clause, and at this position it is the sharper of the two: the
 *   resolver's ambiguity costs an abstain, an edge's merges two entities
 *   workspace-wide with no inverse.
 *
 * Both refusals are SILENT here and reported by the caller as a count, because
 * an entity store with two `Acme` rows is ordinary data rather than a defect —
 * what an operator needs is the number, not a line per row.
 */
export function entityEdgeProposals(
  entries: readonly EntityStoreEntry[],
): readonly AliasProposalInput[] {
  const ids = resolvableIds(entries);
  const proposals: AliasProposalInput[] = [];
  for (const entry of entries) {
    if (entry.keyNorm === entry.canonicalNorm) continue;
    if (ids.get(entry.keyNorm) !== entry.entityId) continue;
    if (ids.get(entry.canonicalNorm) !== entry.entityId) continue;
    for (const position of ENTITY_EDGE_POSITIONS) {
      proposals.push({
        position,
        fromNorm: entry.keyNorm,
        toNorm: entry.canonicalNorm,
        directed: true,
        sourceClass: "warehouse_key",
        confidence: ENTITY_EDGE_CONFIDENCE,
        proposedBy: ENTITY_EDGE_PRODUCER,
      });
    }
  }
  log.debug(
    { entries: entries.length, resolvableNorms: ids.size, proposals: proposals.length },
    "Entity store: built entity-edge proposals",
  );
  return proposals;
}
