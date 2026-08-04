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
import { recomputeEffectiveTargets } from "@atlas/api/lib/brain/vocabulary";
import { importBundle } from "../../../api/routes/admin-migrate";
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
    await pool.query(
      `INSERT INTO brain_facts (id, workspace_id, subject, predicate, object, valid_from,
                                ingested_at, extracted_at, source_episode_id, provenance,
                                status, visible_to, pre_widening_visible_to,
                                predicate_cardinality)
       VALUES ($1, $2, 'acme:pro-plan', 'price_per_seat', '49',
               '2026-06-01T00:00:00Z', '2026-06-01T00:05:00Z', '2026-06-01T00:05:00Z', $3,
               '{"actor":"U-alice","episode":"C123/1700000000.1"}'::jsonb,
               'published', ARRAY['org'], ARRAY['audience:chat-channel:slack:C-FOUNDERS'],
               'single')`,
      [FACT_ID, SOURCE_ORG, EPISODE_ID],
    );
    await pool.query(
      `INSERT INTO brain_facts (id, workspace_id, subject, predicate, object, valid_from, valid_to,
                                ingested_at, invalidated_at, source_episode_id, provenance,
                                status, visible_to, predicate_cardinality)
       VALUES ($1, $2, 'acme:pro-plan', 'price_per_seat', '39',
               '2026-01-01T00:00:00Z', '2026-06-01T00:00:00Z',
               '2026-01-01T00:00:00Z', '2026-06-01T00:00:00Z', $3,
               '{"actor":"U-bob"}'::jsonb, 'published', ARRAY['org'], 'single')`,
      [SUPERSEDED_FACT_ID, SOURCE_ORG, EPISODE_ID],
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
        brainFacts: 2, // the live claim AND the superseded/tombstoned one
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
      expect(result.brainFacts).toEqual({ imported: 2, skipped: 0 });
      expect(result.brainEdges).toEqual({ imported: 2, skipped: 0 });
      expect(result.factAudienceMembers).toEqual({ imported: 1, skipped: 0 });
      expect(result.brainVocabularyEdges).toEqual({ imported: 2, skipped: 0 });

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
      // closure alone leave both unpinned, and `bundle-scope.ts` calls
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
      expect(brainFact.rows[0].provenance).toEqual({
        actor: "U-alice",
        episode: "C123/1700000000.1",
      });
      expect(brainFact.rows[0].predicate_cardinality).toBe("single");
      // FK re-resolved against the imported episode, UUID preserved.
      expect(brainFact.rows[0].source_episode_id).toBe(EPISODE_ID);

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
        brainFacts: { imported: 0, skipped: 2 },
        brainEdges: { imported: 0, skipped: 2 },
        factAudienceMembers: { imported: 0, skipped: 1 },
        // Skipped on the at-most-one-parent key. A re-import must never apply
        // an arriving edge over a target-region decision — that is the rewrite
        // ADR-0037 §6 forbids, reached through the import door.
        brainVocabularyEdges: { imported: 0, skipped: 2 },
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
      });
      const third = await runImport(catchUp);
      expect(third.brainEpisodes).toEqual({ imported: 0, skipped: 1 });
      expect(third.brainFacts).toEqual({ imported: 1, skipped: 2 });

      const late = await pool.query<{ object: string; source_episode_id: string }>(
        `SELECT object, source_episode_id FROM brain_facts WHERE id = $1 AND workspace_id = $2`,
        [LATE_FACT_ID, TARGET_ORG],
      );
      expect(late.rows).toHaveLength(1);
      expect(late.rows[0].object).toBe("59");
      // Attached to the episode the target already held.
      expect(late.rows[0].source_episode_id).toBe(EPISODE_ID);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "aborts the import when an arriving alias edge would close a cycle with the target's own (#5022)",
    async () => {
      // The importer's documented residual #2, which was documented and never
      // tested. `ON CONFLICT DO NOTHING` deduplicates on the at-most-one-parent
      // key and does NOT look for cycles, so an arriving edge can close one
      // against a decision the destination region already holds.
      //
      // The claim under test is "loud and recoverable beats silent and not":
      // the closure rebuild refuses, and because the whole import is one
      // transaction NOTHING lands — not the edge, and not the pillars imported
      // before it. Refusing the single offending edge instead is #5036's merge
      // semantics, deliberately not implemented here.
      //
      // THREE nodes, for `vocabulary-pg.test.ts`'s reason: at an even
      // MAX_CHAIN_DEPTH a 2-cycle lands every norm back on itself and dies on
      // `ck_..._not_self` instead of the convergence check. Both abort, but only
      // one exercises the guard this test is named for.
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

      const cyclic = {
        manifest: {
          version: 2 as const,
          exportedAt: "2026-06-01T00:00:00Z",
          source: { label: "cycle-test" },
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
            fromNorm: "c",
            toNorm: "a",
            approvedBy: "source-admin",
            approvedAt: "2026-06-01T00:00:00Z",
          },
        ],
      };

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await expect(importBundle(client, cyclic, CYCLE_ORG)).rejects.toThrow(/did not converge/);
        await client.query("ROLLBACK");
      } finally {
        client.release();
      }

      // The target's own vocabulary is exactly as it was — the arriving edge is
      // absent and the closure still resolves to the root it always did.
      const edges = await pool.query<{ from_norm: string }>(
        `SELECT from_norm FROM brain_vocabulary_edge WHERE workspace_id = $1 ORDER BY from_norm`,
        [CYCLE_ORG],
      );
      expect(edges.rows.map((r) => r.from_norm)).toEqual(["a", "b"]);
      const closure = await pool.query<{ norm: string; effective_target: string }>(
        `SELECT norm, effective_target FROM brain_vocabulary_target
          WHERE workspace_id = $1 ORDER BY norm`,
        [CYCLE_ORG],
      );
      expect(closure.rows).toEqual([
        { norm: "a", effective_target: "c" },
        { norm: "b", effective_target: "c" },
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
                                  source_episode_id, provenance, visible_to)
         VALUES ($1, $2, 's', 'p', 'o', $3, '{"actor":"u"}'::jsonb, ARRAY['org'])`,
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
        // The TARGET org's imported brain is untouched — the sweep is scoped
        // to the migrated-away workspace, not to the tables. Three facts: the
        // live one, the tombstoned one, and the catch-up fact from the
        // round-trip block above.
        expect(await countIn(`SELECT count(*)::int AS n FROM brain_facts WHERE workspace_id = $1`, [TARGET_ORG])).toBe(3);

        // Survivors: platform settings row, unattributable cache row, the
        // TARGET org's imported data (seeded by the round-trip test above —
        // these blocks run sequentially in this file), and the returned
        // (guarded) workspace.
        expect(await countIn(`SELECT count(*)::int AS n FROM settings WHERE key = 'cleanup_probe_platform' AND org_id IS NULL`, [])).toBe(1);
        expect(await countIn(`SELECT count(*)::int AS n FROM chat_cache WHERE key = 'response:generic'`, [])).toBe(1);
        expect(await countIn(`SELECT count(*)::int AS n FROM conversations WHERE org_id = $1`, [TARGET_ORG])).toBe(1);
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
