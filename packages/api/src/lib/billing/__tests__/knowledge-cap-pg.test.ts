/**
 * Real-Postgres coverage for the per-tier Knowledge Base **collections** cap
 * (#4235). Mirrors `chat-cap-pg.test.ts`'s harness: skips cleanly when
 * `TEST_DATABASE_URL` is unset, runs every migration into a unique per-test
 * schema, and exercises what mock-pool tests can't see.
 *
 * What this catches that the mock-based tests can't:
 *   - `KNOWLEDGE_COLLECTION_COUNT_SQL` is never executed by the unit tests
 *     (they script the count rows). Knowledge partitions by `install_id`, NOT
 *     by `catalog_id` like the chat aggregate — a copy-paste of the chat
 *     predicate would still typecheck, still pass every unit test, and would
 *     silently count several collections from one connector as a single slot.
 *   - The `pg_advisory_xact_lock` serialization: two concurrent net-new
 *     collections at cap-minus-1 must admit exactly one.
 *
 * Opt in locally with:
 *   bun run db:up && export TEST_DATABASE_URL=postgresql://atlas:atlas@localhost:5432/atlas
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import { runMigrations } from "@atlas/api/lib/db/migrate";
import {
  MANAGED_AUTH_MIGRATIONS,
  _resetPool,
  type InternalPool,
} from "@atlas/api/lib/db/internal";
import {
  KNOWLEDGE_COLLECTION_COUNT_SQL,
  KNOWLEDGE_COLLECTION_FANOUT_COUNT_SQL,
  checkKnowledgeCollectionFanOutLimit,
  checkKnowledgeCollectionLimitAndInstall,
  invalidatePlanCache,
} from "@atlas/api/lib/billing/enforcement";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;
const PG_TEST_TIMEOUT_MS = 30_000;

/**
 * Seed a `plugin_catalog` row so `workspace_plugins.catalog_id` FK resolves.
 * `type` and `pillar` are separate vocabularies — `chk_plugin_catalog_type`
 * has no `knowledge` member, so knowledge catalogs carry `type = 'context'`
 * (matching the built-in knowledge seeder).
 */
async function seedCatalog(
  pool: Pool,
  slug: string,
  pillar: string,
  type: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO plugin_catalog (id, name, slug, type, pillar)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (id) DO NOTHING`,
    [`catalog:${slug}`, slug, slug, type, pillar],
  );
}

/** Seed one collection (or any pillar's install) row. */
async function seedInstall(
  pool: Pool,
  opts: {
    id: string;
    workspaceId: string;
    catalog: string;
    installId: string;
    pillar: string;
    status?: "published" | "draft" | "archived";
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO workspace_plugins
       (id, workspace_id, catalog_id, install_id, pillar, config, enabled, status, installed_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, '{}'::jsonb, true, $6, NOW(), NOW())`,
    [opts.id, opts.workspaceId, opts.catalog, opts.installId, opts.pillar, opts.status ?? "published"],
  );
}

describeIfPg("KNOWLEDGE_COLLECTION_COUNT_SQL (real Postgres)", () => {
  let pool: Pool;
  const schemaName = `kb_cap_count_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DB_URL });
    pool.on("connect", (client) => {
      void client.query(`SET search_path TO "${schemaName}"`).catch((err) => {
        console.error(
          `knowledge-cap-pg: SET search_path failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    });
    await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
    await runMigrations(pool, { skip: MANAGED_AUTH_MIGRATIONS });
    await seedCatalog(pool, "okf-upload", "knowledge", "context");
    await seedCatalog(pool, "zendesk", "knowledge", "context");
    await seedCatalog(pool, "slack", "chat", "chat");
  }, PG_TEST_TIMEOUT_MS);

  afterAll(async () => {
    if (!pool) return;
    await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    await pool.end();
  });

  it(
    "partitions by install_id and excludes chat / archived / other-workspace rows",
    async () => {
      const ws = `ws-kb-count-${Date.now()}`;
      const otherWs = `ws-kb-other-${Date.now()}`;
      await seedInstall(pool, { id: `${ws}-a`, workspaceId: ws, catalog: "catalog:okf-upload", installId: "docs", pillar: "knowledge" });
      // Two collections from the SAME catalog — knowledge is multi-instance, so
      // both consume a slot. A catalog_id-based partition (the chat shape)
      // would count these as one.
      await seedInstall(pool, { id: `${ws}-b`, workspaceId: ws, catalog: "catalog:zendesk", installId: "zd-brand-1", pillar: "knowledge" });
      await seedInstall(pool, { id: `${ws}-c`, workspaceId: ws, catalog: "catalog:zendesk", installId: "zd-brand-2", pillar: "knowledge" });
      // Chat pillar — must NOT count toward the collections cap.
      await seedInstall(pool, { id: `${ws}-chat`, workspaceId: ws, catalog: "catalog:slack", installId: "slack", pillar: "chat" });
      // Archived collection — must NOT count.
      await seedInstall(pool, { id: `${ws}-old`, workspaceId: ws, catalog: "catalog:okf-upload", installId: "retired", pillar: "knowledge", status: "archived" });
      // Another workspace's collection — must NOT count.
      await seedInstall(pool, { id: `${otherWs}-a`, workspaceId: otherWs, catalog: "catalog:okf-upload", installId: "docs", pillar: "knowledge" });

      // Edit case — "docs" already exists for this workspace.
      const edit = await pool.query<{ others: number; this_count: number }>(
        KNOWLEDGE_COLLECTION_COUNT_SQL,
        [ws, "docs"],
      );
      expect(edit.rows[0]?.others).toBe(2); // zd-brand-1 + zd-brand-2
      expect(edit.rows[0]?.this_count).toBe(1);

      // Net-new case — "handbook" does not exist yet.
      const netNew = await pool.query<{ others: number; this_count: number }>(
        KNOWLEDGE_COLLECTION_COUNT_SQL,
        [ws, "handbook"],
      );
      expect(netNew.rows[0]?.others).toBe(3);
      expect(netNew.rows[0]?.this_count).toBe(0);

      // `::int` casts must return JS numbers, not strings.
      expect(typeof netNew.rows[0]?.others).toBe("number");
    },
    PG_TEST_TIMEOUT_MS,
  );
});

describeIfPg("KNOWLEDGE_COLLECTION_FANOUT_COUNT_SQL (real Postgres)", () => {
  let pool: Pool;
  const schemaName = `kb_cap_fanout_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DB_URL });
    pool.on("connect", (client) => {
      void client.query(`SET search_path TO "${schemaName}"`).catch((err) => {
        console.error(
          `knowledge-cap-pg: SET search_path failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    });
    await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
    await runMigrations(pool, { skip: MANAGED_AUTH_MIGRATIONS });
    await seedCatalog(pool, "okf-upload", "knowledge", "context");
    await seedCatalog(pool, "zendesk", "knowledge", "context");
  }, PG_TEST_TIMEOUT_MS);

  afterAll(async () => {
    if (!pool) return;
    await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    await pool.end();
  });

  it(
    "counts only collections OUTSIDE the batch, so a re-install of the same slugs is free",
    async () => {
      const ws = `ws-fanout-${Date.now()}`;
      await seedInstall(pool, { id: `${ws}-1`, workspaceId: ws, catalog: "catalog:okf-upload", installId: "keep", pillar: "knowledge" });
      await seedInstall(pool, { id: `${ws}-2`, workspaceId: ws, catalog: "catalog:zendesk", installId: "zd-a", pillar: "knowledge" });
      await seedInstall(pool, { id: `${ws}-3`, workspaceId: ws, catalog: "catalog:zendesk", installId: "zd-b", pillar: "knowledge" });

      // Re-installing the two Zendesk brands: only "keep" is outside the batch,
      // and both batch members already exist (so the batch adds nothing).
      const reinstall = await pool.query<{ others: number; this_count: number }>(
        KNOWLEDGE_COLLECTION_FANOUT_COUNT_SQL,
        [ws, ["zd-a", "zd-b"]],
      );
      expect(reinstall.rows[0]?.others).toBe(1);
      expect(reinstall.rows[0]?.this_count).toBe(2);

      // A net-new batch: all three existing collections are "others".
      const netNew = await pool.query<{ others: number; this_count: number }>(
        KNOWLEDGE_COLLECTION_FANOUT_COUNT_SQL,
        [ws, ["new-a", "new-b"]],
      );
      expect(netNew.rows[0]?.others).toBe(3);
      expect(netNew.rows[0]?.this_count).toBe(0);
      expect(typeof netNew.rows[0]?.others).toBe("number");
    },
    PG_TEST_TIMEOUT_MS,
  );
});

describeIfPg("checkKnowledgeCollectionFanOutLimit (real Postgres)", () => {
  let pool: Pool;
  const schemaName = `kb_cap_fanout_gate_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DB_URL });
    pool.on("connect", (client) => {
      void client.query(`SET search_path TO "${schemaName}"`).catch((err) => {
        console.error(
          `knowledge-cap-pg: SET search_path failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    });
    await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
    await runMigrations(pool, { skip: MANAGED_AUTH_MIGRATIONS });
    await pool.query(
      `CREATE TABLE organization (
         id text PRIMARY KEY, name text, slug text,
         workspace_status text NOT NULL DEFAULT 'active',
         plan_tier text NOT NULL DEFAULT 'free',
         byot boolean NOT NULL DEFAULT false,
         "stripeCustomerId" text, trial_ends_at timestamptz,
         suspended_at timestamptz, suspension_source text,
         plan_override_until timestamptz, deleted_at timestamptz,
         region text, region_assigned_at timestamptz,
         "createdAt" timestamptz NOT NULL DEFAULT now()
       )`,
    );
    await seedCatalog(pool, "zendesk", "knowledge", "context");
    process.env.DATABASE_URL = TEST_DB_URL;
    _resetPool(pool as unknown as InternalPool, null);
  }, PG_TEST_TIMEOUT_MS);

  afterAll(async () => {
    _resetPool(null, null);
    if (ORIGINAL_DATABASE_URL === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
    if (!pool) return;
    await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    await pool.end();
  });

  afterEach(async () => {
    invalidatePlanCache();
    await pool.query(`DELETE FROM workspace_plugins`);
    await pool.query(`DELETE FROM organization`);
  });

  it(
    "refuses a whole 3-brand fan-out that would breach a Pro workspace's cap of 3",
    async () => {
      const ws = "ws-fanout-pro";
      await pool.query(`INSERT INTO organization (id, name, slug, plan_tier) VALUES ($1,$1,$1,'pro')`, [ws]);
      await seedInstall(pool, { id: "row-a", workspaceId: ws, catalog: "catalog:zendesk", installId: "existing", pillar: "knowledge" });

      // 1 existing + 3 net-new = 4 > cap 3. A per-slug precheck would pass all
      // three (each sees `others = 1`) and strand a partial install.
      const decision = await checkKnowledgeCollectionFanOutLimit(ws, ["b1", "b2", "b3"]);
      expect(decision.allowed).toBe(false);
      if (decision.allowed || decision.reason !== "cap_reached") {
        throw new Error("expected a cap_reached denial");
      }
      expect(decision.tier).toBe("pro");
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "admits a fan-out that exactly fills the cap",
    async () => {
      const ws = "ws-fanout-fits";
      await pool.query(`INSERT INTO organization (id, name, slug, plan_tier) VALUES ($1,$1,$1,'pro')`, [ws]);
      await seedInstall(pool, { id: "row-a", workspaceId: ws, catalog: "catalog:zendesk", installId: "existing", pillar: "knowledge" });
      expect((await checkKnowledgeCollectionFanOutLimit(ws, ["b1", "b2"])).allowed).toBe(true);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "never blocks re-installing the SAME brands an over-cap workspace already owns",
    async () => {
      const ws = "ws-fanout-reinstall";
      await pool.query(`INSERT INTO organization (id, name, slug, plan_tier) VALUES ($1,$1,$1,'starter')`, [ws]);
      await seedInstall(pool, { id: "row-a", workspaceId: ws, catalog: "catalog:zendesk", installId: "b1", pillar: "knowledge" });
      await seedInstall(pool, { id: "row-b", workspaceId: ws, catalog: "catalog:zendesk", installId: "b2", pillar: "knowledge" });
      // Starter's cap is 1 and the workspace holds 2 (a downgrade), yet
      // re-running the same install adds nothing and must still be admitted.
      expect((await checkKnowledgeCollectionFanOutLimit(ws, ["b1", "b2"])).allowed).toBe(true);
      // Adding a THIRD brand on top does grow the set, so it is refused.
      expect(
        (await checkKnowledgeCollectionFanOutLimit(ws, ["b1", "b2", "b3"])).allowed,
      ).toBe(false);
    },
    PG_TEST_TIMEOUT_MS,
  );
});

describeIfPg("checkKnowledgeCollectionLimitAndInstall (real Postgres)", () => {
  let pool: Pool;
  const schemaName = `kb_cap_gate_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;

  /** The okf-upload handler's UPSERT shape, with RETURNING id. */
  function collectionInsert(rowId: string, ws: string, slug: string) {
    return {
      sql: `INSERT INTO workspace_plugins
             (id, workspace_id, catalog_id, install_id, pillar, config, enabled, status, installed_at, updated_at)
           VALUES ($1, $2, $3, $4, 'knowledge', '{}'::jsonb, true, 'published', NOW(), NOW())
           ON CONFLICT (workspace_id, catalog_id, install_id) DO UPDATE
             SET enabled = true, status = 'published', updated_at = NOW()
           RETURNING id`,
      params: [rowId, ws, "catalog:okf-upload", slug],
    };
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DB_URL });
    pool.on("connect", (client) => {
      void client.query(`SET search_path TO "${schemaName}"`).catch((err) => {
        console.error(
          `knowledge-cap-pg: SET search_path failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    });
    await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
    await runMigrations(pool, { skip: MANAGED_AUTH_MIGRATIONS });
    // Minimal `organization` — only the columns getWorkspaceDetails reads.
    // Better-Auth owns this table in production, so it is not in our migration
    // set; the columns from MANAGED_AUTH_MIGRATIONS must be carried here or
    // every plan lookup fails with `column "..." does not exist`.
    await pool.query(
      `CREATE TABLE organization (
         id text PRIMARY KEY,
         name text,
         slug text,
         workspace_status text NOT NULL DEFAULT 'active',
         plan_tier text NOT NULL DEFAULT 'free',
         byot boolean NOT NULL DEFAULT false,
         "stripeCustomerId" text,
         trial_ends_at timestamptz,
         suspended_at timestamptz,
         suspension_source text,
         plan_override_until timestamptz,
         deleted_at timestamptz,
         region text,
         region_assigned_at timestamptz,
         "createdAt" timestamptz NOT NULL DEFAULT now()
       )`,
    );
    await seedCatalog(pool, "okf-upload", "knowledge", "context");

    process.env.DATABASE_URL = TEST_DB_URL;
    _resetPool(pool as unknown as InternalPool, null);
  }, PG_TEST_TIMEOUT_MS);

  afterAll(async () => {
    _resetPool(null, null);
    if (ORIGINAL_DATABASE_URL === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
    if (!pool) return;
    await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    await pool.end();
  });

  afterEach(async () => {
    invalidatePlanCache();
    await pool.query(`DELETE FROM workspace_plugins`);
    await pool.query(`DELETE FROM organization`);
  });

  async function seedOrg(id: string, planTier: string): Promise<void> {
    await pool.query(
      `INSERT INTO organization (id, name, slug, plan_tier) VALUES ($1, $1, $1, $2)`,
      [id, planTier],
    );
  }

  it(
    "admits a starter workspace's first collection and refuses its second",
    async () => {
      const ws = "ws-starter";
      await seedOrg(ws, "starter"); // cap = 1

      const first = await checkKnowledgeCollectionLimitAndInstall<{ id: string }>(
        ws,
        "docs",
        collectionInsert("row-1", ws, "docs"),
      );
      expect(first.allowed).toBe(true);

      const second = await checkKnowledgeCollectionLimitAndInstall<{ id: string }>(
        ws,
        "handbook",
        collectionInsert("row-2", ws, "handbook"),
      );
      expect(second.allowed).toBe(false);
      if (second.allowed || second.reason !== "cap_reached") {
        throw new Error("expected a cap_reached denial");
      }

      // The refused INSERT must have rolled back — no orphan row.
      const rows = await pool.query(`SELECT install_id FROM workspace_plugins WHERE workspace_id = $1`, [ws]);
      expect(rows.rows.map((r) => (r as { install_id: string }).install_id)).toEqual(["docs"]);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "never blocks EDITING an existing collection, even for an over-cap workspace",
    async () => {
      const ws = "ws-grandfathered";
      await seedOrg(ws, "starter"); // cap = 1, but seeded with 2 (a downgrade)
      await seedInstall(pool, { id: "row-a", workspaceId: ws, catalog: "catalog:okf-upload", installId: "docs", pillar: "knowledge" });
      await seedInstall(pool, { id: "row-b", workspaceId: ws, catalog: "catalog:okf-upload", installId: "handbook", pillar: "knowledge" });

      const edit = await checkKnowledgeCollectionLimitAndInstall<{ id: string }>(
        ws,
        "docs",
        collectionInsert("row-new", ws, "docs"),
      );
      expect(edit.allowed).toBe(true);
      if (!edit.allowed) throw new Error("unreachable");
      // ON CONFLICT DO UPDATE keeps the ORIGINAL row id.
      expect(edit.rows[0]?.id).toBe("row-a");
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "lets exactly one of two concurrent net-new collections through at cap-minus-one",
    async () => {
      const ws = "ws-race";
      await seedOrg(ws, "pro"); // cap = 3
      await seedInstall(pool, { id: "row-a", workspaceId: ws, catalog: "catalog:okf-upload", installId: "c1", pillar: "knowledge" });
      await seedInstall(pool, { id: "row-b", workspaceId: ws, catalog: "catalog:okf-upload", installId: "c2", pillar: "knowledge" });

      const [a, b] = await Promise.all([
        checkKnowledgeCollectionLimitAndInstall<{ id: string }>(ws, "c3", collectionInsert("row-c", ws, "c3")),
        checkKnowledgeCollectionLimitAndInstall<{ id: string }>(ws, "c4", collectionInsert("row-d", ws, "c4")),
      ]);

      const allowed = [a, b].filter((r) => r.allowed);
      expect(allowed).toHaveLength(1);
      const count = await pool.query<{ n: string }>(
        `SELECT COUNT(*)::int AS n FROM workspace_plugins WHERE workspace_id = $1 AND pillar = 'knowledge'`,
        [ws],
      );
      expect(Number(count.rows[0]?.n)).toBe(3);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "refuses the churn tier's FIRST collection — locked is a real zero, not unlimited",
    async () => {
      const ws = "ws-locked";
      await seedOrg(ws, "locked"); // cap = 0
      const r = await checkKnowledgeCollectionLimitAndInstall<{ id: string }>(
        ws,
        "docs",
        collectionInsert("row-1", ws, "docs"),
      );
      expect(r.allowed).toBe(false);
      if (r.allowed || r.reason !== "cap_reached") {
        throw new Error("expected a cap_reached denial");
      }
      expect(r.limit).toBe(0);
      expect(r.tier).toBe("locked");
      const rows = await pool.query(
        `SELECT 1 FROM workspace_plugins WHERE workspace_id = $1`,
        [ws],
      );
      expect(rows.rowCount).toBe(0);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "caps a trial workspace exactly like starter (the highest-traffic SaaS tier)",
    async () => {
      const ws = "ws-trial";
      await seedOrg(ws, "trial"); // cap = 1, mirroring starter
      const first = await checkKnowledgeCollectionLimitAndInstall<{ id: string }>(
        ws,
        "docs",
        collectionInsert("row-1", ws, "docs"),
      );
      expect(first.allowed).toBe(true);
      const second = await checkKnowledgeCollectionLimitAndInstall<{ id: string }>(
        ws,
        "handbook",
        collectionInsert("row-2", ws, "handbook"),
      );
      expect(second.allowed).toBe(false);
      if (second.allowed || second.reason !== "cap_reached") {
        throw new Error("expected a cap_reached denial");
      }
      // The denial carries the tier that set the cap, so the upgrade prompt
      // never has to re-resolve (and can't name a stale plan).
      expect(second.tier).toBe("trial");
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "applies no cap on the free (self-hosted) tier",
    async () => {
      const ws = "ws-selfhosted";
      await seedOrg(ws, "free");
      for (const slug of ["a", "b", "c", "d", "e"]) {
        const r = await checkKnowledgeCollectionLimitAndInstall<{ id: string }>(
          ws,
          slug,
          collectionInsert(`row-${slug}`, ws, slug),
        );
        expect(r.allowed).toBe(true);
      }
    },
    PG_TEST_TIMEOUT_MS,
  );
});
