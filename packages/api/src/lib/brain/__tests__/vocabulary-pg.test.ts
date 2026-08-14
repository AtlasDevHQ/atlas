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
 * `a → b` then `b → c`, remove `b → c`, assert `a` lands back on `b`. A
 * single-edge vocabulary passes under path compression, under a scoped patch,
 * and under a full rebuild alike, so a test that does not compose is VACUOUS —
 * ADR-0037 §6 says so in as many words, and T7 lists it as target (a).
 *
 * The same trap has a second form, and it is the one that got past the first
 * cut: a refusal that REPORTS a norm's parent cannot be checked against a
 * single-edge fixture either, because the raw parent and the effective target
 * are then the same string. See the `existingTarget` test.
 *
 * ## Every prohibition has a positive control, in its own `test()`
 *
 * Most of the assertions here are refusals, and a refusal passes green against
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
 * **GENERATED — see `packages/api/scripts/mutations/vocabulary.md`**, from
 * `packages/api/scripts/mutations/vocabulary.mutations.ts`:
 *
 *     bun run db:up                 # from the repo ROOT — db:up is a root script
 *     cd packages/api
 *     export TEST_DATABASE_URL=…   # any scratch DB; see "Opt in locally" below
 *     bun run scripts/mutate.ts scripts/mutations/vocabulary.mutations.ts
 *
 * Twenty numbers used to live here by hand, under the claim "measured against
 * THIS tree … in a single run" (#5051). The claim was true when written and
 * unfalsifiable ever after — this same docstring already recorded that rounds 2
 * and 3 of that panel each caught rows which had gone stale. Regenerating at
 * #5061 re-measured all twenty IDENTICAL — the conversion is not always a
 * correction.
 *
 * The two COMPOUND rows, the four rows the schema also refuses, and the one
 * mutation deliberately left out (the probe's `< 1` polarity, which kills
 * nothing and cannot) are all written up in the generated file's preamble and
 * notes — beside the numbers rather than three paragraphs from them.
 *
 * ## Sibling files, same slice — measured ONCE, at #5051, and never since
 *
 * ⚠️ These are NOT generated and nothing re-runs them, so read them as a record
 * of what that slice checked rather than as current counts — the distinction the
 * table above no longer has to make. Converting them means mutation lists for
 * four more suites, which is a separate slice; the numbers are kept because
 * *which mutations were applied* is the durable half and does not go stale.
 *
 * `reconcile.test.ts`: the subject slot reading the predicate lookup (2), the
 * object slot reading the subject lookup (1). `correction.test.ts`: the
 * supersede guard reading the wrong position (2), `applySupersede` dropping the
 * vocabulary on the way into reconcile (1). `admin-migrate.test.ts` +
 * `migrate-roundtrip-pg.test.ts`: the importer's advisory lock dropped — the
 * lock-order inversion that deadlocks against a concurrent approval (1), the
 * import's re-norm refusal (2), its `slotPosition` arm (1), its empty-norm arm
 * (1), its omitted-`approvedBy` arm (1), a nulled `approved_by` (2), a restamped
 * `approved_at` (2), a skipped closure rebuild (5), and the rebuild re-gated on
 * `rowCount ?? 0` (1).
 *
 * Opt in locally with the same scratch database as its sibling brain suites —
 * every one of them creates and drops its OWN schema, so they share it safely:
 *   bun run db:up && export TEST_DATABASE_URL=postgresql://atlas:atlas@localhost:5433/brain_4771_scratch
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import { runMigrations } from "@atlas/api/lib/db/migrate";
import { MANAGED_AUTH_MIGRATIONS, _resetPool } from "@atlas/api/lib/db/internal";
import { reconcileFacts, type ReconcileEpisodeRef } from "@atlas/api/lib/brain/reconcile";
import { is } from "drizzle-orm";
import { PgTable, getTableConfig } from "drizzle-orm/pg-core";
import * as schema from "@atlas/api/lib/db/schema";
import {
  VocabularyClosureError,
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

  let priorDatabaseUrl: string | undefined;

  beforeAll(async () => {
    // `reconcileFacts` writes through the module-level pool when no runner is
    // injected, and sibling brain helpers gate on `hasInternalDB()`, which reads
    // the env var rather than the pool. Both are needed by the composition test
    // at the bottom; set inside the hook, never at module top level.
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

  afterEach(async () => {
    // Targets BEFORE edges — `fk_brain_vocabulary_target_edge` is RESTRICT, and
    // that ordering obligation is the same one the #4458 cleanup sweep carries.
    await pool.query("DELETE FROM brain_vocabulary_target");
    await pool.query("DELETE FROM brain_vocabulary_edge");
    await pool.query("DELETE FROM brain_edges");
    await pool.query("DELETE FROM brain_facts");
    await pool.query("DELETE FROM brain_episodes");
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

  it("re-norms the norm it is asked to remove", async () => {
    // The removal endpoint's twin of the approve-side re-norm test, and it was
    // missing: every other `remove()` here passes an already-normalized norm, so
    // dropping `lexicalNorm` from this function changed nothing observable.
    //
    // The bug it lets through is a silent NO-OP: #5025's admin UI hands back the
    // display form, `removeAliasEdge` finds no row, returns `false`, and the
    // operator is told nothing was aliased while the edge is still standing.
    await seedCompressedChain();
    expect(await remove("predicate", "Priced  At")).toBe(true);

    // …and it really removed the right edge, rather than reporting success.
    expect((await loadClaimVocabulary(pool, WS)).predicate("is priced at")).toBe("priced at");
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

  it("names the RAW approved parent as `existingTarget`, not the effective target", async () => {
    // Seeded as a COMPRESSED chain on purpose. With a single edge the raw parent
    // and the effective target are the same string, so the assertion cannot tell
    // them apart — it agrees with the implementation by construction, and
    // repointing the already-aliased read at `brain_vocabulary_target` passes.
    //
    // The distinction is the field's whole reason for existing: the refusal says
    // "remove that edge first", and `unit price` is the closure's ROOT, which is
    // not a removable edge from `is priced at` at all. Naming it would send the
    // operator to undo a decision that is not the one in the way.
    await seedCompressedChain();
    expect((await loadClaimVocabulary(pool, WS)).predicate("is priced at")).toBe("unit price");

    const second = await approve(edge("predicate", "is priced at", "list price"));
    expect(second).toMatchObject({
      ok: false,
      refusal: "already-aliased",
      existingTarget: "priced at",
    });
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

  it("the cycle walk does not see other positions", async () => {
    // Neutering `slot_position` in the walk's CTE was caught by NOTHING before
    // this: no fixture put an edge at one position whose endpoints are also edge
    // endpoints at another, so a cross-position walk never found a false cycle.
    //
    // The failure it prohibits is a spurious `would-cycle` REFUSAL of a
    // legitimate approval — the cross-position bleed ADR-0037 §6 scopes
    // positions to prevent, arriving through the guard instead of the closure.
    // The subject forest here is empty, so the only way to refuse this is to
    // have walked the predicate one.
    expect((await approve(edge("predicate", "owned by", "owner"))).ok).toBe(true);
    expect((await approve(edge("subject", "owner", "owned by"))).ok).toBe(true);

    const vocabulary = await loadClaimVocabulary(pool, WS);
    expect(vocabulary.predicate("owned by")).toBe("owner");
    expect(vocabulary.subject("owner")).toBe("owned by");
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

    // Asserted as the NAMED class with its fields, not just a message: #5023's
    // decide seam is meant to branch on it ("vocabulary corrupt" vs "database
    // unreachable"), and rewriting the throw as a bare `Error` passes a
    // message-only assertion.
    // Captured OUTSIDE `inTx`, deliberately. Catching inside would swallow the
    // rejection before the helper's ROLLBACK, so the transaction would COMMIT
    // the non-converging closure the rebuild had already inserted — and the
    // rollback assertion below would then be testing the test.
    const raised = await inTx((tx) => recomputeEffectiveTargets(tx, WS, "predicate")).then(
      () => null,
      (err: unknown) => err,
    );
    expect(raised).toBeInstanceOf(VocabularyClosureError);
    const closureError = raised as VocabularyClosureError;
    expect(closureError.message).toMatch(/did not converge/);
    expect(closureError.position).toBe("predicate");
    // Pinned against the fixture's own node set, and pinned as DISTINCT. A
    // `toBeTruthy` pair survives a constructor that passes one value into both
    // fields, or swaps them — which is the mistake a three-field error object
    // invites.
    expect(["a", "b", "c"]).toContain(closureError.norm);
    expect(["a", "b", "c"]).toContain(closureError.effectiveTarget ?? "");
    expect(closureError.norm).not.toBe(closureError.effectiveTarget);

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

  // ── 9. The transaction contract and the lock ────────────────────────────

  it("refuses to mutate the vocabulary outside a transaction", async () => {
    // `VocabularyExecutor` is structurally satisfied by a POOL on purpose —
    // that is what lets `loadClaimVocabulary` take one — so nothing in the type
    // separates a transaction from autocommit, and the mistake is one argument
    // away. On a pool, `pg_advisory_xact_lock` is released at the end of its own
    // statement and guards nothing, and `removeAliasEdge` would COMMIT an empty
    // closure between its DELETE and its rebuild.
    await expect(
      approveAliasEdge(pool, WS, edge("predicate", "is priced at", "priced at")),
    ).rejects.toThrow(/must run inside a transaction/);
    expect(await storedEdges()).toHaveLength(0);

    await expect(
      recomputeEffectiveTargets(pool, WS, "predicate"),
    ).rejects.toThrow(/must run inside a transaction/);
  });

  it("serializes two concurrent approvals, so a cycle cannot slip between them", async () => {
    // The one invariant the at-most-one-parent key CANNOT backstop, and the
    // module says so: two concurrent approvals of `a → b` and `b → a` each see
    // an acyclic store on their own snapshot, and without the lock both commit.
    // The result is not benign — reciprocal edges make every later recompute in
    // that position throw, so the position is wedged until someone hand-deletes
    // an edge.
    // ROLLBACK on the failure path and an explicit timeout, both load-bearing.
    // These hold open transactions owning the workspace's advisory lock, so a
    // bare `release()` on a failing assertion hands the pool back a connection
    // still holding it, and every later test blocks until its own timeout.
    // Measured: one real regression presented as FIVE failures plus a hung
    // `afterEach`, three of them naming innocent code.
    const first = await pool.connect();
    const second = await pool.connect();
    try {
      await first.query("BEGIN");
      await second.query("BEGIN");

      expect((await approveAliasEdge(first, WS, edge("predicate", "owned by", "owner"))).ok).toBe(true);

      // B blocks on A's lock rather than reading around it. Proven by racing the
      // promise against a resolved sentinel — if the lock were dropped, B would
      // have completed its own check-then-write by now.
      const blocked = approveAliasEdge(second, WS, edge("predicate", "owner", "owned by"));
      const raced = await Promise.race([
        blocked.then(() => "completed" as const),
        new Promise<"pending">((r) => setTimeout(() => r("pending"), 300)),
      ]);
      expect(raced).toBe("pending");

      await first.query("COMMIT");
      // Now that A is visible, B's cycle walk finds the chain and refuses.
      expect(await blocked).toMatchObject({ ok: false, refusal: "would-cycle" });
      await second.query("COMMIT");
    } catch (err) {
      // intentionally ignored: the assertion failure is rethrown below; a
      // rollback error on an already-dead connection would mask the real one
      await first.query("ROLLBACK").catch(() => {});
      await second.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      first.release();
      second.release();
    }

    expect(await storedEdges()).toEqual([
      { slot_position: "predicate", from_norm: "owned by", to_norm: "owner" },
    ]);
  }, 20_000);

  it("does not serialize approvals in DIFFERENT workspaces (the control)", async () => {
    // Without this, a lock keyed on a constant — or taken globally — would
    // satisfy the test above while turning every workspace's vocabulary writes
    // into one queue.
    const first = await pool.connect();
    const second = await pool.connect();
    try {
      await first.query("BEGIN");
      await second.query("BEGIN");
      expect((await approveAliasEdge(first, WS, edge("predicate", "a", "b"))).ok).toBe(true);
      // Completes while the first transaction is still open and holding its lock.
      expect(
        (await approveAliasEdge(second, OTHER_WS, edge("predicate", "a", "b"))).ok,
      ).toBe(true);
      await first.query("COMMIT");
      await second.query("COMMIT");
    } catch (err) {
      // intentionally ignored: as above — the outer error is the real failure
      await first.query("ROLLBACK").catch(() => {});
      await second.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      first.release();
      second.release();
    }
    await pool.query("DELETE FROM brain_vocabulary_target WHERE workspace_id = $1", [OTHER_WS]);
    await pool.query("DELETE FROM brain_vocabulary_edge WHERE workspace_id = $1", [OTHER_WS]);
  }, 20_000);

  it("refuses to load a vocabulary whose closure is only half rebuilt", async () => {
    // The one wrong answer `loadClaimVocabulary` could give with no error to
    // propagate: a missing closure row degrades that norm to itself, which is
    // byte-identical to "approved nothing" and keys a whole episode un-aliased.
    //
    // The error must NAME the norm, and that assertion is what pins the
    // single-statement shape. An earlier cut compared per-position COUNTS across
    // two statements — worse than the hole it closed, because on a pool the two
    // reads are two snapshots, so an ordinary concurrent approval made the
    // counts disagree and the loader raised a corruption alarm against a healthy
    // store. A count-based check cannot produce this message.
    await seedCompressedChain();
    await pool.query(
      "DELETE FROM brain_vocabulary_target WHERE workspace_id = $1 AND norm = 'is priced at'",
      [WS],
    );
    await expect(loadClaimVocabulary(pool, WS)).rejects.toThrow(
      /"is priced at" is an approved edge with no closure row/,
    );
  });

  it("loads cleanly when an approval COMMITS mid-load (no read skew)", async () => {
    // The regression the count-based check introduced, pinned so it cannot come
    // back — and the first cut of this test could NOT pin it. It held an
    // approval OPEN in another transaction, which is invisible to every
    // statement, so the counts agreed and the defective two-statement
    // implementation passed. Measured: reverting the loader to that version left
    // this file at 31 pass / 1 fail, and the failure was a different test.
    //
    // Read skew needs a COMMIT *between* the loader's statements. The wrapping
    // executor below is what creates one: it runs each query for real, and after
    // the FIRST it commits an ordinary approval on another connection. Against
    // the shipped single-statement LEFT JOIN that commit lands after the whole
    // read and changes nothing; against a two-statement version it lands between
    // them and the counts disagree.
    await seedCompressedChain();

    let interleaved = false;
    const interleaving: VocabularyExecutor = {
      query: async (sql, params) => {
        const out = await pool.query(sql, params as unknown[]);
        if (!interleaved) {
          interleaved = true;
          await inTx((tx) => approveAliasEdge(tx, WS, edge("predicate", "costs", "unit price")));
        }
        return out;
      },
    };

    const vocabulary = await loadClaimVocabulary(interleaving, WS);
    // The hook must actually have fired, or this proves nothing.
    expect(interleaved).toBe(true);
    expect(vocabulary.predicate("is priced at")).toBe("unit price");
    // The interleaved approval committed after the read, so it is legitimately
    // absent from THIS snapshot…
    expect(vocabulary.predicate("costs")).toBe("costs");
    // …and present in the next one.
    expect((await loadClaimVocabulary(pool, WS)).predicate("costs")).toBe("unit price");
  }, 20_000);

  // ── 10. The product claim, end to end ───────────────────────────────────

  it("an approved alias makes two spellings of a claim CORROBORATE", async () => {
    // The one thing this slice exists to make possible, proven where it happens
    // — in SQL, through the real ingest stage — rather than as two halves that
    // never meet. Without it the closure is verified here and the threading is
    // verified against a fake in `reconcile.test.ts`, and the COMPOSITION of the
    // two rests on the fake, which is the milestone's own named anti-pattern.
    //
    // #5000's pair, and the reason the vocabulary exists at all: `is priced at`
    // and `priced at` deliberately do NOT normalize together (`identity.ts`
    // refuses copula-stripping — the same rule would collapse `is owned by` into
    // `owns`), so an ENTRY with a reviewer behind it is the only fix.
    const seedEpisode = async (sourceId: string): Promise<ReconcileEpisodeRef> => {
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO brain_episodes (workspace_id, source, source_id, source_actor, body, occurred_at, visible_to)
         VALUES ($1, 'slack', $2, 'U123', 'evidence', now(), ARRAY['org'])
         RETURNING id`,
        [WS, sourceId],
      );
      return {
        id: rows[0]!.id,
        workspaceId: WS,
        source: "slack",
        sourceId,
        sourceActor: "U123",
        occurredAt: new Date("2026-06-21T09:00:00.000Z"),
        visibleTo: ["org"],
      };
    };

    const land = async (predicate: string, sourceId: string) =>
      reconcileFacts({
        episode: await seedEpisode(sourceId),
        candidates: [
          {
            subject: "acme:pro-plan",
            predicate,
            object: "49",
            predicateCardinality: "single",
          },
        ],
        producer: "extraction:v1",
        extractedAt: new Date(),
        // Loaded from the store, not hand-built — the whole point.
        vocabulary: await loadClaimVocabulary(pool, WS),
      });

    expect((await approve(edge("predicate", "is priced at", "priced at"))).ok).toBe(true);

    const first = await land("priced at", "C1/1");
    expect(first.outcomes[0]?.kind).toBe("created");
    const second = await land("is priced at", "C1/2");
    // ONE claim, corroborated — not a second draft row. The two surfaces are
    // still stored verbatim; it is the KEY that collapsed.
    expect(second.outcomes[0]?.kind).toBe("corroborated");

    const stored = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM brain_facts WHERE workspace_id = $1",
      [WS],
    );
    expect(stored.rows[0]!.n).toBe(1);
  });

  it("without the approved alias the same two spellings FORK (the control)", async () => {
    // The prohibition's twin, and what proves the corroboration above came from
    // the vocabulary rather than from a lexical layer that folds copulas anyway
    // (it must not — `identity.ts` refuses, and `led_by`/`leads` is why).
    const seedEpisode = async (sourceId: string): Promise<ReconcileEpisodeRef> => {
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO brain_episodes (workspace_id, source, source_id, source_actor, body, occurred_at, visible_to)
         VALUES ($1, 'slack', $2, 'U123', 'evidence', now(), ARRAY['org'])
         RETURNING id`,
        [WS, sourceId],
      );
      return {
        id: rows[0]!.id,
        workspaceId: WS,
        source: "slack",
        sourceId,
        sourceActor: "U123",
        occurredAt: new Date("2026-06-21T09:00:00.000Z"),
        visibleTo: ["org"],
      };
    };

    const land = async (predicate: string, sourceId: string) =>
      reconcileFacts({
        episode: await seedEpisode(sourceId),
        candidates: [
          { subject: "acme:pro-plan", predicate, object: "49", predicateCardinality: "single" },
        ],
        producer: "extraction:v1",
        extractedAt: new Date(),
        vocabulary: await loadClaimVocabulary(pool, WS),
      });

    expect((await land("priced at", "C2/1")).outcomes[0]?.kind).toBe("created");
    expect((await land("is priced at", "C2/2")).outcomes[0]?.kind).toBe("created");

    const stored = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM brain_facts WHERE workspace_id = $1",
      [WS],
    );
    expect(stored.rows[0]!.n).toBe(2);
  });

  // ── 11. Derived-ness is structural ──────────────────────────────────────

  it("refuses to delete an edge out from under its closure row", async () => {
    // `fk_brain_vocabulary_target_edge` is RESTRICT, not CASCADE, and the
    // difference is not tidiness. Cascade would delete `priced at`'s closure row
    // when its edge went and leave `is priced at` pointing at a `unit price`
    // nobody approves any more — a wrong answer with nothing to surface it.
    // RESTRICT stops an edge going while ITS OWN closure row stands. It does
    // not by itself force a full rebuild — a caller could delete one closure row
    // plus its edge and strand the rest — but it stops the rebuild being skipped
    // silently, which is the failure worth making unrepresentable.
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
