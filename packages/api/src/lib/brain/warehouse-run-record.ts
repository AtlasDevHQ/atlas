/**
 * When the warehouse producer last SUCCEEDED, per entity (#5317, migration 0206).
 *
 * A PREFACTOR: one writer, and deliberately NO READER. The consumer is #5233's
 * entity-store reaper, whose reach rule is *entries whose `snapshot_at` predates
 * that entity's last N successful runs* — the left side is
 * `brain_entity.snapshot_at` and this module is the right side, which had no
 * source at any grain. Landing it alone is what lets that ticket be about the
 * reach rule instead of about a migration.
 *
 * Its own module rather than a function in `warehouse-producer.ts`, on
 * `entity-store.ts`'s reason: the statement is exported so a fake executor can
 * dispatch on the EXACT bytes rather than on a paraphrase that stays green
 * against an edited one, and that only works if there is one place the statement
 * lives. `warehouse-run-lock.ts` was the other candidate and is the wrong home —
 * it owns the advisory lock that keeps two runs apart, which is a fact about
 * concurrency and not about outcomes.
 *
 * ## Successes only
 *
 * `brain_warehouse_entity_success` holds one row per (workspace, entity,
 * successful run) and nothing else. A failed or refused entity writes nothing,
 * which is the same guarantee `coverage-enumeration.ts` gets by leaving
 * `last_success_at` out of its failure arm's SET list — reached here by
 * ROLLBACK rather than by a SET list, because {@link recordEntityRunSuccess} is
 * called inside the entity's reconcile transaction. There is no failure arm to
 * forget and no ordering between two statements to get wrong.
 *
 * Migration 0206's header carries the rest: why this is not a general `_run` log
 * with an `outcome` column, why it is append-only rather than a single
 * timestamp, and what the growth costs.
 */

import type { ReconcileExecutor } from "@atlas/api/lib/brain/reconcile";

/**
 * Exported so `warehouse-producer.test.ts`'s fake executor dispatches on the
 * EXACT statement — `ENTITY_STORE_DELETE_SQL`'s reason, verbatim.
 *
 * `ON CONFLICT DO NOTHING` rather than an upsert: the row records THAT a run
 * succeeded and carries nothing a second write could update, so a conflict has
 * nothing to say. It is reachable only past `insertSnapshotEpisode`'s
 * `snapshot-already-recorded` arm, which already refuses a second snapshot at an
 * identical instant — and one line here is what keeps a caller that got there
 * anyway from raising a duplicate-key 500 inside a transaction that also holds
 * the run's facts.
 */
export const ENTITY_RUN_SUCCESS_INSERT_SQL = `INSERT INTO brain_warehouse_entity_success
     (workspace_id, entity, succeeded_at)
   VALUES ($1, $2, $3::timestamptz)
   ON CONFLICT (workspace_id, entity, succeeded_at) DO NOTHING`;

/**
 * Record that the producer succeeded for one entity, in the run it describes.
 *
 * ⚠️ **Must be called with the entity's OWN reconcile transaction.** The whole
 * value of the record is that it cannot outlive the work it claims: an entity
 * whose transaction rolls back takes this row with the facts and the store
 * entries it would have described, so nothing can ever read a success that did
 * not commit. Handed a pool instead of a `tx`, it would claim one — and it would
 * do so in exactly the case that matters, because that is the case where the
 * reaper is about to delete on the strength of it.
 *
 * ⚠️ **`snapshotAt` is the run's SNAPSHOT INSTANT, not the wall clock.** It is
 * the same value the run writes to `brain_entity.snapshot_at`, and the reach
 * rule compares the two directly. A `now()` here — in SQL or in TypeScript —
 * would be later than the snapshot by however long the reconcile took, which
 * makes every entry read as older than its own run: the direction that reaps
 * live entries.
 */
export async function recordEntityRunSuccess(
  tx: ReconcileExecutor,
  params: {
    readonly workspaceId: string;
    readonly entity: string;
    readonly snapshotAt: Date;
  },
): Promise<void> {
  const { workspaceId, entity, snapshotAt } = params;
  await tx.query(ENTITY_RUN_SUCCESS_INSERT_SQL, [
    workspaceId,
    entity,
    snapshotAt.toISOString(),
  ]);
}
