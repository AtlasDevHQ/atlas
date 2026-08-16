/**
 * Real-Postgres tests for the built-in Knowledge Base catalog seed's conflict
 * target (#5239).
 *
 * ⚠️ WHAT ONLY REAL POSTGRES CAN SAY HERE. The whole fix is which conflict
 * target the INSERT names, and the difference between the two spellings is
 * something the DATABASE decides:
 *
 *   - `ON CONFLICT DO NOTHING`      — a slug held under a foreign id is
 *                                    swallowed. Zero rows, no error, and the
 *                                    pass reports success for a row it never
 *                                    wrote. That is #5239.
 *   - `ON CONFLICT (id) DO NOTHING` — the same collision raises 23505, which
 *                                    the seeder reports and steps over.
 *
 * A mocked pool cannot demonstrate either: it returns whatever the fixture
 * says. `seed-builtin-knowledge-catalog-collision.test.ts` covers what the
 * seeder DOES with the rejection (warn, continue, report); this file covers
 * that the rejection happens at all — and that the old spelling would not have
 * produced one, so the change is load-bearing rather than decorative.
 *
 * Skipped cleanly when `TEST_DATABASE_URL` is unset. CI's api-tests workflow
 * provides the Postgres service.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import {
  BUILTIN_KNOWLEDGE_CATALOG_ROWS,
  BUILTIN_GITBOOK_CATALOG_ROW,
  seedBuiltinKnowledgeCatalog,
  type BuiltinKnowledgeCatalogSeedDb,
} from "@atlas/api/lib/db/seed-builtin-knowledge-catalog";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;

const PG_TIMEOUT_MS = 30_000;

const SQUATTER_ID = "catalog:operator-made-this";
const SQUATTED = BUILTIN_GITBOOK_CATALOG_ROW;
const ALL_SLUGS = BUILTIN_KNOWLEDGE_CATALOG_ROWS.map((r) => r.slug);

describeIfPg("built-in Knowledge Base catalog seed against real Postgres (#5239)", () => {
  let pool: Pool;
  let db: BuiltinKnowledgeCatalogSeedDb;
  const schemaName = `kbseed_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

  beforeAll(async () => {
    // `search_path` baked into the connection, `public` deliberately absent —
    // this file runs unqualified `TRUNCATE plugin_catalog`, and a developer's
    // `TEST_DATABASE_URL` points at their dev database.
    pool = new Pool({
      connectionString: TEST_DB_URL,
      options: `-c search_path="${schemaName}"`,
    });
    await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
    const { rows } = await pool.query<{ s: string }>(`SELECT current_schema() AS s`);
    expect(rows[0]?.s).toBe(schemaName);

    // The columns the seeder's INSERT names, with the two constraints the
    // conflict target is about: `id` PRIMARY KEY and `slug` UNIQUE. Without
    // the UNIQUE on slug this whole file would pass with either spelling.
    await pool.query(`
      CREATE TABLE plugin_catalog (
        id                    TEXT PRIMARY KEY,
        name                  TEXT NOT NULL,
        slug                  TEXT NOT NULL UNIQUE,
        description           TEXT,
        type                  TEXT NOT NULL,
        install_model         TEXT NOT NULL,
        pillar                TEXT NOT NULL,
        implementation_status TEXT NOT NULL,
        auto_install          BOOLEAN NOT NULL,
        min_plan              TEXT NOT NULL,
        enabled               BOOLEAN NOT NULL,
        saas_eligible         BOOLEAN NOT NULL,
        config_schema         JSONB,
        created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    db = {
      async query<T = unknown>(sql: string, params?: unknown[]) {
        const result = await pool.query(sql, params);
        return { rows: result.rows as T[] };
      },
    };
  }, PG_TIMEOUT_MS);

  afterAll(async () => {
    if (!pool) return;
    await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    await pool.end();
  }, PG_TIMEOUT_MS);

  beforeEach(async () => {
    await pool.query(`TRUNCATE plugin_catalog`);
  }, PG_TIMEOUT_MS);

  /**
   * An operator-created row squatting a built-in slug under its own id — the
   * production-reachable shape #5239 is about. `slug` is settable only at
   * create (`lib/integrations/catalog-crud.ts` has no `slug` in its update
   * builder), so it takes a row created before the built-in was ever seeded.
   */
  async function insertSquatter(): Promise<void> {
    await pool.query(
      `INSERT INTO plugin_catalog
         (id, name, slug, type, install_model, pillar, implementation_status,
          auto_install, min_plan, enabled, saas_eligible)
       VALUES ($1, 'Our own docs card', $2, 'context', 'form', 'knowledge',
               'available', false, 'starter', true, true)`,
      [SQUATTER_ID, SQUATTED.slug],
    );
  }

  const slugsInCatalog = async (): Promise<string[]> => {
    const { rows } = await pool.query<{ slug: string }>(
      `SELECT slug FROM plugin_catalog WHERE id LIKE 'catalog:%' ORDER BY slug`,
    );
    return rows.map((r) => r.slug);
  };

  it("seeds every row on an empty catalog", async () => {
    const result = await seedBuiltinKnowledgeCatalog(db);
    expect(result.insertedSlugs).toEqual(ALL_SLUGS);
    expect(result.blockedSlugs).toEqual([]);
    expect(await slugsInCatalog()).toEqual([...ALL_SLUGS].sort());
  }, PG_TIMEOUT_MS);

  it("is a no-op on a second pass — nothing inserted, nothing blocked", async () => {
    await seedBuiltinKnowledgeCatalog(db);
    const second = await seedBuiltinKnowledgeCatalog(db);
    expect(second.inserted).toBe(false);
    expect(second.insertedSlugs).toEqual([]);
    expect(second.blockedSlugs).toEqual([]);
  }, PG_TIMEOUT_MS);

  it("⭐ raises 23505 rather than silently no-op'ing when a foreign id holds the slug", async () => {
    // The behaviour the fix depends on, asserted directly against Postgres
    // rather than inferred from the seeder's catch.
    await insertSquatter();
    let raised: { code?: unknown; constraint?: unknown } | undefined;
    try {
      await pool.query(
        `INSERT INTO plugin_catalog
           (id, name, slug, type, install_model, pillar, implementation_status,
            auto_install, min_plan, enabled, saas_eligible)
         VALUES ($1, 'x', $2, 'context', 'form', 'knowledge', 'available',
                 false, 'starter', true, true)
         ON CONFLICT (id) DO NOTHING`,
        [SQUATTED.id, SQUATTED.slug],
      );
    } catch (err) {
      raised = err as { code?: unknown; constraint?: unknown };
    }
    expect(raised?.code).toBe("23505");
  }, PG_TIMEOUT_MS);

  it("⭐ and the UNQUALIFIED target swallows exactly that collision — the defect, measured", async () => {
    // The counterfactual, run rather than reasoned about. If this ever starts
    // raising, the qualified target is no longer buying anything and #5239's
    // whole argument needs re-reading.
    await insertSquatter();
    const { rows } = await pool.query(
      `INSERT INTO plugin_catalog
         (id, name, slug, type, install_model, pillar, implementation_status,
          auto_install, min_plan, enabled, saas_eligible)
       VALUES ($1, 'x', $2, 'context', 'form', 'knowledge', 'available',
               false, 'starter', true, true)
       ON CONFLICT DO NOTHING
       RETURNING slug`,
      [SQUATTED.id, SQUATTED.slug],
    );
    // No error, no row — and the canonical id was never created. This is what
    // used to be reported as a successfully seeded catalog.
    expect(rows).toHaveLength(0);
    const { rows: canonical } = await pool.query(`SELECT id FROM plugin_catalog WHERE id = $1`, [
      SQUATTED.id,
    ]);
    expect(canonical).toHaveLength(0);
  }, PG_TIMEOUT_MS);

  it("⭐ reports the squatted row as blocked and seeds all the others", async () => {
    await insertSquatter();
    const result = await seedBuiltinKnowledgeCatalog(db);

    expect(result.blockedSlugs).toEqual([SQUATTED.slug]);
    // 13 inserted vs 1 blocked — different sizes, so the two lists cannot be
    // swapped without the counts disagreeing.
    expect(result.insertedSlugs).toEqual(ALL_SLUGS.filter((s) => s !== SQUATTED.slug));
    expect(result.insertedSlugs).toHaveLength(ALL_SLUGS.length - 1);

    // And the catalog agrees: every canonical id EXCEPT the blocked one.
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM plugin_catalog WHERE id = $1`,
      [SQUATTED.id],
    );
    expect(rows).toHaveLength(0);
    const { rows: others } = await pool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM plugin_catalog WHERE id LIKE 'catalog:%'`,
    );
    // 14 built-ins minus the blocked one, plus the squatter itself.
    expect(others[0]?.n).toBe(String(ALL_SLUGS.length));
  }, PG_TIMEOUT_MS);

  it("does not clobber the squatter's own row", async () => {
    // The seeder must lose this contest, not win it: the operator's row is the
    // one that legitimately holds the slug.
    await insertSquatter();
    await seedBuiltinKnowledgeCatalog(db);
    const { rows } = await pool.query<{ name: string }>(
      `SELECT name FROM plugin_catalog WHERE id = $1`,
      [SQUATTER_ID],
    );
    expect(rows[0]?.name).toBe("Our own docs card");
  }, PG_TIMEOUT_MS);

  it("stays blocked, and stays quiet about the rest, on a re-boot", async () => {
    await insertSquatter();
    await seedBuiltinKnowledgeCatalog(db);
    const second = await seedBuiltinKnowledgeCatalog(db);
    // Everything else is present now, so nothing is inserted — but the blocked
    // row is still blocked, and still reported. A `blockedSlugs` that emptied
    // out on the second pass would put the operator back where #5239 started.
    expect(second.insertedSlugs).toEqual([]);
    expect(second.blockedSlugs).toEqual([SQUATTED.slug]);
    expect(second.inserted).toBe(false);
  }, PG_TIMEOUT_MS);
});
