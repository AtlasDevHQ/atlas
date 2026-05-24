/**
 * Tests for the built-in Datasource catalog seed pass.
 *
 * Two surfaces under test:
 *
 *  1. `seedBuiltinDatasourceCatalog(db)` — the runtime seeder. Asserts
 *     the eight rows are inserted with `ON CONFLICT DO NOTHING` semantics
 *     and that the result accounting (inserted vs preserved) tracks the
 *     RETURNING row set.
 *
 *  2. `BUILTIN_DATASOURCE_CATALOG_ROWS` — the in-process source of truth.
 *     Asserts content-level invariants: all eight slugs, only
 *     `demo-postgres` is auto_install, every catalog slug is recognised
 *     by the resolver, every secret field is flagged.
 *
 * The migration is checked end-to-end by `migrate-pg.test.ts` against
 * a real Postgres; here we only exercise the boot-time seed against an
 * in-memory mock pool.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  seedBuiltinDatasourceCatalog,
  BUILTIN_DATASOURCE_CATALOG_ROWS,
  type BuiltinDatasourceCatalogSeedDb,
} from "@atlas/api/lib/db/seed-builtin-datasource-catalog";
import {
  BUILTIN_DATASOURCE_CATALOG_SLUGS,
  catalogSlugToDbType,
} from "@atlas/api/lib/db/datasource-pool-resolver";

interface CapturedQuery {
  sql: string;
  params: unknown[];
}

const captureDb = (
  conflictWith: ReadonlyArray<string> = [],
): { db: BuiltinDatasourceCatalogSeedDb; captured: CapturedQuery[] } => {
  const captured: CapturedQuery[] = [];
  const db: BuiltinDatasourceCatalogSeedDb = {
    async query<T = unknown>(sql: string, params?: unknown[]) {
      captured.push({ sql, params: params ?? [] });
      // Simulate ON CONFLICT DO NOTHING ... RETURNING slug:
      // return slugs that did NOT conflict (i.e. that actually inserted).
      const allSlugs = BUILTIN_DATASOURCE_CATALOG_ROWS.map((r) => r.slug);
      const inserted = allSlugs.filter((s) => !conflictWith.includes(s));
      return { rows: inserted.map((slug) => ({ slug })) as T[] };
    },
  };
  return { db, captured };
};

describe("BUILTIN_DATASOURCE_CATALOG_ROWS", () => {
  it("contains exactly the eight built-in slugs", () => {
    expect(BUILTIN_DATASOURCE_CATALOG_ROWS).toHaveLength(8);
    const slugs = BUILTIN_DATASOURCE_CATALOG_ROWS.map((r) => r.slug);
    expect(new Set(slugs)).toEqual(new Set(BUILTIN_DATASOURCE_CATALOG_SLUGS));
  });

  it("only marks `demo-postgres` as auto_install", () => {
    const autoInstall = BUILTIN_DATASOURCE_CATALOG_ROWS.filter((r) => r.autoInstall);
    expect(autoInstall).toHaveLength(1);
    expect(autoInstall[0]!.slug).toBe("demo-postgres");
  });

  it("uses install_model 'oauth' only for salesforce (rest are 'form')", () => {
    for (const row of BUILTIN_DATASOURCE_CATALOG_ROWS) {
      const expected = row.slug === "salesforce" ? "oauth" : "form";
      expect(row.installModel).toBe(expected);
    }
  });

  it("flags every URL / credential field as `secret: true`", () => {
    const secretFieldsBySlug: Record<string, string[]> = {
      postgres: ["url"],
      mysql: ["url"],
      snowflake: ["url"],
      clickhouse: ["url"],
      bigquery: ["service_account_json"],
      duckdb: [],
      salesforce: [],
      "demo-postgres": [],
    };
    for (const row of BUILTIN_DATASOURCE_CATALOG_ROWS) {
      const expectedSecrets = secretFieldsBySlug[row.slug] ?? [];
      const actualSecrets = row.configSchema
        .filter((f) => f.secret === true)
        .map((f) => f.key);
      expect(actualSecrets.sort()).toEqual(expectedSecrets.sort());
    }
  });

  it("requires the primary credential field on form-based rows", () => {
    const primary: Record<string, string | null> = {
      postgres: "url",
      mysql: "url",
      snowflake: "url",
      clickhouse: "url",
      bigquery: "service_account_json",
      duckdb: "path",
      salesforce: null, // handler-managed, empty schema
      "demo-postgres": null, // operator-managed, empty schema
    };
    for (const row of BUILTIN_DATASOURCE_CATALOG_ROWS) {
      const key = primary[row.slug];
      if (key === null) continue;
      const field = row.configSchema.find((f) => f.key === key);
      expect(field, `expected ${key} field on ${row.slug}`).toBeDefined();
      expect(field!.required).toBe(true);
    }
  });

  it("uses `id = catalog:<slug>` for every row (matches catalog-seeder convention)", () => {
    for (const row of BUILTIN_DATASOURCE_CATALOG_ROWS) {
      expect(row.id).toBe(`catalog:${row.slug}`);
    }
  });

  it("every seed slug is recognised by the resolver's slug→db_type map", () => {
    for (const row of BUILTIN_DATASOURCE_CATALOG_ROWS) {
      // Must not throw — covered separately in datasource-pool-resolver.test.ts.
      catalogSlugToDbType(row.slug);
    }
  });
});

describe("seedBuiltinDatasourceCatalog (idempotent boot seed)", () => {
  it("issues a single bulk INSERT covering all eight rows", async () => {
    const { db, captured } = captureDb();
    await seedBuiltinDatasourceCatalog(db);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.sql).toContain("INSERT INTO plugin_catalog");
    expect(captured[0]!.sql).toContain("ON CONFLICT (slug) DO NOTHING");
    expect(captured[0]!.sql).toContain("RETURNING slug");
  });

  it("emits 7 params per row (id, name, slug, description, install_model, auto_install, config_schema)", async () => {
    const { db, captured } = captureDb();
    await seedBuiltinDatasourceCatalog(db);
    // 8 rows × 7 params per row = 56 bound params total.
    expect(captured[0]!.params).toHaveLength(8 * 7);
  });

  it("reports every slug as inserted on a fresh catalog (no conflicts)", async () => {
    const { db } = captureDb();
    const result = await seedBuiltinDatasourceCatalog(db);
    expect([...result.insertedSlugs].sort()).toEqual(
      [...BUILTIN_DATASOURCE_CATALOG_SLUGS].sort(),
    );
    expect(result.preservedSlugs).toHaveLength(0);
  });

  it("reports preserved slugs when rows already exist (ON CONFLICT DO NOTHING path)", async () => {
    const { db } = captureDb(["postgres", "demo-postgres"]);
    const result = await seedBuiltinDatasourceCatalog(db);
    const preserved: string[] = [...result.preservedSlugs];
    expect(preserved.sort()).toEqual(["demo-postgres", "postgres"]);
    expect(result.insertedSlugs).toHaveLength(6);
    expect(result.insertedSlugs).not.toContain("postgres");
  });

  it("reports all preserved on a fully-populated catalog (true idempotent re-boot)", async () => {
    const { db } = captureDb([...BUILTIN_DATASOURCE_CATALOG_SLUGS]);
    const result = await seedBuiltinDatasourceCatalog(db);
    expect(result.insertedSlugs).toHaveLength(0);
    expect([...result.preservedSlugs].sort()).toEqual(
      [...BUILTIN_DATASOURCE_CATALOG_SLUGS].sort(),
    );
  });

  it("serializes config_schema as JSON in the bound params (matches ::jsonb cast in SQL)", async () => {
    const { db, captured } = captureDb();
    await seedBuiltinDatasourceCatalog(db);
    // Each row's 7th param (index 6, 13, 20, …) is the JSON-serialized configSchema.
    for (let i = 0; i < BUILTIN_DATASOURCE_CATALOG_ROWS.length; i++) {
      const param = captured[0]!.params[i * 7 + 6];
      expect(typeof param).toBe("string");
      const parsed = JSON.parse(param as string);
      expect(parsed).toEqual(BUILTIN_DATASOURCE_CATALOG_ROWS[i]!.configSchema);
    }
  });

  it("propagates DB errors instead of swallowing them", async () => {
    const failing: BuiltinDatasourceCatalogSeedDb = {
      async query() {
        throw new Error("simulated pg error");
      },
    };
    await expect(seedBuiltinDatasourceCatalog(failing)).rejects.toThrow(
      /simulated pg error/,
    );
  });
});

describe("migration 0093 and seed module stay aligned", () => {
  // The migration file's VALUES block and the seed module's
  // BUILTIN_DATASOURCE_CATALOG_ROWS need to express the same eight rows.
  // A migration-only edit (or a seed-only edit) would let live DBs and
  // fresh DBs disagree until the next boot. These tests catch the drift.

  const migrationSql = readFileSync(
    join(import.meta.dir, "..", "migrations", "0093_builtin_datasource_catalog.sql"),
    "utf8",
  );

  it("references every seed slug in the migration SQL", () => {
    for (const row of BUILTIN_DATASOURCE_CATALOG_ROWS) {
      // Each slug appears in the VALUES block — exact string match.
      expect(migrationSql).toContain(`'${row.slug}'`);
    }
  });

  it("uses ON CONFLICT (slug) DO NOTHING — idempotent on re-deploy", () => {
    expect(migrationSql).toContain("ON CONFLICT (slug) DO NOTHING");
  });

  it("sets auto_install = true only on the demo-postgres row", () => {
    // Coarse but useful: the migration's `true` autoinstall token appears
    // exactly once — alongside `demo-postgres`. Other rows use `false`.
    const lines = migrationSql.split("\n");
    const demoLineIdx = lines.findIndex((l) => l.includes("'demo-postgres'"));
    expect(demoLineIdx).toBeGreaterThan(-1);
    // Inspect the row's VALUES block — `true,` appears as the auto_install
    // position for demo-postgres only.
    const otherSlugs = BUILTIN_DATASOURCE_CATALOG_ROWS.filter(
      (r) => r.slug !== "demo-postgres",
    );
    for (const row of otherSlugs) {
      // Each non-demo row's stanza opens with `'catalog:<slug>'`. The
      // stanza ends before the next row's `(` so we slice to the next
      // catalog id.
      const stanzaStart = migrationSql.indexOf(`'catalog:${row.slug}'`);
      const nextStanza = migrationSql.indexOf(
        "(\n    'catalog:",
        stanzaStart + 1,
      );
      const stanza = migrationSql.slice(
        stanzaStart,
        nextStanza === -1 ? undefined : nextStanza,
      );
      // The auto_install position in our VALUES block is the 9th value:
      // (id, name, slug, description, type, install_model, pillar,
      //  implementation_status, AUTO_INSTALL, ...). Easier check: this
      // row's stanza must contain `false,` (its auto_install value) and
      // must NOT contain `true,\n    'starter'` immediately before the
      // min_plan position.
      expect(stanza).toContain("false,\n    'starter'");
    }
  });
});
