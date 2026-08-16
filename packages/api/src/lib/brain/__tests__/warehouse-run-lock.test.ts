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
  const client: InternalPoolClient = {
    query: async (statement: string, args?: unknown[]) => {
      sql.push(statement);
      params.push(args ?? []);
      if (statement.includes("pg_try_advisory_lock")) {
        if (opts.lockThrows) throw opts.lockThrows;
        // ⚠️ `in`, not `??`. With `opts.lock ?? true` a scripted `null` — one of
        // the unreadable verdicts this suite exists to pin — silently became
        // `true`, and the test asserting the throw passed the producer through
        // the lock instead. Caught by running it; reading it, `??` looks right.
        return { rows: [{ locked: "lock" in opts ? opts.lock : true }] };
      }
      if (statement.includes("pg_advisory_unlock")) {
        if (opts.unlockThrows) throw opts.unlockThrows;
        return { rows: [{ released: "unlock" in opts ? opts.unlock : true }] };
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
    expect(rec.released).toEqual([undefined]);
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
    // Nothing was locked, so nothing is unlocked, and the client goes back
    // clean — a contract fault must not also cost a connection.
    expect(rec.sql).toHaveLength(1);
    expect(rec.released).toEqual([undefined]);
  });

  it("throws when the lock statement returns no row at all", async () => {
    const released: (Error | undefined)[] = [];
    const client: InternalPoolClient = {
      query: async () => ({ rows: [] as Record<string, unknown>[] }),
      release: (err?: Error) => released.push(err),
    };

    await expect(
      withWarehouseRunLock(WORKSPACE, async () => "report", { connect: async () => client }),
    ).rejects.toThrow(WarehouseRunLockContractError);
    expect(released).toEqual([undefined]);
  });
});
