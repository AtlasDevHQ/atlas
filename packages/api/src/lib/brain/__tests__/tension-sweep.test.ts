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
 *   - **the contention arms — all THREE.** `lock_timeout` expiry is a real
 *     outcome (the sweep contends with this workspace's own extraction fiber),
 *     and so are the two the STATEMENT can hit under the same bounds. They are
 *     reported as refusals rather than 500s, which makes them the arms most
 *     likely to grow into a silent zero, and they carry three different remedies
 *     that a shared message would collapse.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
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
  contentionMessage,
  pgCode,
  pgWhere,
  sweepTensionEdges,
} from "@atlas/api/lib/brain/tension-sweep";

/** Repo root, from this file at `packages/api/src/lib/brain/__tests__/`. */
const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..", "..", "..");

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
function harness(
  opts: { mintedRows?: number; lockError?: unknown; sweepError?: unknown } = {},
) {
  const calls: Call[] = [];
  const runner = async <T>(fn: (tx: ReconcileExecutor) => Promise<T>): Promise<T> =>
    fn({
      query: async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params });
        if (sql === RECONCILE_LOCK_SQL && opts.lockError !== undefined) throw opts.lockError;
        if (sql === TENSION_SWEEP_SQL) {
          // `sweepError` is a SEPARATE lever from `lockError`, and the separation
          // is the point: the two statements are bounded by the same two `SET
          // LOCAL`s and fail with the same SQLSTATEs, but they mean different
          // things and get different messages. A harness that could only throw
          // from the lock made the statement's own arms untestable — which is
          // how the sweep statement's `55P03` reached the caller as a generic
          // 500 for a whole round.
          if (opts.sweepError !== undefined) throw opts.sweepError;
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

  it("leaves BOTH bounds in force — the documented divergence from publish", async () => {
    // `promoteBrainFacts` resets its bound immediately, because its later
    // statements are row-lock contention with ingest that must be allowed to
    // wait. This transaction's remaining statement is the sweep itself, and both
    // bounds are meant to cover it — which is what makes its two refusal arms
    // reachable at all. So the absence of a reset is the decision here, and a
    // "consistency" fix would silently delete two arms.
    const { calls, runner } = harness({ mintedRows: 1 });
    await sweepTensionEdges("ws-1", { withTransaction: runner });

    expect(
      calls.filter((c) => c.sql.includes("= DEFAULT")),
      "the sweep reset a bound — see the constants' ⚠️; both are meant to cover the sweep statement, and resetting either makes its refusal arm unreachable",
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
    expect(contentionMessage(outcome.reason)).toContain("Nothing was changed");
    expect(contentionMessage(outcome.reason).toLowerCase()).toContain("retry");

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

describe("the tension sweep's STATEMENT bounds (#5029)", () => {
  it("bounds the statement as well as the lock, and sets both before acquiring", async () => {
    // ⚠️ Two DIFFERENT bounds for two different failures, and the run cap is
    // neither. `LIMIT $3` caps the INSERT; the candidate scan underneath it
    // walks every live fact in the workspace regardless, and on an
    // already-swept corpus does that walk in full and mints zero. `lock_timeout`
    // bounds WAITING for a lock, not a statement that is simply running — so
    // without `statement_timeout` a large corpus hangs the request with no log
    // line while holding namespace 4771 against this workspace's ingest, which
    // is the exact outcome the lock bound's own docstring claims to prevent.
    const { calls, runner } = harness({ mintedRows: 1 });
    await sweepTensionEdges("ws-1", { withTransaction: runner });

    const lockBoundAt = calls.findIndex((c) => c.sql.includes("SET LOCAL lock_timeout"));
    const stmtBoundAt = calls.findIndex((c) => c.sql.includes("SET LOCAL statement_timeout"));
    const lockAt = calls.findIndex((c) => c.sql === RECONCILE_LOCK_SQL);

    expect(
      stmtBoundAt,
      "no `SET LOCAL statement_timeout` — the run cap bounds the WRITE, not the scan, so nothing bounds the transaction",
    ).toBeGreaterThanOrEqual(0);
    // BOTH before the acquisition. `SET LOCAL` reverts at COMMIT, so a bound set
    // after a statement has already run governs nothing it was written for.
    expect(lockBoundAt).toBeLessThan(lockAt);
    expect(stmtBoundAt).toBeLessThan(lockAt);
    // Neither is reset — the documented divergence from `promoteBrainFacts`.
    expect(calls.filter((c) => c.sql.includes("= DEFAULT"))).toHaveLength(0);
  });

  it("reports a conflicting-lock refusal when the STATEMENT times out on a lock", async () => {
    // The arm that did not exist for a whole round. The two bounds above are
    // deliberately left in force for this statement, so a `55P03` here is an
    // outcome the design CREATES — and it used to fall through to the generic
    // 500 the repo forbids, indistinguishable from a broken query.
    const { runner } = harness({ sweepError: pgError(LOCK_NOT_AVAILABLE) });
    const outcome = await sweepTensionEdges("ws-1", { withTransaction: runner });

    expect(outcome.kind).toBe("contended");
    if (outcome.kind !== "contended") throw new Error("unreachable");
    // The REASON, not just the refusal: the ingest copy is actively wrong here.
    // "Retry in a few seconds" is false advice for a migration holding a lock.
    expect(outcome.reason).toBe("conflicting-lock");
    expect(contentionMessage(outcome.reason)).not.toContain("reconcile lock");
    // ⚠️ It must not send the admin to wait for MAINTENANCE as the headline.
    // MEASURED against this repo's PG 16: `brain_edges`' composite FKs make this
    // INSERT run `SELECT 1 FROM ONLY brain_facts … FOR KEY SHARE` on both
    // endpoints, which raises `55P03` against any held `FOR UPDATE` — and the
    // two ordinary holders of that are a concurrent publish and a correction,
    // NEITHER of which takes namespace 4771. So the common case is a colleague
    // pressing Publish, and "retry once maintenance has finished" was advice to
    // wait for an event that never arrives.
    expect(contentionMessage(outcome.reason)).toContain("publish or a correction");
    expect(contentionMessage(outcome.reason)).toContain("Retry in a few seconds");
    expect(contentionMessage(outcome.reason)).toContain("Nothing was changed");
  });

  it("reports an `unfinished` refusal whose remedy is true for BOTH members of 57014", async () => {
    const { runner } = harness({ sweepError: pgError("57014") });
    const outcome = await sweepTensionEdges("ws-1", { withTransaction: runner });

    expect(outcome.kind).toBe("contended");
    if (outcome.kind !== "contended") throw new Error("unreachable");
    expect(outcome.reason).toBe("unfinished");

    // ⚠️ `57014` is `query_canceled` GENERALLY — a `statement_timeout` expiry
    // AND an operator `pg_cancel_backend` both raise it, and Postgres gives no
    // SQLSTATE that separates them. So the message may not assume either one.
    //
    // The first cut of this arm did: it was called `too-slow` and said "this is
    // not a transient failure … contact an operator rather than retrying",
    // which is wrong for every cancelled statement — and was contradicted by
    // the module's own `isStatementTimeout` docstring, which justified the
    // conflation on the ground that "retrying is the remedy". Two statements in
    // one commit, disagreeing, with the wrong one published in the OpenAPI
    // description.
    expect(contentionMessage(outcome.reason)).toContain("Retry once");
    expect(
      contentionMessage(outcome.reason),
      "the refusal rules out the remedy that is correct for a cancelled statement",
    ).not.toContain("rather than retrying");
    // …and a REPEAT is not a discriminator either — a supervisor that cancels
    // once cancels twice — so the escalation clause may not name the corpus.
    expect(contentionMessage(outcome.reason)).toContain("operator");
    expect(
      contentionMessage(outcome.reason),
      "the escalation clause asserts the timeout member, which a repeat does not establish",
    ).not.toContain("too large");
  });

  it("keeps the three refusals distinguishable, and none of them says the others' remedy", async () => {
    // The whole reason `reason` exists as a discriminant rather than the caller
    // parsing prose. Three bounds, three remedies: seconds, after-maintenance,
    // stop-pressing. A single arm carrying free text collapses them.
    const byReason = new Map<string, string>();
    for (const [reason, err] of [
      ["reconcile-lock", { lockError: pgError(LOCK_NOT_AVAILABLE) }],
      ["conflicting-lock", { sweepError: pgError(LOCK_NOT_AVAILABLE) }],
      ["unfinished", { sweepError: pgError("57014") }],
    ] as const) {
      const outcome = await sweepTensionEdges("ws-1", { withTransaction: harness(err).runner });
      expect(outcome.kind, `${reason} did not refuse`).toBe("contended");
      if (outcome.kind !== "contended") throw new Error("unreachable");
      expect(outcome.reason).toBe(reason);
      byReason.set(reason, contentionMessage(outcome.reason));
    }

    // Three DISTINCT messages. Sharing one would make `reason` a label over
    // prose that contradicts it.
    expect(new Set(byReason.values()).size).toBe(3);
    // …and every one of them states the invariant that makes a refusal safe.
    for (const [reason, message] of byReason) {
      expect(message, `${reason} does not say nothing changed`).toContain("Nothing was changed");
    }
  });

  it("re-throws a non-timeout failure from the STATEMENT, exactly as it does from the lock", async () => {
    // The refusal arms must not become a catch-all on this side either. A sweep
    // that answered `contended` on a `42P01` would tell an admin to retry past a
    // missing table forever.
    const { runner } = harness({ sweepError: pgError("42P01") });
    await expect(sweepTensionEdges("ws-1", { withTransaction: runner })).rejects.toThrow(
      "simulated 42P01",
    );
  });

  it("propagates a non-Error throw untouched — the shape the narrowers must handle", async () => {
    // ⚠️ RETITLED. It used to be called "logs the SQLSTATE on the failure path"
    // and its comment claimed to check that `pgCode` extracted anything — which
    // it never did: the only assertion is that the thrown value propagates. That
    // mislabelling is how `pgCode` shipped unfalsified in the first place, and
    // leaving it beside the real assertion would let the next auditor land here
    // and get the wrong answer. `pgCode`/`pgWhere` are pinned directly below.
    //
    // What this DOES pin is real and nothing else covers it: a driver can throw
    // a plain object, and every narrower in the module takes `unknown`.
    const notAnError = { code: "42P01", message: "relation does not exist" };
    const { runner } = harness({ sweepError: notAnError });
    // A non-`Error` throw, which is also the shape `isLockTimeout` has to
    // narrow: `rejects.toBe` pins that the value travels untouched rather than
    // being wrapped or swallowed.
    await expect(sweepTensionEdges("ws-1", { withTransaction: runner })).rejects.toBe(notAnError);
  });
});

describe("AC 1 — admin-TRIGGERED, and nothing else calls it (#5029)", () => {
  it("has exactly one non-test caller, and it is the admin route", () => {
    // ⚠️ The acceptance criterion is *"not auto-run and not on the boot path"*,
    // and until this existed it was true only because nobody had written the
    // call. That is a property of the current tree, not of the design — and the
    // failure it guards is silent by construction: a scheduler registration is
    // three lines and turns a human-gated autonomous writer of `brain_edges`
    // into an unattended one, which is precisely the thing ADR-0037 §7 refused
    // (`db/migrations/README.md:93-96`'s advisory-lock stall argument, and the
    // counter-case recorded on the issue).
    //
    // `correction-audit.test.ts`'s caller-discovery sweep is the precedent,
    // including its non-vacuity check: assert the KNOWN caller is found, or a
    // broken grep reports "no callers" and passes.
    const roots = ["packages/api/src", "packages/mcp/src", "packages/cli/src"];
    const files: string[] = [];
    const walk = (dir: string) => {
      let entries: import("node:fs").Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        // intentionally ignored: a root that does not exist in this checkout is
        // covered by the roots-exist assertion below, which names it.
        return;
      }
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".ts") && !full.includes("__tests__")) files.push(full);
      }
    };
    for (const root of roots) {
      expect(existsSync(join(REPO_ROOT, root)), `${root} is gone — the sweep below is vacuous`).toBe(
        true,
      );
      walk(join(REPO_ROOT, root));
    }
    expect(files.length, "the walk found no source files — the guard is vacuous").toBeGreaterThan(
      100,
    );

    // ⚠️ The BARE identifier, not `sweepTensionEdges(`. Measured evasions of the
    // call-shaped form: `workspaceIds.map(sweepTensionEdges)`, which is the
    // natural way to write a per-workspace scheduler tick and therefore the
    // precise failure AC 1 forbids; `{ run: sweepTensionEdges }`; and
    // `const run = sweepTensionEdges`. The import line is excluded rather than
    // the call shape required.
    const callers = files
      .filter((file) =>
        readFileSync(file, "utf8")
          .split("\n")
          .some((line) => /\bsweepTensionEdges\b/.test(line) && !/^\s*(?:import|\})/.test(line)),
      )
      .map((f) => f.slice(REPO_ROOT.length + 1))
      // Its own declaration site.
      .filter((f) => f !== "packages/api/src/lib/brain/tension-sweep.ts");

    // Non-vacuity FIRST: if the known caller is not found, the emptiness below
    // means the grep broke, not that the invariant holds.
    expect(
      callers,
      "the admin route no longer appears as a caller — the discovery grep is broken and the assertion below proves nothing",
    ).toContain("packages/api/src/api/routes/admin-brain-facts.ts");
    expect(
      callers,
      "something other than the admin route calls the sweep. If that is a scheduler, a fiber registration, or anything on the boot path, it violates AC 1 — the sweep is admin-TRIGGERED, and an unattended autonomous writer of `brain_edges` is what ADR-0037 §7 refused",
    ).toEqual(["packages/api/src/api/routes/admin-brain-facts.ts"]);
    // …and belt-and-braces on the two shapes the list above would name.
    for (const forbidden of ["scheduler/", "registerPeriodicFiber", "boot"]) {
      expect(
        callers.some((c) => c.includes(forbidden)),
        `the sweep is reached from ${forbidden}`,
      ).toBe(false);
    }
  });
});

describe("no contention arm asserts a cause the SQLSTATE cannot establish (#5029)", () => {
  /**
   * ⚠️ A MECHANICAL CHECK, because prose failed four times.
   *
   * Every arm of `TensionSweepContention` began life asserting a cause, and all
   * three were wrong: `too-slow` assumed a `statement_timeout` where `57014` is
   * also `pg_cancel_backend`; `ingest` assumed the extraction fiber where
   * namespace 4771 also has a concurrent sweep — created by this very PR; and
   * `table-lock` assumed maintenance where the INSERT's FK check takes
   * `FOR KEY SHARE` on `brain_facts` and therefore waits on any `FOR UPDATE`,
   * which usually means a publish (measured against PG 16).
   *
   * Each was fixed in the message and left standing in a COMMENT beside it, four
   * separate times. `review-panel` Step 5b's rule is that a principle swept twice
   * becomes a check rather than a third comment, and this is that check.
   *
   * ## What it does and does NOT establish — stated precisely, because the first
   * ## version of this docstring over-claimed and its own matchers proved it
   *
   * It catches the SPELLINGS below and nothing else. An earlier line here said
   * it caught "the three causes already paid for", which is a claim about
   * MEANING that a list of regexes cannot make — and two live counterexamples
   * were sitting in the scanned file at the time: `a wait on concurrent DDL`
   * (paid-for cause #1, missed by `/a DDL wait/`) and `a large or never-swept
   * corpus can outrun it` (paid-for cause #2, falling between two matchers
   * pinned to the pre-reword sentences). The guard asserting a coverage it did
   * not have is the same defect it exists to catch, one layer over.
   *
   * So the matchers are written against the CONCEPT — `maintenance|DDL`,
   * `corpus`, `ingest pass` — rather than against historical sentences, and the
   * docstring claims only what a lexical scan can: these words do not appear.
   * A genuinely novel wrong cause still gets past it, and that is the honest
   * limit of a grep.
   */
  const SCANNED = [
    "packages/api/src/lib/brain/tension-sweep.ts",
    // ⚠️ The ROUTE too, and it is not an afterthought: the published OpenAPI
    // description is where an earlier wrong cause did its real damage, and the
    // first version of this guard scanned only the module — so it read green
    // while the 200 description asserted that `minted: 0` meant "the corpus had
    // nothing left to flag", the least likely of that value's three producers.
    "packages/api/src/api/routes/admin-brain-facts.ts",
    // ⚠️ And the LOCK's declaration site, which is the most authoritative copy
    // and the one a future third taker reads first. Round 3 corrected the
    // deadlock-impossible premise in this module and in ADR-0037 and left it
    // standing here — instance closed in two files, class open in the third,
    // precisely because this file was not scanned.
    "packages/api/src/lib/brain/reconcile.ts",
    // ⚠️ And the ADR — which the rationale directly above NAMES as one of the two
    // files that carried the deadlock-impossible premise, while leaving it out of
    // this list. It is the most durable copy of the argument and the one a future
    // third taker of 4771 reads before any docstring. Same shape, one file over,
    // a fourth time.
    "docs/adr/0037-claim-identity-in-the-brain.md",
  ];

  /**
   * Phrasings that assert one member of a class the SQLSTATE does not split.
   *
   * Each carries the planted case that proves it fires. Kept as PAIRS rather
   * than two parallel arrays, so adding one cannot silently mis-align the
   * control against the wrong matcher.
   */
  const DEFEATED: ReadonlyArray<{ readonly pattern: RegExp; readonly planted: string }> = [
    // `conflicting-lock` — asserts maintenance, whose usual holder is a publish.
    { pattern: /(?:once )?maintenance (?:has finished|completes)/i, planted: "Retry once maintenance has finished." },
    { pattern: /\bwait on (?:concurrent )?DDL\b|\ba DDL wait\b/i, planted: "abandon rather than sit through a DDL wait" },
    { pattern: /VACUUM FULL/, planted: "a migration, CREATE INDEX, VACUUM FULL" },
    // `unfinished` — asserts the timeout member, where `57014` is also a cancel.
    // Deliberately concept-scoped (`corpus`), not sentence-scoped: the two
    // reworded survivors this guard missed both said "corpus" and neither
    // matched the sentence-pinned originals.
    // ⚠️ Concept-scoped but not LOOSE. A first cut carried a third alternative,
    // `corpus a?n?d? ?size`, which is not the pattern it looks like — the
    // optional letters make it match a bare "size" — and it fired on a comment
    // EXPLAINING why blaming the corpus is wrong. A matcher that cannot tell an
    // assertion from its own refutation gets exempted, and an exemption is how
    // the phrase comes back.
    // ⚠️ Two alternatives, both REFUSAL-shaped, and a third was tried and
    // dropped. `large…corpus` fired on `TENSION_SWEEP_STATEMENT_TIMEOUT_SQL`'s
    // own rationale — *"without this bound a large corpus produces…"* — which is
    // a true statement about why the bound EXISTS, not a claim about why some
    // observed run failed. A lexical guard cannot tell those apart, and the
    // honest response is a narrower matcher rather than an exemption. Coverage
    // is not lost: the reworded survivor that motivated the widening ("a large
    // or never-swept corpus can outrun it") is caught by `never-swept corpus`.
    { pattern: /corpus (?:is |was )?too large|never-swept corpus/i, planted: "this corpus is too large for a single sweep" },
    { pattern: /will outrun it again|outrun (?:it|the bound) on the next/i, planted: "will outrun it again on the next press" },
    { pattern: /\brather than retrying\b/, planted: "Contact an operator rather than retrying." },
    // `reconcile-lock` — asserts the extraction fiber, where 4771 has two takers.
    // ⚠️ `is (running|reconciling)`, not just `reconciling`. The orphaned
    // `TensionSweepOutcome` docstring survived three rounds carrying "an ingest
    // pass is running" — the same defeated claim, one verb over, and the
    // sentence-pinned matcher walked straight past it. A near-miss is how a
    // lexical guard fails; widen on the noun phrase, not the whole sentence.
    { pattern: /an ingest pass is (?:running|reconciling)/i, planted: "an ingest pass is reconciling this workspace" },
    // A DIFFERENT class from the three above — not "asserts a cause" but
    // "asserts a deadlock is impossible", which is the premise that left `40P01`
    // with no arm for two rounds. Included here because the guard's file list is
    // the only place that reaches all three copies of it.
    // ⚠️ Concept-scoped, and the negative control below carries the QUALIFIED
    // form. Pinned to the historical sentence this missed every natural reword —
    // "no other lock", "neither taker acquires any further lock" — which is the
    // same near-miss failure this file diagnoses two matchers up. The shipped
    // text says "no other ADVISORY lock", so dropping one word is the regression.
    {
      pattern:
        /(?<!advisory )(?:hold(?:s)? ONLY this lock|no other lock(?!\s+of any kind)|nothing else,? ever|acquires? any further lock)/i,
      planted: "Both takers hold ONLY this lock, so no cycle can form",
    },
  ];

  it("proves each matcher on its own planted case before trusting it", () => {
    // Without this the block below is satisfied by seven regexes that match
    // nothing — the shape that makes a guard read green forever.
    //
    // ⚠️ It is a NON-EMPTINESS control, not a calibration one: both sides are
    // hand-written here, so every matcher passes its own case by construction.
    // The calibration control is the negative below, which is the half that
    // caught nothing until it was added.
    for (const { pattern, planted } of DEFEATED) {
      expect(pattern.test(planted), `matcher ${pattern} does not match its own planted case`).toBe(
        true,
      );
    }
  });

  it("does NOT fire on legitimate prose — the negative control", () => {
    // The direction the positive control cannot reach. A matcher broad enough to
    // hit ordinary writing gets deleted by the next person it inconveniences,
    // which is strictly worse than not having it.
    for (const innocent of [
      "it returns the outcome rather than throwing inside the transaction",
      "the run cap bounds the write, and the statement timeout bounds the scan",
      "reconcile takes namespace 4771 and this module takes it too",
      "the candidate scan walks every live fact in the workspace",
      // The bound's own rationale — a true statement about WHY the bound exists,
      // which an over-broad corpus matcher fired on.
      "without this bound a large corpus produces an unbounded scan",
      // The QUALIFIED deadlock claim — true, shipped, and the thing the
      // concept-scoped matcher above must not fire on.
      "both takers hold no other advisory lock, so no cycle with 5022 can form",
      "`57014` is `query_canceled` generally, so the message names neither member",
    ]) {
      for (const { pattern } of DEFEATED) {
        expect(pattern.test(innocent), `${pattern} fires on legitimate prose: "${innocent}"`).toBe(
          false,
        );
      }
    }
  });

  it("finds none of them in the module or in the published route description", () => {
    for (const relative of SCANNED) {
      const source = readFileSync(join(REPO_ROOT, relative), "utf8");
      // ⚠️ Non-vacuity on TEXT, not on identifiers. Keying on
      // `TensionSweepContention` / `CONTENTION_MESSAGE` would survive as bare
      // IMPORTS if the messages were ever extracted to their own module — the
      // guard would then scan a file with no message prose in it and pass
      // forever.
      // Non-vacuity on TEXT each file must carry, not on identifiers that
      // survive as bare imports. Per file, because they hold different halves:
      // the two sweep files carry the refusal prose, `reconcile.ts` carries the
      // lock namespace whose ordering claim is what it is scanned for.
      const sentinel =
        relative === "packages/api/src/lib/brain/reconcile.ts"
          ? "RECONCILE_LOCK_NAMESPACE"
          : relative.endsWith(".md")
            ? "#5029"
            : "Nothing was changed";
      expect(
        source,
        `${relative} no longer carries the prose this guard exists to scan — it moved, and the guard is now vacuous`,
      ).toContain(sentinel);

      for (const { pattern } of DEFEATED) {
        const hit = pattern.exec(source);
        expect(
          hit?.[0],
          `${relative} asserts a cause its SQLSTATE cannot establish: "${hit?.[0]}". Every contention arm names what is KNOWN — the lock, the statement — never a holder or a cause, because 55P03 carries no holder identity and 57014 is timeout-or-cancel. Four rounds were spent fixing the message and leaving prose like this behind; see TensionSweepContention.`,
        ).toBeUndefined();
      }
    }
  });
});

describe("the two round-1 fixes that shipped unfalsified (#5029)", () => {
  it("extracts the SQLSTATE from every shape the driver can throw", () => {
    // ⚠️ Round 1 added `code: pgCode(err)` to four log sites so an operator
    // could tell contention from a real fault — the first question anyone asks
    // about a failed sweep — and the test that claimed to cover it asserted only
    // that the thrown value propagated untouched. Deleting every `code:` field,
    // or making `pgCode` return `undefined` always, survived the whole suite.
    //
    // Asserted DIRECTLY rather than through a logger double, because this file
    // deliberately installs no `mock.module` (see its header) and a double would
    // pin the call rather than the extraction.
    expect(pgCode(Object.assign(new Error("boom"), { code: "42P01" }))).toBe("42P01");
    expect(pgCode({ code: "55P03", message: "not an Error at all" })).toBe("55P03");
    // …and every shape that must NOT produce a code, because a `pgCode` that
    // threw or invented one would do so from inside an error handler.
    expect(pgCode("a bare string")).toBeUndefined();
    expect(pgCode(null)).toBeUndefined();
    expect(pgCode(undefined)).toBeUndefined();
    expect(pgCode(new Error("no code"))).toBeUndefined();
    // A NUMERIC `code` — the shape a non-pg error (a Node `SystemError`) carries.
    // Returning it would put a number where a SQLSTATE is expected.
    expect(pgCode({ code: 42 })).toBeUndefined();
  });

  it("logs the outcome even when it minted nothing", () => {
    // ⚠️ The other round-1 fix with no falsifier: re-adding `if (minted > 0)`
    // around the info log passed every test in the diff. That log is what
    // separates "the corpus converged" from "no predicate is approved `single`"
    // — the commonest reason for a `0` on a workspace that has just started
    // curating, and unrecoverable from the response, which is two numbers.
    //
    // A LEXICAL check, alongside the `DEFEATED` scan and for the same reason:
    // the unit file has no logger double by design, and the property is "this
    // call is not nested under a count test" rather than "this call happened".
    const source = readFileSync(join(REPO_ROOT, "packages/api/src/lib/brain/tension-sweep.ts"), "utf8");

    // Non-vacuity: the zero-branch prose must actually be in the file, or the
    // structural assertion below is about nothing.
    expect(
      source,
      "the zero-minted log line is gone — an admin who sweeps and sees 0 has no server-side line telling them whether the vocabulary is the reason",
    ).toContain("nothing to mint");

    // The structural half: no `minted > 0` (or `>= 1`, or `!== 0`) conditional
    // anywhere between the report and the log call.
    const reportAt = source.indexOf("const report = tensionSweepReport(");
    const logAt = source.indexOf("log.info(", reportAt);
    expect(reportAt, "the report construction moved").toBeGreaterThan(-1);
    expect(logAt, "the info log moved").toBeGreaterThan(reportAt);
    const between = source.slice(reportAt, logAt);
    // ⚠️ Including the BARE TRUTHINESS gate, which is the idiomatic spelling and
    // was the one form the first cut of this list missed — measured:
    // `if (report.minted) log.info(…)` evaded it entirely.
    for (const gate of [
      /minted\s*>\s*0/,
      /minted\s*>=\s*1/,
      /minted\s*!==?\s*0/,
      /if\s*\(\s*(?:\w+\.)?minted\s*\)/,
    ]) {
      expect(
        gate.test(between),
        `the info log is gated on ${gate} — a run that minted nothing emits no line, which is the regression this pins`,
      ).toBe(false);
    }
  });
});

describe("the arms round 2 found missing (#5029)", () => {
  it("refuses a DEADLOCK rather than 500ing — the arm an advisory-lock argument argued away", () => {
    // ⚠️ `40P01` had no arm because the docstring claimed the transaction "takes
    // 4771 and nothing else, ever" — true of ADVISORY locks, false of row locks.
    // The INSERT takes `FOR KEY SHARE` on both endpoint rows via `brain_edges`'
    // composite FKs, in plan order, while a concurrent publish takes `FOR UPDATE`
    // over every live draft in its own order and deliberately does not take 4771.
    // Overlapping row locks in independent orders is the textbook deadlock, and
    // `identity.ts` records that this repo has already had one from exactly this
    // reasoning gap.
    //
    // Routed to `conflicting-lock` because the remedy is identical; a fourth wire
    // value for one recovery would be a distinction with no consequence.
    return sweepTensionEdges("ws-1", {
      withTransaction: harness({ sweepError: pgError("40P01") }).runner,
    }).then((outcome) => {
      expect(
        outcome.kind,
        "a deadlock victim reached the caller as a generic 500 — retryable, near-certain to succeed on retry, and indistinguishable from a broken statement",
      ).toBe("contended");
      if (outcome.kind !== "contended") throw new Error("unreachable");
      expect(outcome.reason).toBe("conflicting-lock");
    });
  });

  it("refuses a CANCELLED acquisition — the arm the statement got and the lock did not", async () => {
    // Round 1 gave the sweep statement both arms and left the acquisition with
    // one, which is the reported instance closed and the class open one statement
    // over. The bounds are issued ABOVE the acquisition, so `57014` there is an
    // outcome this design creates; `lock_timeout` (5s) beats `statement_timeout`
    // (30s) on a pure lock wait, so the reachable member is a cancel.
    const outcome = await sweepTensionEdges("ws-1", {
      withTransaction: harness({ lockError: pgError("57014") }).runner,
    });

    expect(outcome.kind).toBe("contended");
    if (outcome.kind !== "contended") throw new Error("unreachable");
    expect(outcome.reason).toBe("unfinished");
  });

  it("carries `err` on EVERY refusal log that hedges between holders", () => {
    // ⚠️ A log that says "the SQLSTATE does not say which" and then withholds the
    // field that does is the reassurance-without-a-discriminator defect, and
    // round 1 fixed it on one arm and left the sibling. `55P03`'s detail says
    // `… while locking tuple in relation "brain_facts"` for a ROW-lock wait and
    // nothing for a relation-level one — exactly the difference between "a
    // colleague pressed Publish" and "someone is running DDL", which are the two
    // ends of that message's own hedge and have different remedies.
    //
    // Lexical, for the reason the other guards here are: the file installs no
    // logger double by design.
    const source = readFileSync(join(REPO_ROOT, "packages/api/src/lib/brain/tension-sweep.ts"), "utf8");
    // Every `log.warn(` in the refusal arms must carry `err:`. `reconcile-lock`
    // is included: it hedges between two holders too.
    const warns = [...source.matchAll(/log\.warn\(\s*(?:\/\/[^\n]*\n\s*)*\{[\s\S]*?\},/g)].map(
      (m) => m[0],
    );
    // DERIVED from the file rather than a floor. `>= 4` against a population of
    // five let one refusal log be deleted with the guard still green, and a
    // payload-shape change (a hoisted variable, a string-only warn) would have
    // shrunk the matched set silently instead of failing.
    const warnCalls = (source.match(/log\.warn\(/g) ?? []).length;
    expect(warnCalls, "no log.warn calls found — the scan is vacuous").toBeGreaterThan(0);
    expect(
      warns.length,
      `the payload matcher found ${warns.length} of ${warnCalls} log.warn calls — a warn whose payload it cannot see is a warn it cannot check`,
    ).toBe(warnCalls);
    for (const [i, payload] of warns.entries()) {
      expect(
        /\berr:/.test(payload),
        `refusal log ${i} omits \`err\`, so the only field that discriminates its hedged holders never reaches the operator it tells to read the logs:\n${payload.slice(0, 200)}`,
      ).toBe(true);
    }
  });
});

describe("`pgWhere` — the round-3 helper that repeated round 1's mistake (#5029)", () => {
  it("extracts the CONTEXT field, which is the only 55P03 discriminator", () => {
    // ⚠️ `pgCode` shipped unfalsified in round 1 and was given a direct
    // assertion in round 2 — and round 3 then added this same-shape sibling with
    // no test at all. Instance closed, class reopened one helper over, in the
    // round whose whole subject was that pattern.
    //
    // MEASURED against this repo's PG 16: for a `55P03` raised by the INSERT's
    // FK check, `.message` is the bare `canceling statement due to lock timeout`
    // — identical to a relation-level wait — and the discriminator lives in the
    // server's CONTEXT, which `pg` surfaces as `DatabaseError.where`.
    const rowLock = {
      code: "55P03",
      message: "canceling statement due to lock timeout",
      where: 'while locking tuple (0,1) in relation "brain_facts"',
    };
    expect(pgWhere(rowLock)).toContain('relation "brain_facts"');
    // A relation-level wait carries no CONTEXT — the other half of the
    // distinction, and the reason `.message` alone cannot make it.
    expect(pgWhere({ code: "55P03", message: "canceling statement due to lock timeout" })).toBeUndefined();
    // …and every shape that must not produce one.
    expect(pgWhere("a bare string")).toBeUndefined();
    expect(pgWhere(null)).toBeUndefined();
    expect(pgWhere(new Error("no where"))).toBeUndefined();
    expect(pgWhere({ where: 42 })).toBeUndefined();
  });

  it("reaches the conflicting-lock log, where the message promises the logs carry it", () => {
    // Lexical, like its siblings: this file installs no logger double. The
    // `conflicting-lock` refusal tells the admin to check whether maintenance is
    // running, which is a diagnosis only `where` supports — `err` alone is
    // byte-identical for the two holders that message hedges between.
    const source = readFileSync(join(REPO_ROOT, "packages/api/src/lib/brain/tension-sweep.ts"), "utf8");
    const armAt = source.indexOf("conflicting-lock\" };");
    expect(armAt, "the conflicting-lock return moved").toBeGreaterThan(-1);
    const warnAt = source.lastIndexOf("log.warn(", armAt);
    expect(warnAt, "no log.warn precedes the conflicting-lock return").toBeGreaterThan(-1);
    expect(
      source.slice(warnAt, armAt),
      "the conflicting-lock log dropped `where` — `.message` is identical for a row-lock and a relation-level wait, so without it the message's 'check for maintenance' advice rests on nothing",
    ).toContain("where: pgWhere(err)");
  });
});
