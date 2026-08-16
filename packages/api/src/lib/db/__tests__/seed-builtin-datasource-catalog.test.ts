/**
 * Tests for the built-in Datasource catalog seed pass.
 *
 * Two surfaces under test:
 *
 *  1. `seedBuiltinDatasourceCatalog(db)` — the runtime seeder. Asserts
 *     the nine rows are inserted with `ON CONFLICT (id) DO NOTHING`
 *     semantics and that the result accounting partitions the expected
 *     slugs across inserted / preserved / blocked (#5266).
 *
 *     ⚠️ THE BLOCKED OUTCOME IS NOT HERE, and cannot be: this file's mock
 *     pool returns whatever the fixture says, so it can no more raise a
 *     real 23505 than it can prove Postgres would.
 *     `seed-builtin-datasource-catalog-collision.test.ts` covers what the
 *     seeder DOES with a rejection; `builtin-datasource-catalog-seed-pg.
 *     test.ts` covers that the rejection happens at all.
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

import { afterEach, describe, expect, it, mock } from "bun:test";
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

/**
 * Per-row mock pool (#5266 — the seeder issues one statement per row now).
 *
 * `conflictWith` names slugs whose row already exists under its canonical id:
 * the `ON CONFLICT (id) DO NOTHING` path, which returns zero rows and no
 * error. That is the PRESERVED outcome, and it is deliberately not the same
 * thing as the BLOCKED outcome — a foreign id holding the slug raises 23505
 * instead, which this mock cannot express and
 * `seed-builtin-datasource-catalog-collision.test.ts` covers.
 */
const captureDb = (
  conflictWith: ReadonlyArray<string> = [],
): { db: BuiltinDatasourceCatalogSeedDb; captured: CapturedQuery[] } => {
  const captured: CapturedQuery[] = [];
  const db: BuiltinDatasourceCatalogSeedDb = {
    async query<T = unknown>(sql: string, params?: unknown[]) {
      captured.push({ sql, params: params ?? [] });
      // The seeder binds (id, name, slug, …) — slug is the third param.
      const slug = String((params ?? [])[2]);
      return {
        rows: (conflictWith.includes(slug) ? [] : [{ slug }]) as T[],
      };
    },
  };
  return { db, captured };
};

describe("BUILTIN_DATASOURCE_CATALOG_ROWS", () => {
  it("contains exactly the nine built-in slugs", () => {
    expect(BUILTIN_DATASOURCE_CATALOG_ROWS).toHaveLength(9);
    const slugs = BUILTIN_DATASOURCE_CATALOG_ROWS.map((r) => r.slug);
    expect(new Set(slugs)).toEqual(new Set(BUILTIN_DATASOURCE_CATALOG_SLUGS));
  });

  it("only marks `demo-postgres` as auto_install", () => {
    const autoInstall = BUILTIN_DATASOURCE_CATALOG_ROWS.filter((r) => r.autoInstall);
    expect(autoInstall).toHaveLength(1);
    expect(autoInstall[0]!.slug).toBe("demo-postgres");
  });

  it("marks only `duckdb` as not saas_eligible (#3301)", () => {
    // DuckDB is file-path based and not multi-tenant safe — it is the lone
    // built-in datasource hidden from the SaaS marketplace. Every other row
    // stays installable on SaaS.
    const ineligible = BUILTIN_DATASOURCE_CATALOG_ROWS.filter((r) => !r.saasEligible);
    expect(ineligible).toHaveLength(1);
    expect(ineligible[0]!.slug).toBe("duckdb");
    for (const row of BUILTIN_DATASOURCE_CATALOG_ROWS) {
      expect(row.saasEligible).toBe(row.slug !== "duckdb");
    }
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
      // ES `url` carries no credential. The auth modes (#3263–#3266) add three
      // more secret fields: HTTP Basic `password` and the two AWS SigV4 secrets.
      elasticsearch: ["apiKey", "awsSecretAccessKey", "awsSessionToken", "password"],
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
      elasticsearch: "url", // connection URL is the primary required field
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
  it("issues one INSERT per row, with the conflict target QUALIFIED on id (#5266)", async () => {
    const { db, captured } = captureDb();
    await seedBuiltinDatasourceCatalog(db);
    // One statement per row — the shape that makes per-row recovery
    // expressible at all. A bulk INSERT rejects the whole batch on the first
    // 23505, so it cannot report WHICH row is missing.
    expect(captured).toHaveLength(BUILTIN_DATASOURCE_CATALOG_ROWS.length);
    for (const q of captured) {
      expect(q.sql).toContain("INSERT INTO plugin_catalog");
      // ⚠️ Qualified on `(id)`. The unqualified spelling ALSO covers the slug
      // unique index, which is exactly the defect: it swallows a slug held
      // under a foreign id instead of raising 23505.
      expect(q.sql).toContain("ON CONFLICT (id) DO NOTHING");
      expect(q.sql).not.toMatch(/ON CONFLICT\s+DO NOTHING/);
      expect(q.sql).not.toContain("ON CONFLICT (slug)");
      expect(q.sql).toContain("RETURNING slug");
    }
  });

  it("emits 8 params per row (id, name, slug, description, install_model, auto_install, saas_eligible, config_schema)", async () => {
    const { db, captured } = captureDb();
    await seedBuiltinDatasourceCatalog(db);
    for (const q of captured) expect(q.params).toHaveLength(8);
  });

  it("binds saas_eligible per row — DuckDB false, every other row true (#3301)", async () => {
    const { db, captured } = captureDb();
    await seedBuiltinDatasourceCatalog(db);
    // Each statement's 7th param (index 6) is the saas_eligible boolean,
    // bound rather than a SQL literal so DuckDB lands `false` on a fresh DB.
    for (let i = 0; i < BUILTIN_DATASOURCE_CATALOG_ROWS.length; i++) {
      const row = BUILTIN_DATASOURCE_CATALOG_ROWS[i]!;
      expect(captured[i]!.params[6]).toBe(row.slug === "duckdb" ? false : true);
    }
  });

  it("reports every slug as inserted on a fresh catalog (no conflicts)", async () => {
    const { db } = captureDb();
    const result = await seedBuiltinDatasourceCatalog(db);
    expect([...result.insertedSlugs].sort()).toEqual(
      [...BUILTIN_DATASOURCE_CATALOG_SLUGS].sort(),
    );
    expect(result.preservedSlugs).toHaveLength(0);
    expect(result.blockedSlugs).toHaveLength(0);
  });

  it("reports preserved slugs when rows already exist (ON CONFLICT (id) DO NOTHING path)", async () => {
    const { db } = captureDb(["postgres", "demo-postgres"]);
    const result = await seedBuiltinDatasourceCatalog(db);
    const preserved: string[] = [...result.preservedSlugs];
    expect(preserved.sort()).toEqual(["demo-postgres", "postgres"]);
    expect(result.insertedSlugs).toHaveLength(7);
    expect(result.insertedSlugs).not.toContain("postgres");
    // Preserved is now a POSITIVE observation (the empty RETURNING set), not
    // "everything that isn't inserted" — so nothing blocked can leak in here.
    expect(result.blockedSlugs).toHaveLength(0);
  });

  it("reports all preserved on a fully-populated catalog (true idempotent re-boot)", async () => {
    const { db } = captureDb([...BUILTIN_DATASOURCE_CATALOG_SLUGS]);
    const result = await seedBuiltinDatasourceCatalog(db);
    expect(result.insertedSlugs).toHaveLength(0);
    expect([...result.preservedSlugs].sort()).toEqual(
      [...BUILTIN_DATASOURCE_CATALOG_SLUGS].sort(),
    );
    expect(result.blockedSlugs).toHaveLength(0);
  });

  it("partitions the expected slugs across the three outcome lists", async () => {
    // ⚠️ The invariant #5266 is about, stated as a partition rather than as
    // three separate counts: every expected slug appears exactly once. The old
    // derivation (`all minus inserted`) satisfied "covers everything" while
    // putting blocked rows in the wrong bucket.
    const { db } = captureDb(["postgres"]);
    const result = await seedBuiltinDatasourceCatalog(db);
    const all = [...result.insertedSlugs, ...result.preservedSlugs, ...result.blockedSlugs];
    expect(all.sort()).toEqual([...BUILTIN_DATASOURCE_CATALOG_SLUGS].sort());
    expect(new Set(all).size).toBe(all.length);
  });

  it("serializes config_schema as JSON in the bound params (matches ::jsonb cast in SQL)", async () => {
    const { db, captured } = captureDb();
    await seedBuiltinDatasourceCatalog(db);
    // Each statement's 8th param (index 7) is the JSON-serialized configSchema.
    for (let i = 0; i < BUILTIN_DATASOURCE_CATALOG_ROWS.length; i++) {
      const param = captured[i]!.params[7];
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
  // The migration files' VALUES blocks and the seed module's
  // BUILTIN_DATASOURCE_CATALOG_ROWS need to express the same nine rows.
  // A migration-only edit (or a seed-only edit) would let live DBs and
  // fresh DBs disagree until the next boot. These tests catch the drift.
  //
  // The original eight rows ship in 0093; `elasticsearch` (#3270) ships in
  // 0123 (0093 is immutable). Concatenate both so every seed slug is covered
  // by some migration's VALUES block.
  const migrationSql =
    readFileSync(
      join(import.meta.dir, "..", "migrations", "0093_builtin_datasource_catalog.sql"),
      "utf8",
    ) +
    "\n" +
    readFileSync(
      join(import.meta.dir, "..", "migrations", "0123_elasticsearch_datasource_catalog.sql"),
      "utf8",
    );

  it("references every seed slug in the migration SQL", () => {
    for (const row of BUILTIN_DATASOURCE_CATALOG_ROWS) {
      // Each slug appears in the VALUES block — exact string match.
      expect(migrationSql).toContain(`'${row.slug}'`);
    }
  });

  it("uses unqualified ON CONFLICT DO NOTHING — covers slug + id PK collisions", () => {
    // Unqualified (no `(slug)` target) so an operator-hand-edited row
    // with a clashing `catalog:<slug>` id under a different slug doesn't
    // crash startup with a PK violation. See migration header for the
    // edge case.
    expect(migrationSql).toContain("ON CONFLICT DO NOTHING");
    expect(migrationSql).not.toContain("ON CONFLICT (slug)");
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

  it("converges the DuckDB saas_eligible flag to false in migration 0124 (#3301)", () => {
    // 0093/0123 seeded every row `saas_eligible = true` (immutable). Migration
    // 0124 is the data UPDATE that flips DuckDB on existing DBs; the seed row
    // (`saasEligible: false`) keeps fresh / re-seeded DBs in agreement.
    const duckdb = BUILTIN_DATASOURCE_CATALOG_ROWS.find((r) => r.slug === "duckdb");
    expect(duckdb?.saasEligible).toBe(false);

    const convergeSql = readFileSync(
      join(import.meta.dir, "..", "migrations", "0124_duckdb_not_saas_eligible.sql"),
      "utf8",
    );
    // Targets only the DuckDB row by slug and sets saas_eligible = false.
    expect(convergeSql).toMatch(/UPDATE\s+plugin_catalog/i);
    expect(convergeSql).toMatch(/saas_eligible\s*=\s*false/i);
    expect(convergeSql).toMatch(/WHERE\s+slug\s*=\s*'duckdb'/i);
  });

  it("migration 0147 config_schema matches the seed's elasticsearch row exactly (#3841)", () => {
    // The elasticsearch progressive-auth schema lives in two places: migration
    // 0147 (the UPDATE that converges existing deploys) and the seed module's
    // row (the fresh-deploy / delete-and-self-heal re-insert). They must express
    // identical JSON — otherwise a converged deploy and a fresh deploy render
    // different install forms. 0147's header explicitly promises this mirror.
    const sql0147 = readFileSync(
      join(
        import.meta.dir,
        "..",
        "migrations",
        "0147_elasticsearch_auth_mode_selector_config_schema.sql",
      ),
      "utf8",
    );
    const match = sql0147.match(/config_schema\s*=\s*'([\s\S]*?)'::jsonb/);
    expect(match).not.toBeNull();
    const migrationSchema = JSON.parse(match![1]!);

    const seedRow = BUILTIN_DATASOURCE_CATALOG_ROWS.find(
      (r) => r.slug === "elasticsearch",
    );
    expect(seedRow).toBeDefined();
    // Deep structural equality — field order, select options, showWhen rules,
    // and secret flags all have to line up. JSON round-trip normalizes the seed
    // row's readonly TS shape to plain JSON for an exact compare.
    expect(migrationSchema).toEqual(
      JSON.parse(JSON.stringify(seedRow!.configSchema)),
    );
  });
});

describe("runBuiltinDatasourceCatalogSeedBoot (discriminated outcomes)", () => {
  // The boot wrapper sits between the Effect layer and the pure
  // seed function. Each of its three outcomes (`skipped` / `seeded` /
  // `error`) must be distinguishable — `BuiltinDatasourceCatalogSeedLive`
  // maps them onto the user-visible `outcome` field; conflating skip
  // and error was the bug that the discriminated return shape fixes.

  // Mock pg pool — captures the same shape `getInternalDB()` returns.
  const mockQuery = mock<
    (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>
  >(() => Promise.resolve({ rows: [] }));

  // Track which `db/internal` shape we want for the current test.
  let hasInternalDBReturns = true;

  void mock.module("@atlas/api/lib/db/internal", () => ({
    hasInternalDB: () => hasInternalDBReturns,
    getInternalDB: () => ({ query: mockQuery }),
    // Re-export the encryption-key reset so the resolver test file's
    // `mock.module` companions don't blow up on partial mocks if both
    // suites end up in the same isolated worker. Defensive.
    _resetEncryptionKeyCache: () => {},
  }));

  afterEach(() => {
    mockQuery.mockClear();
    hasInternalDBReturns = true;
  });

  it("returns `{ kind: 'skipped' }` when no internal DB is configured", async () => {
    hasInternalDBReturns = false;
    const { runBuiltinDatasourceCatalogSeedBoot } = await import(
      "@atlas/api/lib/db/seed-builtin-datasource-catalog"
    );
    const result = await runBuiltinDatasourceCatalogSeedBoot();
    expect(result.kind).toBe("skipped");
    if (result.kind === "skipped") expect(result.reason).toBe("no-internal-db");
    // Pool must not be queried in the skip path.
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("returns `{ kind: 'seeded' }` on a successful seed", async () => {
    hasInternalDBReturns = true;
    // Simulate every row inserted (no conflicts) — one statement per row,
    // each returning its own slug, matching the per-row RETURNING contract.
    mockQuery.mockImplementation((_sql, params) =>
      Promise.resolve({ rows: [{ slug: String((params ?? [])[2]) }] }),
    );
    const { runBuiltinDatasourceCatalogSeedBoot } = await import(
      "@atlas/api/lib/db/seed-builtin-datasource-catalog"
    );
    const result = await runBuiltinDatasourceCatalogSeedBoot();
    expect(result.kind).toBe("seeded");
    if (result.kind === "seeded") {
      expect(result.insertedSlugs).toHaveLength(9);
      expect(result.preservedSlugs).toHaveLength(0);
      expect(result.blockedSlugs).toHaveLength(0);
    }
  });

  it("⭐ forwards NON-EMPTY blockedSlugs and preservedSlugs across the boot seam", async () => {
    // ⚠️ THE TEST ABOVE ASSERTS BOTH FIELDS ARE `[]`, WHICH IS THE VALUE A
    // BROKEN FORWARD PRODUCES. `blockedSlugs: []` / `preservedSlugs: []`
    // hardcoded in the boot wrapper passes it — measured. The knowledge
    // sibling has this exact test (`seed-builtin-knowledge-catalog.test.ts`)
    // with a comment saying the same thing; #5266 did not carry it over, and
    // the review panel found the gap.
    //
    // One blocked, one preserved, seven inserted — three DIFFERENT sizes, so
    // no two of the lists can be swapped without a count disagreeing.
    hasInternalDBReturns = true;
    mockQuery.mockImplementation((_sql, params) => {
      const slug = String((params ?? [])[2]);
      if (slug === "clickhouse") {
        return Promise.reject(
          Object.assign(new Error("duplicate key value violates unique constraint"), {
            code: "23505",
            constraint: "plugin_catalog_slug_key",
            detail: `Key (slug)=(${slug}) already exists.`,
          }),
        );
      }
      // Empty RETURNING = the row already existed under its canonical id.
      if (slug === "postgres") return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [{ slug }] });
    });

    const { runBuiltinDatasourceCatalogSeedBoot } = await import(
      "@atlas/api/lib/db/seed-builtin-datasource-catalog"
    );
    const result = await runBuiltinDatasourceCatalogSeedBoot();
    expect(result.kind).toBe("seeded");
    if (result.kind === "seeded") {
      expect(result.blockedSlugs).toEqual(["clickhouse"]);
      expect(result.preservedSlugs).toEqual(["postgres"]);
      expect(result.insertedSlugs).toHaveLength(7);
    }
  });

  it("returns `{ kind: 'error' }` when the pool query throws", async () => {
    hasInternalDBReturns = true;
    mockQuery.mockImplementation(() =>
      Promise.reject(new Error("simulated pg failure")),
    );
    const { runBuiltinDatasourceCatalogSeedBoot } = await import(
      "@atlas/api/lib/db/seed-builtin-datasource-catalog"
    );
    const result = await runBuiltinDatasourceCatalogSeedBoot();
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toContain("simulated pg failure");
    }
  });

  it("normalizes a non-Error throw to a string message", async () => {
    hasInternalDBReturns = true;
    mockQuery.mockImplementation(() => Promise.reject("just a string"));
    const { runBuiltinDatasourceCatalogSeedBoot } = await import(
      "@atlas/api/lib/db/seed-builtin-datasource-catalog"
    );
    const result = await runBuiltinDatasourceCatalogSeedBoot();
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toContain("just a string");
    }
  });
});
