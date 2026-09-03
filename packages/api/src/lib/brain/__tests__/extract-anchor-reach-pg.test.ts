/**
 * The extract lane's anchor arm, against LIVE Postgres (#5615).
 *
 * `extract-contract.ts`'s `toFactCandidates` declares `anchorReach:
 * "curated-only"` on every candidate. What that must mean at the database:
 *
 *   1. **The prohibition** — two claims sharing a subject and nothing else, each
 *      hinted `single` by the model, from different episodes, on predicates
 *      nobody has curated: NO edge between them. This is the staging demo
 *      corpus's shape (`had GMV in December 2024 of` beside `has return window
 *      of`, both about the company), reduced to one pair.
 *   2. **The exact slot is exempt** — the same guess still mints the edge
 *      between two values in ONE slot, with no curation anywhere. Asserted in
 *      the same workspace as case 1, off the same claims, so it cannot be
 *      satisfied by a different fixture: the bound is on the anchor arm, not on
 *      the scan.
 *   3. **The curation control** — curate the incoming claim's predicate and the
 *      anchor edge appears. Without this, case 1 is equally consistent with
 *      "the anchor arm is off for the extractor", which is a wider claim than
 *      the one made.
 *   4. **The gate reads the INCOMING side** — curating the RIVAL's predicate
 *      opens nothing.
 *
 * ## Why this needs real Postgres and cannot be a fake
 *
 * `reconcile.test.ts`'s store models the exact slot and nothing else, so it
 * cannot tell an anchor-only rival from an absent one. What the unit lane owns
 * is the DECLARATION (`extract.test.ts`: the candidate carries `curated-only`)
 * and the BIND (`$10 = false` leaves reconcile); what this file owns is what
 * the statement does with it.
 *
 * ## The claims go through `toFactCandidates`, not a hand-built candidate
 *
 * A candidate built in the test with `anchorReach: "curated-only"` written in
 * would prove reconcile honours the field — which `correction-anchor-reach-pg`
 * already proves — and nothing about the extractor. The seam under test is
 * that the extractor's OWN output carries the bound, so the model's answer is
 * shaped exactly as `llmFactExtractor` shapes it and handed to reconcile.
 *
 * Opt in locally with the same scratch database as its sibling brain suites —
 * this file creates and drops its OWN schema, so they share it safely:
 *   bun run db:up && export TEST_DATABASE_URL=postgresql://atlas:atlas@localhost:5433/brain_4771_scratch
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import { runMigrations } from "@atlas/api/lib/db/migrate";
import { MANAGED_AUTH_MIGRATIONS, _resetPool } from "@atlas/api/lib/db/internal";
import { identityAlias, identityVocabulary, slotKey } from "@atlas/api/lib/brain/identity";
import { reconcileFacts, type ReconcileEpisodeRef } from "@atlas/api/lib/brain/reconcile";
import { BRAIN_EXTRACTION_PRODUCER, toFactCandidates } from "@atlas/api/lib/brain/extract-contract";
import { declarePredicateCardinality } from "@atlas/api/lib/brain/cardinality";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;
const PG_TEST_TIMEOUT_MS = 60_000;

/** The demo corpus's shape, reduced to one pair. Subjects EQUAL — the anchor's
 *  first disjunct — so nothing here depends on the prefix test. */
const SUBJECT = "NovaMart";
const RETURN_WINDOW = "has return window of";
const GMV = "had GMV in December 2024 of";

describeIfPg("the extract lane's anchor arm (real Postgres, #5615)", () => {
  let pool: Pool;
  const schemaName = `brain_extract_anchor_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

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
    // Reconcile writes through the module-level pool, so it has to BE this
    // schema-scoped one for the test to exercise the real statement.
    _resetPool(pool);
  }, PG_TEST_TIMEOUT_MS);

  afterAll(async () => {
    _resetPool(null);
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await pool.end();
    }
  }, PG_TEST_TIMEOUT_MS);

  afterEach(async () => {
    await pool.query("DELETE FROM brain_edges");
    await pool.query("DELETE FROM brain_facts");
    await pool.query("DELETE FROM brain_episodes");
    await pool.query("DELETE FROM brain_predicate_cardinality");
  });

  /**
   * One episode per claim. The separate episode is not incidental: the anchor
   * arm flags a rival only from a DIFFERENT episode, so landing the claims in
   * one would make the prohibition pass for that reason instead of the one
   * under test.
   */
  async function insertEpisode(workspaceId: string, sourceId: string): Promise<ReconcileEpisodeRef> {
    const occurredAt = new Date("2026-06-21T09:00:00.000Z");
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO brain_episodes
         (workspace_id, source, source_id, source_actor, body, occurred_at, visible_to)
       VALUES ($1, 'slack', $2, 'U1', 'evidence', $3::timestamptz, ARRAY['org'])
       RETURNING id`,
      [workspaceId, sourceId, occurredAt.toISOString()],
    );
    const id = rows[0]?.id;
    if (id === undefined) throw new Error("seed: episode insert returned no id");
    return { id, workspaceId, source: "slack", sourceId, sourceActor: "U1", occurredAt, visibleTo: ["org"] };
  }

  /**
   * Land one claim the way the extractor lands it: the model's answer shaped by
   * `toFactCandidates`, hinted `single`, reconciled in its own episode. Returns
   * the fact id.
   */
  async function extract(workspaceId: string, predicate: string, object: string): Promise<string> {
    const episode = await insertEpisode(workspaceId, `${workspaceId}:${predicate}:${object}`);
    const candidates = toFactCandidates(
      [{ subject: SUBJECT, predicate, object, cardinality: "single" }],
      episode,
      "fake-model",
    );
    const report = await reconcileFacts({
      vocabulary: identityVocabulary,
      episode,
      candidates,
      producer: BRAIN_EXTRACTION_PRODUCER,
      extractedAt: new Date(),
    });
    const outcome = report.outcomes[0];
    if (outcome?.kind !== "created") {
      throw new Error(`expected created, got ${outcome?.kind ?? "nothing"} — every assertion below is vacuous`);
    }
    return outcome.factId;
  }

  /** Every `in-tension-with` edge in the workspace, as `(from, to)` fact ids. */
  async function tensionEdges(workspaceId: string): Promise<{ from: string | null; to: string | null }[]> {
    const { rows } = await pool.query<{ from_fact_id: string | null; to_fact_id: string | null }>(
      `SELECT from_fact_id, to_fact_id FROM brain_edges
        WHERE workspace_id = $1 AND edge_type = 'in-tension-with'
     ORDER BY created_at, id`,
      [workspaceId],
    );
    return rows.map((r) => ({ from: r.from_fact_id, to: r.to_fact_id }));
  }

  /**
   * The corpus shape: the GMV claim first, then the two return-window values.
   * The GMV claim shares the subject with both and a slot with neither.
   */
  async function landCorpus(workspaceId: string) {
    const gmv = await extract(workspaceId, GMV, "$1.9M");
    const thirtyDays = await extract(workspaceId, RETURN_WINDOW, "30 days from delivery");
    const fourteenDays = await extract(workspaceId, RETURN_WINDOW, "14 days from delivery");
    return { gmv, thirtyDays, fourteenDays };
  }

  it(
    "⭐ mints NO anchor-only edge between two hinted-single claims on uncurated predicates",
    async () => {
      // Case 1 — the prohibition. Both return-window claims are hinted `single`
      // and share the subject with the GMV claim from another episode; neither
      // predicate has a row in `brain_predicate_cardinality`.
      const ws = "ws-extract-uncurated";
      const { gmv, thirtyDays, fourteenDays } = await landCorpus(ws);

      const edges = await tensionEdges(ws);
      expect(
        edges.some((e) => e.to === gmv || e.from === gmv),
        "a return window was flagged against a GMV figure on an uncurated predicate — the extractor's guess is licensing the anchor arm",
      ).toBe(false);

      // Case 2 — the exact-slot control, in the SAME workspace off the SAME
      // claims. The guess is about this slot, and this slot keeps it.
      expect(
        edges,
        "the extractor lost its EXACT-SLOT edge — the bound was applied to the whole scan, not to the anchor arm",
      ).toContainEqual({ from: fourteenDays, to: thirtyDays });
      expect(edges).toHaveLength(1);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "⭐ …and an APPROVED `single` entry for the incoming predicate opens the arm",
    async () => {
      // Case 3 — the curation control. `declarePredicateCardinality` rather
      // than a raw INSERT, so a change to what the write path admits reaches
      // this suite instead of being routed around by the fixture.
      const ws = "ws-extract-curated";
      const declared = await declarePredicateCardinality(pool, ws, {
        predicateKey: slotKey(RETURN_WINDOW, identityAlias),
        cardinality: "single",
        authoredBy: "curator-1",
      });
      expect(declared.ok, "curating the predicate failed — the control proves nothing").toBe(true);

      const { gmv, thirtyDays, fourteenDays } = await landCorpus(ws);

      const edges = await tensionEdges(ws);
      // Each return-window claim reaches the GMV claim through the anchor arm,
      // licensed by the workspace's entry for ITS predicate.
      expect(edges).toContainEqual({ from: thirtyDays, to: gmv });
      expect(edges).toContainEqual({ from: fourteenDays, to: gmv });
      // The slot arm is unaffected by curation — it never depended on it.
      expect(edges).toContainEqual({ from: fourteenDays, to: thirtyDays });
      expect(edges).toHaveLength(3);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "⚠️ the gate reads the INCOMING claim's predicate, not the rival's",
    async () => {
      // Case 4. Curating the GMV predicate — the RIVAL's — must not license the
      // return-window claims' reach to it: the question the gate asks is
      // whether the slot being written is single-valued.
      const ws = "ws-extract-wrong-side-curated";
      const declared = await declarePredicateCardinality(pool, ws, {
        predicateKey: slotKey(GMV, identityAlias),
        cardinality: "single",
        authoredBy: "curator-1",
      });
      expect(declared.ok).toBe(true);

      const { gmv, thirtyDays, fourteenDays } = await landCorpus(ws);

      const edges = await tensionEdges(ws);
      expect(
        edges.some((e) => e.to === gmv || e.from === gmv),
        "curating the RIVAL's predicate opened the anchor arm — the gate is reading the wrong side",
      ).toBe(false);
      expect(edges).toEqual([{ from: fourteenDays, to: thirtyDays }]);
    },
    PG_TEST_TIMEOUT_MS,
  );
});
