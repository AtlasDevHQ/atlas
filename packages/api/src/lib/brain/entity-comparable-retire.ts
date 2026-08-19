/**
 * Retiring the comparables of entity ids that have stopped being live (#5319,
 * bounded by #5233).
 *
 * ## The hazard, measured rather than reasoned about
 *
 * PR 5315 traced it against a real Postgres: two facts about ONE entity whose
 * object comparables carry different ids supersede each other **even when the
 * object surface is byte-identical**. `object_key` is `acme corp` on both rows;
 * `objectSameSql` reads that pair as SAME and `comparableDifferentSql` reads it
 * as PROVABLY DIFFERENT, and `supersessionCollisionJoin` reads only the second.
 * So a fact is retired by a fact asserting the identical claim, autonomously,
 * with no reviewer.
 *
 *   different ids, same surface   superseded, valid_to STAMPED
 *   same id, same surface         superseded: [], valid_to null   (control)
 *   different ids, source: slack  superseded, valid_to STAMPED    (fidelity)
 *
 * ## Why the remedy is HERE and not at the join
 *
 * `object_key` equal + `object_cmp` different is genuinely ambiguous, and
 * `supersessionCollisionJoin` is correct for one of the two readings:
 *
 *   - an id RE-MINT — one entity, ids that differ spuriously — must not supersede;
 *   - a true HOMONYM — two entities sharing a surface, someone moved between
 *     them — SHOULD supersede.
 *
 * Nothing in the two rows separates those. The defect is upstream: comparing an
 * id minted under one authority with one minted under another is a category
 * error, and inequality across two minting domains is noise rather than
 * evidence. So the remedy makes such a pair ABSTAIN, at the moment the second id
 * is minted and by the writer that knows it happened. `supersessionCollisionJoin`
 * is deliberately untouched — narrowing it would break the homonym case, which
 * is the one it gets right.
 *
 * ## `NULL`, and why that is the abstain rather than a marker
 *
 * A retired comparable is `NULL`. Both SQL predicates in `object-cmp.ts` fall to
 * not-true on a NULL side — `comparableDifferentSql` leads with `a <> b`, and
 * `comparableSameSql` is `a = b` — so the row asserts neither difference nor
 * sameness and sameness falls back to `object_key`, which is the honest handle.
 * That is the whole point: it costs unmatched corroboration, the recoverable and
 * invisible cost #5233 already accepts at `subject_cmp`, and it buys back a
 * `valid_to` stamp that no human asked for and no inverse undoes.
 *
 * ## It fires ONLY on a re-mint, and an earlier draft of this file was wrong
 *
 * The caller gates on "some new entry claims this row's `key_norm` under a
 * different id". An earlier version gated on "this id is no longer in the
 * store", justified here by the claim that *an id no entry carries can never be
 * produced by a future resolution*. **That claim is false**, and the counter-
 * example is ordinary: `warehouseRowId` digests
 * `(workspace, entity, primary key)` and NOT the canonical surface, so blanking
 * a row's NAME in the warehouse drops its entry and re-typing the name re-mints
 * the identical id. The wider rule therefore turned two reversible admin actions
 * — a blanked name, an un-named dimension — into an irreversible corpus write,
 * and the un-named-dimension case blanked an entire entity's facts in one
 * transaction.
 *
 * The narrow rule is the one #5319 actually asks for, and it is the only one
 * that can be justified: a comparable is provably stale when the SAME warehouse
 * row now answers to a DIFFERENT id, and merely absent when the row simply
 * stopped being described. Absence is recoverable and over-matches nothing;
 * staleness is what retires a fact by its own twin.
 *
 * ## No index on `object_cmp`, and that is a decision
 *
 * The statement is workspace-scoped and `brain_facts` has no index on
 * `object_cmp`, so this is a scan of one workspace's facts. It is not on any hot
 * path: {@link retireEntityComparables} is only reached when a write actually
 * dropped an id, and a steady-state producer run drops none — every re-run mints
 * the identical id set and the caller short-circuits before the statement is
 * built. Adding an index for a statement that runs on a rename, an import or a
 * warehouse deletion would be paying an insert cost on every fact in the corpus
 * to speed up something that fires a handful of times a year. If that ever stops
 * being true, it is a new access pattern and it should arrive with its own
 * measurement — which is `brain_warehouse_entity_success`'s own index argument,
 * one table over.
 *
 * ## This file is on the promotion guard's allowlist, and why it had to be
 *
 * `object_cmp` is a gated identity column: `check-brain-fact-promotion.sh`
 * refuses an UPDATE naming one outside the alias-approval seam, because a key
 * decides what a claim COLLIDES with and a collision is what stamps `valid_to`.
 * This module is allowlisted (#5321) rather than routed through that seam, on
 * an argument that runs in the opposite direction to the seam's own.
 *
 * The decide transaction RE-KEYS — it moves a claim from one identity to
 * another, so it can both create and destroy collisions, which is why it needs
 * the advisory namespace and shows a reviewer a preview. This writer only ever
 * NULLs. Per the section above, a NULL side makes both predicates fall to
 * not-true, and at the object a proven difference is what DRIVES supersession —
 * so the statement can only ever subtract a supersession trigger. The hazard
 * the column is gated for, *a second writer stamping `valid_to` on a pair
 * nobody arbitrated*, is unreachable from a write that cannot add a collision.
 *
 * The SELECT→UPDATE race is closed, and not here: #5024 made
 * `SUPERSEDE_STAMP_SQL` re-check the collision join inside its own UPDATE, so a
 * de-merge landing between the publish gate's unlocked SELECT and its stamp
 * makes it stamp FEWER rows, never more, with `promoteBrainFacts` warning on
 * the shortfall. **#5324 closed the other half**: that re-check was per TARGET,
 * so a retirement breaking one pair while another still collided left a
 * `supersedes` edge whose attribution no longer held — a stamp with the wrong
 * reason rather than a belief retired with none, but still a reader being shown
 * the wrong answer to *"why was this fact retired?"*. The re-check is now
 * per PAIR: `SUPERSEDE_STAMP_SQL` evaluates the collision per disclosed pair in
 * a CTE, stamps a row iff one of its pairs survived, and RETURNs the draft whose
 * arbitration did it, so `promoteBrainFacts` writes an edge only for pairs that
 * actually superseded. A concurrent retirement from THIS module is one of the
 * two de-mergers that fix exists for, and `vocabulary-rekey-pg.test.ts` drives
 * the two-pairs-one-rival case against real Postgres.
 *
 * Taking `IDENTITY_MUTATION_LOCK_NAMESPACE` here was the other candidate and is
 * worse: `pg_advisory_xact_lock` releases at COMMIT, and this runs inside the
 * minting transaction by construction (see {@link retireEntityComparables}), so
 * it would hold the publish namespace for the rest of a full producer run —
 * the wedged-by-ingest outcome `reconcile.ts`'s namespace note says publish
 * deliberately avoids — to buy serialization the stamp guard already makes
 * unnecessary.
 *
 * An allowlist entry exempts a FILE, so this one also exempts the module for
 * `status`, `visible_to`, `valid_to` and the other four identity columns. It
 * writes none of them, and `__tests__/entity-comparable-retire.test.ts` is the
 * column-scoped assertion that keeps it that way — the guard cannot, on a file
 * it has been told to skip. A new gated write here needs its own argument.
 *
 * ⚠️ **`object_cmp` ONLY, and `subject_cmp` is deliberately left alone.** The
 * polarity is inverted between the two positions (`schema.ts` states it at the
 * column): at the object a proven difference DRIVES supersession, and at the
 * subject it SUPPRESSES everything. So nulling `subject_cmp` would not retire a
 * hazard — it would delete a guard, letting two distinct entities that share a
 * `subject_key` merge into one row at the publish gate, with no inverse. That is
 * the direction #5233 calls a false `same`, and it is worse than the stale-id
 * cost it would be trying to fix. #5316 measured the subject-side cost of a
 * re-mint and it is exactly the tolerable one: claims about one warehouse row
 * split across two comparables and stop corroborating.
 */

import { createLogger } from "@atlas/api/lib/logger";
import { entityComparable } from "@atlas/api/lib/brain/object-cmp";
import type { ReconcileExecutor } from "@atlas/api/lib/brain/reconcile";

const log = createLogger("brain-entity-comparable-retire");

/**
 * Exported so `warehouse-producer.test.ts`'s fake executor dispatches on the
 * EXACT statement — `ENTITY_STORE_DELETE_SQL`'s reason, verbatim.
 *
 * Matched on the WHOLE comparable value (`entity:<id>`) rather than on the id
 * with a `LIKE` or a `split_part`, and that is not a micro-optimisation. An
 * equality against a text array is what lets the retirement be exact: a
 * `split_part(object_cmp, ':', 2) = ANY(...)` would also match a comparable at
 * another tag whose payload happened to equal a warehouse id, and a `LIKE
 * 'entity:%' AND ...` reintroduces the malformed shapes `comparableDifferentSql`
 * spends four arms refusing.
 *
 * `object_cmp` alone — see this module's header for why `subject_cmp` stays.
 *
 * `RETURNING id` and not a bare `UPDATE`, because {@link ReconcileExecutor}'s
 * `query` answers `{ rows }` and carries no `rowCount` — the count this function
 * reports has to come back as rows or be invented, and an invented one is the
 * observability shape #5043 already had to build twice.
 */
export const ENTITY_COMPARABLE_RETIRE_SQL = `UPDATE brain_facts
      SET object_cmp = NULL
    WHERE workspace_id = $1
      AND object_cmp = ANY($2::text[])
RETURNING id`;

/**
 * Make every fact whose object comparable names one of these ids abstain.
 *
 * ⚠️ **Must be called with the MINTING transaction**, never a pool. The claim
 * this statement makes is *"these ids are no longer live"*, and it is only true
 * because the same transaction is about to replace them. Handed a pool, a
 * rollback of the mint would leave the ids live and their comparables retired —
 * the one combination that is worse than either state, because the corpus has
 * then abstained on evidence that is still current.
 *
 * Returns the number of facts retired, for the caller's report. Zero is the
 * ordinary case and is not remarkable: most runs re-mint nothing.
 */
export async function retireEntityComparables(
  tx: ReconcileExecutor,
  params: {
    readonly workspaceId: string;
    readonly entityIds: readonly string[];
  },
): Promise<number> {
  const { workspaceId, entityIds } = params;
  // Built through `entityComparable` rather than by interpolating `entity:` —
  // the tag has ONE spelling (`object-cmp.ts` says so at the function), and a
  // second one here is a value #5035's null-at-import rule would fail to
  // discriminate, since that rule keys on the tag. It also drops a blank id
  // rather than sending `entity:`, which is one of the malformed shapes
  // `comparableDifferentSql`'s `strpos` arms exist to refuse.
  const values = entityIds
    .map((id) => entityComparable(id))
    .filter((value): value is NonNullable<typeof value> => value !== null);
  if (values.length === 0) return 0;
  const { rows } = await tx.query(ENTITY_COMPARABLE_RETIRE_SQL, [workspaceId, values]);
  const retired = rows.length;
  if (retired > 0) {
    log.info(
      { workspaceId, ids: values.length, facts: retired },
      "Entity store: retired the object comparables of facts naming an entity id this run replaced — " +
        "they now abstain rather than asserting a difference that is an artefact of the re-mint",
    );
  }
  return retired;
}
