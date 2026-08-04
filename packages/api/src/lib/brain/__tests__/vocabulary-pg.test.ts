/**
 * The vocabulary — approved edges, the derived closure, and what `alias`
 * answers (#5022, ADR-0037 §6).
 *
 * ## Why this is a `-pg` suite and not a unit one
 *
 * Because every property under test is a property of SQL. At-most-one-parent is
 * a primary key, derived-ness is a RESTRICT foreign key, the closure is a
 * recursive CTE, and the reversibility that is the whole point of the
 * two-relation split is a DELETE followed by a rebuild. A fake that decided any
 * of this in TypeScript would be a second implementation agreeing with the first
 * by construction — which is what #5021 stripped `FakeBrainStore` of identity
 * answers to stop, and what #5000's root cause was.
 *
 * ## The compressed chain is the only shape that falsifies reversibility
 *
 * `a → b` then `b → c`, remove `b → c`, assert `a` lands back on `b`. A two-node
 * vocabulary passes under path compression, under a scoped patch, and under a
 * full rebuild alike, so a test that does not compose is VACUOUS — ADR-0037 §6
 * says so in as many words, and T7 lists it as target (a).
 *
 * ## Every prohibition has a positive control, in its own `test()`
 *
 * Six of the assertions here are refusals, and a refusal passes green against
 * machinery that refuses everything — an `approveAliasEdge` that returned
 * `{ok: false}` unconditionally would satisfy all of them. Each is paired with a
 * control that proves the same call can succeed, and the two are separate
 * `test()` blocks rather than two arms of one body: in a long proof the first
 * failure hides the rest, and a broken control would silently mask the
 * prohibition it licenses.
 *
 * ## Nothing here hand-writes a closure row
 *
 * Every effective target asserted below is a value the recursive CTE produced.
 * The fixtures supply approved EDGES — the human's half — and the system
 * supplies what they compose to. The one exception is deliberate and marked: the
 * convergence test writes a cyclic pair through raw SQL precisely because the
 * primitives refuse to.
 *
 * ## MUTATIONS THIS CATCHES
 *
 * Run one at a time against this file; each line was verified, not assumed.
 *
 * | Mutation | Tests it kills |
 * |---|---|
 * | `loadClaimVocabulary` reads `brain_vocabulary_edge` instead of `_target` (one relation, not two) | 5 |
 * | the recompute's recursive term dropped (closure is depth-1 only) | 9 |
 * | `ORDER BY norm, depth DESC` → `depth ASC` (the closure keeps the first hop, not the root) | 9 |
 * | `removeAliasEdge` drops its final `recomputeEffectiveTargets` | 1 — reversibility, and ONLY that one |
 * | the at-most-one-parent read dropped (the PK still refuses — by THROWING) | 1 — the second-approval refusal |
 * | the cycle walk dropped | 2 — both cycle lengths |
 * | `lexicalNorm` dropped from both write endpoints | 3 |
 * | the self-edge arm dropped (`ck_..._not_self` still refuses — by throwing) | 1 |
 * | the degenerate-norm arm dropped (`ck_..._norms_present` still refuses — by throwing) | 1 |
 * | `loadClaimVocabulary` merges the three positions into one map | 3 — position-scoping |
 * | `loadClaimVocabulary` loses its `workspace_id` filter | 1 |
 * | the convergence check dropped from `recomputeEffectiveTargets` | 1 |
 *
 * Note the shape shared by four rows: the SCHEMA also refuses, so deleting the
 * TypeScript guard does not make the write succeed — it turns a typed refusal
 * into a raw `duplicate key value violates unique constraint` or a CHECK
 * violation. That is a different observable outcome, and asserting on the
 * refusal VALUE rather than on "it did not land" is what makes it visible. Each
 * of those four is caught by exactly one test, and a version of that test
 * written as `expect(await storedEdges()).toHaveLength(1)` would pass under all
 * four — which is how they were nearly missed.
 *
 * Opt in locally with the same scratch database as its sibling brain suites —
 * every one of them creates and drops its OWN schema, so they share it safely:
 *   bun run db:up && export TEST_DATABASE_URL=postgresql://atlas:atlas@localhost:5433/brain_4771_scratch
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import { runMigrations } from "@atlas/api/lib/db/migrate";
import { MANAGED_AUTH_MIGRATIONS } from "@atlas/api/lib/db/internal";
import { is } from "drizzle-orm";
import { PgTable, getTableConfig } from "drizzle-orm/pg-core";
import * as schema from "@atlas/api/lib/db/schema";
import {
  approveAliasEdge,
  loadClaimVocabulary,
  recomputeEffectiveTargets,
  removeAliasEdge,
  type AliasEdgeInput,
  type VocabularyExecutor,
} from "@atlas/api/lib/brain/vocabulary";
import type { SlotPosition } from "@atlas/api/lib/brain/identity";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;
const PG_TEST_TIMEOUT_MS = 60_000;

const WS = "ws-vocab-5022";
const OTHER_WS = "ws-vocab-5022-other";

// ---------------------------------------------------------------------------
// The no-ACL invariant — deliberately OUTSIDE the Postgres gate
// ---------------------------------------------------------------------------
//
// ADR-0037 §6 makes the vocabulary the one piece of brain state with no ACL,
// PERMANENTLY, and calls that a derived invariant rather than a preference: all
// three identity consumers already carry no grant arm, and grant-scoping would
// need `alias(norm, reader)` at a seam materialized by a fiber that has no
// reader. A `visible_to` column appearing on either table is the moment that
// decision quietly reverses, and it would appear in a schema PR, not in a brain
// one — so this reads the Drizzle schema and needs no database.

describe("the vocabulary carries no ACL arm (#5022, ADR-0037 §6)", () => {
  const tableColumns = (name: string): string[] => {
    const cfg = Object.values(schema)
      .flatMap((v) => (is(v, PgTable) ? [getTableConfig(v)] : []))
      .find((t) => t.name === name);
    return cfg ? cfg.columns.map((c) => c.name) : [];
  };

  for (const table of ["brain_vocabulary_edge", "brain_vocabulary_target"]) {
    it(`${table} has no grant column`, () => {
      const columns = tableColumns(table);
      // Non-vacuous: prove the table is really in the schema before asserting
      // what it lacks — `tableColumns` returns [] for a renamed or dropped one,
      // which would otherwise satisfy every assertion below.
      expect(columns.length, `${table} is not in db/schema.ts`).toBeGreaterThan(0);
      expect(columns).toContain("workspace_id");
      expect(columns).not.toContain("visible_to");
      expect(columns).not.toContain("pre_widening_visible_to");
    });
  }
});

describeIfPg("the vocabulary — edges, closure, and `alias` (#5022)", () => {
  let pool: Pool;
  const schemaName = `brain_5022_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

  beforeAll(async () => {
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
  }, PG_TEST_TIMEOUT_MS);

  afterAll(async () => {
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await pool.end();
    }
  }, PG_TEST_TIMEOUT_MS);

  afterEach(async () => {
    // Targets BEFORE edges — `fk_brain_vocabulary_target_edge` is RESTRICT, and
    // that ordering obligation is the same one the #4458 cleanup sweep carries.
    await pool.query("DELETE FROM brain_vocabulary_target");
    await pool.query("DELETE FROM brain_vocabulary_edge");
  });

  // ── helpers ─────────────────────────────────────────────────────────────

  /**
   * Run one vocabulary mutation the way #5023's decide seam will: inside a
   * transaction. Not a convenience — `approveAliasEdge` checks then writes, and
   * its `pg_advisory_xact_lock` is released at COMMIT, so outside a transaction
   * the lock spans a single statement and guards nothing.
   */
  async function inTx<T>(fn: (tx: VocabularyExecutor) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const out = await fn(client);
      await client.query("COMMIT");
      return out;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  const approve = (input: AliasEdgeInput, workspaceId = WS) =>
    inTx((tx) => approveAliasEdge(tx, workspaceId, input));

  const remove = (position: SlotPosition, fromNorm: string, workspaceId = WS) =>
    inTx((tx) => removeAliasEdge(tx, workspaceId, position, fromNorm));

  const edge = (
    position: SlotPosition,
    fromNorm: string,
    toNorm: string,
    approvedBy: string | null = "user-1",
  ): AliasEdgeInput => ({ position, fromNorm, toNorm, approvedBy });

  /** The approved edges as stored — the human's half, never the derived one. */
  async function storedEdges(workspaceId = WS) {
    const { rows } = await pool.query<{ slot_position: string; from_norm: string; to_norm: string }>(
      `SELECT slot_position, from_norm, to_norm FROM brain_vocabulary_edge
        WHERE workspace_id = $1 ORDER BY slot_position, from_norm`,
      [workspaceId],
    );
    return rows;
  }

  /** Approve a compressed predicate chain: `is priced at → priced at → unit price`. */
  async function seedCompressedChain() {
    expect((await approve(edge("predicate", "is priced at", "priced at"))).ok).toBe(true);
    expect((await approve(edge("predicate", "priced at", "unit price"))).ok).toBe(true);
  }

  // ── 1. `alias` reads the closure, and the closure composes ──────────────

  it("answers an approved alias, and leaves every other norm alone", async () => {
    // The positive control for this whole file. Every refusal below passes
    // green against an `approveAliasEdge` that refuses unconditionally; this is
    // what proves it can land an edge at all.
    expect((await approve(edge("predicate", "is priced at", "priced at"))).ok).toBe(true);

    const vocabulary = await loadClaimVocabulary(pool, WS);
    expect(vocabulary.predicate("is priced at")).toBe("priced at");
    // TOTAL: a norm with no entry maps to itself, including the target's own
    // norm (an effective target is already its own target, which is what makes
    // `f(f(x)) === f(x)` fall out).
    expect(vocabulary.predicate("priced at")).toBe("priced at");
    expect(vocabulary.predicate("led by")).toBe("led by");
    expect(vocabulary.predicate("")).toBe("");
  });

  it("composes a chain to its ROOT, without rewriting either approved edge", async () => {
    // ADR-0037 §6's two relations, in one assertion pair. `alias` answers
    // `unit price` for BOTH norms — the closure composed — while the approved
    // edges still record exactly what the human approved, in the order they
    // approved it. Path compression would have rewritten the first edge's
    // target to `unit price` here, and that rewrite is what destroys the
    // reversibility the next test asserts.
    await seedCompressedChain();

    const vocabulary = await loadClaimVocabulary(pool, WS);
    expect(vocabulary.predicate("is priced at")).toBe("unit price");
    expect(vocabulary.predicate("priced at")).toBe("unit price");

    expect(await storedEdges()).toEqual([
      { slot_position: "predicate", from_norm: "is priced at", to_norm: "priced at" },
      { slot_position: "predicate", from_norm: "priced at", to_norm: "unit price" },
    ]);
  });

  // ── 2. Reversibility — the compressed chain ─────────────────────────────

  it("restores the prior effective target when an edge is removed (compressed chain)", async () => {
    // T7 target (a), and the reason the vocabulary is two relations at all.
    // Removing `priced at → unit price` must put `is priced at` back on
    // `priced at` — an edge the removal does not mention, and one that path
    // compression would have destroyed at the moment the second approval
    // landed.
    await seedCompressedChain();
    expect(await remove("predicate", "priced at")).toBe(true);

    const vocabulary = await loadClaimVocabulary(pool, WS);
    expect(vocabulary.predicate("is priced at")).toBe("priced at");
    // And `priced at` itself is unaliased again — the identity answer.
    expect(vocabulary.predicate("priced at")).toBe("priced at");

    // The surviving decision is untouched, which is what "removal is a
    // recomputation, not a destructive write" means at the durable relation.
    expect(await storedEdges()).toEqual([
      { slot_position: "predicate", from_norm: "is priced at", to_norm: "priced at" },
    ]);
  });

  it("removing an unaliased norm changes nothing and reports that it did nothing", async () => {
    await seedCompressedChain();
    expect(await remove("predicate", "unit price")).toBe(false);
    // The negative return is not the interesting half — this is: a no-op
    // removal must not clear the closure it happened to run beside.
    const vocabulary = await loadClaimVocabulary(pool, WS);
    expect(vocabulary.predicate("is priced at")).toBe("unit price");
  });

  // ── 3. At-most-one-parent, and approvals never rewrite ──────────────────

  it("refuses a second parent, names the existing target, and leaves the first edge intact", async () => {
    await approve(edge("predicate", "is priced at", "priced at"));

    const second = await approve(edge("predicate", "is priced at", "list price"));
    expect(second.ok).toBe(false);
    // The refusal VALUE, not merely "the write did not land". The primary key
    // refuses this too — by throwing a duplicate-key error — so an assertion on
    // the stored rows alone would pass with the explicit check deleted, and the
    // caller would get an unactionable driver error instead of a repair path.
    expect(second).toMatchObject({
      ok: false,
      refusal: "already-aliased",
      existingTarget: "priced at",
    });

    expect(await storedEdges()).toEqual([
      { slot_position: "predicate", from_norm: "is priced at", to_norm: "priced at" },
    ]);
    expect((await loadClaimVocabulary(pool, WS)).predicate("is priced at")).toBe("priced at");
  });

  it("a norm that is already a TARGET may still be approved onto something (the control)", async () => {
    // The prohibition above is about a second PARENT, not about reusing a norm.
    // Without this control, an `approveAliasEdge` that refused every approval
    // touching a known norm would satisfy it — and that implementation would
    // make composition, the previous section's subject, impossible.
    await approve(edge("predicate", "is priced at", "priced at"));
    expect((await approve(edge("predicate", "priced at", "unit price"))).ok).toBe(true);
  });

  // ── 4. Cycles ───────────────────────────────────────────────────────────

  it("refuses an edge that would close a two-node cycle", async () => {
    await approve(edge("predicate", "owned by", "owner"));
    const back = await approve(edge("predicate", "owner", "owned by"));
    expect(back).toMatchObject({ ok: false, refusal: "would-cycle" });
    expect(await storedEdges()).toHaveLength(1);
  });

  it("refuses an edge that would close a LONGER cycle", async () => {
    // The two-node case is also refused by the at-most-one-parent key in some
    // orderings, so on its own it cannot tell the cycle walk from the PK. This
    // one can: `region` has no parent, so nothing but the walk refuses it.
    await approve(edge("subject", "emea", "europe"));
    await approve(edge("subject", "europe", "region"));
    const closing = await approve(edge("subject", "region", "emea"));
    expect(closing).toMatchObject({ ok: false, refusal: "would-cycle" });

    expect(await storedEdges()).toHaveLength(2);
    const vocabulary = await loadClaimVocabulary(pool, WS);
    expect(vocabulary.subject("emea")).toBe("region");
  });

  it("a norm with no parent CAN be approved onto the chain's root (the control)", async () => {
    // Same shape as the refusal above, one edge different: `apac → region`
    // extends the forest instead of closing it. Without this, a cycle check
    // that refused everything reaching an existing chain would pass.
    await approve(edge("subject", "emea", "europe"));
    await approve(edge("subject", "europe", "region"));
    expect((await approve(edge("subject", "apac", "region"))).ok).toBe(true);
    expect((await loadClaimVocabulary(pool, WS)).subject("apac")).toBe("region");
  });

  // ── 5. The endpoints are norms, not surfaces ────────────────────────────

  it("re-norms both endpoints on write, so a display-cased target still joins", async () => {
    // The likeliest authoring mistake once this is a reviewed data table: an
    // admin types the canonical DISPLAY form. `slotKey` re-norms the ANSWER,
    // but a stored non-norm would also make the closure's own joins miss, which
    // `slotKey` cannot repair. Both sides are spelled off normal form so a
    // one-sided normalization cannot pass.
    expect((await approve(edge("predicate", "Is_Priced  At", "Priced At"))).ok).toBe(true);

    expect(await storedEdges()).toEqual([
      { slot_position: "predicate", from_norm: "is priced at", to_norm: "priced at" },
    ]);
    // And the composition works through the normalized endpoint — the half a
    // from-side-only normalization would still get wrong.
    expect((await approve(edge("predicate", "priced at", "unit price"))).ok).toBe(true);
    expect((await loadClaimVocabulary(pool, WS)).predicate("is priced at")).toBe("unit price");
  });

  it("refuses an edge whose endpoints norm to the same thing", async () => {
    const same = await approve(edge("predicate", "Priced At", "priced  at"));
    expect(same).toMatchObject({ ok: false, refusal: "self-edge" });
    expect(await storedEdges()).toHaveLength(0);
  });

  it("refuses an edge with a norm that asserts nothing", async () => {
    // `-`, `___` and `  ` all norm to the empty string, and a stored empty key
    // is the one value that joins every other degenerate row (migration 0187's
    // `DEFAULT ''` hazard, reached through the vocabulary's front door).
    expect(await approve(edge("predicate", "-", "unit price"))).toMatchObject({
      ok: false,
      refusal: "degenerate-norm",
    });
    expect(await approve(edge("predicate", "unit price", "___"))).toMatchObject({
      ok: false,
      refusal: "degenerate-norm",
    });
    expect(await storedEdges()).toHaveLength(0);
  });

  // ── 6. Position scoping ─────────────────────────────────────────────────

  it("a predicate-position approval does not re-key subjects or objects", async () => {
    // T7 target (b), and ADR-0037 §6's reason for scoping at all: agnostic, a
    // predicate approval re-keys subjects workspace-wide, silently, in the
    // direction nothing undoes. `owner` is the realistic collision — T4 §2 makes
    // warehouse predicates bare common nouns, exactly the norms most likely to
    // also be subject or object surfaces.
    expect((await approve(edge("predicate", "owner", "account owner"))).ok).toBe(true);

    const vocabulary = await loadClaimVocabulary(pool, WS);
    expect(vocabulary.predicate("owner")).toBe("account owner");
    expect(vocabulary.subject("owner")).toBe("owner");
    expect(vocabulary.object("owner")).toBe("owner");
  });

  it("the three positions are three independent forests (the control)", async () => {
    // The prohibition above passes against a `loadClaimVocabulary` whose
    // subject and object lookups are hardwired to the identity function. This
    // is what proves each position can answer, and that the SAME norm resolves
    // differently in each — which is the whole content of "position-scoped".
    await approve(edge("predicate", "owner", "account owner"));
    await approve(edge("subject", "owner", "owner (person)"));
    await approve(edge("object", "owner", "owner (value)"));

    const vocabulary = await loadClaimVocabulary(pool, WS);
    expect(vocabulary.predicate("owner")).toBe("account owner");
    expect(vocabulary.subject("owner")).toBe("owner (person)");
    expect(vocabulary.object("owner")).toBe("owner (value)");
  });

  it("removing an edge at one position leaves the others standing", async () => {
    await approve(edge("predicate", "owner", "account owner"));
    await approve(edge("subject", "owner", "owner (person)"));
    expect(await remove("predicate", "owner")).toBe(true);

    const vocabulary = await loadClaimVocabulary(pool, WS);
    expect(vocabulary.predicate("owner")).toBe("owner");
    // The recompute clears and rebuilds ONE position; a rebuild scoped to the
    // workspace alone would have wiped this.
    expect(vocabulary.subject("owner")).toBe("owner (person)");
  });

  // ── 7. Workspace scoping ────────────────────────────────────────────────

  it("is workspace-scoped — a neighbour's vocabulary is invisible", async () => {
    await approve(edge("predicate", "owner", "account owner"));
    await approve(edge("predicate", "owner", "the boss"), OTHER_WS);

    expect((await loadClaimVocabulary(pool, WS)).predicate("owner")).toBe("account owner");
    expect((await loadClaimVocabulary(pool, OTHER_WS)).predicate("owner")).toBe("the boss");

    await pool.query("DELETE FROM brain_vocabulary_target WHERE workspace_id = $1", [OTHER_WS]);
    await pool.query("DELETE FROM brain_vocabulary_edge WHERE workspace_id = $1", [OTHER_WS]);
  });

  it("a workspace that has approved nothing gets the identity function", async () => {
    const vocabulary = await loadClaimVocabulary(pool, WS);
    expect(vocabulary.predicate("is priced at")).toBe("is priced at");
    expect(vocabulary.subject("acme")).toBe("acme");
    expect(vocabulary.object("49")).toBe("49");
  });

  // ── 8. The convergence guard ────────────────────────────────────────────

  it("refuses to commit a closure that did not converge", async () => {
    // The only test here that writes edges through raw SQL, and it has to: the
    // primitives refuse a cycle, which is the point. This is the store as it
    // would look after a hand-written INSERT or a restore that bypassed them.
    //
    // What it pins is that the depth cap FAILS rather than TRUNCATES. A cap
    // that silently kept the deepest hop it reached would write a closure
    // pointing at an intermediate node, `alias` would answer confidently and
    // wrongly, and every row keyed through it would need a re-key to recover.
    //
    // THREE nodes, not two, and that is load-bearing: a 2-cycle walked to an
    // even depth lands every node back on ITSELF, so
    // `ck_brain_vocabulary_target_not_self` refuses the INSERT and the
    // convergence check never runs — the test would pass against a build with
    // no convergence check at all. At three nodes the cap (64) lands each norm
    // on a DIFFERENT node, which is a perfectly legal closure row and exactly
    // the silent wrong answer this guard exists to catch.
    await pool.query(
      `INSERT INTO brain_vocabulary_edge (workspace_id, slot_position, from_norm, to_norm)
       VALUES ($1, 'predicate', 'a', 'b'), ($1, 'predicate', 'b', 'c'), ($1, 'predicate', 'c', 'a')`,
      [WS],
    );

    await expect(
      inTx((tx) => recomputeEffectiveTargets(tx, WS, "predicate")),
    ).rejects.toThrow(/did not converge/);

    // The transaction rolled back, so no partial closure was committed — the
    // rebuild is DELETE-then-INSERT, and a half-applied one would leave the
    // position with no closure at all while the edges still claim one.
    const { rows } = await pool.query(
      "SELECT 1 FROM brain_vocabulary_target WHERE workspace_id = $1",
      [WS],
    );
    expect(rows).toHaveLength(0);
  });

  it("a deep but acyclic chain converges (the control)", async () => {
    // Without this, a `recomputeEffectiveTargets` that threw on every chain
    // longer than one hop would satisfy the test above. Five hops is past
    // anything the composition tests reach and far short of the cap.
    const chain = ["a", "b", "c", "d", "e", "f"];
    for (let i = 0; i < chain.length - 1; i++) {
      expect((await approve(edge("object", chain[i]!, chain[i + 1]!))).ok).toBe(true);
    }
    const vocabulary = await loadClaimVocabulary(pool, WS);
    for (const norm of chain.slice(0, -1)) {
      expect(vocabulary.object(norm), norm).toBe("f");
    }
  });

  // ── 9. Derived-ness is structural ───────────────────────────────────────

  it("refuses to delete an edge out from under its closure row", async () => {
    // `fk_brain_vocabulary_target_edge` is RESTRICT, not CASCADE, and the
    // difference is not tidiness. Cascade would delete `priced at`'s closure row
    // when its edge went and leave `is priced at` pointing at a `unit price`
    // nobody approves any more — a wrong answer with nothing to surface it.
    // RESTRICT makes "remove an edge without recomputing" unrepresentable
    // instead of a caller obligation.
    await seedCompressedChain();
    await expect(
      pool.query(
        `DELETE FROM brain_vocabulary_edge
          WHERE workspace_id = $1 AND slot_position = 'predicate' AND from_norm = 'priced at'`,
        [WS],
      ),
    ).rejects.toThrow(/fk_brain_vocabulary_target_edge/);
  });
});
