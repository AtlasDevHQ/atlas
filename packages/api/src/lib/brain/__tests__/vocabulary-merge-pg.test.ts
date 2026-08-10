/**
 * Merging two vocabularies (#5036, ADR-0037 §8 §4).
 *
 * > Union the approved edges; refuse any edge that would close a cycle or
 * > violate at-most-one-parent; log every refusal; recompute the effective-target
 * > closure at the destination.
 *
 * The hole this closes is CROSS-vocabulary. The forest invariant is enforced
 * per-vocabulary and nothing enforced it across two: canonical direction is
 * arbitrary, so a source that curated `price → priced at` and a destination that
 * curated `priced at → price` are both valid forests whose UNION is a 2-cycle.
 * Group 1 is that case, and it is the issue's named falsification.
 *
 * ## What each group falsifies
 *
 *   1. **The cycle** — two individually-valid forests whose union is cyclic
 *      refuse, log, and leave the destination a forest. Run TWICE, because
 *      "refuses" and "does not oscillate" are different claims and only the
 *      second one is about a merge that runs again.
 *   2. **The union** — non-conflicting decisions from BOTH regions survive, and
 *      the closure is recomputed over the union rather than over either half.
 *      The chain case (`a → b` destination, `b → c` arriving) is the one a
 *      per-edge closure patch gets wrong.
 *   3. **The refusals** — at-most-one-parent, and the two that need no store.
 *      Every arriving edge lands in exactly one of applied / duplicate /
 *      refused, which `migrate.ts` reconciliation depends on.
 *   4. **The row-copy** — values are written verbatim, `approved_at` included,
 *      and an identical arriving edge does NOT rewrite the destination's row.
 *   5. **The scoping** — positions are independent forests, and only a position
 *      that gained an edge is recomputed.
 *   6. **The transaction** — the merge refuses to run outside one, and takes no
 *      lock when there is nothing to merge.
 *
 * ## Why the logger is mocked here
 *
 * #5036 makes the log THE recovery path: a refused edge is a human's approved
 * decision this region is dropping, and the log line is the only artifact from
 * which it can be re-authored once the bundle is gone (`stays` cleanup, #4458).
 * A test that asserted only the returned counts would leave a merge that
 * computes refusals correctly and tells nobody entirely green.
 *
 * Separate SINKS per level, not one array with the level in the payload: the
 * level is part of the claim, and a helper that merged the two would pass a
 * mutation demoting `log.warn` to `log.debug`.
 *
 * Real Postgres throughout — the cycle walk and the closure rebuild are SQL, so
 * a scripted executor would be asserting this file's own arithmetic.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { Pool, type PoolClient } from "pg";

interface Captured {
  readonly payload: Record<string, unknown>;
  readonly message: string;
}

const warns: Captured[] = [];
/** Separate sinks: the LEVEL is part of what this file pins, not just the payload. */
const infos: Captured[] = [];
const errors: Captured[] = [];

/**
 * Every value export of `lib/logger`, replaced.
 *
 * ⚠️ A PARTIAL mock is the trap this repo has recorded: `mock.module` replaces
 * the whole module, so any export left out becomes `undefined` and the module
 * under test throws on first use — which reads as a broken test rather than a
 * missing mock. The factory is SYNCHRONOUS, because an async one deadlocks
 * `bun:test`.
 */
void mock.module("@atlas/api/lib/logger", () => {
  const record = (sink: Captured[]) => (payload: unknown, message?: unknown) =>
    sink.push({
      payload: (payload ?? {}) as Record<string, unknown>,
      message: typeof message === "string" ? message : String(payload),
    });
  const capture = {
    info: record(infos),
    warn: record(warns),
    error: record(errors),
    debug: () => {},
    level: "info",
  };
  return {
    createLogger: () => capture,
    getLogger: () => capture,
    setLogLevel: () => true,
    getRequestContext: () => undefined,
    withRequestContext: <T,>(_ctx: unknown, fn: () => T): T => fn(),
    redactPaths: [] as string[],
    scrubErrSerializer: (err: unknown) => err,
    scrubLogFormatter: (obj: unknown) => obj,
    hashShareToken: (token: string) => token,
    ACTOR_KINDS: ["human", "agent", "mcp", "scheduler", "api_key"] as const,
  };
});

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;
const PG_TEST_TIMEOUT_MS = 60_000;

// DYNAMIC, after the mock above is installed.
const { runMigrations } = await import("@atlas/api/lib/db/migrate");
const { MANAGED_AUTH_MIGRATIONS, _resetPool } = await import("@atlas/api/lib/db/internal");
const { approveAliasEdge, mergeApprovedEdges } = await import("@atlas/api/lib/brain/vocabulary");
type ArrivingAliasEdge = import("@atlas/api/lib/brain/vocabulary").ArrivingAliasEdge;
type SlotPosition = import("@atlas/api/lib/brain/identity").SlotPosition;

/** The source region's approval timestamp — never `now()`, which is the point of group 4. */
const SOURCE_APPROVED_AT = "2026-01-02T03:04:05.000Z";

const arriving = (
  fromNorm: string,
  toNorm: string,
  overrides: Partial<ArrivingAliasEdge> = {},
): ArrivingAliasEdge => ({
  position: "predicate",
  fromNorm,
  toNorm,
  approvedBy: "source-admin",
  approvedAt: SOURCE_APPROVED_AT,
  ...overrides,
});

describeIfPg("merging two vocabularies (#5036)", () => {
  let pool: Pool;
  const schemaName = `brain_5036_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let priorDatabaseUrl: string | undefined;
  let wsCounter = 0;

  beforeAll(async () => {
    priorDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = TEST_DB_URL;
    pool = new Pool({
      connectionString: TEST_DB_URL,
      options: `-c search_path="${schemaName}",public`,
    });
    const bootstrap = new Pool({ connectionString: TEST_DB_URL });
    try {
      await bootstrap.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
    } finally {
      await bootstrap.end();
    }
    await runMigrations(pool, { skip: MANAGED_AUTH_MIGRATIONS });
    _resetPool(pool);
  }, PG_TEST_TIMEOUT_MS);

  afterAll(async () => {
    _resetPool(null);
    if (priorDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = priorDatabaseUrl;
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await pool.end();
    }
  }, PG_TEST_TIMEOUT_MS);

  // BEFORE each, not after: `runMigrations` in `beforeAll` emits ~200 info
  // lines, so an after-only reset leaves the FIRST test measuring the migration
  // runner's output. That is not hypothetical — the `infos` assertion in group 1
  // caught it, which is the only reason the level sinks are worth having.
  beforeEach(() => {
    warns.length = 0;
    infos.length = 0;
    errors.length = 0;
  });

  /**
   * A workspace nobody else in this file touches.
   *
   * Every group shares one schema, and the closure assertions below read whole
   * tables by workspace — an unscoped fixture would make one group's edges show
   * up in another's `ORDER BY` and the failure would look like a merge bug.
   */
  const freshWorkspace = () => `ws-merge-5036-${++wsCounter}`;

  /** Run one unit of work inside a real transaction — every primitive here demands one. */
  const inTx = async <T,>(fn: (tx: PoolClient) => Promise<T>): Promise<T> => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const out = await fn(client);
      await client.query("COMMIT");
      return out;
    } catch (err) {
      await client.query("ROLLBACK").catch((rollbackErr: unknown) => {
        // The original error below is the real outcome; a rollback failure on an
        // already-dead connection would mask it. Logged rather than dropped.
        console.debug(
          "rollback after a failed test transaction:",
          rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr),
        );
      });
      throw err;
    } finally {
      client.release();
    }
  };

  /** Seed the DESTINATION region's own curated decisions, through the real approval path. */
  const seedDestination = (ws: string, edges: readonly (readonly [string, string, SlotPosition?])[]) =>
    inTx(async (tx) => {
      for (const [fromNorm, toNorm, position] of edges) {
        const result = await approveAliasEdge(tx, ws, {
          position: position ?? "predicate",
          fromNorm,
          toNorm,
          approvedBy: "destination-admin",
        });
        // Seeding through the real path means a seed that silently refused would
        // make the group under test measure an empty destination.
        expect(result.ok).toBe(true);
      }
    });

  const closureOf = async (ws: string, position: SlotPosition = "predicate") => {
    const rows = await pool.query<{ norm: string; effective_target: string }>(
      `SELECT norm, effective_target FROM brain_vocabulary_target
        WHERE workspace_id = $1 AND slot_position = $2 ORDER BY norm`,
      [ws, position],
    );
    return rows.rows;
  };

  const edgesOf = async (ws: string) => {
    const rows = await pool.query<{
      slot_position: string;
      from_norm: string;
      to_norm: string;
      approved_by: string | null;
      approved_at: Date;
    }>(
      `SELECT slot_position, from_norm, to_norm, approved_by, approved_at
         FROM brain_vocabulary_edge WHERE workspace_id = $1
        ORDER BY slot_position, from_norm`,
      [ws],
    );
    return rows.rows;
  };

  // ── 1. The cycle: two valid forests whose union is not one ──────────────────

  it(
    "REFUSES an arriving edge that would close a cycle against a destination edge, and logs it",
    async () => {
      // Not contrived: canonical direction is arbitrary, so both regions made a
      // defensible call and each store is individually a valid forest.
      const ws = freshWorkspace();
      await seedDestination(ws, [["priced at", "price"]]);

      const merge = await inTx((tx) => mergeApprovedEdges(tx, ws, [arriving("price", "priced at")]));

      expect(merge.applied).toBe(0);
      expect(merge.duplicate).toBe(0);
      expect(merge.refusals).toHaveLength(1);
      expect(merge.refusals[0].refusal).toBe("would-cycle");
      // The position was NOT recomputed: nothing was written, so a rebuild would
      // be a no-op that reads as "something changed here".
      expect(merge.positionsRecomputed).toEqual([]);

      // The destination is still a forest, and still says exactly what it said.
      expect(await edgesOf(ws)).toMatchObject([
        { slot_position: "predicate", from_norm: "priced at", to_norm: "price" },
      ]);
      expect(await closureOf(ws)).toEqual([{ norm: "priced at", effective_target: "price" }]);

      // ── The log IS the recovery path (#5036) ──
      expect(warns).toHaveLength(1);
      expect(errors).toHaveLength(0);
      expect(infos).toHaveLength(0);
      // The whole edge, not a norm pair: the bundle may be gone by the time an
      // operator reads this, so everything needed to re-author the source row
      // has to be in the line itself.
      expect(warns[0].payload).toMatchObject({
        workspaceId: ws,
        position: "predicate",
        fromNorm: "price",
        toNorm: "priced at",
        approvedBy: "source-admin",
        approvedAt: SOURCE_APPROVED_AT,
        refusal: "would-cycle",
        // Explicitly `null` rather than absent — a missing key and "there is no
        // conflicting edge" read identically in an aggregator, and only one is true.
        existingTarget: null,
        index: 0,
        total: 1,
      });
      expect(String(warns[0].payload.reason)).toContain("would close a cycle");
      expect(warns[0].message).toContain("REFUSED");
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "does not OSCILLATE — re-running the same merge repeats the refusal and moves nothing",
    async () => {
      // The failure this rules out is the one the issue names: a merge that
      // resolved the cycle by flipping an edge would flip it back on the next
      // catch-up import, and the corpus would re-key on every migration.
      const ws = freshWorkspace();
      await seedDestination(ws, [["priced at", "price"]]);
      const bundle = [arriving("price", "priced at")];

      const first = await inTx((tx) => mergeApprovedEdges(tx, ws, bundle));
      const edgesAfterFirst = await edgesOf(ws);
      const closureAfterFirst = await closureOf(ws);

      const second = await inTx((tx) => mergeApprovedEdges(tx, ws, bundle));

      expect(second.applied).toBe(first.applied);
      expect(second.duplicate).toBe(first.duplicate);
      expect(second.refusals.map((r) => r.refusal)).toEqual(first.refusals.map((r) => r.refusal));
      expect(await edgesOf(ws)).toEqual(edgesAfterFirst);
      expect(await closureOf(ws)).toEqual(closureAfterFirst);
      // Logged BOTH times — an operator re-running a catch-up import must not be
      // told a decision landed just because a previous run already refused it.
      expect(warns).toHaveLength(2);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "refuses a cycle closed through a LONGER chain, not only a 2-cycle",
    async () => {
      // `x → y` here; `y → z` and `z → x` arriving. The arriving pair is itself a
      // valid forest (z is unaliased at the source), and only the union cycles.
      // A cycle check that compared endpoints instead of walking the chain would
      // apply both.
      const ws = freshWorkspace();
      await seedDestination(ws, [["x", "y"]]);

      const merge = await inTx((tx) =>
        mergeApprovedEdges(tx, ws, [arriving("y", "z"), arriving("z", "x")]),
      );

      expect(merge.applied).toBe(1);
      expect(merge.refusals).toHaveLength(1);
      expect(merge.refusals[0].refusal).toBe("would-cycle");
      expect(merge.refusals[0].edge.fromNorm).toBe("z");
      // The half that does not cycle still lands — refusing the whole bundle
      // over one bad edge would discard the source's other decisions too.
      expect(await closureOf(ws)).toEqual([
        { norm: "x", effective_target: "z" },
        { norm: "y", effective_target: "z" },
      ]);
    },
    PG_TEST_TIMEOUT_MS,
  );

  // ── 2. The union: both regions' decisions survive, closure recomputed ───────

  it(
    "UNIONS the approved edges and recomputes the closure over the union",
    async () => {
      // The case a per-edge closure patch gets wrong. Destination holds `a → b`;
      // `b → c` arrives. Writing the arrival and patching only `b` leaves `a`
      // keyed onto `b`, which nothing approves any more — silently.
      const ws = freshWorkspace();
      await seedDestination(ws, [["a", "b"]]);

      const merge = await inTx((tx) => mergeApprovedEdges(tx, ws, [arriving("b", "c")]));

      expect(merge.applied).toBe(1);
      expect(merge.refusals).toEqual([]);
      expect(merge.positionsRecomputed).toEqual(["predicate"]);
      expect(await closureOf(ws)).toEqual([
        { norm: "a", effective_target: "c" },
        { norm: "b", effective_target: "c" },
      ]);
      // Both approved edges are still there — the closure composed them, it did
      // not COMPRESS them. Compression is what destroys reversibility (ADR-0037 §6).
      expect((await edgesOf(ws)).map((e) => [e.from_norm, e.to_norm])).toEqual([
        ["a", "b"],
        ["b", "c"],
      ]);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "unions in the other direction too — an arriving edge UNDER a destination edge",
    async () => {
      // Destination `b → c`; `a → b` arrives. Same union, opposite insertion
      // order, and it is the direction in which the arriving edge is the one
      // whose effective target has to be composed rather than stored.
      const ws = freshWorkspace();
      await seedDestination(ws, [["b", "c"]]);

      const merge = await inTx((tx) => mergeApprovedEdges(tx, ws, [arriving("a", "b")]));

      expect(merge.applied).toBe(1);
      expect(await closureOf(ws)).toEqual([
        { norm: "a", effective_target: "c" },
        { norm: "b", effective_target: "c" },
      ]);
    },
    PG_TEST_TIMEOUT_MS,
  );

  // ── 3. The refusals, and the three-way accounting ───────────────────────────

  it(
    "REFUSES an arriving edge whose `fromNorm` this region already aliased elsewhere",
    async () => {
      const ws = freshWorkspace();
      await seedDestination(ws, [["price", "cost"]]);

      const merge = await inTx((tx) => mergeApprovedEdges(tx, ws, [arriving("price", "unit price")]));

      expect(merge.applied).toBe(0);
      expect(merge.duplicate).toBe(0);
      expect(merge.refusals).toHaveLength(1);
      const [refusal] = merge.refusals;
      expect(refusal.refusal).toBe("already-aliased");
      // The destination's target, which is the ONLY thing that makes the log
      // line actionable: an operator has to know what to remove before the
      // source's decision can be re-authored.
      expect(refusal.refusal === "already-aliased" && refusal.existingTarget).toBe("cost");
      expect(warns[0].payload).toMatchObject({ refusal: "already-aliased", existingTarget: "cost" });

      expect(await closureOf(ws)).toEqual([{ norm: "price", effective_target: "cost" }]);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "refuses the two that need no store — a degenerate norm and a self-edge",
    async () => {
      // Unreachable through the importer (`validateBundle` refuses both at the
      // door) and reachable through this function's own contract, which is the
      // surface being tested. A merge that wrote them would put a row in that
      // can never match anything.
      const ws = freshWorkspace();

      const merge = await inTx((tx) =>
        mergeApprovedEdges(tx, ws, [arriving("", "price"), arriving("price", "price")]),
      );

      expect(merge.applied).toBe(0);
      expect(merge.refusals.map((r) => r.refusal)).toEqual(["degenerate-norm", "self-edge"]);
      expect(await edgesOf(ws)).toEqual([]);
      expect(warns.map((w) => w.payload.refusal)).toEqual(["degenerate-norm", "self-edge"]);
      // Index and total let an operator tell a truncated log from a complete one.
      expect(warns.map((w) => [w.payload.index, w.payload.total])).toEqual([
        [0, 2],
        [1, 2],
      ]);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "accounts for EVERY arriving edge exactly once — applied + duplicate + refused",
    async () => {
      // `migrate.ts` reconciles the target's counters against the manifest count
      // and ABORTS the migration before cutover when they disagree, so an edge
      // that fell through all three would fail a whole cutover.
      //
      // Deliberately three DIFFERENT numbers (2 / 1 / 3): with 1/1/1 a merge that
      // mixed two counters up would pass every assertion here.
      const ws = freshWorkspace();
      await seedDestination(ws, [
        ["price", "cost"], // conflicts with one arrival
        ["priced at", "amount"], // cycles with one arrival
      ]);

      const bundle: readonly ArrivingAliasEdge[] = [
        arriving("fresh one", "target one"), // applied
        arriving("fresh two", "target two"), // applied
        arriving("price", "cost"), // duplicate — same decision
        arriving("price", "unit price"), // refused — already-aliased
        arriving("amount", "priced at"), // refused — would-cycle
        arriving("", "nothing"), // refused — degenerate-norm
      ];

      const merge = await inTx((tx) => mergeApprovedEdges(tx, ws, bundle));

      expect(merge.applied).toBe(2);
      expect(merge.duplicate).toBe(1);
      expect(merge.refusals).toHaveLength(3);
      expect(merge.applied + merge.duplicate + merge.refusals.length).toBe(bundle.length);
      // Every refusal logged, and the duplicate NOT logged — a re-import that
      // warned about decisions it already holds is how a real refusal gets skimmed past.
      expect(warns).toHaveLength(3);
    },
    PG_TEST_TIMEOUT_MS,
  );

  // ── 4. The row-copy: verbatim, and never a rewrite ──────────────────────────

  it(
    "carries the source's `approved_by` and `approved_at` VERBATIM",
    async () => {
      // ADR-0037 §8: a row-copy path carries values verbatim. Letting
      // `approved_at` fall to its `now()` default would date every migrated
      // decision to the migration and erase when it was actually made.
      const ws = freshWorkspace();

      await inTx((tx) =>
        mergeApprovedEdges(tx, ws, [arriving("price", "cost", { approvedBy: "eu-reviewer" })]),
      );

      const [edge] = await edgesOf(ws);
      expect(edge.approved_by).toBe("eu-reviewer");
      expect(new Date(edge.approved_at).toISOString()).toBe(SOURCE_APPROVED_AT);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "treats an IDENTICAL arriving edge as a duplicate and leaves the destination row untouched",
    async () => {
      // The idempotent re-import path, and it must not be reported as a lost
      // decision — nor overwrite the destination's own approval metadata, which
      // is the `ON CONFLICT DO UPDATE` this table must never grow.
      const ws = freshWorkspace();
      await seedDestination(ws, [["price", "cost"]]);
      const before = await edgesOf(ws);

      const merge = await inTx((tx) =>
        mergeApprovedEdges(tx, ws, [arriving("price", "cost", { approvedBy: "source-admin" })]),
      );

      expect(merge.duplicate).toBe(1);
      expect(merge.applied).toBe(0);
      expect(merge.refusals).toEqual([]);
      expect(warns).toEqual([]);
      // Whole-row equality: the destination's approver and timestamp are its own.
      expect(await edgesOf(ws)).toEqual(before);
    },
    PG_TEST_TIMEOUT_MS,
  );

  // ── 5. Position scoping, and which closures get rebuilt ─────────────────────

  it(
    "keeps positions independent — the same norm pair may run opposite ways at two positions",
    async () => {
      // Three forests, not one (ADR-0037 §6). A cycle walk that dropped
      // `slot_position` would see `price → cost` and `cost → price` as a 2-cycle
      // and refuse the arrival, which is a predicate decision re-keying subjects.
      const ws = freshWorkspace();
      await seedDestination(ws, [["price", "cost", "subject"]]);

      const merge = await inTx((tx) =>
        mergeApprovedEdges(tx, ws, [arriving("cost", "price", { position: "predicate" })]),
      );

      expect(merge.applied).toBe(1);
      expect(merge.refusals).toEqual([]);
      expect(await closureOf(ws, "subject")).toEqual([{ norm: "price", effective_target: "cost" }]);
      expect(await closureOf(ws, "predicate")).toEqual([{ norm: "cost", effective_target: "price" }]);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "recomputes ONLY the positions that gained an edge",
    async () => {
      const ws = freshWorkspace();
      await seedDestination(ws, [["price", "cost", "subject"]]);

      const merge = await inTx((tx) =>
        mergeApprovedEdges(tx, ws, [
          arriving("a", "b", { position: "predicate" }), // applied
          arriving("price", "elsewhere", { position: "subject" }), // refused
        ]),
      );

      expect(merge.applied).toBe(1);
      expect(merge.refusals).toHaveLength(1);
      // `subject` saw an arrival but gained nothing, so it is absent.
      expect(merge.positionsRecomputed).toEqual(["predicate"]);
    },
    PG_TEST_TIMEOUT_MS,
  );

  // ── 6. The transaction contract ─────────────────────────────────────────────

  it(
    "REFUSES to merge outside a transaction",
    async () => {
      // On an autocommit connection the advisory lock is taken and dropped
      // inside its own statement, so the check-then-insert stops being atomic
      // and a concurrent approval can close a cycle either side of it.
      const ws = freshWorkspace();
      await expect(mergeApprovedEdges(pool, ws, [arriving("price", "cost")])).rejects.toThrow(
        /must run inside a transaction/,
      );
      expect(await edgesOf(ws)).toEqual([]);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "takes no lock at all when there is nothing to merge",
    async () => {
      // The positive control for the early return: a bundle carrying no
      // vocabulary must not serialize against every open approval in the
      // workspace — and it reaches this function on a POOL from the importer's
      // perspective only in tests, which is exactly why the check is worth
      // making here. If the early return were removed, the line above would throw.
      const ws = freshWorkspace();
      const merge = await mergeApprovedEdges(pool, ws, []);
      expect(merge).toEqual({ applied: 0, duplicate: 0, refusals: [], positionsRecomputed: [] });
      expect(warns).toEqual([]);
    },
    PG_TEST_TIMEOUT_MS,
  );
});
