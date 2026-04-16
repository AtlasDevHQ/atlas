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
import { listEntitiesWithOverlay } from "@atlas/api/lib/semantic/entities";

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

  // Minimal schema — only the columns referenced by the overlay CTE.
  db.public.none(`
    CREATE TABLE connections (
      id TEXT NOT NULL,
      org_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'published',
      PRIMARY KEY (id, org_id)
    );
    CREATE TABLE semantic_entities (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      name TEXT NOT NULL,
      yaml_content TEXT NOT NULL,
      connection_id TEXT,
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
  db.public.none(`TRUNCATE semantic_entities; TRUNCATE connections;`);
});

// ---------------------------------------------------------------------------
// Fixture helpers — thin wrappers around raw INSERTs
// ---------------------------------------------------------------------------

function seedConnection(id: string, status: "published" | "draft" | "archived" = "published"): void {
  db.public.none(
    `INSERT INTO connections (id, org_id, status) VALUES ('${id}', 'org-1', '${status}')`,
  );
}

function seedEntity(opts: {
  id: string;
  name: string;
  status: "published" | "draft" | "draft_delete" | "archived";
  connectionId?: string | null;
  yaml?: string;
}): void {
  const conn = opts.connectionId === undefined ? "NULL" : opts.connectionId === null ? "NULL" : `'${opts.connectionId}'`;
  const yaml = (opts.yaml ?? `table: ${opts.name}`).replace(/'/g, "''");
  db.public.none(
    `INSERT INTO semantic_entities (id, org_id, entity_type, name, yaml_content, connection_id, status)
     VALUES ('${opts.id}', 'org-1', 'entity', '${opts.name}', '${yaml}', ${conn}, '${opts.status}')`,
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

  it("case 3: draft supersedes published for the same (name, connection_id) key", async () => {
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

  it("NULL connection_id entities pass through (org-level, not connection-scoped)", async () => {
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
      `INSERT INTO semantic_entities (id, org_id, entity_type, name, yaml_content, connection_id, status)
       VALUES ('m1', 'org-1', 'metric', 'mrr', 'name: mrr', 'warehouse', 'published')`,
    );

    const entities = await listEntitiesWithOverlay("org-1", "entity");
    const metrics = await listEntitiesWithOverlay("org-1", "metric");

    expect(rowsByName(entities)).toEqual({ users: "published" });
    expect(rowsByName(metrics)).toEqual({ mrr: "published" });
  });

  it("cross-org rows are invisible", async () => {
    // Seed an entity under a different org — should never appear in org-1's overlay
    db.public.none(
      `INSERT INTO connections (id, org_id, status) VALUES ('warehouse', 'org-2', 'published')`,
    );
    db.public.none(
      `INSERT INTO semantic_entities (id, org_id, entity_type, name, yaml_content, connection_id, status)
       VALUES ('other', 'org-2', 'entity', 'other_users', 'table: other', 'warehouse', 'published')`,
    );

    // org-1 has nothing
    const rows = await listEntitiesWithOverlay("org-1", "entity");
    expect(rows).toHaveLength(0);
  });
});
