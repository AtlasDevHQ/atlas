/**
 * Real-Postgres tests for the built-in Datasource catalog seed's conflict
 * target and outcome accounting (#5266).
 *
 * ⚠️ WHAT ONLY REAL POSTGRES CAN SAY HERE. Half the fix is which conflict
 * target the INSERT names, and the difference between the two spellings is
 * something the DATABASE decides:
 *
 *   - `ON CONFLICT DO NOTHING`      — a slug held under a foreign id is
 *                                    swallowed. Zero rows, no error, and the
 *                                    pass reported the row as PRESERVED. That
 *                                    is #5266.
 *   - `ON CONFLICT (id) DO NOTHING` — the same collision raises 23505, which
 *                                    the seeder reports and steps over.
 *
 * A mocked pool cannot demonstrate either: it returns whatever the fixture
 * says. `seed-builtin-datasource-catalog-collision.test.ts` covers what the
 * seeder DOES with the rejection; this file covers that the rejection happens
 * at all — and that the old spelling would not have produced one, so the
 * change is load-bearing rather than decorative.
 *
 * Skipped cleanly when `TEST_DATABASE_URL` is unset. CI's api-tests workflow
 * provides the Postgres service.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import {
  BUILTIN_DATASOURCE_CATALOG_ROWS,
  seedBuiltinDatasourceCatalog,
  type BuiltinDatasourceCatalogSeedDb,
} from "@atlas/api/lib/db/seed-builtin-datasource-catalog";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;

const PG_TIMEOUT_MS = 30_000;

const SQUATTER_ID = "catalog:operator-made-this";
/** 4th of nine — neither first nor last, so a loop that stops early fails. */
const SQUATTED = BUILTIN_DATASOURCE_CATALOG_ROWS.find((r) => r.slug === "clickhouse")!;
const ALL_SLUGS = BUILTIN_DATASOURCE_CATALOG_ROWS.map((r) => r.slug);

describeIfPg("built-in Datasource catalog seed against real Postgres (#5266)", () => {
  let pool: Pool;
  let db: BuiltinDatasourceCatalogSeedDb;
  const schemaName = `dsseed_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

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
    //
    // ⚠️ THE FOUR CHECKs ARE COPIED FROM `schema.ts` DELIBERATELY — a fixture
    // looser than production cannot fail where production would.
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
        updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT chk_plugin_catalog_type
          CHECK (type IN ('datasource', 'context', 'interaction', 'action', 'sandbox', 'chat', 'integration')),
        CONSTRAINT chk_plugin_catalog_install_model
          CHECK (install_model IN ('oauth', 'form', 'static-bot', 'oauth-datasource')),
        CONSTRAINT chk_plugin_catalog_pillar
          CHECK (pillar IN ('datasource', 'chat', 'action', 'knowledge')),
        CONSTRAINT chk_plugin_catalog_implementation_status
          CHECK (implementation_status IN ('available', 'coming_soon'))
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
   * production-reachable shape #5266 is about. `slug` is settable only at
   * create (`lib/integrations/catalog-crud.ts` has no `slug` in its update
   * builder), so it takes a row created before the built-in was ever seeded.
   */
  async function insertSquatter(): Promise<void> {
    await pool.query(
      `INSERT INTO plugin_catalog
         (id, name, slug, type, install_model, pillar, implementation_status,
          auto_install, min_plan, enabled, saas_eligible)
       VALUES ($1, 'Our own warehouse card', $2, 'datasource', 'form', 'datasource',
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
    const result = await seedBuiltinDatasourceCatalog(db);
    expect(result.insertedSlugs).toEqual(ALL_SLUGS);
    expect(result.preservedSlugs).toEqual([]);
    expect(result.blockedSlugs).toEqual([]);
    expect(await slugsInCatalog()).toEqual([...ALL_SLUGS].sort());
  }, PG_TIMEOUT_MS);

  it("is a no-op on a second pass — everything preserved, nothing blocked", async () => {
    await seedBuiltinDatasourceCatalog(db);
    const second = await seedBuiltinDatasourceCatalog(db);
    expect(second.insertedSlugs).toEqual([]);
    expect(second.preservedSlugs).toEqual(ALL_SLUGS);
    expect(second.blockedSlugs).toEqual([]);
  }, PG_TIMEOUT_MS);

  it("⭐ raises 23505 rather than silently no-op'ing when a foreign id holds the slug", async () => {
    // The behaviour the fix depends on, asserted directly against Postgres
    // rather than inferred from the seeder's catch.
    await insertSquatter();
    let raised: { code?: unknown; constraint?: unknown; detail?: unknown } | undefined;
    try {
      await pool.query(
        `INSERT INTO plugin_catalog
           (id, name, slug, type, install_model, pillar, implementation_status,
            auto_install, min_plan, enabled, saas_eligible)
         VALUES ($1, 'x', $2, 'datasource', 'form', 'datasource', 'available',
                 false, 'starter', true, true)
         ON CONFLICT (id) DO NOTHING`,
        [SQUATTED.id, SQUATTED.slug],
      );
    } catch (err) {
      raised = err as { code?: unknown; constraint?: unknown; detail?: unknown };
    }
    expect(raised?.code).toBe("23505");
    // ⚠️ THE SHAPE TOO, not only the code. The mocked collision suite asserts a
    // warn payload carrying `constraint: "plugin_catalog_slug_key"` and
    // `detail: "Key (slug)=(…) already exists."` — both hand-written in that
    // file's own fixture, so it is agreeing with itself. These two lines are
    // where those strings are checked against Postgres.
    expect(raised?.constraint).toBe("plugin_catalog_slug_key");
    expect(String(raised?.detail)).toContain(`Key (slug)=(${SQUATTED.slug})`);
  }, PG_TIMEOUT_MS);

  it("⭐ and the UNQUALIFIED target swallows exactly that collision — the defect, measured", async () => {
    // The counterfactual, run rather than reasoned about. If this ever starts
    // raising, the qualified target is no longer buying anything and #5266's
    // whole argument needs re-reading.
    await insertSquatter();
    const { rows } = await pool.query(
      `INSERT INTO plugin_catalog
         (id, name, slug, type, install_model, pillar, implementation_status,
          auto_install, min_plan, enabled, saas_eligible)
       VALUES ($1, 'x', $2, 'datasource', 'form', 'datasource', 'available',
               false, 'starter', true, true)
       ON CONFLICT DO NOTHING
       RETURNING slug`,
      [SQUATTED.id, SQUATTED.slug],
    );
    // No error, no row — and the canonical id was never created. Under the old
    // subtraction this empty result is precisely what got counted as preserved.
    expect(rows).toHaveLength(0);
    const { rows: canonical } = await pool.query(`SELECT id FROM plugin_catalog WHERE id = $1`, [
      SQUATTED.id,
    ]);
    expect(canonical).toHaveLength(0);
  }, PG_TIMEOUT_MS);

  it("⭐ reports the squatted row as blocked, NOT as preserved, and seeds all the others", async () => {
    await insertSquatter();
    const result = await seedBuiltinDatasourceCatalog(db);

    expect(result.blockedSlugs).toEqual([SQUATTED.slug]);
    // ⚠️ THE WHOLE POINT OF #5266. The old derivation put this slug in
    // `preservedSlugs` — telling the caller a row the catalog does not have is
    // fine. `preservedSlugs` is empty here because nothing legitimately
    // pre-existed: 8 inserted, 0 preserved, 1 blocked, three different sizes.
    expect(result.preservedSlugs).toEqual([]);
    expect(result.insertedSlugs).toEqual(ALL_SLUGS.filter((s) => s !== SQUATTED.slug));
    expect(result.insertedSlugs).toHaveLength(ALL_SLUGS.length - 1);

    // And the catalog agrees: the canonical id was never created.
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM plugin_catalog WHERE id = $1`,
      [SQUATTED.id],
    );
    expect(rows).toHaveLength(0);
    // ⚠️ THE ID SET, NOT A COUNT. "8 built-ins + the squatter" and "all 9
    // built-ins, squatter clobbered" are both 9 rows, so a count cannot tell
    // apart the world where the seeder lost this contest from the world where
    // it won it — and the seeder is supposed to lose.
    const { rows: present } = await pool.query<{ id: string }>(
      `SELECT id FROM plugin_catalog ORDER BY id`,
    );
    expect(present.map((r) => r.id)).toEqual(
      [
        SQUATTER_ID,
        ...BUILTIN_DATASOURCE_CATALOG_ROWS.filter((r) => r.slug !== SQUATTED.slug).map((r) => r.id),
      ].sort(),
    );
  }, PG_TIMEOUT_MS);

  it("⭐ keeps a genuinely preserved row apart from a blocked one in the same pass", async () => {
    // The discriminating case: `postgres` legitimately exists under its
    // canonical id (preserved), `clickhouse` is squatted (blocked). Under the
    // old subtraction both were "not inserted" and reported identically.
    await insertSquatter();
    const canonical = BUILTIN_DATASOURCE_CATALOG_ROWS.find((r) => r.slug === "postgres")!;
    await pool.query(
      `INSERT INTO plugin_catalog
         (id, name, slug, type, install_model, pillar, implementation_status,
          auto_install, min_plan, enabled, saas_eligible)
       VALUES ($1, 'Pre-existing', $2, 'datasource', 'form', 'datasource',
               'available', false, 'starter', true, true)`,
      [canonical.id, canonical.slug],
    );

    const result = await seedBuiltinDatasourceCatalog(db);
    expect(result.preservedSlugs).toEqual(["postgres"]);
    expect(result.blockedSlugs).toEqual([SQUATTED.slug]);
    expect(result.insertedSlugs).toHaveLength(ALL_SLUGS.length - 2);
  }, PG_TIMEOUT_MS);

  it("does not clobber the squatter's own row", async () => {
    // The seeder must lose this contest, not win it: the operator's row is the
    // one that legitimately holds the slug.
    await insertSquatter();
    await seedBuiltinDatasourceCatalog(db);
    const { rows } = await pool.query<{ name: string }>(
      `SELECT name FROM plugin_catalog WHERE id = $1`,
      [SQUATTER_ID],
    );
    expect(rows[0]?.name).toBe("Our own warehouse card");
  }, PG_TIMEOUT_MS);

  it("stays blocked, and stays out of preserved, on a re-boot", async () => {
    await insertSquatter();
    await seedBuiltinDatasourceCatalog(db);
    const second = await seedBuiltinDatasourceCatalog(db);
    // Everything else is present now, so nothing is inserted — but the blocked
    // row is still blocked, and still must not drift into `preservedSlugs`.
    // A second pass is exactly where the old subtraction looked most innocent:
    // every slug "preserved", nothing inserted, no error.
    expect(second.insertedSlugs).toEqual([]);
    expect(second.blockedSlugs).toEqual([SQUATTED.slug]);
    expect(second.preservedSlugs).toEqual(ALL_SLUGS.filter((s) => s !== SQUATTED.slug));
    expect(second.preservedSlugs).not.toContain(SQUATTED.slug);
  }, PG_TIMEOUT_MS);
});
