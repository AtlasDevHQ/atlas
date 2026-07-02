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

  it("serves the admin documents-list + publish-preview projections against the live schema (#4209)", async () => {
    // These two SELECTs mirror the exact projections the admin surface runs
    // (`GET /api/v1/admin/knowledge/{slug}/documents` and the knowledge slice
    // of `/api/v1/admin/publish-preview`). Exercising them here pins every
    // referenced column name (description, type, tags, to_char(updated_at),
    // the COALESCE label) against real Postgres — the mocked route tests can't.
    const list = await pool.query<{
      id: string;
      path: string;
      title: string | null;
      description: string | null;
      type: string | null;
      tags: unknown;
      status: string;
      updated_at: string | null;
    }>(
      `SELECT id,
              path,
              title,
              description,
              type,
              tags,
              status,
              to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at
         FROM knowledge_documents
        WHERE workspace_id = $1 AND collection_id = 'runbooks' AND status <> 'archived'
        ORDER BY path ASC`,
      [ws],
    );
    // Both freshly-ingested docs are draft, ordered by path.
    expect(list.rows.map((r) => r.path)).toEqual(["glossary/replica.md", "runbooks/eu.md"]);
    expect(list.rows.every((r) => r.status === "draft")).toBe(true);
    expect(list.rows.every((r) => typeof r.updated_at === "string")).toBe(true);
    expect(Array.isArray(list.rows[1]?.tags)).toBe(true);

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
});
