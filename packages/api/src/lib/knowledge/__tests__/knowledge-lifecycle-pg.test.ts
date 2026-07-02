/**
 * Real-Postgres coverage for the Knowledge Base ingest + collection lifecycle
 * (#4207). Mirrors the `persist-form-install-pg.test.ts` harness: skips when
 * `TEST_DATABASE_URL` is unset, runs every migration into a unique per-test
 * schema, and executes the REAL ingest SQL + the exported install-upsert string
 * against the live `knowledge_documents` / `knowledge_links` / `workspace_plugins`
 * schema.
 *
 * Catches the drift class mock-pool tests can't: the quoted `"timestamp"`
 * column, `tags::jsonb`, the `(workspace_id, collection_id, path)` unique upsert
 * key, the multi-instance `pillar='knowledge'` install conflict target, and the
 * `knowledge_links` ON DELETE CASCADE.
 *
 * Opt in locally with:
 *   bun run db:up && export TEST_DATABASE_URL=postgresql://atlas:atlas@localhost:5432/atlas
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import { zipSync, strToU8 } from "fflate";
import { runMigrations } from "@atlas/api/lib/db/migrate";
import { MANAGED_AUTH_MIGRATIONS } from "@atlas/api/lib/db/internal";
import { extractBundle } from "@atlas/api/lib/knowledge/bundle-archive";
import { parseLenientBundle } from "@atlas/api/lib/knowledge/parse-lenient";
import { ingestBundleIntoCollection, type IngestClient } from "@atlas/api/lib/knowledge/ingest";
import { KNOWLEDGE_INSTALL_UPSERT_SQL } from "@atlas/api/lib/integrations/install/okf-upload-form-handler";
import { rowToDoc } from "@atlas/api/lib/knowledge/mirror";
import {
  buildCollectionsQuery,
  buildCollectionDocumentsQuery,
  buildDocumentStatusCountsQuery,
  type KnowledgeDocRowWithBody,
} from "@atlas/api/lib/knowledge/queries";
import {
  BUNDLE_SYNC_CATALOG_ID,
  BUNDLE_SYNC_INSTALL_UPSERT_SQL,
} from "@atlas/api/lib/integrations/install/bundle-sync-form-handler";
import { SYNC_CYCLE_INSTALLS_SQL, SYNC_STATE_UPSERT_SQL } from "@atlas/api/lib/knowledge/sync";
import {
  ARCHIVE_COLLECTION_DOCS_SQL,
  INSTALL_RECHECK_SQL,
} from "@atlas/api/lib/knowledge/collection-lifecycle";
import { SYNC_CREDENTIAL_UPSERT_SQL } from "@atlas/api/lib/knowledge/sync-credentials";
import { CONTENT_MODE_TABLES, makeService } from "@atlas/api/lib/content-mode";
import { Effect } from "effect";
import type { PoolClient } from "pg";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;
const PG_TEST_TIMEOUT_MS = 30_000;
const LIMITS = { maxDocBytes: 1_000_000, maxTotalBytes: 25_000_000 };

function docsFrom(files: Record<string, string>) {
  const zip = zipSync(Object.fromEntries(Object.entries(files).map(([p, c]) => [p, strToU8(c)])));
  const extracted = extractBundle(zip, LIMITS);
  return parseLenientBundle(extracted.files).docs;
}

describeIfPg("knowledge ingest lifecycle against the live schema", () => {
  let pool: Pool;
  let client: IngestClient;
  const schemaName = `knowledge_pg_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const ws = `ws-knowledge-${Date.now()}`;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DB_URL });
    pool.on("connect", (c) => {
      void c.query(`SET search_path TO "${schemaName}"`).catch((err) => {
        console.error(`knowledge-pg: SET search_path failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    });
    await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
    await runMigrations(pool, { skip: MANAGED_AUTH_MIGRATIONS });
    await pool.query(
      `INSERT INTO plugin_catalog (id, name, slug, type, pillar, install_model)
       VALUES ('catalog:okf-upload', 'Knowledge Base (Upload)', 'okf-upload', 'context', 'knowledge', 'form')
       ON CONFLICT (id) DO NOTHING`,
    );
    client = pool as unknown as IngestClient;
  }, PG_TEST_TIMEOUT_MS * 2);

  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`).catch((err) => {
      console.error(`knowledge-pg: cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
    });
    await pool.end();
  });

  it("installs a multi-instance knowledge collection (pillar='knowledge', status='published')", async () => {
    const a = await pool.query<{ id: string }>(KNOWLEDGE_INSTALL_UPSERT_SQL, [
      "row-a",
      ws,
      "catalog:okf-upload",
      "runbooks",
      JSON.stringify({ description: "Ops runbooks" }),
    ]);
    expect(a.rows[0]?.id).toBe("row-a");
    // Re-install same slug → conflict path returns the existing row id.
    const again = await pool.query<{ id: string }>(KNOWLEDGE_INSTALL_UPSERT_SQL, [
      "row-a2",
      ws,
      "catalog:okf-upload",
      "runbooks",
      JSON.stringify({ description: "Ops runbooks v2" }),
    ]);
    expect(again.rows[0]?.id).toBe("row-a");
    // A second slug coexists (multi-instance).
    await pool.query(KNOWLEDGE_INSTALL_UPSERT_SQL, [
      "row-b",
      ws,
      "catalog:okf-upload",
      "product",
      JSON.stringify({}),
    ]);
    const rows = await pool.query<{ install_id: string; pillar: string; status: string }>(
      `SELECT install_id, pillar, status FROM workspace_plugins WHERE workspace_id = $1 ORDER BY install_id`,
      [ws],
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows.every((r) => r.pillar === "knowledge" && r.status === "published")).toBe(true);
  }, PG_TEST_TIMEOUT_MS);

  it("ingests documents as draft, mirroring frontmatter and extracting the link graph", async () => {
    const docs = docsFrom({
      "runbooks/eu.md":
        "---\ntype: Runbook\ntitle: EU\ntags: [eu]\ntimestamp: '2026-05-28T22:49:59+00:00'\n---\n# EU\n\nSee [glossary](../glossary/replica.md).",
      "glossary/replica.md": "# Replica\n\nbody",
    });
    const report = await ingestBundleIntoCollection({
      client,
      workspaceId: ws,
      collectionId: "runbooks",
      source: "upload",
      docs,
    });
    expect(report).toMatchObject({ created: 2, documents: 2, linksWritten: 1 });

    const eu = await pool.query<{ type: string; title: string; tags: string[]; status: string; timestamp: string }>(
      `SELECT type, title, tags, status, "timestamp" FROM knowledge_documents
        WHERE workspace_id = $1 AND collection_id = 'runbooks' AND path = 'runbooks/eu.md'`,
      [ws],
    );
    expect(eu.rows[0]).toMatchObject({ type: "Runbook", title: "EU", status: "draft" });
    expect(eu.rows[0]?.tags).toEqual(["eu"]);

    // A frontmatter-less file is stamped conformant (type Document, title from heading).
    const gloss = await pool.query<{ type: string; title: string }>(
      `SELECT type, title FROM knowledge_documents
        WHERE workspace_id = $1 AND collection_id = 'runbooks' AND path = 'glossary/replica.md'`,
      [ws],
    );
    expect(gloss.rows[0]).toMatchObject({ type: "Document", title: "Replica" });

    const links = await pool.query<{ target_path: string; anchor_text: string }>(
      `SELECT l.target_path, l.anchor_text FROM knowledge_links l
         JOIN knowledge_documents d ON d.id = l.source_document_id
        WHERE d.workspace_id = $1 AND d.path = 'runbooks/eu.md'`,
      [ws],
    );
    expect(links.rows).toEqual([{ target_path: "glossary/replica.md", anchor_text: "glossary" }]);
  }, PG_TEST_TIMEOUT_MS);

  it("serves the admin documents-list, status-counts, and publish-preview projections against the live schema (#4209)", async () => {
    // The documents-list + status-counts reads execute the EXACT exported
    // builders the route runs (`buildCollectionDocumentsQuery` /
    // `buildDocumentStatusCountsQuery` — the reason they're exported); the
    // publish-preview SELECT mirrors the knowledge slice of
    // `/api/v1/admin/publish-preview`. This pins every referenced column name
    // (description, type, tags, to_char(updated_at), the COALESCE label)
    // against real Postgres — the mocked route tests can't.
    const docsQuery = buildCollectionDocumentsQuery(ws, "runbooks");
    const list = await pool.query<{
      id: string;
      path: string;
      title: string | null;
      description: string | null;
      type: string | null;
      tags: unknown;
      status: string;
      updated_at: string | null;
    }>(docsQuery.text, docsQuery.params);
    // Both freshly-ingested docs are draft, ordered by path.
    expect(list.rows.map((r) => r.path)).toEqual(["glossary/replica.md", "runbooks/eu.md"]);
    expect(list.rows.every((r) => r.status === "draft")).toBe(true);
    expect(list.rows.every((r) => typeof r.updated_at === "string")).toBe(true);
    expect(Array.isArray(list.rows[1]?.tags)).toBe(true);

    const countsQuery = buildDocumentStatusCountsQuery(ws);
    const counts = await pool.query<{ collection_id: string; status: string; n: number }>(
      countsQuery.text,
      countsQuery.params,
    );
    const runbookDrafts = counts.rows.find(
      (r) => r.collection_id === "runbooks" && r.status === "draft",
    );
    expect(runbookDrafts?.n).toBe(2);

    const preview = await pool.query<{ id: string; label: string; updated_at: unknown }>(
      `SELECT id::text AS id, COALESCE(NULLIF(title, ''), path) AS label, updated_at
         FROM knowledge_documents
        WHERE workspace_id = $1 AND status = 'draft'
        ORDER BY updated_at DESC`,
      [ws],
    );
    expect(preview.rows).toHaveLength(2);
    // Label falls back to path when there is no frontmatter title; every draft
    // row must carry a non-empty label.
    expect(preview.rows.every((r) => typeof r.label === "string" && r.label.length > 0)).toBe(true);
  }, PG_TEST_TIMEOUT_MS);

  it("keeps unchanged published docs published, demotes changed ones, and upserts by path (no dup)", async () => {
    // Publish the EU doc.
    await pool.query(
      `UPDATE knowledge_documents SET status = 'published'
        WHERE workspace_id = $1 AND collection_id = 'runbooks' AND path = 'runbooks/eu.md'`,
      [ws],
    );

    // Re-ingest identical content → unchanged, stays published.
    const same = docsFrom({
      "runbooks/eu.md":
        "---\ntype: Runbook\ntitle: EU\ntags: [eu]\ntimestamp: '2026-05-28T22:49:59+00:00'\n---\n# EU\n\nSee [glossary](../glossary/replica.md).",
    });
    const r1 = await ingestBundleIntoCollection({
      client, workspaceId: ws, collectionId: "runbooks", source: "upload", docs: same,
    });
    expect(r1).toMatchObject({ unchanged: 1, demoted: 0 });
    const stillPub = await pool.query<{ status: string }>(
      `SELECT status FROM knowledge_documents WHERE workspace_id = $1 AND path = 'runbooks/eu.md'`,
      [ws],
    );
    expect(stillPub.rows[0]?.status).toBe("published");

    // Re-ingest CHANGED content → demoted back to draft.
    const changed = docsFrom({
      "runbooks/eu.md": "---\ntype: Runbook\ntitle: EU\ntags: [eu]\n---\n# EU (updated)\n",
    });
    const r2 = await ingestBundleIntoCollection({
      client, workspaceId: ws, collectionId: "runbooks", source: "upload", docs: changed,
    });
    expect(r2).toMatchObject({ demoted: 1 });

    // Upsert-by-path: exactly one row for the path (no duplicate insert).
    const count = await pool.query<{ n: string }>(
      `SELECT COUNT(*)::int AS n FROM knowledge_documents
        WHERE workspace_id = $1 AND collection_id = 'runbooks' AND path = 'runbooks/eu.md'`,
      [ws],
    );
    expect(Number(count.rows[0]?.n)).toBe(1);
  }, PG_TEST_TIMEOUT_MS);

  it("archives on uninstall, and re-ingest resurrects to draft (not silently)", async () => {
    // Uninstall archive (the route's UPDATE shape).
    const archived = await pool.query<{ id: string }>(
      `UPDATE knowledge_documents SET status = 'archived', updated_at = NOW()
        WHERE workspace_id = $1 AND collection_id = 'runbooks' AND status <> 'archived'
        RETURNING id`,
      [ws],
    );
    expect(archived.rows.length).toBeGreaterThan(0);
    const anyLive = await pool.query<{ n: string }>(
      `SELECT COUNT(*)::int AS n FROM knowledge_documents
        WHERE workspace_id = $1 AND collection_id = 'runbooks' AND status <> 'archived'`,
      [ws],
    );
    expect(Number(anyLive.rows[0]?.n)).toBe(0);

    // Explicit re-upload resurrects the archived path to draft.
    const docs = docsFrom({ "runbooks/eu.md": "---\ntype: Runbook\ntitle: EU\n---\n# EU\n" });
    const report = await ingestBundleIntoCollection({
      client, workspaceId: ws, collectionId: "runbooks", source: "upload", docs,
    });
    expect(report).toMatchObject({ resurrected: 1 });
    const status = await pool.query<{ status: string }>(
      `SELECT status FROM knowledge_documents WHERE workspace_id = $1 AND path = 'runbooks/eu.md'`,
      [ws],
    );
    expect(status.rows[0]?.status).toBe("draft");
  }, PG_TEST_TIMEOUT_MS);

  it("re-installing a collection does NOT resurrect archived documents (only ingest does)", async () => {
    // Archive everything, then re-run the install upsert — the container comes
    // back but the documents must stay archived (ADR-0028 §5, no silent resurrect).
    await pool.query(
      `UPDATE knowledge_documents SET status = 'archived'
        WHERE workspace_id = $1 AND collection_id = 'runbooks'`,
      [ws],
    );
    await pool.query(KNOWLEDGE_INSTALL_UPSERT_SQL, [
      "row-a3",
      ws,
      "catalog:okf-upload",
      "runbooks",
      JSON.stringify({}),
    ]);
    const live = await pool.query<{ n: string }>(
      `SELECT COUNT(*)::int AS n FROM knowledge_documents
        WHERE workspace_id = $1 AND collection_id = 'runbooks' AND status <> 'archived'`,
      [ws],
    );
    expect(Number(live.rows[0]?.n)).toBe(0); // install touched only workspace_plugins
  }, PG_TEST_TIMEOUT_MS);

  it("cascades knowledge_links when a document is deleted, and scopes paths per collection", async () => {
    // Same path in a DIFFERENT collection is a separate row (unique is per collection).
    const otherDocs = docsFrom({ "runbooks/eu.md": "# Other collection copy\n" });
    await ingestBundleIntoCollection({
      client, workspaceId: ws, collectionId: "product", source: "upload", docs: otherDocs,
    });
    const both = await pool.query<{ n: string }>(
      `SELECT COUNT(*)::int AS n FROM knowledge_documents
        WHERE workspace_id = $1 AND path = 'runbooks/eu.md'`,
      [ws],
    );
    expect(Number(both.rows[0]?.n)).toBe(2);

    // Link cascade: delete the glossary target's SOURCE doc and confirm its links go.
    const src = await pool.query<{ id: string }>(
      `SELECT id FROM knowledge_documents
        WHERE workspace_id = $1 AND collection_id = 'runbooks' AND path = 'runbooks/eu.md'`,
      [ws],
    );
    const sourceId = src.rows[0]?.id;
    // Re-ingest a version WITH a link so there is an edge to cascade.
    await ingestBundleIntoCollection({
      client, workspaceId: ws, collectionId: "runbooks", source: "upload",
      docs: docsFrom({ "runbooks/eu.md": "# EU\n[g](../glossary/replica.md)" }),
    });
    await pool.query(`DELETE FROM knowledge_documents WHERE id = $1`, [sourceId]);
    const remaining = await pool.query<{ n: string }>(
      `SELECT COUNT(*)::int AS n FROM knowledge_links WHERE source_document_id = $1`,
      [sourceId],
    );
    expect(Number(remaining.rows[0]?.n)).toBe(0);
  }, PG_TEST_TIMEOUT_MS);

  it("the serving read (#4208) applies content-mode: published excludes drafts, developer includes them", async () => {
    // Fresh collection so this case is independent of the lifecycle above.
    await pool.query(KNOWLEDGE_INSTALL_UPSERT_SQL, [
      "row-serving",
      ws,
      "catalog:okf-upload",
      "serving",
      JSON.stringify({}),
    ]);
    await ingestBundleIntoCollection({
      client,
      workspaceId: ws,
      collectionId: "serving",
      source: "upload",
      docs: docsFrom({
        "pub.md": "---\ntype: Runbook\ntitle: Pub\ntags: [ops]\ntimestamp: '2026-05-28T22:49:59+00:00'\n---\n# Pub\n\nbody",
        "draft.md": "# Draft\n\nbody",
      }),
    });
    // Publish only pub.md.
    await pool.query(
      `UPDATE knowledge_documents SET status = 'published'
        WHERE workspace_id = $1 AND collection_id = 'serving' AND path = 'pub.md'`,
      [ws],
    );

    // The REAL serving SELECT (quoted "timestamp" alias, atlas_* columns, status
    // clause) against the live schema — published mode sees only the published doc.
    const pub = buildCollectionsQuery(ws, "published", "serving");
    const pubRows = (await pool.query<KnowledgeDocRowWithBody>(pub.text, pub.params)).rows;
    expect(pubRows.map((r) => r.path)).toEqual(["pub.md"]);
    // The read→map path produces a conformant MirrorDoc with provenance + timestamp.
    const doc = rowToDoc(pubRows[0]);
    expect(doc.type).toBe("Runbook");
    expect(doc.atlasSource).toBe("upload");
    expect(doc.atlasIngestedAt).not.toBeNull();
    expect(doc.timestamp).toBe("2026-05-28T22:49:59.000Z");

    // Developer mode overlays the draft.
    const dev = buildCollectionsQuery(ws, "developer", "serving");
    const devRows = (await pool.query<KnowledgeDocRowWithBody>(dev.text, dev.params)).rows;
    expect(devRows.map((r) => r.path).sort()).toEqual(["draft.md", "pub.md"]);
  }, PG_TEST_TIMEOUT_MS);

  // ── Bundle sync (#4211): the 0164 tables + the exported SQL strings ───────

  it("installs a bundle-sync collection and upserts its credential + sync-state rows (0164)", async () => {
    await pool.query(
      `INSERT INTO plugin_catalog (id, name, slug, type, pillar, install_model)
       VALUES ('catalog:bundle-sync', 'Knowledge Base (Bundle Sync)', 'bundle-sync', 'context', 'knowledge', 'form')
       ON CONFLICT (id) DO NOTHING`,
    );
    const installed = await pool.query<{ id: string }>(BUNDLE_SYNC_INSTALL_UPSERT_SQL, [
      "row-sync",
      ws,
      "catalog:bundle-sync",
      "synced-docs",
      JSON.stringify({ endpoint_url: "https://kb.example.com/bundle.tar.gz", auth_scheme: "bearer" }),
    ]);
    expect(installed.rows[0]?.id).toBe("row-sync");

    // Credential upsert: second write for the same collection REPLACES (unique
    // on (workspace_id, collection_id)), never duplicates.
    await pool.query(SYNC_CREDENTIAL_UPSERT_SQL, [ws, "synced-docs", "enc:v1:aaa", 1]);
    await pool.query(SYNC_CREDENTIAL_UPSERT_SQL, [ws, "synced-docs", "enc:v1:bbb", 1]);
    const creds = await pool.query<{ auth_secret_encrypted: string }>(
      `SELECT auth_secret_encrypted FROM knowledge_sync_credentials
        WHERE workspace_id = $1 AND collection_id = 'synced-docs'`,
      [ws],
    );
    expect(creds.rows).toHaveLength(1);
    expect(creds.rows[0]?.auth_secret_encrypted).toBe("enc:v1:bbb");

    // Sync-state upsert: error then success — one row, latest wins; the CHECK
    // pins the status enum.
    await pool.query(SYNC_STATE_UPSERT_SQL, [ws, "synced-docs", "error", "HTTP 403", null]);
    await pool.query(SYNC_STATE_UPSERT_SQL, [
      ws,
      "synced-docs",
      "success",
      null,
      JSON.stringify({ documents: { created: 2 } }),
    ]);
    const state = await pool.query<{ status: string; error: string | null }>(
      `SELECT status, error FROM knowledge_sync_state
        WHERE workspace_id = $1 AND collection_id = 'synced-docs'`,
      [ws],
    );
    expect(state.rows).toHaveLength(1);
    expect(state.rows[0]).toMatchObject({ status: "success", error: null });
    await expect(
      pool.query(SYNC_STATE_UPSERT_SQL, [ws, "synced-docs", "bogus", null, null]),
    ).rejects.toThrow(/chk_knowledge_sync_state_status/);

    // The admin list route's sync-state projection (to_char / column names)
    // against the live schema — the same drift class the documents-list
    // projection test above exists for (#4209).
    const projection = await pool.query<{
      collection_id: string;
      last_sync_at: string;
      status: string;
      error: string | null;
    }>(
      `SELECT collection_id,
              to_char(last_sync_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS last_sync_at,
              status,
              error
         FROM knowledge_sync_state
        WHERE workspace_id = $1`,
      [ws],
    );
    expect(projection.rows).toHaveLength(1);
    expect(projection.rows[0]?.collection_id).toBe("synced-docs");
    expect(projection.rows[0]?.last_sync_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  }, PG_TEST_TIMEOUT_MS);

  it("the cycle's install listing returns ONLY enabled, non-archived bundle-sync installs (#4211)", async () => {
    // Alongside the enabled 'synced-docs' install from the test above, seed a
    // disabled and an archived bundle-sync install. The okf-upload installs
    // (runbooks/product/serving) are already present — the catalog_id filter
    // must exclude them too.
    await pool.query(BUNDLE_SYNC_INSTALL_UPSERT_SQL, [
      "row-sync-disabled",
      ws,
      "catalog:bundle-sync",
      "disabled-docs",
      JSON.stringify({ endpoint_url: "https://kb.example.com/d.zip", auth_scheme: "none" }),
    ]);
    await pool.query(
      `UPDATE workspace_plugins SET enabled = false WHERE workspace_id = $1 AND install_id = 'disabled-docs'`,
      [ws],
    );
    await pool.query(BUNDLE_SYNC_INSTALL_UPSERT_SQL, [
      "row-sync-archived",
      ws,
      "catalog:bundle-sync",
      "archived-docs",
      JSON.stringify({ endpoint_url: "https://kb.example.com/a.zip", auth_scheme: "none" }),
    ]);
    await pool.query(
      `UPDATE workspace_plugins SET status = 'archived', enabled = false
        WHERE workspace_id = $1 AND install_id = 'archived-docs'`,
      [ws],
    );

    const installs = await pool.query<{ install_id: string; config: unknown }>(
      SYNC_CYCLE_INSTALLS_SQL,
      [BUNDLE_SYNC_CATALOG_ID],
    );
    expect(installs.rows.map((r) => r.install_id)).toEqual(["synced-docs"]);
  }, PG_TEST_TIMEOUT_MS);

  it("the uninstall × sync race guards hold against the live schema", async () => {
    // The in-transaction re-check sees the live install…
    const live = await pool.query<{ status: string }>(INSTALL_RECHECK_SQL, [
      ws,
      "synced-docs",
    ]);
    expect(live.rows[0]?.status).toBe("published");

    // …and the guarded state upsert refuses to write a row for an archived
    // install (the uninstall just hard-deleted its sync state; a racing sync
    // must not re-create it).
    await pool.query(BUNDLE_SYNC_INSTALL_UPSERT_SQL, [
      "row-sync-ghost",
      ws,
      "catalog:bundle-sync",
      "ghost-docs",
      JSON.stringify({ endpoint_url: "https://kb.example.com/g.zip", auth_scheme: "none" }),
    ]);
    await pool.query(
      `UPDATE workspace_plugins SET status = 'archived', enabled = false
        WHERE workspace_id = $1 AND install_id = 'ghost-docs'`,
      [ws],
    );
    const gone = await pool.query<{ status: string }>(INSTALL_RECHECK_SQL, [ws, "ghost-docs"]);
    expect(gone.rows[0]?.status).toBe("archived");
    await pool.query(SYNC_STATE_UPSERT_SQL, [ws, "ghost-docs", "success", null, null]);
    const state = await pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM knowledge_sync_state
        WHERE workspace_id = $1 AND collection_id = 'ghost-docs'`,
      [ws],
    );
    expect(state.rows[0]?.n).toBe(0);
  }, PG_TEST_TIMEOUT_MS);

  it("the REAL publish phases promote knowledge drafts against the live schema (#4206)", async () => {
    // Publish is workspace-wide, so use a dedicated workspace — the shared `ws`
    // carries leftover drafts from the lifecycle tests above and would skew the
    // promoted count.
    const wsPromote = `${ws}-promote`;
    await pool.query(KNOWLEDGE_INSTALL_UPSERT_SQL, [
      "row-promote",
      wsPromote,
      "catalog:okf-upload",
      "promote-docs",
      JSON.stringify({}),
    ]);
    await ingestBundleIntoCollection({
      client,
      workspaceId: wsPromote,
      collectionId: "promote-docs",
      source: "upload",
      docs: docsFrom({ "a.md": "# A", "b.md": "# B" }),
    });

    // Run the SAME registry promote the atomic publish endpoint runs, inside a
    // real transaction — this executes the derived
    // `UPDATE knowledge_documents … SET status='published'` against Postgres,
    // which no mocked route test can pin.
    const registry = makeService(CONTENT_MODE_TABLES);
    const txClient = await pool.connect();
    let reports: ReadonlyArray<{ table: string; promoted: number }>;
    try {
      await txClient.query("BEGIN");
      reports = await Effect.runPromise(
        registry.runPublishPhases(txClient as unknown as PoolClient, wsPromote),
      );
      await txClient.query("COMMIT");
    } catch (err) {
      await txClient.query("ROLLBACK");
      throw err;
    } finally {
      txClient.release();
    }

    const knowledgeReport = reports.find((r) => r.table === "knowledge_documents");
    expect(knowledgeReport?.promoted).toBe(2);
    const statuses = await pool.query<{ status: string }>(
      `SELECT status FROM knowledge_documents
        WHERE workspace_id = $1 AND collection_id = 'promote-docs'`,
      [wsPromote],
    );
    expect(statuses.rows).toHaveLength(2);
    expect(statuses.rows.every((r) => r.status === "published")).toBe(true);
  }, PG_TEST_TIMEOUT_MS);

  it("archives absent paths via ARCHIVE_COLLECTION_DOCS_SQL without touching present or rejected paths", async () => {
    await ingestBundleIntoCollection({
      client,
      workspaceId: ws,
      collectionId: "synced-docs",
      source: "bundle-sync",
      docs: docsFrom({ "keep.md": "# keep", "gone.md": "# gone", "broken.md": "# broken" }),
    });
    // Next pull: keep.md present, broken.md present-but-rejected, gone.md absent.
    const archived = await pool.query<{ id: string }>(ARCHIVE_COLLECTION_DOCS_SQL, [
      ws,
      "synced-docs",
      ["keep.md", "broken.md"],
    ]);
    expect(archived.rows).toHaveLength(1);
    const statuses = await pool.query<{ path: string; status: string }>(
      `SELECT path, status FROM knowledge_documents
        WHERE workspace_id = $1 AND collection_id = 'synced-docs' ORDER BY path`,
      [ws],
    );
    expect(statuses.rows).toEqual([
      { path: "broken.md", status: "draft" },
      { path: "gone.md", status: "archived" },
      { path: "keep.md", status: "draft" },
    ]);
    // The provenance source landed as bundle-sync.
    const src = await pool.query<{ atlas_source: string }>(
      `SELECT atlas_source FROM knowledge_documents
        WHERE workspace_id = $1 AND collection_id = 'synced-docs' AND path = 'keep.md'`,
      [ws],
    );
    expect(src.rows[0]?.atlas_source).toBe("bundle-sync");
  }, PG_TEST_TIMEOUT_MS);
});
