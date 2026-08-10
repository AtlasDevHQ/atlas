/**
 * The tension sweep's WIRING (#5029, ADR-0037 §7).
 *
 * `tension-sweep-pg.test.ts` owns whether the rule is true — which pairs are in
 * tension, what the caps do, that a second run is a no-op. None of that can be
 * asserted here without a fake answering its own script.
 *
 * What IS here is everything the statement's truth does not cover, and every one
 * of these is a property a real-Postgres suite either cannot reach or would only
 * reach by accident:
 *
 *   - **the lock, and its ORDER.** A `SET LOCAL lock_timeout` issued AFTER the
 *     acquisition bounds nothing at all, and the two statements succeed in
 *     either order — so the bug is invisible to any test that only checks both
 *     ran. `content-mode/adapters/__tests__/brain-facts.test.ts` pins the same
 *     property on the publish path for the same reason.
 *   - **which namespace.** 4771 rather than 5024 is a lock-ORDER decision
 *     (`identity.ts`'s note), and getting it wrong produces a deadlock under
 *     concurrency rather than a failure under test.
 *   - **the bind list.** `$1` is bound at three sites in one statement; a
 *     widened list that renumbered two of them would still run.
 *   - **the truncation arithmetic.** Reaching `TENSION_SWEEP_RUN_CAP` in a
 *     `-pg` fixture costs a thousand-edge corpus to assert one comparison, so
 *     that suite deliberately never trips it — which leaves the flag
 *     unfalsified there. Measured: hard-wiring `truncated: false` survives the
 *     entire `-pg` suite.
 *   - **the contention arm.** `lock_timeout` expiry is a real outcome (the sweep
 *     contends with this workspace's own extraction fiber) and it is reported as
 *     a refusal, not a 500 — which means it is also the arm most likely to grow
 *     into a silent zero.
 */

import { describe, expect, it } from "bun:test";
import {
  RECONCILE_LOCK_NAMESPACE,
  RECONCILE_LOCK_SQL,
  TENSION_EDGE_CAP,
  type ReconcileExecutor,
} from "@atlas/api/lib/brain/reconcile";
import { IDENTITY_MUTATION_LOCK_NAMESPACE, LOCK_NOT_AVAILABLE } from "@atlas/api/lib/brain/identity";
import {
  TENSION_SWEEP_RUN_CAP,
  TENSION_SWEEP_SQL,
  sweepTensionEdges,
} from "@atlas/api/lib/brain/tension-sweep";

interface Call {
  readonly sql: string;
  readonly params: unknown[] | undefined;
}

/**
 * A recording transaction runner.
 *
 * `mintedRows` is how many rows the sweep statement "returns" — the only lever
 * the report's arithmetic reads. `lockError` is thrown from the advisory-lock
 * statement, which is where the one recoverable failure lives.
 */
function harness(opts: { mintedRows?: number; lockError?: unknown } = {}) {
  const calls: Call[] = [];
  const runner = async <T>(fn: (tx: ReconcileExecutor) => Promise<T>): Promise<T> =>
    fn({
      query: async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params });
        if (sql === RECONCILE_LOCK_SQL && opts.lockError !== undefined) throw opts.lockError;
        if (sql === TENSION_SWEEP_SQL) {
          return { rows: Array.from({ length: opts.mintedRows ?? 0 }, () => ({ minted: 1 })) };
        }
        return { rows: [] };
      },
    });
  return { calls, runner };
}

/** A `pg` error as the driver actually shapes it — a `code` on an Error. */
function pgError(code: string): Error & { code: string } {
  return Object.assign(new Error(`simulated ${code}`), { code });
}

describe("the tension sweep's lock (#5029)", () => {
  it("bounds the acquisition BEFORE taking it, and takes reconcile's namespace", async () => {
    const { calls, runner } = harness({ mintedRows: 2 });
    await sweepTensionEdges("ws-1", { withTransaction: runner });

    const timeoutAt = calls.findIndex((c) => c.sql.includes("SET LOCAL lock_timeout"));
    const lockAt = calls.findIndex((c) => c.sql === RECONCILE_LOCK_SQL);
    const sweepAt = calls.findIndex((c) => c.sql === TENSION_SWEEP_SQL);

    expect(timeoutAt, "no `SET LOCAL lock_timeout` — the acquisition below is unbounded, and `pg_advisory_xact_lock` waits forever").toBeGreaterThanOrEqual(0);
    expect(lockAt, "the sweep took no advisory lock at all").toBeGreaterThanOrEqual(0);
    // ORDER is the whole property. Both statements succeed in either order, and
    // a bound set after the acquisition bounds nothing that has already waited.
    expect(timeoutAt, "the timeout is set AFTER the lock is taken — it bounds nothing").toBeLessThan(lockAt);
    expect(lockAt, "the sweep ran before it held the lock").toBeLessThan(sweepAt);

    expect(calls[lockAt]!.params).toEqual([RECONCILE_LOCK_NAMESPACE, "ws-1"]);
    // Asserted as a VALUE too, not only against the imported constant: the
    // constant could be re-pointed and this test would follow it.
    expect(RECONCILE_LOCK_NAMESPACE).toBe(4771);
    // ⚠️ NOT the identity-mutation namespace. Publish takes 5024 precisely so it
    // is never wedged by ingest; the sweep takes 4771 precisely so it IS
    // serialized against ingest, because ingest is the writer it races. Swapping
    // them compiles, passes the `-pg` suite, and produces duplicate edges under
    // concurrency — never under test.
    expect(RECONCILE_LOCK_NAMESPACE).not.toBe(IDENTITY_MUTATION_LOCK_NAMESPACE);
  });

  it("leaves the lock_timeout in force — the documented divergence from publish", async () => {
    // `promoteBrainFacts` resets the bound immediately, because its later
    // statements are row-lock contention with ingest that must be allowed to
    // wait. This transaction's only remaining wait is the table lock an INSERT
    // takes against concurrent DDL, which an admin-triggered sweep should
    // abandon rather than sit through — so the absence of a reset is the
    // decision, and a "consistency" fix would silently change the behaviour.
    const { calls, runner } = harness({ mintedRows: 1 });
    await sweepTensionEdges("ws-1", { withTransaction: runner });

    expect(
      calls.filter((c) => c.sql.includes("lock_timeout = DEFAULT")),
      "the sweep reset its lock_timeout — see the constant's ⚠️; the bound is meant to cover the INSERT as well",
    ).toHaveLength(0);
  });
});

describe("the tension sweep's bind list (#5029)", () => {
  it("binds the workspace, the per-fact cap, and the run cap, in that order", async () => {
    const { calls, runner } = harness({ mintedRows: 0 });
    await sweepTensionEdges("ws-binds", { withTransaction: runner });

    const sweep = calls.find((c) => c.sql === TENSION_SWEEP_SQL);
    expect(sweep, "the sweep statement never ran").toBeDefined();
    // POSITIONALLY, not by membership: the two caps are both plain integers, so
    // a swapped pair type-checks, runs, and silently caps the fan-out at 1000
    // while capping the run at 10.
    expect(sweep!.params).toEqual(["ws-binds", TENSION_EDGE_CAP, TENSION_SWEEP_RUN_CAP]);
    expect(TENSION_EDGE_CAP).not.toBe(TENSION_SWEEP_RUN_CAP);
  });

  it("names exactly the three placeholders it binds, and `$1` at all three of its sites", async () => {
    // `$1` is the workspace and reaches the candidate scan, the existence guard,
    // and the INSERT's own column. A widened bind list that renumbered two of
    // them would still be a legal statement — it would just scope the guard to a
    // different tenant than the rows.
    expect(TENSION_SWEEP_SQL.match(/\$1\b/g) ?? []).toHaveLength(3);
    expect(TENSION_SWEEP_SQL.match(/\$2\b/g) ?? []).toHaveLength(1);
    expect(TENSION_SWEEP_SQL.match(/\$3\b/g) ?? []).toHaveLength(1);
    expect(
      TENSION_SWEEP_SQL.match(/\$[0-9]+/g) ?? [],
      "the statement names a placeholder the caller does not bind",
    ).toHaveLength(5);
  });

  it("writes `brain_edges` and nothing else", async () => {
    // The licence, asserted lexically because it is the whole reason this
    // autonomous writer was allowed. An `UPDATE brain_facts` added here — to
    // stamp a swept marker, say — would pass every behavioural test in the `-pg`
    // suite except the additive one, and that one is easy to "fix" by widening
    // its snapshot.
    const writes = TENSION_SWEEP_SQL.match(/\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+\w+/gi) ?? [];
    expect(writes).toEqual(["INSERT INTO brain_edges"]);
    expect(TENSION_SWEEP_SQL).toContain("'in-tension-with'");
  });
});

describe("the tension sweep's report (#5029)", () => {
  it("counts the rows the statement returned, not the pairs it considered", async () => {
    const { runner } = harness({ mintedRows: 7 });
    const outcome = await sweepTensionEdges("ws-1", { withTransaction: runner });
    expect(outcome).toEqual({ kind: "swept", report: { minted: 7, truncated: false } });
  });

  it("reports `truncated` at the cap and not below it", async () => {
    // THE arm the `-pg` suite structurally cannot reach: tripping
    // TENSION_SWEEP_RUN_CAP there needs a thousand-edge fixture. Measured —
    // hard-wiring `truncated: false` survives that entire suite.
    //
    // Three points, not two, and the boundary is between the first two: `cap-1`
    // and `cap` differ by one row and must differ in the flag, which is what
    // pins `>=` rather than `>`.
    const below = await sweepTensionEdges("ws-1", {
      withTransaction: harness({ mintedRows: TENSION_SWEEP_RUN_CAP - 1 }).runner,
    });
    const at = await sweepTensionEdges("ws-1", {
      withTransaction: harness({ mintedRows: TENSION_SWEEP_RUN_CAP }).runner,
    });
    const none = await sweepTensionEdges("ws-1", { withTransaction: harness().runner });

    expect(below).toEqual({
      kind: "swept",
      report: { minted: TENSION_SWEEP_RUN_CAP - 1, truncated: false },
    });
    expect(at, "a run that minted exactly the cap reported `truncated: false` — the flag tells an admin they are done when the tail is unswept").toEqual({
      kind: "swept",
      report: { minted: TENSION_SWEEP_RUN_CAP, truncated: true },
    });
    // A converged corpus is `{0, false}`, never `{0, true}` — the reading a
    // client renders as "there is more".
    expect(none).toEqual({ kind: "swept", report: { minted: 0, truncated: false } });
  });
});

describe("the tension sweep under lock contention (#5029)", () => {
  it("refuses with an actionable message and never runs the statement", async () => {
    const { calls, runner } = harness({ mintedRows: 5, lockError: pgError(LOCK_NOT_AVAILABLE) });
    const outcome = await sweepTensionEdges("ws-busy", { withTransaction: runner });

    expect(outcome.kind).toBe("contended");
    if (outcome.kind !== "contended") throw new Error("unreachable");
    // The message is the caller's only copy of what happened, so it has to carry
    // both halves: nothing changed, and retrying is the fix.
    expect(outcome.message).toContain("Nothing was changed");
    expect(outcome.message.toLowerCase()).toContain("retry");

    // `mintedRows: 5` is the trap: a build that swallowed the lock failure and
    // carried on would report a successful sweep of five edges, which is the one
    // outcome worse than the refusal — the lock is what makes the statement's
    // dedupe sound.
    expect(
      calls.some((c) => c.sql === TENSION_SWEEP_SQL),
      "the sweep ran after failing to take the lock",
    ).toBe(false);
  });

  it("re-throws every OTHER database failure", async () => {
    // The refusal arm must not become a catch-all. A sweep that answered
    // `contended` on a broken statement would hand an admin "an ingest pass is
    // running" forever, for a fault no retry clears.
    const { runner } = harness({ lockError: pgError("42P01") });
    await expect(sweepTensionEdges("ws-1", { withTransaction: runner })).rejects.toThrow(
      "simulated 42P01",
    );
  });

  it("…and a thrown value that is not an Error at all", async () => {
    // `isLockTimeout` narrows an `unknown`, and the arm that matters is the one
    // where the guard is asked about something with no `code` property. A
    // `typeof err === "object"` test that forgot the null check would throw a
    // TypeError from inside the error handler.
    const { runner } = harness({ lockError: "a bare string" });
    await expect(sweepTensionEdges("ws-1", { withTransaction: runner })).rejects.toBe(
      "a bare string",
    );
  });
});
