/**
 * Real-Postgres falsification suite for #5113 — the two vocabulary-memory
 * bundle sections (`brain_vocabulary_proposal`, `brain_predicate_cardinality`).
 *
 * The two claims the issue requires falsifiable, each pinned here against the
 * ACTUAL SQL rather than a string-keyed fake:
 *
 *   1. A cutover PRESERVES a `rejected` proposal, and a re-run producer at the
 *      destination does NOT auto-approve (or even re-queue) what a human
 *      removed — #4507's failure must not return across a region boundary.
 *      The producer probe deliberately emits the pair REVERSED and in display
 *      form, because the rejection memory's whole design (the unordered
 *      generated pair + re-norming) is what stops a producer routing around a
 *      rejection that way.
 *
 *   2. A cardinality entry CANNOT land on a predicate the destination's
 *      vocabulary canonicalizes differently — it is refused with a visible
 *      per-row outcome, never silently re-keyed and never applied to the
 *      re-canonicalized slot.
 *
 * Plus the merge lattice both sections share: decisions outrank `pending`,
 * identical decisions skip, and contradictory decisions keep the destination's
 * and surface as `refused`.
 *
 * Skips cleanly when `TEST_DATABASE_URL` is unset. Opt in locally with:
 *   bun run db:up && export TEST_DATABASE_URL=postgresql://atlas:atlas@localhost:5432/atlas
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import { runMigrations } from "@atlas/api/lib/db/migrate";
import {
  MANAGED_AUTH_MIGRATIONS,
  _resetPool,
  type InternalPool,
} from "@atlas/api/lib/db/internal";
import { exportWorkspaceBundle } from "../export";
import { approveAliasEdge } from "@atlas/api/lib/brain/vocabulary";
import { proposeAliasEdge } from "@atlas/api/lib/brain/vocabulary-decide";
import {
  importBundle as importBundleWithCorrelationId,
  validateBundle,
} from "../../../api/routes/admin-migrate";
import type { ExportBundle, ImportResult } from "@useatlas/types";

/** `importBundle` with #5112's correlation token defaulted — the roundtrip suite's shim. */
type ImportBundleArgs = Parameters<typeof importBundleWithCorrelationId>;

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;
const PG_TEST_TIMEOUT_MS = 30_000;

const SOURCE_ORG = "org-5113-src";
/** Cutover into an empty destination — the preservation arm. */
const TARGET_EMPTY = "org-5113-tgt-empty";
/** A destination that already holds its own rows — the merge-lattice arm. */
const TARGET_HELD = "org-5113-tgt-held";
/** A destination whose vocabulary canonicalizes the arriving predicate away. */
const TARGET_ALIASED = "org-5113-tgt-aliased";
/** A destination that starts alias-free: the re-canonicalizing edge arrives IN the bundle. */
const TARGET_MERGE_ALIASED = "org-5113-tgt-merge-aliased";

describeIfPg("region migration preserves vocabulary memory (real Postgres, #5113)", () => {
  let pool: Pool;
  const schemaName = `migrate_vocab_memory_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;

  const importInto = async (
    bundle: ImportBundleArgs[1],
    orgId: string,
  ): Promise<ImportResult> => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await importBundleWithCorrelationId(
        client,
        bundle,
        orgId,
        "req-vocab-memory-pg",
      );
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  };

  beforeAll(async () => {
    pool = new Pool({
      connectionString: TEST_DB_URL,
      // Pin search_path at connection STARTUP so every pooled connection —
      // including the transaction clients above — sees the suite's schema
      // without racing an unawaited SET (the roundtrip suite's discipline).
      options: `-c search_path="${schemaName}"`,
    });
    const admin = new Pool({ connectionString: TEST_DB_URL });
    await admin.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
    await admin.end();
    await runMigrations(pool, { skip: MANAGED_AUTH_MIGRATIONS });

    // `proposeAliasEdge`'s default transaction runner reads the module pool.
    process.env.DATABASE_URL = TEST_DB_URL;
    _resetPool(pool as unknown as InternalPool, null);

    // ── Source org: the memory a human authored ──
    // A REJECTED warehouse-derived subject pair: the exact state whose loss
    // re-opens #4507 (the producer re-proposes it and auto-approves).
    await pool.query(
      `INSERT INTO brain_vocabulary_proposal
         (id, workspace_id, slot_position, from_norm, to_norm, directed, source_class,
          confidence, status, proposed_by, proposed_at, reviewed_by, reviewed_at)
       VALUES ('prop-5113-rejected', $1, 'subject', 'acme corp', 'acme corporation', TRUE,
               'warehouse_key', 0.99, 'rejected', 'producer:warehouse',
               '2026-07-01T00:00:00Z', 'user-reviewer', '2026-07-02T00:00:00Z')`,
      [SOURCE_ORG],
    );
    // A pending queue entry — travels, but must never outrank a decision.
    await pool.query(
      `INSERT INTO brain_vocabulary_proposal
         (id, workspace_id, slot_position, from_norm, to_norm, directed, source_class,
          confidence, status, proposed_by, proposed_at, reviewed_by, reviewed_at)
       VALUES ('prop-5113-pending', $1, 'predicate', 'ships to', 'delivers to', FALSE,
               'seam', 0.7, 'pending', 'producer:seam', '2026-07-03T00:00:00Z', NULL, NULL)`,
      [SOURCE_ORG],
    );
    // Cardinality decisions: an approved `single` (the supersession license),
    // and a rejected one (the producers' memory).
    await pool.query(
      `INSERT INTO brain_predicate_cardinality
         (workspace_id, predicate_key, cardinality, status, source_class,
          proposed_by, proposed_at, reviewed_by, reviewed_at)
       VALUES ($1, 'ships to', 'single', 'approved', 'human',
               'user-curator', '2026-07-01T00:00:00Z', 'user-curator', '2026-07-01T00:00:00Z'),
              ($1, 'billed monthly', 'single', 'rejected', 'correction_event',
               'producer:correction', '2026-07-02T00:00:00Z', 'user-reviewer', '2026-07-03T00:00:00Z')`,
      [SOURCE_ORG],
    );
    // Explicit budget: this hook runs the FULL migration set, which on a loaded
    // CI runner takes longer than bun's 5s default hook timeout — the sibling
    // roundtrip suite passes the same budget for the same reason. Without it the
    // hook is killed mid-`runMigrations`, the in-flight migration then fails
    // against the already-dropped scratch schema ("no schema has been selected
    // to create in"), and the suite reports as a flake rather than a timeout.
  }, PG_TEST_TIMEOUT_MS);

  afterAll(async () => {
    if (ORIGINAL_DATABASE_URL === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
    _resetPool(null, null);
    const admin = new Pool({ connectionString: TEST_DB_URL });
    await admin.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    await admin.end();
    await pool.end();
  });

  it(
    "exports both sections, and the exporter's own output validates",
    async () => {
      const bundle = await exportWorkspaceBundle(SOURCE_ORG, "vocab-memory-test");
      expect(bundle.manifest.counts.brainVocabularyProposals).toBe(2);
      expect(bundle.manifest.counts.brainPredicateCardinalities).toBe(2);

      const rejected = bundle.brainVocabularyProposals?.find((p) => p.status === "rejected");
      expect(rejected).toMatchObject({
        slotPosition: "subject",
        fromNorm: "acme corp",
        toNorm: "acme corporation",
        directed: true,
        sourceClass: "warehouse_key",
        status: "rejected",
        proposedBy: "producer:warehouse",
        // The review stamp travels VERBATIM — a re-stamped decision would
        // assert a reading the destination never took.
        reviewedBy: "user-reviewer",
        reviewedAt: "2026-07-02T00:00:00.000Z",
      });

      // The real exporter's output through the real validator, the roundtrip
      // suite's "one place they meet" discipline.
      const validated = validateBundle(JSON.parse(JSON.stringify(bundle)));
      expect(validated.ok).toBe(true);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "FALSIFICATION 1: a cutover preserves a rejected proposal, and a re-run producer does NOT re-queue or auto-approve what a human removed",
    async () => {
      const bundle = await exportWorkspaceBundle(SOURCE_ORG, "vocab-memory-test");
      const result = await importInto(bundle, TARGET_EMPTY);
      expect(result.brainVocabularyProposals).toEqual({
        imported: 2,
        skipped: 0,
        refused: 0,
        // #5533 — the payload array is part of the pinned shape, not an extra.
        // Nothing refused means nothing to carry, and `[]` here is a positive
        // statement of that rather than an absent field.
        refusalDetails: [],
      });

      const landed = await pool.query(
        `SELECT status, reviewed_by, reviewed_at, source_class FROM brain_vocabulary_proposal
          WHERE workspace_id = $1 AND slot_position = 'subject'
            AND pair_low = LEAST('acme corp', 'acme corporation')
            AND pair_high = GREATEST('acme corp', 'acme corporation')`,
        [TARGET_EMPTY],
      );
      expect(landed.rows).toHaveLength(1);
      expect(landed.rows[0].status).toBe("rejected");
      expect(landed.rows[0].reviewed_by).toBe("user-reviewer");

      // ── The producer re-runs at the destination ──
      // REVERSED direction and DISPLAY forms, deliberately: the unordered pair
      // identity plus `proposeAliasEdge`'s re-norming are what must stop a
      // producer routing around the rejection by re-spelling it.
      const outcome = await proposeAliasEdge(TARGET_EMPTY, {
        position: "subject",
        fromNorm: "Acme Corporation",
        toNorm: "Acme Corp",
        directed: true,
        sourceClass: "warehouse_key",
        confidence: 0.99,
        proposedBy: "producer:warehouse",
      });
      expect(outcome.kind).toBe("rejected");

      // Nothing was queued, nothing auto-approved: the pair still holds
      // exactly one row (the rejection) and the edge table holds nothing.
      const rows = await pool.query(
        `SELECT status FROM brain_vocabulary_proposal
          WHERE workspace_id = $1 AND slot_position = 'subject'`,
        [TARGET_EMPTY],
      );
      expect(rows.rows.map((r) => r.status)).toEqual(["rejected"]);
      const edges = await pool.query(
        `SELECT 1 FROM brain_vocabulary_edge WHERE workspace_id = $1`,
        [TARGET_EMPTY],
      );
      expect(edges.rows).toHaveLength(0);

      // Idempotent re-import: both rows are already-held decisions/entries.
      const second = await importInto(bundle, TARGET_EMPTY);
      expect(second.brainVocabularyProposals).toEqual({
        imported: 0,
        skipped: 2,
        refused: 0,
        refusalDetails: [],
      });
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "merge lattice: an arriving rejection lands over a pending row; a contradictory destination decision is kept and surfaced as refused",
    async () => {
      // The destination already holds: the subject pair PENDING (undecided
      // queue entry — the arriving rejection outranks it), and the predicate
      // pair APPROVED (a decision — the arriving pending must not touch it,
      // and a later contradictory decision must be refused).
      await pool.query(
        `INSERT INTO brain_vocabulary_proposal
           (id, workspace_id, slot_position, from_norm, to_norm, directed, source_class,
            confidence, status, proposed_by)
         VALUES ('prop-5113-held-pending', $1, 'subject', 'acme corporation', 'acme corp', FALSE,
                 'seam', 0.5, 'pending', 'producer:seam'),
                ('prop-5113-held-approved', $1, 'predicate', 'ships to', 'delivers to', TRUE,
                 'human', 1, 'approved', 'user-local')`,
        [TARGET_HELD],
      );

      const bundle = await exportWorkspaceBundle(SOURCE_ORG, "vocab-memory-test");
      const result = await importInto(bundle, TARGET_HELD);
      // rejected-over-pending applies (imported); arriving pending over the
      // destination's approved predicate pair is skipped (queue entries
      // re-derive; the decision stands).
      expect(result.brainVocabularyProposals).toEqual({
        imported: 1,
        skipped: 1,
        refused: 0,
        refusalDetails: [],
      });

      const subject = await pool.query(
        `SELECT status, reviewed_by, proposed_by FROM brain_vocabulary_proposal
          WHERE id = 'prop-5113-held-pending'`,
      );
      expect(subject.rows[0].status).toBe("rejected");
      // The decision's reviewer travels; the row keeps its own proposer —
      // no re-attribution.
      expect(subject.rows[0].reviewed_by).toBe("user-reviewer");
      expect(subject.rows[0].proposed_by).toBe("producer:seam");

      const predicate = await pool.query(
        `SELECT status FROM brain_vocabulary_proposal WHERE id = 'prop-5113-held-approved'`,
      );
      expect(predicate.rows[0].status).toBe("approved");

      // ── Contradiction: the destination's decision is kept, and the drop is
      // surfaced as `refused` rather than silently overwritten ──
      const contradicting: ExportBundle = JSON.parse(JSON.stringify(bundle));
      contradicting.brainVocabularyProposals = [
        {
          slotPosition: "predicate",
          fromNorm: "ships to",
          toNorm: "delivers to",
          directed: true,
          sourceClass: "human",
          confidence: 1,
          status: "rejected",
          proposedBy: "user-remote",
          proposedAt: "2026-07-05T00:00:00Z",
          reviewedBy: "user-remote",
          reviewedAt: "2026-07-05T00:00:00Z",
        },
      ];
      contradicting.brainPredicateCardinalities = [];
      contradicting.manifest.counts.brainVocabularyProposals = 1;
      contradicting.manifest.counts.brainPredicateCardinalities = 0;

      const refusedRun = await importInto(contradicting, TARGET_HELD);
      // #5533 — the refusal carries a PAYLOAD, not just a count. This is the
      // whole point of the slice: after cutover plus grace period the source's
      // own `brain_vocabulary_proposal` row is deleted, so if the counter were
      // the only durable artifact the dropped decision would exist nowhere.
      // Both sides' statuses are on it, because re-authoring here means
      // OVERTURNING the destination's decision and an operator cannot weigh
      // that from the arriving half alone.
      expect(refusedRun.brainVocabularyProposals).toEqual({
        imported: 0,
        skipped: 0,
        refused: 1,
        refusalDetails: [
          {
            slotPosition: "predicate",
            fromNorm: "ships to",
            toNorm: "delivers to",
            arrivingStatus: "rejected",
            existingStatus: "approved",
            // Verbatim from the source row — never re-stamped by this region.
            reviewedBy: "user-remote",
            reviewedAt: "2026-07-05T00:00:00Z",
            refusal: "contradictory-decision",
            reason: expect.stringContaining("contradicts the arriving one and is kept"),
          },
        ],
      });
      const still = await pool.query(
        `SELECT status FROM brain_vocabulary_proposal WHERE id = 'prop-5113-held-approved'`,
      );
      expect(still.rows[0].status).toBe("approved");
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "FALSIFICATION 2: a cardinality entry cannot land on a predicate the destination canonicalizes differently",
    async () => {
      // The destination's own human curated `ships to` → `delivers to` at the
      // predicate position, so its closure aliases the arriving entry's key
      // away. (`approveAliasEdge` recomputes the closure inside the same
      // transaction.)
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const approved = await approveAliasEdge(client, TARGET_ALIASED, {
          position: "predicate",
          fromNorm: "ships to",
          toNorm: "delivers to",
          approvedBy: "user-local",
        });
        expect(approved.ok).toBe(true);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }

      const bundle = await exportWorkspaceBundle(SOURCE_ORG, "vocab-memory-test");
      // Isolate the cardinality section: this arm is about the key screen, not
      // the proposal lattice.
      const isolated: ExportBundle = JSON.parse(JSON.stringify(bundle));
      isolated.brainVocabularyProposals = [];
      isolated.manifest.counts.brainVocabularyProposals = 0;

      const arriving = (isolated.brainPredicateCardinalities ?? []).find(
        (e) => e.predicateKey === "ships to",
      );
      const result = await importInto(isolated, TARGET_ALIASED);
      // `ships to` is re-canonicalized here → refused. `billed monthly` is not
      // aliased → its rejected memory lands.
      //
      // #5533 — and `canonicalHere` is what makes this arm's payload usable at
      // all. The recovery instruction is "re-author the decision against the
      // predicate this region holds", and the SOURCE region has no other way to
      // learn what that predicate is: the key it sent is the only one it knows.
      expect(result.brainPredicateCardinalities).toEqual({
        imported: 1,
        skipped: 0,
        refused: 1,
        refusalDetails: [
          {
            predicateKey: "ships to",
            arrivingCardinality: "single",
            arrivingStatus: "approved",
            // NULL by design: this arm refuses BEFORE consulting the key's own
            // row, because the key is not this region's slot and a row found
            // under it would describe a different predicate.
            existingCardinality: null,
            existingStatus: null,
            canonicalHere: "delivers to",
            reviewedBy: "user-curator",
            reviewedAt: arriving?.reviewedAt ?? null,
            refusal: "predicate-re-canonicalized",
            reason: expect.stringContaining(
              "canonicalizes the arriving predicate onto a different norm",
            ),
          },
        ],
      });

      // Refused means NOT landed on the arriving key, and NOT re-keyed onto
      // the destination's canonical form either — both would be the silent
      // supersession license the refusal exists to prevent.
      const keys = await pool.query(
        `SELECT predicate_key, status FROM brain_predicate_cardinality
          WHERE workspace_id = $1 ORDER BY predicate_key`,
        [TARGET_ALIASED],
      );
      expect(keys.rows).toEqual([{ predicate_key: "billed monthly", status: "rejected" }]);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "FALSIFICATION 2b: the screen reads the POST-MERGE closure — a re-canonicalizing edge arriving IN the bundle refuses the entry keyed on its from-norm",
    async () => {
      // The arm the section-9a-ii ordering exists for, and the one FALSIFICATION
      // 2 cannot pin: there the destination's alias PRE-EXISTS, so the closure
      // is identical before and after the edge merge and the test passes
      // whichever side of `mergeApprovedEdges` the screen runs on. Here the
      // destination starts alias-free and the bundle itself carries BOTH the
      // edge (`ships to` → `delivers to`) and a cardinality entry keyed on
      // `ships to` — the realizable source state, since nothing re-keys
      // `brain_predicate_cardinality` when an alias is approved at the source.
      // Run the screen BEFORE the merge (or against a pre-merge closure read)
      // and the stale entry lands verbatim; this test goes red exactly then.
      const bundle = await exportWorkspaceBundle(SOURCE_ORG, "vocab-memory-test");
      const withEdge: ExportBundle = JSON.parse(JSON.stringify(bundle));
      withEdge.brainVocabularyProposals = [];
      withEdge.manifest.counts.brainVocabularyProposals = 0;
      withEdge.brainVocabularyEdges = [
        {
          slotPosition: "predicate",
          fromNorm: "ships to",
          toNorm: "delivers to",
          approvedBy: "user-remote",
          approvedAt: "2026-07-04T00:00:00Z",
        },
      ];
      withEdge.manifest.counts.brainVocabularyEdges = 1;

      const result = await importInto(withEdge, TARGET_MERGE_ALIASED);
      // The edge lands first (the merge), and only then is the entry judged —
      // against the closure that edge just created: `ships to` is aliased away
      // here NOW, so its entry is refused; `billed monthly` is untouched and
      // its rejected memory lands.
      expect(result.brainVocabularyEdges).toMatchObject({ imported: 1, skipped: 0, refused: 0 });
      expect(result.brainPredicateCardinalities).toMatchObject({
        imported: 1,
        skipped: 0,
        refused: 1,
      });
      // #5533 — the payload names the norm the merge JUST created, not the one
      // the destination held when the import began. A screen reading a pre-merge
      // closure would still refuse (the counter is unchanged) but would have no
      // second norm to report, so this is the assertion that separates "refused"
      // from "refused for the right reason".
      expect(result.brainPredicateCardinalities.refusalDetails).toMatchObject([
        {
          predicateKey: "ships to",
          canonicalHere: "delivers to",
          refusal: "predicate-re-canonicalized",
        },
      ]);

      // The refused entry landed on NEITHER key — not the arriving `ships to`,
      // not the destination's new canonical `delivers to`.
      const keys = await pool.query(
        `SELECT predicate_key, status FROM brain_predicate_cardinality
          WHERE workspace_id = $1 ORDER BY predicate_key`,
        [TARGET_MERGE_ALIASED],
      );
      expect(keys.rows).toEqual([{ predicate_key: "billed monthly", status: "rejected" }]);

      // And the closure row the refusal was judged against really is the one
      // the merge wrote in this same transaction.
      const closure = await pool.query(
        `SELECT effective_target FROM brain_vocabulary_target
          WHERE workspace_id = $1 AND slot_position = 'predicate' AND norm = 'ships to'`,
        [TARGET_MERGE_ALIASED],
      );
      expect(closure.rows).toEqual([{ effective_target: "delivers to" }]);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "cardinality merge lattice: decisions outrank pending, contradictory decisions are refused, rejections agree regardless of declined value",
    async () => {
      const ORG = "org-5113-card-lattice";
      await pool.query(
        `INSERT INTO brain_predicate_cardinality
           (workspace_id, predicate_key, cardinality, status, source_class, proposed_by)
         VALUES ($1, 'ships to', 'multi', 'pending', 'correction_event', 'producer:correction'),
                ($1, 'billed monthly', 'multi', 'rejected', 'human', 'user-local')`,
        [ORG],
      );

      const bundle = await exportWorkspaceBundle(SOURCE_ORG, "vocab-memory-test");
      const isolated: ExportBundle = JSON.parse(JSON.stringify(bundle));
      isolated.brainVocabularyProposals = [];
      isolated.manifest.counts.brainVocabularyProposals = 0;

      const result = await importInto(isolated, ORG);
      // Arriving approved `single` for `ships to` beats the pending `multi`
      // (imported, the VALUE moves with the decision); arriving rejected
      // `single` for `billed monthly` meets a rejected `multi` — the same
      // decision in effect, whatever value each declined — so it skips.
      expect(result.brainPredicateCardinalities).toEqual({
        imported: 1,
        skipped: 1,
        refused: 0,
        refusalDetails: [],
      });

      const decided = await pool.query(
        `SELECT cardinality, status, reviewed_by, proposed_by FROM brain_predicate_cardinality
          WHERE workspace_id = $1 AND predicate_key = 'ships to'`,
        [ORG],
      );
      expect(decided.rows[0]).toMatchObject({
        cardinality: "single",
        status: "approved",
        reviewed_by: "user-curator",
        // The destination row keeps its own proposer — no re-attribution.
        proposed_by: "producer:correction",
      });

      // ── Contradiction: approved `multi` here vs arriving approved `single` ──
      const CONTRA_ORG = "org-5113-card-contra";
      await pool.query(
        `INSERT INTO brain_predicate_cardinality
           (workspace_id, predicate_key, cardinality, status, source_class, proposed_by, reviewed_by, reviewed_at)
         VALUES ($1, 'ships to', 'multi', 'approved', 'human', 'user-local', 'user-local', now())`,
        [CONTRA_ORG],
      );
      const contraResult = await importInto(isolated, CONTRA_ORG);
      expect(contraResult.brainPredicateCardinalities).toMatchObject({
        imported: 1, // billed monthly's rejection lands
        skipped: 0,
        refused: 1, // ships to: the destination's decision is kept
      });
      // #5533 — both sides' VALUES as well as both statuses, because on this
      // table a contradiction can be about the value alone (approved `single`
      // against approved `multi`) and a payload carrying only statuses would
      // report two agreeing decisions.
      expect(contraResult.brainPredicateCardinalities.refusalDetails).toMatchObject([
        {
          predicateKey: "ships to",
          arrivingCardinality: "single",
          arrivingStatus: "approved",
          existingCardinality: "multi",
          existingStatus: "approved",
          // Not the re-canonicalization arm: the key IS this region's slot here,
          // so there is no second norm to name.
          canonicalHere: null,
          reviewedBy: "user-curator",
          refusal: "contradictory-decision",
        },
      ]);
      const kept = await pool.query(
        `SELECT cardinality, status FROM brain_predicate_cardinality
          WHERE workspace_id = $1 AND predicate_key = 'ships to'`,
        [CONTRA_ORG],
      );
      expect(kept.rows[0]).toMatchObject({ cardinality: "multi", status: "approved" });
    },
    PG_TEST_TIMEOUT_MS,
  );
});
