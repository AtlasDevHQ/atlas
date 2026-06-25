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
  getOrgWhitelistedTables,
  invalidateOrgWhitelist,
  _resetOrgWhitelists,
  _resetWhitelists,
  _resetPluginEntities,
} from "@atlas/api/lib/semantic/whitelist";
import { connections } from "@atlas/api/lib/db/connection";
import { withRequestContext } from "@atlas/api/lib/logger";
import { validateSQL } from "@atlas/api/lib/tools/sql";

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

/**
 * LIVE-Postgres regression for the demo first-answer dead-end (#3947).
 *
 * The agent loop's `executeSQL` validates against `getOrgWhitelistedTables(orgId,
 * connectionId, mode)` where, for a fresh conversation with no pinned connection,
 * `connectionId` collapses to the literal `"default"` (sql.ts: `currentMember =
 * groupTargetMember ?? connectionId ?? requestContextConnectionId ?? "default"`).
 * Demo entities, however, are keyed under their `connection_group_id` (`__demo__`
 * for a group-of-one demo install), NOT `"default"`. The single-connection
 * fallback that bridged this (#2142) only fires when the org has EXACTLY ONE
 * connection bucket — so the moment a second bucket exists (the demo install
 * carries an explicit `config.group_id`, or a second datasource is connected),
 * the `"default"` lookup returns the empty set and the agent rejects every demo
 * table as "not in the allowed list" — while `GET /api/v1/tables`, which resolves
 * through `resolveAllowedTables` with the demo connection id, still lists them.
 *
 * The fix broadens the unpinned-`"default"` fallback in `getOrgWhitelistedTables`
 * to the UNION of every org bucket (the "All sources" reach an unpinned default
 * query has), so the query-time whitelist resolves the SAME table set the demo
 * workspace advertises — for one OR many connection buckets.
 *
 * These tests pin the exact lookup `executeSQL` performs (`connectionId =
 * "default"`) against the realistic multi-bucket shapes, so a regression that
 * re-narrows the fallback fails here.
 */
describeIfPg("demo first-answer: executeSQL whitelist resolves the demo tables (#3947)", () => {
  let pool: Pool;
  const schemaName = `demo_3947_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let prevDatabaseUrl: string | undefined;

  /** Insert a published datasource install for one org. */
  async function install(orgId: string, installId: string, config: Record<string, unknown>): Promise<void> {
    await pool.query(
      `INSERT INTO workspace_plugins (id, workspace_id, catalog_id, install_id, pillar, config, enabled, status, installed_at)
       VALUES ($1, $2, 'catalog:demo-3947', $3, 'datasource', $4::jsonb, true, 'published', NOW())
       ON CONFLICT (workspace_id, catalog_id, install_id)
         DO UPDATE SET status = 'published', config = EXCLUDED.config`,
      [`${orgId}-${installId}`, orgId, installId, JSON.stringify(config)],
    );
  }

  /** Import published entities scoped to one connection install. */
  async function seedEntities(orgId: string, installId: string, tables: string[]): Promise<void> {
    await bulkUpsertEntities(
      orgId,
      tables.map((t) => ({
        entityType: "entity" as const,
        name: t,
        yamlContent: `table: ${t}\ndescription: ${t}\n`,
        connectionId: installId,
      })),
      internalQuery,
      "published",
    );
  }

  beforeAll(async () => {
    prevDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = TEST_DB_URL;
    pool = new Pool({ connectionString: TEST_DB_URL });
    pool.on("connect", (client) => {
      void client.query(`SET search_path TO "${schemaName}"`).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`demo-3947: SET search_path failed: ${message}`);
      });
    });
    await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
    await runMigrations(pool, { skip: MANAGED_AUTH_MIGRATIONS });
    _resetPool(pool as unknown as InternalPool);
    await pool.query(
      `INSERT INTO plugin_catalog (id, name, slug, type, pillar, install_model)
       VALUES ('catalog:demo-3947', 'Demo Postgres', 'demo-3947', 'datasource', 'datasource', 'form')
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
      console.error(`demo-3947: schema cleanup failed: ${message}`);
    });
    await pool.end();
  });

  const DEMO_TABLES = ["order_items", "products", "categories", "orders"];

  it("single demo connection: the unpinned `default` lookup resolves the demo tables (baseline #2142)", async () => {
    const orgId = `org-3947-single-${Math.floor(Math.random() * 1e6)}`;
    await install(orgId, DEMO_INSTALL, { db_type: "postgres" }); // group-of-one, no group_id
    await seedEntities(orgId, DEMO_INSTALL, DEMO_TABLES);

    invalidateOrgWhitelist(orgId);
    await loadOrgWhitelist(orgId, "published");
    // What executeSQL asks for on a fresh conversation: connectionId === "default".
    const allowed = getOrgWhitelistedTables(orgId, "default", "published");
    for (const t of DEMO_TABLES) expect(allowed.has(t)).toBe(true);
  });

  it("demo install with an explicit config.group_id: unpinned `default` STILL resolves the demo tables (the #3947 dead-end)", async () => {
    // Two whitelist buckets land for this org: the entity's resolved
    // `connection_group_id` (the explicit group) AND that group's member
    // install id. `byConnection.size > 1`, so the old single-connection
    // fallback could not fire and `getOrgWhitelistedTables(orgId, "default")`
    // returned EMPTY — every demo table rejected on the user's first query.
    const orgId = `org-3947-groupid-${Math.floor(Math.random() * 1e6)}`;
    await install(orgId, DEMO_INSTALL, { db_type: "postgres", group_id: "grp_demo" });
    await seedEntities(orgId, DEMO_INSTALL, DEMO_TABLES);

    invalidateOrgWhitelist(orgId);
    const wl = await loadOrgWhitelist(orgId, "published");
    expect(wl.size).toBeGreaterThan(1); // pin the multi-bucket shape that broke the old fallback

    const allowed = getOrgWhitelistedTables(orgId, "default", "published");
    for (const t of DEMO_TABLES) {
      expect(allowed.has(t)).toBe(true);
    }
  });

  it("demo + a second datasource: unpinned `default` resolves the UNION of both (no more empty set)", async () => {
    // A fresh workspace that connected the demo AND a real datasource has two
    // buckets. The unpinned `default` agent query (reach = All sources) must
    // see every reachable table, not nothing.
    const orgId = `org-3947-multi-${Math.floor(Math.random() * 1e6)}`;
    await install(orgId, DEMO_INSTALL, { db_type: "postgres" });
    await install(orgId, "warehouse", { db_type: "postgres" });
    await seedEntities(orgId, DEMO_INSTALL, ["order_items", "products"]);
    await seedEntities(orgId, "warehouse", ["widgets"]);

    invalidateOrgWhitelist(orgId);
    const wl = await loadOrgWhitelist(orgId, "published");
    expect(wl.size).toBeGreaterThan(1);

    const allowed = getOrgWhitelistedTables(orgId, "default", "published");
    expect(allowed.has("order_items")).toBe(true);
    expect(allowed.has("products")).toBe(true);
    expect(allowed.has("widgets")).toBe(true);
  });

  it("a PINNED connection id is NOT widened — it still sees only its own bucket (isolation preserved)", async () => {
    // The broadened fallback fires only for the unpinned `default` sentinel.
    // A query pinned to a specific connection must keep seeing exactly that
    // connection's tables — never the union — or cross-connection isolation
    // would regress.
    const orgId = `org-3947-pinned-${Math.floor(Math.random() * 1e6)}`;
    await install(orgId, DEMO_INSTALL, { db_type: "postgres" });
    await install(orgId, "warehouse", { db_type: "postgres" });
    await seedEntities(orgId, DEMO_INSTALL, ["order_items", "products"]);
    await seedEntities(orgId, "warehouse", ["widgets"]);

    invalidateOrgWhitelist(orgId);
    await loadOrgWhitelist(orgId, "published");

    const demoOnly = getOrgWhitelistedTables(orgId, DEMO_INSTALL, "published");
    expect(demoOnly.has("order_items")).toBe(true);
    expect(demoOnly.has("widgets")).toBe(false); // the warehouse table must NOT leak into the demo connection

    const warehouseOnly = getOrgWhitelistedTables(orgId, "warehouse", "published");
    expect(warehouseOnly.has("widgets")).toBe(true);
    expect(warehouseOnly.has("order_items")).toBe(false);
  });

  it("a real `default` bucket short-circuits the union — direct hit wins even with a second bucket", async () => {
    // An org that genuinely has a `default`-keyed bucket (an entity scoped to a
    // connection with no `workspace_plugins` install row → resolves to the flat
    // NULL/`default` group) alongside the demo bucket must, on a `default`
    // lookup, return ONLY the `default` bucket — never the union. Guards against
    // a future "simplification" of the `!byConnection.has("default")` guard that
    // would let the union fire and silently widen a non-demo org's first query.
    const orgId = `org-3947-realdefault-${Math.floor(Math.random() * 1e6)}`;
    await install(orgId, DEMO_INSTALL, { db_type: "postgres" });
    // No install row for "default" → entity keys under the flat `default` bucket.
    await seedEntities(orgId, "default", ["base_users"]);
    await seedEntities(orgId, DEMO_INSTALL, ["order_items"]);

    invalidateOrgWhitelist(orgId);
    const wl = await loadOrgWhitelist(orgId, "published");
    expect(wl.has("default")).toBe(true);
    expect(wl.size).toBeGreaterThan(1);

    const allowed = getOrgWhitelistedTables(orgId, "default", "published");
    expect(allowed.has("base_users")).toBe(true);
    expect(allowed.has("order_items")).toBe(false); // the demo bucket must NOT be unioned in when a real default exists
  });

  it("an org with no entities resolves the unpinned `default` to an empty set (fail-closed)", async () => {
    // The `byConnection.size >= 1` guard means a loaded-but-empty org never
    // accidentally unions a non-existent bucket. With no entities, the `default`
    // lookup must be empty — every query rejected, fail-closed.
    const orgId = `org-3947-empty-${Math.floor(Math.random() * 1e6)}`;
    await install(orgId, DEMO_INSTALL, { db_type: "postgres" });
    // Intentionally seed NO entities.

    invalidateOrgWhitelist(orgId);
    await loadOrgWhitelist(orgId, "published");
    const allowed = getOrgWhitelistedTables(orgId, "default", "published");
    expect(allowed.size).toBe(0);
  });
});

/**
 * LIVE-Postgres regression for the demo first-answer dead-end STILL not fixed in
 * prod after #3947 (#3961).
 *
 * #3947 broadened the union fallback in `getOrgWhitelistedTables`, but ONLY for
 * the literal `connectionId === "default"` sentinel. The real prod path never
 * passes `"default"`: an unpinned chat conversation (reach = "All sources", no
 * agent-named group) collapses `executeSQL`'s `currentMember` to the
 * conversation's own `requestContextConnectionId` — a REAL, non-`"default"`
 * connection id stamped by the chat route — which matches NO entity bucket
 * (entities key under `connection_group_id`). So the direct lookup missed AND the
 * literal-`"default"` union was bypassed → every demo table rejected on the first
 * answer, while `GET /api/v1/tables` (the web page fetches it with no
 * `connectionId` → resolves `"default"` → unions) still listed the full demo set.
 * That asymmetry is exactly what `/verify-prod-signup` caught post-v0.0.28.
 *
 * The fix threads an explicit `unpinned` signal from `validateSQL` (derived from
 * the RequestContext: All-sources reach AND the lookup id IS the conversation's
 * own connection) into `getOrgWhitelistedTables`, so the union fires for the
 * real-id unpinned case too — not only the literal sentinel.
 *
 * These tests feed the lookup the ACTUAL `requestContextConnectionId` a demo
 * conversation carries (a real id, NOT `"default"`), so a fix that only satisfies
 * the literal-`"default"` unit test (the #3947 gap) fails here. The final test
 * drives the full `validateSQL` boundary inside a `withRequestContext`, pinning
 * the RequestContext → `unpinned` derivation end-to-end.
 */
describeIfPg("demo first-answer: real requestContextConnectionId resolves the demo tables (#3961)", () => {
  let pool: Pool;
  const schemaName = `demo_3961_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let prevDatabaseUrl: string | undefined;

  /** The real, non-`"default"` connection id an unpinned demo conversation carries. */
  const CONV_CONN_ID = "demo-conn-7f3a";

  async function install(orgId: string, installId: string, config: Record<string, unknown>): Promise<void> {
    await pool.query(
      `INSERT INTO workspace_plugins (id, workspace_id, catalog_id, install_id, pillar, config, enabled, status, installed_at)
       VALUES ($1, $2, 'catalog:demo-3961', $3, 'datasource', $4::jsonb, true, 'published', NOW())
       ON CONFLICT (workspace_id, catalog_id, install_id)
         DO UPDATE SET status = 'published', config = EXCLUDED.config`,
      [`${orgId}-${installId}`, orgId, installId, JSON.stringify(config)],
    );
  }

  async function seedEntities(orgId: string, installId: string, tables: string[]): Promise<void> {
    await bulkUpsertEntities(
      orgId,
      tables.map((t) => ({
        entityType: "entity" as const,
        name: t,
        yamlContent: `table: ${t}\ndescription: ${t}\n`,
        connectionId: installId,
      })),
      internalQuery,
      "published",
    );
  }

  beforeAll(async () => {
    prevDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = TEST_DB_URL;
    pool = new Pool({ connectionString: TEST_DB_URL });
    pool.on("connect", (client) => {
      void client.query(`SET search_path TO "${schemaName}"`).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`demo-3961: SET search_path failed: ${message}`);
      });
    });
    await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
    await runMigrations(pool, { skip: MANAGED_AUTH_MIGRATIONS });
    _resetPool(pool as unknown as InternalPool);
    await pool.query(
      `INSERT INTO plugin_catalog (id, name, slug, type, pillar, install_model)
       VALUES ('catalog:demo-3961', 'Demo Postgres', 'demo-3961', 'datasource', 'datasource', 'form')
       ON CONFLICT (id) DO NOTHING`,
    );
  }, PG_TEST_TIMEOUT_MS * 2);

  /** The conversation's own connection id, a sibling WITH a bucket, and an empty sibling. */
  const SIBLING_CONN_ID = "warehouse";
  const EMPTY_SIBLING_CONN_ID = "warehouse-empty";

  afterEach(() => {
    _resetWhitelists();
    _resetOrgWhitelists();
    _resetPluginEntities();
    connections.unregister(CONV_CONN_ID);
    connections.unregister(SIBLING_CONN_ID);
    connections.unregister(EMPTY_SIBLING_CONN_ID);
  });

  afterAll(async () => {
    _resetPool(null);
    if (prevDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prevDatabaseUrl;
    await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`demo-3961: schema cleanup failed: ${message}`);
    });
    await pool.end();
  });

  const DEMO_TABLES = ["order_items", "products", "categories", "orders"];

  it("the REAL conversation connection id (not `default`) dead-ends WITHOUT the unpinned flag — reproduces the #3961 prod bug", async () => {
    // Entities key under the demo install bucket (`__demo__`); the conversation
    // carries a different real connection id. This is the prod shape: the
    // pre-#3961 lookup (`getOrgWhitelistedTables(orgId, <real id>)`, no union)
    // returns EMPTY — the exact dead-end `/verify-prod-signup` hit, and exactly
    // what the literal-`"default"` #3947 test could never catch.
    const orgId = `org-3961-repro-${Math.floor(Math.random() * 1e6)}`;
    await install(orgId, DEMO_INSTALL, { db_type: "postgres" });
    await seedEntities(orgId, DEMO_INSTALL, DEMO_TABLES);

    invalidateOrgWhitelist(orgId);
    await loadOrgWhitelist(orgId, "published");

    const deadEnd = getOrgWhitelistedTables(orgId, CONV_CONN_ID, "published");
    expect(deadEnd.size).toBe(0); // every demo table rejected — the bug

    const fixed = getOrgWhitelistedTables(orgId, CONV_CONN_ID, "published", { unpinned: true });
    for (const t of DEMO_TABLES) expect(fixed.has(t)).toBe(true); // the fix
  });

  it("unpinned union across multiple buckets resolves the demo tables for the real conversation id (config.group_id shape)", async () => {
    // The realistic multi-bucket shape: the demo install carries an explicit
    // `config.group_id`, so entities key under BOTH the group AND its member.
    // The conversation still carries its own distinct connection id → direct miss
    // → without the union, empty. The unpinned union must resolve the full set.
    const orgId = `org-3961-groupid-${Math.floor(Math.random() * 1e6)}`;
    await install(orgId, DEMO_INSTALL, { db_type: "postgres", group_id: "grp_demo" });
    await seedEntities(orgId, DEMO_INSTALL, DEMO_TABLES);

    invalidateOrgWhitelist(orgId);
    const wl = await loadOrgWhitelist(orgId, "published");
    expect(wl.size).toBeGreaterThan(1); // multi-bucket — the shape #3947 missed
    expect(wl.has(CONV_CONN_ID)).toBe(false); // the conversation id is NOT a bucket key

    const fixed = getOrgWhitelistedTables(orgId, CONV_CONN_ID, "published", { unpinned: true });
    for (const t of DEMO_TABLES) expect(fixed.has(t)).toBe(true);
  });

  it("a PINNED real connection id is NOT widened by the absence of the unpinned flag (isolation preserved)", async () => {
    // The unpinned union fires ONLY when the caller passes `unpinned: true`. A
    // query the agent pinned to a real connection/group id is resolved WITHOUT
    // the flag, so it sees its own bucket alone — a connection with no bucket
    // gets the empty set, never the union of its siblings.
    const orgId = `org-3961-pinned-${Math.floor(Math.random() * 1e6)}`;
    await install(orgId, DEMO_INSTALL, { db_type: "postgres" });
    await install(orgId, "warehouse", { db_type: "postgres" });
    await seedEntities(orgId, DEMO_INSTALL, ["order_items", "products"]);
    await seedEntities(orgId, "warehouse", ["widgets"]);

    invalidateOrgWhitelist(orgId);
    await loadOrgWhitelist(orgId, "published");

    // Pinned to a real bucket → that bucket alone (direct hit), no union.
    const warehouseOnly = getOrgWhitelistedTables(orgId, "warehouse", "published");
    expect(warehouseOnly.has("widgets")).toBe(true);
    expect(warehouseOnly.has("order_items")).toBe(false);

    // Pinned to a real id with NO bucket, WITHOUT the unpinned flag → empty, not
    // the union (the leak the flag-gating prevents).
    const pinnedMiss = getOrgWhitelistedTables(orgId, CONV_CONN_ID, "published");
    expect(pinnedMiss.size).toBe(0);
  });

  it("validateSQL accepts a demo table for an UNPINNED conversation carrying the real connection id (full boundary)", async () => {
    // The end-to-end #3961 boundary: drive `validateSQL` exactly as `executeSQL`
    // does on a demo first answer — a RequestContext with All-sources reach
    // (`groupReach` absent) and `connectionId` = the conversation's own real id,
    // and the SAME id as the lookup `connId`. `validateSQL` must derive
    // `unpinned: true` and accept the demo table, instead of rejecting it as "not
    // in the allowed list".
    const orgId = `org-3961-validate-${Math.floor(Math.random() * 1e6)}`;
    await install(orgId, DEMO_INSTALL, { db_type: "postgres" });
    await seedEntities(orgId, DEMO_INSTALL, DEMO_TABLES);
    invalidateOrgWhitelist(orgId);
    await loadOrgWhitelist(orgId, "published");

    // Register the conversation's connection so `getDBType` resolves (postgres);
    // no pool is opened — `validateSQL` only parses + whitelist-checks.
    connections.register(CONV_CONN_ID, { url: TEST_DB_URL! });

    // Unpinned conversation: groupReach omitted (All sources), connectionId = the
    // real conversation id. `executeSQL`'s `currentMember` collapses to this same
    // id, so we pass it as the validateSQL `connId`.
    const accepted = await withRequestContext(
      { requestId: "test-3961-unpinned", atlasMode: "published", connectionId: CONV_CONN_ID },
      () => validateSQL("SELECT order_total FROM orders LIMIT 10", CONV_CONN_ID, orgId),
    );
    expect(accepted.valid).toBe(true);

    // Contrast: a FOCUSED conversation (groupReach set to a different group) is
    // not All-sources → `unpinned` stays false → the demo bucket is not unioned
    // in → the same query is rejected. Locks the derivation's isolation side.
    const rejected = await withRequestContext(
      {
        requestId: "test-3961-focused",
        atlasMode: "published",
        connectionId: CONV_CONN_ID,
        groupReach: "grp_other",
      },
      () => validateSQL("SELECT order_total FROM orders LIMIT 10", CONV_CONN_ID, orgId),
    );
    expect(rejected.valid).toBe(false);
  });

  it("validateSQL does NOT widen an agent pin to a SIBLING connection under All-sources reach (isolation — locks the equality clause)", async () => {
    // The load-bearing half of the derivation: `unpinned` requires the lookup id
    // to BE the conversation's own connection. When the agent pins a different
    // (sibling) connection while reach is still All-sources, `currentMember` is
    // the sibling id ≠ `reqCtx.connectionId`, so `unpinned` MUST stay false and
    // the sibling resolves its own bucket alone — never the org-wide union.
    //
    // The EMPTY-bucket sibling is what actually locks the equality clause: a
    // sibling WITH a bucket is isolated by the `tables.size === 0` direct-hit
    // short-circuit regardless of the flag, so dropping the clause would still
    // pass. Only an empty-bucket pin reaches the union, so the empty-sibling
    // assertion below FLIPS (reject → accept, demo tables leak) if a future edit
    // drops `connectionId === sqlReqCtx?.connectionId`.
    const orgId = `org-3961-sibling-${Math.floor(Math.random() * 1e6)}`;
    await install(orgId, DEMO_INSTALL, { db_type: "postgres" });
    await install(orgId, SIBLING_CONN_ID, { db_type: "postgres" });
    await install(orgId, EMPTY_SIBLING_CONN_ID, { db_type: "postgres" });
    await seedEntities(orgId, DEMO_INSTALL, DEMO_TABLES);
    await seedEntities(orgId, SIBLING_CONN_ID, ["widgets"]);
    // EMPTY_SIBLING_CONN_ID intentionally gets NO entities — an empty bucket.
    invalidateOrgWhitelist(orgId);
    await loadOrgWhitelist(orgId, "published");

    // Registered so `getDBType` resolves (postgres); no pool is opened.
    connections.register(CONV_CONN_ID, { url: TEST_DB_URL! });
    connections.register(SIBLING_CONN_ID, { url: TEST_DB_URL! });
    connections.register(EMPTY_SIBLING_CONN_ID, { url: TEST_DB_URL! });

    // Conversation is unpinned (All sources), but the agent pins a SIBLING for
    // this query → lookup connId = sibling ≠ the conversation id.
    const ctx = {
      requestId: "test-3961-sibling",
      atlasMode: "published" as const,
      connectionId: CONV_CONN_ID,
    };

    // THE LOCK: an EMPTY-bucket sibling pin would reach the union if `unpinned`
    // wrongly flipped true (dropped equality clause) → demo `orders` would leak.
    // With the clause, `unpinned` stays false → empty set → demo `orders` rejected.
    const emptySiblingLeak = await withRequestContext(ctx, () =>
      validateSQL("SELECT order_total FROM orders LIMIT 10", EMPTY_SIBLING_CONN_ID, orgId),
    );
    expect(emptySiblingLeak.valid).toBe(false);

    // A non-empty sibling pin is also not widened (here the direct-hit
    // short-circuit does the isolating) — demo `orders` still rejected.
    const fullSiblingLeak = await withRequestContext(ctx, () =>
      validateSQL("SELECT order_total FROM orders LIMIT 10", SIBLING_CONN_ID, orgId),
    );
    expect(fullSiblingLeak.valid).toBe(false);

    // The sibling's OWN table still validates — isolation, not a blanket deny.
    const ownBucket = await withRequestContext(ctx, () =>
      validateSQL("SELECT id FROM widgets LIMIT 10", SIBLING_CONN_ID, orgId),
    );
    expect(ownBucket.valid).toBe(true);
  });
});
