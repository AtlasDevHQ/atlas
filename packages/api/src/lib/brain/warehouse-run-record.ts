/**
 * When the warehouse producer last SUCCEEDED, per entity (#5317, migration 0206).
 *
 * It landed as a PREFACTOR — one writer, and deliberately no reader — so that
 * #5233's entity-store reaper could be about a reach rule instead of about a
 * migration. That rule is *rows whose timestamp predates that entity's last N
 * successful runs*, and this module is its right-hand side, which had no source
 * at any grain.
 *
 * It has TWO readers now, and since #5344 it also owns the rule they share:
 * {@link WAREHOUSE_SUCCESS_WINDOW_CTE} and {@link
 * WAREHOUSE_REAP_AFTER_SUCCESSFUL_RUNS} live at the bottom of this file, and
 * `entity-store.ts` (the store's entries) and `observation-reap.ts` (the
 * corpus's observations) both open with them. The window belongs beside the
 * table it reads rather than inside either consumer — a rule that lives in one
 * of its two callers reads as that caller's property, which is how the second
 * copy gets written.
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

// ---------------------------------------------------------------------------
// The reach rule, shared (#5321, #5344)
// ---------------------------------------------------------------------------

/**
 * How many of an entity's own successful runs must pass over a row before it is
 * reaped — for the entity store's entries (#5321) and for the corpus's
 * observations (#5344) alike.
 *
 * **3**, and a named constant carrying its reason rather than a bare literal in
 * either statement. At the producer's default 24-hour cadence that is roughly
 * three days of an entity being read successfully and producing nothing about
 * the row before it goes — long enough that a one-off empty read costs nothing,
 * short enough that a truncated table does not answer for a week.
 *
 * It is load-bearing rather than decorative: the boundary at N-1 is tested on
 * both consumers, so changing this number changes measured behaviour rather
 * than a comment.
 *
 * ⚠️ **One constant for both reapers, and it lives HERE rather than in either
 * of them.** It was `ENTITY_STORE_REAP_AFTER_SUCCESSFUL_RUNS` in
 * `entity-store.ts` until #5344 needed the same number and the same window one
 * table over. A second constant — even one initialised to 3 — is how the store
 * and the corpus come to disagree about which rows are gone, which is the
 * failure #5344 names in as many words. The name lost its `ENTITY_STORE_`
 * prefix for the same reason: a shared rule must not read as one consumer's
 * property.
 */
export const WAREHOUSE_REAP_AFTER_SUCCESSFUL_RUNS = 3;

/**
 * *That entity's last N successful runs*, as a CTE both reapers open with.
 *
 * `recent` is those runs, newest first; `gate` collapses them to the oldest of
 * the N and how many there were. A consumer then compares its own row's
 * timestamp against `gate.oldest` and demands `gate.n >= $3`.
 *
 * ## The bind contract, which is the price of sharing the text
 *
 * `$1` workspace, `$2` entity, `$3` N — in that order, in every statement that
 * splices this. The CTE cannot enforce that, so each consumer's docstring
 * repeats it and each consumer's own tests bind it. That is a real cost, and it
 * is smaller than the one it buys off: #5344 requires the corpus reaper to use
 * *the same reach rule* as the store's, and two hand-written copies of a window
 * function are how "the same rule" becomes two rules that agree until one is
 * edited.
 *
 * ## `gate.n >= $3` is the half that makes the rule safe by default
 *
 * With fewer than N recorded successes the join matches nothing and the
 * statement is a no-op. An entity the producer has never run for, an entity
 * whose datasource has been down since before the record existed, an entity in
 * a freshly-migrated region whose success history deliberately did not travel
 * (`bundle-scope.ts` says why) — every one of them reaps nothing, because
 * absence of evidence reaps nothing. The clause belongs to the consumer's WHERE
 * rather than to this text, because a CTE cannot filter its own caller; both
 * consumers carry it and both have a test that fails without it.
 *
 * Spliced rather than parameterised because it is STRUCTURE, not data: nothing
 * user-supplied reaches it, and every value it reads travels as a bind.
 *
 * ## ⚠️ It assumes an entity's snapshot instants are MONOTONIC
 *
 * The window is *the last N successes by `succeeded_at`*, and a consumer reaps
 * whatever predates the oldest of them. Nothing says those successes postdate
 * the run currently committing — and where they do not, a run reaps rows IT
 * JUST WROTE, in both consumers alike.
 *
 * A deployment cannot reach that state: `succeeded_at` is the run's snapshot
 * instant, `withWarehouseRunLock` serializes runs per workspace, and a region's
 * clock is one clock, so an entity's instants only ever increase. A FIXTURE
 * reaches it easily, and one did — `warehouse-run-lock-pg.test.ts` drives four
 * runs at hand-picked instants and its `afterEach` did not clear this table, so
 * successes at 13:05 from an earlier test licensed a reap of the facts a later
 * test wrote at 11:00. Measured on CI, not reasoned about; the three fixtures
 * that leaked now clear it.
 *
 * Stated rather than defended against. A guard would be machinery for a state
 * the lock already prevents, and the honest record of an assumption is the
 * assumption written where the next person meets it.
 */
export const WAREHOUSE_SUCCESS_WINDOW_CTE = `recent AS (
    SELECT succeeded_at
      FROM brain_warehouse_entity_success
     WHERE workspace_id = $1 AND entity = $2
     ORDER BY succeeded_at DESC
     LIMIT $3
  ), gate AS (
    SELECT min(succeeded_at) AS oldest, count(*) AS n FROM recent
  )`;

/**
 * Clamp a caller-supplied N to something the window can be safe with.
 *
 * ⚠️ **`0` is the value this exists for.** `gate.n >= 0` is true with `oldest`
 * NULL, so the whole rule would rest on the comparison against NULL being
 * unknown — harmless by luck rather than by design. A rule this destructive
 * does not get to be safe by luck. The seam is test-only on both consumers;
 * clamping it is what keeps a test's convenience from being a production
 * hazard.
 */
export function reapWindowSize(afterSuccessfulRuns?: number): number {
  return Math.max(1, Math.trunc(afterSuccessfulRuns ?? WAREHOUSE_REAP_AFTER_SUCCESSFUL_RUNS));
}
