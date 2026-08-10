/**
 * Real-Postgres round-trip for the v2 region-migration bundle (#4460):
 * seed every exported pillar for a source org → `exportWorkspaceBundle` →
 * `importBundle` into a target org on the same DB → assert row parity, FK
 * integrity, carve-out semantics (share token dropped, caches empty,
 * next_run_at/next_refresh_at recomputed, FTS regenerated) → re-import and
 * assert full idempotent skip.
 *
 * The mock-level suites (`export.test.ts`, `admin-migrate.test.ts`) pin
 * behavior against string-keyed fakes that can't catch a typo'd column name,
 * a bind-count mismatch, a missing JSON.stringify on a jsonb column, or an
 * FK-ordering mistake — this suite runs the ACTUAL SQL against the real
 * schema so that drift class fails in CI instead of during a live migration.
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
import { approveAliasEdge, recomputeEffectiveTargets } from "@atlas/api/lib/brain/vocabulary";
import { identityVocabulary } from "@atlas/api/lib/brain/identity";
import { reconcileFacts } from "@atlas/api/lib/brain/reconcile";
import {
  RegionImportUnkeyableError,
  RegionImportVocabularyTargetError,
  importBundle,
  validateBundle,
} from "../../../api/routes/admin-migrate";
import { PROVISIONAL_PREDICATE } from "@atlas/api/lib/brain/candidates";
import { buildCleanupStatements, runSourceCleanupSweep } from "../cleanup";
import type { ImportResult } from "@useatlas/types";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;
const PG_TEST_TIMEOUT_MS = 30_000;

const SOURCE_ORG = "org-migrate-src";
const TARGET_ORG = "org-migrate-tgt";

const CONV_ID = "11111111-1111-4111-8111-111111111111";
const DELETED_CONV_ID = "22222222-2222-4222-8222-222222222222";
const DASH_ID = "33333333-3333-4333-8333-333333333333";
const CARD_ID = "44444444-4444-4444-8444-444444444444";
const DOC_ID = "55555555-5555-4555-8555-555555555555";
const TASK_ID = "66666666-6666-4666-8666-666666666666";
// Company brain (#4767, ADR-0036).
const EPISODE_ID = "77777777-7777-4777-8777-777777777777";
const FACT_ID = "88888888-8888-4888-8888-888888888888";
const SUPERSEDED_FACT_ID = "99999999-9999-4999-8999-999999999999";
/** Carries a VALUE-TYPED `subject_cmp` — the only fixture the subject-position rule can fail against (#5035). */
const VALUE_SUBJECT_FACT_ID = "aaaaaaaa-5035-4000-8000-000000000003";

describeIfPg("region-migration bundle round-trip (real Postgres, #4460)", () => {
  let pool: Pool;
  const schemaName = `migrate_roundtrip_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;

  beforeAll(async () => {
    pool = new Pool({
      connectionString: TEST_DB_URL,
      // Pin search_path at connection STARTUP so every pooled connection —
      // including the transaction client `importBundle` runs on — sees the
      // suite's schema without racing an unawaited SET.
      options: `-c search_path="${schemaName}"`,
    });
    const admin = new Pool({ connectionString: TEST_DB_URL });
    await admin.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
    await admin.end();
    await runMigrations(pool, { skip: MANAGED_AUTH_MIGRATIONS });

    process.env.DATABASE_URL = TEST_DB_URL;
    _resetPool(pool as unknown as InternalPool, null);

    // ── Seed the source org: one row (at least) in every exported pillar ──
    await pool.query(
      `INSERT INTO conversations (id, user_id, title, surface, starred, org_id, created_at, updated_at)
       VALUES ($1, 'user-1', 'Roundtrip conversation', 'web', true, $2, '2026-05-01T00:00:00Z', '2026-05-02T00:00:00Z')`,
      [CONV_ID, SOURCE_ORG],
    );
    await pool.query(
      `INSERT INTO messages (conversation_id, role, content, created_at)
       VALUES ($1, 'user', '"hello"'::jsonb, '2026-05-01T00:00:00Z'),
              ($1, 'assistant', '"hi there"'::jsonb, '2026-05-01T00:00:01Z')`,
      [CONV_ID],
    );
    // A soft-deleted conversation with memory — must NOT travel.
    await pool.query(
      `INSERT INTO conversations (id, user_id, title, surface, org_id, deleted_at)
       VALUES ($1, 'user-1', 'Deleted', 'web', $2, now())`,
      [DELETED_CONV_ID, SOURCE_ORG],
    );
    await pool.query(
      `INSERT INTO agent_session_memory (conversation_id, org_id, namespace, value)
       VALUES ($1, $3, 'scratchpad', '{"note":"weekly grain"}'::jsonb),
              ($2, $3, 'scratchpad', '{"note":"should not travel"}'::jsonb)`,
      [CONV_ID, DELETED_CONV_ID, SOURCE_ORG],
    );
    await pool.query(
      `INSERT INTO semantic_entities (org_id, entity_type, name, yaml_content, connection_group_id)
       VALUES ($1, 'entity', 'users', 'table: users', 'g-prod')`,
      [SOURCE_ORG],
    );
    await pool.query(
      `INSERT INTO learned_patterns (org_id, pattern_sql, description, confidence, status, auto_promoted)
       VALUES ($1, 'SELECT COUNT(*) FROM users', 'User count', 0.9, 'approved', false)`,
      [SOURCE_ORG],
    );
    await pool.query(
      `INSERT INTO settings (key, value, org_id) VALUES ('theme', 'dark', $1)`,
      [SOURCE_ORG],
    );
    await pool.query(
      `INSERT INTO dashboards (id, org_id, owner_id, title, description, share_token, share_mode,
                               refresh_schedule, next_refresh_at, parameters, first_published_at)
       VALUES ($1, $2, 'user-1', 'Revenue', 'MRR overview', 'tok-source-region', 'org',
               '0 8 * * *', now(), '[{"key":"region","type":"string"}]'::jsonb, '2026-06-01T00:00:00Z')`,
      [DASH_ID, SOURCE_ORG],
    );
    await pool.query(
      `INSERT INTO dashboard_cards (id, dashboard_id, position, title, sql, chart_config, annotations,
                                    connection_group_id, layout, cached_columns, cached_rows, cached_at)
       VALUES ($1, $2, 0, 'MRR', 'SELECT 1', '{"type":"line"}'::jsonb, '[{"x":"2026-06-01","label":"launch"}]'::jsonb,
               'g-prod', '{"x":0,"y":0,"w":6,"h":4}'::jsonb, '["a"]'::jsonb, '[{"a":1}]'::jsonb, now())`,
      [CARD_ID, DASH_ID],
    );
    await pool.query(
      `INSERT INTO dashboard_user_drafts (user_id, dashboard_id, draft, baseline, published_baseline_at)
       VALUES ('user-2', $1, '{"title":"Revenue (wip)","cards":[]}'::jsonb,
               '{"title":"Revenue","cards":[]}'::jsonb, '2026-06-01T00:00:00Z')`,
      [DASH_ID],
    );
    await pool.query(
      `INSERT INTO knowledge_documents (id, workspace_id, collection_id, path, type, title, tags, body, status)
       VALUES ($1, $2, 'handbook', 'policies/refunds.md', 'guide', 'Refund policy',
               '["policy"]'::jsonb, '# Refunds body text', 'draft')`,
      [DOC_ID, SOURCE_ORG],
    );
    await pool.query(
      `INSERT INTO knowledge_links (source_document_id, target_path, anchor_text)
       VALUES ($1, 'policies/returns.md', 'returns')`,
      [DOC_ID],
    );
    await pool.query(
      `INSERT INTO scheduled_tasks (id, owner_id, org_id, name, question, cron_expression, delivery_channel,
                                    recipients, connection_group_id, approval_mode, enabled, last_run_at, next_run_at)
       VALUES ($1, 'user-1', $2, 'Weekly revenue', 'What was revenue last week?', '0 9 * * 1', 'email',
               '["ops@example.com"]'::jsonb, 'g-prod', 'auto', true, now(), now())`,
      [TASK_ID, SOURCE_ORG],
    );

    // ── Company brain (#4767, ADR-0036) ──
    // One episode carrying TWO facts: a live published one and a superseded,
    // tombstoned one. The retracted fact is the interesting case — it proves
    // invalidate-never-delete survives the hop, so an as-of read in the
    // target still answers "what we believed on Monday" correctly. An export
    // that quietly dropped invalidated rows would look perfectly healthy.
    await pool.query(
      `INSERT INTO brain_episodes (id, workspace_id, source, source_id, source_actor, body,
                                   occurred_at, extracted_at, visible_to)
       VALUES ($1, $2, 'slack', 'C123/1700000000.1', 'U-alice', 'Pricing moved to $49/seat.',
               '2026-06-01T00:00:00Z', '2026-06-01T00:05:00Z', ARRAY['org', 'audience:eng'])`,
      [EPISODE_ID, SOURCE_ORG],
    );
    // The identity columns (#5035, ADR-0037 §8) are seeded with values chosen to
    // be UN-DERIVABLE from the surfaces beside them, which is the only way a
    // carry can be told from a re-derive:
    //
    //   `object_key = 'forty nine'` over the object `'49'`. Under §8's carry the
    //   target holds `forty nine`; under any re-derive it holds `49`. No
    //   vocabulary in either region can produce the former from the latter, so
    //   the assertion has exactly one passing implementation.
    //
    //   `predicate_key = 'unit price'` is the vocabulary's answer for
    //   `price per seat` in NEITHER region — it is what the seeded alias chain
    //   maps `is priced at` to. It travels anyway, which is the accepted
    //   under-match §8 names: a key the destination cannot explain, colliding
    //   with nothing until a human curates.
    //
    // `object_cmp = 'money:USD:49'` is region-invariant and must SURVIVE;
    // `subject_cmp = 'entity:…'` is a store-local id and must be NULLED. The two
    // ride the same INSERT, so the null-out is provably a decision rather than a
    // writer that never fills the column.
    await pool.query(
      `INSERT INTO brain_facts (id, workspace_id, subject, predicate, object, valid_from,
                                ingested_at, extracted_at, source_episode_id, provenance,
                                status, visible_to, pre_widening_visible_to,
                                predicate_cardinality,
                                subject_key, predicate_key, object_key,
                                subject_cmp, object_cmp)
       VALUES ($1, $2, 'acme:pro-plan', 'price_per_seat', '49',
               '2026-06-01T00:00:00Z', '2026-06-01T00:05:00Z', '2026-06-01T00:05:00Z', $3,
               '{"actor":"U-alice","episode":"C123/1700000000.1"}'::jsonb,
               'published', ARRAY['org'], ARRAY['audience:chat-channel:slack:C-FOUNDERS'],
               'single',
               'acme:pro plan', 'unit price', 'forty nine',
               'entity:01JSRCSUBJECT7X', 'money:USD:49')`,
      [FACT_ID, SOURCE_ORG, EPISODE_ID],
    );
    // The tombstoned twin carries an entity-tagged OBJECT comparable — the
    // destructive position. A foreign id here is `different` under
    // `comparableDifferentSql`, which is the arm that becomes
    // `supersessionCollisionJoin`, so carrying it verbatim is what would let a
    // destination draft about the same real entity stamp `valid_to`.
    await pool.query(
      `INSERT INTO brain_facts (id, workspace_id, subject, predicate, object, valid_from, valid_to,
                                ingested_at, invalidated_at, source_episode_id, provenance,
                                status, visible_to, predicate_cardinality,
                                subject_key, predicate_key, object_key, object_cmp)
       VALUES ($1, $2, 'acme:pro-plan', 'price_per_seat', '39',
               '2026-01-01T00:00:00Z', '2026-06-01T00:00:00Z',
               '2026-01-01T00:00:00Z', '2026-06-01T00:00:00Z', $3,
               '{"actor":"U-bob"}'::jsonb, 'published', ARRAY['org'], 'single',
               'acme:pro plan', 'unit price', 'thirty nine', 'entity:01JSRCOBJECT7X')`,
      [SUPERSEDED_FACT_ID, SOURCE_ORG, EPISODE_ID],
    );
    // ⚠️ A VALUE-TYPED `subject_cmp`, and it is the only fixture that makes the
    // subject-position rule falsifiable (#5035, panel round 1). Every other fact
    // here carries `entity:` or NULL at the subject, so `subjectCmp: null`
    // hardcoded in the importer and the shipped tag rule are the same program —
    // the rule would be asserted nowhere.
    //
    // This region's own `subjectComparableValue` cannot produce this value, and
    // that is exactly the point: the importer re-admits values ANOTHER region or
    // a later release wrote, and what makes that safe is the TAG, not the
    // position. ADR-0037 §8 says so in as many words — *"the rule is stated by
    // tag rather than by position so the two cannot drift about what a
    // store-local id is"* — and a rule stated only in prose is not a rule.
    await pool.query(
      `INSERT INTO brain_facts (id, workspace_id, subject, predicate, object, valid_from,
                                ingested_at, source_episode_id, provenance,
                                status, visible_to,
                                subject_key, predicate_key, object_key, subject_cmp)
       VALUES ($1, $2, 'acme:seat-count', 'billed_at', '12',
               '2026-06-01T00:00:00Z', '2026-06-01T00:05:00Z', $3,
               '{"actor":"U-carol"}'::jsonb, 'draft', ARRAY['org'],
               'acme:seat count', 'billed at', 'twelve', 'number:7')`,
      [VALUE_SUBJECT_FACT_ID, SOURCE_ORG, EPISODE_ID],
    );
    await pool.query(
      `INSERT INTO brain_edges (workspace_id, edge_type, from_fact_id, to_fact_id)
       VALUES ($1, 'supersedes', $2, $3)`,
      [SOURCE_ORG, FACT_ID, SUPERSEDED_FACT_ID],
    );
    await pool.query(
      `INSERT INTO brain_edges (workspace_id, edge_type, from_fact_id, to_episode_id)
       VALUES ($1, 'provenance', $2, $3)`,
      [SOURCE_ORG, FACT_ID, EPISODE_ID],
    );
    await pool.query(
      `INSERT INTO fact_audience_member (workspace_id, audience_id, user_id, source)
       VALUES ($1, 'eng', 'user-1', 'slack')`,
      [SOURCE_ORG],
    );

    // ── The curated identity vocabulary (#5022, ADR-0037 §6/§8) ──
    // A COMPRESSED chain, which is the only shape that can tell "the closure
    // was recomputed" from "the closure was copied": the bundle carries no
    // closure section at all, so `is priced at` can only land on `unit price`
    // in the target if the importer walked the two edges itself. A flat
    // one-edge vocabulary would round-trip identically under both designs.
    await pool.query(
      `INSERT INTO brain_vocabulary_edge (workspace_id, slot_position, from_norm, to_norm, approved_by)
       VALUES ($1, 'predicate', 'is priced at', 'priced at', 'user-1'),
              ($1, 'predicate', 'priced at', 'unit price', NULL)`,
      [SOURCE_ORG],
    );
    // In a transaction, because `recomputeEffectiveTargets` now refuses to run
    // outside one — its clear-then-rebuild is not atomic on an autocommit
    // connection, and a failed rebuild would commit an empty closure.
    const seedClient = await pool.connect();
    try {
      await seedClient.query("BEGIN");
      await recomputeEffectiveTargets(seedClient, SOURCE_ORG, "predicate");
      await seedClient.query("COMMIT");
    } finally {
      seedClient.release();
    }
  }, PG_TEST_TIMEOUT_MS);

  afterAll(async () => {
    _resetPool(null, null);
    if (ORIGINAL_DATABASE_URL === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
    const admin = new Pool({ connectionString: TEST_DB_URL });
    await admin.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`).catch((err) => {
      console.error(
        `migrate-roundtrip-pg: DROP SCHEMA cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
    await admin.end();
    await pool.end();
  });

  /** Run `importBundle` for TARGET_ORG inside a committed transaction. */
  async function runImport(bundle: Awaited<ReturnType<typeof exportWorkspaceBundle>>): Promise<ImportResult> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await importBundle(client, bundle, TARGET_ORG);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  it(
    "exports every pillar, imports into the target org with FK integrity, and re-imports idempotently",
    async () => {
      // ── Export: counts reflect the seeded source org ──
      const bundle = await exportWorkspaceBundle(SOURCE_ORG, "roundtrip-test");

      // ⚠️ The ONE place a real exporter's output meets the validator. Every
      // other test on both sides hand-builds its bundle, so an exporter that
      // stopped emitting a field the validator requires would be caught by
      // neither: `runImport` below calls `importBundle` directly. Cheap, and it
      // is the seam a live cutover actually runs.
      expect(validateBundle(bundle as unknown).ok).toBe(true);
      expect(bundle.manifest.counts).toEqual({
        conversations: 1, // the soft-deleted conversation is excluded
        messages: 2,
        semanticEntities: 1,
        learnedPatterns: 1,
        settings: 1,
        dashboards: 1,
        dashboardCards: 1,
        dashboardUserDrafts: 1,
        knowledgeDocuments: 1,
        knowledgeLinks: 1,
        scheduledTasks: 1,
        agentSessionMemory: 1, // the deleted conversation's slot is excluded
        brainEpisodes: 1,
        // The live claim, the superseded/tombstoned one, and the fact whose
        // `subject_cmp` is VALUE-typed (#5035's subject-position falsifier).
        brainFacts: 3,
        brainEdges: 2,
        factAudienceMembers: 1,
        // The approved edges only. There is no `brainVocabularyTargets` count
        // because the derived closure does not ride the bundle — §8 has the
        // import recompute it, and the assertion below is what proves it did.
        brainVocabularyEdges: 2,
      });

      // ── Simulate the cross-region hop on one DB: preserved UUIDs would
      // collide with the still-present source rows, so remove them first —
      // exactly what the #4458 source cleanup does after the grace period.
      await pool.query(`DELETE FROM conversations WHERE org_id = $1`, [SOURCE_ORG]); // cascades messages + memory
      await pool.query(`DELETE FROM dashboards WHERE org_id = $1`, [SOURCE_ORG]); // cascades cards + drafts
      await pool.query(`DELETE FROM knowledge_documents WHERE workspace_id = $1`, [SOURCE_ORG]); // cascades links
      await pool.query(`DELETE FROM scheduled_tasks WHERE org_id = $1`, [SOURCE_ORG]);
      // Brain: facts before episodes — brain_facts.source_episode_id is the
      // one RESTRICT FK here (evidence can't vanish under a live claim). The
      // edge delete is belt-and-braces: those FKs CASCADE, so the rows are
      // already gone once their endpoints are.
      await pool.query(`DELETE FROM brain_edges WHERE workspace_id = $1`, [SOURCE_ORG]);
      await pool.query(`DELETE FROM brain_facts WHERE workspace_id = $1`, [SOURCE_ORG]);
      await pool.query(`DELETE FROM brain_episodes WHERE workspace_id = $1`, [SOURCE_ORG]);
      await pool.query(`DELETE FROM fact_audience_member WHERE workspace_id = $1`, [SOURCE_ORG]);
      await pool.query(`DELETE FROM semantic_entities WHERE org_id = $1`, [SOURCE_ORG]);
      await pool.query(`DELETE FROM learned_patterns WHERE org_id = $1`, [SOURCE_ORG]);
      await pool.query(`DELETE FROM settings WHERE org_id = $1`, [SOURCE_ORG]);

      // ── Import: real INSERTs against the real schema ──
      const result = await runImport(bundle);
      expect(result.conversations).toEqual({ imported: 1, skipped: 0 });
      expect(result.semanticEntities).toEqual({ imported: 1, skipped: 0 });
      expect(result.learnedPatterns).toEqual({ imported: 1, skipped: 0 });
      expect(result.settings).toEqual({ imported: 1, skipped: 0 });
      expect(result.dashboards).toEqual({ imported: 1, skipped: 0 });
      expect(result.knowledgeDocuments).toEqual({ imported: 1, skipped: 0 });
      expect(result.scheduledTasks).toEqual({ imported: 1, skipped: 0 });
      expect(result.agentSessionMemory).toEqual({ imported: 1, skipped: 0 });
      expect(result.brainEpisodes).toEqual({ imported: 1, skipped: 0 });
      expect(result.brainFacts).toEqual({ imported: 3, skipped: 0 });
      expect(result.brainEdges).toEqual({ imported: 2, skipped: 0 });
      expect(result.factAudienceMembers).toEqual({ imported: 1, skipped: 0 });
      expect(result.brainVocabularyEdges).toEqual({ imported: 2, skipped: 0, refused: 0 });

      // The vocabulary's closure is REBUILT in the target, not carried. Nothing
      // in the bundle says `is priced at` resolves to `unit price` — the export
      // ships two edges and no closure — so this row exists only if the importer
      // walked the compressed chain itself. A copy-the-closure importer would
      // leave the target with an EMPTY `brain_vocabulary_target`, and every
      // claim keyed there would silently key onto the un-aliased norm.
      const targetClosure = await pool.query<{ norm: string; effective_target: string }>(
        `SELECT norm, effective_target FROM brain_vocabulary_target
          WHERE workspace_id = $1 AND slot_position = 'predicate'
          ORDER BY norm`,
        [TARGET_ORG],
      );
      expect(targetClosure.rows).toEqual([
        { norm: "is priced at", effective_target: "unit price" },
        { norm: "priced at", effective_target: "unit price" },
      ]);

      // The APPROVER and the decision time survive verbatim. Counts and the
      // closure alone leave both unpinned, and migration 0189 calls
      // `approved_by` "the one column an audit of a workspace-wide re-key reads
      // first" — an import that nulled it, or stamped `now()`, would pass every
      // other assertion in this block. The NULL row is the auto-approved case
      // and is why the fixture seeds one of each.
      const targetEdges = await pool.query<{
        from_norm: string;
        approved_by: string | null;
        approved_at: Date;
      }>(
        `SELECT from_norm, approved_by, approved_at FROM brain_vocabulary_edge
          WHERE workspace_id = $1 ORDER BY from_norm`,
        [TARGET_ORG],
      );
      expect(targetEdges.rows.map((r) => [r.from_norm, r.approved_by])).toEqual([
        ["is priced at", "user-1"],
        ["priced at", null],
      ]);
      const sourceEdges = await pool.query<{ from_norm: string; approved_at: Date }>(
        `SELECT from_norm, approved_at FROM brain_vocabulary_edge
          WHERE workspace_id = $1 ORDER BY from_norm`,
        [SOURCE_ORG],
      );
      expect(targetEdges.rows.map((r) => r.approved_at.toISOString())).toEqual(
        sourceEdges.rows.map((r) => r.approved_at.toISOString()),
      );

      // The brain survives the hop INTACT — not just row counts, but every
      // property that makes a fact trustworthy. A migration that moved the
      // rows while dropping the grant or the provenance would pass a count
      // assertion and quietly publish private claims in the target region.
      const brainFact = await pool.query<{
        object: string;
        status: string;
        visible_to: string[];
        pre_widening_visible_to: string[] | null;
        provenance: Record<string, unknown>;
        predicate_cardinality: string;
        invalidated_at: Date | null;
        source_episode_id: string;
      }>(
        `SELECT object, status, visible_to, pre_widening_visible_to, provenance,
                predicate_cardinality, invalidated_at, source_episode_id
           FROM brain_facts WHERE id = $1 AND workspace_id = $2`,
        [FACT_ID, TARGET_ORG],
      );
      expect(brainFact.rows).toHaveLength(1);
      expect(brainFact.rows[0].object).toBe("49");
      expect(brainFact.rows[0].status).toBe("published");
      expect(brainFact.rows[0].visible_to).toEqual(["org"]);
      // BOTH grants travel, not just the live one (#4836). `visible_to` gates
      // the CLAIM; `pre_widening_visible_to` gates its ATTRIBUTION, and it
      // cannot be reconstructed in the target region — the import writes
      // `status` verbatim, so the fact never re-publishes and the widening
      // UPDATE that is its only writer never runs again. Drop it from the
      // bundle and every widened fact lands reading as never-widened, which
      // discloses its first episode's actor, channel and timestamp to the
      // whole org: #4836's exact leak, restored by a supported path, silently.
      expect(brainFact.rows[0].pre_widening_visible_to).toEqual([
        "audience:chat-channel:slack:C-FOUNDERS",
      ]);
      // Verbatim, plus exactly one key: `provisional`, written by the
      // `jsonb_set` in the import statement because this row's `subject_cmp`
      // was a store-local id and got nulled (#5035 — asserted properly below,
      // where the null-out itself is). A whole-object equality rather than
      // `toMatchObject`, so a producer key dropped on the way through is
      // visible.
      expect(brainFact.rows[0].provenance).toEqual({
        actor: "U-alice",
        episode: "C123/1700000000.1",
        provisional: true,
      });
      // ⚠️ `predicate_cardinality` does NOT travel on v3, and the source row
      // says `single`. #5027 moved cardinality onto the canonical predicate and
      // the per-row values are LLM guesses, so honouring one here would restore
      // a guess as though it were a curated decision. The column falls to its
      // schema default — `multi`, the conservative arm, since coexisting is
      // recoverable and wrongly superseding destroys a belief — and #5028 drops
      // it. Asserted as the exact value rather than left unchecked: "the field
      // was removed from the bundle" and "the field is silently still being
      // written" both pass a `toBeDefined`.
      expect(brainFact.rows[0].predicate_cardinality).toBe("multi");
      // FK re-resolved against the imported episode, UUID preserved.
      expect(brainFact.rows[0].source_episode_id).toBe(EPISODE_ID);

      // ── Identity: keys carried verbatim, store-local ids nulled (#5035) ──
      //
      // Read against what the BUNDLE carried rather than against literals, so
      // the claim is "these bytes are the ones that left the other region"
      // rather than "these bytes match what this test also wrote". (The source
      // rows are deleted above, on purpose — the import must not be able to
      // reach them.) The seeded `object_key` — `forty nine`, over the object
      // `49` — is un-derivable from any surface in play, so a re-deriving
      // importer cannot satisfy this whatever vocabulary it consults.
      const wireFact = bundle.brainEpisodes!.find((e) => e.id === EPISODE_ID)!
        .facts.find((f) => f.id === FACT_ID)!;
      const targetIdentity = (
        await pool.query<Record<string, string | null>>(
          `SELECT subject_key, predicate_key, object_key, subject_cmp, object_cmp
             FROM brain_facts WHERE id = $1 AND workspace_id = $2`,
          [FACT_ID, TARGET_ORG],
        )
      ).rows[0]!;

      expect(targetIdentity.subject_key).toBe(wireFact.subjectKey!);
      expect(targetIdentity.predicate_key).toBe(wireFact.predicateKey!);
      expect(targetIdentity.object_key).toBe(wireFact.objectKey!);
      // Spelled out as well, because "target equals wire" also holds if BOTH
      // are null — which is the pre-#5035 behaviour this slice replaces.
      expect(targetIdentity.object_key).toBe("forty nine");

      // THE falsification target: an imported store-local id is NULL, with the
      // value-typed sibling on the SAME row proving the writer does fill the
      // column. Without that control, "NULL" is satisfied by an importer that
      // never writes either `_cmp` at all.
      //
      // The wire assertion is what makes the null a DECISION rather than an
      // exporter that never sent the value.
      expect(wireFact.subjectCmp).toBe("entity:01JSRCSUBJECT7X");
      expect(targetIdentity.subject_cmp).toBeNull();
      expect(wireFact.objectCmp).toBe("money:USD:49");
      expect(targetIdentity.object_cmp).toBe("money:USD:49");

      // …and at the OBJECT, which is the destructive position: a foreign id
      // there is non-null, same-tagged and unequal to every id this region
      // mints, so `comparableDifferentSql` reads it as PROVEN DIFFERENT and the
      // publish gate stamps `valid_to` on it without a human.
      const supersededWire = bundle.brainEpisodes!.find((e) => e.id === EPISODE_ID)!
        .facts.find((f) => f.id === SUPERSEDED_FACT_ID)!;
      expect(supersededWire.objectCmp).toBe("entity:01JSRCOBJECT7X");
      const supersededIdentity = (
        await pool.query<{ object_key: string | null; object_cmp: string | null }>(
          `SELECT object_key, object_cmp FROM brain_facts WHERE id = $1 AND workspace_id = $2`,
          [SUPERSEDED_FACT_ID, TARGET_ORG],
        )
      ).rows[0]!;
      expect(supersededIdentity.object_cmp).toBeNull();
      expect(supersededIdentity.object_key).toBe("thirty nine");

      // The tombstoned twin is `provisional` too — the marker's one job, *this
      // row's comparable value is worth recomputing*, and what makes the
      // null-out recoverable rather than merely safe. `PROVISIONAL_PREDICATE`
      // reads it with `jsonb_exists`, so the key's PRESENCE is what matters.
      const supersededProvenance = await pool.query<{ provenance: Record<string, unknown> }>(
        `SELECT provenance FROM brain_facts WHERE id = $1 AND workspace_id = $2`,
        [SUPERSEDED_FACT_ID, TARGET_ORG],
      );
      expect(supersededProvenance.rows[0].provenance).toEqual({
        actor: "U-bob",
        provisional: true,
      });

      // ⚠️ The rule is keyed on the TAG, not on the position — asserted at the
      // subject, which is the only place it can fail. A value-typed
      // `subject_cmp` must SURVIVE. Without this fixture, `subjectCmp: null`
      // hardcoded in the importer passes every other assertion in this file:
      // every other fact carries `entity:` or NULL there.
      const valueSubject = (
        await pool.query<{ subject_cmp: string | null; provenance: Record<string, unknown> }>(
          `SELECT subject_cmp, provenance FROM brain_facts WHERE id = $1 AND workspace_id = $2`,
          [VALUE_SUBJECT_FACT_ID, TARGET_ORG],
        )
      ).rows[0]!;
      expect(valueSubject.subject_cmp).toBe("number:7");
      // …and it is NOT provisional: nothing was dropped from this row, so there
      // is nothing worth recomputing.
      expect(valueSubject.provenance).toEqual({ actor: "U-carol" });

      // The marker is read through the QUERY that consumes it, not only as a
      // JSON key. The writer spells `jsonb_set(…, '{provisional}', …)` and the
      // reader spells `jsonb_exists(f.provenance, 'provisional')` — two
      // spellings of one contract, and nothing else compares them. Exactly the
      // two rows whose comparable value was dropped.
      const provisionalRows = await pool.query<{ id: string }>(
        `SELECT f.id::text AS id FROM brain_facts f
          WHERE f.workspace_id = $1 AND ${PROVISIONAL_PREDICATE}
          ORDER BY f.id`,
        [TARGET_ORG],
      );
      expect(provisionalRows.rows.map((r) => r.id).sort()).toEqual(
        [FACT_ID, SUPERSEDED_FACT_ID].sort(),
      );

      // Invalidate-never-delete survives: the tombstoned claim is still here,
      // still carrying the instant it stopped being true. Asserted as the
      // EXACT instant, not merely non-null — an importer that stamped
      // `new Date()` instead of forwarding the source value would pass a
      // non-null check while silently rewriting bi-temporal history.
      const superseded = await pool.query<{
        invalidated_at: Date | null;
        valid_to: Date | null;
        pre_widening_visible_to: string[] | null;
      }>(
        `SELECT invalidated_at, valid_to, pre_widening_visible_to
           FROM brain_facts WHERE id = $1 AND workspace_id = $2`,
        [SUPERSEDED_FACT_ID, TARGET_ORG],
      );
      expect(superseded.rows).toHaveLength(1);
      expect(superseded.rows[0].invalidated_at?.toISOString()).toBe("2026-06-01T00:00:00.000Z");
      expect(superseded.rows[0].valid_to?.toISOString()).toBe("2026-06-01T00:00:00.000Z");
      // The negative for the assertion above: this fact was never widened, and
      // must arrive NULL rather than inheriting a grant from anywhere. NULL is
      // what the read path treats as "disclose", so an importer that
      // defaulted it to the live grant would withhold attribution across the
      // whole imported corpus — the opposite failure, equally silent.
      expect(superseded.rows[0].pre_widening_visible_to).toBeNull();

      // The episode's grant (including its audience arm) and its extraction
      // stamp travel — the latter so the target doesn't re-queue an episode a
      // human already reviewed.
      const episode = await pool.query<{ visible_to: string[]; extracted_at: Date | null }>(
        `SELECT visible_to, extracted_at FROM brain_episodes WHERE id = $1 AND workspace_id = $2`,
        [EPISODE_ID, TARGET_ORG],
      );
      expect(episode.rows[0].visible_to).toEqual(["org", "audience:eng"]);
      // Exact instant: a re-stamped extracted_at is indistinguishable from a
      // correct one under a non-null check, and it silently re-queues an
      // episode a human already reviewed.
      expect(episode.rows[0].extracted_at?.toISOString()).toBe("2026-06-01T00:05:00.000Z");

      // Audience membership moved, so the `audience:eng` grant still resolves
      // to a real person rather than denying everyone.
      const audience = await pool.query(
        `SELECT 1 FROM fact_audience_member
          WHERE workspace_id = $1 AND audience_id = 'eng' AND user_id = 'user-1'`,
        [TARGET_ORG],
      );
      expect(audience.rowCount).toBe(1);

      // Both edge shapes re-resolved: fact→fact and fact→episode.
      const edges = await pool.query<{ edge_type: string; to_fact_id: string | null; to_episode_id: string | null }>(
        `SELECT edge_type, to_fact_id, to_episode_id FROM brain_edges
          WHERE workspace_id = $1 ORDER BY edge_type ASC`,
        [TARGET_ORG],
      );
      expect(edges.rows).toHaveLength(2);
      expect(edges.rows[0].edge_type).toBe("provenance");
      expect(edges.rows[0].to_episode_id).toBe(EPISODE_ID);
      expect(edges.rows[1].edge_type).toBe("supersedes");
      expect(edges.rows[1].to_fact_id).toBe(SUPERSEDED_FACT_ID);

      // UUIDs preserved; carve-outs enforced on the dashboard row.
      const dash = await pool.query(
        `SELECT share_token, share_mode, refresh_schedule, next_refresh_at, first_published_at
         FROM dashboards WHERE id = $1 AND org_id = $2`,
        [DASH_ID, TARGET_ORG],
      );
      expect(dash.rows).toHaveLength(1);
      expect(dash.rows[0].share_token).toBeNull(); // re-shared by the owner, never carried
      expect(dash.rows[0].share_mode).toBe("org");
      expect(dash.rows[0].refresh_schedule).toBe("0 8 * * *");
      // Auto-refresh re-planned: recomputed, in the future, never NULL.
      expect(dash.rows[0].next_refresh_at).not.toBeNull();
      expect(new Date(dash.rows[0].next_refresh_at as string).getTime()).toBeGreaterThan(Date.now());

      // Card rides its dashboard FK with caches stripped.
      const card = await pool.query(
        `SELECT dashboard_id, cached_columns, cached_rows, cached_at, chart_config
         FROM dashboard_cards WHERE id = $1`,
        [CARD_ID],
      );
      expect(card.rows).toHaveLength(1);
      expect(card.rows[0].dashboard_id).toBe(DASH_ID);
      expect(card.rows[0].cached_columns).toBeNull();
      expect(card.rows[0].cached_rows).toBeNull();
      expect(card.rows[0].cached_at).toBeNull();
      expect(card.rows[0].chart_config).toEqual({ type: "line" });

      const draft = await pool.query(
        `SELECT draft FROM dashboard_user_drafts WHERE dashboard_id = $1 AND user_id = 'user-2'`,
        [DASH_ID],
      );
      expect(draft.rows).toHaveLength(1);
      expect(draft.rows[0].draft).toEqual({ title: "Revenue (wip)", cards: [] });

      // Knowledge doc: status preserved, generated FTS repopulated, link rides.
      const doc = await pool.query(
        `SELECT status, fts IS NOT NULL AS has_fts FROM knowledge_documents WHERE id = $1 AND workspace_id = $2`,
        [DOC_ID, TARGET_ORG],
      );
      expect(doc.rows).toHaveLength(1);
      expect(doc.rows[0].status).toBe("draft");
      expect(doc.rows[0].has_fts).toBe(true);
      const link = await pool.query(
        `SELECT target_path, anchor_text FROM knowledge_links WHERE source_document_id = $1`,
        [DOC_ID],
      );
      expect(link.rows).toHaveLength(1);
      expect(link.rows[0].target_path).toBe("policies/returns.md");
      expect(link.rows[0].anchor_text).toBe("returns");

      // Scheduled task: definition moved, run bookkeeping reset + re-planned.
      const task = await pool.query(
        `SELECT last_run_at, next_run_at, approval_mode, enabled FROM scheduled_tasks WHERE id = $1 AND org_id = $2`,
        [TASK_ID, TARGET_ORG],
      );
      expect(task.rows).toHaveLength(1);
      expect(task.rows[0].last_run_at).toBeNull();
      expect(task.rows[0].next_run_at).not.toBeNull();
      expect(new Date(task.rows[0].next_run_at as string).getTime()).toBeGreaterThan(Date.now());
      expect(task.rows[0].approval_mode).toBe("auto");
      expect(task.rows[0].enabled).toBe(true);

      // Session memory: FK resolves against the imported conversation.
      const memory = await pool.query(
        `SELECT value FROM agent_session_memory WHERE conversation_id = $1 AND org_id = $2`,
        [CONV_ID, TARGET_ORG],
      );
      expect(memory.rows).toHaveLength(1);
      expect(memory.rows[0].value).toEqual({ note: "weekly grain" });

      // ── Idempotency: a second import skips every row ──
      const second = await runImport(bundle);
      expect(second).toEqual({
        conversations: { imported: 0, skipped: 1 },
        semanticEntities: { imported: 0, skipped: 1 },
        learnedPatterns: { imported: 0, skipped: 1 },
        settings: { imported: 0, skipped: 1 },
        dashboards: { imported: 0, skipped: 1 },
        knowledgeDocuments: { imported: 0, skipped: 1 },
        scheduledTasks: { imported: 0, skipped: 1 },
        agentSessionMemory: { imported: 0, skipped: 1 },
        brainEpisodes: { imported: 0, skipped: 1 },
        // Deduped on the FACT's own key, not the episode's — see the catch-up
        // case below for why that distinction is load-bearing.
        brainFacts: { imported: 0, skipped: 3 },
        brainEdges: { imported: 0, skipped: 2 },
        factAudienceMembers: { imported: 0, skipped: 1 },
        // ⚠️ `skipped`, NOT `refused`, and the distinction is the whole of
        // #5036. Both edges are already approved here onto the SAME target —
        // they are this region's own rows, arriving back — so nothing is lost
        // and nothing is logged. `refused: 0` is the load-bearing half of this
        // assertion: it says an idempotent re-import reports NO discarded human
        // decision, which is what an operator reads the counter to find out.
        // A merge that counted every conflict as a refusal would report two
        // dropped approvals on the most routine path there is.
        brainVocabularyEdges: { imported: 0, skipped: 2, refused: 0 },
      });

      // ── Catch-up import: an episode the target already has, carrying a
      // fact it does NOT. An episode is immutable but its fact set GROWS
      // (re-extraction, human corrections), so skipping facts wholesale
      // because their episode existed would strand the new claim while
      // reporting it as "skipped" — i.e. as already present.
      const LATE_FACT_ID = "cccccccc-0000-4000-8000-00000000000c";
      const catchUp = structuredClone(bundle);
      catchUp.brainEpisodes![0].facts.push({
        ...catchUp.brainEpisodes![0].facts[0],
        id: LATE_FACT_ID,
        object: "59",
        // ⚠️ The only v3 fact in this corpus with NOTHING to drop, and it is
        // here on purpose. Both seeded facts carry a store-local id, so every
        // imported row in the corpus is legitimately `provisional` — and against
        // a corpus like that, "mark the row provisional" and "mark EVERY
        // imported row provisional" are the same program. Measured: the
        // every-row mutation killed nothing until this fixture existed.
        //
        // The distinction is the marker's whole meaning. `provisional` says
        // *this row's comparable value is worth recomputing*, not *this row was
        // imported* — and #4772's review filter reads it as the former.
        subjectCmp: null,
        objectCmp: null,
      });
      const third = await runImport(catchUp);
      expect(third.brainEpisodes).toEqual({ imported: 0, skipped: 1 });
      expect(third.brainFacts).toEqual({ imported: 1, skipped: 3 });

      const late = await pool.query<{
        object: string;
        source_episode_id: string;
        provenance: Record<string, unknown>;
        object_key: string | null;
      }>(
        `SELECT object, source_episode_id, provenance, object_key
           FROM brain_facts WHERE id = $1 AND workspace_id = $2`,
        [LATE_FACT_ID, TARGET_ORG],
      );
      expect(late.rows).toHaveLength(1);
      expect(late.rows[0].object).toBe("59");
      // Attached to the episode the target already held.
      expect(late.rows[0].source_episode_id).toBe(EPISODE_ID);
      // Nothing was dropped for this one, so it is NOT provisional — the arm
      // that separates "worth recomputing" from "was imported". Its keys still
      // travel verbatim, which is what keeps this a fact about `provisional`
      // rather than about the fact having no identity at all.
      //
      // `U-bob` and `thirty nine`, not the live fact's values: the export
      // orders facts by `ingested_at`, and the tombstoned twin was ingested
      // first — so `facts[0]`, which this clone is spread from, is that one.
      expect(late.rows[0].provenance).toEqual({ actor: "U-bob" });
      expect(late.rows[0].object_key).toBe("thirty nine");
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "keys a LEGACY bundle's facts once at import, against the post-merge vocabulary (#5035)",
    async () => {
      // The other half of ADR-0037 §8: a v1/v2 bundle carries no identity, and
      // its facts must be keyed ONCE here rather than left NULL. An unkeyed
      // fact corroborates nothing, earns no tension edge, and can neither
      // supersede nor be superseded — fail-closed and invisible, which is the
      // state this slice ends.
      const LEGACY_ORG = "org-migrate-legacy";
      // Distinct from every other id in this file: the orphan assertions in the
      // adoption test below query `brain_episodes` by id with NO workspace
      // filter, so a shared uuid makes an unrelated test fail for a reason
      // nothing in it explains. (Measured, not hypothesised — the first cut of
      // this test reused `dddddddd-…000d`.)
      const LEGACY_EPISODE_ID = "aaaaaaaa-5035-4000-8000-000000000001";
      const LEGACY_FACT_ID = "aaaaaaaa-5035-4000-8000-000000000002";

      // Hand-built rather than exported-then-downgraded: the source org's rows
      // are deleted by the round-trip above, and a fixture that depends on
      // another test's leftovers fails for a reason that has nothing to do with
      // what it asserts. This is exactly what a pre-#5035 producer emitted —
      // v2, brain sections present, no identity field anywhere. Their ABSENCE is
      // what makes it legacy: validation refuses a v1/v2 fact that carries one,
      // and the importer discriminates on the manifest.
      //
      // ⚠️ The predicate is `Is Priced At`, and that is the whole test. It norms
      // to `is priced at`, which the vocabulary ARRIVING IN THIS BUNDLE maps
      // `→ priced at → unit price`. The destination org is fresh, so its
      // pre-merge vocabulary is empty: an importer that keyed the facts before
      // merging the edges would land `is priced at`, and one that never keyed
      // them would land NULL. Only keying against the post-merge closure
      // produces `unit price`.
      const legacy = {
        manifest: {
          version: 2 as const,
          exportedAt: "2026-06-01T00:00:00Z",
          source: { label: "legacy-arm-test" },
          counts: {
            conversations: 0, messages: 0, semanticEntities: 0,
            learnedPatterns: 0, settings: 0,
            dashboards: 0, dashboardCards: 0, dashboardUserDrafts: 0,
            knowledgeDocuments: 0, knowledgeLinks: 0,
            scheduledTasks: 0, agentSessionMemory: 0,
            brainEpisodes: 1, brainFacts: 1, brainVocabularyEdges: 2,
          },
        },
        conversations: [],
        semanticEntities: [],
        learnedPatterns: [],
        settings: [],
        dashboards: [],
        knowledgeDocuments: [],
        scheduledTasks: [],
        agentSessionMemory: [],
        brainEpisodes: [
          {
            id: LEGACY_EPISODE_ID,
            source: "slack",
            sourceId: "C-legacy/1700000000.1",
            sourceActor: "U-alice",
            body: "Pricing moved to $49/seat.",
            locator: null,
            occurredAt: "2026-06-01T00:00:00Z",
            ingestedAt: "2026-06-01T00:00:00Z",
            extractedAt: "2026-06-01T00:05:00Z",
            visibleTo: ["org"],
            createdAt: "2026-06-01T00:00:00Z",
            facts: [
              {
                id: LEGACY_FACT_ID,
                subject: "acme:pro-plan",
                predicate: "Is Priced At",
                object: "49",
                validFrom: "2026-06-01T00:00:00Z",
                validTo: null,
                ingestedAt: "2026-06-01T00:05:00Z",
                invalidatedAt: null,
                extractedAt: "2026-06-01T00:05:00Z",
                provenance: { actor: "U-alice", episode: "C-legacy/1700000000.1" },
                status: "published" as const,
                visibleTo: ["org"],
                preWideningVisibleTo: null,
                predicateCardinality: "single" as const,
                createdAt: "2026-06-01T00:05:00Z",
                updatedAt: "2026-06-01T00:05:00Z",
              },
            ],
          },
        ],
        brainEdges: [],
        factAudienceMembers: [],
        brainVocabularyEdges: [
          {
            slotPosition: "predicate" as const,
            fromNorm: "is priced at",
            toNorm: "priced at",
            approvedBy: "source-admin",
            approvedAt: "2026-06-01T00:00:00Z",
          },
          {
            slotPosition: "predicate" as const,
            fromNorm: "priced at",
            toNorm: "unit price",
            approvedBy: null,
            approvedAt: "2026-06-01T00:00:00Z",
          },
        ],
      };

      // ⚠️ The destination is NOT empty. A fresh org would prove only *the
      // arriving edges are visible*, which an implementation that built a
      // closure from `bundle.brainVocabularyEdges` and never read the database
      // would also satisfy. This edge is the destination's OWN prior decision,
      // on a disjoint norm so nothing conflicts — the imported fact's
      // `subject_key` has to come through it, which is only true if the load
      // reads the merged table.
      const seedClient = await pool.connect();
      try {
        await seedClient.query("BEGIN");
        expect(
          (
            await approveAliasEdge(seedClient, LEGACY_ORG, {
              position: "subject",
              fromNorm: "acme:pro plan",
              toNorm: "acme pro",
              approvedBy: "target-admin",
            })
          ).ok,
        ).toBe(true);
        await seedClient.query("COMMIT");
      } finally {
        seedClient.release();
      }

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await importBundle(
          client,
          legacy as unknown as Parameters<typeof importBundle>[1],
          LEGACY_ORG,
        );
        await client.query("COMMIT");
        expect(result.brainFacts).toEqual({ imported: 1, skipped: 0 });
        expect(result.brainVocabularyEdges).toEqual({ imported: 2, skipped: 0, refused: 0 });
      } finally {
        client.release();
      }

      const keyed = await pool.query<{
        subject_key: string | null;
        predicate_key: string | null;
        object_key: string | null;
        subject_cmp: string | null;
        object_cmp: string | null;
        provenance: Record<string, unknown>;
        predicate_cardinality: string;
      }>(
        `SELECT subject_key, predicate_key, object_key, subject_cmp, object_cmp,
                provenance, predicate_cardinality
           FROM brain_facts WHERE id = $1 AND workspace_id = $2`,
        [LEGACY_FACT_ID, LEGACY_ORG],
      );
      expect(keyed.rows).toHaveLength(1);
      // The bundle says `single`; the row lands `multi`. This is the ONLY
      // population where "accepted and ignored" changes a stored value — a v3
      // bundle carries no such field, so the v3 path writes the schema default
      // whether the importer honours the field or not, and an assertion there
      // would pass against a build that still writes it.
      expect(keyed.rows[0].predicate_cardinality).toBe("multi");
      // Computed, not carried, and computed through the vocabulary that arrived
      // in the same transaction.
      expect(keyed.rows[0].predicate_key).toBe("unit price");
      // …and through the DESTINATION's own pre-existing edge at the subject.
      // `acme:pro-plan` norms to `acme:pro plan`, which the edge approved above
      // maps to `acme pro`. A load that read only the arriving edges — or that
      // ran before the merge — lands the bare norm.
      expect(keyed.rows[0].subject_key).toBe("acme pro");
      // The one position no vocabulary touches: a lexical norm of the retained
      // surface, which is what `slotKey` reduces to when the lookup is identity.
      expect(keyed.rows[0].object_key).toBe("49");
      // A legacy bundle carries no comparable value at all, so there is nothing
      // to drop — and nothing to recompute. `provisional` must NOT be set, or
      // the marker means "was imported" rather than "is worth recomputing" and
      // #4772's review filter fills with rows that need no work.
      expect(keyed.rows[0].subject_cmp).toBeNull();
      expect(keyed.rows[0].object_cmp).toBeNull();
      expect(keyed.rows[0].provenance).toEqual({
        actor: "U-alice",
        episode: "C-legacy/1700000000.1",
      });
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "keys a legacy corpus against the DESTINATION's decision when the source's edge is refused (#5036)",
    async () => {
      // The arm #5036 newly makes reachable, and the one place its two halves
      // meet. Before this slice the same input either aborted the whole import
      // (a cycle) or was a documented silent skip; now it COMMITS, and the
      // consequence lands on facts rather than on edges.
      //
      // Source curated `price → priced at`; this region had already curated
      // `price → cost`. The arriving edge takes a second parent, so it is
      // refused — and the legacy bundle's facts are then keyed, in the same
      // transaction, through the vocabulary that survived the merge. So the
      // imported claim keys onto THIS region's canonical predicate, not the
      // source's, which is exactly the accepted cost of destination-wins and is
      // worth pinning so a future reader sees it was decided rather than missed.
      const REFUSED_ORG = "org-migrate-legacy-refused";
      const EPISODE_ID = "bbbbbbbb-5036-4000-8000-000000000001";
      const FACT_ID = "bbbbbbbb-5036-4000-8000-000000000002";

      const seedClient = await pool.connect();
      try {
        await seedClient.query("BEGIN");
        expect(
          (
            await approveAliasEdge(seedClient, REFUSED_ORG, {
              position: "predicate",
              fromNorm: "price",
              toNorm: "cost",
              approvedBy: "target-admin",
            })
          ).ok,
        ).toBe(true);
        await seedClient.query("COMMIT");
      } finally {
        seedClient.release();
      }

      const legacy = {
        manifest: {
          version: 2 as const,
          exportedAt: "2026-06-01T00:00:00Z",
          source: { label: "legacy-refused-test" },
          counts: {
            conversations: 0, messages: 0, semanticEntities: 0,
            learnedPatterns: 0, settings: 0,
            brainEpisodes: 1, brainFacts: 1, brainVocabularyEdges: 1,
          },
        },
        conversations: [],
        semanticEntities: [],
        learnedPatterns: [],
        settings: [],
        brainEpisodes: [
          {
            id: EPISODE_ID,
            source: "slack",
            sourceId: "C-refused/1700000000.1",
            sourceActor: "U-alice",
            body: "Price is $49/seat.",
            locator: null,
            occurredAt: "2026-06-01T00:00:00Z",
            ingestedAt: "2026-06-01T00:00:00Z",
            extractedAt: "2026-06-01T00:05:00Z",
            visibleTo: ["org"],
            createdAt: "2026-06-01T00:00:00Z",
            facts: [
              {
                id: FACT_ID,
                subject: "acme pro",
                // Norms to `price` — the very norm both regions curated, in
                // opposite directions.
                predicate: "Price",
                object: "49",
                validFrom: "2026-06-01T00:00:00Z",
                validTo: null,
                ingestedAt: "2026-06-01T00:05:00Z",
                invalidatedAt: null,
                extractedAt: "2026-06-01T00:05:00Z",
                provenance: { actor: "U-alice", episode: "C-refused/1700000000.1" },
                status: "published" as const,
                visibleTo: ["org"],
                preWideningVisibleTo: null,
                predicateCardinality: "single" as const,
                createdAt: "2026-06-01T00:05:00Z",
                updatedAt: "2026-06-01T00:05:00Z",
              },
            ],
          },
        ],
        brainVocabularyEdges: [
          {
            slotPosition: "predicate" as const,
            fromNorm: "price",
            toNorm: "priced at",
            approvedBy: "source-admin",
            approvedAt: "2026-06-01T00:00:00Z",
          },
        ],
      };

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await importBundle(
          client,
          legacy as unknown as Parameters<typeof importBundle>[1],
          REFUSED_ORG,
        );
        await client.query("COMMIT");
        // The import COMMITS — one refusal, and the fact still lands.
        expect(result.brainVocabularyEdges).toEqual({ imported: 0, skipped: 0, refused: 1 });
        expect(result.brainFacts).toEqual({ imported: 1, skipped: 0 });
      } finally {
        client.release();
      }

      const keyed = await pool.query<{ predicate_key: string | null }>(
        `SELECT predicate_key FROM brain_facts WHERE id = $1 AND workspace_id = $2`,
        [FACT_ID, REFUSED_ORG],
      );
      expect(keyed.rows).toHaveLength(1);
      // `cost` — and each of the two alternatives would be a different bug:
      // `priced at` means the refusal did not hold, `price` means the keying ran
      // against no vocabulary at all.
      expect(keyed.rows[0].predicate_key).toBe("cost");

      // The destination's edge is untouched and still the only one.
      const edges = await pool.query<{ from_norm: string; to_norm: string }>(
        `SELECT from_norm, to_norm FROM brain_vocabulary_edge WHERE workspace_id = $1`,
        [REFUSED_ORG],
      );
      expect(edges.rows).toEqual([{ from_norm: "price", to_norm: "cost" }]);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "positive control: this region's OWN writer does fill both _cmp columns (#5035)",
    async () => {
      // Without this, every `toBeNull()` above is satisfied by a build in which
      // `object_cmp` and `subject_cmp` are never written by anyone — a green
      // suite over a column that does nothing. The control has to be a LOCALLY
      // written row, through the ordinary ingest path, in the same schema.
      const CONTROL_ORG = "org-migrate-cmp-control";
      const { rows: epRows } = await pool.query<{ id: string }>(
        `INSERT INTO brain_episodes (workspace_id, source, source_id, source_actor, body, occurred_at, visible_to)
         VALUES ($1, 'slack', 'C999/1700000000.9', 'U-ctl', 'Pro plan is 49 USD.', now(), ARRAY['org'])
         RETURNING id`,
        [CONTROL_ORG],
      );
      const episodeId = epRows[0]!.id;

      const report = await reconcileFacts({
        vocabulary: identityVocabulary,
        episode: {
          id: episodeId,
          workspaceId: CONTROL_ORG,
          source: "slack",
          sourceId: "C999/1700000000.9",
          sourceActor: "U-ctl",
          occurredAt: new Date(),
          visibleTo: ["org"],
        },
        candidates: [{ subject: "acme pro plan", predicate: "price per seat", object: "49 USD" }],
        producer: "extraction:v1",
        extractedAt: new Date(),
        // An ANSWERING store, so the subject position has an id to carry. The
        // shipped default abstains on everything, and against it "subject_cmp
        // is null" would pass with no writer involved at all.
        //
        // It answers for the SUBJECT surface only, deliberately. A resolved id
        // outranks any parse of the surface (`comparableValueWithReason`), so
        // answering for `49 USD` too would put `entity:…` in `object_cmp` and
        // the money control would be testing the resolver instead of the parser
        // — the two shapes this slice discriminates between, collapsed into one.
        resolveEntity: (surfaces) =>
          new Map(
            [...surfaces]
              .filter((s) => s === "acme pro plan")
              .map((s) => [s, { entityId: `01JCTL${s.replaceAll(/\W/g, "")}` }]),
          ),
      });
      expect(report.created).toBe(1);

      const control = await pool.query<{ subject_cmp: string | null; object_cmp: string | null }>(
        `SELECT subject_cmp, object_cmp FROM brain_facts WHERE workspace_id = $1`,
        [CONTROL_ORG],
      );
      expect(control.rows).toHaveLength(1);
      // Both non-null, and the object's tag is the region-invariant one — the
      // same shape that SURVIVES an import, which is what makes the entity-tag
      // null-out a discrimination rather than a blanket wipe.
      expect(control.rows[0].object_cmp).toBe("money:USD:49");
      expect(control.rows[0].subject_cmp).toBe("entity:01JCTLacmeproplan");
    },
    PG_TEST_TIMEOUT_MS,
  );

  /** A v2 bundle carrying nothing but one alias edge. */
  const vocabularyOnlyBundle = (fromNorm: string, toNorm: string) => ({
    manifest: {
      version: 2 as const,
      exportedAt: "2026-06-01T00:00:00Z",
      source: { label: "vocab-test" },
      counts: {
        conversations: 0, messages: 0, semanticEntities: 0, learnedPatterns: 0,
        settings: 0, brainVocabularyEdges: 1,
      },
    },
    conversations: [],
    semanticEntities: [],
    learnedPatterns: [],
    settings: [],
    brainVocabularyEdges: [
      {
        slotPosition: "predicate" as const,
        fromNorm,
        toNorm,
        approvedBy: "source-admin",
        approvedAt: "2026-06-01T00:00:00Z",
      },
    ],
  });

  it(
    "blocks on the workspace vocabulary lock while an approval is open (#5022)",
    async () => {
      // Two vocabulary writers over DISJOINT norms: they must serialize on the
      // workspace lock and end with a closure of the union, not of either half.
      // What this pins is the serialization; the test below pins the LOCK ORDER,
      // which is the property that actually bites.
      const LOCK_ORG = "org-migrate-vocab-lock";
      const holder = await pool.connect();
      const importer = await pool.connect();
      try {
        await holder.query("BEGIN");
        expect(
          (
            await approveAliasEdge(holder, LOCK_ORG, {
              position: "predicate",
              fromNorm: "a",
              toNorm: "b",
              approvedBy: "target-admin",
            })
          ).ok,
        ).toBe(true);

        await importer.query("BEGIN");
        const blocked = importBundle(importer, vocabularyOnlyBundle("c", "d"), LOCK_ORG);
        const raced = await Promise.race([
          blocked.then(() => "completed" as const),
          new Promise<"pending">((r) => setTimeout(() => r("pending"), 300)),
        ]);
        // Still waiting on the holder's lock rather than recomputing around it.
        expect(raced).toBe("pending");

        await holder.query("COMMIT");
        const result = await blocked;
        expect(result.brainVocabularyEdges).toEqual({ imported: 1, skipped: 0, refused: 0 });
        await importer.query("COMMIT");
      } catch (err) {
        // intentionally ignored: the assertion failure below is the real
        // outcome; a rollback error on an already-dead connection would mask it
        await holder.query("ROLLBACK").catch(() => {});
        await importer.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        holder.release();
        importer.release();
      }

      // Both writers' edges survive, and the closure covers both — which is only
      // true because the second rebuild ran AFTER the first committed.
      const closure = await pool.query<{ norm: string; effective_target: string }>(
        `SELECT norm, effective_target FROM brain_vocabulary_target
          WHERE workspace_id = $1 ORDER BY norm`,
        [LOCK_ORG],
      );
      expect(closure.rows).toEqual([
        { norm: "a", effective_target: "b" },
        { norm: "c", effective_target: "d" },
      ]);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "does not deadlock against a concurrent approval of the SAME norm (#5022)",
    async () => {
      // The regression test for a defect this PR shipped and then removed: the
      // importer's advisory lock was deleted as "redundant, since
      // `recomputeEffectiveTargets` takes it anyway". It is not redundant.
      //
      // `approveAliasEdge` takes the advisory lock and THEN inserts. An importer
      // that inserts first and reaches the lock only at recompute time acquires
      // the same two resources in the opposite order, and the cycle needs a
      // precise interleaving:
      //
      //   1. the importer inserts the contended row (taking its row lock) and
      //      keeps working;
      //   2. the approver takes the ADVISORY lock, then blocks on that row;
      //   3. the importer finishes and asks for the advisory lock → cycle.
      //
      // So the fixture puts the contended norm FIRST in the bundle and pads it
      // with enough filler edges that step 2 lands inside the loop. An earlier
      // version of this test had the approver insert first, which cannot
      // deadlock — the approver then waits on nothing, so there is no cycle, and
      // the test passed against the broken code. The padding is the test.
      const DEADLOCK_ORG = "org-migrate-vocab-deadlock";
      const PADDING = 400;

      const bundle = vocabularyOnlyBundle("shared", "source side");
      for (let i = 0; i < PADDING; i++) {
        bundle.brainVocabularyEdges.push({
          slotPosition: "predicate" as const,
          fromNorm: `filler ${i}`,
          toNorm: `filler target ${i}`,
          approvedBy: "source-admin",
          approvedAt: "2026-06-01T00:00:00Z",
        });
      }

      const approver = await pool.connect();
      const importer = await pool.connect();
      const failures: string[] = [];
      try {
        await importer.query("BEGIN");
        const importing = importBundle(importer, bundle, DEADLOCK_ORG).catch((err: unknown) => {
          failures.push(`import: ${err instanceof Error ? err.message : String(err)}`);
          return null;
        });

        // Long enough for the importer to have written the contended row and be
        // partway through the padding.
        await new Promise((r) => setTimeout(r, 60));

        await approver.query("BEGIN");
        const approving = approveAliasEdge(approver, DEADLOCK_ORG, {
          position: "predicate",
          fromNorm: "shared",
          toNorm: "target side",
          approvedBy: "target-admin",
        }).catch((err: unknown) => {
          failures.push(`approve: ${err instanceof Error ? err.message : String(err)}`);
          return null;
        });

        // The importer is awaited and COMMITTED first, and the order matters
        // for the test itself: with the lock correctly held, the approver waits
        // on it until the importer's transaction ENDS, so awaiting the approver
        // before committing the importer would hang on a dependency the test
        // created rather than on anything under test.
        await importing;
        await importer.query("COMMIT").catch(() => {});
        await approving;
        await approver.query("COMMIT").catch(() => {});
      } finally {
        approver.release();
        importer.release();
      }

      // The whole assertion. Either writer may win, and the loser may be refused
      // — those are ordinary outcomes. What must never happen is Postgres
      // breaking a lock cycle for us, because the victim is picked arbitrarily
      // and is sometimes the entire region import.
      expect(
        failures.filter((f) => /deadlock/i.test(f)),
        `lock-order inversion between importBundle and approveAliasEdge: ${failures.join(" | ")}`,
      ).toEqual([]);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "REFUSES only the arriving alias edge that would close a cycle, and imports the rest (#5036)",
    async () => {
      // The importer's residual #2, inverted by #5036. Until this slice the
      // block was `ON CONFLICT DO NOTHING`: it deduplicated on the
      // at-most-one-parent key and did not look for cycles at all, so an
      // arriving edge could close one against a decision the destination region
      // already held — and the closure rebuild then aborted the ENTIRE import
      // transaction. That was "loud and recoverable beats silent and not", and
      // it was the right call while the merge did not exist.
      //
      // It is the wrong outcome now, and the reason is the failure MODE rather
      // than the noise: a cross-region cutover is not a retryable unit of work
      // an operator can fix and re-run cheaply, and the edge that killed it is
      // one alias out of a whole workspace. The merge refuses the single edge,
      // logs enough of the source row to re-author it, and lets everything else
      // land.
      //
      // THREE nodes, kept from the pre-#5036 version of this test where a
      // 2-cycle died on `ck_brain_vocabulary_target_not_self` during the closure
      // REBUILD rather than in the cycle walk. That no longer applies — the
      // merge refuses before it writes, so the rebuild never runs and a two-node
      // fixture now takes the same path. Three still buy the stronger claim:
      // that the walk COMPOSES a chain rather than comparing endpoints.
      const CYCLE_ORG = "org-migrate-vocab-cycle";
      await pool.query(
        `INSERT INTO brain_vocabulary_edge (workspace_id, slot_position, from_norm, to_norm, approved_by)
         VALUES ($1, 'predicate', 'a', 'b', 'target-admin'),
                ($1, 'predicate', 'b', 'c', 'target-admin')`,
        [CYCLE_ORG],
      );
      const seedClient = await pool.connect();
      try {
        await seedClient.query("BEGIN");
        await recomputeEffectiveTargets(seedClient, CYCLE_ORG, "predicate");
        await seedClient.query("COMMIT");
      } finally {
        seedClient.release();
      }

      // `c → a` closes the cycle; `d → a` beside it does not, and is what proves
      // the refusal is scoped to the offending edge rather than to the section.
      const cyclic = vocabularyOnlyBundle("c", "a");
      cyclic.brainVocabularyEdges.push({
        slotPosition: "predicate" as const,
        fromNorm: "d",
        toNorm: "a",
        approvedBy: "source-admin",
        approvedAt: "2026-06-01T00:00:00Z",
      });

      const client = await pool.connect();
      let result: Awaited<ReturnType<typeof importBundle>>;
      try {
        await client.query("BEGIN");
        // No longer throws. The import COMMITS.
        result = await importBundle(client, cyclic, CYCLE_ORG);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch((rollbackErr: unknown) => {
          // intentionally logged rather than rethrown: the original error is the
          // real outcome, and a rollback failure on a dead connection would mask it
          console.debug(
            "rollback after a failed import:",
            rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr),
          );
        });
        throw err;
      } finally {
        client.release();
      }

      // One applied, one refused, nothing duplicated — three distinct values, so
      // a merge that mixed two counters up cannot satisfy this.
      expect(result.brainVocabularyEdges).toEqual({ imported: 1, skipped: 0, refused: 1 });

      // The target keeps its own two decisions, GAINS the non-cycling arrival,
      // and never receives `c → a`.
      const edges = await pool.query<{ from_norm: string }>(
        `SELECT from_norm FROM brain_vocabulary_edge WHERE workspace_id = $1 ORDER BY from_norm`,
        [CYCLE_ORG],
      );
      expect(edges.rows.map((r) => r.from_norm)).toEqual(["a", "b", "d"]);

      // The closure is recomputed over the union: `d` joins the chain and lands
      // on the same root, and `c` is still nobody's child.
      const closure = await pool.query<{ norm: string; effective_target: string }>(
        `SELECT norm, effective_target FROM brain_vocabulary_target
          WHERE workspace_id = $1 ORDER BY norm`,
        [CYCLE_ORG],
      );
      expect(closure.rows).toEqual([
        { norm: "a", effective_target: "c" },
        { norm: "b", effective_target: "c" },
        { norm: "d", effective_target: "c" },
      ]);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "adopts a target episode already present under a DIFFERENT uuid, remapping facts AND edges (#4767)",
    async () => {
      // The scenario adoption exists for: after cutover the target's own
      // connector ingests the same source record, minting its own uuid. A bare
      // INSERT would hit uq_brain_episodes_source_id and abort the entire
      // import; the importer instead adopts the target's row.
      //
      // The subtle half — and the one that was wrong first time — is that the
      // adopted id must be threaded to EDGES too, not just facts. The bundle's
      // episode uuid is never inserted on this path, so a `provenance` edge
      // (fact→episode, the most common type) would otherwise reference a row
      // that does not exist and fail its composite endpoint FK at the very last
      // import step, rolling back everything.
      const ADOPT_ORG = "org-migrate-adopt";
      const SOURCE_EP = "dddddddd-0000-4000-8000-00000000000d";
      const TARGET_EP = "eeeeeeee-0000-4000-8000-00000000000e";
      const ADOPT_FACT = "dddddddd-0000-4000-8000-00000000000f";

      // The target already holds the same (source, source_id) under its own id.
      await pool.query(
        `INSERT INTO brain_episodes (id, workspace_id, source, source_id, body, visible_to)
         VALUES ($1, $2, 'slack', 'C-adopt/1', 'target-side copy', ARRAY['org'])`,
        [TARGET_EP, ADOPT_ORG],
      );

      const bundle = {
        manifest: {
          version: 2 as const,
          exportedAt: "2026-06-01T00:00:00Z",
          source: { label: "adopt-test" },
          counts: {
            conversations: 0, messages: 0, semanticEntities: 0, learnedPatterns: 0, settings: 0,
            brainEpisodes: 1, brainFacts: 1, brainEdges: 1, factAudienceMembers: 0,
          },
        },
        conversations: [], semanticEntities: [], learnedPatterns: [], settings: [],
        dashboards: [], knowledgeDocuments: [], scheduledTasks: [], agentSessionMemory: [],
        brainEpisodes: [
          {
            id: SOURCE_EP,
            source: "slack",
            sourceId: "C-adopt/1",
            sourceActor: null,
            body: "source-side copy",
            locator: null,
            occurredAt: null,
            ingestedAt: "2026-06-01T00:00:00Z",
            extractedAt: null,
            visibleTo: ["org"],
            createdAt: "2026-06-01T00:00:00Z",
            facts: [
              {
                id: ADOPT_FACT,
                subject: "s", predicate: "p", object: "o",
                validFrom: null, validTo: null,
                ingestedAt: "2026-06-01T00:00:00Z",
                invalidatedAt: null, extractedAt: null,
                provenance: { actor: "u1" },
                status: "published" as const,
                visibleTo: ["org"],
                predicateCardinality: "multi" as const,
                createdAt: "2026-06-01T00:00:00Z",
                updatedAt: "2026-06-01T00:00:00Z",
              },
            ],
          },
        ],
        // Points at the BUNDLE's episode id — the id that is never inserted.
        brainEdges: [
          {
            edgeType: "provenance" as const,
            fromFactId: ADOPT_FACT,
            fromEpisodeId: null,
            toFactId: null,
            toEpisodeId: SOURCE_EP,
            createdAt: "2026-06-01T00:00:00Z",
          },
        ],
        factAudienceMembers: [],
      };

      const client = await pool.connect();
      let result: ImportResult;
      try {
        await client.query("BEGIN");
        result = await importBundle(client, bundle as never, ADOPT_ORG);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }

      expect(result.brainEpisodes).toEqual({ imported: 0, skipped: 1 });
      expect(result.brainFacts).toEqual({ imported: 1, skipped: 0 });
      expect(result.brainEdges).toEqual({ imported: 1, skipped: 0 });

      // The bundle's episode uuid was never inserted…
      const orphan = await pool.query(`SELECT 1 FROM brain_episodes WHERE id = $1`, [SOURCE_EP]);
      expect(orphan.rowCount).toBe(0);

      // …so both the fact and the edge must reference the TARGET's uuid.
      const fact = await pool.query<{ source_episode_id: string }>(
        `SELECT source_episode_id FROM brain_facts WHERE id = $1`,
        [ADOPT_FACT],
      );
      expect(fact.rows[0].source_episode_id).toBe(TARGET_EP);

      const edge = await pool.query<{ to_episode_id: string }>(
        `SELECT to_episode_id FROM brain_edges WHERE workspace_id = $1`,
        [ADOPT_ORG],
      );
      expect(edge.rows).toHaveLength(1);
      expect(edge.rows[0].to_episode_id).toBe(TARGET_EP);
    },
    PG_TEST_TIMEOUT_MS,
  );

  // ── #4458 — Phase 4 source cleanup against the real schema ──────────
  // The mock-level suite (`cleanup.test.ts`) pins scope + transaction
  // behavior but can't catch a typo'd column in one of the ~70 generated
  // DELETE statements — this runs every one of them against real Postgres.
  it(
    "deletes the source org's residue after the grace period, sparing the target org, platform rows, and a returned workspace (#4458)",
    async () => {
      const CLEAN_ORG = "org-cleanup-src";
      const GUARD_ORG = "org-cleanup-guard";
      const GRACE_ORG = "org-cleanup-in-grace";
      /** A workspace the sweep is not asked about — seeded in this test, so the
       *  "spared" assertion carries no dependency on any other test's state. */
      const SPARED_ORG = "org-cleanup-spared";
      const C_CONV = "77777777-7777-4777-8777-777777777777";
      const GRACE_CONV = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
      const C_DASH = "88888888-8888-4888-8888-888888888888";
      const C_CARD = "99999999-9999-4999-8999-999999999999";
      const C_DOC = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      const C_TASK = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
      const G_CONV = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

      // Minimal Better-Auth `organization` mirror for the cutover guard
      // (the BA migrations are skipped in this suite).
      await pool.query(
        `CREATE TABLE IF NOT EXISTS organization (id text PRIMARY KEY, region text)`,
      );
      await pool.query(
        `INSERT INTO organization (id, region) VALUES ($1, 'eu-test'), ($2, 'us-test'), ($3, 'eu-test')`,
        [CLEAN_ORG, GUARD_ORG, GRACE_ORG],
      );

      // ── Seed residue for the migrated-away org: exported pillars still
      // present in the source PLUS stays-residue rows ──
      await pool.query(
        `INSERT INTO conversations (id, user_id, title, surface, org_id)
         VALUES ($1, 'user-1', 'Residue conversation', 'web', $2)`,
        [C_CONV, CLEAN_ORG],
      );
      await pool.query(
        `INSERT INTO messages (conversation_id, role, content)
         VALUES ($1, 'user', '"hello"'::jsonb)`,
        [C_CONV],
      );
      // No FK from slack_threads → conversations: only the parent-first
      // delete ordering keeps this row attributable.
      await pool.query(
        `INSERT INTO slack_threads (thread_ts, channel_id, conversation_id)
         VALUES ('171.001', 'C-clean', $1)`,
        [C_CONV],
      );
      await pool.query(
        `INSERT INTO agent_session_memory (conversation_id, org_id, namespace, value)
         VALUES ($1, $2, 'scratchpad', '{"note":"residue"}'::jsonb)`,
        [C_CONV, CLEAN_ORG],
      );
      await pool.query(
        `INSERT INTO dashboards (id, org_id, owner_id, title) VALUES ($1, $2, 'user-1', 'Residue dash')`,
        [C_DASH, CLEAN_ORG],
      );
      await pool.query(
        `INSERT INTO dashboard_cards (id, dashboard_id, position, title, sql)
         VALUES ($1, $2, 0, 'Residue card', 'SELECT 1')`,
        [C_CARD, C_DASH],
      );
      await pool.query(
        `INSERT INTO dashboard_user_drafts (user_id, dashboard_id, draft, baseline, published_baseline_at)
         VALUES ('user-9', $1, '{"title":"wip","cards":[]}'::jsonb, '{"title":"base","cards":[]}'::jsonb, now())`,
        [C_DASH],
      );
      await pool.query(
        `INSERT INTO dashboard_draft_card_cache (user_id, dashboard_id, card_id, cached_columns, cached_rows)
         VALUES ('user-9', $1, $2, '["a"]'::jsonb, '[{"a":1}]'::jsonb)`,
        [C_DASH, C_CARD],
      );
      await pool.query(
        `INSERT INTO knowledge_documents (id, workspace_id, collection_id, path, type, title, tags, body, status)
         VALUES ($1, $2, 'handbook', 'residue.md', 'guide', 'Residue doc', '[]'::jsonb, 'body', 'draft')`,
        [C_DOC, CLEAN_ORG],
      );
      await pool.query(
        `INSERT INTO knowledge_links (source_document_id, target_path) VALUES ($1, 'other.md')`,
        [C_DOC],
      );
      await pool.query(
        `INSERT INTO scheduled_tasks (id, owner_id, org_id, name, question, cron_expression, delivery_channel,
                                      recipients, connection_group_id, approval_mode, enabled)
         VALUES ($1, 'user-1', $2, 'Residue task', 'q?', '0 9 * * 1', 'email', '[]'::jsonb, 'g-prod', 'auto', true)`,
        [C_TASK, CLEAN_ORG],
      );
      await pool.query(
        `INSERT INTO scheduled_task_runs (task_id, status) VALUES ($1, 'success')`,
        [C_TASK],
      );
      await pool.query(
        `INSERT INTO semantic_entities (org_id, entity_type, name, yaml_content, connection_group_id)
         VALUES ($1, 'entity', 'orders', 'table: orders', 'g-prod')`,
        [CLEAN_ORG],
      );
      await pool.query(
        `INSERT INTO learned_patterns (org_id, pattern_sql, description, confidence, status, auto_promoted)
         VALUES ($1, 'SELECT 1', 'Residue pattern', 0.5, 'approved', false)`,
        [CLEAN_ORG],
      );
      // Org-scoped settings row must go; the platform-scoped (org_id NULL)
      // row must survive — platform state is outside the cleanup scope.
      await pool.query(
        `INSERT INTO settings (key, value, org_id) VALUES ('theme', 'light', $1), ('cleanup_probe_platform', 'keep', NULL)`,
        [CLEAN_ORG],
      );
      // chat_cache: the Slack installation row (org id in the JSONB value)
      // must go; a generic response-cache row is unattributable and stays.
      await pool.query(
        `INSERT INTO chat_cache (key, value)
         VALUES ('slack:installation:T-clean', jsonb_build_object('orgId', $1::text, 'botToken', 'enc')),
                ('response:generic', '{"answer":42}'::jsonb)`,
        [CLEAN_ORG],
      );
      await pool.query(
        `INSERT INTO audit_log (auth_mode, sql, duration_ms, success, org_id)
         VALUES ('none', 'SELECT 1', 5, true, $1)`,
        [CLEAN_ORG],
      );

      // Company brain residue (#4767). This is the ONE place the sweep's
      // phase ordering is load-bearing: `brain_facts.source_episode_id` is
      // RESTRICT, so if facts were deleted in the same phase as episodes the
      // sweep would fail outright on any workspace that actually has a brain.
      // Seeding a full episode → fact → edge chain here is what makes that a
      // test failure instead of a production incident.
      const cleanEpisode = "aaaaaaaa-0000-4000-8000-00000000000a";
      const cleanFact = "aaaaaaaa-0000-4000-8000-00000000000b";
      await pool.query(
        `INSERT INTO brain_episodes (id, workspace_id, source, source_id, body, visible_to)
         VALUES ($1, $2, 'slack', 'C-clean/1', 'residue', ARRAY['org'])`,
        [cleanEpisode, CLEAN_ORG],
      );
      await pool.query(
        `INSERT INTO brain_facts (id, workspace_id, subject, predicate, object,
                                  subject_key, predicate_key, object_key,
                                  source_episode_id, provenance, visible_to)
         VALUES ($1, $2, 's', 'p', 'o', 's', 'p', 'o', $3, '{"actor":"u"}'::jsonb, ARRAY['org'])`,
        [cleanFact, CLEAN_ORG, cleanEpisode],
      );
      await pool.query(
        `INSERT INTO brain_edges (workspace_id, edge_type, from_fact_id, to_episode_id)
         VALUES ($1, 'provenance', $2, $3)`,
        [CLEAN_ORG, cleanFact, cleanEpisode],
      );
      await pool.query(
        `INSERT INTO fact_audience_member (workspace_id, audience_id, user_id, source)
         VALUES ($1, 'eng', 'user-1', 'slack')`,
        [CLEAN_ORG],
      );

      // Vocabulary residue (#5022) — the SECOND place phase ordering is
      // load-bearing, and the reason `brain_vocabulary_target`'s cleanup rule is
      // `expression`-kind rather than `column`. Its FK to the edge table is
      // RESTRICT and the edge table is declared FIRST, so under a `column` rule
      // the two deletes would run in the wrong order and abort the sweep for
      // every workspace that has ever approved an alias. Without rows here, both
      // new DELETE statements have never executed against real Postgres and the
      // residency promise that curated aliases are deleted at source is asserted
      // nowhere.
      await pool.query(
        `INSERT INTO brain_vocabulary_edge (workspace_id, slot_position, from_norm, to_norm, approved_by)
         VALUES ($1, 'predicate', 'is priced at', 'priced at', 'user-1'),
                ($1, 'predicate', 'priced at', 'unit price', NULL)`,
        [CLEAN_ORG],
      );
      const cleanupSeedClient = await pool.connect();
      try {
        await cleanupSeedClient.query("BEGIN");
        await recomputeEffectiveTargets(cleanupSeedClient, CLEAN_ORG, "predicate");
        await cleanupSeedClient.query("COMMIT");
      } finally {
        cleanupSeedClient.release();
      }

      // ── A workspace that migrated away but came BACK before cleanup ran:
      // the cutover guard must refuse to delete its (live) data ──
      await pool.query(
        `INSERT INTO conversations (id, user_id, title, surface, org_id)
         VALUES ($1, 'user-1', 'Guarded conversation', 'web', $2)`,
        [G_CONV, GUARD_ORG],
      );

      // A migration still INSIDE the grace period (2 days < 7) — the due
      // query's interval clause is the only timing guard, so this pins that
      // premature deletion cannot happen even when the sweep runs.
      await pool.query(
        `INSERT INTO conversations (id, user_id, title, surface, org_id)
         VALUES ($1, 'user-1', 'In-grace conversation', 'web', $2)`,
        [GRACE_CONV, GRACE_ORG],
      );

      // Two migrations completed 8 days ago — past the 7-day grace period —
      // and one only 2 days ago, still inside it.
      await pool.query(
        `INSERT INTO region_migrations (id, workspace_id, source_region, target_region, status, completed_at, region_updated)
         VALUES ('mig-clean-1', $1, 'us-test', 'eu-test', 'completed', now() - interval '8 days', TRUE),
                ('mig-guard-1', $2, 'us-test', 'eu-test', 'completed', now() - interval '8 days', TRUE),
                ('mig-grace-1', $3, 'us-test', 'eu-test', 'completed', now() - interval '2 days', TRUE)`,
        [CLEAN_ORG, GUARD_ORG, GRACE_ORG],
      );

      // Pin this process's region identity to the source region so the
      // sweep's region guard matches (getApiRegion reads the env var on
      // every call, so setting it just for this block is enough).
      const savedRegion = process.env.ATLAS_API_REGION;
      process.env.ATLAS_API_REGION = "us-test";
      try {
        // ⚠️ The "spared" side is seeded HERE, not inherited from the round-trip
        // test above. The first attempt at this fix captured a before-count and
        // asserted it `> 0` — which re-imported the very dependency it was
        // removing, so the mutation column kept double-counting (#5035, panel
        // round 3, measured by running this test alone: `Expected > 0, Received
        // 0`). A spared-workspace assertion needs a spared workspace, and the
        // cheapest honest one is its own.
        const SPARED_EPISODE = "bbbbbbbb-5035-4000-8000-000000000001";
        const SPARED_FACT = "bbbbbbbb-5035-4000-8000-000000000002";
        await pool.query(
          `INSERT INTO brain_episodes (id, workspace_id, source, source_id, body, visible_to)
           VALUES ($1, $2, 'slack', 'C-spared/1', 'spared', ARRAY['org'])`,
          [SPARED_EPISODE, SPARED_ORG],
        );
        await pool.query(
          `INSERT INTO brain_facts (id, workspace_id, subject, predicate, object, ingested_at,
                                    subject_key, predicate_key, object_key,
                                    source_episode_id, provenance, status, visible_to)
           VALUES ($1, $2, 's', 'p', 'o', now(), 's', 'p', 'o', $3, '{"actor":"u"}'::jsonb, 'draft', ARRAY['org'])`,
          [SPARED_FACT, SPARED_ORG, SPARED_EPISODE],
        );

        const sweep = await runSourceCleanupSweep();
        expect(sweep).toEqual({ due: 2, cleaned: 1, skipped: 1, blocked: 0 });

        // Every scoped table's residue for the migrated org is gone.
        const countIn = async (sql: string, params: unknown[]): Promise<number> => {
          const res = await pool.query(sql, params);
          return Number(res.rows[0].n);
        };
        expect(await countIn(`SELECT count(*)::int AS n FROM conversations WHERE org_id = $1`, [CLEAN_ORG])).toBe(0);
        expect(await countIn(`SELECT count(*)::int AS n FROM messages WHERE conversation_id = $1`, [C_CONV])).toBe(0);
        expect(await countIn(`SELECT count(*)::int AS n FROM slack_threads WHERE conversation_id = $1`, [C_CONV])).toBe(0);
        expect(await countIn(`SELECT count(*)::int AS n FROM agent_session_memory WHERE org_id = $1`, [CLEAN_ORG])).toBe(0);
        // Both vocabulary tables, and the sweep completing at all is half the
        // assertion: a wrong phase order aborts it on the RESTRICT FK.
        expect(await countIn(`SELECT count(*)::int AS n FROM brain_vocabulary_target WHERE workspace_id = $1`, [CLEAN_ORG])).toBe(0);
        expect(await countIn(`SELECT count(*)::int AS n FROM brain_vocabulary_edge WHERE workspace_id = $1`, [CLEAN_ORG])).toBe(0);
        expect(await countIn(`SELECT count(*)::int AS n FROM dashboards WHERE org_id = $1`, [CLEAN_ORG])).toBe(0);
        expect(await countIn(`SELECT count(*)::int AS n FROM dashboard_cards WHERE dashboard_id = $1`, [C_DASH])).toBe(0);
        expect(await countIn(`SELECT count(*)::int AS n FROM dashboard_user_drafts WHERE dashboard_id = $1`, [C_DASH])).toBe(0);
        expect(await countIn(`SELECT count(*)::int AS n FROM dashboard_draft_card_cache WHERE dashboard_id = $1`, [C_DASH])).toBe(0);
        expect(await countIn(`SELECT count(*)::int AS n FROM knowledge_documents WHERE workspace_id = $1`, [CLEAN_ORG])).toBe(0);
        expect(await countIn(`SELECT count(*)::int AS n FROM knowledge_links WHERE source_document_id = $1`, [C_DOC])).toBe(0);
        expect(await countIn(`SELECT count(*)::int AS n FROM scheduled_tasks WHERE org_id = $1`, [CLEAN_ORG])).toBe(0);
        expect(await countIn(`SELECT count(*)::int AS n FROM scheduled_task_runs WHERE task_id = $1`, [C_TASK])).toBe(0);
        expect(await countIn(`SELECT count(*)::int AS n FROM semantic_entities WHERE org_id = $1`, [CLEAN_ORG])).toBe(0);
        expect(await countIn(`SELECT count(*)::int AS n FROM learned_patterns WHERE org_id = $1`, [CLEAN_ORG])).toBe(0);
        expect(await countIn(`SELECT count(*)::int AS n FROM settings WHERE org_id = $1`, [CLEAN_ORG])).toBe(0);
        expect(await countIn(`SELECT count(*)::int AS n FROM audit_log WHERE org_id = $1`, [CLEAN_ORG])).toBe(0);
        expect(await countIn(`SELECT count(*)::int AS n FROM chat_cache WHERE key = 'slack:installation:T-clean'`, [])).toBe(0);
        // The brain chain is fully swept — facts ahead of episodes despite the
        // RESTRICT FK between them, edges cascaded, audience membership gone.
        expect(await countIn(`SELECT count(*)::int AS n FROM brain_facts WHERE workspace_id = $1`, [CLEAN_ORG])).toBe(0);
        expect(await countIn(`SELECT count(*)::int AS n FROM brain_episodes WHERE workspace_id = $1`, [CLEAN_ORG])).toBe(0);
        expect(await countIn(`SELECT count(*)::int AS n FROM brain_edges WHERE workspace_id = $1`, [CLEAN_ORG])).toBe(0);
        expect(await countIn(`SELECT count(*)::int AS n FROM fact_audience_member WHERE workspace_id = $1`, [CLEAN_ORG])).toBe(0);
        // A workspace the sweep was not asked about is UNTOUCHED — it is scoped
        // to the migrated-away workspace, not to the tables.
        //
        // ⚠️ Asserted as *unchanged by the sweep*, not as an absolute count.
        // The absolute form (`toBe(4)`) depends on the round-trip test above
        // having run to completion, so ANY mutation that fails an assertion
        // inside it also failed here — and every kill in the `roundtrip-pg`
        // column read `2` when the real figure was `1`, the second being a
        // cascade reported under a message about "sparing the target org"
        // (#5035, panel round 2, proven by running the test alone). A
        // before/after comparison measures what this test is actually about and
        // is inert to the other test's state.
        expect(
          await countIn(`SELECT count(*)::int AS n FROM brain_facts WHERE workspace_id = $1`, [SPARED_ORG]),
          "the cleanup sweep deleted facts belonging to a workspace it was not asked to clean — it is scoped to the migrated-away workspace, not to the tables",
        ).toBe(1);

        // Survivors: platform settings row, unattributable cache row, the
        // and the returned (guarded) workspace.
        expect(await countIn(`SELECT count(*)::int AS n FROM settings WHERE key = 'cleanup_probe_platform' AND org_id IS NULL`, [])).toBe(1);
        expect(await countIn(`SELECT count(*)::int AS n FROM chat_cache WHERE key = 'response:generic'`, [])).toBe(1);
        // GUARD_ORG and GRACE_ORG are seeded by THIS test; the TARGET_ORG
        // assertion that used to sit here was inherited from the round-trip
        // block and coupled every mutation's count to it.
        expect(await countIn(`SELECT count(*)::int AS n FROM conversations WHERE org_id = $1`, [GUARD_ORG])).toBe(1);

        // Grace-period boundary: the 2-day-old migration was never due —
        // its data is untouched and its row unstamped.
        expect(await countIn(`SELECT count(*)::int AS n FROM conversations WHERE org_id = $1`, [GRACE_ORG])).toBe(1);
        const graceRow = await pool.query(
          `SELECT source_cleaned_at FROM region_migrations WHERE id = 'mig-grace-1'`,
        );
        expect(graceRow.rows[0].source_cleaned_at).toBeNull();

        // Both past-grace migration rows resolved; cutover bookkeeping untouched.
        const migs = await pool.query(
          `SELECT id, status, region_updated, source_cleaned_at FROM region_migrations WHERE id IN ('mig-clean-1', 'mig-guard-1') ORDER BY id`,
        );
        expect(migs.rows).toHaveLength(2);
        for (const row of migs.rows) {
          expect(row.status).toBe("completed");
          expect(row.region_updated).toBe(true);
          expect(row.source_cleaned_at).not.toBeNull();
        }

        // Idempotent: nothing is due on the next sweep (the in-grace row is
        // still not due; the resolved rows are stamped).
        expect(await runSourceCleanupSweep()).toEqual({ due: 0, cleaned: 0, skipped: 0, blocked: 0 });

        // Belt-and-braces: the generated statement set matches what ran —
        // every scopable table got exactly one DELETE against the real schema.
        expect(buildCleanupStatements().length).toBeGreaterThan(60);
      } finally {
        if (savedRegion === undefined) delete process.env.ATLAS_API_REGION;
        else process.env.ATLAS_API_REGION = savedRegion;
      }
    },
    PG_TEST_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// The import's answer to a fact with no identity (#5047)
// ---------------------------------------------------------------------------

describeIfPg("region import: a fact whose key cannot be supplied (#5047)", () => {
  let pool: Pool;
  const schemaName = `import_unkeyed_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const ORG = "org-unkeyed-import";

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DB_URL });
    pool.on("connect", (client) => {
      void client.query(`SET search_path TO "${schemaName}"`).catch((err) => {
        console.error(
          `import-unkeyed: SET search_path failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    });
    await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
    await runMigrations(pool, { skip: MANAGED_AUTH_MIGRATIONS });
  }, PG_TEST_TIMEOUT_MS);

  afterAll(async () => {
    if (!pool) return;
    await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    await pool.end();
  });

  /**
   * A minimal v3 bundle carrying one episode and one fact.
   *
   * `episodeId` is a parameter because `brain_episodes_pkey` is on `id` alone
   * rather than `(workspace_id, id)`, so two cases reusing one id collide even
   * in different orgs.
   */
  function bundleWith(
    fact: Record<string, unknown>,
    episodeId = "aaaaaaaa-0000-4000-8000-0000000000e1",
  ): Record<string, unknown> {
    return {
      manifest: {
        version: 3,
        exportedAt: new Date().toISOString(),
        source: { label: "region-a" },
        counts: {
          conversations: 0,
          messages: 0,
          semanticEntities: 0,
          learnedPatterns: 0,
          settings: 0,
          brainEpisodes: 1,
          brainFacts: 1,
        },
      },
      conversations: [],
      semanticEntities: [],
      learnedPatterns: [],
      settings: [],
      // Required from v2 on: a producer that claims the version and drops a
      // section is exporter drift, and `validateBundle` refuses it rather than
      // stranding a pillar silently.
      dashboards: [],
      knowledgeDocuments: [],
      scheduledTasks: [],
      agentSessionMemory: [],
      // Facts travel NESTED under their episode — the bundle has no top-level
      // `brainFacts` section, and the episode is the evidence the fact hangs off.
      brainEpisodes: [
        {
          id: episodeId,
          source: "slack",
          sourceId: `unkeyed-import-${episodeId}`,
          sourceActor: "U1",
          body: "evidence",
          locator: null,
          occurredAt: new Date().toISOString(),
          ingestedAt: new Date().toISOString(),
          extractedAt: null,
          visibleTo: ["org"],
          createdAt: new Date().toISOString(),
          facts: [fact],
        },
      ],
      brainEdges: [],
      factAudienceMembers: [],
    };
  }

  const baseFact = {
    id: "aaaaaaaa-0000-4000-8000-0000000000f1",
    // Overwritten per case below, alongside the episode id.
    subject: "billing",
    predicate: "is owned by",
    object: "-",
    subjectKey: "billing",
    predicateKey: "is owned by",
    objectKey: null,
    subjectCmp: null,
    objectCmp: null,
    validFrom: null,
    validTo: null,
    ingestedAt: new Date().toISOString(),
    invalidatedAt: null,
    extractedAt: null,
    sourceEpisodeId: "aaaaaaaa-0000-4000-8000-0000000000e1",
    provenance: { source: "slack", actor: "U1" },
    status: "draft",
    visibleTo: ["org"],
    preWideningVisibleTo: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  async function runImport(body: Record<string, unknown>, org: string) {
    const validation = validateBundle(body);
    if (!validation.ok) throw new Error(`fixture bundle is invalid: ${validation.error}`);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await importBundle(client, validation.bundle, org);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  it(
    "TOMBSTONES a fact whose surface normalizes away, with a per-row placeholder",
    async () => {
      // The one state where a null key is honest: `-` has no identity in any
      // region under any vocabulary, so there is nothing to carry and nothing to
      // compute. Migration 0194 does exactly this to the same state, and this is
      // the second key writer agreeing with it.
      const result = await runImport(bundleWith(baseFact), ORG);
      expect(result.brainFacts.imported).toBe(1);

      const { rows } = await pool.query<{
        subject_key: string;
        predicate_key: string;
        object_key: string;
        invalidated_at: Date | null;
      }>(
        `SELECT subject_key, predicate_key, object_key, invalidated_at
           FROM brain_facts WHERE workspace_id = $1`,
        [ORG],
      );
      expect(rows).toHaveLength(1);
      // Per-row, so two such facts can never share a slot — the difference from
      // the shared sentinel 0187's header rejects.
      expect(rows[0]!.object_key).toBe(`-unkeyable:${baseFact.id}`);
      // The keyable positions keep their CARRIED keys: a row valueless at one
      // slot must not become unreachable at all three.
      expect([rows[0]!.subject_key, rows[0]!.predicate_key]).toEqual(["billing", "is owned by"]);
      // The tombstone is the load-bearing half — all three slot consumers
      // require `invalidated_at IS NULL`, so this is what keeps the placeholder
      // out of every join rather than the key's shape.
      expect(
        rows[0]!.invalidated_at,
        "the placeholder landed LIVE — it is non-null and unequal to every real key, so the `<>` arm now reads it as a rival",
      ).not.toBeNull();
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "REFUSES the import when the key is absent but the surface has one",
    async () => {
      // ⚠️ The falsifier for treating both null-key causes alike, which is what
      // the first cut of #5047 did. This row's surface keys perfectly well, so
      // it is REPAIRABLE — the next drift re-key computes a real key and it
      // rejoins every consumer. Tombstoning it retires a healthy belief that no
      // verb in the product can restore, and re-deriving its key here is what
      // ADR-0037 §8 forbids. Refusing is the only outcome that writes nothing.
      //
      // This is the exporter-drift shape: a projection that stops returning the
      // key columns exports null for every fact, and the destination would
      // otherwise accept the whole corpus with a green 200.
      const REFUSE_ORG = "org-unkeyed-refuse";
      await expect(
        runImport(
          bundleWith(
            {
              ...baseFact,
              id: "aaaaaaaa-0000-4000-8000-0000000000f3",
              object: "platform team",
              objectKey: null,
              sourceEpisodeId: "aaaaaaaa-0000-4000-8000-0000000000e2",
            },
            "aaaaaaaa-0000-4000-8000-0000000000e2",
          ),
          REFUSE_ORG,
        ),
      ).rejects.toBeInstanceOf(RegionImportUnkeyableError);

      // ⚠️ THE POSITION AND THE ROW, not just the type (#5108). `positions` is
      // how an operator finds the offending slot in a bundle of thousands, and
      // without asserting it a mutant that refuses on the WRONG position — the
      // subject, say, which here is `billing` and keys perfectly well —
      // survives every other assertion in this test. `factId` is the same
      // argument for the row.
      await expect(
        runImport(
          bundleWith(
            {
              ...baseFact,
              id: "aaaaaaaa-0000-4000-8000-0000000000f8",
              object: "platform team",
              objectKey: null,
              sourceEpisodeId: "aaaaaaaa-0000-4000-8000-0000000000e8",
            },
            "aaaaaaaa-0000-4000-8000-0000000000e8",
          ),
          "org-unkeyed-refuse-positions",
        ),
      ).rejects.toMatchObject({
        factId: "aaaaaaaa-0000-4000-8000-0000000000f8",
        positions: ["object"],
      });

      // ⚠️ `positions` names the REPAIRABLE positions, not every null one, and
      // this fixture is the only shape that can tell the two apart: the
      // predicate is null AND degenerate (`-` has no key in any region, so
      // nothing to fix), while the object is null and KEYABLE (`platform team`
      // is real text the source region should have carried). `absent` is both;
      // `repairable` is the object alone.
      //
      // Reporting `absent` sends the operator to hunt a predicate key that
      // cannot exist — and the earlier one-null fixture cannot see it, because
      // there the two sets are equal. Measured: that mutation SURVIVED until
      // this case existed.
      await expect(
        runImport(
          bundleWith(
            {
              ...baseFact,
              id: "aaaaaaaa-0000-4000-8000-0000000000fa",
              predicate: "-",
              predicateKey: null,
              object: "platform team",
              objectKey: null,
              sourceEpisodeId: "aaaaaaaa-0000-4000-8000-0000000000ea",
            },
            "aaaaaaaa-0000-4000-8000-0000000000ea",
          ),
          "org-unkeyed-refuse-mixed",
        ),
      ).rejects.toMatchObject({
        factId: "aaaaaaaa-0000-4000-8000-0000000000fa",
        positions: ["object"],
      });

      // Nothing landed — the refusal rolled the whole transaction back, so the
      // episode is gone too rather than left orphaned.
      const { rows: facts } = await pool.query(
        `SELECT 1 FROM brain_facts WHERE workspace_id = $1`,
        [REFUSE_ORG],
      );
      expect(facts).toHaveLength(0);
      const { rows: episodes } = await pool.query(
        `SELECT 1 FROM brain_episodes WHERE workspace_id = $1`,
        [REFUSE_ORG],
      );
      expect(episodes).toHaveLength(0);
    },
    PG_TEST_TIMEOUT_MS,
  );

  // ── The COMPUTED (v1/v2) arm (#5108) ───────────────────────────────────
  //
  // Everything above drives the CARRIED (v3) arm. The legacy arm computes its
  // keys here via `slotKey(surface, vocabulary[position])` and sets
  // `unkeyable: true` — a distinct path, with its own counter and its own
  // refusal type, that nothing exercised.

  /** The same bundle at version 2: no identity fields on the wire at all. */
  function legacyBundleWith(
    fact: Record<string, unknown>,
    episodeId: string,
  ): Record<string, unknown> {
    const v3 = bundleWith(fact, episodeId) as Record<string, unknown>;
    const manifest = { ...(v3.manifest as Record<string, unknown>), version: 2 };
    const episodes = (v3.brainEpisodes as Record<string, unknown>[]).map((episode) => ({
      ...episode,
      facts: (episode.facts as Record<string, unknown>[]).map((f) => {
        // The five identity fields do not exist before v3 — stripped rather
        // than nulled, because a v2 fact that CARRIED them would be a shape no
        // exporter produces and would not exercise the computed arm.
        const {
          subjectKey: _s,
          predicateKey: _p,
          objectKey: _o,
          subjectCmp: _sc,
          objectCmp: _oc,
          ...rest
        } = f;
        return rest;
      }),
    }));
    return { ...v3, manifest, brainEpisodes: episodes };
  }

  it(
    "COMPUTED arm: a degenerate object is tombstoned with a placeholder, and counted as unkeyable",
    async () => {
      // The legacy arm's tombstone, which had no case at all. The distinction
      // from the carried arm is the COUNTER: `unkeyableFacts` says the key was
      // computed HERE and came out null, while `nullKeyFacts` says one arrived
      // null on the wire. A v1/v2 bundle carries no key columns, so the second
      // must be zero — and a counter wired to the wrong arm is invisible
      // without both numbers asserted together.
      const LEGACY_ORG = "org-legacy-tombstone";
      const result = await runImport(
        legacyBundleWith(
          {
            ...baseFact,
            id: "aaaaaaaa-0000-4000-8000-0000000000f5",
            subject: "billing",
            predicate: "is owned by",
            object: "-",
            sourceEpisodeId: "aaaaaaaa-0000-4000-8000-0000000000e5",
          },
          "aaaaaaaa-0000-4000-8000-0000000000e5",
        ),
        LEGACY_ORG,
      );
      // LANDED, not refused — which is the arm's whole behaviour and the thing
      // `ImportResult` can see. The COUNTERS (`unkeyableFacts` / `nullKeyFacts`)
      // are not on `ImportResult`; they travel on the aggregate identity warn,
      // and are asserted on this exact fixture in `migrate-identity-logging.test.ts`
      // where the log is observable.
      expect(result.brainFacts.imported).toBe(1);

      const { rows } = await pool.query<{
        subject_key: string;
        predicate_key: string;
        object_key: string;
        invalidated_at: Date | null;
      }>(
        `SELECT subject_key, predicate_key, object_key, invalidated_at
           FROM brain_facts WHERE workspace_id = $1`,
        [LEGACY_ORG],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.object_key).toBe("-unkeyable:aaaaaaaa-0000-4000-8000-0000000000f5");
      // The other two were COMPUTED, not carried — the surfaces key fine, so
      // they hold real keys and the row is not unreachable at all three slots.
      expect([rows[0]!.subject_key, rows[0]!.predicate_key]).toEqual(["billing", "is owned by"]);
      expect(rows[0]!.invalidated_at).not.toBeNull();
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "COMPUTED arm: under an EMPTY vocabulary a null key always implies a degenerate surface, so it cannot refuse",
    async () => {
      // The asymmetry #5108 asks to assert rather than assume. With no
      // vocabulary entry at the position, `slotKey` reduces to
      // `identityKey(surface)` — so a computed null and a degenerate surface
      // are the same condition, `repairable` is empty, and the arm tombstones
      // instead of throwing.
      //
      // Two surfaces that reach null by different spellings, because the guard
      // tests the KEY and not the text: `String#trim` strips whitespace but
      // neither `_` nor `-`.
      const NO_REFUSE_ORG = "org-legacy-no-refuse";
      const result = await runImport(
        legacyBundleWith(
          {
            ...baseFact,
            id: "aaaaaaaa-0000-4000-8000-0000000000f6",
            subject: "___",
            predicate: "is owned by",
            object: "-",
            sourceEpisodeId: "aaaaaaaa-0000-4000-8000-0000000000e6",
          },
          "aaaaaaaa-0000-4000-8000-0000000000e6",
        ),
        NO_REFUSE_ORG,
      );
      // Landed, not refused — the assertion this case exists for.
      expect(result.brainFacts.imported).toBe(1);
      const { rows } = await pool.query<{ subject_key: string; object_key: string }>(
        `SELECT subject_key, object_key FROM brain_facts WHERE workspace_id = $1`,
        [NO_REFUSE_ORG],
      );
      const placeholder = "-unkeyable:aaaaaaaa-0000-4000-8000-0000000000f6";
      // ONE placeholder value across both degenerate positions of the SAME row,
      // which is what makes it per-row rather than per-slot.
      expect([rows[0]!.subject_key, rows[0]!.object_key]).toEqual([placeholder, placeholder]);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "COMPUTED arm: a VOCABULARY whose target normalizes away DOES refuse, as RegionImportVocabularyTargetError",
    async () => {
      // ⚠️ #5108's parenthetical says the computed arm "can never REFUSE:
      // a computed null implies a degenerate surface". That holds only under an
      // EMPTY vocabulary (the case above). `slotKey` is
      // `identityKey(alias(identityKey(surface)))`, so it reaches null a SECOND
      // way — this region's own closure maps a real norm to something that
      // normalizes away — and on that road the surface keys perfectly well, so
      // `repairable` is non-empty and the arm throws.
      //
      // Far from being unreachable, this is the ONLY arm that can raise
      // `RegionImportVocabularyTargetError`: `tombstonePlaceholder` picks the
      // type off `source.carried`, and `carried: false` IS the legacy arm. The
      // type would be dead code if the claim were true.
      //
      // Written directly to both relations rather than through the authoring
      // seam, because `vocabulary-decide.ts` refuses a `degenerate-norm` target
      // at authoring — which is what keeps this path closed in practice, and
      // exactly what makes the seam unable to build the fixture.
      const VOCAB_ORG = "org-legacy-vocab-refuse";
      await pool.query(
        `INSERT INTO brain_vocabulary_edge
           (workspace_id, slot_position, from_norm, to_norm, approved_by)
         VALUES ($1, 'object', 'platform team', ' - ', '5108-test')`,
        [VOCAB_ORG],
      );
      await pool.query(
        `INSERT INTO brain_vocabulary_target (workspace_id, slot_position, norm, effective_target)
         VALUES ($1, 'object', 'platform team', ' - ')`,
        [VOCAB_ORG],
      );

      await expect(
        runImport(
          legacyBundleWith(
            {
              ...baseFact,
              id: "aaaaaaaa-0000-4000-8000-0000000000f7",
              subject: "billing",
              predicate: "is owned by",
              object: "platform team",
              sourceEpisodeId: "aaaaaaaa-0000-4000-8000-0000000000e7",
            },
            "aaaaaaaa-0000-4000-8000-0000000000e7",
          ),
          VOCAB_ORG,
        ),
      ).rejects.toBeInstanceOf(RegionImportVocabularyTargetError);

      // ⚠️ The TYPE is the whole point, and it is not interchangeable with the
      // carried arm's. `RegionImportUnkeyableError` tells the operator to
      // re-export from the source region and check it has applied 0194 — advice
      // nobody can follow here, because a v1/v2 bundle carries no key columns
      // and re-exporting changes nothing. The defect is a local
      // `brain_vocabulary_target` row. #5047's first cut raised the source-side
      // error from both arms and wedged the migration behind that instruction.
      await expect(
        runImport(
          legacyBundleWith(
            {
              ...baseFact,
              id: "aaaaaaaa-0000-4000-8000-0000000000f9",
              subject: "billing",
              predicate: "is owned by",
              object: "platform team",
              sourceEpisodeId: "aaaaaaaa-0000-4000-8000-0000000000e9",
            },
            "aaaaaaaa-0000-4000-8000-0000000000e9",
          ),
          VOCAB_ORG,
        ),
      ).rejects.not.toBeInstanceOf(RegionImportUnkeyableError);

      // Nothing landed — the refusal writes nothing, which is the only outcome
      // that is reversible.
      const { rows } = await pool.query(`SELECT 1 FROM brain_facts WHERE workspace_id = $1`, [
        VOCAB_ORG,
      ]);
      expect(rows).toHaveLength(0);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "preserves a SOURCE tombstone rather than restamping it",
    async () => {
      // The `COALESCE` on `invalidated_at`. When a claim stopped being a belief
      // is a fact about the corpus, not about the import that moved it.
      const KEEP_ORG = "org-unkeyed-keep";
      const original = "2026-01-02T03:04:05.000Z";
      await runImport(
        bundleWith(
          {
            ...baseFact,
            id: "aaaaaaaa-0000-4000-8000-0000000000f2",
            invalidatedAt: original,
            sourceEpisodeId: "aaaaaaaa-0000-4000-8000-0000000000e3",
          },
          "aaaaaaaa-0000-4000-8000-0000000000e3",
        ),
        KEEP_ORG,
      );

      const { rows } = await pool.query<{ invalidated_at: Date }>(
        `SELECT invalidated_at FROM brain_facts WHERE workspace_id = $1`,
        [KEEP_ORG],
      );
      expect(rows[0]!.invalidated_at.toISOString()).toBe(original);
    },
    PG_TEST_TIMEOUT_MS,
  );
});
