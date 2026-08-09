/**
 * Direct authoring, removal, and the *In force* pane's disclosure rule
 * (#5087, ADR-0037 §6).
 *
 * ## Why this is a `-pg` suite
 *
 * `vocabulary-pg.test.ts`'s reason, inherited: every property under test is a
 * property of SQL. The author-and-approve atomicity is a transaction boundary,
 * the rejection memory is a unique constraint on a generated unordered pair, the
 * both-sides visibility test is a join against `brain_facts`, and the closure
 * rebuild is a recursive CTE. A fake that decided any of this in TypeScript
 * would be a second implementation agreeing with the first by construction —
 * which is what #5000's root cause was.
 *
 * ## Every prohibition has its own positive control, in its own `test()`
 *
 * Most assertions here are REFUSALS and absences, and both pass green against
 * machinery that does nothing. An `authorAliasEdge` that returned
 * `{kind: "refused"}` unconditionally satisfies four of them; a
 * `loadInForceVocabulary` that returned `{edges: []}` satisfies the visibility
 * arm outright. The controls are separate `test()` blocks rather than extra
 * arms in one body, because in a long proof the first failure hides the rest —
 * and a broken control would silently license the prohibition it is supposed to
 * make meaningful.
 *
 * ## What #5027 cost, and what this suite does about it
 *
 * #5027 took four `/review-panel` rounds because rounds 1 and 2 shipped fixes
 * with no falsifiers, so each round's defect survived into the next — recorded
 * as `/review-panel` Step 6 in #5065. Each assertion below therefore states the
 * DEFECT it would catch, not merely the behaviour it observes.
 *
 * Opt in locally with the same scratch database as its sibling brain suites:
 *   bun run db:up && export TEST_DATABASE_URL=postgresql://atlas:atlas@localhost:5433/brain_4771_scratch
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Pool, type PoolClient } from "pg";
import { runMigrations } from "@atlas/api/lib/db/migrate";
import { MANAGED_AUTH_MIGRATIONS, _resetPool } from "@atlas/api/lib/db/internal";
import type { BrainPrincipalContext } from "@atlas/api/lib/brain/acl";
import { identityKeySql, type SlotPosition } from "@atlas/api/lib/brain/identity";
import {
  REKEY_DRIFTED_FACTS_SQL,
  authorAliasEdge,
  proposeAliasEdge,
  removeInForceAliasEdge,
} from "@atlas/api/lib/brain/vocabulary-decide";
import {
  emptySide,
  loadObservedSurfaces,
  loadPairPopulation,
} from "@atlas/api/lib/brain/vocabulary-surfaces";
import {
  loadInForceVocabulary,
  loadVocabularyCoverage,
} from "@atlas/api/lib/brain/vocabulary-in-force";
import { declarePredicateCardinalityForSurface } from "@atlas/api/lib/brain/cardinality";
import { loadClaimVocabulary } from "@atlas/api/lib/brain/vocabulary";
import type { ReconcileTransactionRunner } from "@atlas/api/lib/brain/reconcile";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;
const PG_TEST_TIMEOUT_MS = 60_000;

const WS = "ws-vocab-5087";

// ---------------------------------------------------------------------------

describeIfPg("direct authoring and the In-force pane (#5087)", () => {
  let pool: Pool;
  const schemaName = `brain_5087_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let priorDatabaseUrl: string | undefined;

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

  afterEach(async () => {
    // Targets BEFORE edges — `fk_brain_vocabulary_target_edge` is RESTRICT.
    await pool.query("DELETE FROM brain_vocabulary_target");
    await pool.query("DELETE FROM brain_vocabulary_edge");
    await pool.query("DELETE FROM brain_vocabulary_proposal");
    await pool.query("DELETE FROM brain_predicate_cardinality");
    await pool.query("DELETE FROM brain_edges");
    await pool.query("DELETE FROM brain_facts");
    await pool.query("DELETE FROM brain_episodes");
  });

  // ── helpers ───────────────────────────────────────────────────────────────

  /** The real transaction runner, against this suite's schema-scoped pool. */
  const runner: ReconcileTransactionRunner = async (fn) => {
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
  };

  const owner = (audienceIds: readonly string[] = []): BrainPrincipalContext => ({
    origin: "authenticated",
    workspaceId: WS,
    userId: "user-owner",
    role: "owner",
    audienceIds,
  });

  const member = (audienceIds: readonly string[] = []): BrainPrincipalContext => ({
    origin: "authenticated",
    workspaceId: WS,
    userId: "user-member",
    role: "member",
    audienceIds,
  });

  let episodeSeq = 0;
  async function seedEpisode(visibleTo: readonly string[]): Promise<string> {
    episodeSeq += 1;
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO brain_episodes (workspace_id, source, source_id, body, occurred_at, visible_to)
       VALUES ($1, 'manual', $2, 'seed', now(), $3::text[])
       RETURNING id`,
      [WS, `ep-5087-${episodeSeq}`, visibleTo],
    );
    return rows[0]!.id;
  }

  /**
   * One live fact, keys derived by the PRODUCTION expression.
   *
   * ⚠️ `identityKeySql` is imported rather than transcribed. The first cut
   * pasted the `translate(…)/regexp_replace(…)` body into the fixture — a second
   * implementation of the norm rule, which would diverge silently the day
   * `lexicalNorm`'s separator class changes, and the atomicity test's baseline
   * assertion would then describe a corpus state production never produces.
   *
   * The keys matter for the cardinality join only — the visibility seam joins on
   * `lexicalNorm(surface)` deliberately, so that an alias's own approval does
   * not make its source norm's population vanish. Setting them here anyway keeps
   * the fixture honest rather than accidentally proving the seam right.
   */
  async function seedFact(opts: {
    subject: string;
    predicate: string;
    object: string;
    visibleTo: readonly string[];
  }): Promise<string> {
    const episodeId = await seedEpisode(opts.visibleTo);
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO brain_facts
         (workspace_id, subject, predicate, object, source_episode_id, provenance, status,
          visible_to, subject_key, predicate_key, object_key)
       VALUES ($1, $2, $3, $4, $5, '{"actor":"test"}'::jsonb, 'published', $6::text[],
               ${identityKeySql("$2")}, ${identityKeySql("$3")}, ${identityKeySql("$4")})
       RETURNING id`,
      [WS, opts.subject, opts.predicate, opts.object, episodeId, opts.visibleTo],
    );
    return rows[0]!.id;
  }

  async function storedEdges(): Promise<{ from_norm: string; to_norm: string }[]> {
    const { rows } = await pool.query<{ from_norm: string; to_norm: string }>(
      `SELECT from_norm, to_norm FROM brain_vocabulary_edge
        WHERE workspace_id = $1 ORDER BY from_norm`,
      [WS],
    );
    return rows;
  }

  async function proposals(): Promise<
    { id: string; status: string; source_class: string; from_norm: string; to_norm: string }[]
  > {
    const { rows } = await pool.query<{
      id: string;
      status: string;
      source_class: string;
      from_norm: string;
      to_norm: string;
    }>(
      `SELECT id, status, source_class, from_norm, to_norm
         FROM brain_vocabulary_proposal WHERE workspace_id = $1 ORDER BY from_norm`,
      [WS],
    );
    return rows;
  }

  const author = (
    position: SlotPosition,
    fromNorm: string,
    toNorm: string,
    ctx: BrainPrincipalContext = owner(),
  ) => authorAliasEdge(WS, { position, fromNorm, toNorm }, ctx, { withTransaction: runner });

  // ── the picker ────────────────────────────────────────────────────────────

  describe("authoring is a picker over observed surfaces, never a norm text box", () => {
    it("offers only norms the corpus produced, with the merge visible", async () => {
      // THE positive control for every refusal below: it proves the picker query
      // fires and returns rows at all. Without it a `loadObservedSurfaces` that
      // returned `[]` unconditionally would satisfy the "does not offer an
      // absent norm" assertion and every zero-population refusal in this file.
      await seedFact({ subject: "acme", predicate: "is priced at", object: "10", visibleTo: ["org"] });
      await seedFact({ subject: "acme", predicate: "Is Priced At", object: "11", visibleTo: ["org"] });
      await seedFact({ subject: "acme", predicate: "priced at", object: "12", visibleTo: ["org"] });

      const page = await loadObservedSurfaces(pool, owner(), { position: "predicate" });
      const norms = page.surfaces.map((s) => s.norm).toSorted();
      expect(norms).toEqual(["is priced at", "priced at"]);

      const merged = page.surfaces.find((s) => s.norm === "is priced at")!;
      // The FOLDING, made visible. Two spellings of one norm, counted together:
      // this is the number an approver reasons about, and grouping by SURFACE
      // instead would have shown them as two rows of one claim each.
      expect(merged.claims).toBe(2);
      expect(merged.variants).toBe(2);
      expect(["is priced at", "Is Priced At"]).toContain(merged.exampleSurface);
    });

    it("does not offer a norm the corpus has never produced", async () => {
      await seedFact({ subject: "acme", predicate: "is priced at", object: "10", visibleTo: ["org"] });
      const page = await loadObservedSurfaces(pool, owner(), { position: "predicate" });
      // The typo an approver would have typed into a text box. `499 a month`
      // vs `499-a-month` is the case the ACs name; this is the same shape.
      expect(page.surfaces.map((s) => s.norm)).not.toContain("is priced att");
    });

    it("filters the list without ever supplying a value", async () => {
      await seedFact({ subject: "acme", predicate: "is priced at", object: "10", visibleTo: ["org"] });
      await seedFact({ subject: "acme", predicate: "reports to", object: "bob", visibleTo: ["org"] });

      const filtered = await loadObservedSurfaces(pool, owner(), {
        position: "predicate",
        filter: "priced",
      });
      expect(filtered.surfaces.map((s) => s.norm)).toEqual(["is priced at"]);

      // A filter matching NOTHING yields nothing — it does not fall back to the
      // typed string as a candidate value. That fallback is the exact
      // affordance the picker exists to remove, and it would be invisible in a
      // UI that rendered "no matches" beside a submit button that still worked.
      const miss = await loadObservedSurfaces(pool, owner(), {
        position: "predicate",
        filter: "definitely-not-present",
      });
      expect(miss.surfaces).toEqual([]);
    });

    it("treats a `%` in the filter as a literal, not as a wildcard", async () => {
      // Not a leak — the scope clause is AND-ed regardless — but a filter that
      // silently means something other than what was typed is wrong on the one
      // control whose entire job is to narrow rather than to supply.
      await seedFact({ subject: "acme", predicate: "is priced at", object: "10", visibleTo: ["org"] });
      const page = await loadObservedSurfaces(pool, owner(), { position: "predicate", filter: "%" });
      expect(page.surfaces).toEqual([]);
    });
  });

  // ── the zero-population refusal ───────────────────────────────────────────

  describe("a pair with no population is refused, naming which side is empty", () => {
    it("refuses and names the FROM side", async () => {
      await seedFact({ subject: "acme", predicate: "priced at", object: "10", visibleTo: ["org"] });

      const outcome = await author("predicate", "is priced at", "priced at");
      expect(outcome.kind).toBe("refused");
      if (outcome.kind !== "refused") throw new Error("unreachable");
      expect(outcome.refusal).toBe("empty-population");
      // NAMES the empty side. A refusal saying only "one side is empty" sends
      // an approver to re-check the side that was fine.
      expect(outcome.message).toContain("is priced at");
      expect(outcome.message).not.toContain('"priced at" has no live claim');

      // …and nothing was written. A refusal that left a `pending` human
      // proposal behind would be invisible (there is no queue on this surface)
      // and would block the correct authoring later with `already_pending`.
      expect(await proposals()).toEqual([]);
      expect(await storedEdges()).toEqual([]);
    });

    it("refuses and names the TO side", async () => {
      // ⚠️ DISJOINT norms, and the previous fixture is why. It used
      // `is priced at` / `priced at`, where the TO norm is a SUBSTRING of the
      // FROM norm — and `emptyPopulationMessage` always appends
      // `(from: n, to: n)`. So `toContain("priced at")` matched on three
      // separate accidents, and a mutation that always named the FROM side
      // passed. It also never asserted the refusal KIND, so a `degenerate-norm`
      // regression passed too.
      await seedFact({ subject: "acme", predicate: "alpha", object: "10", visibleTo: ["org"] });

      const outcome = await author("predicate", "alpha", "beta");
      expect(outcome.kind).toBe("refused");
      if (outcome.kind !== "refused") throw new Error("unreachable");
      expect(outcome.refusal).toBe("empty-population");
      expect(outcome.message).toContain('"beta" has no live claim');
      expect(outcome.message).not.toContain('"alpha" has no live claim');
    });

    it("refuses when BOTH sides are empty, and the sentence is not a double negative", async () => {
      // Routed through `author(...)` rather than through `loadPairPopulation` +
      // `emptySide` directly. The old version tested the CLASSIFIER and never
      // produced the message, so the `both` prose was unreachable by any test —
      // and it read *"neither "a" nor "b" has no live claim"*, which asserts the
      // opposite of the refusal it explains.
      await seedFact({ subject: "acme", predicate: "reports to", object: "bob", visibleTo: ["org"] });

      const population = await loadPairPopulation(pool, owner(), {
        position: "predicate",
        fromNorm: "alpha",
        toNorm: "beta",
      });
      expect(emptySide(population)).toBe("both");

      const outcome = await author("predicate", "alpha", "beta");
      expect(outcome.kind).toBe("refused");
      if (outcome.kind !== "refused") throw new Error("unreachable");
      expect(outcome.refusal).toBe("empty-population");
      // Reads as an ASSERTION, not a double negative. "neither … has no live
      // claim" says both sides DO have one, which is the opposite of the
      // refusal — and it is the shape a shared `${sides} has no live claim`
      // template produces the moment one arm starts with "neither".
      expect(outcome.message).toContain('Neither "alpha" nor "beta" has a live claim');
      expect(outcome.message).not.toContain("nor \"beta\" has no live claim");
    });

    it("POSITIVE CONTROL — the same call succeeds once both sides are populated", async () => {
      // Without this, an `authorAliasEdge` that refused unconditionally would
      // pass every assertion above.
      await seedFact({ subject: "acme", predicate: "is priced at", object: "10", visibleTo: ["org"] });
      await seedFact({ subject: "acme", predicate: "priced at", object: "11", visibleTo: ["org"] });

      const outcome = await author("predicate", "is priced at", "priced at");
      expect(outcome.kind).toBe("authored");
      expect(await storedEdges()).toEqual([{ from_norm: "is priced at", to_norm: "priced at" }]);
    });
  });

  // ── authoring writes THROUGH the proposal table ───────────────────────────

  describe("authoring writes through the proposal table, in one transaction", () => {
    async function seedBothSides() {
      await seedFact({ subject: "acme", predicate: "is priced at", object: "10", visibleTo: ["org"] });
      await seedFact({ subject: "acme", predicate: "priced at", object: "11", visibleTo: ["org"] });
    }

    it("leaves a human-sourced proposal row stamped approved", async () => {
      await seedBothSides();
      const outcome = await author("predicate", "is priced at", "priced at");
      expect(outcome.kind).toBe("authored");

      const rows = await proposals();
      expect(rows).toHaveLength(1);
      // THE row a later removal stamps `rejected`. Writing the edge directly
      // would leave none — and a producer would then re-propose the pair a
      // human deleted, which is #4507's failure returning through the one path
      // authoring exists to serve.
      expect(rows[0]!.source_class).toBe("human");
      expect(rows[0]!.status).toBe("approved");
    });

    it("re-keys existing facts onto the authored target", async () => {
      await seedBothSides();
      await author("predicate", "is priced at", "priced at");
      const { rows } = await pool.query<{ predicate_key: string; n: string }>(
        `SELECT predicate_key, COUNT(*)::text AS n FROM brain_facts
          WHERE workspace_id = $1 GROUP BY predicate_key`,
        [WS],
      );
      // Both claims now occupy ONE slot. That is the whole point of the merge,
      // and it is the observable the arc's originating bug is about.
      expect(rows).toEqual([{ predicate_key: "priced at", n: "2" }]);
    });

    it("is ATOMIC — a failing re-key leaves no proposal row and no edge", async () => {
      await seedBothSides();

      // The re-key is the LAST write before the stamp, and it is the one that
      // touches every row in the workspace — so it is the realistic failure
      // point (a lock timeout, a statement cancellation on the scan, a deadlock).
      // Injected by failing exactly that statement, matched against the exported
      // SQL rather than a substring, so the fault lands where production's would.
      const failingRunner: ReconcileTransactionRunner = async (fn) =>
        runner(async (tx) => {
          const guarded = {
            query: async (sql: string, params?: unknown[]) => {
              if (sql === REKEY_DRIFTED_FACTS_SQL.predicate) {
                throw new Error("simulated 57014: statement cancelled during the re-key");
              }
              return tx.query(sql, params);
            },
          };
          return fn(guarded as unknown as PoolClient);
        });

      await expect(
        authorAliasEdge(
          WS,
          { position: "predicate", fromNorm: "is priced at", toNorm: "priced at" },
          owner(),
          { withTransaction: failingRunner },
        ),
      ).rejects.toThrow(/statement cancelled/);

      // Neither half survives. A proposal row committed beside no edge would be
      // an `approved` proposal for a merge that never happened — re-approvable,
      // and refused the second time with `already-aliased` for a decision
      // nobody made.
      expect(await proposals()).toEqual([]);
      expect(await storedEdges()).toEqual([]);
      // …and the corpus is untouched.
      const { rows } = await pool.query<{ predicate_key: string }>(
        `SELECT DISTINCT predicate_key FROM brain_facts WHERE workspace_id = $1 ORDER BY 1`,
        [WS],
      );
      expect(rows.map((r) => r.predicate_key).toSorted()).toEqual(["is priced at", "priced at"]);
    });

    it("converges on a producer's pending proposal rather than inserting a second row", async () => {
      await seedBothSides();
      const queued = await proposeAliasEdge(
        WS,
        {
          position: "predicate",
          fromNorm: "is priced at",
          toNorm: "priced at",
          directed: false,
          sourceClass: "seam",
          confidence: 0.7,
          proposedBy: "producer",
        },
        { withTransaction: runner },
      );
      expect(queued.kind).toBe("queued");

      const outcome = await author("predicate", "is priced at", "priced at");
      expect(outcome.kind).toBe("authored");
      if (outcome.kind !== "authored") throw new Error("unreachable");
      expect(outcome.convergedOnProposal).toBe(true);

      const rows = await proposals();
      // ONE row, not two — migration 0190's unordered-pair constraint makes
      // that structural rather than a choice — and it keeps the PRODUCER's
      // source class, because the proposal genuinely came from there.
      expect(rows).toHaveLength(1);
      expect(rows[0]!.source_class).toBe("seam");
      expect(rows[0]!.status).toBe("approved");
    });

    it("refuses to silently flip a producer's DIRECTED proposal", async () => {
      await seedBothSides();
      await proposeAliasEdge(
        WS,
        {
          position: "predicate",
          fromNorm: "is priced at",
          toNorm: "priced at",
          directed: true,
          sourceClass: "seam",
          confidence: 0.9,
          proposedBy: "producer",
        },
        { withTransaction: runner },
      );

      // The opposite direction. Approving it would re-key the corpus the other
      // way — a different row set and a different blast radius — and the two
      // are indistinguishable afterwards. Authoring must not be the way around
      // the protection an approval already gets.
      const outcome = await author("predicate", "priced at", "is priced at");
      expect(outcome.kind).toBe("refused");
      if (outcome.kind !== "refused") throw new Error("unreachable");
      expect(outcome.refusal).toBe("direction-conflict");
      expect(await storedEdges()).toEqual([]);
    });
  });

  // ── entitlement ───────────────────────────────────────────────────────────

  describe("authoring needs the owner/admin entitlement, at EVERY position", () => {
    it("refuses a plain member at the PREDICATE position", async () => {
      await seedFact({ subject: "acme", predicate: "is priced at", object: "10", visibleTo: ["org"] });
      await seedFact({ subject: "acme", predicate: "priced at", object: "11", visibleTo: ["org"] });

      // ⚠️ The bar that differs from `approverEntitled`, which grants any
      // authenticated member the predicate position. Approving adjudicates
      // evidence a producer gathered; authoring creates the assertion from
      // nothing. A mutation replacing `authorEntitled` with `approverEntitled`
      // fails HERE and nowhere else.
      const outcome = await author("predicate", "is priced at", "priced at", member());
      expect(outcome.kind).toBe("refused");
      if (outcome.kind !== "refused") throw new Error("unreachable");
      expect(outcome.refusal).toBe("not-entitled");
      expect(await storedEdges()).toEqual([]);
    });

    it("refuses another workspace's admin before reading a single row", async () => {
      const foreign: BrainPrincipalContext = {
        origin: "authenticated",
        workspaceId: "some-other-workspace",
        userId: "user-owner",
        role: "owner",
        audienceIds: [],
      };
      const outcome = await author("predicate", "a", "b", foreign);
      expect(outcome.kind).toBe("refused");
      if (outcome.kind !== "refused") throw new Error("unreachable");
      expect(outcome.refusal).toBe("workspace-mismatch");
    });
  });

  // ── removal and rejection memory ──────────────────────────────────────────

  describe("removing an authored edge leaves rejection memory", () => {
    async function authorTheEdge() {
      await seedFact({ subject: "acme", predicate: "is priced at", object: "10", visibleTo: ["org"] });
      await seedFact({ subject: "acme", predicate: "priced at", object: "11", visibleTo: ["org"] });
      const outcome = await author("predicate", "is priced at", "priced at");
      expect(outcome.kind).toBe("authored");
    }

    it("drops the edge, re-keys the corpus back, and stamps the row rejected", async () => {
      await authorTheEdge();
      const removed = await removeInForceAliasEdge(
        WS,
        { position: "predicate", fromNorm: "is priced at", toNorm: "priced at" },
        owner(),
        { withTransaction: runner },
      );
      expect(removed.kind).toBe("removed");

      expect(await storedEdges()).toEqual([]);
      const rows = await proposals();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.status).toBe("rejected");

      // The UNDO half of the drift re-key: the claim that always said
      // `is priced at` goes back to its own slot, and the one that said
      // `priced at` stays. The key column alone cannot tell those two
      // populations apart — sharing a key is exactly what it records — which is
      // why the statement re-derives from the surface.
      const { rows: keys } = await pool.query<{ predicate_key: string }>(
        `SELECT DISTINCT predicate_key FROM brain_facts WHERE workspace_id = $1 ORDER BY 1`,
        [WS],
      );
      expect(keys.map((k) => k.predicate_key)).toEqual(["is priced at", "priced at"]);
    });

    it("a producer re-proposing the removed pair is REFUSED", async () => {
      await authorTheEdge();
      await removeInForceAliasEdge(
        WS,
        { position: "predicate", fromNorm: "is priced at", toNorm: "priced at" },
        owner(),
        { withTransaction: runner },
      );

      // THE assertion the whole author-through-the-proposal-table design exists
      // for. Under a direct `approveAliasEdge` write there is no row to stamp,
      // so this call returns `queued` and the removal does not stick.
      const reproposed = await proposeAliasEdge(
        WS,
        {
          position: "predicate",
          fromNorm: "is priced at",
          toNorm: "priced at",
          directed: false,
          sourceClass: "seam",
          confidence: 0.9,
          proposedBy: "producer",
        },
        { withTransaction: runner },
      );
      expect(reproposed.kind).toBe("rejected");
    });

    it("…and the UNORDERED pair is remembered, so the other direction is refused too", async () => {
      await authorTheEdge();
      await removeInForceAliasEdge(
        WS,
        { position: "predicate", fromNorm: "is priced at", toNorm: "priced at" },
        owner(),
        { withTransaction: runner },
      );
      const flipped = await proposeAliasEdge(
        WS,
        {
          position: "predicate",
          fromNorm: "priced at",
          toNorm: "is priced at",
          directed: false,
          sourceClass: "seam",
          confidence: 0.9,
          proposedBy: "producer",
        },
        { withTransaction: runner },
      );
      // An ORDERED identity would let a producer route around the rejection by
      // emitting the pair the other way, without any intent to. 0190's header
      // says so; this is where it is checked.
      expect(flipped.kind).toBe("rejected");
    });

    it("re-authoring a removed pair is refused, and the refusal says why it is permanent", async () => {
      await authorTheEdge();
      await removeInForceAliasEdge(
        WS,
        { position: "predicate", fromNorm: "is priced at", toNorm: "priced at" },
        owner(),
        { withTransaction: runner },
      );
      const outcome = await author("predicate", "is priced at", "priced at");
      expect(outcome.kind).toBe("refused");
      if (outcome.kind !== "refused") throw new Error("unreachable");
      expect(outcome.refusal).toBe("previously-rejected");
      // The cost, stated to the operator rather than discovered. Authoring over
      // a rejection would make every removal undoable by the next producer run,
      // which is the rule meaning nothing.
      expect(outcome.message).toMatch(/permanent/i);
    });

    it("CREATES the memory for an imported edge that never had a proposal", async () => {
      // The region importer copies edges and not proposals (#5035's bundle
      // scope classifies `brain_vocabulary_proposal` as `stays`), so this edge
      // exists with nothing to stamp. Removing it through `removeAliasEdge`
      // alone would drop it with no memory, and the next producer run would
      // re-propose it.
      await seedFact({ subject: "acme", predicate: "is priced at", object: "10", visibleTo: ["org"] });
      await seedFact({ subject: "acme", predicate: "priced at", object: "11", visibleTo: ["org"] });
      await pool.query(
        `INSERT INTO brain_vocabulary_edge
           (workspace_id, slot_position, from_norm, to_norm, approved_by)
         VALUES ($1, 'predicate', 'is priced at', 'priced at', 'imported-approver')`,
        [WS],
      );
      await pool.query(
        `INSERT INTO brain_vocabulary_target (workspace_id, slot_position, norm, effective_target)
         VALUES ($1, 'predicate', 'is priced at', 'priced at')`,
        [WS],
      );
      expect(await proposals()).toEqual([]);

      const removed = await removeInForceAliasEdge(
        WS,
        { position: "predicate", fromNorm: "is priced at", toNorm: "priced at" },
        owner(),
        { withTransaction: runner },
      );
      expect(removed.kind).toBe("removed");
      if (removed.kind !== "removed") throw new Error("unreachable");
      expect(removed.memoryCreated).toBe(true);

      const rows = await proposals();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.status).toBe("rejected");
      expect(await storedEdges()).toEqual([]);
    });

    it("removes by pair in EITHER order", async () => {
      await authorTheEdge();
      // The pane renders norms and the request carries what it rendered; a
      // transposed pair must remove the right edge rather than fail to find one.
      const removed = await removeInForceAliasEdge(
        WS,
        { position: "predicate", fromNorm: "priced at", toNorm: "is priced at" },
        owner(),
        { withTransaction: runner },
      );
      expect(removed.kind).toBe("removed");
      expect(await storedEdges()).toEqual([]);
    });

    it("refuses a removal naming a pair that is not in force", async () => {
      await seedFact({ subject: "acme", predicate: "is priced at", object: "10", visibleTo: ["org"] });
      const outcome = await removeInForceAliasEdge(
        WS,
        { position: "predicate", fromNorm: "is priced at", toNorm: "priced at" },
        owner(),
        { withTransaction: runner },
      );
      expect(outcome.kind).toBe("refused");
      if (outcome.kind !== "refused") throw new Error("unreachable");
      expect(outcome.refusal).toBe("not-in-force");
    });

    it("⚠️ refuses to remove an entity edge this reader cannot SEE", async () => {
      // THE oracle this gate closes. Before it, removal validated the workspace,
      // the owner/admin bar and the norm shape, then went straight to the
      // proposal row — so a reader the *In force* pane had withheld an entity
      // edge from could remove it by naming the pair.
      await seedFact({
        subject: "project atlas",
        predicate: "is",
        object: "thing",
        visibleTo: ["audience:secret"],
      });
      await seedFact({
        subject: "nova",
        predicate: "is",
        object: "thing",
        visibleTo: ["audience:secret"],
      });
      await pool.query(
        `INSERT INTO brain_vocabulary_edge
           (workspace_id, slot_position, from_norm, to_norm, approved_by)
         VALUES ($1, 'subject', 'project atlas', 'nova', 'seed-approver')`,
        [WS],
      );
      await pool.query(
        `INSERT INTO brain_vocabulary_target (workspace_id, slot_position, norm, effective_target)
         VALUES ($1, 'subject', 'project atlas', 'nova')`,
        [WS],
      );

      const blind = owner(["eng"]);
      // The pane withholds it — so the removal must too, or the log line
      // `logFailClosedHole` writes ("also un-removable by them") is false.
      const view = await loadInForceVocabulary(pool, blind);
      expect(view.edges).toEqual([]);
      expect(view.counts.find((c) => c.position === "subject")!.withheld).toBe(1);

      const outcome = await removeInForceAliasEdge(
        WS,
        { position: "subject", fromNorm: "project atlas", toNorm: "nova" },
        blind,
        { withTransaction: runner },
      );
      expect(outcome.kind).toBe("refused");
      if (outcome.kind !== "refused") throw new Error("unreachable");
      expect(outcome.refusal).toBe("not-in-force");
      // …and the edge is STILL THERE. A refusal that had already dropped the
      // edge would be the same disclosure with a politer message.
      expect(await storedEdges()).toHaveLength(1);
    });

    it("⚠️ answers a REAL invisible edge and an IMAGINED one identically", async () => {
      // The oracle is not the removal — it is the DIFFERENCE. Closing the write
      // while leaving two distinguishable refusals would let a reader learn the
      // pair exists by comparing responses, which at an entity position is the
      // confidential bit ADR-0037 §6 is about.
      await seedFact({
        subject: "project atlas",
        predicate: "is",
        object: "thing",
        visibleTo: ["audience:secret"],
      });
      await seedFact({
        subject: "nova",
        predicate: "is",
        object: "thing",
        visibleTo: ["audience:secret"],
      });
      await pool.query(
        `INSERT INTO brain_vocabulary_edge
           (workspace_id, slot_position, from_norm, to_norm, approved_by)
         VALUES ($1, 'subject', 'project atlas', 'nova', 'seed-approver')`,
        [WS],
      );
      await pool.query(
        `INSERT INTO brain_vocabulary_target (workspace_id, slot_position, norm, effective_target)
         VALUES ($1, 'subject', 'project atlas', 'nova')`,
        [WS],
      );

      const blind = owner(["eng"]);
      const real = await removeInForceAliasEdge(
        WS,
        { position: "subject", fromNorm: "project atlas", toNorm: "nova" },
        blind,
        { withTransaction: runner },
      );
      const imagined = await removeInForceAliasEdge(
        WS,
        { position: "subject", fromNorm: "no such thing", toNorm: "nor this" },
        blind,
        { withTransaction: runner },
      );

      expect(real.kind).toBe("refused");
      expect(imagined.kind).toBe("refused");
      if (real.kind !== "refused" || imagined.kind !== "refused") throw new Error("unreachable");
      // A THIRD arm: a pair with a PENDING proposal. That is the arm where a
      // distinguishable answer would tell a reader "a proposal exists for this
      // pair" — which at an entity position is the confidential bit — and it sat
      // outside the equality until now.
      await seedFact({ subject: "alpha", predicate: "is", object: "thing", visibleTo: ["org"] });
      await seedFact({ subject: "beta", predicate: "is", object: "thing", visibleTo: ["org"] });
      await proposeAliasEdge(
        WS,
        {
          position: "subject",
          fromNorm: "alpha",
          toNorm: "beta",
          directed: false,
          sourceClass: "seam",
          confidence: 0.8,
          proposedBy: "producer",
        },
        { withTransaction: runner },
      );
      const pending = await removeInForceAliasEdge(
        WS,
        { position: "subject", fromNorm: "alpha", toNorm: "beta" },
        blind,
        { withTransaction: runner },
      );
      expect(pending.kind).toBe("refused");
      if (pending.kind !== "refused") throw new Error("unreachable");

      expect(real.refusal).toBe(imagined.refusal);
      expect(pending.refusal).toBe(imagined.refusal);
      expect(pending.message).toBe(imagined.message);
      // BYTE-IDENTICAL prose. `notInForceMessage` names no norm precisely so
      // this assertion can be an equality rather than a fuzzy match — a message
      // echoing the requested pair back would differ here and the test would
      // have to weaken to survive it.
      expect(real.message).toBe(imagined.message);
    });

    it("POSITIVE CONTROL — a VISIBLE entity edge is removable by the same call", async () => {
      // Without this, a `removeInForceAliasEdge` that refused every entity
      // removal outright would satisfy both assertions above.
      await seedFact({
        subject: "project atlas",
        predicate: "is",
        object: "thing",
        visibleTo: ["audience:eng"],
      });
      await seedFact({
        subject: "nova",
        predicate: "is",
        object: "thing",
        visibleTo: ["audience:eng"],
      });
      const authored = await author("subject", "project atlas", "nova", owner(["eng"]));
      expect(authored.kind).toBe("authored");

      const outcome = await removeInForceAliasEdge(
        WS,
        { position: "subject", fromNorm: "project atlas", toNorm: "nova" },
        owner(["eng"]),
        { withTransaction: runner },
      );
      expect(outcome.kind).toBe("removed");
      expect(await storedEdges()).toEqual([]);
    });

    it("POSITIVE CONTROL — a PREDICATE edge stays removable by a reader who sees no claims", async () => {
      // The predicate arm is unscoped, and the gate must not have quietly made
      // it scoped: that would put #5000's own entry — authored at the predicate
      // position and verified in prod — behind a grant nobody holds.
      await seedFact({
        subject: "acme",
        predicate: "is priced at",
        object: "10",
        visibleTo: ["audience:secret"],
      });
      await seedFact({
        subject: "acme",
        predicate: "priced at",
        object: "11",
        visibleTo: ["audience:secret"],
      });
      await pool.query(
        `INSERT INTO brain_vocabulary_edge
           (workspace_id, slot_position, from_norm, to_norm, approved_by)
         VALUES ($1, 'predicate', 'is priced at', 'priced at', 'seed-approver')`,
        [WS],
      );
      await pool.query(
        `INSERT INTO brain_vocabulary_target (workspace_id, slot_position, norm, effective_target)
         VALUES ($1, 'predicate', 'is priced at', 'priced at')`,
        [WS],
      );

      const outcome = await removeInForceAliasEdge(
        WS,
        { position: "predicate", fromNorm: "is priced at", toNorm: "priced at" },
        owner([]),
        { withTransaction: runner },
      );
      expect(outcome.kind).toBe("removed");
    });

    it("refuses a plain member's removal", async () => {
      await authorTheEdge();
      const outcome = await removeInForceAliasEdge(
        WS,
        { position: "predicate", fromNorm: "is priced at", toNorm: "priced at" },
        member(),
        { withTransaction: runner },
      );
      expect(outcome.kind).toBe("refused");
      if (outcome.kind !== "refused") throw new Error("unreachable");
      expect(outcome.refusal).toBe("not-entitled");
      // A member who could not author the edge must not be able to delete it —
      // otherwise the strictness of the authoring bar is decorative.
      expect(await storedEdges()).toHaveLength(1);
    });
  });

  // ── the positional-visibility rule ────────────────────────────────────────

  describe("the In-force pane applies the positional rule to populations", () => {
    /** Approve an edge without going through the entitlement-gated seams. */
    async function seedEdge(position: SlotPosition, fromNorm: string, toNorm: string) {
      await pool.query(
        `INSERT INTO brain_vocabulary_edge
           (workspace_id, slot_position, from_norm, to_norm, approved_by)
         VALUES ($1, $2, $3, $4, 'seed-approver')`,
        [WS, position, fromNorm, toNorm],
      );
      await pool.query(
        `INSERT INTO brain_vocabulary_target (workspace_id, slot_position, norm, effective_target)
         VALUES ($1, $2, $3, $4)`,
        [WS, position, fromNorm, toNorm],
      );
    }

    it("shows a PREDICATE edge to a reader who can see neither side's claims", async () => {
      // Unscoped by design: a verb phrase discloses nothing an approver could
      // not have guessed, and this is what keeps #5000's entry visible for the
      // prod verification the arc closes on. A mutation that reader-scoped the
      // predicate arm fails here.
      await seedFact({
        subject: "acme",
        predicate: "is priced at",
        object: "10",
        visibleTo: ["audience:finance"],
      });
      await seedFact({
        subject: "acme",
        predicate: "priced at",
        object: "11",
        visibleTo: ["audience:finance"],
      });
      await seedEdge("predicate", "is priced at", "priced at");

      const view = await loadInForceVocabulary(pool, owner([]));
      expect(view.edges.map((e) => e.fromNorm)).toEqual(["is priced at"]);
      const counts = view.counts.find((c) => c.position === "predicate")!;
      expect(counts.decision).toBe("unscoped");
      expect(counts.withheld).toBe(0);
    });

    it("POSITIVE CONTROL — an entity edge IS shown when both sides are readable", async () => {
      // Without this, a `loadPositionEdges` that returned nothing for entity
      // positions would satisfy every withholding assertion below.
      await seedFact({
        subject: "project atlas",
        predicate: "is",
        object: "thing",
        visibleTo: ["audience:eng"],
      });
      await seedFact({
        subject: "nova",
        predicate: "is",
        object: "thing",
        visibleTo: ["audience:eng"],
      });
      await seedEdge("subject", "project atlas", "nova");

      const view = await loadInForceVocabulary(pool, owner(["eng"]));
      expect(view.edges.map((e) => e.fromNorm)).toEqual(["project atlas"]);
      const counts = view.counts.find((c) => c.position === "subject")!;
      expect(counts.decision).toBe("reader-scoped");
      expect(counts.withheld).toBe(0);
    });

    it("withholds an entity edge when only ONE side is readable", async () => {
      // ⚠️ The half of the rule most likely to be dropped in a copy —
      // "reader-scoped on BOTH sides". A one-sided test would let
      // *"something you cannot see is the same thing as X"* through, which
      // discloses half a merge to a reader the grant excluded from the other
      // half.
      await seedFact({
        subject: "project atlas",
        predicate: "is",
        object: "thing",
        visibleTo: ["audience:eng"],
      });
      await seedFact({
        subject: "nova",
        predicate: "is",
        object: "thing",
        visibleTo: ["audience:secret"],
      });
      await seedEdge("subject", "project atlas", "nova");

      const view = await loadInForceVocabulary(pool, owner(["eng"]));
      expect(view.edges).toEqual([]);
      const counts = view.counts.find((c) => c.position === "subject")!;
      // …and the WITHHELD count says so. "1 you cannot see" and "none" are
      // opposite facts, and an empty list renders them identically.
      expect(counts.total).toBe(1);
      expect(counts.scoped).toBe(0);
      expect(counts.withheld).toBe(1);
      expect(counts.consistent).toBe(true);
    });

    it("withholds an entity edge when NEITHER side is readable", async () => {
      await seedFact({
        subject: "project atlas",
        predicate: "is",
        object: "thing",
        visibleTo: ["audience:secret"],
      });
      await seedFact({
        subject: "nova",
        predicate: "is",
        object: "thing",
        visibleTo: ["audience:secret"],
      });
      await seedEdge("subject", "project atlas", "nova");

      const view = await loadInForceVocabulary(pool, owner(["eng"]));
      expect(view.edges).toEqual([]);
      expect(view.counts.find((c) => c.position === "subject")!.withheld).toBe(1);
    });

    it("keeps an authored edge visible after its own approval re-keys the corpus", async () => {
      // ⚠️ The defect a KEY join would produce, and the reason
      // `visibleNormsSql` projects `lexicalNorm(surface)`. After `a → b` is
      // approved no live row keys `a` any more — so an edge-visibility test
      // written against `subject_key` would make the edge just authored vanish
      // from the pane that exists to show it in force, on the very path #5000
      // closes on.
      await seedFact({
        subject: "project atlas",
        predicate: "is",
        object: "thing",
        visibleTo: ["audience:eng"],
      });
      await seedFact({
        subject: "nova",
        predicate: "is",
        object: "thing",
        visibleTo: ["audience:eng"],
      });
      // The audience is supplied deliberately: at an ENTITY position the
      // population check is reader-scoped, so an owner who cannot read the
      // claims cannot author over them either. That is the seam holding, not an
      // obstacle to route around — and it is why this fixture states the
      // audience where the predicate-position ones do not.
      const outcome = await author("subject", "project atlas", "nova", owner(["eng"]));
      expect(outcome.kind).toBe("authored");

      const { rows } = await pool.query<{ subject_key: string }>(
        `SELECT DISTINCT subject_key FROM brain_facts WHERE workspace_id = $1`,
        [WS],
      );
      // The re-key really happened — so the assertion below is not passing
      // because nothing moved.
      expect(rows.map((r) => r.subject_key)).toEqual(["nova"]);

      const view = await loadInForceVocabulary(pool, owner(["eng"]));
      expect(view.edges.map((e) => e.fromNorm)).toEqual(["project atlas"]);
    });

    it("carries the proposal id an authored edge's removal will stamp", async () => {
      await seedFact({ subject: "acme", predicate: "is priced at", object: "10", visibleTo: ["org"] });
      await seedFact({ subject: "acme", predicate: "priced at", object: "11", visibleTo: ["org"] });
      await author("predicate", "is priced at", "priced at");

      const view = await loadInForceVocabulary(pool, owner());
      expect(view.edges[0]!.proposalId).not.toBeNull();
    });

    it("still LISTS an imported edge that has no proposal row", async () => {
      // An inner join would make it vanish — an approved edge shaping identity
      // that the surface silently denies exists, which is a strictly worse
      // disclosure failure than showing it with a null id.
      await seedFact({ subject: "acme", predicate: "is priced at", object: "10", visibleTo: ["org"] });
      await seedFact({ subject: "acme", predicate: "priced at", object: "11", visibleTo: ["org"] });
      await seedEdge("predicate", "is priced at", "priced at");

      const view = await loadInForceVocabulary(pool, owner());
      expect(view.edges).toHaveLength(1);
      expect(view.edges[0]!.proposalId).toBeNull();
    });
  });

  // ── curated cardinalities ─────────────────────────────────────────────────

  describe("the In-force pane shows curated predicates, and only approved ones", () => {
    async function seedCardinality(opts: {
      predicateKey: string;
      status: "approved" | "pending";
      cardinality?: string;
    }) {
      await pool.query(
        `INSERT INTO brain_predicate_cardinality
           (workspace_id, predicate_key, cardinality, status, source_class, proposed_by)
         VALUES ($1, $2, $3, $4, 'human', 'user-owner')`,
        [WS, opts.predicateKey, opts.cardinality ?? "single", opts.status],
      );
    }

    it("renders the SURFACE and its live claim count, never the key", async () => {
      // The whole section was previously exercised only against an EMPTY table,
      // so the LATERAL surface resolution, the claim count and the key-stays-in-
      // the-join property were all unasserted — and `cardinalities` is the one
      // field the route passes through unmapped, so its strict schema was the
      // only guard and it never saw a row.
      await seedFact({ subject: "acme", predicate: "reports to", object: "bob", visibleTo: ["org"] });
      await seedFact({ subject: "acme", predicate: "Reports To", object: "sue", visibleTo: ["org"] });
      await seedCardinality({ predicateKey: "reports to", status: "approved" });

      const view = await loadInForceVocabulary(pool, owner());
      expect(view.cardinalities).toHaveLength(1);
      const entry = view.cardinalities[0]!;
      expect(entry.predicateSurface).toBeOneOf(["reports to", "Reports To"]);
      // Both spellings fold into the one canonical key, so both claims count.
      expect(entry.claims).toBe(2);
      expect(entry.cardinality).toBe("single");
      // ⚠️ No key on the record. `PredicateCardinalityRecord` states the same
      // prohibition for itself; this is the pane's version of it.
      expect(Object.keys(entry)).not.toContain("predicateKey");
      expect(JSON.stringify(entry)).not.toContain("predicate_key");
    });

    it("excludes a PENDING entry, which is a proposal rather than a fact in force", async () => {
      // `cardinalitySingleSql` — the one live read — filters on
      // `status = 'approved'`. Showing a pending row here would report a
      // predicate as shaping identity when the publish gate ignores it.
      await seedFact({ subject: "acme", predicate: "reports to", object: "bob", visibleTo: ["org"] });
      await seedCardinality({ predicateKey: "reports to", status: "pending" });

      const view = await loadInForceVocabulary(pool, owner());
      expect(view.cardinalities).toEqual([]);
      // …and it is counted as PENDING work rather than vanishing entirely.
      const coverage = await loadVocabularyCoverage(pool, WS);
      expect(coverage.pendingCardinalities).toBe(1);
    });

    it("reports a NULL surface for an entry whose claims have all been retracted", async () => {
      // A documented real state, and the one an approver most needs to find: an
      // entry still arming supersession for a predicate with no live claims.
      // Filtering it away would make it unremovable from the product.
      await seedCardinality({ predicateKey: "reports to", status: "approved" });
      const view = await loadInForceVocabulary(pool, owner());
      expect(view.cardinalities).toHaveLength(1);
      expect(view.cardinalities[0]!.predicateSurface).toBeNull();
      expect(view.cardinalities[0]!.claims).toBe(0);
    });

    it("counts curated predicates workspace-wide so an empty list is legible", async () => {
      await seedCardinality({ predicateKey: "reports to", status: "approved" });
      const view = await loadInForceVocabulary(pool, owner());
      expect(view.cardinalityCounts.total).toBe(1);
      expect(view.cardinalityCounts.consistent).toBe(true);
    });

    it("⚠️ curating an ALIASED spelling lands on its canonical predicate", async () => {
      // THE silent-failure mode `declarePredicateCardinalityForSurface` exists
      // to prevent, and it had no falsifier anywhere. An identity default would
      // write an entry keyed on `is priced at` — a norm no live claim carries
      // once the alias is approved — which `cardinalitySingleSql` never reads:
      // a no-op wearing the face of a successful curation.
      await seedFact({ subject: "acme", predicate: "is priced at", object: "10", visibleTo: ["org"] });
      await seedFact({ subject: "acme", predicate: "priced at", object: "11", visibleTo: ["org"] });
      const authored = await author("predicate", "is priced at", "priced at");
      expect(authored.kind).toBe("authored");

      const vocabulary = await loadClaimVocabulary(pool, WS);
      const result = await declarePredicateCardinalityForSurface(pool, WS, {
        predicateSurface: "is priced at",
        cardinality: "single",
        authoredBy: "user-owner",
        predicateAlias: vocabulary.predicate,
      });
      expect(result.ok).toBe(true);

      const { rows } = await pool.query<{ predicate_key: string }>(
        `SELECT predicate_key FROM brain_predicate_cardinality WHERE workspace_id = $1`,
        [WS],
      );
      // The CANONICAL key, not the spelling that was typed. A mutation replacing
      // `input.predicateAlias` with an identity lookup fails here and nowhere
      // else in the suite.
      expect(rows.map((r) => r.predicate_key)).toEqual(["priced at"]);

      // …and the entry is genuinely in force: the pane resolves it back to a
      // live surface, which it could not do for a key no claim carries.
      const view = await loadInForceVocabulary(pool, owner());
      expect(view.cardinalities).toHaveLength(1);
      expect(view.cardinalities[0]!.claims).toBe(2);
    });
  });

  // ── the picker at an ENTITY position ──────────────────────────────────────

  describe("the picker scopes and filters at an entity position too", () => {
    it("⚠️ binds its placeholders correctly with BOTH an ACL clause and a filter", async () => {
      // Every other picker test uses `predicate`, which is the ONE-parameter
      // arm. The entity arm binds two ACL params, so the filter and limit
      // placeholders shift — an untested combination whose failure mode is a
      // Postgres bind error surfacing as a 500 on the entity authoring picker.
      await seedFact({
        subject: "project atlas",
        predicate: "is",
        object: "thing",
        visibleTo: ["audience:eng"],
      });
      await seedFact({
        subject: "project nimbus",
        predicate: "is",
        object: "thing",
        visibleTo: ["audience:secret"],
      });

      const page = await loadObservedSurfaces(pool, owner(["eng"]), {
        position: "subject",
        filter: "project",
      });
      expect(page.decision).toBe("reader-scoped");
      // The visible one is offered (positive control — without it a query that
      // returned nothing would satisfy the exclusion below).
      expect(page.surfaces.map((s) => s.norm)).toEqual(["project atlas"]);
    });

    it("does not offer an entity norm from claims this reader cannot read", async () => {
      await seedFact({
        subject: "project nimbus",
        predicate: "is",
        object: "thing",
        visibleTo: ["audience:secret"],
      });
      const page = await loadObservedSurfaces(pool, owner(["eng"]), { position: "subject" });
      expect(page.surfaces).toEqual([]);
    });
  });

  // ── outcome arms that had no coverage ─────────────────────────────────────

  describe("outcome arms", () => {
    it("reports already_approved when the same pair is authored twice", async () => {
      await seedFact({ subject: "acme", predicate: "is priced at", object: "10", visibleTo: ["org"] });
      await seedFact({ subject: "acme", predicate: "priced at", object: "11", visibleTo: ["org"] });
      expect((await author("predicate", "is priced at", "priced at")).kind).toBe("authored");

      const second = await author("predicate", "is priced at", "priced at");
      // NOT a refusal and NOT a second write — the pair is already in the state
      // the caller asked for, and a double submit must say so rather than
      // surfacing `already-aliased` from the vocabulary.
      expect(second.kind).toBe("already_approved");
      expect(await storedEdges()).toHaveLength(1);
    });

    it("admits the local operator on a no-auth deployment", async () => {
      // `unauthenticated-local` is the DEFAULT self-hosted deploy mode. A
      // regression here means direct authoring is impossible on every
      // self-hosted install — and nothing went red for it.
      await seedFact({ subject: "acme", predicate: "is priced at", object: "10", visibleTo: ["org"] });
      await seedFact({ subject: "acme", predicate: "priced at", object: "11", visibleTo: ["org"] });

      const localOperator: BrainPrincipalContext = {
        origin: "unauthenticated-local",
        workspaceId: WS,
        userId: null,
        role: null,
        audienceIds: [],
      };
      const outcome = await author("predicate", "is priced at", "priced at", localOperator);
      expect(outcome.kind).toBe("authored");

      const { rows } = await pool.query<{ approved_by: string }>(
        `SELECT approved_by FROM brain_vocabulary_edge WHERE workspace_id = $1`,
        [WS],
      );
      // `local-operator`, never NULL. Migration 0189 makes NULL mean
      // "auto-approved, no human", so a human re-key recorded as NULL would be
      // indistinguishable from a machine one, permanently.
      expect(rows[0]!.approved_by).toBe("local-operator");
    });

    it("refuses an unresolved reader outright", async () => {
      const unresolved: BrainPrincipalContext = {
        origin: "unresolved",
        workspaceId: WS,
        userId: null,
        role: null,
        audienceIds: [],
      };
      const outcome = await author("predicate", "a", "b", unresolved);
      expect(outcome.kind).toBe("refused");
      if (outcome.kind !== "refused") throw new Error("unreachable");
      expect(outcome.refusal).toBe("not-entitled");
    });

    it("refuses a self-edge and a degenerate norm at the seam", async () => {
      // Previously covered only as MOCKED route outcomes, so the seam's own
      // shape guards never ran.
      const selfEdge = await author("predicate", "Priced At", "priced at");
      expect(selfEdge.kind).toBe("refused");
      if (selfEdge.kind !== "refused") throw new Error("unreachable");
      expect(selfEdge.refusal).toBe("self-edge");

      const degenerate = await author("predicate", "___", "priced at");
      expect(degenerate.kind).toBe("refused");
      if (degenerate.kind !== "refused") throw new Error("unreachable");
      expect(degenerate.refusal).toBe("degenerate-norm");
    });
  });

  // ── the empty state's coverage numbers ────────────────────────────────────

  describe("coverage is a statement about what has been observed", () => {
    it("counts live facts and the comparable subset the proposer reads", async () => {
      await seedFact({ subject: "acme", predicate: "is priced at", object: "10", visibleTo: ["org"] });
      await seedFact({ subject: "acme", predicate: "priced at", object: "11", visibleTo: ["org"] });

      const coverage = await loadVocabularyCoverage(pool, WS);
      expect(coverage.liveFacts).toBe(2);
      // `object_cmp` is written by the ingest pipeline, not by this fixture, so
      // the seeded rows carry NULL — which is exactly the day-one state the
      // empty state must be able to explain: *"0 of your 2 facts qualify"*.
      expect(coverage.comparableFacts).toBe(0);
      expect(coverage.pendingProposals).toBe(0);
    });

    it("counts a pending proposal so the surface never claims an empty queue it has not checked", async () => {
      await seedFact({ subject: "acme", predicate: "is priced at", object: "10", visibleTo: ["org"] });
      await seedFact({ subject: "acme", predicate: "priced at", object: "11", visibleTo: ["org"] });
      await proposeAliasEdge(
        WS,
        {
          position: "predicate",
          fromNorm: "is priced at",
          toNorm: "priced at",
          directed: false,
          sourceClass: "seam",
          confidence: 0.8,
          proposedBy: "producer",
        },
        { withTransaction: runner },
      );
      const coverage = await loadVocabularyCoverage(pool, WS);
      expect(coverage.pendingProposals).toBe(1);
    });
  });
});
