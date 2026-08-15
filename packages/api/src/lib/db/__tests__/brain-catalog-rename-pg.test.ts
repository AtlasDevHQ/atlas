/**
 * Real-Postgres tests for migration 0201 — renaming the two Company Atlas
 * ingest catalog rows (#5082, ADR-0038).
 *
 * Why real Postgres: the migration's entire value is in a guard the SQL text
 * cannot demonstrate — a per-column `CASE` inside a row-level `WHERE`, so that
 * a row an operator partially rewrote through the catalog CRUD path keeps the
 * half they edited and still gets the half they didn't. A mocked query layer
 * evaluates none of that; it would report success against
 * `UPDATE plugin_catalog SET name = 'Company Atlas (…)'` with no guard at all,
 * which would silently revert an operator's edit in three prod regions.
 *
 * The load-bearing assertions here are the NEGATIVE ones: an operator-renamed
 * row is not clobbered, a row of a DIFFERENT catalog id is untouched, and a
 * second run changes nothing. A test that only checked "the stock row got
 * renamed" would pass against an unguarded blanket UPDATE.
 *
 * The expected post-migration values come from the seed constants, never from
 * literals retyped here — the migration and the constants must agree, and a
 * fixture that hand-writes both sides cannot prove it. The PRE-migration
 * values are derived from the same constants by inverting the ADR-0038 rename,
 * for the same reason. `seed-builtin-knowledge-catalog.test.ts` pins that
 * derivation against the migration text itself.
 *
 * Skipped cleanly when `TEST_DATABASE_URL` is unset (matches `migrate-pg` /
 * `scim-provider-seal-ownerless-pg`). CI's api-tests workflow provides the
 * Postgres service.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import {
  BUILTIN_ZOOM_TRANSCRIPTS_CATALOG_ROW,
  BUILTIN_OUTLOOK_MAIL_CATALOG_ROW,
} from "@atlas/api/lib/db/seed-builtin-knowledge-catalog";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;

const PG_TIMEOUT_MS = 30_000;

const MIGRATION_SQL = readFileSync(
  join(import.meta.dir, "..", "migrations", "0201_brain_catalog_rows_company_atlas.sql"),
  "utf8",
);

/** ADR-0038's rename, inverted: what these rows held before 0201 ran. */
const preRename = (s: string): string =>
  s.replace("Company Atlas (", "Company Brain (").replace("the Company Atlas", "the company brain");

const ZOOM = BUILTIN_ZOOM_TRANSCRIPTS_CATALOG_ROW;
const OUTLOOK = BUILTIN_OUTLOOK_MAIL_CATALOG_ROW;

interface CatalogRow {
  id: string;
  name: string;
  description: string | null;
  updated_at: Date;
}

describeIfPg("migration 0201 — rename the Company Atlas ingest catalog rows (#5082)", () => {
  let pool: Pool;
  const schemaName = `catrename_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DB_URL });
    pool.on("connect", (client) => {
      void client.query(`SET search_path TO "${schemaName}"`).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`brain-catalog-rename-pg: SET search_path failed: ${message}`);
      });
    });
    await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
    // The migration only ever touches `id`, `name`, `description` and
    // `updated_at`, so the fixture stands up that projection rather than the
    // full production table — a narrower table proves the statement never
    // reaches for a column it has no business writing.
    await pool.query(`
      CREATE TABLE plugin_catalog (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        description TEXT,
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
  }, PG_TIMEOUT_MS);

  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    await pool.end();
  }, PG_TIMEOUT_MS);

  async function rowOf(id: string): Promise<CatalogRow | undefined> {
    const { rows } = await pool.query<CatalogRow>(
      `SELECT id, name, description, updated_at FROM plugin_catalog WHERE id = $1`,
      [id],
    );
    return rows[0];
  }

  /**
   * Seed the catalog as an upgraded region holds it: both Company Atlas rows
   * still pre-rename, plus an unrelated vendor row whose copy the migration
   * must never reach. `updated_at` is backdated so a bump is observable.
   */
  async function seedPreRename(): Promise<void> {
    await pool.query(`TRUNCATE plugin_catalog`);
    await pool.query(
      `INSERT INTO plugin_catalog (id, name, description, updated_at) VALUES
         ($1, $2, $3, TIMESTAMPTZ '2020-01-01 00:00:00+00'),
         ($4, $5, $6, TIMESTAMPTZ '2020-01-01 00:00:00+00'),
         ('catalog:notion-knowledge', 'Notion', 'Sync Notion pages into the company brain somehow.', TIMESTAMPTZ '2020-01-01 00:00:00+00')`,
      [
        ZOOM.id,
        preRename(ZOOM.name),
        preRename(ZOOM.description),
        OUTLOOK.id,
        preRename(OUTLOOK.name),
        preRename(OUTLOOK.description),
      ],
    );
  }

  describe("an upgraded region holding the stock pre-rename rows", () => {
    beforeEach(async () => {
      await seedPreRename();
      await pool.query(MIGRATION_SQL);
    }, PG_TIMEOUT_MS);

    it("renames the Zoom row to exactly the seed constant", async () => {
      const row = await rowOf(ZOOM.id);
      expect(row?.name).toBe(ZOOM.name);
      expect(row?.description).toBe(ZOOM.description);
    });

    it("renames the Outlook row to exactly the seed constant", async () => {
      const row = await rowOf(OUTLOOK.id);
      expect(row?.name).toBe(OUTLOOK.name);
      expect(row?.description).toBe(OUTLOOK.description);
    });

    it("leaves an unrelated catalog row completely alone", async () => {
      // Negative, and the widest blast radius available: this is what dies if
      // either statement loses its `WHERE` and rewrites the whole table.
      // Measured — dropping both `WHERE` clauses kills this test. It does NOT
      // catch a merely id-LESS statement, because the remaining string
      // predicates are exact equality and this row's copy differs; the two
      // `WHERE id =` assertions in
      // `seed-builtin-knowledge-catalog.test.ts` are what cover that, and the
      // "does not confuse the two rows" case below covers a wrong id.
      // `company brain` appears in this row's description deliberately, so the
      // decoy would also catch a substring/`LIKE`-keyed rewrite if one were
      // ever introduced.
      const row = await rowOf("catalog:notion-knowledge");
      expect(row?.name).toBe("Notion");
      expect(row?.description).toBe("Sync Notion pages into the company brain somehow.");
      expect(row?.updated_at.toISOString()).toBe("2020-01-01T00:00:00.000Z");
    });

    it("bumps updated_at on the two rows it wrote", async () => {
      const zoom = await rowOf(ZOOM.id);
      const outlook = await rowOf(OUTLOOK.id);
      expect(zoom?.updated_at.getUTCFullYear()).toBeGreaterThan(2020);
      expect(outlook?.updated_at.getUTCFullYear()).toBeGreaterThan(2020);
    });

    it("is idempotent — a second run changes nothing and bumps nothing", async () => {
      const before = await rowOf(ZOOM.id);
      await pool.query(MIGRATION_SQL);
      const after = await rowOf(ZOOM.id);
      expect(after?.name).toBe(ZOOM.name);
      expect(after?.description).toBe(ZOOM.description);
      // The `WHERE` no longer matches, so the row is not rewritten at all —
      // distinguishing "idempotent result" from "rewritten to the same value",
      // which is what an unguarded blanket UPDATE would do.
      expect(after?.updated_at.toISOString()).toBe(before?.updated_at.toISOString());
    });
  });

  describe("a fresh region seeded after the rename", () => {
    it("no-ops on rows that already carry the new copy", async () => {
      await pool.query(`TRUNCATE plugin_catalog`);
      await pool.query(
        `INSERT INTO plugin_catalog (id, name, description, updated_at)
           VALUES ($1, $2, $3, TIMESTAMPTZ '2020-01-01 00:00:00+00')`,
        [ZOOM.id, ZOOM.name, ZOOM.description],
      );
      await pool.query(MIGRATION_SQL);
      const row = await rowOf(ZOOM.id);
      expect(row?.name).toBe(ZOOM.name);
      expect(row?.updated_at.toISOString()).toBe("2020-01-01T00:00:00.000Z");
    }, PG_TIMEOUT_MS);

    it("no-ops on an empty catalog — the migration runs before the boot seed", async () => {
      await pool.query(`TRUNCATE plugin_catalog`);
      await expect(pool.query(MIGRATION_SQL)).resolves.toBeDefined();
      const { rows } = await pool.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM plugin_catalog`,
      );
      expect(rows[0]?.n).toBe("0");
    }, PG_TIMEOUT_MS);
  });

  describe("operator-edited rows (catalog CRUD is a live write path)", () => {
    it("leaves a fully operator-renamed row alone", async () => {
      await pool.query(`TRUNCATE plugin_catalog`);
      await pool.query(
        `INSERT INTO plugin_catalog (id, name, description, updated_at)
           VALUES ($1, 'Meeting recordings', 'Our own words for this.', TIMESTAMPTZ '2020-01-01 00:00:00+00')`,
        [ZOOM.id],
      );
      await pool.query(MIGRATION_SQL);
      const row = await rowOf(ZOOM.id);
      expect(row?.name).toBe("Meeting recordings");
      expect(row?.description).toBe("Our own words for this.");
      expect(row?.updated_at.toISOString()).toBe("2020-01-01T00:00:00.000Z");
    }, PG_TIMEOUT_MS);

    it("renames the stock NAME while keeping an operator-rewritten DESCRIPTION", async () => {
      // The per-column `CASE` is the whole reason this migration is not two
      // row-level guards. A row-level guard would abandon BOTH columns here,
      // leaving a customer-visible "Company Brain" name behind — the exact
      // divergence #5082 exists to close.
      await pool.query(`TRUNCATE plugin_catalog`);
      await pool.query(
        `INSERT INTO plugin_catalog (id, name, description) VALUES ($1, $2, 'Our own words for this.')`,
        [ZOOM.id, preRename(ZOOM.name)],
      );
      await pool.query(MIGRATION_SQL);
      const row = await rowOf(ZOOM.id);
      expect(row?.name).toBe(ZOOM.name);
      expect(row?.description).toBe("Our own words for this.");
    }, PG_TIMEOUT_MS);

    it("renames the stock DESCRIPTION while keeping an operator-rewritten NAME", async () => {
      await pool.query(`TRUNCATE plugin_catalog`);
      await pool.query(
        `INSERT INTO plugin_catalog (id, name, description) VALUES ($1, 'Meeting recordings', $2)`,
        [ZOOM.id, preRename(ZOOM.description)],
      );
      await pool.query(MIGRATION_SQL);
      const row = await rowOf(ZOOM.id);
      expect(row?.name).toBe("Meeting recordings");
      expect(row?.description).toBe(ZOOM.description);
    }, PG_TIMEOUT_MS);

    it("does not confuse the two rows — Zoom's copy never lands on Outlook", async () => {
      // Accidental-equality guard: both statements share a shape, and a
      // copy-paste that left the Outlook statement writing Zoom's strings
      // would pass every assertion above that only reads one row at a time.
      await seedPreRename();
      await pool.query(MIGRATION_SQL);
      const zoom = await rowOf(ZOOM.id);
      const outlook = await rowOf(OUTLOOK.id);
      expect(zoom?.name).not.toBe(outlook?.name);
      expect(zoom?.description).not.toBe(outlook?.description);
      expect(outlook?.name).toContain("Outlook");
      expect(zoom?.name).toContain("Zoom");
    }, PG_TIMEOUT_MS);
  });

  describe("a NULL description (the column is nullable)", () => {
    it("renames the name and leaves the NULL in place", async () => {
      // `description` is nullable in `plugin_catalog`. A `CASE` comparing to a
      // literal yields NULL for a NULL input, so the ELSE arm must carry it —
      // and the row-level `WHERE` must still admit the row on the name alone.
      await pool.query(`TRUNCATE plugin_catalog`);
      await pool.query(`INSERT INTO plugin_catalog (id, name, description) VALUES ($1, $2, NULL)`, [
        OUTLOOK.id,
        preRename(OUTLOOK.name),
      ]);
      await pool.query(MIGRATION_SQL);
      const row = await rowOf(OUTLOOK.id);
      expect(row?.name).toBe(OUTLOOK.name);
      expect(row?.description).toBeNull();
    }, PG_TIMEOUT_MS);
  });
});
