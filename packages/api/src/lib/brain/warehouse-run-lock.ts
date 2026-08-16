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
 * Every two-arg, workspace-scoped advisory lock in the tree is
 * `pg_advisory_xact_lock` inside one transaction (`internal.ts`). A producer run
 * cannot be: it opens **one transaction per entity** (`withBrainTransaction`,
 * and the per-entity `catch` that turns a failure into a typed refusal depends
 * on that boundary). A transaction-scoped lock would release at the first
 * entity's COMMIT and guard the run's first slice only — which is worse than no
 * lock, because it looks like one.
 *
 * The session-scoped shape it takes instead is not new here: `db/migrate.ts` and
 * `db/backfill-plugin-config.ts` already hold a single-arg session lock on a
 * dedicated client with an explicit unlock. This applies the same shape per
 * workspace rather than per process.
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
 *
 * ⚠️ **The peers' `hashtext`-collision argument does NOT transfer to this lock.**
 * Every two-arg peer in `db/internal.ts` carries the same reassurance — *"a
 * cross-workspace hash collision only costs extra serialization, never
 * correctness"* — and that holds because they are WAITING locks
 * (`pg_advisory_xact_lock`). A collision here does not serialize, it DECLINES,
 * and the decline is reported as *"a run is already in progress for this
 * workspace"* about a workspace that has no run. The blast radius is one missed
 * tick (the next one runs, and the loop is sequential, so it needs concurrent
 * replicas or an operator press to bite at all) — but it is a false sentence in
 * an operator's log, so the decline line carries the resolved key to make a
 * collision greppable.
 */

import { createLogger } from "@atlas/api/lib/logger";
import { errorMessage } from "@atlas/api/lib/audit/error-scrub";
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
 * knowledge-collection install gate (`4235`), the brain reconcile stage
 * (`4771`), the vocabulary lock (`5022`) and the identity-mutation lock
 * (`5024`); all ten namespaces are pairwise distinct.
 *
 * ⚠️ **This enumeration is checked, not trusted.** Its first draft listed seven
 * peers and concluded "all eight are pairwise distinct" — omitting `5022` and
 * `5024`, both live two-arg namespaces. There was no collision, which is the
 * problem: a sentence that reads as a completed audit of the space, and isn't
 * one, is how the NEXT namespace collides.
 *
 * `__tests__/warehouse-run-lock.test.ts` pins it, and the three peers that are
 * EXPORTED constants are IMPORTED there rather than retyped, so those three
 * cannot drift from their definitions. The other six are literals because their
 * constants are module-private — the test says which is which, rather than
 * claiming a derivation it does not perform.
 */
export const WAREHOUSE_RUN_LOCK_NAMESPACE = 5228;

/**
 * The lock reported something that is neither `true` nor `false`.
 *
 * Its own class. A reader
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

// `key` comes back so a `hashtext` collision — two workspaces resolving to one
// int4 — is visible by grep. Without it, a decline naming the wrong workspace is
// indistinguishable in the log from a genuine one.
const TRY_LOCK_SQL =
  "SELECT pg_try_advisory_lock($1, hashtext($2)) AS locked, hashtext($2) AS key";
const UNLOCK_SQL = "SELECT pg_advisory_unlock($1, hashtext($2)) AS released";

/** The error's class name — non-secret, and lost when a stack is scrubbed away. */
function errorName(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}

/**
 * A pg `SQLSTATE`, when the thrown value carries one.
 *
 * Five characters, from a fixed vocabulary, and it cannot contain a credential —
 * which is what makes it safe to log beside a scrubbed message.
 */
function pgCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
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
  /**
   * Set when we cannot PROVE the session is lock-free.
   *
   * ⚠️ **`held === false` does not mean "nothing was locked".** Two paths leave
   * the try block without setting `held`, and on both the server may already
   * hold the lock:
   *
   *   - the ACQUISITION STATEMENT REJECTING. Measured rather than argued: a
   *     session-scoped advisory lock taken inside a transaction survives that
   *     transaction's `ROLLBACK` (`BEGIN; pg_try_advisory_lock(…); ROLLBACK;`
   *     leaves one row in `pg_locks` for the same backend). So a cancel, a
   *     `statement_timeout`, or a dropped response AFTER the function evaluated
   *     leaves the lock held while the caller sees only a rejection.
   *   - the CONTRACT ERROR. An unreadable verdict means the ROW SHAPE was
   *     unreadable, never that the function did not run — and `"t"` / `1` are
   *     what a driver, a pooling proxy or a `::text` cast produce for a lock that
   *     genuinely WAS acquired.
   *
   * Destroying a socket on a fault that fires ~never is trivially cheaper than a
   * wedged pool slot, so the default is "cannot prove it is free ⇒ destroy it".
   */
  let lockStateUnknown: "acquisition-rejected" | "unreadable-verdict" | undefined;
  try {
    // `Awaited<ReturnType<...>>` rather than a hand-written shape: the real
    // return also carries `rowCount`, and a literal annotation is a claim about
    // another module that drifts.
    let res: Awaited<ReturnType<InternalPoolClient["query"]>>;
    try {
      res = await client.query(TRY_LOCK_SQL, [WAREHOUSE_RUN_LOCK_NAMESPACE, workspaceId]);
    } catch (err) {
      lockStateUnknown = "acquisition-rejected";
      throw err instanceof Error ? err : new Error(String(err));
    }
    const locked = res.rows[0]?.locked;
    if (locked === false) {
      log.info(
        { workspaceId, lockKey: res.rows[0]?.key },
        "Warehouse producer: a run is already in progress for this workspace — declining rather than queueing a second reading",
      );
      return { acquired: false };
    }
    if (locked !== true) {
      lockStateUnknown = "unreadable-verdict";
      throw new WarehouseRunLockContractError(
        `pg_try_advisory_lock answered ${typeof locked} rather than a boolean — the warehouse run lock cannot report whether it is held.`,
      );
    }
    held = true;
    return { acquired: true, value: await fn() };
  } finally {
    if (!held && lockStateUnknown) {
      // ⚠️ The CAUSE, not one sentence for both. The two paths lead an operator
      // to different places: a rejected acquisition points at the internal DB's
      // health and statement timeouts, an unreadable verdict points at the
      // driver, a pooling proxy or a `::text` cast. One message would be right
      // half the time.
      poison = new Error(
        `the warehouse run lock's state is unknown (${lockStateUnknown}) — the session may hold it`,
      );
      log.error(
        { workspaceId, cause: lockStateUnknown },
        lockStateUnknown === "acquisition-rejected"
          ? "Warehouse producer: the run-lock acquisition statement was rejected — a session-scoped lock survives its transaction's rollback, so the session may hold it; destroying the connection"
          : "Warehouse producer: pg_try_advisory_lock answered a shape this reader cannot parse — the session may hold it; destroying the connection",
      );
    }
    if (held) {
      try {
        const res = await client.query(UNLOCK_SQL, [WAREHOUSE_RUN_LOCK_NAMESPACE, workspaceId]);
        if (res.rows[0]?.released !== true) {
          poison = new Error("pg_advisory_unlock reported the lock was not held");
          log.error(
            { workspaceId },
            "Warehouse producer: releasing the run lock reported it was not held — destroying the connection so the session lock cannot outlive it",
          );
        }
      } catch (err) {
        poison = err instanceof Error ? err : new Error(String(err));
        log.error(
          // `errorMessage`, not the raw text: `error-scrub.ts` names pg error
          // strings as exactly the class that echoes a connection string, and a
          // failed unlock is the most likely place to meet one.
          //
          // ⚠️ The scrub costs the STACK, which `warehouse-producer.ts` calls
          // "the actionable half" for a pool-or-lock failure — so the two
          // non-secret discriminators are carried back explicitly. `pgCode`
          // (`57014`, `08006`, `53300`) is the single most useful field for this
          // class and cannot contain a credential.
          { workspaceId, err: errorMessage(err), errName: errorName(err), pgCode: pgCode(err) },
          "Warehouse producer: releasing the run lock failed — destroying the connection so the session lock cannot outlive it",
        );
      }
    }
    try {
      client.release(poison);
    } catch (err) {
      // node-postgres throws on a double release. Letting it out of a `finally`
      // would REPLACE the run's error — the thing the caller actually needs —
      // with a pool-internals one. Logged rather than marked
      // `// intentionally ignored:`, since that marker means silence.
      //
      // ⚠️ **Two messages, because "the run is unaffected" is only half the
      // story when we were POISONING.** If `poison` was set and this threw, the
      // socket may not have been destroyed by us — which is the wedged-pool-slot
      // outcome the whole `lockStateUnknown` mechanism exists to prevent,
      // arriving through the one seam that runs after it. A single reassuring
      // sentence would be the last word on it.
      log.error(
        { workspaceId, err: errorMessage(err), poisoned: poison !== undefined },
        poison
          ? "Warehouse producer: DESTROYING the run lock's connection threw — the socket may have been pooled while still holding this workspace's session lock; the run's own outcome is unaffected"
          : "Warehouse producer: releasing the run lock's connection threw — the run's own outcome is unaffected",
      );
    }
  }
}
