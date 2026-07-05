/**
 * Real-Postgres coverage for `searchKnowledge` (#4210). Mirrors the
 * `knowledge-lifecycle-pg.test.ts` harness: skips when `TEST_DATABASE_URL` is
 * unset, runs every migration into a unique per-test schema, ingests real OKF
 * bundles, and executes the REAL search + 1-hop expansion SQL against the live
 * `knowledge_documents` / `knowledge_links` schema.
 *
 * Catches the drift a mock-exec unit test can't: `websearch_to_tsquery` /
 * `to_tsvector` / `ts_headline`, `tags @> …::jsonb` against the GIN index, the
 * quoted `"timestamp"` column, the `array_agg` edge aggregation, and content-mode
 * status gating in both directions.
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
import {
  buildSearchQuery,
  searchKnowledgeCore,
  type KnowledgeQueryExec,
} from "@atlas/api/lib/tools/search-knowledge";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;
const PG_TEST_TIMEOUT_MS = 30_000;
const LIMITS = { maxDocBytes: 1_000_000, maxTotalBytes: 25_000_000 };

function docsFrom(files: Record<string, string>) {
  const zip = zipSync(Object.fromEntries(Object.entries(files).map(([p, c]) => [p, strToU8(c)])));
  const extracted = extractBundle(zip, LIMITS);
  return parseLenientBundle(extracted.files).docs;
}

describeIfPg("searchKnowledge against the live schema", () => {
  let pool: Pool;
  let client: IngestClient;
  let exec: KnowledgeQueryExec;
  const schemaName = `knowledge_search_pg_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const ws = `ws-search-${Date.now()}`;

  async function publish(collectionId: string, path: string) {
    await pool.query(
      `UPDATE knowledge_documents SET status = 'published'
        WHERE workspace_id = $1 AND collection_id = $2 AND path = $3`,
      [ws, collectionId, path],
    );
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DB_URL });
    pool.on("connect", (c) => {
      void c.query(`SET search_path TO "${schemaName}"`).catch((err) => {
        console.error(`knowledge-search-pg: SET search_path failed: ${err instanceof Error ? err.message : String(err)}`);
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
    exec = async (sql, params) => (await pool.query(sql, params)).rows as never;

    // A runbooks collection: eu.md links to replica.md; a draft doc stays hidden.
    const docs = docsFrom({
      "runbooks/eu.md":
        "---\ntype: Runbook\ntitle: EU Failover\ntags: [ops, eu]\ntimestamp: '2026-05-28T00:00:00Z'\n---\n# EU Failover\n\nWhen replica lag exceeds threshold, promote the standby. See [replica notes](../glossary/replica.md).",
      "glossary/replica.md":
        "---\ntype: Document\ntitle: Replica Lag\ntags: [ops]\n---\n# Replica Lag\n\nReplica lag is the delay between primary and standby.",
      "runbooks/secret.md":
        "---\ntype: Runbook\ntitle: Secret Draft\ntags: [ops]\n---\n# Secret Draft\n\nUnpublished replica content that must stay hidden.",
    });
    await ingestBundleIntoCollection({
      client,
      workspaceId: ws,
      collectionId: "runbooks",
      source: "upload",
      docs,
    });
    // Publish two of three; secret.md stays draft.
    await publish("runbooks", "runbooks/eu.md");
    await publish("runbooks", "glossary/replica.md");
  }, PG_TEST_TIMEOUT_MS * 2);

  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`).catch((err) => {
      console.error(`knowledge-search-pg: cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
    });
    await pool.end();
  });

  it("full-text search returns matches with a highlighted snippet and provenance", async () => {
    const res = await searchKnowledgeCore({
      workspaceId: ws,
      mode: "published",
      filters: { query: "replica lag", limit: 10, expand: false },
      exec,
    });
    const eu = res.results.find((r) => r.path === "runbooks/eu.md");
    expect(eu).toBeDefined();
    expect(eu!.provenance.type).toBe("Runbook");
    expect(eu!.provenance.status).toBe("published");
    expect(eu!.snippet).toContain("**");
    expect(eu!.snippet?.toLowerCase()).toContain("replica");
  }, PG_TEST_TIMEOUT_MS);

  it("published mode hides draft documents; developer mode surfaces them", async () => {
    const published = await searchKnowledgeCore({
      workspaceId: ws,
      mode: "published",
      filters: { query: "replica", limit: 10, expand: false },
      exec,
    });
    expect(published.results.some((r) => r.path === "runbooks/secret.md")).toBe(false);

    const developer = await searchKnowledgeCore({
      workspaceId: ws,
      mode: "developer",
      filters: { query: "replica", limit: 10, expand: false },
      exec,
    });
    const secret = developer.results.find((r) => r.path === "runbooks/secret.md");
    expect(secret).toBeDefined();
    expect(secret!.provenance.status).toBe("draft");
  }, PG_TEST_TIMEOUT_MS);

  it("frontmatter filters narrow by type and tag (GIN jsonb containment)", async () => {
    const byTag = await searchKnowledgeCore({
      workspaceId: ws,
      mode: "published",
      filters: { tags: ["eu"], limit: 10, expand: false },
      exec,
    });
    expect(byTag.results.map((r) => r.path)).toEqual(["runbooks/eu.md"]);

    const byType = await searchKnowledgeCore({
      workspaceId: ws,
      mode: "published",
      filters: { type: "Document", limit: 10, expand: false },
      exec,
    });
    expect(byType.results.map((r) => r.path)).toEqual(["glossary/replica.md"]);
  }, PG_TEST_TIMEOUT_MS);

  it("1-hop expansion returns outbound neighbors of the matched seed", async () => {
    const res = await searchKnowledgeCore({
      workspaceId: ws,
      mode: "published",
      filters: { query: "failover", limit: 10, expand: true },
      exec,
    });
    expect(res.results.map((r) => r.path)).toContain("runbooks/eu.md");
    const neighbor = res.neighbors.find((n) => n.path === "glossary/replica.md");
    expect(neighbor).toBeDefined();
    expect(neighbor!.direction).toContain("outbound");
    expect(neighbor!.via).toContain("runbooks/eu.md");
    expect(neighbor!.anchors).toContain("replica notes");
  }, PG_TEST_TIMEOUT_MS);

  it("1-hop expansion returns inbound neighbors (the doc that links to the seed)", async () => {
    const res = await searchKnowledgeCore({
      workspaceId: ws,
      mode: "published",
      // Match only replica.md by a term unique to it.
      filters: { query: "delay between primary", limit: 10, expand: true },
      exec,
    });
    expect(res.results.map((r) => r.path)).toContain("glossary/replica.md");
    const neighbor = res.neighbors.find((n) => n.path === "runbooks/eu.md");
    expect(neighbor).toBeDefined();
    expect(neighbor!.direction).toContain("inbound");
  }, PG_TEST_TIMEOUT_MS);

  it("recency ordering (no query) returns the newest document first", async () => {
    const res = await searchKnowledgeCore({
      workspaceId: ws,
      mode: "published",
      filters: { limit: 10, expand: false },
      exec,
    });
    // Only eu.md and replica.md are published. eu.md carries an explicit
    // 2026-05-28 frontmatter timestamp; replica.md has none and falls back to
    // its ingest time (the same-run ingest, ~now = 2026-07+), so replica.md is
    // the newer of the two and must sort first — this asserts the ORDER BY DESC.
    expect(res.results.length).toBe(2);
    expect(res.results[0].path).toBe("glossary/replica.md");
    expect(res.results[1].path).toBe("runbooks/eu.md");
  }, PG_TEST_TIMEOUT_MS);

  it("a draft neighbor never leaks into published-mode expansion; developer mode surfaces it", async () => {
    // The invariant the module header promises (search-knowledge.ts): the
    // status clause must gate the NEIGHBOR arm of the graph expansion, not
    // just the seed search. A published doc links to one draft and one
    // published neighbor — published mode must expand to the published
    // neighbor only.
    const docs = docsFrom({
      "gate/linker.md":
        "---\ntype: Runbook\ntitle: Gate Linker\n---\n# Gate Linker\n\nunique-gate-token links [draft](./hidden.md) and [open](./open.md).",
      "gate/hidden.md":
        "---\ntype: Document\ntitle: Hidden Draft\n---\n# Hidden Draft\n\ndraft-only gated content",
      "gate/open.md": "---\ntype: Document\ntitle: Open\n---\n# Open\n\npublished neighbor body",
    });
    await ingestBundleIntoCollection({
      client, workspaceId: ws, collectionId: "gate", source: "upload", docs,
    });
    await publish("gate", "gate/linker.md");
    await publish("gate", "gate/open.md");
    // gate/hidden.md stays draft.

    const pub = await searchKnowledgeCore({
      workspaceId: ws,
      mode: "published",
      filters: { query: "unique-gate-token", limit: 10, expand: true },
      exec,
    });
    expect(pub.results.map((r) => r.path)).toEqual(["gate/linker.md"]);
    // Expansion RAN (the published neighbor came back) — the draft one was
    // excluded by status, not by the expansion failing.
    expect(pub.neighbors.map((n) => n.path)).toContain("gate/open.md");
    expect(pub.neighbors.map((n) => n.path)).not.toContain("gate/hidden.md");

    const dev = await searchKnowledgeCore({
      workspaceId: ws,
      mode: "developer",
      filters: { query: "unique-gate-token", limit: 10, expand: true },
      exec,
    });
    const hidden = dev.neighbors.find((n) => n.path === "gate/hidden.md");
    expect(hidden).toBeDefined();
    expect(hidden!.provenance.status).toBe("draft");
  }, PG_TEST_TIMEOUT_MS);

  it("an archived document is invisible to search AND expansion in both modes", async () => {
    // Archive the published neighbor seeded by the test above.
    await pool.query(
      `UPDATE knowledge_documents SET status = 'archived'
        WHERE workspace_id = $1 AND collection_id = 'gate' AND path = 'gate/open.md'`,
      [ws],
    );
    for (const mode of ["published", "developer"] as const) {
      const expanded = await searchKnowledgeCore({
        workspaceId: ws,
        mode,
        filters: { query: "unique-gate-token", limit: 10, expand: true },
        exec,
      });
      expect(expanded.neighbors.map((n) => n.path)).not.toContain("gate/open.md");
      const direct = await searchKnowledgeCore({
        workspaceId: ws,
        mode,
        filters: { query: "published neighbor body", limit: 10, expand: false },
        exec,
      });
      expect(direct.results.map((r) => r.path)).not.toContain("gate/open.md");
    }
  }, PG_TEST_TIMEOUT_MS);

  it("dedupes a neighbor linked from two seeds into one row with merged `via`", async () => {
    // A separate collection where two published seeds both link to the same doc.
    const docs = docsFrom({
      "hub/a.md": "---\ntype: Runbook\ntitle: Alpha Hub\n---\n# Alpha Hub\n\nunique-alpha-token → [shared](./shared.md).",
      "hub/b.md": "---\ntype: Runbook\ntitle: Beta Hub\n---\n# Beta Hub\n\nunique-alpha-token → [shared](./shared.md).",
      "hub/shared.md": "---\ntype: Document\ntitle: Shared\n---\n# Shared\n\ncommon target",
    });
    await ingestBundleIntoCollection({
      client, workspaceId: ws, collectionId: "hub", source: "upload", docs,
    });
    for (const p of ["hub/a.md", "hub/b.md", "hub/shared.md"]) await publish("hub", p);

    const res = await searchKnowledgeCore({
      workspaceId: ws,
      mode: "published",
      filters: { query: "unique-alpha-token", limit: 10, expand: true },
      exec,
    });
    // Both hubs match the seed query; the shared doc is a single neighbor row
    // whose `via` names both seeds (array_agg DISTINCT dedup).
    expect(res.results.map((r) => r.path).sort()).toEqual(["hub/a.md", "hub/b.md"]);
    const shared = res.neighbors.filter((n) => n.path === "hub/shared.md");
    expect(shared).toHaveLength(1);
    expect([...shared[0].via].sort()).toEqual(["hub/a.md", "hub/b.md"]);
  }, PG_TEST_TIMEOUT_MS);

  it("weighted ranking (0167): a title hit outranks a body hit for the same term", async () => {
    // The stored generated `fts` column weights title A / description B /
    // body D, so ts_rank must sort a title match above a body-only match.
    // Before 0167 the vector was unweighted (everything D) and this ordering
    // was undefined — this pins the fold-in.
    const docs = docsFrom({
      "weights/title-hit.md":
        "---\ntype: Document\ntitle: Zephyrite Guide\n---\n# Zephyrite Guide\n\nNothing about the term in the body at all.",
      "weights/body-hit.md":
        "---\ntype: Document\ntitle: Unrelated\n---\n# Unrelated\n\nA passing mention of zephyrite deep in the body.",
    });
    await ingestBundleIntoCollection({
      client, workspaceId: ws, collectionId: "weights", source: "upload", docs,
    });
    await publish("weights", "weights/title-hit.md");
    await publish("weights", "weights/body-hit.md");

    const res = await searchKnowledgeCore({
      workspaceId: ws,
      mode: "published",
      filters: { query: "zephyrite", collection: "weights", limit: 10, expand: false },
      exec,
    });
    expect(res.results.map((r) => r.path)).toEqual([
      "weights/title-hit.md",
      "weights/body-hit.md",
    ]);
  }, PG_TEST_TIMEOUT_MS);

  it("at trigger-condition scale, lexical queries take the GIN bitmap path over idx_knowledge_documents_fts (0167)", async () => {
    // EXPLAIN the EXACT SQL buildSearchQuery emits and assert the planner
    // routes the `kd.fts @@ tsquery` predicate through the 0167 GIN index.
    // At a handful of rows the (workspace_id, *) btrees always win, so this
    // seeds a dedicated workspace at the issue's trigger-condition scale
    // (tens of thousands of documents) — where the GIN bitmap path becomes
    // the plan of choice with NO GUC forcing. This is what a bare-expression
    // drift (or dropping the column back to inline to_tsvector) would break.
    const wsBulk = `ws-bulk-${Date.now()}`;
    await pool.query(
      `INSERT INTO knowledge_documents (workspace_id, collection_id, path, title, body, status)
       SELECT $1, 'bulk', 'filler-' || g || '.md', 'Filler ' || g,
              'routine filler content nothing special entry number ' || g, 'published'
         FROM generate_series(1, 30000) g`,
      [wsBulk],
    );
    await pool.query(
      `INSERT INTO knowledge_documents (workspace_id, collection_id, path, title, body, status)
       VALUES ($1, 'bulk', 'target.md', 'EU Failover',
               'when replica lag exceeds the threshold promote the standby', 'published')`,
      [wsBulk],
    );
    await pool.query(`ANALYZE knowledge_documents`);

    const { sql, params } = buildSearchQuery(wsBulk, "published", {
      query: "replica lag",
      limit: 10,
      expand: false,
    });
    const explained = await pool.query(`EXPLAIN (FORMAT JSON) ${sql}`, params);
    const plan = JSON.stringify(explained.rows[0]["QUERY PLAN"]);
    expect(plan).toContain("Bitmap Index Scan");
    expect(plan).toContain("idx_knowledge_documents_fts");

    // And the plan is not just chosen but correct: the query itself finds
    // exactly the one matching document among 3001.
    const res = await searchKnowledgeCore({
      workspaceId: wsBulk,
      mode: "published",
      filters: { query: "replica lag", limit: 10, expand: false },
      exec,
    });
    expect(res.results.map((r) => r.path)).toEqual(["target.md"]);
  }, PG_TEST_TIMEOUT_MS);
});
