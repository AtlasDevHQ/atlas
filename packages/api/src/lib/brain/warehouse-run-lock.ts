/**
 * The **warehouse producer's run lock** (#5228, ADR-0039).
 *
 * One workspace, one producer run at a time — across processes, across replicas,
 * and across the two triggers that now exist.
 *
 * ## Why `ON CONFLICT` is not the answer, and this is
 *
 * `runWarehouseProducer` takes ONE snapshot instant per run and stamps it into
 * every episode's `source_id` (`warehouse:<entity>@<instant>`), so the episode
 * table's `ON CONFLICT (workspace_id, source, source_id) DO NOTHING` makes a
 * re-run *at the same instant* a no-op. Two OVERLAPPING runs are not at the same
 * instant. They take two `new Date()` readings milliseconds apart, mint two
 * distinct source ids, and both insert — and then both reconcile the same rows
 * they each read, so the second run's claims arrive as a *second reading of the
 * same values*. The dedupe everybody points at dedupes nothing here; it was only
 * ever a guard against pressing the button twice inside one millisecond.
 *
 * The cost is paid where ADR-0039 says the product's scarce resource is: the
 * review queue. `reconcile.ts` CORROBORATES an unchanged value rather than
 * minting a fresh draft, so a duplicate run is not a doubled queue — but every
 * changed value costs a draft **and** a tension edge (ADR-0037 §4), and two runs
 * straddling a warehouse write turn one human decision into two.
 *
 * ## A SESSION lock, not a transaction lock, and that is forced
 *
 * Every other advisory lock in the tree is `pg_advisory_xact_lock` inside one
 * transaction (`internal.ts`). A producer run cannot be: it opens **one
 * transaction per entity** (`withBrainTransaction`, and the per-entity `catch`
 * that turns a failure into a typed refusal depends on that boundary). A
 * transaction-scoped lock would release at the first entity's COMMIT and guard
 * the run's first slice only — which is worse than no lock, because it looks
 * like one.
 *
 * So the lock is held on a DEDICATED pooled client for the whole run, and it is
 * released explicitly. That has two consequences a caller must respect:
 *
 *   - **Never nest.** The internal pool is bounded (max 5) and the run inside
 *     `fn` checks out its own clients per entity. A second lock inside `fn` is a
 *     second checkout under a held one — the nested-pool starvation
 *     `withWorkspaceAdminLocks` documents. A nested call would in any case take
 *     a DIFFERENT session and simply decline, so it buys nothing.
 *   - **Run workspaces SEQUENTIALLY.** N concurrent locked runs pin N of the
 *     five clients before doing any work. The cadence fiber does exactly one at
 *     a time for this reason.
 *
 * ## TRY, not wait
 *
 * `pg_try_advisory_lock` declines instead of queueing, and declining is the
 * correct answer rather than the cheap one. A run that waits for the run ahead
 * of it re-reads a warehouse that was just read, at a fresh instant, and files
 * its findings as a second reading — precisely the duplicate this lock exists to
 * prevent, arriving a few minutes later with the queue behind it. There is
 * nothing for a queued run to do that the run it waited for did not already do.
 *
 * A caller that declines is told so ({@link WarehouseRunLockOutcome}) rather
 * than being handed a fabricated empty report: "a run is already in progress" and
 * "your reach produced nothing" are different sentences, and an operator who
 * cannot tell them apart will un-enroll a working pair.
 */

import { createHash } from "node:crypto";
import { createLogger } from "@atlas/api/lib/logger";
import { getInternalDB, type InternalPoolClient } from "@atlas/api/lib/db/internal";

const log = createLogger("brain.warehouse-run-lock");

/**
 * The `classkey` arg of the two-arg advisory-lock space, per this repo's
 * convention: the value is the issue number that introduced the lock (#5228).
 *
 * Postgres keeps the single-arg `pg_advisory_lock(bigint)` and two-arg
 * `(int4, int4)` spaces fully disjoint, so this can never collide with the
 * migration lock or the plugin-config backfill. The two-arg peers are the
 * last-admin guard (`3158`), the chat-install gate (`3001`), `lead-outbox`
 * (`2870`), the Stripe webhook lock (`3445`), the demo seed (`3683`), the
 * knowledge-collection install gate (`4235`) and the brain reconcile stage
 * (`4771`); all eight namespaces are pairwise distinct.
 */
export const WAREHOUSE_RUN_LOCK_NAMESPACE = 5228;

/**
 * The lock reported something that is neither `true` nor `false`.
 *
 * Its own class, and it is deliberately not folded into "declined". A reader
 * that cannot parse `pg_try_advisory_lock`'s answer does not know whether the
 * lock is held, and the two safe-looking guesses are both wrong in the direction
 * that matters: treating it as ACQUIRED runs the producer unguarded, and
 * treating it as DECLINED reports "a run is already in progress" to an operator
 * whose workspace has no run at all — forever, on every press, with no error
 * anywhere. This throws instead, and the trigger surfaces it as the fault it is.
 */
export class WarehouseRunLockContractError extends Error {
  override readonly name = "WarehouseRunLockContractError";
}

/**
 * What the lock did, and — when it ran — what `fn` returned.
 *
 * A discriminated union rather than `T | null`, because `null` is a value a
 * producer trigger could legitimately return and the two must never merge.
 */
export type WarehouseRunLockOutcome<T> =
  | { readonly acquired: true; readonly value: T }
  | { readonly acquired: false };

/** The one I/O seam, defaulted to the internal pool. */
export interface WarehouseRunLockDeps {
  readonly connect?: () => Promise<InternalPoolClient>;
}

const TRY_LOCK_SQL = "SELECT pg_try_advisory_lock($1, hashtext($2)) AS locked";
const UNLOCK_SQL = "SELECT pg_advisory_unlock($1, hashtext($2)) AS released";

/**
 * A stable, non-reversible tag for a workspace id, for log lines only.
 *
 * The lock's log lines are operational and are read by whoever is holding a 409;
 * a raw workspace id in them is fine (every other brain log line carries one).
 * This exists for the ONE line that cannot carry it — the unlock failure, which
 * is logged from a `finally` that may be unwinding an error whose message the
 * caller has already decided not to put on the wire. Correlating two log lines
 * needs a stable token, not the id itself.
 */
function lockTag(workspaceId: string): string {
  return createHash("sha256").update(workspaceId).digest("hex").slice(0, 12);
}

/**
 * Run `fn` holding this workspace's producer lock, or decline.
 *
 * Returns `{ acquired: false }` — without running `fn` — when another run
 * already holds it. Anything `fn` throws propagates unchanged, after the lock is
 * released.
 *
 * @param workspaceId the workspace whose run is being serialized
 * @param fn the run. **Must not** take this lock again, and must not be run
 *   concurrently for several workspaces (see the module header).
 */
export async function withWarehouseRunLock<T>(
  workspaceId: string,
  fn: () => Promise<T>,
  deps: WarehouseRunLockDeps = {},
): Promise<WarehouseRunLockOutcome<T>> {
  const connect = deps.connect ?? (() => getInternalDB().connect());
  const client = await connect();
  let held = false;
  /**
   * Set when the session may STILL hold the lock at release time. Passing a
   * truthy error to `release` tells node-postgres to destroy the socket instead
   * of returning it to the pool — and destroying the connection is what makes
   * the server drop a session-scoped lock we failed to unlock. Without this, one
   * failed `pg_advisory_unlock` poisons a pooled connection with a permanent
   * lock and this workspace's producer never runs again for the life of the
   * process, silently, because every later run reads a legitimate-looking
   * "already in progress".
   */
  let poison: Error | undefined;
  try {
    const res = await client.query(TRY_LOCK_SQL, [WAREHOUSE_RUN_LOCK_NAMESPACE, workspaceId]);
    const locked = res.rows[0]?.locked;
    if (locked === false) {
      log.info(
        { workspaceId },
        "Warehouse producer: a run is already in progress for this workspace — declining rather than queueing a second reading",
      );
      return { acquired: false };
    }
    if (locked !== true) {
      throw new WarehouseRunLockContractError(
        `pg_try_advisory_lock answered ${typeof locked} rather than a boolean — the warehouse run lock cannot report whether it is held.`,
      );
    }
    held = true;
    return { acquired: true, value: await fn() };
  } finally {
    if (held) {
      try {
        const res = await client.query(UNLOCK_SQL, [WAREHOUSE_RUN_LOCK_NAMESPACE, workspaceId]);
        if (res.rows[0]?.released !== true) {
          poison = new Error("pg_advisory_unlock reported the lock was not held");
          log.error(
            { workspaceId, lockTag: lockTag(workspaceId) },
            "Warehouse producer: releasing the run lock reported it was not held — destroying the connection so the session lock cannot outlive it",
          );
        }
      } catch (err) {
        poison = err instanceof Error ? err : new Error(String(err));
        log.error(
          { workspaceId, lockTag: lockTag(workspaceId), err: poison.message },
          "Warehouse producer: releasing the run lock failed — destroying the connection so the session lock cannot outlive it",
        );
      }
    }
    client.release(poison);
  }
}
