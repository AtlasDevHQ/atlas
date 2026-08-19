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
import { retireEntityComparables } from "@atlas/api/lib/brain/entity-comparable-retire";
import type { EntityResolver, ReconcileExecutor } from "@atlas/api/lib/brain/reconcile";
import type { AliasProposalInput } from "@atlas/api/lib/brain/vocabulary-decide";
// ⚠️ `warehouse-producer.ts` imports THIS module for values, so this edge closes
// a runtime cycle — deliberately, and it is why `isWarehouseRowId` lives there
// rather than here. ES modules handle the cycle (both sides only call across it
// at runtime, never during module evaluation), and the alternative was worse:
// re-declaring the minted shape here would be a second spelling of the pattern
// `warehouseRowId` produces, drifting the day either changes.
import { isWarehouseRowId, type WarehouseRowId } from "@atlas/api/lib/brain/warehouse-producer";

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
 * The three fields {@link resolvableIds} reads — an id and its two handles.
 *
 * Split out of {@link EntityStoreEntry} so the resolver's projection (which
 * selects exactly these columns) can be passed to the fail-closed rule without
 * inventing empty surfaces to satisfy a type the rule does not read. Inventing
 * them is how a `""` surface reaches a function that later starts caring.
 */
export interface StoredEntityNorms {
  /**
   * `warehouseRowId`'s digest, UNCHECKED — this is the READ shape.
   *
   * See {@link EntityStoreEntry.entityId} for why the brand is on the write side
   * only: this module's own writes are guaranteed, and what comes back out is
   * checked rather than assumed, because the region importer is a second writer.
   */
  readonly entityId: string;
  readonly keyNorm: string;
  readonly canonicalNorm: string;
}

/**
 * One row as the TABLE holds it — the read shape, id unchecked, and a SNAPSHOT
 * of one warehouse row.
 *
 * Two accepted costs ride on the word snapshot, both from ADR-0037 §5 rather
 * than discovered here: a deleted or renamed warehouse row leaves a stale entry
 * until the producer re-runs (and a re-keyed one when it does), and an entity's
 * canonical surface changing re-keys brain facts workspace-wide — a blast radius
 * reachable from a warehouse rename nobody thinks of as a brain operation.
 *
 * {@link EntityStoreEntry} is the WRITE shape and brands the id;
 * `buildEntityEntry` is its only mint. Same columns, deliberately not the same
 * type: what this module stores is guaranteed, what it reads back is not,
 * because the region importer is a second writer of `brain_entity`.
 */
export interface StoredEntity extends StoredEntityNorms {
  readonly entity: string;
  readonly keySurface: string;
  readonly canonicalSurface: string;
}

/**
 * One entry as this module WRITES it — {@link StoredEntity} with the id branded.
 *
 * `buildEntityEntry` is the only mint and `writeEntityEntries` is the only
 * writer that takes it, so nothing unbranded can be stored through this module.
 */
export interface EntityStoreEntry extends StoredEntityNorms {
  /**
   * `warehouseRowId`'s digest, BRANDED — narrowing {@link StoredEntityNorms}'s
   * bare `string`.
   *
   * ⚠️ **The brand is on the WRITE shape and deliberately not on the read one.**
   * This is the door this module owns: `buildEntityEntry` is the only mint and
   * `writeEntityEntries` takes this type, so nothing unbranded can be STORED
   * through here — with a bare `string`, `{ entityId: "1" }` is an unbranded
   * door straight onto `subject_cmp`, which is how #5032's guard was bypassed
   * one column over once only the parameter was branded.
   *
   * What comes back OUT is a different question, and asserting the brand there
   * was the bug: the region importer is a second writer, so a read is checked
   * (`isWarehouseRowId`) rather than assumed.
   */
  readonly entityId: WarehouseRowId;
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

/** What {@link entityEdgeProposals} produced, and what it refused. */
export interface EntityEdgeBatch {
  readonly proposals: readonly AliasProposalInput[];
  /**
   * Entries whose key IS its name — a natural-key table (`account_name` as the
   * primary key). Nothing to propose, and nothing wrong: the surface a person
   * says and the surface the warehouse stores are already one, so the entry
   * resolves by name with no edge needed.
   *
   * Returned rather than folded into `ambiguous` so the two refusals stay
   * distinguishable — "nothing to propose because the keys are natural" and
   * "nothing to propose because names collide" have opposite meanings.
   *
   * ⚠️ It DOES reach the run report now (#5277), on every `entityEdges` arm that
   * got far enough to count it. This line used to say "no report and no log on
   * purpose; there is nothing to act on", and the second half is still true — but
   * silence made a healthy all-natural-key store byte-identical to one whose ids no
   * producer could have minted, which resolves nothing. Nothing to ACT on is not
   * the same as nothing to SAY.
   */
  readonly selfEdges: number;
  /**
   * Entries refused because a norm resolves to nothing — a name shared with
   * another entity, or a norm poisoned by one. Their surfaces resolve to NOTHING
   * and no edge is ever raised for them, so they are the rows a person has to
   * disambiguate in their warehouse.
   *
   * DISJOINT from `unmintedIds`: an unminted row is counted there and skipped
   * before this test. They overlapped in a first cut, which made this number
   * mean three things at once and `unmintedIds > 0` imply `ambiguous > 0`.
   *
   * THIS one reaches the run report (`entityEdges.ambiguous`, on every arm that
   * got far enough to count it) and a warn, because it is ordinary data — two
   * `Acme` accounts — with a permanent consequence.
   */
  readonly ambiguous: number;
  /**
   * Rows whose id no producer could have minted (a hand-edited or downgraded
   * bundle). They still POISON their norms — see {@link StoredEntityNorms} —
   * and they can never be answered with. DISJOINT from `ambiguous`, and the
   * split is the point: the remedy here is a re-import, not a warehouse edit.
   */
  readonly unmintedIds: number;
}

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
  entries: readonly StoredEntityNorms[],
): ReadonlyMap<string, WarehouseRowId> {
  const byNorm = new Map<string, string | null>();
  const note = (norm: string, id: string): void => {
    // The degenerate norm is refused HERE, not only by the two callers that
    // happen to filter it. This function's docstring calls itself the single
    // home of the fail-closed clause, and that was true of ambiguity and not of
    // emptiness — `""` is the one key value that joins every other degenerate
    // row, so a caller that forgot the filter would resolve them all as one.
    if (norm === "") return;
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
    // ⚠️ Unambiguous AND minted, and the two conditions are SEPARATE. An
    // ambiguous norm answers nothing because the store cannot say which entity
    // it is; an unminted id answers nothing because the VALUE cannot be trusted
    // onto `subject_cmp`. A row can fail the second while still having poisoned
    // a norm through the first — which is exactly what makes this fail-closed
    // rather than fail-open. Filtering unminted rows out of the INPUT instead
    // let a forged row's twin become unambiguous and take the name.
    if (id !== null && isWarehouseRowId(id)) resolved.set(norm, id);
  }
  return resolved;
}

/**
 * Rows whose id no producer could have minted — for the caller to report.
 *
 * Separate from {@link resolvableIds} because it answers a different question:
 * that function says what a norm resolves to, and a caller also needs to know
 * that some rows in the table are unusable, which is invisible in a map that
 * simply omits them.
 */
export function unmintedIdCount(entries: readonly StoredEntityNorms[]): number {
  let unminted = 0;
  for (const entry of entries) {
    if (!isWarehouseRowId(entry.entityId)) unminted++;
  }
  return unminted;
}

// ---------------------------------------------------------------------------
// The write path
// ---------------------------------------------------------------------------

/**
 * Exported so `warehouse-producer.test.ts`'s fake executor dispatches on the
 * EXACT statement rather than on a paraphrase that stays green against an edited
 * one. (Not the `-pg` suite, which an earlier version of this line claimed: that
 * suite calls the functions.)
 */
export const ENTITY_STORE_DELETE_SQL = `DELETE FROM brain_entity WHERE workspace_id = $1 AND entity = $2`;

/**
 * The ids this entity's entries carry RIGHT NOW, read before the DELETE
 * replaces them (#5319).
 *
 * The whole input to comparable retirement, and the reason it is a read rather
 * than a diff computed from the run's own candidates: the set that matters is
 * what the STORE holds, not what the producer believes it wrote last time. A
 * run that was refused, a hand-edited row, an imported entry from another
 * region — none of them are in this run's memory, and every one of them can be
 * carrying an id that facts still name.
 *
 * Exported for {@link ENTITY_STORE_DELETE_SQL}'s reason.
 */
export const ENTITY_STORE_LIVE_IDS_SQL = `SELECT entity_id, key_norm FROM brain_entity
    WHERE workspace_id = $1 AND entity = $2`;

/**
 * The #5320 reconciliation — entries keyed under a name that has stopped being
 * this entity's name.
 *
 * Exported for {@link ENTITY_STORE_DELETE_SQL}'s reason.
 *
 * ## What the three predicates do, and why none of them can go
 *
 * `entity <> $2` — never touch the entity being written; its own snapshot is
 * {@link ENTITY_STORE_DELETE_SQL}'s job and doing it twice would delete rows the
 * INSERT is about to restore.
 *
 * `NOT (entity = ANY($3))` — the row is keyed under a name the producer no
 * longer reaches. This is the half that makes the statement a RENAME
 * reconciliation rather than a homonym purge. Two entities that are both
 * enrolled and both legitimately name a row `Acme Corp` are ordinary data — the
 * store abstains for that norm and `entityEdgeProposals` counts it in
 * `ambiguous` — and deleting one of them would be picking a winner the store
 * spends {@link resolvableIds} refusing to pick.
 *
 * `key_norm = ANY($4) OR canonical_norm = ANY($4)` — the row shares a norm with
 * what is being written, which is the POISONING itself rather than a proxy for
 * it. An out-of-reach entry that collides with nothing is stale and recoverable
 * (it resolves to an id no live fact carries; nothing over-matches) and it is
 * #5321's reaper's business, on an age rule with its own argument. This
 * statement deletes only where the collision is, so it does not need to know
 * how long anything has been there and cannot be wrong about a transient
 * outage.
 *
 * ⚠️ Together they are why this is not "delete everything out of reach". That
 * statement would be simpler, would also clear renames, and would reap an
 * un-enrolled entity's entries the instant its enrollment went — with no age
 * gate, on an irreversible DELETE, which is the exact trade #5233's AC-1 spends
 * its whole argument refusing.
 *
 * ## What "no longer in reach" actually includes, stated plainly
 *
 * `reach.entities` is derived from ENROLLED PAIRS (`enrollment.ts`), so an
 * entity with zero enrolled dimensions is not in reach — and that covers a
 * temporary state, not only a permanent one. An admin who un-enrolls every
 * dimension of `contacts` while reconfiguring it has, for that window, made
 * `contacts` indistinguishable from an entity that was renamed away. If
 * `accounts` runs in that window and shares a norm, this statement deletes the
 * `contacts` entries that collide with it.
 *
 * That is accepted rather than overlooked, on two grounds. The first is that the
 * alternative is worse: #5320 is explicit that the poisoning must not wait on
 * the reaper, because a poisoned store already resolves nothing and routing its
 * repair through an age rule asks the broken thing to repair itself. The second
 * is that what is deleted here is REGENERABLE — a store entry is a snapshot of a
 * warehouse read, and re-enrolling `contacts` restores every row of it, with the
 * identical ids, on that entity's next run. It is emphatically not the same
 * class of loss as a retired comparable, which is why the retirement beside it
 * is gated far more narrowly (on a re-mint, never on a mere disappearance).
 */
export const ENTITY_STORE_RENAME_RECONCILE_SQL = `DELETE FROM brain_entity
    WHERE workspace_id = $1
      AND entity <> $2
      AND NOT (entity = ANY($3::text[]))
      AND (key_norm = ANY($4::text[]) OR canonical_norm = ANY($4::text[]))
RETURNING entity_id, key_norm`;

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
 * ⚠️ **AND THAT MEANS THE SNAPSHOT CLAIM ABOVE HAS A STATED LIMIT.** The
 * producer opens no transaction for an entity that yielded no candidates — a
 * truncated table, a primary-key column that became unsurfaceable, an entity
 * un-enrolled entirely — so this function is not reached and its prior entries
 * SURVIVE, still resolving surfaces for rows that may no longer exist. An
 * earlier version of this docstring asserted the snapshot property without the
 * exception, which is a comment describing an invariant the code does not keep.
 *
 * It is the recoverable direction (an entry resolves to an id no live fact
 * carries; nothing over-matches, because the ids are unique per row) and the
 * fix is {@link reapUnreachedEntityEntries}, on the age rule #5321 settled.
 *
 * The `ON CONFLICT` arm is not dead code the DELETE makes unreachable — it is
 * what keeps the statement correct if two entities ever legitimately claim one
 * id, and it is one line against a duplicate-key 500 in a transaction that also
 * holds the run's facts.
 *
 * ## It now does THREE things, and the composition is the point (#5319, #5320)
 *
 * A snapshot write that changes which ids are live has two consequences the
 * store cannot leave to a caller, because a caller that forgets either one
 * reintroduces a silent, permanent failure:
 *
 *   1. **Reconcile away a stale NAME** (#5320) — entries keyed under a name that
 *      has stopped being this entity's name, sharing this snapshot's norms. See
 *      {@link ENTITY_STORE_RENAME_RECONCILE_SQL}. Left behind, both sets go live
 *      with the same canonical norms and different ids, {@link resolvableIds}
 *      poisons every shared norm, and the store resolves NOTHING for that entity
 *      — permanently, with no error. #5316 measured that arriving from an
 *      ordinary semantic-layer rename inside one region, no migration involved.
 *   2. **Retire the comparables of the ids it dropped** (#5319) — see
 *      `entity-comparable-retire.ts`. Left behind, a fact carrying an old id and
 *      a fact carrying the new one are *provably different* at `object_cmp`
 *      while their `object_key` is byte-identical, and the second retires the
 *      first at the publish gate. PR 5315 measured the `valid_to` stamp.
 *
 * ⚠️ **Both are done HERE rather than beside the call, deliberately.** #5319
 * requires the retirement to ride in the minting transaction, and the only way
 * to guarantee that for every future caller is for the mint itself to do it —
 * this function already knows the ids going out and the ids coming in, and it is
 * already inside the transaction. A second call the producer must remember is a
 * call the next writer of a second mint path will not make, and the failure is
 * invisible when they don't.
 *
 * The ORDER matters and is not the obvious one: reconcile first, so the orphan
 * ids join the retirement set; read the live ids before the DELETE, because
 * after it there is nothing to read. What gets retired is
 * `(orphans ∪ previously live) − newly written` — an id that survives this write
 * is still live and its comparables must NOT be touched, which is what keeps a
 * plain re-run from retiring the corpus it just corroborated.
 */
export async function writeEntityEntries(
  tx: ReconcileExecutor,
  params: {
    readonly workspaceId: string;
    readonly entity: string;
    readonly entries: readonly EntityStoreEntry[];
    readonly snapshotAt: Date;
    /**
     * Every entity name the producer currently reaches — `reach.entities`.
     *
     * REQUIRED, and not optional with a safe default. An optional reach would
     * make the #5320 reconciliation opt-in, and the caller most likely to omit
     * it is a future second mint path, which is exactly the caller whose entries
     * would poison the store. Pass `[entity]` if a caller genuinely has no
     * wider reach — that spelling says "nothing else is enrolled" out loud
     * rather than by omission.
     */
    readonly entityNamesInReach: readonly string[];
  },
): Promise<EntityStoreWriteOutcome> {
  const { workspaceId, entity, entries, snapshotAt, entityNamesInReach } = params;

  // (1) The rename reconciliation, BEFORE the snapshot's own DELETE. The norms
  // it matches on are this snapshot's, so it has to run while they are still in
  // hand, and its victims have to be known before the retirement set is built.
  const norms = [...new Set(entries.flatMap((e) => [e.keyNorm, e.canonicalNorm]))];
  let orphans: readonly DroppedEntityRow[] = [];
  if (norms.length > 0) {
    const { rows } = await tx.query(ENTITY_STORE_RENAME_RECONCILE_SQL, [
      workspaceId,
      entity,
      [...entityNamesInReach],
      norms,
    ]);
    orphans = readDroppedRows(rows);
  }

  // (2) The ids that are live for THIS entity right now. Read before the DELETE
  // for the obvious reason, and read from the table rather than remembered from
  // a previous run for the less obvious one — see `ENTITY_STORE_LIVE_IDS_SQL`.
  const { rows: liveRows } = await tx.query(ENTITY_STORE_LIVE_IDS_SQL, [workspaceId, entity]);
  const liveBefore = readDroppedRows(liveRows);

  await tx.query(ENTITY_STORE_DELETE_SQL, [workspaceId, entity]);
  if (entries.length > 0) {
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

  // (3) Retire the comparables of ids that were RE-MINTED — and only those.
  //
  // ⚠️ **The gate is "some new entry claims this row's `key_norm` under a
  // DIFFERENT id", not "this id is no longer in the store", and the difference
  // is a defect this shipped with once.** `warehouseRowId` digests
  // `(workspace, entity, primary key)` and NOT the canonical surface, so an id
  // that leaves the store can absolutely come back identical:
  //
  //   - a human blanks an account's NAME in the CRM. The row lands in
  //     `unnamedRows` (ordinary data on a nullable column), contributes no
  //     entry, and its id drops out. Re-typing the name re-mints the SAME id and
  //     restores the entry — but a retirement would already have blanked
  //     `object_cmp` on every fact about it, with no inverse.
  //   - a human un-names the DIMENSION. `entries` is empty, so every one of this
  //     entity's ids drops out at once and the whole entity's corpus is blanked
  //     in one transaction — for an action the refusal text describes as merely
  //     clearing the store entries.
  //
  // Both are reversible admin actions, and both were producing an irreversible
  // corpus write. `key_norm` is the primary key's norm, so "the same warehouse
  // row now answers to a different id" is exactly the re-mint #5319 is about,
  // and it is the only condition under which the old comparable is provably
  // stale rather than merely absent.
  //
  // A genuinely DELETED warehouse row therefore retires nothing: no new entry
  // claims its key, its id may return if the row does, and its facts keep a
  // comparable that over-matches nothing.
  const mintedByKeyNorm = new Map<string, string>();
  for (const e of entries) mintedByKeyNorm.set(e.keyNorm, e.entityId);
  const retiredIds = [
    ...new Map([...orphans, ...liveBefore].map((row) => [row.entityId, row])).values(),
  ]
    .filter((row) => {
      const minted = mintedByKeyNorm.get(row.keyNorm);
      return minted !== undefined && minted !== row.entityId;
    })
    .map((row) => row.entityId);
  const comparablesRetired = await retireEntityComparables(tx, { workspaceId, entityIds: retiredIds });

  if (orphans.length > 0) {
    log.warn(
      { workspaceId, entity, orphans: orphans.length, orphanIds: sampleIds(orphans.map((o) => o.entityId)) },
      "Entity store: deleted store entries keyed under a name that is no longer this entity's and no " +
        "longer in reach, whose norms collided with this snapshot's — the store had gone blind to " +
        "this entity while they were live. A semantic-layer rename is the usual cause (#5316)",
    );
  }
  return { orphansDeleted: orphans.length, retiredIds, comparablesRetired };
}

/** What one snapshot write changed beyond its own rows — for the run report. */
export interface EntityStoreWriteOutcome {
  /** #5320 — entries removed because their key name had gone stale. */
  readonly orphansDeleted: number;
  /** Ids that were live before this write and are not live after it. */
  readonly retiredIds: readonly string[];
  /** #5319 — facts whose object comparable now abstains. */
  readonly comparablesRetired: number;
}

/** One row that left `brain_entity`, with the handle the re-mint gate needs. */
interface DroppedEntityRow {
  readonly entityId: string;
  /** The PRIMARY KEY's norm — what says two rows are the same warehouse row. */
  readonly keyNorm: string;
}

/**
 * `(entity_id, key_norm)` off rows this module's own statements returned.
 *
 * Narrowed rather than asserted: `ReconcileExecutor.query` answers
 * `readonly unknown[]`, and a `as { entity_id: string }` here is the unchecked
 * door {@link EntityStoreEntry.entityId} argues about one column over.
 *
 * A row missing either field is DROPPED rather than defaulted. Both directions
 * of a default are wrong here and one of them is dangerous: an empty
 * `entity_id` would be handed to a retirement set, and an empty `key_norm`
 * would match nothing in `mintedByKeyNorm` and silently exempt a genuinely
 * re-minted row from retirement. Neither is reachable through this module's own
 * columns (0200 CHECKs both non-empty); the guard is for the second writer.
 */
function readDroppedRows(rows: readonly unknown[]): readonly DroppedEntityRow[] {
  const out: DroppedEntityRow[] = [];
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const record = row as Record<string, unknown>;
    const entityId = record.entity_id;
    const keyNorm = record.key_norm;
    if (typeof entityId !== "string" || entityId === "") continue;
    if (typeof keyNorm !== "string" || keyNorm === "") continue;
    out.push({ entityId, keyNorm });
  }
  return out;
}

/**
 * How many ids a log line carries when it reports an irreversible DELETE.
 *
 * Both {@link writeEntityEntries} and {@link reapUnreachedEntityEntries} return
 * their ids so an operator can audit a deletion after the fact, and a count
 * alone does not let anyone do that. Bounded because the caller is a per-entity
 * loop and the row cap is 1000 — a run that reaped an entire large entity would
 * otherwise put a thousand digests on one line. The COUNT beside it is always
 * exact, so a truncated sample never reads as the whole story.
 */
const LOGGED_ID_SAMPLE = 20;

function sampleIds(ids: readonly string[]): readonly string[] {
  return ids.length <= LOGGED_ID_SAMPLE ? ids : ids.slice(0, LOGGED_ID_SAMPLE);
}

// ---------------------------------------------------------------------------
// The reaper — entries for an entity no longer in reach (#5321)
// ---------------------------------------------------------------------------

/**
 * How many of an entity's own successful runs must pass over an entry before it
 * is reaped.
 *
 * **3**, and a named constant carrying its reason rather than a bare literal in
 * the statement. At the producer's default 24-hour cadence that is roughly three
 * days of an entity being read successfully and producing nothing about the row
 * before its entry goes — long enough that a one-off empty read costs nothing,
 * short enough that a truncated table does not answer for a week.
 *
 * It is load-bearing rather than decorative: the boundary at N-1 is tested, so
 * changing this number changes measured behaviour rather than a comment.
 */
export const ENTITY_STORE_REAP_AFTER_SUCCESSFUL_RUNS = 3;

/**
 * Exported for {@link ENTITY_STORE_DELETE_SQL}'s reason.
 *
 * ## The reach rule, in one statement
 *
 * *Reap entries whose `snapshot_at` predates that entity's last N successful
 * producer runs.* `recent` is those runs, newest first; `gate` collapses them to
 * the oldest of the N and how many there were.
 *
 * `gate.n >= $3` is the half that makes the rule safe by default, and it is the
 * whole of #5233's AC-1: with fewer than N recorded successes the join matches
 * nothing and the statement is a no-op. An entity the producer has never run
 * for, an entity whose datasource has been down since before the record
 * existed, an entity in a freshly-migrated region whose success history
 * deliberately did not travel (`bundle-scope.ts` says why) — every one of them
 * reaps nothing, because absence of evidence reaps nothing.
 *
 * `e.snapshot_at < gate.oldest` is strict, and the strictness is what puts the
 * N-1 boundary where the constant says it is. A run that commits through the
 * reconcile transaction rewrites every entry at that run's own `snapshot_at`, so
 * an entry is never older than the success recorded beside it — it takes N
 * successes that wrote NO entries (the zero-candidate arm: a truncated table, a
 * primary key that stopped being surfaceable) to push the oldest of the N past
 * it.
 *
 * ⚠️ **This does NOT touch the name-mismatch poisoning, and must not.** That is
 * #5320's, handled by {@link ENTITY_STORE_RENAME_RECONCILE_SQL} in the minting
 * transaction. The two are different failures: the poisoning is a
 * `(workspace_id, entity)` KEY MISMATCH, permanent and silent, whose repair
 * cannot wait on this rule — a poisoned store already resolves nothing, and
 * routing its repair through a reaper that only fires on that entity's own
 * successful runs asks the broken thing to repair itself. This rule is for
 * recoverable STALENESS. Stated here so a later reader does not assume the
 * reaper covers both.
 */
export const ENTITY_STORE_REAP_SQL = `WITH recent AS (
    SELECT succeeded_at
      FROM brain_warehouse_entity_success
     WHERE workspace_id = $1 AND entity = $2
     ORDER BY succeeded_at DESC
     LIMIT $3
  ), gate AS (
    SELECT min(succeeded_at) AS oldest, count(*) AS n FROM recent
  )
  DELETE FROM brain_entity e
   USING gate
   WHERE e.workspace_id = $1
     AND e.entity = $2
     AND gate.n >= $3::bigint
     AND e.snapshot_at < gate.oldest
RETURNING e.entity_id, e.key_norm`;

/**
 * Reap one entity's entries that are no longer in reach.
 *
 * ⚠️ **Per entity, and the scoping is an acceptance criterion rather than an
 * implementation detail.** Both predicates carry `entity = $2` and the success
 * window is read for that entity alone, so one entity's failures can never reap
 * another's entries — which is the coupling that made *"gate on a run that
 * refused nothing"* unusable: one misconfigured entity anywhere in the workspace
 * would have frozen reaping for all of them, forever.
 *
 * ⚠️ **Must run in the entity's own transaction, AFTER its success record.**
 * The run that is about to license a reap has to be inside the window the reap
 * reads, or the rule lags a full cycle behind itself. And on the reconcile arm
 * it is a no-op by construction — that arm just rewrote every entry at this
 * run's `snapshot_at`, so nothing predates the window — which is deliberate:
 * calling it on BOTH arms keeps one rule with one call site's meaning rather
 * than an arm that is special because it is the only one that reaps.
 *
 * ⚠️ **The comparables of reaped ids are NOT retired**, unlike a re-mint's. A
 * re-mint puts a second live id on the SAME claim, which is what lets one fact
 * retire its own twin (#5319); a reap removes an entry and mints no replacement,
 * so there is no twin and no supersession to prevent. The facts keep an id that
 * resolves to nothing, which over-matches nothing and is the recoverable
 * direction the store's docstring already names.
 *
 * Returns the ids it removed, for the caller's report — an irreversible DELETE
 * that reports only a count is one an operator cannot audit after the fact.
 */
export async function reapUnreachedEntityEntries(
  tx: ReconcileExecutor,
  params: {
    readonly workspaceId: string;
    readonly entity: string;
    readonly afterSuccessfulRuns?: number;
  },
): Promise<readonly string[]> {
  const { workspaceId, entity } = params;
  // Clamped for `runWarehouseProducer`'s `rowCap` reason: the seam is test-only,
  // and `0` would make `gate.n >= 0` true with `oldest` NULL — harmless by luck
  // rather than by design, since the comparison against NULL is what stops it.
  // A rule this destructive does not get to be safe by luck.
  const n = Math.max(1, Math.trunc(params.afterSuccessfulRuns ?? ENTITY_STORE_REAP_AFTER_SUCCESSFUL_RUNS));
  const { rows } = await tx.query(ENTITY_STORE_REAP_SQL, [workspaceId, entity, n]);
  const reaped = readDroppedRows(rows).map((row) => row.entityId);
  if (reaped.length > 0) {
    log.warn(
      {
        workspaceId,
        entity,
        reaped: reaped.length,
        reapedIds: sampleIds(reaped),
        afterSuccessfulRuns: n,
      },
      "Entity store: reaped entries that predate this entity's last N successful producer runs — " +
        "the warehouse rows behind them have not been readable for N consecutive successful reads, " +
        "so the store stops answering for them",
    );
  }
  return reaped;
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
 * ⚠️ **Every stored row comes back, including ones whose id no producer could
 * have minted.** An earlier version DROPPED those before the caller computed
 * ambiguity, which was a fail-OPEN: the dropped row stopped poisoning its norm,
 * so its twin — a second entity with the same name — became unambiguous and got
 * an edge the rule had refused. The guard belongs on the ANSWER, not the input;
 * {@link resolvableIds} carries the argument, and {@link unmintedIdCount} is how
 * a caller reports what it saw.
 */
export async function loadEntityStore(
  workspaceId: string,
): Promise<readonly StoredEntity[]> {
  const rows = await internalQuery<EntityStoreDbRow>(ENTITY_STORE_LOAD_SQL, [workspaceId]);
  return rows.map((r) => ({
    entityId: r.entity_id,
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
    // ⚠️ EVERY row goes in, including ones whose id is unusable. Filtering them
    // out first was a fail-OPEN: a forged row stopped poisoning its norm, so its
    // twin resolved where the pair had abstained. `resolvableIds` poisons over
    // the input and answers only for minted ids, which is the shape that keeps
    // both properties.
    //
    // ⚠️ THIS is the site where the id reaches `subject_cmp`/`object_cmp` — the
    // caller is `reconcile.ts`, by way of `extract.ts`. A forged id there is a
    // false `same` at the publish gate: two distinct entities merged, with no
    // inverse. Abstaining is the recoverable direction.
    const stored = rows.map((r) => ({
      entityId: r.entity_id,
      keyNorm: r.key_norm,
      canonicalNorm: r.canonical_norm,
    }));
    const ids = resolvableIds(stored);

    // NOT silent, and this site is the one that most needed the line: the edge
    // producer's drop costs a vocabulary edge, this one costs a `_cmp` — so an
    // operator asking "why does Acme Corp not resolve" gets an answer here or
    // nowhere. `warn` rather than `error`: the store still answers for every
    // other surface, and the remedy is a re-import rather than a restart.
    const unminted = unmintedIdCount(stored);
    if (unminted > 0) {
      log.warn(
        { workspaceId: context.workspaceId, unminted, matched: rows.length },
        "Entity store: rows hold an id no producer could have minted, so those surfaces ABSTAIN " +
          "rather than reaching `subject_cmp` — and they still block their twins from resolving. " +
          "Check the last region import into this workspace",
      );
    }

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
 * Both refusals are COUNTED and returned, never merely skipped. An earlier
 * version of this docstring said they were *"reported by the caller as a
 * count"* — the caller read only `proposals.length` and reported nothing, so a
 * workspace with two `Acme` accounts had every edge for both rows refused with
 * no trace anywhere: no report field, no log above `debug` (which production
 * does not emit), no UI. A comment promising an observability guarantee nothing
 * implements is worse than the omission, so the guarantee is built instead.
 */
export function entityEdgeProposals(entries: readonly StoredEntity[]): EntityEdgeBatch {
  const ids = resolvableIds(entries);
  const proposals: AliasProposalInput[] = [];
  let selfEdges = 0;
  let ambiguous = 0;
  let unmintedIds = 0;
  for (const entry of entries) {
    // ⚠️ **THE ORDER IS THE FINDING: unminted, then ambiguity, then self-edge.**
    // Both swaps were shipped once and both collapsed two counters into one.
    //
    // UNMINTED first: `resolvableIds` omits an unminted id, so without this arm
    // such a row failed `resolvesToSelf` and landed in `ambiguous` — counted
    // TWICE, making `ambiguous` mean three different things and `unmintedIds > 0`
    // strictly imply `ambiguous > 0`. The two have different remedies (a re-import
    // versus a warehouse edit), which is the whole reason they are two numbers.
    //
    // AMBIGUITY before self-edge: with the self-edge check first, a natural-key
    // table whose two rows share a name (`Acme` as the primary key of two
    // entities) counted as two benign self-edges and reported `ambiguous: 0` — so
    // the run said nothing was wrong about a store in which neither entity
    // resolves by name, and the caller's warn never fired. A self-edge is only
    // benign when the name is unambiguous.
    if (!isWarehouseRowId(entry.entityId)) {
      unmintedIds++;
      continue;
    }
    const resolvesToSelf =
      ids.get(entry.keyNorm) === entry.entityId && ids.get(entry.canonicalNorm) === entry.entityId;
    if (!resolvesToSelf) {
      ambiguous++;
      continue;
    }
    if (entry.keyNorm === entry.canonicalNorm) {
      selfEdges++;
      continue;
    }
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
  return { proposals, selfEdges, ambiguous, unmintedIds };
}
