/**
 * Integration test for the developer-mode overlay CTE (#1427).
 *
 * Runs `listEntitiesWithOverlay` against an in-process Postgres (pg-mem) to
 * verify the CTE's logical semantics — not just its SQL shape. Closes the
 * gap flagged in the pr-test-analyzer review (#1454): shape-only regex tests
 * can't catch a reordering of the `CASE` arms or a broken `DISTINCT ON`
 * projection.
 *
 * Covers the five acceptance-matrix cases from #1427:
 *   1. Published-only entity → visible
 *   2. Draft-only entity → visible
 *   3. Draft + published for the same key → draft wins, published hidden
 *   4. `draft_delete` tombstone for a published key → both hidden
 *   5. Entity whose parent connection is `archived` → hidden even if published
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { newDb, type IMemoryDb } from "pg-mem";
import type { InternalPool } from "@atlas/api/lib/db/internal";
import {
  _resetPool,
  hasInternalDB as _hasInternalDB,
} from "@atlas/api/lib/db/internal";
import { listEntitiesWithOverlay, listEntityRows } from "@atlas/api/lib/semantic/entities";

// ---------------------------------------------------------------------------
// In-memory Postgres wired into the internal DB pool singleton
// ---------------------------------------------------------------------------

let db: IMemoryDb;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pg-mem's adapter returns a dynamic Pool constructor; not worth typing for tests
let pool: any;
let originalDatabaseUrl: string | undefined;

beforeAll(async () => {
  // `hasInternalDB()` reads DATABASE_URL; pg-mem doesn't need a URL but the
  // guard runs before the pool is consulted.
  originalDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgresql://pgmem/atlas";

  db = newDb();

  // Minimal schema — only the columns referenced by the post-#2744
  // overlay CTE. The OWN_OR_GLOBAL shadow rule now reads from
  // `workspace_plugins (pillar='datasource')` with the install's group_id
  // living inside `config` JSONB. `install_id` replaces `connections.id`
  // for the shadow-precedence NOT-IN check.
  db.public.none(`
    CREATE TABLE workspace_plugins (
      install_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      pillar TEXT NOT NULL DEFAULT 'datasource',
      status TEXT NOT NULL DEFAULT 'published',
      config JSONB,
      PRIMARY KEY (workspace_id, install_id)
    );
    CREATE TABLE semantic_entities (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      name TEXT NOT NULL,
      yaml_content TEXT NOT NULL,
      connection_group_id TEXT,
      status TEXT NOT NULL DEFAULT 'published',
      created_at TEXT NOT NULL DEFAULT 'now',
      updated_at TEXT NOT NULL DEFAULT 'now'
    );
  `);

  const { Pool } = db.adapters.createPg();
  pool = new Pool();

  // Verify `listEntitiesWithOverlay` takes the raw-pool path by clearing any
  // Effect-managed SqlClient and installing our pg-mem pool.
  _resetPool(pool as unknown as InternalPool, null);

  // Sanity check — the hasInternalDB guard must pass so the overlay runs.
  if (!_hasInternalDB()) {
    throw new Error("hasInternalDB() returned false despite DATABASE_URL — test setup bug");
  }
});

afterAll(async () => {
  _resetPool(null, null);
  if (originalDatabaseUrl === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = originalDatabaseUrl;
  }
  if (pool) await pool.end();
});

beforeEach(() => {
  db.public.none(`TRUNCATE semantic_entities; TRUNCATE workspace_plugins;`);
});

// ---------------------------------------------------------------------------
// Fixture helpers — thin wrappers around raw INSERTs
// ---------------------------------------------------------------------------

function seedConnection(
  id: string,
  status: "published" | "draft" | "archived" = "published",
  workspaceId = "org-1",
): void {
  // Post-#2744 each install lives in workspace_plugins with its
  // group_id stashed under `config->>'group_id'`.
  db.public.none(
    `INSERT INTO workspace_plugins (install_id, workspace_id, pillar, status, config)
     VALUES ('${id}', '${workspaceId}', 'datasource', '${status}', '{"group_id":"g_${id}"}'::jsonb)`,
  );
}

function seedEntity(opts: {
  id: string;
  name: string;
  status: "published" | "draft" | "draft_delete" | "archived";
  connectionId?: string | null;
  yaml?: string;
}): void {
  const group = opts.connectionId === undefined ? "NULL" : opts.connectionId === null ? "NULL" : `'g_${opts.connectionId}'`;
  const yaml = (opts.yaml ?? `table: ${opts.name}`).replace(/'/g, "''");
  db.public.none(
    `INSERT INTO semantic_entities (id, org_id, entity_type, name, yaml_content, connection_group_id, status)
     VALUES ('${opts.id}', 'org-1', 'entity', '${opts.name}', '${yaml}', ${group}, '${opts.status}')`,
  );
}

function rowsByName(rows: Array<{ name: string; status: string }>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of rows) out[r.name] = r.status;
  return out;
}

// ---------------------------------------------------------------------------
// Acceptance matrix
// ---------------------------------------------------------------------------

describe("listEntitiesWithOverlay — acceptance matrix against real Postgres", () => {
  it("case 1: published-only entity is visible", async () => {
    seedConnection("warehouse");
    seedEntity({ id: "e1", name: "users", status: "published", connectionId: "warehouse" });

    const rows = await listEntitiesWithOverlay("org-1", "entity");
    expect(rowsByName(rows)).toEqual({ users: "published" });
  });

  it("case 2: draft-only entity is visible", async () => {
    seedConnection("warehouse");
    seedEntity({ id: "e1", name: "events", status: "draft", connectionId: "warehouse" });

    const rows = await listEntitiesWithOverlay("org-1", "entity");
    expect(rowsByName(rows)).toEqual({ events: "draft" });
  });

  it("case 3: draft supersedes published for the same (name, connection_group_id) key", async () => {
    seedConnection("warehouse");
    seedEntity({ id: "e-pub", name: "users", status: "published", connectionId: "warehouse" });
    seedEntity({ id: "e-draft", name: "users", status: "draft", connectionId: "warehouse" });

    const rows = await listEntitiesWithOverlay("org-1", "entity");
    // Exactly one row — the draft wins, the published is shadowed
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("draft");
    expect(rows[0].id).toBe("e-draft");
  });

  it("case 4: draft_delete tombstone hides the published entity it targets", async () => {
    seedConnection("warehouse");
    seedEntity({ id: "e-pub", name: "orders", status: "published", connectionId: "warehouse" });
    seedEntity({ id: "e-tomb", name: "orders", status: "draft_delete", connectionId: "warehouse" });

    const rows = await listEntitiesWithOverlay("org-1", "entity");
    expect(rows).toHaveLength(0);
  });

  it("case 5: entity whose parent connection is archived is excluded", async () => {
    seedConnection("legacy", "archived");
    seedEntity({ id: "e1", name: "old_logs", status: "published", connectionId: "legacy" });

    // Seed an unrelated visible entity to prove the filter is connection-scoped,
    // not a blanket "return empty".
    seedConnection("warehouse");
    seedEntity({ id: "e2", name: "users", status: "published", connectionId: "warehouse" });

    const rows = await listEntitiesWithOverlay("org-1", "entity");
    expect(rowsByName(rows)).toEqual({ users: "published" });
  });

  it("combined: all five cases together reduce to the expected visible set", async () => {
    seedConnection("warehouse");
    seedConnection("legacy", "archived");

    // Case 1 — published-only
    seedEntity({ id: "e1", name: "users", status: "published", connectionId: "warehouse" });
    // Case 2 — draft-only
    seedEntity({ id: "e2", name: "events", status: "draft", connectionId: "warehouse" });
    // Case 3 — draft supersedes published
    seedEntity({ id: "e3a", name: "orders", status: "published", connectionId: "warehouse" });
    seedEntity({ id: "e3b", name: "orders", status: "draft", connectionId: "warehouse" });
    // Case 4 — tombstone hides
    seedEntity({ id: "e4a", name: "sessions", status: "published", connectionId: "warehouse" });
    seedEntity({ id: "e4b", name: "sessions", status: "draft_delete", connectionId: "warehouse" });
    // Case 5 — archived parent
    seedEntity({ id: "e5", name: "old_logs", status: "published", connectionId: "legacy" });

    const rows = await listEntitiesWithOverlay("org-1", "entity");
    expect(rowsByName(rows)).toEqual({
      users: "published",
      events: "draft",
      orders: "draft",
    });
  });

  it("NULL connection_group_id entities pass through (org-level, not connection-scoped)", async () => {
    // Glossary and catalog entries typically have no connection — they must
    // survive the archived-connection filter.
    seedEntity({ id: "g1", name: "kpi_terms", status: "published", connectionId: null });

    const rows = await listEntitiesWithOverlay("org-1", "entity");
    expect(rowsByName(rows)).toEqual({ kpi_terms: "published" });
  });

  it("archived entity rows are dropped by the status filter", async () => {
    seedConnection("warehouse");
    seedEntity({ id: "e-arch", name: "deprecated", status: "archived", connectionId: "warehouse" });
    seedEntity({ id: "e-pub", name: "users", status: "published", connectionId: "warehouse" });

    const rows = await listEntitiesWithOverlay("org-1", "entity");
    expect(rowsByName(rows)).toEqual({ users: "published" });
  });

  it("entityType filter binds to $2 and scopes results", async () => {
    seedConnection("warehouse");
    seedEntity({ id: "e-ent", name: "users", status: "published", connectionId: "warehouse" });
    // Pretend a metric was stored in the same table — different entity_type
    db.public.none(
      `INSERT INTO semantic_entities (id, org_id, entity_type, name, yaml_content, connection_group_id, status)
       VALUES ('m1', 'org-1', 'metric', 'mrr', 'name: mrr', 'g_warehouse', 'published')`,
    );

    const entities = await listEntitiesWithOverlay("org-1", "entity");
    const metrics = await listEntitiesWithOverlay("org-1", "metric");

    expect(rowsByName(entities)).toEqual({ users: "published" });
    expect(rowsByName(metrics)).toEqual({ mrr: "published" });
  });

  it("cross-org rows are invisible", async () => {
    // Seed an entity under a different org — should never appear in org-1's overlay
    seedConnection("warehouse-org2", "published", "org-2");
    db.public.none(
      `INSERT INTO semantic_entities (id, org_id, entity_type, name, yaml_content, connection_group_id, status)
       VALUES ('other', 'org-2', 'entity', 'other_users', 'table: other', 'g_warehouse-org2', 'published')`,
    );

    // org-1 has nothing
    const rows = await listEntitiesWithOverlay("org-1", "entity");
    expect(rows).toHaveLength(0);
  });

  it("entities tied to a __global__ install are visible to any org (#2304)", async () => {
    // The canonical `__demo__` install lives at workspace_id='__global__'.
    // Per-org entities reference it via `connection_group_id`; the
    // connection-visibility subquery now accepts `__global__` rows so
    // those entities resolve.
    seedConnection("__demo__", "published", "__global__");
    seedEntity({ id: "demo-ent", name: "novamart_orders", status: "published", connectionId: "__demo__" });

    const rows = await listEntitiesWithOverlay("org-1", "entity");
    expect(rowsByName(rows)).toEqual({ novamart_orders: "published" });
  });

  it("per-org override hides entities tied to a `__global__` install — exact precedence (#2304)", async () => {
    // Pin the *transition* sequence so a future refactor that flips the
    // NOT-IN shadow check can't silently start surfacing demo entities
    // to a workspace whose own __demo__ install supersedes the global.
    seedConnection("__demo__", "published", "__global__");
    seedEntity({ id: "demo-ent-pre", name: "novamart_orders", status: "published", connectionId: "__demo__" });
    expect(rowsByName(await listEntitiesWithOverlay("org-1", "entity"))).toEqual({ novamart_orders: "published" });

    // Per-workspace __demo__ install arrives (any status) — shadows the global.
    seedConnection("__demo__", "archived", "org-1");
    expect(await listEntitiesWithOverlay("org-1", "entity")).toHaveLength(0);
  });

  it("per-org install shadows a `__global__` install with the same id (#2304)", async () => {
    // The "delete the demo from my workspace" flow now writes a per-org
    // workspace_plugins row at the same install_id as the global. The
    // shadow check (`install_id NOT IN ...own org's installs...`) excludes
    // the global, so any entities tied to that connection_group_id drop
    // out of the overlay alongside it.
    seedConnection("__demo__", "published", "__global__");
    seedConnection("__demo__", "archived", "org-1");
    seedEntity({ id: "demo-ent", name: "novamart_orders", status: "published", connectionId: "__demo__" });

    const rows = await listEntitiesWithOverlay("org-1", "entity");
    expect(rows).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Group-of-one — standalone group-less datasources (#3855)
  // -------------------------------------------------------------------------

  /**
   * A group-LESS datasource install: `config` carries no `group_id`, so its
   * entities key under the bare `install_id` (a group-of-one) rather than the
   * shared NULL/default bucket. Distinct from {@link seedConnection}, which
   * always stamps `config.group_id = g_<id>`.
   */
  function seedGrouplessConnection(
    id: string,
    status: "published" | "draft" | "archived" = "published",
    workspaceId = "org-1",
  ): void {
    db.public.none(
      `INSERT INTO workspace_plugins (install_id, workspace_id, pillar, status, config)
       VALUES ('${id}', '${workspaceId}', 'datasource', '${status}', '{}'::jsonb)`,
    );
  }

  /** Seed an entity keyed directly under a group-of-one's bare `install_id`. */
  function seedGroupOfOneEntity(opts: {
    id: string;
    name: string;
    status: "published" | "draft" | "draft_delete" | "archived";
    installId: string;
    yaml?: string;
  }): void {
    const yaml = (opts.yaml ?? `table: ${opts.name}`).replace(/'/g, "''");
    db.public.none(
      `INSERT INTO semantic_entities (id, org_id, entity_type, name, yaml_content, connection_group_id, status)
       VALUES ('${opts.id}', 'org-1', 'entity', '${opts.name}', '${yaml}', '${opts.installId}', '${opts.status}')`,
    );
  }

  it("two same-named tables on distinct group-less connections both survive — no last-write-wins (#3855)", async () => {
    // The bug: `test_orders` generated+saved from `mysql-staging` then from
    // `clickhouse` (both group-less → pre-fix resolved to NULL) shared the
    // `coalesce(connection_group_id,'default')` upsert key and the second
    // clobbered the first. The fix keys each under its own install_id, so the
    // two rows are distinct AND each is surfaced by the install_id visibility
    // branch.
    seedGrouplessConnection("mysql-staging");
    seedGrouplessConnection("clickhouse");
    seedGroupOfOneEntity({
      id: "e-mysql",
      name: "test_orders",
      status: "published",
      installId: "mysql-staging",
      yaml: "table: test_orders\nengine: mysql",
    });
    seedGroupOfOneEntity({
      id: "e-ch",
      name: "test_orders",
      status: "published",
      installId: "clickhouse",
      yaml: "table: test_orders\nengine: clickhouse",
    });

    const rows = await listEntitiesWithOverlay("org-1", "entity");
    // Two distinct rows — one per connection group-of-one. `DISTINCT ON`
    // keys on connection_group_id, so the same name no longer collapses.
    expect(rows).toHaveLength(2);
    const scopes = rows.map((r) => r.connection_group_id).toSorted();
    expect(scopes).toEqual(["clickhouse", "mysql-staging"]);
    // Each row kept its own dialect-specific YAML — neither overwrote the other.
    const byScope = new Map(rows.map((r) => [r.connection_group_id, r.yaml_content]));
    expect(byScope.get("mysql-staging")).toContain("engine: mysql");
    expect(byScope.get("clickhouse")).toContain("engine: clickhouse");
  });

  it("a group-of-one entity is invisible once its standalone install is shadowed/archived (#3855)", async () => {
    // Sanity that the install_id visibility branch is gated on a LIVE install,
    // not a blanket pass — archiving the standalone datasource hides its
    // group-of-one entities just like a grouped connection.
    seedGrouplessConnection("clickhouse", "archived");
    seedGroupOfOneEntity({ id: "e-ch", name: "test_orders", status: "published", installId: "clickhouse" });

    const rows = await listEntitiesWithOverlay("org-1", "entity");
    expect(rows).toHaveLength(0);
  });

  it("a per-org install shadows a `__global__` group-of-one install with the same id (#3855)", async () => {
    // The group-less mirror of the #2304 shadow-precedence check: a `__global__`
    // group-of-one install is surfaced via the global install_id branch UNLESS
    // the org has its own row at the same install_id, in which case the NOT-IN
    // shadow guard drops it (and its entities) from the developer-mode overlay.
    seedGrouplessConnection("clickhouse", "published", "__global__");
    seedGroupOfOneEntity({ id: "e-ch", name: "test_orders", status: "published", installId: "clickhouse" });
    expect(rowsByName(await listEntitiesWithOverlay("org-1", "entity"))).toEqual({ test_orders: "published" });

    // Org-local install of the same id arrives — shadows the global group-of-one.
    seedGrouplessConnection("clickhouse", "archived", "org-1");
    expect(await listEntitiesWithOverlay("org-1", "entity")).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // listEntityRows (PUBLISHED read path) — the path real end-user queries take.
  // It carries the same group-of-one visibility branches as the developer
  // overlay above but with a `status = 'published'` install filter, so it
  // needs its own coverage: a copy-paste slip in the published variant would
  // pass every developer-mode test yet make a standalone datasource's tables
  // un-queryable in production (#3855, pr-test-analyzer gap #1).
  // -------------------------------------------------------------------------

  it("listEntityRows(published) surfaces two same-named group-of-one tables on distinct connections (#3855)", async () => {
    seedGrouplessConnection("mysql-staging");
    seedGrouplessConnection("clickhouse");
    seedGroupOfOneEntity({ id: "e-mysql", name: "test_orders", status: "published", installId: "mysql-staging" });
    seedGroupOfOneEntity({ id: "e-ch", name: "test_orders", status: "published", installId: "clickhouse" });

    const rows = await listEntityRows("org-1", "entity", "published");
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.connection_group_id).toSorted()).toEqual(["clickhouse", "mysql-staging"]);
  });

  it("listEntityRows(published) hides a group-of-one entity whose standalone install is archived (#3855)", async () => {
    // Only `status = 'published'` installs count in the published read — an
    // archived (or draft-only) standalone datasource must not surface its
    // group-of-one entities here.
    seedGrouplessConnection("clickhouse", "archived");
    seedGroupOfOneEntity({ id: "e-ch", name: "test_orders", status: "published", installId: "clickhouse" });

    const rows = await listEntityRows("org-1", "entity", "published");
    expect(rows).toHaveLength(0);
  });
});
