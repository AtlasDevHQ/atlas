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
import type { SlotPosition } from "@atlas/api/lib/brain/identity";
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
import { withheldCount } from "@atlas/api/lib/brain/vocabulary-visibility";
import type { ReconcileTransactionRunner } from "@atlas/api/lib/brain/reconcile";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;
const PG_TEST_TIMEOUT_MS = 60_000;

const WS = "ws-vocab-5087";

// ---------------------------------------------------------------------------
// `withheldCount` — pure, so it runs without a database
// ---------------------------------------------------------------------------

describe("the withheld count is never a silent omission (#5087, ADR-0037 §6)", () => {
  it("reports the difference, so 'you cannot see 12' is distinguishable from 'none'", () => {
    // THE property the pane exists for. A scoped SELECT renders those two
    // identically, and an approver who cannot tell them apart concludes their
    // workspace has a clean vocabulary when it may have a dozen entries they
    // are blind to.
    expect(withheldCount(15, 3)).toEqual({
      total: 15,
      scoped: 3,
      withheld: 12,
      consistent: true,
    });
    expect(withheldCount(3, 3).withheld).toBe(0);
  });

  it("reports an inverted delta rather than clamping it into a reassuring zero", () => {
    // `loadFactOversight`'s recorded lesson, quoted in `BlastRadiusSide`:
    // silently clamping renders as "nothing is hidden from you", which is the
    // pre-#4825 defect reproduced by its own fix. A mutation deleting the
    // `consistent` computation and hardcoding `true` fails here.
    const inverted = withheldCount(2, 5);
    expect(inverted.withheld).toBe(0);
    expect(inverted.consistent).toBe(false);
  });

  it("refuses an unreadable count rather than rendering NaN at an approver", () => {
    const broken = withheldCount(Number.NaN, 4);
    expect(broken.withheld).toBe(0);
    expect(broken.consistent).toBe(false);
  });
});

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
   * One live fact, keys derived the way the pipeline derives them.
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
               NULLIF(btrim(regexp_replace(translate($2, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), '[ ' || chr(9) || chr(10) || chr(11) || chr(12) || chr(13) || '_-]+', ' ', 'g'), ' '), ''),
               NULLIF(btrim(regexp_replace(translate($3, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), '[ ' || chr(9) || chr(10) || chr(11) || chr(12) || chr(13) || '_-]+', ' ', 'g'), ' '), ''),
               NULLIF(btrim(regexp_replace(translate($4, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), '[ ' || chr(9) || chr(10) || chr(11) || chr(12) || chr(13) || '_-]+', ' ', 'g'), ' '), ''))
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
      await seedFact({ subject: "acme", predicate: "is priced at", object: "10", visibleTo: ["org"] });
      const outcome = await author("predicate", "is priced at", "priced at");
      expect(outcome.kind).toBe("refused");
      if (outcome.kind !== "refused") throw new Error("unreachable");
      expect(outcome.message).toContain("priced at");
    });

    it("refuses when BOTH sides are empty, and says so", async () => {
      await seedFact({ subject: "acme", predicate: "reports to", object: "bob", visibleTo: ["org"] });
      const population = await loadPairPopulation(pool, owner(), {
        position: "predicate",
        fromNorm: "is priced at",
        toNorm: "priced at",
      });
      expect(emptySide(population)).toBe("both");
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
