/**
 * LIVE-Postgres create → profile → query coverage for the MCP datasource flow
 * (#3546). This replaces the fully-MOCKED `create → profile → query` assertion
 * that #3512 (PR #3545) shipped: there, `mcp-lifecycle` was mocked, so real
 * end-to-end queryability was never exercised. Here the whole spine runs
 * against a live schema:
 *
 *   1. install a datasource row (`workspace_plugins`, pillar='datasource') —
 *      the "create" half (mirrors what `provisionDatasource` persists);
 *   2. seed a real source table in the same schema;
 *   3. `runSemanticProfile(...)` profiles it, generates the semantic layer,
 *      registers the in-memory whitelist, AND persists the generated entities
 *      to `semantic_entities` as drafts (the #3546 durability path);
 *   4. assert the rows landed as `draft` and that a real `validateSQL` against
 *      a profiled table is PERMITTED — and a non-profiled table is REJECTED.
 *
 * What this catches that the mocked tool tests can't: the persisted-draft rows
 * are actually readable by the cross-process whitelist loader
 * (`loadOrgWhitelist` → `getOrgWhitelistedTables`), proving an MCP-profiled
 * datasource is queryable from the API process (web `/chat`), not just the
 * in-memory MCP process.
 *
 * Skips cleanly when `TEST_DATABASE_URL` is unset (CI sets it; opt in locally
 * with `bun run db:up && export TEST_DATABASE_URL=postgresql://atlas:atlas@localhost:5432/atlas`).
 */

import { afterAll, beforeAll, afterEach, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import * as yaml from "js-yaml";
import { runMigrations } from "@atlas/api/lib/db/migrate";
import { MANAGED_AUTH_MIGRATIONS, _resetPool } from "@atlas/api/lib/db/internal";
import type { InternalPool } from "@atlas/api/lib/db/internal";
import { profileLiveDatasource } from "../mcp-lifecycle";
import type { LiveDatasourceConnection } from "../mcp-lifecycle";
import { profilePostgres, listPostgresObjects } from "@atlas/api/lib/profiler";
import { validateSQL } from "@atlas/api/lib/tools/sql";
import { connections } from "@atlas/api/lib/db/connection";
import {
  invalidateOrgWhitelist,
  _resetOrgWhitelists,
  _resetWhitelists,
  _resetPluginEntities,
} from "@atlas/api/lib/semantic/whitelist";
import { withRequestContext } from "@atlas/api/lib/logger";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;

if (!TEST_DB_URL) {
  // Make the skip reason explicit in the run output rather than silently
  // no-op'ing — this is a real-DB contract test, not an optional extra.
  console.warn(
    "mcp-profile-persist-pg: TEST_DATABASE_URL unset — skipping live create→profile→query test (set it to opt in).",
  );
}

const PG_TEST_TIMEOUT_MS = 30_000;

describeIfPg("MCP create → profile → query (live Postgres, #3546)", () => {
  let pool: Pool;
  // Two schemas: `schemaName` holds the migrated internal-DB tables (the
  // `semantic_entities` / `workspace_plugins` store this process reads); a
  // SEPARATE `srcSchema` holds the single source table the profiler
  // introspects, so the profiler sees ONLY `live_orders` — not the 70+ atlas
  // tables the migrations create.
  const schemaName = `mcp_persist_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const srcSchema = `mcp_src_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const ORG = `org-mcp-persist-${Math.floor(Math.random() * 1e6)}`;
  const INSTALL_ID = "live-pg";
  const GROUP_ID = "g_live";
  // `hasInternalDB()` (the persist + whitelist-load gate) keys on DATABASE_URL.
  // Set it for this file so the durable path runs; restored in afterAll.
  let prevDatabaseUrl: string | undefined;

  // #3667 — profiling now consumes a resolved LiveDatasourceConnection. For a
  // native pg datasource the connection binds the in-core profilers to the
  // resolved url; here we build it directly off the live test DB (the install
  // row carries only the group scope, which `profileLiveDatasource` reads from
  // the connection's `connectionGroupId`).
  const pgLiveConnection = (): LiveDatasourceConnection => ({
    dbType: "postgres",
    connectionGroupId: GROUP_ID,
    query: (sql, timeoutMs) => connections.get(GROUP_ID).query(sql, timeoutMs),
    listObjects: (o) => listPostgresObjects(TEST_DB_URL as string, o?.schema ?? srcSchema),
    profile: (o) =>
      profilePostgres(TEST_DB_URL as string, o.selectedTables, o.prefetchedObjects, o.schema ?? srcSchema, o.progress, o.logger),
    close: async () => {},
  });

  beforeAll(async () => {
    prevDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = TEST_DB_URL;
    pool = new Pool({ connectionString: TEST_DB_URL });
    pool.on("connect", (client) => {
      void client.query(`SET search_path TO "${schemaName}"`).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`mcp-persist-pg: SET search_path failed: ${message}`);
      });
    });
    await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
    await runMigrations(pool, { skip: MANAGED_AUTH_MIGRATIONS });

    // Install this process's internal DB pool so `internalQuery` / `hasInternalDB`
    // (used by the persistence + whitelist-load paths) hit the live test schema.
    _resetPool(pool as unknown as InternalPool);

    // Seed the catalog FK target + the "create" half: a datasource install row
    // bound to GROUP_ID (group-of-one). `runSemanticProfile`'s persistence is
    // scoped DIRECTLY to GROUP_ID, so the whitelist loader resolves it.
    await pool.query(
      `INSERT INTO plugin_catalog (id, name, slug, type, pillar, install_model)
       VALUES ('catalog:mcp-persist-pg', 'Postgres', 'mcp-persist-pg', 'datasource', 'datasource', 'form')
       ON CONFLICT (id) DO NOTHING`,
    );
    await pool.query(
      `INSERT INTO workspace_plugins (id, workspace_id, catalog_id, install_id, pillar, config, enabled, status, installed_at)
       VALUES ($1, $2, 'catalog:mcp-persist-pg', $3, 'datasource',
               $4::jsonb, true, 'draft', NOW())`,
      [`${ORG}-${INSTALL_ID}`, ORG, INSTALL_ID, JSON.stringify({ group_id: GROUP_ID })],
    );

    // A real source table for the profiler to introspect — in its OWN schema so
    // the profiler (which lists every table in the target schema) sees only it.
    await pool.query(`CREATE SCHEMA IF NOT EXISTS "${srcSchema}"`);
    await pool.query(
      `CREATE TABLE "${srcSchema}".live_orders (
         id integer PRIMARY KEY,
         customer text NOT NULL,
         total numeric NOT NULL
       )`,
    );
    await pool.query(
      `INSERT INTO "${srcSchema}".live_orders (id, customer, total)
       VALUES (1, 'acme', 100.0), (2, 'globex', 250.5)`,
    );

    // Register the analytics connection under the SAME key the persisted rows
    // are scoped to (GROUP_ID) so `validateSQL(sql, GROUP_ID, ORG)` resolves the
    // dbType and reads the matching whitelist bucket. Points at the source schema.
    connections.register(GROUP_ID, { url: TEST_DB_URL as string, schema: srcSchema });
  }, PG_TEST_TIMEOUT_MS * 2);

  afterEach(() => {
    _resetWhitelists();
    _resetOrgWhitelists();
    _resetPluginEntities();
    invalidateOrgWhitelist(ORG);
  });

  afterAll(async () => {
    connections.unregister(GROUP_ID);
    // Restore the internal-DB pool to "unconfigured" so later files aren't
    // pinned to this (now-closing) pool.
    _resetPool(null);
    if (prevDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prevDatabaseUrl;
    for (const s of [schemaName, srcSchema]) {
      await pool.query(`DROP SCHEMA IF EXISTS "${s}" CASCADE`).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`mcp-persist-pg: schema cleanup failed for ${s}: ${message}`);
      });
    }
    await pool.end();
  });

  it("persists generated entities as drafts AND makes the profiled table queryable cross-process", async () => {
    const outcome = await profileLiveDatasource({
      connection: pgLiveConnection(),
      schema: srcSchema,
      connectionId: GROUP_ID,
      orgId: ORG,
    });

    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;

    // The generated layer was DURABLY persisted (not just registered in-memory).
    expect(outcome.persisted).not.toBeNull();
    expect(outcome.persisted?.entities).toBeGreaterThanOrEqual(1);

    // The rows landed in `semantic_entities` as DRAFTS, scoped to the group —
    // out of the published `/chat` whitelist until an admin promotes them.
    const rows = await pool.query<{ name: string; status: string; yaml_content: string; cg: string | null }>(
      `SELECT name, status, yaml_content, connection_group_id AS cg
         FROM semantic_entities
        WHERE org_id = $1 AND entity_type = 'entity'`,
      [ORG],
    );
    // The profiler saw ONLY `live_orders` (its own schema), so exactly one
    // entity landed.
    expect(rows.rows).toHaveLength(1);
    const orderRow = rows.rows[0];
    expect(orderRow.name).toContain("live_orders");
    expect(orderRow.status).toBe("draft");
    expect(orderRow.cg).toBe(GROUP_ID);

    // The persisted entity's `table:` is what the whitelist keys on — derive the
    // query from it so the test never drifts from the generator's qualification.
    const parsed = yaml.load(orderRow.yaml_content) as { table?: string };
    const tableRef = parsed.table ?? "live_orders";

    // A real `executeSQL`-path validation, in DEVELOPER mode (drafts overlay),
    // PERMITS the profiled table — proving cross-process queryability via the
    // durable store, not the in-memory MCP whitelist.
    const ok = await withRequestContext(
      { requestId: "test-mcp-persist", atlasMode: "developer" },
      () => validateSQL(`SELECT id, total FROM ${tableRef}`, GROUP_ID, ORG),
    );
    expect(ok.valid).toBe(true);

    // A table that was never profiled is REJECTED by the same validation.
    const rejected = await withRequestContext(
      { requestId: "test-mcp-persist-neg", atlasMode: "developer" },
      () => validateSQL(`SELECT * FROM not_profiled_table`, GROUP_ID, ORG),
    );
    expect(rejected.valid).toBe(false);
  }, PG_TEST_TIMEOUT_MS);

  it("a published-mode whitelist does NOT see the freshly-profiled drafts (status discipline)", async () => {
    // Re-profile is idempotent (ON CONFLICT draft upsert); the rows stay draft.
    await profileLiveDatasource({
      connection: pgLiveConnection(),
      schema: srcSchema,
      connectionId: GROUP_ID,
      orgId: ORG,
    });

    const parsedRows = await pool.query<{ yaml_content: string }>(
      `SELECT yaml_content FROM semantic_entities
        WHERE org_id = $1 AND entity_type = 'entity' AND name LIKE '%live_orders'`,
      [ORG],
    );
    const parsed = yaml.load(parsedRows.rows[0]?.yaml_content ?? "") as { table?: string };
    const tableRef = parsed.table ?? "live_orders";

    // Drop the IN-MEMORY whitelist that profiling also registers (it is not
    // content-mode-aware — it exists for same-process queryability). This test
    // is about the DURABLE store's status discipline, so we isolate it from the
    // in-process layer and the warm developer-mode cache.
    _resetPluginEntities();
    _resetOrgWhitelists();

    // PUBLISHED mode: the persisted rows are drafts, so the profiled table is
    // rejected until an admin promotes it via the atomic publish endpoint.
    const res = await withRequestContext(
      { requestId: "test-mcp-persist-pub", atlasMode: "published" },
      () => validateSQL(`SELECT id FROM ${tableRef}`, GROUP_ID, ORG),
    );
    expect(res.valid).toBe(false);
  }, PG_TEST_TIMEOUT_MS);
});
