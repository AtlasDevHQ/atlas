/**
 * Real-Postgres tests for migration 0201 — renaming the two Company Atlas
 * ingest catalog rows (#5082, ADR-0038).
 *
 * Why real Postgres: the migration's value is in guards the SQL text cannot
 * demonstrate — a per-column `CASE` inside a row-level `WHERE`, so a row an
 * operator partially rewrote keeps the half they edited and still gets the
 * half they didn't, plus a per-column breadcrumb and a residue warning. A
 * mocked query layer evaluates none of that; it would report success against
 * `UPDATE plugin_catalog SET name = 'Company Atlas (…)'` with no guard at all,
 * which silently reverts an operator's edit in three prod regions.
 *
 * The load-bearing assertions are the NEGATIVE ones: an operator-renamed row
 * is not clobbered, a row under a FOREIGN id carrying the identical stock copy
 * is not touched, and a second run does not rewrite anything.
 *
 * ⚠️ Every case runs over both rows: the two statements are copy-paste twins,
 * so a guard dropped from one survives a suite that exercises only the other.
 * Round 2 measured exactly this — two instruments here, the id-scoping decoy
 * and the idempotency check, had been written for Zoom only, and a scoping
 * defect appended to the OUTLOOK statement passed every one of the 58 cases
 * the two files then had. Add new cases inside a `RENAME_PAIRS` loop, unless
 * the case's subject IS the asymmetry (absent-vs-present, partially-seeded) —
 * those say so where they sit.
 *
 * ⚠️ WHERE THE FIXTURE'S GROUND TRUTH COMES FROM. Expected POST-migration
 * values are the seed constants — never literals retyped here, since the
 * migration and the constants agreeing is the thing under test. PRE-migration
 * values come from `brain-catalog-rename-fixtures.ts`, the single derivation
 * both this file and the text pin share; `assertPinnedToMigration` runs in
 * `beforeAll` and THROWS, so a slack derivation aborts the block rather than
 * leaving fixtures that cannot fail.
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
  BUILTIN_NOTION_KNOWLEDGE_CATALOG_ROW,
} from "@atlas/api/lib/db/seed-builtin-knowledge-catalog";
import {
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
const ROWS = RENAME_PAIRS;

/**
 * An unrelated vendor row, used as the "don't rewrite the table" decoy. Its
 * description carries the old product name deliberately, so it would also trip
 * a substring- or `LIKE`-keyed rewrite.
 */
const NOTION_ID = BUILTIN_NOTION_KNOWLEDGE_CATALOG_ROW.id;
const NOTION_DESCRIPTION = "Sync Notion pages into the company brain somehow.";

interface CatalogRow {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly updated_at: Date;
  /** Postgres' `xmin` — the transaction that last wrote the row, as text. */
  readonly row_version: string;
}

interface CapturedNotice {
  readonly severity: string;
  readonly message: string;
}

describeIfPg("migration 0201 — rename the Company Atlas ingest catalog rows (#5082)", () => {
  let pool: Pool;
  const schemaName = `catrename_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

  beforeAll(async () => {
    // Refuse to run at all on a slack derivation. A throwing `beforeAll`
    // aborts the block; an `expect(...).not.toThrow()` inside an `it` does
    // NOT — measured, it left 21 cases passing against rows the migration
    // never wrote. See the fixtures module's header.
    assertPinnedToMigration(MIGRATION_SQL);

    // `search_path` is baked into the connection via libpq `options`, so it is
    // set server-side at startup. The `pool.on("connect")` + `SET search_path`
    // idiom the older -pg suites use is fire-and-forget: its failure path can
    // only log, and this file runs UNQUALIFIED `TRUNCATE plugin_catalog` many
    // times. Against a developer's own `TEST_DATABASE_URL` — which
    // docs/development/testing.md tells them to point at their dev database —
    // that resolves to `public` and wipes the real catalog.
    //
    // `public` is deliberately NOT in the path: nothing here needs it
    // (`pg_catalog` is implicit), and leaving it out means an unqualified
    // statement cannot reach a real table even if the schema were missing.
    pool = new Pool({
      connectionString: TEST_DB_URL,
      options: `-c search_path="${schemaName}"`,
    });
    await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
    const { rows } = await pool.query<{ s: string }>(`SELECT current_schema() AS s`);
    expect(rows[0]?.s).toBe(schemaName);

    // The migration only ever touches `id`, `name`, `description` and
    // `updated_at`, so the fixture stands up that projection rather than the
    // full production table — a narrower table makes "reached for a column it
    // has no business writing" a hard error instead of a silent pass. The real
    // table is covered by `migrate-pg.test.ts`, which runs 0201 through the
    // runner against the full schema.
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
   * Run the migration and capture the notices it emits, with severity.
   *
   * `migrate.ts` attaches a `notice` listener and forwards these into the
   * structured log, so they are the only operator-visible difference between
   * "rewrote both columns", "rewrote one", and "matched nothing" — and the
   * zero case is permanent, since the applied-marker lands in the same
   * successful transaction. Severity is captured because the residue arm is a
   * `WARNING` and the routine arm is a `NOTICE`; asserting only the text would
   * not notice the two being collapsed.
   */
  async function runMigrationCapturingNotices(): Promise<readonly CapturedNotice[]> {
    const client = await pool.connect();
    const notices: CapturedNotice[] = [];
    const onNotice = (n: { readonly message?: string; readonly severity?: string }): void => {
      notices.push({ severity: n.severity ?? "(none)", message: n.message ?? "" });
    };
    client.on("notice", onNotice);
    let failure: Error | undefined;
    try {
      await client.query(MIGRATION_SQL);
    } catch (err) {
      failure = err instanceof Error ? err : new Error(String(err));
    } finally {
      client.off("notice", onNotice);
      // Hand the error back on release so a connection-level failure destroys
      // the client rather than returning it to the pool dirty — `migrate.ts`
      // does the same with its rollback error.
      client.release(failure);
    }
    if (failure) throw failure;
    return notices;
  }

  const messagesOf = (notices: readonly CapturedNotice[]): string[] => notices.map((n) => n.message);

  async function rowOf(id: string): Promise<CatalogRow | undefined> {
    const { rows } = await pool.query<CatalogRow>(
      `SELECT id, name, description, updated_at, xmin::text AS row_version
         FROM plugin_catalog WHERE id = $1`,
      [id],
    );
    return rows[0];
  }

  /**
   * `rowOf` for cases whose subject is the row's CONTENT. An absent row is a
   * fixture bug there, and an optional chain would let two `undefined`s
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
   * still pre-rename, plus the decoys the migration must never touch.
   */
  async function seedPreRename(): Promise<void> {
    await pool.query(`TRUNCATE plugin_catalog`);
    for (const { row, oldName, oldDescription, decoyId } of ROWS) {
      await insertRow(row.id, oldName, oldDescription);
      // The id-scoping decoy, ONE PER ROW. It carries that row's exact stock
      // pre-rename copy under a FOREIGN id, so a statement that kept the
      // string predicates but lost or widened `id = '…'` rewrites it.
      // Reachable in production: an operator can create a catalog row through
      // the CRUD path and `name` is not unique.
      await insertRow(decoyId, oldName, oldDescription);
    }
    await insertRow(NOTION_ID, "Notion", NOTION_DESCRIPTION);
  }

  it("the two rows' fixtures are distinct from each other", () => {
    // `assertPinnedToMigration` ran in `beforeAll` and ITS throw is the report
    // — a throwing `beforeAll` means none of this block's cases run at all, so
    // re-asserting it here would be a tautology that can never fire.
    //
    // This case covers what that guard does not: the two rows must not share a
    // pre-rename string or a decoy id, or a statement writing the wrong row's
    // copy would be invisible to every per-row assertion below.
    expect(ROWS[0].oldName).not.toBe(ROWS[1].oldName);
    expect(ROWS[0].oldDescription).not.toBe(ROWS[1].oldDescription);
    expect(ROWS[0].decoyId).not.toBe(ROWS[1].decoyId);
  });

  describe("an upgraded region holding the stock pre-rename rows", () => {
    beforeEach(async () => {
      await seedPreRename();
      await pool.query(MIGRATION_SQL);
    }, PG_TIMEOUT_MS);

    for (const { label, row, oldName, oldDescription, decoyId } of ROWS) {
      it(`renames the ${label} row to exactly the seed constant`, async () => {
        const stored = await requireRow(row.id);
        expect(stored.name).toBe(row.name);
        expect(stored.description).toBe(row.description);
      });

      it(`bumps updated_at on the ${label} row it wrote`, async () => {
        const stored = await requireRow(row.id);
        expect(stored.updated_at.getUTCFullYear()).toBeGreaterThan(2020);
      });

      it(`leaves a FOREIGN id carrying ${label}'s identical stock copy alone`, async () => {
        // The only assertion that catches a WIDENED `WHERE` — one keeping
        // `id = '…'` and adding `OR name = '<stock>'`. Round 2 appended exactly
        // that to the Outlook statement and the whole suite stayed green,
        // because the only decoy then carried Zoom's copy; hence one decoy per
        // row. The text pins cannot catch it (the literal `WHERE id = '…'` is
        // still present), and the unrelated-row case below catches only a
        // `WHERE` dropped outright.
        const stored = await requireRow(decoyId);
        expect(stored.name).toBe(oldName);
        expect(stored.description).toBe(oldDescription);
        expect(stored.updated_at.toISOString()).toBe("2020-01-01T00:00:00.000Z");
      });

      it(`is idempotent for ${label} — a second run does not rewrite the row`, async () => {
        const before = await requireRow(row.id);
        await pool.query(MIGRATION_SQL);
        const after = await requireRow(row.id);
        expect(after.name).toBe(row.name);
        expect(after.description).toBe(row.description);
        // `xmin`, not `updated_at`: the two runs are one round trip apart and
        // `toISOString()` truncates to milliseconds, so a timestamp comparison
        // passes against a row that WAS rewritten whenever both land in the
        // same millisecond. `xmin` advances on any write including a no-op
        // self-assignment and has no clock in it. Same remedy as
        // `builtin-roles-backfill-pg.test.ts`.
        expect(after.row_version).toBe(before.row_version);
      });
    }

    it("leaves an unrelated catalog row completely alone", async () => {
      // What dies if either statement loses its `WHERE` outright and rewrites
      // the whole table. A WIDENED `WHERE` is the decoy's job, above.
      const stored = await requireRow(NOTION_ID);
      expect(stored.name).toBe("Notion");
      expect(stored.description).toBe(NOTION_DESCRIPTION);
      expect(stored.updated_at.toISOString()).toBe("2020-01-01T00:00:00.000Z");
    });

    it("does not confuse the two rows — Zoom's copy never lands on Outlook", async () => {
      // Accidental-equality guard: the statements share a shape, and a
      // copy-paste that left one writing the other's strings would pass every
      // assertion that reads a single row.
      const zoom = await requireRow(ZOOM.id);
      const outlook = await requireRow(OUTLOOK.id);
      expect(zoom.name).not.toBe(outlook.name);
      expect(zoom.description).not.toBe(outlook.description);
      expect(outlook.name).toContain("Outlook");
      expect(zoom.name).toContain("Zoom");
    });
  });

  describe("the operator breadcrumb", () => {
    beforeEach(async () => {
      await pool.query(`TRUNCATE plugin_catalog`);
    }, PG_TIMEOUT_MS);

    it("reports both columns rewritten, per row, and warns about nothing", async () => {
      for (const { row, oldName, oldDescription } of ROWS) {
        await insertRow(row.id, oldName, oldDescription);
      }
      const notices = await runMigrationCapturingNotices();
      for (const { row } of ROWS) {
        expect(
          notices.some(
            (n) =>
              n.severity === "NOTICE" &&
              n.message.includes(
                `${row.id}: present=1, name rewritten=1, description rewritten=1`,
              ),
          ),
        ).toBe(true);
      }
      expect(notices.filter((n) => n.severity === "WARNING")).toHaveLength(0);
    }, PG_TIMEOUT_MS);

    it("distinguishes ABSENT from present-but-not-eligible", async () => {
      // ⚠️ The second time this migration's breadcrumb reported at a coarser
      // granularity than its outcomes differ at. Round 2 caught it as
      // row-vs-column; a fix-vs-finding pass caught the repeat as
      // presence-vs-eligibility — `count(*) FILTER` returns 0 on an empty set,
      // so "the row is not here" and "the row is here and already renamed"
      // emitted byte-identical output. They are not the same situation: only
      // the absent one is exposed to the rollback window in 0201's header,
      // where a pre-#5082 image re-creates the row with the old label.
      //
      // Both halves are asserted in one test deliberately — the claim is that
      // the two are DISTINGUISHABLE, and a test that only checked one could
      // pass with them collapsed.
      const [zoomPair, outlookPair] = ROWS;
      // Zoom: absent entirely.
      // Outlook: present and already carrying the new copy.
      await insertRow(outlookPair.row.id, outlookPair.row.name, outlookPair.row.description);
      const notices = await runMigrationCapturingNotices();
      expect(
        notices.some((n) =>
          n.message.includes(
            `${zoomPair.row.id}: present=0, name rewritten=0, description rewritten=0`,
          ),
        ),
      ).toBe(true);
      expect(
        notices.some((n) =>
          n.message.includes(
            `${outlookPair.row.id}: present=1, name rewritten=0, description rewritten=0`,
          ),
        ),
      ).toBe(true);
      expect(notices.filter((n) => n.severity === "WARNING")).toHaveLength(0);
    }, PG_TIMEOUT_MS);

    it("distinguishes the columns — name rewritten, description was not", async () => {
      // The case a per-ROW count cannot see, and the reason the breadcrumb
      // counts per COLUMN. Measured before this existed: the row-count version
      // emitted plain success here while the customer-read description still
      // carried the old product name.
      for (const { row, oldName } of ROWS) {
        await insertRow(row.id, oldName, "A description an operator wrote themselves.");
      }
      const notices = await runMigrationCapturingNotices();
      for (const { row } of ROWS) {
        expect(
          notices.some((n) =>
            n.message.includes(`${row.id}: present=1, name rewritten=1, description rewritten=0`),
          ),
        ).toBe(true);
      }
    }, PG_TIMEOUT_MS);

    it("RAISES A WARNING per row when the old product name survives", async () => {
      // The arm that answers the question an operator actually has. Both
      // causes are named in the message because only one of them is benign.
      for (const { row } of ROWS) {
        await insertRow(row.id, "Our own name", "We still call this the company brain internally.");
      }
      const notices = await runMigrationCapturingNotices();
      for (const { row } of ROWS) {
        expect(
          notices.some((n) => n.severity === "WARNING" && n.message.includes(row.id)),
        ).toBe(true);
      }
      // Severity is asserted because it is a property of the SQL, NOT because
      // anything downstream routes on it: `migrate.ts` types its listener as
      // `{ message?: string }` and logs only the message, at `info`. So in the
      // Atlas log a WARNING already reads as routine, and the text is the only
      // operator-visible discriminator — which is why the two arms must stay
      // textually distinct. Routing on severity would take a change there.
      expect(notices.filter((n) => n.severity === "WARNING")).toHaveLength(ROWS.length);
    }, PG_TIMEOUT_MS);

    it("does not warn once the rename has actually landed", async () => {
      for (const { row, oldName, oldDescription } of ROWS) {
        await insertRow(row.id, oldName, oldDescription);
      }
      await runMigrationCapturingNotices();
      const second = await runMigrationCapturingNotices();
      for (const { row } of ROWS) {
        // present=1 — the row is here; both columns already renamed, so
        // neither was eligible. Distinct from the absent case above.
        expect(
          second.some((n) =>
            n.message.includes(`${row.id}: present=1, name rewritten=0, description rewritten=0`),
          ),
        ).toBe(true);
      }
      expect(second.filter((n) => n.severity === "WARNING")).toHaveLength(0);
      // Guard against the two arms collapsing into one message that satisfies
      // both count checks.
      expect(messagesOf(second).join("\n")).not.toContain("name rewritten=1");
    }, PG_TIMEOUT_MS);
  });

  describe("regions that need no rewrite", () => {
    beforeEach(async () => {
      await pool.query(`TRUNCATE plugin_catalog`);
    }, PG_TIMEOUT_MS);

    for (const { label, row } of ROWS) {
      it(`no-ops on a ${label} row that already carries the new copy`, async () => {
        await insertRow(row.id, row.name, row.description);
        await pool.query(MIGRATION_SQL);
        const stored = await requireRow(row.id);
        expect(stored.name).toBe(row.name);
        expect(stored.updated_at.toISOString()).toBe("2020-01-01T00:00:00.000Z");
      }, PG_TIMEOUT_MS);
    }

    it("no-ops on an empty catalog without erroring", async () => {
      // A fresh region runs every migration before the boot seed inserts
      // anything, so 0201 meets an empty table. It must not throw — an error
      // here aborts the whole boot migration.
      await expect(pool.query(MIGRATION_SQL)).resolves.toBeDefined();
      const { rows } = await pool.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM plugin_catalog`,
      );
      expect(rows[0]?.n).toBe("0");
    }, PG_TIMEOUT_MS);

    it("handles a partially-seeded region — Zoom present, Outlook never seeded", async () => {
      // A partially-seeded catalog is reachable, though NOT by the route that
      // first suggests itself: #4965 (Zoom) and #4966 (Outlook) both shipped in
      // v0.2.3, so no prod region ever held one without the other. What does
      // reach it is the seeder itself — it loops sequentially and a hard
      // failure aborts the pass mid-list, and #5239's slug collision leaves a
      // canonical id unseeded. The statements are independent, so the present
      // row must still be renamed.
      await insertRow(ZOOM.id, ROWS[0].oldName, ROWS[0].oldDescription);
      await pool.query(MIGRATION_SQL);
      const stored = await requireRow(ZOOM.id);
      expect(stored.name).toBe(ZOOM.name);
      expect(stored.description).toBe(ZOOM.description);
      expect(await rowOf(OUTLOOK.id)).toBeUndefined();
    }, PG_TIMEOUT_MS);
  });

  describe("operator-edited rows (catalog CRUD is a live write path)", () => {
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
          // The per-column `CASE` is the whole reason this is not two
          // row-level guards. A row-level guard would abandon BOTH columns
          // here, leaving a customer-visible old product name behind — the
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
          // Not reachable through the migration itself (one transaction), but
          // exactly what a hand repair or a partial operator edit leaves, and
          // the shape a `CASE` gets wrong: the name arm must fall through to
          // `ELSE` while the row-level `WHERE` still admits the row on the
          // description disjunct alone.
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
