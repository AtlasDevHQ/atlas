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
 * row is not clobbered, a row under a FOREIGN id carrying the identical stock
 * copy is not touched, and a second run does not rewrite anything.
 *
 * ⚠️ WHERE THE FIXTURE'S GROUND TRUTH COMES FROM, because getting this wrong
 * makes the whole file vacuously green. The expected POST-migration values are
 * the seed constants — never literals retyped here, since the migration and
 * the constants agreeing is the thing under test. The PRE-migration values come
 * from `brain-catalog-rename-fixtures.ts`, the single derivation both this file
 * and the text pin share, and `assertPinnedToMigration` throws before any
 * fixture is seeded if that derivation has gone slack. Read that file's header
 * before changing any of it — including why it does NOT parse the migration.
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
import {
  PRE_RENAME,
  RENAME_PAIRS,
  assertPinnedToMigration,
} from "@atlas/api/lib/db/__tests__/brain-catalog-rename-fixtures";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;

const PG_TIMEOUT_MS = 30_000;

const MIGRATION_SQL = readFileSync(
  join(import.meta.dir, "..", "migrations", "0201_brain_catalog_rows_company_atlas.sql"),
  "utf8",
);

const ZOOM = BUILTIN_ZOOM_TRANSCRIPTS_CATALOG_ROW;
const OUTLOOK = BUILTIN_OUTLOOK_MAIL_CATALOG_ROW;
const OLD = PRE_RENAME;
const ROWS = RENAME_PAIRS;

interface CatalogRow {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly updated_at: Date;
  /** Postgres' `xmin` — the transaction that last wrote the row, as text. */
  readonly row_version: string;
}

describeIfPg("migration 0201 — rename the Company Atlas ingest catalog rows (#5082)", () => {
  let pool: Pool;
  const schemaName = `catrename_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

  beforeAll(async () => {
    // `search_path` is baked into the connection via libpq `options`, so it is
    // set server-side at startup. The `pool.on("connect")` + `SET search_path`
    // idiom the older -pg suites use is fire-and-forget: its failure path can
    // only log, and this file then runs UNQUALIFIED `TRUNCATE plugin_catalog`
    // seven times. Against a developer's own `TEST_DATABASE_URL` — which
    // docs/development/testing.md tells them to point at their dev database —
    // that resolves to `public` and wipes the real catalog. Not a live CI risk;
    // it is a local blast radius with no reason to exist.
    pool = new Pool({
      connectionString: TEST_DB_URL,
      options: `-c search_path="${schemaName}",public`,
    });
    await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
    // The schema is created after the pool's first connection may already have
    // resolved `search_path`, so prove the destructive statements below land
    // where we think before any of them runs.
    const { rows } = await pool.query<{ s: string }>(`SELECT current_schema() AS s`);
    expect(rows[0]?.s).toBe(schemaName);

    // The migration only ever touches `id`, `name`, `description` and
    // `updated_at`, so the fixture stands up that projection rather than the
    // full production table — a narrower table proves the statement never
    // reaches for a column it has no business writing. The real table is
    // covered by `migrate-pg.test.ts`, which runs 0201 through the runner.
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
    if (!pool) return;
    await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    await pool.end();
  }, PG_TIMEOUT_MS);

  /**
   * Run the migration and capture the `RAISE NOTICE`s it emits.
   *
   * `migrate.ts` attaches a `notice` listener and forwards these into the
   * structured log, so they are the only operator-visible difference between
   * "renamed two rows" and "matched nothing" — the latter being permanent,
   * since the applied-marker lands in the same successful transaction. An
   * un-asserted notice is decoration: measured, deleting the zero-row arm
   * killed zero tests before these existed.
   */
  async function runMigrationCapturingNotices(): Promise<readonly string[]> {
    const client = await pool.connect();
    const notices: string[] = [];
    const onNotice = (n: { readonly message?: string }): void => {
      notices.push(n.message ?? "");
    };
    client.on("notice", onNotice);
    try {
      await client.query(MIGRATION_SQL);
    } finally {
      client.off("notice", onNotice);
      client.release();
    }
    return notices;
  }

  async function rowOf(id: string): Promise<CatalogRow | undefined> {
    const { rows } = await pool.query<CatalogRow>(
      `SELECT id, name, description, updated_at, xmin::text AS row_version
         FROM plugin_catalog WHERE id = $1`,
      [id],
    );
    return rows[0];
  }

  /**
   * `rowOf` for the cases whose subject is the row's CONTENT. An absent row is
   * a fixture bug there, and an optional chain would let two `undefined`s
   * satisfy an equality — so this turns absence into a failure with a name.
   */
  async function requireRow(id: string): Promise<CatalogRow> {
    const row = await rowOf(id);
    if (!row) throw new Error(`fixture: expected a plugin_catalog row for ${id}, found none`);
    return row;
  }

  async function insertRow(
    id: string,
    name: string,
    description: string | null,
    backdated = true,
  ): Promise<void> {
    await pool.query(
      `INSERT INTO plugin_catalog (id, name, description, updated_at)
         VALUES ($1, $2, $3, ${backdated ? "TIMESTAMPTZ '2020-01-01 00:00:00+00'" : "now()"})`,
      [id, name, description],
    );
  }

  /**
   * Seed the catalog as an upgraded region holds it: both Company Atlas rows
   * still pre-rename, plus two decoys the migration must never touch.
   */
  async function seedPreRename(): Promise<void> {
    await pool.query(`TRUNCATE plugin_catalog`);
    for (const { row, oldName, oldDescription } of ROWS) {
      await insertRow(row.id, oldName, oldDescription);
    }
    // Decoy 1 — an unrelated vendor row. Its description deliberately contains
    // `company brain`, so a substring- or LIKE-keyed rewrite would trip it.
    await insertRow(
      "catalog:notion-knowledge",
      "Notion",
      "Sync Notion pages into the company brain somehow.",
    );
    // Decoy 2 — the one that proves ID SCOPING behaviourally. It carries the
    // EXACT stock pre-rename name and description under a FOREIGN id, so a
    // statement that kept the string predicates but lost `id = '…'` rewrites
    // it. Reachable in production: an operator can create a catalog row through
    // the CRUD path and name it anything — `slug` is unique, `name` is not.
    await insertRow("catalog:operator-copy", OLD.zoomName, OLD.zoomDescription);
  }

  it("the pre-rename fixtures are real and are what 0201 matches on", () => {
    // The derivation's backstop, and it runs before anything is seeded. If
    // `preRename` ever became a no-op, every positive case below would seed
    // the POST-rename string, update zero rows, and still pass. See
    // `brain-catalog-rename-fixtures.ts`.
    expect(() => assertPinnedToMigration(MIGRATION_SQL)).not.toThrow();
    // And the two rows' pre-rename strings must differ from each other, or a
    // statement writing the wrong row's copy would be invisible.
    expect(OLD.zoomName).not.toBe(OLD.outlookName);
    expect(OLD.zoomDescription).not.toBe(OLD.outlookDescription);
  });

  describe("an upgraded region holding the stock pre-rename rows", () => {
    beforeEach(async () => {
      await seedPreRename();
      await pool.query(MIGRATION_SQL);
    }, PG_TIMEOUT_MS);

    for (const { label, row } of ROWS) {
      it(`renames the ${label} row to exactly the seed constant`, async () => {
        const stored = await requireRow(row.id);
        expect(stored.name).toBe(row.name);
        expect(stored.description).toBe(row.description);
      });

      it(`bumps updated_at on the ${label} row it wrote`, async () => {
        const stored = await requireRow(row.id);
        expect(stored.updated_at.getUTCFullYear()).toBeGreaterThan(2020);
      });
    }

    it("leaves an unrelated catalog row completely alone", async () => {
      // Negative: this is what dies if either statement loses its `WHERE` and
      // rewrites the whole table. Measured — dropping both `WHERE` clauses
      // kills this test. `company brain` is in its description deliberately, so
      // it would also catch a substring- or `LIKE`-keyed rewrite.
      const stored = await requireRow("catalog:notion-knowledge");
      expect(stored.name).toBe("Notion");
      expect(stored.description).toBe("Sync Notion pages into the company brain somehow.");
      expect(stored.updated_at.toISOString()).toBe("2020-01-01T00:00:00.000Z");
    });

    it("leaves a FOREIGN id carrying the identical stock copy alone (id scoping)", async () => {
      // The only assertion in the suite that proves scoping BEHAVIOURALLY. The
      // text pins in `seed-builtin-knowledge-catalog.test.ts` prove which ids
      // appear after `WHERE id =`; they cannot see a `WHERE id = '…' OR name =
      // '…'`, which satisfies every one of them and rewrites this row.
      const stored = await requireRow("catalog:operator-copy");
      expect(stored.name).toBe(OLD.zoomName);
      expect(stored.description).toBe(OLD.zoomDescription);
      expect(stored.updated_at.toISOString()).toBe("2020-01-01T00:00:00.000Z");
    });

    it("is idempotent — a second run does not rewrite the row at all", async () => {
      const before = await requireRow(ZOOM.id);
      await pool.query(MIGRATION_SQL);
      const after = await requireRow(ZOOM.id);
      expect(after.name).toBe(ZOOM.name);
      expect(after.description).toBe(ZOOM.description);
      // `xmin`, not `updated_at`: the two runs are one round trip apart and
      // `toISOString()` truncates to milliseconds, so a timestamp comparison
      // passes against a row that WAS rewritten whenever both land in the same
      // millisecond. `xmin` advances on any write including a no-op
      // self-assignment and has no clock in it. Same remedy as
      // `builtin-roles-backfill-pg.test.ts`.
      expect(after.row_version).toBe(before.row_version);
    });

    it("does not confuse the two rows — Zoom's copy never lands on Outlook", async () => {
      // Accidental-equality guard: the two statements share a shape, and a
      // copy-paste that left one writing the other's strings would pass every
      // assertion above that reads a single row.
      const zoom = await requireRow(ZOOM.id);
      const outlook = await requireRow(OUTLOOK.id);
      expect(zoom.name).not.toBe(outlook.name);
      expect(zoom.description).not.toBe(outlook.description);
      expect(outlook.name).toContain("Outlook");
      expect(zoom.name).toContain("Zoom");
    });
  });

  describe("the operator breadcrumb (RAISE NOTICE)", () => {
    beforeEach(async () => {
      await pool.query(`TRUNCATE plugin_catalog`);
    }, PG_TIMEOUT_MS);

    it("reports a REWRITE per row when the stock rows are renamed", async () => {
      for (const { row, oldName, oldDescription } of ROWS) {
        await insertRow(row.id, oldName, oldDescription);
      }
      const notices = await runMigrationCapturingNotices();
      const rewritten = notices.filter((n) => n.includes("rewritten to the Company Atlas copy"));
      expect(rewritten).toHaveLength(2);
      expect(rewritten.some((n) => n.includes(ZOOM.id))).toBe(true);
      expect(rewritten.some((n) => n.includes(OUTLOOK.id))).toBe(true);
      // The success and no-op arms must be mutually exclusive, or "rewritten"
      // stops carrying information.
      expect(notices.filter((n) => n.includes("NOT rewritten"))).toHaveLength(0);
    }, PG_TIMEOUT_MS);

    it("reports NOT-rewritten per row on an empty catalog", async () => {
      const notices = await runMigrationCapturingNotices();
      const skipped = notices.filter((n) => n.includes("NOT rewritten"));
      expect(skipped).toHaveLength(2);
      // The whole point of the message is that the zero-row case is AMBIGUOUS
      // and one of its causes is a defect. A notice that only said "skipped"
      // would read as reassurance.
      for (const n of skipped) {
        expect(n).toContain("FOUR causes");
        expect(n).toContain("will never retry");
      }
      expect(notices.filter((n) => n.includes("rewritten to the Company Atlas copy"))).toHaveLength(
        0,
      );
    }, PG_TIMEOUT_MS);

    it("reports NOT-rewritten for a row an operator fully renamed", async () => {
      await insertRow(ZOOM.id, "Meeting recordings", "Our own words for this.");
      await insertRow(OUTLOOK.id, OLD.outlookName, OLD.outlookDescription);
      const notices = await runMigrationCapturingNotices();
      // Mixed outcome: exactly one of each, and each naming its own row. A
      // per-statement count is what distinguishes this from "all fine".
      expect(notices.filter((n) => n.includes(`${ZOOM.id} NOT rewritten`))).toHaveLength(1);
      expect(
        notices.filter((n) => n.includes(`${OUTLOOK.id} rewritten to the Company Atlas copy`)),
      ).toHaveLength(1);
    }, PG_TIMEOUT_MS);

    it("reports NOT-rewritten on a re-run, so idempotence is visible", async () => {
      for (const { row, oldName, oldDescription } of ROWS) {
        await insertRow(row.id, oldName, oldDescription);
      }
      await runMigrationCapturingNotices();
      const second = await runMigrationCapturingNotices();
      expect(second.filter((n) => n.includes("NOT rewritten"))).toHaveLength(2);
    }, PG_TIMEOUT_MS);
  });

  describe("regions that need no rewrite", () => {
    it("no-ops on rows that already carry the new copy", async () => {
      await pool.query(`TRUNCATE plugin_catalog`);
      await insertRow(ZOOM.id, ZOOM.name, ZOOM.description);
      await pool.query(MIGRATION_SQL);
      const stored = await requireRow(ZOOM.id);
      expect(stored.name).toBe(ZOOM.name);
      expect(stored.updated_at.toISOString()).toBe("2020-01-01T00:00:00.000Z");
    }, PG_TIMEOUT_MS);

    it("no-ops on an empty catalog without erroring", async () => {
      // A fresh region runs every migration before the boot seed inserts
      // anything, so 0201 meets an empty table. It must not throw — an error
      // here aborts the whole boot migration.
      await pool.query(`TRUNCATE plugin_catalog`);
      await expect(pool.query(MIGRATION_SQL)).resolves.toBeDefined();
      const { rows } = await pool.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM plugin_catalog`,
      );
      expect(rows[0]?.n).toBe("0");
    }, PG_TIMEOUT_MS);

    it("handles a partially-seeded region — Zoom present, Outlook never seeded", async () => {
      // The real shape of at least one region's history: #4965 added the Zoom
      // row, #4966 added Outlook, and a region that booted between them holds
      // one and not the other. The two statements are independent, so the
      // present row must still be renamed.
      await pool.query(`TRUNCATE plugin_catalog`);
      await insertRow(ZOOM.id, OLD.zoomName, OLD.zoomDescription);
      await pool.query(MIGRATION_SQL);
      const stored = await requireRow(ZOOM.id);
      expect(stored.name).toBe(ZOOM.name);
      expect(stored.description).toBe(ZOOM.description);
      expect(await rowOf(OUTLOOK.id)).toBeUndefined();
    }, PG_TIMEOUT_MS);
  });

  describe("operator-edited rows (catalog CRUD is a live write path)", () => {
    // Parameterized over BOTH rows deliberately. The two statements are
    // copy-paste twins, so a guard dropped from ONE of them survives any suite
    // that only ever exercises the other — and that mutant clobbers an
    // operator's edit in three prod regions.
    for (const { label, row, oldName, oldDescription } of ROWS) {
      describe(label, () => {
        beforeEach(async () => {
          await pool.query(`TRUNCATE plugin_catalog`);
        }, PG_TIMEOUT_MS);

        it("leaves a fully operator-renamed row alone", async () => {
          await insertRow(row.id, "Meeting recordings", "Our own words for this.");
          await pool.query(MIGRATION_SQL);
          const stored = await requireRow(row.id);
          expect(stored.name).toBe("Meeting recordings");
          expect(stored.description).toBe("Our own words for this.");
          expect(stored.updated_at.toISOString()).toBe("2020-01-01T00:00:00.000Z");
        }, PG_TIMEOUT_MS);

        it("renames the stock NAME while keeping an operator-rewritten DESCRIPTION", async () => {
          // The per-column `CASE` is the whole reason this migration is not two
          // row-level guards. A row-level guard would abandon BOTH columns
          // here, leaving a customer-visible "Company Brain" name behind — the
          // exact divergence #5082 exists to close.
          await insertRow(row.id, oldName, "Our own words for this.");
          await pool.query(MIGRATION_SQL);
          const stored = await requireRow(row.id);
          expect(stored.name).toBe(row.name);
          expect(stored.description).toBe("Our own words for this.");
        }, PG_TIMEOUT_MS);

        it("renames the stock DESCRIPTION while keeping an operator-rewritten NAME", async () => {
          await insertRow(row.id, "Meeting recordings", oldDescription);
          await pool.query(MIGRATION_SQL);
          const stored = await requireRow(row.id);
          expect(stored.name).toBe("Meeting recordings");
          expect(stored.description).toBe(row.description);
        }, PG_TIMEOUT_MS);

        it("finishes a HALF-APPLIED row — new name, description still stock", async () => {
          // Not reachable through the migration itself (it runs in one
          // transaction), but it is exactly the state a hand-written repair or
          // a partial operator edit leaves, and it is the shape a `CASE` gets
          // wrong: the name arm must fall through to `ELSE` while the row-level
          // `WHERE` still admits the row on the description disjunct alone.
          await insertRow(row.id, row.name, oldDescription);
          await pool.query(MIGRATION_SQL);
          const stored = await requireRow(row.id);
          expect(stored.name).toBe(row.name);
          expect(stored.description).toBe(row.description);
        }, PG_TIMEOUT_MS);

        it("renames the name and leaves a NULL description in place", async () => {
          // `description` is nullable. A `CASE` comparing to a literal yields
          // NULL for a NULL input, so the ELSE arm must carry it — and the
          // row-level `WHERE` must still admit the row on the name alone
          // (`TRUE OR NULL` is TRUE).
          await insertRow(row.id, oldName, null);
          await pool.query(MIGRATION_SQL);
          const stored = await requireRow(row.id);
          expect(stored.name).toBe(row.name);
          expect(stored.description).toBeNull();
        }, PG_TIMEOUT_MS);
      });
    }
  });
});
