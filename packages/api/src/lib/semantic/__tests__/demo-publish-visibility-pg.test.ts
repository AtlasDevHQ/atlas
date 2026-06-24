/**
 * LIVE-Postgres regression for the demo composer dead-end (#3932, F1).
 *
 * The bug: `/use-demo` imported the curated demo layer as `status='draft'` and
 * relied on the published `__demo__` install to make it "visible". But the
 * published-mode entity read (`listEntityRows(..., 'published')` — the source for
 * BOTH the chat data-setup gate and the agent's whitelist) requires the ENTITY's
 * OWN `status='published'`; a published install alone does NOT surface a draft
 * entity. A fresh signup runs in `published` mode by default, so the curated demo
 * tables were invisible to the gate (→ composer hidden) AND the agent (→ empty
 * whitelist), dead-ending the user at the activation moment.
 *
 * The fix: seed the demo entities as `published` (this file's `seedDemo(...,
 * "published")`). This test pins the exact SQL-level invariant the fix depends
 * on — with the SAME published `__demo__` install, the ENTITY status is the
 * lever:
 *   • published entity → visible in published mode (gate count > 0 AND agent
 *     whitelist non-empty);
 *   • draft entity     → invisible in published mode (the original dead-end),
 * which also proves the install-resolution chain: demo entities resolve
 * `connection_group_id = COALESCE(config->>'group_id', install_id) = '__demo__'`
 * (group-of-one), so published-mode visibility flows through the published-install
 * branch of the `listEntityRows` visibility clause.
 *
 * Skips cleanly when `TEST_DATABASE_URL` is unset (CI sets it; opt in locally
 * with `bun run db:up && export TEST_DATABASE_URL=postgresql://atlas:atlas@localhost:5432/atlas`).
 */

import { afterAll, beforeAll, afterEach, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import { runMigrations } from "@atlas/api/lib/db/migrate";
import {
  MANAGED_AUTH_MIGRATIONS,
  _resetPool,
  internalQuery,
  type InternalPool,
} from "@atlas/api/lib/db/internal";
import { bulkUpsertEntities, listEntityRows } from "@atlas/api/lib/semantic/entities";
import {
  loadOrgWhitelist,
  invalidateOrgWhitelist,
  _resetOrgWhitelists,
  _resetWhitelists,
  _resetPluginEntities,
} from "@atlas/api/lib/semantic/whitelist";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;

if (!TEST_DB_URL) {
  console.warn(
    "demo-publish-visibility-pg: TEST_DATABASE_URL unset — skipping live demo published-mode visibility test (set it to opt in).",
  );
}

const PG_TEST_TIMEOUT_MS = 30_000;
const DEMO_INSTALL = "__demo__";

describeIfPg("demo seed → published-mode visibility (#3932)", () => {
  let pool: Pool;
  const schemaName = `demo_pub_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let prevDatabaseUrl: string | undefined;

  /** Flatten the whitelist Map<connId, Set<table>> into one set of table names. */
  const flatTables = (wl: Map<string, Set<string>>): Set<string> =>
    new Set([...wl.values()].flatMap((s) => [...s]));

  /**
   * Reproduce the /use-demo seed for one org: a PUBLISHED `__demo__` datasource
   * install (no `group_id` → group-of-one keyed under the install id) plus the
   * curated entity imported at `status`. Returns the table name the entity
   * declares (what the whitelist keys on).
   */
  async function seedDemo(orgId: string, status: "draft" | "published"): Promise<string> {
    await pool.query(
      `INSERT INTO workspace_plugins (id, workspace_id, catalog_id, install_id, pillar, config, enabled, status, installed_at)
       VALUES ($1, $2, 'catalog:demo-pg-3932', $3, 'datasource', $4::jsonb, true, 'published', NOW())
       ON CONFLICT (workspace_id, catalog_id, install_id)
         DO UPDATE SET status = 'published', config = EXCLUDED.config`,
      [`${orgId}-${DEMO_INSTALL}`, orgId, DEMO_INSTALL, JSON.stringify({ db_type: "postgres" })],
    );
    const table = "demo_orders";
    await bulkUpsertEntities(
      orgId,
      [{ entityType: "entity", name: table, yamlContent: `table: ${table}\ndescription: Demo orders\n`, connectionId: DEMO_INSTALL }],
      internalQuery,
      status,
    );
    return table;
  }

  beforeAll(async () => {
    prevDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = TEST_DB_URL;
    pool = new Pool({ connectionString: TEST_DB_URL });
    pool.on("connect", (client) => {
      void client.query(`SET search_path TO "${schemaName}"`).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`demo-publish-visibility-pg: SET search_path failed: ${message}`);
      });
    });
    await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
    await runMigrations(pool, { skip: MANAGED_AUTH_MIGRATIONS });
    _resetPool(pool as unknown as InternalPool);

    // Catalog FK target for the demo install rows.
    await pool.query(
      `INSERT INTO plugin_catalog (id, name, slug, type, pillar, install_model)
       VALUES ('catalog:demo-pg-3932', 'Demo Postgres', 'demo-pg-3932', 'datasource', 'datasource', 'form')
       ON CONFLICT (id) DO NOTHING`,
    );
  }, PG_TEST_TIMEOUT_MS * 2);

  afterEach(() => {
    _resetWhitelists();
    _resetOrgWhitelists();
    _resetPluginEntities();
  });

  afterAll(async () => {
    _resetPool(null);
    if (prevDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prevDatabaseUrl;
    await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`demo-publish-visibility-pg: schema cleanup failed: ${message}`);
    });
    await pool.end();
  });

  it("a PUBLISHED demo entity is visible in published mode — gate sees it AND the agent whitelists it", async () => {
    const orgId = `org-pub-3932-${Math.floor(Math.random() * 1e6)}`;
    const table = await seedDemo(orgId, "published");

    // Sanity: the row landed as published, keyed under the group-of-one install.
    const raw = await pool.query<{ status: string; cg: string | null }>(
      `SELECT status, connection_group_id AS cg FROM semantic_entities WHERE org_id = $1 AND name = $2`,
      [orgId, table],
    );
    expect(raw.rows[0]?.status).toBe("published");
    expect(raw.rows[0]?.cg).toBe(DEMO_INSTALL);

    // Gate: the published-mode entity list (what `use-datasource-summary` counts)
    // includes the demo table → tableCount > 0 → composer shown.
    const gateRows = await listEntityRows(orgId, "entity", "published");
    expect(gateRows.map((r) => r.name)).toContain(table);

    // Agent: the published-mode whitelist contains the demo table → the agent can
    // answer the first question instead of "I have no tables".
    invalidateOrgWhitelist(orgId);
    const wl = await loadOrgWhitelist(orgId, "published");
    expect(flatTables(wl).has(table)).toBe(true);
  });

  it("a DRAFT demo entity stays invisible in published mode despite the published install (the original #3932 dead-end)", async () => {
    const orgId = `org-draft-3932-${Math.floor(Math.random() * 1e6)}`;
    const table = await seedDemo(orgId, "draft");

    // The published install is present and published — but the ENTITY is a draft,
    // so the published-mode read filters it out. This is exactly the state the
    // fix moves away from: gate sees 0 (composer hidden) and the agent's
    // whitelist is empty (dead-end).
    const gateRows = await listEntityRows(orgId, "entity", "published");
    expect(gateRows.map((r) => r.name)).not.toContain(table);

    invalidateOrgWhitelist(orgId);
    const wl = await loadOrgWhitelist(orgId, "published");
    expect(flatTables(wl).has(table)).toBe(false);

    // ...and it IS reachable in developer mode (drafts overlay), proving the row
    // persisted and the invisibility is purely the published-mode status gate.
    invalidateOrgWhitelist(orgId);
    const devWl = await loadOrgWhitelist(orgId, "developer");
    expect(flatTables(devWl).has(table)).toBe(true);
  });

  it("re-seeding published is idempotent — ON CONFLICT upserts in place, no duplicate rows", async () => {
    const orgId = `org-reseed-3932-${Math.floor(Math.random() * 1e6)}`;
    const table = await seedDemo(orgId, "published");
    // Second seed must not throw on the published partial unique index, and must
    // not leave a second row — the idempotency the /use-demo comment relies on.
    await seedDemo(orgId, "published");

    const rows = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM semantic_entities
        WHERE org_id = $1 AND name = $2 AND status = 'published'`,
      [orgId, table],
    );
    expect(rows.rows[0]?.count).toBe("1");
  });
});
