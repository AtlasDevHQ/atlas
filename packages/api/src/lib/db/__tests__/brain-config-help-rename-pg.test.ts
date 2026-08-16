/**
 * Real-Postgres tests for migration 0203 — the `config_schema` helper text on
 * the two Company Atlas ingest rows (#5240, ADR-0038).
 *
 * Why real Postgres, and why it is less optional here than it was for 0201:
 * the whole statement is JSONB machinery. `jsonb_agg` over
 * `jsonb_array_elements … WITH ORDINALITY`, a `jsonb_set` on one matched
 * element, and a guard that has to see through JSONB's normalisation — none of
 * that is visible to a text pin, and the failure mode it exists to prevent
 * (rebuilding the array and losing a field, a flag, or the field ORDER the
 * install form renders in) is silent everywhere else.
 *
 * The load-bearing assertion is `config_schema` coming out EQUAL TO THE SEED
 * CONSTANT — not "contains the new string". Equality is what says the rewrite
 * touched one string and left every other field, flag and position alone.
 *
 * ⚠️ Every case runs over both rows (`CONFIG_HELP_PAIRS`): the two statements
 * are copy-paste twins, so a guard dropped from one survives a suite that
 * exercises only the other — measured on 0201's own suite at #5082 round 2.
 *
 * ⚠️ GROUND TRUTH. Post-migration expectations are the seed constants;
 * pre-migration fixtures come from `brain-catalog-rename-fixtures.ts`, the one
 * derivation in the tree, and `assertConfigHelpPinnedToMigration` runs in
 * `beforeAll` and THROWS — a degenerate derivation aborts the block instead of
 * leaving cases that cannot fail.
 *
 * Skipped cleanly when `TEST_DATABASE_URL` is unset. CI's api-tests workflow
 * provides the Postgres service.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import {
  BUILTIN_NOTION_KNOWLEDGE_CATALOG_ROW,
  BUILTIN_OUTLOOK_MAIL_CATALOG_ROW,
  BUILTIN_ZOOM_TRANSCRIPTS_CATALOG_ROW,
  type BuiltinKnowledgeCatalogRow,
} from "@atlas/api/lib/db/seed-builtin-knowledge-catalog";
import {
  CONFIG_HELP_FIELD_KEY,
  CONFIG_HELP_PAIRS,
  assertConfigHelpPinnedToMigration,
} from "@atlas/api/lib/db/__tests__/brain-catalog-rename-fixtures";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;

const PG_TIMEOUT_MS = 30_000;

const MIGRATION_SQL = readFileSync(
  join(import.meta.dir, "..", "migrations", "0203_brain_catalog_config_help_company_atlas.sql"),
  "utf8",
);

const ROWS = CONFIG_HELP_PAIRS;

/** A JSON value as `pg` hands a `jsonb` column back. */
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

interface CatalogRow {
  readonly id: string;
  readonly config_schema: Json;
  readonly updated_at: Date;
  /** Postgres' `xmin` — the transaction that last wrote the row, as text. */
  readonly row_version: string;
}

interface CapturedNotice {
  readonly severity: string;
  readonly message: string;
}

/**
 * The row's `config_schema` as a region held it before 0203: the seed constant
 * with its helper text put back to the pre-rename string.
 *
 * Derived from the constant so the fixture and the expectation can only differ
 * in the one field under test — the #5000 lesson. Everything else in the array
 * is exactly what the seeder writes, which is what makes "byte-identical
 * afterwards" a real claim rather than a claim about a hand-typed stub.
 */
function preRenameSchema(row: BuiltinKnowledgeCatalogRow, oldHelp: string): Json[] {
  return row.configSchema.map((field) =>
    field.key === CONFIG_HELP_FIELD_KEY
      ? ({ ...field, description: oldHelp } as unknown as Json)
      : (field as unknown as Json),
  );
}

/** The constant's own schema, as JSON — the post-migration expectation. */
const expectedSchema = (row: BuiltinKnowledgeCatalogRow): Json =>
  JSON.parse(JSON.stringify(row.configSchema)) as Json;

/**
 * A JSON value with every object's keys sorted, for comparing two values by
 * content.
 *
 * ⚠️ Needed because JSONB does NOT preserve key order: Postgres stores object
 * keys sorted by length then bytewise, so a field that came back untouched
 * still stringifies differently from the literal that went in (`clientSecret`
 * is the live example — `secret` moves after `label`). A plain
 * `JSON.stringify` diff reports those fields as CHANGED, which would make the
 * "exactly one field moved" case below fail against a correct migration. Deep
 * equality (`toEqual`) is key-order-insensitive already and is used everywhere
 * a whole schema is compared; this exists for the per-field diff.
 */
function canonical(value: Json): string {
  const sort = (v: Json): Json => {
    if (Array.isArray(v)) return v.map(sort);
    if (v !== null && typeof v === "object") {
      return Object.fromEntries(
        Object.keys(v)
          .sort()
          .map((k) => [k, sort(v[k] as Json)]),
      );
    }
    return v;
  };
  return JSON.stringify(sort(value));
}

describeIfPg("migration 0203 — the config_schema helper text (#5240)", () => {
  let pool: Pool;
  const schemaName = `cfghelp_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

  beforeAll(async () => {
    // Refuse to run at all on a degenerate derivation — see the fixtures
    // module. A throwing `beforeAll` aborts the block, which is the point.
    assertConfigHelpPinnedToMigration(MIGRATION_SQL);

    // `search_path` is baked into the connection via libpq `options` so it is
    // set server-side at startup: this file runs UNQUALIFIED `TRUNCATE
    // plugin_catalog`, and against a developer's own `TEST_DATABASE_URL` a
    // fire-and-forget `SET search_path` that failed would wipe the real
    // catalog. `public` is deliberately not in the path.
    pool = new Pool({
      connectionString: TEST_DB_URL,
      options: `-c search_path="${schemaName}"`,
    });
    await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
    const { rows } = await pool.query<{ s: string }>(`SELECT current_schema() AS s`);
    expect(rows[0]?.s).toBe(schemaName);

    // The projection 0203 touches. `config_schema` is nullable here exactly as
    // it is in `schema.ts`, because a NULL is one of the shapes the guard has
    // to survive.
    await pool.query(`
      CREATE TABLE plugin_catalog (
        id            TEXT PRIMARY KEY,
        config_schema JSONB,
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
  }, PG_TIMEOUT_MS);

  afterAll(async () => {
    if (!pool) return;
    await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    await pool.end();
  }, PG_TIMEOUT_MS);

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
      // the client rather than returning it to the pool dirty.
      client.release(failure);
    }
    if (failure) throw failure;
    return notices;
  }

  async function rowOf(id: string): Promise<CatalogRow | undefined> {
    const { rows } = await pool.query<CatalogRow>(
      `SELECT id, config_schema, updated_at, xmin::text AS row_version
         FROM plugin_catalog WHERE id = $1`,
      [id],
    );
    return rows[0];
  }

  async function requireRow(id: string): Promise<CatalogRow> {
    const row = await rowOf(id);
    if (!row) throw new Error(`fixture: expected a plugin_catalog row for ${id}, found none`);
    return row;
  }

  async function insertRow(id: string, configSchema: Json | null): Promise<void> {
    await pool.query(
      `INSERT INTO plugin_catalog (id, config_schema, updated_at)
         VALUES ($1, $2::jsonb, TIMESTAMPTZ '2020-01-01 00:00:00+00')`,
      [id, configSchema === null ? null : JSON.stringify(configSchema)],
    );
  }

  /** An unrelated vendor row whose help carries the old noun deliberately. */
  const NOTION_ID = BUILTIN_NOTION_KNOWLEDGE_CATALOG_ROW.id;
  const NOTION_SCHEMA: Json = [
    { key: "description", type: "string", description: "Optional. A human description of this brain source." },
  ];

  /** A foreign id carrying a Company Atlas row's exact stock schema. */
  const decoyIdFor = (index: number): string => ROWS[index]!.decoyId;

  async function seedPreRename(): Promise<void> {
    await pool.query(`TRUNCATE plugin_catalog`);
    for (const [i, { row, oldHelp }] of ROWS.entries()) {
      await insertRow(row.id, preRenameSchema(row, oldHelp));
      // The id-scoping decoy, ONE PER ROW: same stock schema, foreign id. A
      // statement that kept the JSONB predicates but lost or widened
      // `id = '…'` rewrites it. Production-reachable — an operator can create a
      // catalog row through the CRUD path.
      await insertRow(decoyIdFor(i), preRenameSchema(row, oldHelp));
    }
    await insertRow(NOTION_ID, NOTION_SCHEMA);
  }

  it("the two rows' fixtures are distinct from each other", () => {
    // A shared fixture would make a statement that wrote the wrong row's schema
    // invisible to every per-row assertion below.
    expect(ROWS).toHaveLength(2);
    expect(ROWS[0]!.row.id).not.toBe(ROWS[1]!.row.id);
    expect(ROWS[0]!.decoyId).not.toBe(ROWS[1]!.decoyId);
    // The two schemas are the same LENGTH (five fields each), so length is no
    // discriminator at all — content is. Every whole-schema assertion below
    // therefore compares against that row's own constant, and
    // "Zoom's schema never lands on Outlook" states the non-equality directly.
    expect(canonical(expectedSchema(BUILTIN_ZOOM_TRANSCRIPTS_CATALOG_ROW))).not.toBe(
      canonical(expectedSchema(BUILTIN_OUTLOOK_MAIL_CATALOG_ROW)),
    );
  });

  describe("an upgraded region holding the stock pre-rename schema", () => {
    beforeEach(async () => {
      await seedPreRename();
      await pool.query(MIGRATION_SQL);
    }, PG_TIMEOUT_MS);

    for (const [i, { label, row, oldHelp }] of ROWS.entries()) {
      it(`rewrites ${label}'s helper text and leaves the REST of config_schema identical`, async () => {
        // Equality against the seed constant, not a substring check: this is
        // the assertion that catches a rebuild which dropped a field, lost the
        // `secret: true` flag, or reordered the install form.
        const stored = await requireRow(row.id);
        expect(stored.config_schema).toEqual(expectedSchema(row));
      });

      it(`changes EXACTLY ONE field on ${label} — measured against what went in`, async () => {
        // The complement of the equality above, stated as a delta so a fixture
        // that happened to equal the constant before the migration ran could
        // not satisfy it.
        const before = preRenameSchema(row, oldHelp) as Array<Record<string, Json>>;
        const after = (await requireRow(row.id)).config_schema as Array<Record<string, Json>>;
        expect(after).toHaveLength(before.length);
        const changed = after.filter(
          (f, idx) => canonical(f as Json) !== canonical(before[idx] as Json),
        );
        expect(changed).toHaveLength(1);
        expect(changed[0]!.key).toBe(CONFIG_HELP_FIELD_KEY);
      });

      it(`bumps updated_at on the ${label} row it wrote`, async () => {
        const stored = await requireRow(row.id);
        expect(stored.updated_at.getUTCFullYear()).toBeGreaterThan(2020);
      });

      it(`leaves a FOREIGN id carrying ${label}'s identical stock schema alone`, async () => {
        // The only assertion that catches a WIDENED `WHERE` — one keeping
        // `id = '…'` and adding an `OR` on the JSONB predicate. The text pins
        // cannot see it, and the unrelated-row case below catches only a
        // `WHERE` dropped outright.
        const stored = await requireRow(decoyIdFor(i));
        expect(stored.config_schema).toEqual(preRenameSchema(row, oldHelp));
        expect(stored.updated_at.toISOString()).toBe("2020-01-01T00:00:00.000Z");
      });

      it(`is idempotent for ${label} — a second run does not rewrite the row`, async () => {
        const before = await requireRow(row.id);
        await pool.query(MIGRATION_SQL);
        const after = await requireRow(row.id);
        expect(after.config_schema).toEqual(expectedSchema(row));
        // `xmin`, not `updated_at`: two runs a round trip apart can land in the
        // same millisecond, so a timestamp comparison passes against a row that
        // WAS rewritten. `xmin` advances on any write, including a no-op
        // self-assignment.
        expect(after.row_version).toBe(before.row_version);
      });
    }

    it("leaves an unrelated catalog row completely alone", async () => {
      // What dies if either statement loses its `WHERE` outright. Note this row
      // still says "brain source" afterwards and that is correct: 0203 renames
      // two rows, not every string in the table.
      const stored = await requireRow(NOTION_ID);
      expect(stored.config_schema).toEqual(NOTION_SCHEMA);
      expect(stored.updated_at.toISOString()).toBe("2020-01-01T00:00:00.000Z");
    });

    it("does not confuse the two rows — Zoom's schema never lands on Outlook", async () => {
      const zoom = await requireRow(BUILTIN_ZOOM_TRANSCRIPTS_CATALOG_ROW.id);
      const outlook = await requireRow(BUILTIN_OUTLOOK_MAIL_CATALOG_ROW.id);
      expect(zoom.config_schema).not.toEqual(outlook.config_schema);
      expect(zoom.config_schema).toEqual(expectedSchema(BUILTIN_ZOOM_TRANSCRIPTS_CATALOG_ROW));
      expect(outlook.config_schema).toEqual(expectedSchema(BUILTIN_OUTLOOK_MAIL_CATALOG_ROW));
    });
  });

  describe("schemas the guard must not rewrite or choke on", () => {
    beforeEach(async () => {
      await pool.query(`TRUNCATE plugin_catalog`);
    }, PG_TIMEOUT_MS);

    for (const { label, row, oldHelp } of ROWS) {
      it(`leaves ${label}'s operator-rewritten helper text alone`, async () => {
        const operator: Json[] = row.configSchema.map((field) =>
          field.key === CONFIG_HELP_FIELD_KEY
            ? ({ ...field, description: "Whatever we call this internally." } as unknown as Json)
            : (field as unknown as Json),
        );
        await insertRow(row.id, operator);
        await pool.query(MIGRATION_SQL);
        const stored = await requireRow(row.id);
        expect(stored.config_schema).toEqual(operator);
        expect(stored.updated_at.toISOString()).toBe("2020-01-01T00:00:00.000Z");
      }, PG_TIMEOUT_MS);

      it(`rewrites ONLY the '${CONFIG_HELP_FIELD_KEY}' field on ${label}, not a twin under another key`, async () => {
        // The key predicate's falsifier. A guard matched on the string alone
        // rewrites any field that happens to carry it — plausible, since these
        // rows already repeat help text across fields.
        const twinKey = "not_the_description_field";
        const withTwin: Json[] = [
          ...preRenameSchema(row, oldHelp),
          { key: twinKey, type: "string", description: oldHelp } as unknown as Json,
        ];
        await insertRow(row.id, withTwin);
        await pool.query(MIGRATION_SQL);
        const stored = (await requireRow(row.id)).config_schema as Array<Record<string, Json>>;
        expect(stored.find((f) => f.key === CONFIG_HELP_FIELD_KEY)?.description).toBe(
          row.configSchema.find((f) => f.key === CONFIG_HELP_FIELD_KEY)?.description,
        );
        expect(stored.find((f) => f.key === twinKey)?.description).toBe(oldHelp);
      }, PG_TIMEOUT_MS);

      it(`survives a NULL config_schema on ${label} without erroring`, async () => {
        await insertRow(row.id, null);
        await expect(pool.query(MIGRATION_SQL)).resolves.toBeDefined();
        expect((await requireRow(row.id)).config_schema).toBeNull();
      }, PG_TIMEOUT_MS);

      it(`survives a config_schema that is an OBJECT, not an array, on ${label}`, async () => {
        // `jsonb_array_elements` errors on a non-array, and an error here aborts
        // the whole boot migration — hence the `jsonb_typeof` guard.
        const notAnArray: Json = { fields: [] };
        await insertRow(row.id, notAnArray);
        await expect(pool.query(MIGRATION_SQL)).resolves.toBeDefined();
        expect((await requireRow(row.id)).config_schema).toEqual(notAnArray);
      }, PG_TIMEOUT_MS);

      it(`survives an EMPTY config_schema array on ${label} without nulling it`, async () => {
        // `jsonb_agg` over an empty set returns NULL, which would blank the
        // column outright — the guard has to keep the statement off this row.
        await insertRow(row.id, []);
        await expect(pool.query(MIGRATION_SQL)).resolves.toBeDefined();
        expect((await requireRow(row.id)).config_schema).toEqual([]);
      }, PG_TIMEOUT_MS);
    }

    it("no-ops on an empty catalog without erroring", async () => {
      // A fresh region runs every migration before the boot seed inserts
      // anything, so 0203 meets an empty table.
      await expect(pool.query(MIGRATION_SQL)).resolves.toBeDefined();
      const { rows } = await pool.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM plugin_catalog`,
      );
      expect(rows[0]?.n).toBe("0");
    }, PG_TIMEOUT_MS);

    it("handles a partially-seeded region — Zoom present, Outlook never seeded", async () => {
      // Reachable through the seeder itself: it loops sequentially, a hard
      // failure aborts the pass mid-list, and #5239's slug collision leaves a
      // canonical id unseeded. The statements are independent.
      const [zoomPair, outlookPair] = ROWS;
      await insertRow(zoomPair!.row.id, preRenameSchema(zoomPair!.row, zoomPair!.oldHelp));
      await pool.query(MIGRATION_SQL);
      expect((await requireRow(zoomPair!.row.id)).config_schema).toEqual(
        expectedSchema(zoomPair!.row),
      );
      expect(await rowOf(outlookPair!.row.id)).toBeUndefined();
    }, PG_TIMEOUT_MS);
  });

  describe("the operator breadcrumb", () => {
    beforeEach(async () => {
      await pool.query(`TRUNCATE plugin_catalog`);
    }, PG_TIMEOUT_MS);

    it("reports the rewrite per row, and warns about nothing", async () => {
      for (const { row, oldHelp } of ROWS) {
        await insertRow(row.id, preRenameSchema(row, oldHelp));
      }
      const notices = await runMigrationCapturingNotices();
      for (const { row } of ROWS) {
        expect(
          notices.some(
            (n) =>
              n.severity === "NOTICE" &&
              n.message.includes(`${row.id}: present=1, config_schema helper text rewritten=1`),
          ),
        ).toBe(true);
      }
      expect(notices.filter((n) => n.severity === "WARNING")).toHaveLength(0);
    }, PG_TIMEOUT_MS);

    it("distinguishes ABSENT from present-but-not-eligible", async () => {
      // `count(*) FILTER`-style eligibility returns 0 on an empty set too, so
      // "the row is not here" and "the row is here and already renamed" would
      // otherwise emit byte-identical output. Only the first is exposed to the
      // rollback window in 0203's header. Both halves in one case deliberately:
      // the claim is that they are DISTINGUISHABLE.
      const [zoomPair, outlookPair] = ROWS;
      await insertRow(outlookPair!.row.id, expectedSchema(outlookPair!.row));
      const notices = await runMigrationCapturingNotices();
      expect(
        notices.some((n) =>
          n.message.includes(`${zoomPair!.row.id}: present=0, config_schema helper text rewritten=0`),
        ),
      ).toBe(true);
      expect(
        notices.some((n) =>
          n.message.includes(
            `${outlookPair!.row.id}: present=1, config_schema helper text rewritten=0`,
          ),
        ),
      ).toBe(true);
      expect(notices.filter((n) => n.severity === "WARNING")).toHaveLength(0);
    }, PG_TIMEOUT_MS);

    it("RAISES A WARNING per row when help text still reads 'brain source'", async () => {
      // The arm that answers the question an operator actually has. Both causes
      // are named in the message because only one of them is benign — here it
      // is the benign one: their own wording, which stands.
      for (const { row } of ROWS) {
        await insertRow(row.id, [
          { key: "description", type: "string", description: "We still say brain source here." },
        ]);
      }
      const notices = await runMigrationCapturingNotices();
      for (const { row } of ROWS) {
        expect(
          notices.some((n) => n.severity === "WARNING" && n.message.includes(row.id)),
        ).toBe(true);
      }
      expect(notices.filter((n) => n.severity === "WARNING")).toHaveLength(ROWS.length);
      // Severity is asserted as a property of the SQL, not because anything
      // routes on it: `migrate.ts` logs only the message, at `info`, so the two
      // arms are told apart by TEXT downstream.
    }, PG_TIMEOUT_MS);

    it("does not warn once the rename has actually landed", async () => {
      for (const { row, oldHelp } of ROWS) {
        await insertRow(row.id, preRenameSchema(row, oldHelp));
      }
      await runMigrationCapturingNotices();
      const second = await runMigrationCapturingNotices();
      for (const { row } of ROWS) {
        expect(
          second.some((n) =>
            n.message.includes(`${row.id}: present=1, config_schema helper text rewritten=0`),
          ),
        ).toBe(true);
      }
      expect(second.filter((n) => n.severity === "WARNING")).toHaveLength(0);
      // Guard against the two arms collapsing into one message that satisfies
      // both count checks.
      expect(second.map((n) => n.message).join("\n")).not.toContain("rewritten=1");
    }, PG_TIMEOUT_MS);
  });
});
