/**
 * The warehouse producer's run lock, against an injected client (#5228).
 *
 * This suite owns the lock's PROTOCOL — which statements it issues, what it does
 * with each answer, and above all what it does to the CONNECTION when releasing
 * fails. `warehouse-run-lock-pg.test.ts` owns the only claim a mock cannot
 * settle: that two genuinely overlapping runs produce one snapshot's worth of
 * facts.
 *
 * The release path is where the interesting failures are, and none of them is
 * visible from the caller. A session-scoped advisory lock outlives the statement
 * that took it, so a client handed back to the pool still holding one poisons a
 * connection for the life of the process — and the symptom is not an error, it
 * is this workspace's producer answering "a run is already in progress" forever
 * to an operator whose workspace has no run at all.
 */

import { describe, expect, it } from "bun:test";
import {
  WAREHOUSE_RUN_LOCK_NAMESPACE,
  WarehouseRunLockContractError,
  withWarehouseRunLock,
} from "@atlas/api/lib/brain/warehouse-run-lock";
import type { InternalPoolClient } from "@atlas/api/lib/db/internal";
import { RECONCILE_LOCK_NAMESPACE } from "@atlas/api/lib/brain/reconcile";
import { VOCABULARY_LOCK_NAMESPACE } from "@atlas/api/lib/brain/vocabulary";
import { IDENTITY_MUTATION_LOCK_NAMESPACE } from "@atlas/api/lib/brain/identity";

const WORKSPACE = "ws-5228";

interface Recorder {
  readonly client: InternalPoolClient;
  readonly sql: string[];
  readonly params: unknown[][];
  /** `undefined` means a clean release; an Error means the socket was destroyed. */
  readonly released: (Error | undefined)[];
}

/**
 * A client whose answers are scripted per statement.
 *
 * `lock` / `unlock` take the VALUE the column carries or a thunk that throws, so
 * a test can say "the unlock statement rejects" without matching on SQL text at
 * the call site.
 */
function recorder(opts: {
  readonly lock?: unknown;
  readonly lockThrows?: Error;
  readonly unlock?: unknown;
  readonly unlockThrows?: Error;
}): Recorder {
  const sql: string[] = [];
  const params: unknown[][] = [];
  const released: (Error | undefined)[] = [];
  /** The key the lock was actually taken on — `null` until it is taken. */
  let heldKey: string | null = null;
  const client: InternalPoolClient = {
    query: async (statement: string, args?: unknown[]) => {
      sql.push(statement);
      params.push(args ?? []);
      // The KEY a statement resolves to: the advisory function's ARGUMENT LIST
      // (`$1, hashtext($2)`) plus the values bound to it. Taking the argument
      // list rather than the whole statement is what lets the lock's and the
      // unlock's keys be compared despite their different result aliases.
      const argList = /advisory_(?:un)?lock\((.*?)\)\s+AS/.exec(statement)?.[1] ?? statement;
      const key = `${JSON.stringify(args ?? [])}|${argList}`;
      if (statement.includes("pg_try_advisory_lock")) {
        if (opts.lockThrows) throw opts.lockThrows;
        const locked = "lock" in opts ? opts.lock : true;
        if (locked === true) heldKey = key;
        // ⚠️ `in`, not `??`. With `opts.lock ?? true` a scripted `null` — one of
        // the unreadable verdicts this suite exists to pin — silently became
        // `true`, and the test asserting the throw passed the producer through
        // the lock instead. Caught by running it; reading it, `??` looks right.
        return { rows: [{ locked, key: 12345 }] };
      }
      if (statement.includes("pg_advisory_unlock")) {
        if (opts.unlockThrows) throw opts.unlockThrows;
        if ("unlock" in opts) return { rows: [{ released: opts.unlock }] };
        // ⚠️ **Models Postgres: releasing a key this session does not hold
        // answers `false`.** A flat `true` agreed with ANY unlock statement — so
        // changing `UNLOCK_SQL` to `pg_advisory_unlock($1, 0)` was green here,
        // and green in `-pg` too (there the false answer poisons, the socket is
        // destroyed, and the server drops the session lock anyway, so every
        // overlap assertion still holds). The lock's correctness would have
        // rested silently on connection destruction, tearing down a pooled
        // connection on every single run. Only a fixture that knows which key it
        // handed out can see it.
        return { rows: [{ released: key === heldKey }] };
      }
      throw new Error(`unexpected statement: ${statement}`);
    },
    release: (err?: Error) => released.push(err),
  };
  return { client, sql, params, released };
}

const run = (rec: Recorder, fn: () => Promise<unknown>) =>
  withWarehouseRunLock(WORKSPACE, fn, { connect: async () => rec.client });

describe("withWarehouseRunLock — acquiring", () => {
  it("takes a SESSION lock in the two-arg namespace, runs fn, and hands back its value", async () => {
    const rec = recorder({});
    const outcome = await run(rec, async () => "report");

    expect(outcome).toEqual({ acquired: true, value: "report" });
    // ⚠️ NOT `_xact_`. A run opens one transaction per entity, so a
    // transaction-scoped lock would release at the first COMMIT and guard the
    // run's first slice only — which is worse than no lock because it looks like
    // one. This assertion is the whole reason the distinction survives a refactor.
    expect(rec.sql[0]).toContain("pg_try_advisory_lock");
    expect(rec.sql[0]).not.toContain("pg_advisory_xact_lock");
    // TRY, not wait: a queued run re-reads a warehouse that was just read and
    // files a second reading, which is the duplicate the lock exists to prevent.
    expect(rec.sql[0]).not.toMatch(/pg_advisory_lock\(/);
    expect(rec.params[0]).toEqual([WAREHOUSE_RUN_LOCK_NAMESPACE, WORKSPACE]);
  });

  it("carries a NULL run result without merging it into the decline", async () => {
    // The union's stated reason — "`null` is a value a producer trigger could
    // legitimately return and the two must never merge" — had no test, so a
    // `T | null` return type would have satisfied everything else in this file.
    const rec = recorder({});
    expect(await run(rec, async () => null)).toEqual({ acquired: true, value: null });
  });

  it("releases the lock and returns the client CLEAN when the run succeeds", async () => {
    const rec = recorder({});
    await run(rec, async () => "report");

    expect(rec.sql).toHaveLength(2);
    expect(rec.sql[1]).toContain("pg_advisory_unlock");
    expect(rec.params[1]).toEqual([WAREHOUSE_RUN_LOCK_NAMESPACE, WORKSPACE]);
    // `undefined` — the socket goes back to the pool. Any Error here would mean
    // a healthy connection was destroyed on every single run.
    expect(rec.released).toEqual([undefined]);
  });

  it("releases the lock and re-throws when the run throws", async () => {
    const rec = recorder({});
    const boom = new Error("snapshot failed");

    await expect(
      run(rec, async () => {
        throw boom;
      }),
    ).rejects.toThrow("snapshot failed");

    // The unlock ran anyway. Without it, one failing run holds this workspace's
    // lock until the process exits.
    expect(rec.sql[1]).toContain("pg_advisory_unlock");
    expect(rec.released).toEqual([undefined]);
  });
});

describe("withWarehouseRunLock — declining", () => {
  it("does not run fn, and does NOT unlock, when the lock is held elsewhere", async () => {
    const rec = recorder({ lock: false });
    let ran = false;

    const outcome = await run(rec, async () => {
      ran = true;
      return "report";
    });

    expect(outcome).toEqual({ acquired: false });
    expect(ran).toBe(false);
    // ⚠️ THE SECOND HALF IS THE ONE THAT MATTERS. `pg_advisory_unlock` released
    // from a session that never took the lock is a no-op HERE — but the shape
    // "unlock in a finally regardless of whether we acquired" is one edit away
    // from releasing a lock this session does hold for another reason, and it
    // would log a spurious "the lock was not held" error on every declined run.
    expect(rec.sql).toHaveLength(1);
    // A DECLINE is the one path that proves the session is lock-free, so this is
    // the only non-acquiring exit that may pool the client. Contrast the two
    // unknown-verdict tests below, which must destroy it.
    expect(rec.released).toEqual([undefined]);
  });
});

describe("withWarehouseRunLock — the connection", () => {
  it("checks out exactly ONE client for the whole run", async () => {
    // ⚠️ The recorder hands back the SAME client every time, so a `connect()`
    // moved into the `finally` — unlocking on a DIFFERENT session, returning
    // `false`, poisoning the wrong connection and leaking the locked one — is
    // invisible to every other assertion in this file. Counting is the only way
    // to see it from outside.
    let connects = 0;
    const rec = recorder({});
    await withWarehouseRunLock(WORKSPACE, async () => "report", {
      connect: async () => {
        connects++;
        return rec.client;
      },
    });

    expect(connects).toBe(1);
  });

  it("propagates a checkout failure rather than reporting it as a decline", async () => {
    let ran = false;

    // Pool exhaustion rendered as `{ acquired: false }` would tell an operator a
    // run is already in progress — permanently, on every press, with no error
    // anywhere. That is the failure this module exists to refuse, arriving
    // through the one seam that has not run a statement yet.
    await expect(
      withWarehouseRunLock(
        WORKSPACE,
        async () => {
          ran = true;
        },
        {
          connect: async () => {
            throw new Error("pool exhausted");
          },
        },
      ),
    ).rejects.toThrow("pool exhausted");
    expect(ran).toBe(false);
  });
});

describe("withWarehouseRunLock — the release path", () => {
  it("DESTROYS the connection when the unlock reports the lock was not held", async () => {
    const rec = recorder({ unlock: false });

    const outcome = await run(rec, async () => "report");

    expect(outcome).toEqual({ acquired: true, value: "report" });
    // Truthy ⇒ node-postgres destroys the socket instead of pooling it, which is
    // what makes the SERVER drop a session lock we could not release. A clean
    // release here pools a connection holding this workspace's lock forever.
    expect(rec.released[0]).toBeInstanceOf(Error);
  });

  it("DESTROYS the connection when the unlock statement itself rejects", async () => {
    const rec = recorder({ unlockThrows: new Error("connection reset") });

    const outcome = await run(rec, async () => "report");

    expect(outcome).toEqual({ acquired: true, value: "report" });
    expect(rec.released[0]).toBeInstanceOf(Error);
  });

  it("does not let a THROWING release replace the run's error", async () => {
    // ⚠️ The existing "does not swallow" test makes the UNLOCK STATEMENT throw,
    // not `release` — so deleting the try/catch around `client.release(poison)`
    // was green. node-postgres throws on a double release, and a `finally` that
    // throws replaces the run's error with a pool-internals one, which is the
    // error the caller actually needs.
    const sql: string[] = [];
    const client: InternalPoolClient = {
      query: async (statement: string) => {
        sql.push(statement);
        return statement.includes("pg_try_advisory_lock")
          ? { rows: [{ locked: true, key: 1 }] }
          : { rows: [{ released: true }] };
      },
      release: () => {
        throw new Error("Release called on client which has already been released");
      },
    };

    await expect(
      withWarehouseRunLock(
        WORKSPACE,
        async () => {
          throw new Error("snapshot failed");
        },
        { connect: async () => client },
      ),
    ).rejects.toThrow("snapshot failed");
  });

  it("does not swallow the RUN's error while destroying the connection", async () => {
    const rec = recorder({ unlockThrows: new Error("connection reset") });

    // The run's error is the one the caller needs; the unlock failure is
    // operational and belongs in the log. A `finally` that threw would replace
    // one with the other.
    await expect(
      run(rec, async () => {
        throw new Error("snapshot failed");
      }),
    ).rejects.toThrow("snapshot failed");
    expect(rec.released[0]).toBeInstanceOf(Error);
  });
});

describe("withWarehouseRunLock — an unreadable verdict", () => {
  it.each([
    ["null", null],
    ["the string 't'", "t"],
    ["the number 1", 1],
  ])("throws rather than guessing when pg_try_advisory_lock answers %s", async (_label, value) => {
    const rec = recorder({ lock: value });
    let ran = false;

    // Both safe-looking guesses are wrong in the direction that matters:
    // ACQUIRED runs the producer unguarded, DECLINED tells an operator a run is
    // in progress forever with no error anywhere.
    await expect(run(rec, async () => void (ran = true))).rejects.toThrow(
      WarehouseRunLockContractError,
    );
    expect(ran).toBe(false);
    expect(rec.sql).toHaveLength(1);
    // ⚠️ **DESTROYED, and the previous version of this assertion was the bug.**
    // It read `toEqual([undefined])` under the comment "Nothing was locked, so
    // nothing is unlocked" — a premise nothing establishes. An unreadable
    // verdict means the ROW SHAPE was unreadable, never that the function did
    // not run, and `"t"` / `1` are what a driver or a pooling proxy produce for
    // a lock that genuinely WAS taken. Pooling that client wedges this
    // workspace's producer behind a permanent, legitimate-looking "already in
    // progress" — the exact outcome this module's docstring refuses.
    expect(rec.released[0]).toBeInstanceOf(Error);
  });

  it("throws — and destroys the connection — when the lock statement returns no row at all", async () => {
    const released: (Error | undefined)[] = [];
    const client: InternalPoolClient = {
      query: async () => ({ rows: [] as Record<string, unknown>[] }),
      release: (err?: Error) => released.push(err),
    };

    await expect(
      withWarehouseRunLock(WORKSPACE, async () => "report", { connect: async () => client }),
    ).rejects.toThrow(WarehouseRunLockContractError);
    expect(released[0]).toBeInstanceOf(Error);
  });

  it("destroys the connection when the ACQUISITION STATEMENT itself rejects", async () => {
    const rec = recorder({ lockThrows: new Error("canceling statement due to statement timeout") });
    let ran = false;

    await expect(run(rec, async () => void (ran = true))).rejects.toThrow("statement timeout");
    expect(ran).toBe(false);
    // Measured, not argued: a session-scoped advisory lock survives its
    // transaction's ROLLBACK, so a cancel arriving AFTER the function evaluated
    // leaves the lock held while the caller sees only a rejection. "We saw an
    // error, therefore nothing was locked" is false.
    expect(rec.released[0]).toBeInstanceOf(Error);
  });
});

describe("the advisory-lock namespace", () => {
  it("does not collide with any peer in the two-arg space", () => {
    // ⚠️ HAND-TYPED, deliberately. `expect(NAMESPACE).toEqual(NAMESPACE)` is the
    // fixture that agrees by construction: setting the constant to 4771 —
    // reconcile's namespace, which would serialize every producer run against
    // `reconcileFacts` — left every test in the tree green. Two independent
    // spellings is the whole mechanism (`brain-facts.test.ts` does the same).
    //
    // The peer list is the complete two-arg space as of #5228. The module's own
    // enumeration shipped INCOMPLETE in review round 1 — it omitted 5022 and
    // 5024 while concluding "all eight are pairwise distinct" — so this list is
    // the one that has to be re-derived when a namespace is added.
    const peers = [
      // The three that are EXPORTED are imported, so they cannot drift from
      // their definitions. The other six are module-private constants, so a
      // literal is the only option — the module docstring says which is which
      // rather than claiming a derivation this test does not perform.
      RECONCILE_LOCK_NAMESPACE,
      VOCABULARY_LOCK_NAMESPACE,
      IDENTITY_MUTATION_LOCK_NAMESPACE,
      2870, // lead-outbox/outbox.ts
      3001, // chat-install gate — billing/enforcement.ts
      3158, // last-admin guard — db/internal.ts
      3445, // Stripe webhook — db/internal.ts
      3683, // demo seed — db/internal.ts
      4235, // knowledge-collection install — billing/enforcement.ts
    ];
    expect(peers).not.toContain(WAREHOUSE_RUN_LOCK_NAMESPACE);
    expect(new Set(peers).size).toBe(peers.length);
  });
});
