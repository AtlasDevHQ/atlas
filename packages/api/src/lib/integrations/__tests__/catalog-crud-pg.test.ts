/**
 * Real-Postgres coverage for the platform-admin catalog CRUD SQL
 * (#4232). Mirrors the `persist-form-install-pg.test.ts` harness: skips
 * cleanly when `TEST_DATABASE_URL` is unset, runs every migration into a
 * unique per-test-file schema, and executes {@link buildCatalogCreateSql}
 * / {@link buildCatalogUpdateSql} VERBATIM against the live schema.
 *
 * What this catches that the mocked route tests can't: plan-time /
 * constraint-time SQL errors. The pre-#4232 `POST /catalog` INSERT
 * omitted `pillar` — NOT NULL since 0092, and 0096 dropped
 * `trg_plugin_catalog_default_pillar` (the BEFORE INSERT trigger that
 * derived it from `type`) — so every platform catalog create 23502'd at
 * runtime while the mocked tests stayed green. 0096 also dropped
 * `trg_plugin_catalog_sync_pillar_on_type_change`, so a `PUT` that
 * changes `type` silently left `pillar` stale.
 *
 * Opt in locally with:
 *   bun run db:up && export TEST_DATABASE_URL=postgresql://atlas:atlas@localhost:5432/atlas
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import { runMigrations } from "@atlas/api/lib/db/migrate";
import { MANAGED_AUTH_MIGRATIONS } from "@atlas/api/lib/db/internal";
import {
  buildCatalogCreateSql,
  buildCatalogUpdateSql,
  type CatalogType,
} from "../catalog-crud";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;

// Full migration set + queries can take several seconds on shared CI
// runners (matches migrate-pg.test.ts's budget).
const PG_TEST_TIMEOUT_MS = 30_000;

/** Minimal valid `POST /catalog` body for a given type/slug. */
function createFields(type: CatalogType, slug: string) {
  return {
    name: `Catalog ${slug}`,
    slug,
    type,
    minPlan: "starter" as const,
    enabled: true,
  };
}

describeIfPg("platform catalog CRUD against the live schema (#4232)", () => {
  let pool: Pool;
  const schemaName = `catalog_crud_pg_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DB_URL });
    pool.on("connect", (client) => {
      void client.query(`SET search_path TO "${schemaName}"`).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`catalog-crud-pg: SET search_path failed on new connection: ${message}`);
      });
    });
    await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
    await runMigrations(pool, { skip: MANAGED_AUTH_MIGRATIONS });
  }, PG_TEST_TIMEOUT_MS * 2);

  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`catalog-crud-pg: schema cleanup failed: ${message}`);
    });
    await pool.end();
  });

  // Every type CreateCatalogBodySchema admits, with the pillar the 0092
  // trigger used to derive (ADR-0006: chat→chat, datasource→datasource,
  // everything else→action). The route doesn't admit 'chat'/'integration',
  // but the mapping module serves the catalog-seeder too, which does.
  it.each([
    ["datasource", "datasource"],
    ["context", "action"],
    ["interaction", "action"],
    ["action", "action"],
    ["sandbox", "action"],
  ] as const)(
    "POST /catalog INSERT executes verbatim for type %s and derives pillar %s",
    async (type, expectedPillar) => {
      const stamp = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
      const id = crypto.randomUUID();
      const create = buildCatalogCreateSql(id, createFields(type, `crud-${type}-${stamp}`));

      // Pre-#4232 this throws 23502: `pillar` is NOT NULL with no default
      // and the deriving trigger is gone (0096).
      const { rows } = await pool.query<{ id: string; pillar: string }>(create.sql, create.params);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe(id);
      expect(rows[0]?.pillar).toBe(expectedPillar);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it("a pillar-less INSERT still 23502s — the schema demands explicit naming", async () => {
    // Deliberately fails if someone reintroduces a column default or a
    // deriving trigger: every writer must keep naming pillar (#4232).
    const stamp = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    await expect(
      pool.query(
        `INSERT INTO plugin_catalog (id, name, slug, type)
         VALUES ($1, $2, $3, 'action')`,
        [crypto.randomUUID(), "No Pillar", `crud-nopillar-${stamp}`],
      ),
    ).rejects.toMatchObject({ code: "23502" });
  }, PG_TEST_TIMEOUT_MS);

  it("PUT /catalog/:id re-derives pillar when type changes (0092 sync trigger semantics, dropped by 0096)", async () => {
    const stamp = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    const id = crypto.randomUUID();
    const create = buildCatalogCreateSql(id, createFields("action", `crud-sync-${stamp}`));
    await pool.query(create.sql, create.params);

    const update = buildCatalogUpdateSql(id, { type: "datasource" });
    expect(update).not.toBeNull();
    const { rows } = await pool.query<{ type: string; pillar: string }>(update!.sql, update!.params);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.type).toBe("datasource");
    expect(rows[0]?.pillar).toBe("datasource");
  }, PG_TEST_TIMEOUT_MS);

  it("PUT /catalog/:id without a type change leaves pillar untouched", async () => {
    const stamp = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    const id = crypto.randomUUID();
    const create = buildCatalogCreateSql(id, createFields("datasource", `crud-noop-${stamp}`));
    await pool.query(create.sql, create.params);

    const update = buildCatalogUpdateSql(id, { name: "Renamed" });
    expect(update).not.toBeNull();
    const { rows } = await pool.query<{ name: string; pillar: string }>(update!.sql, update!.params);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe("Renamed");
    expect(rows[0]?.pillar).toBe("datasource");
  }, PG_TEST_TIMEOUT_MS);

  it("PUT /catalog/:id with an unchanged type does NOT clobber an explicit knowledge pillar", async () => {
    // Knowledge-pillar rows (type 'context', pillar 'knowledge' — 0161 /
    // ADR-0028) are created by the built-in knowledge seeder
    // (`seed-builtin-knowledge-catalog.ts`) with pillar named explicitly;
    // the CRUD mapping never derives 'knowledge'. The 0092 sync trigger
    // (dropped by 0096) only re-derived pillar when type ACTUALLY changed
    // (`IS DISTINCT FROM`), so a same-type PUT on a knowledge row must
    // preserve pillar='knowledge' rather than rewrite it to 'action'.
    const stamp = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO plugin_catalog (id, name, slug, type, pillar, install_model)
       VALUES ($1, $2, $3, 'context', 'knowledge', 'form')`,
      [id, "OKF Collection", `crud-knowledge-${stamp}`],
    );

    const sameType = buildCatalogUpdateSql(id, { type: "context", name: "OKF v2" });
    expect(sameType).not.toBeNull();
    const same = await pool.query<{ pillar: string; name: string }>(sameType!.sql, sameType!.params);
    expect(same.rows[0]?.name).toBe("OKF v2");
    expect(same.rows[0]?.pillar).toBe("knowledge");

    // An ACTUAL type change re-derives per the mapping — same semantics
    // the 0092 sync trigger had. One-way: flipping type back to 'context'
    // would land on 'action', not 'knowledge' (the mapping can't emit it).
    const changed = buildCatalogUpdateSql(id, { type: "action" });
    expect(changed).not.toBeNull();
    const after = await pool.query<{ pillar: string }>(changed!.sql, changed!.params);
    expect(after.rows[0]?.pillar).toBe("action");
  }, PG_TEST_TIMEOUT_MS);
});
