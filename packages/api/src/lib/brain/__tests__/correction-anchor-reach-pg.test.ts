/**
 * The correction lane's anchor arm, against LIVE Postgres (#5467).
 *
 * ## The pair this file reproduces
 *
 * us prod, 2026-08-26T16:25:09Z. A human superseded `series a` / `has target
 * raise of` / `8M` with `10M`. In the same instant the correction's tension scan
 * wired an anchor-only `in-tension-with` edge (`e78de65d`) to `series a` / `has
 * post money valuation of` / `30M` — **a raise target flagged against a
 * valuation**, both claims true, both live, and `has target raise of` carrying
 * no row in `brain_predicate_cardinality` at all.
 *
 * `correction.ts` hard-codes `predicateCardinality: "single"` on the claim a
 * correction authors. Until #5438 a correction's tension scan reached its own
 * slot and no further, so *"the verb may decide it"* and *"the verb decides only
 * about its own slot"* were one sentence. The anchor arm split them: the scan
 * now reaches every live claim sharing the subject's whole-token prefix, from a
 * different episode, with no predicate test. The reach widened; the hard-code
 * did not move.
 *
 * ## Why this needs real Postgres and cannot be a fake
 *
 * Everything under test is a SQL arm. `correction.test.ts`'s store models the
 * exact slot and nothing else, so it cannot tell an anchor-only rival from an
 * absent one — a fake that grew an anchor model would be a fixture agreeing with
 * itself about the very predicate this file exists to falsify. What the unit
 * lane owns is the BIND (`$10 = false` leaves `correction.ts`); what this file
 * owns is what the database does with it.
 *
 * ## The four cases, and why all four are needed
 *
 * A single "no edge appeared" assertion is satisfiable by a broken fixture, an
 * empty corpus, or a scan that stopped running. So:
 *
 *   1. **The prohibition** — uncurated predicate, anchor-only rival present and
 *      live: no edge.
 *   2. **The exact-slot control** — the SAME correction, in the SAME workspace,
 *      with the SAME absence of curation, still earns its exact-slot edge. This
 *      is the half #5467 deliberately did not take: the human's verb IS an
 *      assertion about the slot they corrected, and reading "an uncurated
 *      predicate mints nothing" as covering the slot arm would delete a true
 *      edge in every workspace that has curated nothing — silently, since a
 *      missing advisory edge is indistinguishable from agreement.
 *   3. **The curation control** — curate the predicate and the anchor edge
 *      appears. Without it the prohibition is equally consistent with "the
 *      anchor arm is off for corrections", which is a different and more
 *      damaging rule: the workspace's approved entry is supposed to license the
 *      reach, exactly as it does for `TENSION_SWEEP_SQL`.
 *   4. **The wrong-side control** — curate the RIVAL's predicate instead and the
 *      arm stays shut. Cases 1 and 3 together are satisfied by a gate reading
 *      either side, since in both of them exactly one predicate is curated and
 *      it is the driving one. This is the case that separates them.
 *
 * ## MUTATIONS VERIFIED RED
 *
 * ⚠️ **A hand-run record, NOT a generated table.** `packages/api/scripts/mutations/`
 * holds this repo's generated ones and `check-mutation-tables.sh` keeps those in
 * step with their specs; this list is neither and must not be read as one. It
 * says what was mutated on 2026-08-26 and which assertion went red, so a future
 * reader can re-run it by hand rather than trust that the tests below can fail
 * at all. Every line was executed against this file with
 * `TEST_DATABASE_URL` set, and reverted.
 *
 *   - `correction.ts`: delete `anchorReach: "curated-only"` → **cases 1 and 4
 *     fail** (the valuation edge returns), and `correction.test.ts`'s bind
 *     assertion with them. The shipped defect, reproduced.
 *   - `reconcile.ts`: bind a literal `true` instead of
 *     `item.candidate.anchorReach !== "curated-only"` → **cases 1 and 4 fail**,
 *     plus `reconcile.test.ts`'s `curated-only` bind test. What does the work is
 *     the declaration REACHING the statement, not the field existing.
 *   - `reconcile.ts`: drop the `exactSlotSql(…) OR` disjunct from the new
 *     conjunct — i.e. gate the WHOLE scan, which is the other available reading
 *     of #5467's "a predicate with no approved entry mints nothing" → **case 2
 *     fails**. This is the mutation the file exists for: it is green on every
 *     other assertion here, and it silently deletes a true edge in every
 *     workspace that has curated nothing.
 *   - `reconcile.ts`: replace `cardinalitySingleSql("f", "$3")` with `FALSE`
 *     → **case 3 fails**. The bound is the curated entry, not a flat refusal to
 *     ever use the anchor arm on this lane.
 *   - `reconcile.ts`: point the gate at the rival's own column
 *     (`cardinalitySingleSql("f", "f.predicate_key")`) → **cases 3 and 4 fail**.
 *     Case 4 is the one that names the defect: curating the VALUATION opens the
 *     arm, so the licence comes from a predicate nobody in the correction spoke
 *     about.
 *
 * Opt in locally with the same scratch database as its sibling brain suites —
 * this file creates and drops its OWN schema, so they share it safely:
 *   bun run db:up && export TEST_DATABASE_URL=postgresql://atlas:atlas@localhost:5433/brain_4771_scratch
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import { runMigrations } from "@atlas/api/lib/db/migrate";
import { MANAGED_AUTH_MIGRATIONS } from "@atlas/api/lib/db/internal";
import { identityAlias, identityVocabulary, slotKey } from "@atlas/api/lib/brain/identity";
import { correctFact } from "@atlas/api/lib/brain/correction";
import { declarePredicateCardinality } from "@atlas/api/lib/brain/cardinality";
import type { ReconcileTransactionRunner } from "@atlas/api/lib/brain/reconcile";
import type { BrainPrincipalContext } from "@atlas/api/lib/brain/acl";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;
const PG_TEST_TIMEOUT_MS = 60_000;

/** The prod pair, verbatim. The subject is EQUAL on both sides — the anchor
 *  arm's first disjunct — so nothing here depends on the prefix test as well. */
const SUBJECT = "Series A";
const RAISE = "has target raise of";
const VALUATION = "has post money valuation of";

function reviewer(workspaceId: string): BrainPrincipalContext {
  return {
    origin: "authenticated",
    workspaceId,
    userId: "user-admin-1",
    role: "admin",
    audienceIds: [],
  };
}

describeIfPg("the correction lane's anchor arm (real Postgres, #5467)", () => {
  let pool: Pool;
  const schemaName = `brain_corr_anchor_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

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

  /**
   * One transaction on the test pool, in `withBrainTransaction`'s shape.
   *
   * The `.catch` on the ROLLBACK and `client.release(rollbackErr)` are copied
   * from `correction-audit-pg.test.ts` for its stated reasons: a rollback-time
   * failure must not REPLACE the original cause, and an unconditional
   * `release()` hands back a client still inside an aborted transaction, where
   * the next assertion query fails with "current transaction is aborted".
   */
  const poolTx: ReconcileTransactionRunner = async <T,>(
    fn: (tx: {
      query: (sql: string, params?: unknown[]) => Promise<{ rows: readonly unknown[] }>;
    }) => Promise<T>,
  ): Promise<T> => {
    const client = await pool.connect();
    let rollbackErr: Error | undefined;
    try {
      await client.query("BEGIN");
      const result = await fn({
        query: async (sql: string, params?: unknown[]) => {
          const res = await client.query(sql, params);
          return { rows: res.rows as readonly unknown[] };
        },
      });
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch((rbErr: unknown) => {
        rollbackErr = rbErr instanceof Error ? rbErr : new Error(String(rbErr));
        console.warn(`correction-anchor-reach-pg: ROLLBACK failed — ${rollbackErr.message}`);
      });
      throw err;
    } finally {
      client.release(rollbackErr);
    }
  };

  /**
   * One live published claim, in its OWN episode.
   *
   * The separate episode is not incidental: the anchor arm flags a rival only
   * from a DIFFERENT episode, because one message routinely yields several
   * claims about one subject and they are not contradictions. Landing the seeds
   * in a shared episode would make every case below pass for that reason instead
   * of the one under test.
   *
   * Keyed like an ingested row (#5020) — an unkeyed seed is a corpus state the
   * ingest path cannot produce, and every arm of the scan joins on the keys.
   */
  async function seedFact(
    workspaceId: string,
    predicate: string,
    object: string,
    sourceId: string,
  ): Promise<string> {
    const { rows: episodes } = await pool.query<{ id: string }>(
      `INSERT INTO brain_episodes (workspace_id, source, source_id, source_actor, body, occurred_at, visible_to)
       VALUES ($1, 'slack', $2, 'U1', 'evidence', now(), ARRAY['org'])
       RETURNING id`,
      [workspaceId, sourceId],
    );
    const episodeId = episodes[0]?.id;
    if (episodeId === undefined) throw new Error("seed: episode insert returned no id");
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO brain_facts
         (workspace_id, subject, predicate, object, source_episode_id, provenance,
          status, visible_to, subject_key, predicate_key, object_key)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'published', ARRAY['org'], $7, $8, $9)
       RETURNING id`,
      [
        workspaceId,
        SUBJECT,
        predicate,
        object,
        episodeId,
        JSON.stringify({ source: "slack", actor: "U1" }),
        slotKey(SUBJECT, identityAlias),
        slotKey(predicate, identityAlias),
        slotKey(object, identityAlias),
      ],
    );
    const factId = rows[0]?.id;
    if (factId === undefined) throw new Error("seed: fact insert returned no id");
    return factId;
  }

  /** Every `in-tension-with` edge in the workspace, as `(from, to)` fact ids. */
  async function tensionEdges(
    workspaceId: string,
  ): Promise<{ from: string | null; to: string | null }[]> {
    const { rows } = await pool.query<{ from_fact_id: string | null; to_fact_id: string | null }>(
      `SELECT from_fact_id, to_fact_id FROM brain_edges
        WHERE workspace_id = $1 AND edge_type = 'in-tension-with'
     ORDER BY created_at, id`,
      [workspaceId],
    );
    return rows.map((r) => ({ from: r.from_fact_id, to: r.to_fact_id }));
  }

  /**
   * Land the prod shape and supersede the raise target.
   *
   * Returns the ids the assertions pivot on. `rivalInSlot` is the second live
   * claim in the SAME slot — the exact-slot control — and `anchorOnly` is the
   * valuation, which shares the subject and nothing else.
   */
  async function landAndSupersede(workspaceId: string) {
    const anchorOnly = await seedFact(workspaceId, VALUATION, "30M", `${workspaceId}-valuation`);
    const rivalInSlot = await seedFact(workspaceId, RAISE, "6M", `${workspaceId}-raise-6m`);
    const target = await seedFact(workspaceId, RAISE, "8M", `${workspaceId}-raise-8m`);

    const outcome = await correctFact(
      {
        vocabulary: identityVocabulary,
        ctx: reviewer(workspaceId),
        factId: target,
        verb: "supersede",
        replacement: { object: "10M" },
      },
      { withTransaction: poolTx },
    );
    if (outcome.kind !== "corrected") {
      throw new Error(`expected corrected, got ${outcome.kind} — every assertion below is vacuous`);
    }
    const replacement = outcome.result.supersededBy;
    if (replacement === null) throw new Error("supersede returned no replacement id");
    return { anchorOnly, rivalInSlot, target, replacement };
  }

  it(
    "⭐ mints NO anchor-only edge for a predicate with no curated entry",
    async () => {
      // Case 1 — the prohibition, and the prod pair reproduced. `has target
      // raise of` has no row in `brain_predicate_cardinality`, so the human's
      // verb licenses the slot and nothing wider. `e78de65d` is the edge this
      // assertion says can no longer be minted.
      const ws = "ws-anchor-uncurated";
      const { anchorOnly, rivalInSlot, replacement } = await landAndSupersede(ws);

      const edges = await tensionEdges(ws);
      expect(
        edges.some((e) => e.to === anchorOnly || e.from === anchorOnly),
        "a raise target was flagged against a post-money valuation on an uncurated predicate — the #5467 bound is gone",
      ).toBe(false);

      // Case 2 — the exact-slot control, asserted in the SAME workspace and off
      // the SAME correction, so it cannot be satisfied by a different fixture.
      // The claim is not "some edge exists": it is that THIS edge, from the
      // replacement to the other live value in the slot the human just
      // corrected, survives the bound.
      expect(
        edges,
        "the correction lost its EXACT-SLOT tension edge — the bound was applied to the whole scan, not to the anchor arm",
      ).toContainEqual({ from: replacement, to: rivalInSlot });
      // Exactly one, so "contains the right edge" cannot be true of a scan that
      // flagged everything under the subject and happened to include it.
      expect(edges).toHaveLength(1);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "⭐ …and mints it once the workspace APPROVES the predicate as `single`",
    async () => {
      // Case 3 — the curation control. Without this the prohibition above is
      // equally consistent with "the anchor arm is simply off for corrections",
      // which is a different rule and a worse one: the reach is supposed to be
      // licensed by the workspace's approved entry, exactly as
      // `TENSION_SWEEP_SQL` licenses its own.
      //
      // `declarePredicateCardinality` rather than a raw INSERT, so a change to
      // what the write path admits reaches this suite instead of being routed
      // around by a fixture that writes the table directly.
      const ws = "ws-anchor-curated";
      const declared = await declarePredicateCardinality(pool, ws, {
        predicateKey: slotKey(RAISE, identityAlias),
        cardinality: "single",
        authoredBy: "curator-1",
      });
      expect(declared.ok, "curating the predicate failed — the control proves nothing").toBe(true);

      const { anchorOnly, rivalInSlot, replacement } = await landAndSupersede(ws);

      const edges = await tensionEdges(ws);
      expect(
        edges,
        "an APPROVED `single` entry no longer licenses the anchor arm on the correction lane",
      ).toContainEqual({ from: replacement, to: anchorOnly });
      // The slot arm is unaffected by curation — it never depended on it.
      expect(edges).toContainEqual({ from: replacement, to: rivalInSlot });
      expect(edges).toHaveLength(2);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "⚠️ the gate reads the INCOMING claim's predicate, not the rival's",
    async () => {
      // The asymmetry a reader is most likely to get backwards, and the one
      // `cardinalitySingleSql("f", "$3")` encodes. Curating the VALUATION — the
      // rival's predicate — must not open the arm: the question the gate asks is
      // whether the slot the human corrected is single-valued, and the sweep's
      // `cardinalitySingleSql("a")` asks it of its driving side for the same
      // reason. Reading the rival's predicate would make the arm's licence
      // depend on a predicate nobody in this correction spoke about.
      const ws = "ws-anchor-wrong-side-curated";
      const declared = await declarePredicateCardinality(pool, ws, {
        predicateKey: slotKey(VALUATION, identityAlias),
        cardinality: "single",
        authoredBy: "curator-1",
      });
      expect(declared.ok).toBe(true);

      const { anchorOnly, replacement } = await landAndSupersede(ws);

      const edges = await tensionEdges(ws);
      expect(
        edges.some((e) => e.to === anchorOnly),
        "curating the RIVAL's predicate opened the anchor arm — the gate is reading the wrong side",
      ).toBe(false);
      // Still one edge, so the scan ran and the corpus was not empty.
      expect(edges).toHaveLength(1);
      expect(edges[0]?.from).toBe(replacement);
    },
    PG_TEST_TIMEOUT_MS,
  );
});
