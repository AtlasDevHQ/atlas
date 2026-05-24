/**
 * Boot-time idempotent seed pass for the eight built-in Datasource
 * catalog rows. Re-asserts the same rows migration 0093 inserts on
 * fresh DBs — keeps the catalog consistent if an operator deleted a
 * row out-of-band.
 *
 * Per ADR-0007 §"Catalog seeding for Datasources":
 *
 *   > The current code-hard-wired `DB_TYPES` array promotes to built-in
 *   > `plugin_catalog` rows seeded by a boot-time migration: `postgres`,
 *   > `mysql`, `snowflake`, `clickhouse`, `bigquery`, `duckdb`,
 *   > `salesforce`, `demo-postgres`. Operators do *not* declare these
 *   > in `atlas.config.ts` — they ship with Atlas.
 *
 * Idempotency:
 *   - Uses `ON CONFLICT (slug) DO NOTHING` so re-running on a populated
 *     catalog is a no-op. The atlas.config.ts catalog seeder
 *     (`integrations/catalog-seeder.ts`) updates mutable fields on
 *     existing rows; this seed deliberately leaves them alone — once
 *     a built-in row exists, an operator who edited its `name` or
 *     `description` via SQL keeps that edit.
 *   - Slice 5 ships the resolver inert (no ConnectionRegistry consumer);
 *     a seed-time failure logs at error and the API keeps booting —
 *     pre-existing rows answer admin-UI reads.
 *
 * Inert until slice 6 (#2744): no production caller reads from these
 * rows. The seeded rows do, however, surface as catalog entries in
 * admin-UI listings — they appear in the integrations marketplace as
 * `pillar = 'datasource'` cards (slice 8 / #2746 pivots the UI to
 * surface them on `/admin/connections`).
 */

import { createLogger } from "@atlas/api/lib/logger";
import {
  BUILTIN_DATASOURCE_CATALOG_SLUGS,
  type BuiltinDatasourceCatalogSlug,
} from "@atlas/api/lib/db/datasource-pool-resolver";
import type { ConfigSchemaField } from "@atlas/api/lib/plugins/registry";

const log = createLogger("db.seed-builtin-datasource-catalog");

/**
 * Declarative description of a single built-in Datasource catalog row.
 * Mirrors `plugin_catalog`'s column shape for the columns the seed sets.
 * `min_plan`, `enabled`, `saas_eligible` are pinned to the row's
 * canonical values; `created_at` / `updated_at` are written as `NOW()`
 * in the SQL — no field here.
 *
 * `configSchema` reuses {@link ConfigSchemaField} (the same shape the
 * rest of the codebase reads back from `plugin_catalog.config_schema`
 * JSONB) so a future field addition there (e.g. a new option key)
 * propagates here at compile time instead of silently drifting between
 * the seed-time write shape and the runtime read shape.
 */
export interface BuiltinDatasourceCatalogRow {
  readonly id: string;
  readonly slug: BuiltinDatasourceCatalogSlug;
  readonly name: string;
  readonly description: string;
  readonly installModel: "form" | "oauth";
  readonly autoInstall: boolean;
  readonly configSchema: ReadonlyArray<ConfigSchemaField>;
}

/**
 * The eight built-in Datasource catalog rows seeded by this module +
 * migration 0093. The single source of truth for `name` / `description`
 * / `config_schema` across both surfaces — keeping the SQL migration
 * structurally identical to this table is enforced by the
 * `migration-and-seed-stay-aligned` test in
 * `__tests__/seed-builtin-datasource-catalog.test.ts`.
 *
 * `config_schema` `secret: true` fields drive
 * `plugins/secrets.ts::encryptSecretFields` so per-workspace credentials
 * land encrypted in `workspace_plugins.config` JSONB once slice 6 wires
 * the install handler.
 */
export const BUILTIN_DATASOURCE_CATALOG_ROWS: ReadonlyArray<BuiltinDatasourceCatalogRow> = [
  {
    id: "catalog:postgres",
    slug: "postgres",
    name: "PostgreSQL",
    description: "Connect a PostgreSQL database as an analytics datasource.",
    installModel: "form",
    autoInstall: false,
    configSchema: [
      {
        key: "url",
        type: "string",
        label: "Connection URL",
        required: true,
        secret: true,
        description: "postgresql://user:pass@host:5432/database",
      },
      {
        key: "schema",
        type: "string",
        label: "Schema",
        description: "Optional. Sets search_path on connection.",
      },
      {
        key: "description",
        type: "string",
        label: "Description",
        description: "Optional. Shown in the agent system prompt.",
      },
    ],
  },
  {
    id: "catalog:mysql",
    slug: "mysql",
    name: "MySQL",
    description: "Connect a MySQL database as an analytics datasource.",
    installModel: "form",
    autoInstall: false,
    configSchema: [
      {
        key: "url",
        type: "string",
        label: "Connection URL",
        required: true,
        secret: true,
        description: "mysql://user:pass@host:3306/database",
      },
      { key: "schema", type: "string", label: "Schema", description: "Optional." },
      {
        key: "description",
        type: "string",
        label: "Description",
        description: "Optional. Shown in the agent system prompt.",
      },
    ],
  },
  {
    id: "catalog:snowflake",
    slug: "snowflake",
    name: "Snowflake",
    description: "Connect a Snowflake account as an analytics datasource.",
    installModel: "form",
    autoInstall: false,
    configSchema: [
      {
        key: "url",
        type: "string",
        label: "Connection URL",
        required: true,
        secret: true,
        description:
          "snowflake://user:pass@account/db/schema?warehouse=WH&role=ROLE",
      },
      { key: "schema", type: "string", label: "Schema", description: "Optional." },
      {
        key: "description",
        type: "string",
        label: "Description",
        description: "Optional. Shown in the agent system prompt.",
      },
    ],
  },
  {
    id: "catalog:clickhouse",
    slug: "clickhouse",
    name: "ClickHouse",
    description: "Connect a ClickHouse instance as an analytics datasource.",
    installModel: "form",
    autoInstall: false,
    configSchema: [
      {
        key: "url",
        type: "string",
        label: "Connection URL",
        required: true,
        secret: true,
        description: "clickhouse://user:pass@host:8443/database",
      },
      {
        key: "description",
        type: "string",
        label: "Description",
        description: "Optional. Shown in the agent system prompt.",
      },
    ],
  },
  {
    id: "catalog:bigquery",
    slug: "bigquery",
    name: "BigQuery",
    description: "Connect a Google BigQuery project as an analytics datasource.",
    installModel: "form",
    autoInstall: false,
    configSchema: [
      {
        key: "service_account_json",
        type: "string",
        label: "Service Account JSON",
        required: true,
        secret: true,
        description: "Paste the full service account key JSON.",
      },
      {
        key: "project_id",
        type: "string",
        label: "GCP Project ID",
        required: true,
      },
      {
        key: "description",
        type: "string",
        label: "Description",
        description: "Optional. Shown in the agent system prompt.",
      },
    ],
  },
  {
    id: "catalog:duckdb",
    slug: "duckdb",
    name: "DuckDB",
    description: "Connect a DuckDB file as an analytics datasource.",
    installModel: "form",
    autoInstall: false,
    configSchema: [
      {
        key: "path",
        type: "string",
        label: "Database File Path",
        required: true,
        description: "Absolute path to the .duckdb file.",
      },
      {
        key: "description",
        type: "string",
        label: "Description",
        description: "Optional. Shown in the agent system prompt.",
      },
    ],
  },
  {
    id: "catalog:salesforce",
    slug: "salesforce",
    name: "Salesforce",
    description: "Connect a Salesforce org as an analytics datasource via OAuth.",
    installModel: "oauth",
    autoInstall: false,
    configSchema: [],
  },
  {
    id: "catalog:demo-postgres",
    slug: "demo-postgres",
    name: "Demo Dataset",
    description:
      "Atlas-managed demo Postgres dataset, shared across all workspaces.",
    installModel: "form",
    autoInstall: true,
    configSchema: [],
  },
];

/**
 * Narrow shape of the DB client the seeder needs. Mirrors
 * `CatalogSeedDb` from `integrations/catalog-seeder.ts` so a single
 * mock pool serves both seeders in tests.
 */
export interface BuiltinDatasourceCatalogSeedDb {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface BuiltinDatasourceCatalogSeedResult {
  /** Slugs whose `ON CONFLICT DO NOTHING` ran an insert (row didn't exist). */
  readonly insertedSlugs: ReadonlyArray<BuiltinDatasourceCatalogSlug>;
  /** Slugs whose row already existed (the conflict path). */
  readonly preservedSlugs: ReadonlyArray<BuiltinDatasourceCatalogSlug>;
}

/**
 * Idempotently seed the eight built-in Datasource catalog rows.
 *
 * Bulk INSERT keeps the seed cheap (single statement vs eight) and lets
 * the result set (`RETURNING slug`) report which rows actually inserted
 * vs which were preserved. Unqualified `ON CONFLICT DO NOTHING` covers
 * both the `slug` unique index AND the `id` primary key — so a stray
 * operator-edited row with one of our canonical `catalog:<slug>` ids
 * under a different slug doesn't crash the boot pass.
 *
 * The bulk shape mirrors migration 0093's VALUES block exactly —
 * keeping them aligned is checked by the
 * `migration-and-seed-stay-aligned` test.
 */
export async function seedBuiltinDatasourceCatalog(
  db: BuiltinDatasourceCatalogSeedDb,
): Promise<BuiltinDatasourceCatalogSeedResult> {
  // Defense-in-depth: this list is the source of truth for the seed,
  // and the resolver's slug→db_type map is the source of truth for
  // accepted slugs. A regression that adds a row here without updating
  // the resolver would silently land a catalog entry the resolver can't
  // translate. Fail loud at boot rather than at first install.
  for (const row of BUILTIN_DATASOURCE_CATALOG_ROWS) {
    if (!BUILTIN_DATASOURCE_CATALOG_SLUGS.includes(row.slug)) {
      throw new Error(
        `Built-in datasource seed: row slug "${row.slug}" is not in BUILTIN_DATASOURCE_CATALOG_SLUGS — update datasource-pool-resolver.ts`,
      );
    }
  }

  // Parameterised bulk INSERT — each row contributes 7 placeholders
  // (id, name, slug, description, install_model, auto_install,
  // config_schema). The remaining 8 columns are SQL literals
  // (`'datasource'` for type and pillar, `'available'` for status,
  // `'starter'` for min_plan, two `true`s for enabled + saas_eligible,
  // and two `NOW()` timestamps). Column order matches migration 0093's
  // VALUES block — drift is checked by
  // `__tests__/seed-builtin-datasource-catalog.test.ts`'s
  // `migration-and-seed-stay-aligned` suite.
  const placeholders: string[] = [];
  const params: unknown[] = [];
  let p = 0;
  for (const row of BUILTIN_DATASOURCE_CATALOG_ROWS) {
    const placeholder = `($${++p}, $${++p}, $${++p}, $${++p}, 'datasource', $${++p}, 'datasource', 'available', $${++p}, 'starter', true, true, $${++p}::jsonb, NOW(), NOW())`;
    placeholders.push(placeholder);
    params.push(
      row.id,
      row.name,
      row.slug,
      row.description,
      row.installModel,
      row.autoInstall,
      JSON.stringify(row.configSchema),
    );
  }

  const { rows } = await db.query<{ slug: BuiltinDatasourceCatalogSlug }>(
    `INSERT INTO plugin_catalog
       (id, name, slug, description, type, install_model, pillar,
        implementation_status, auto_install, min_plan, enabled, saas_eligible,
        config_schema, created_at, updated_at)
     VALUES ${placeholders.join(", ")}
     ON CONFLICT DO NOTHING
     RETURNING slug`,
    params,
  );

  const insertedSlugs = rows.map((r) => r.slug);
  const insertedSet = new Set<string>(insertedSlugs);
  const preservedSlugs = BUILTIN_DATASOURCE_CATALOG_ROWS.map((r) => r.slug).filter(
    (slug) => !insertedSet.has(slug),
  );

  log.info(
    {
      insertedCount: insertedSlugs.length,
      preservedCount: preservedSlugs.length,
      insertedSlugs,
    },
    "Built-in Datasource catalog seed complete",
  );

  return { insertedSlugs, preservedSlugs };
}

/**
 * Discriminated outcome of {@link runBuiltinDatasourceCatalogSeedBoot}.
 *
 * `kind: "skipped"` is a legitimate skip (no `InternalDB` — typically a
 * test runner or a dev process without a DB configured). `kind: "error"`
 * means the seed actually threw; rows from the prior boot remain
 * authoritative. The two cases were previously collapsed to `null`,
 * which forced {@link BuiltinDatasourceCatalogSeedLive} to mislabel a
 * real failure as `outcome: "skipped-gate"`.
 */
export type BuiltinDatasourceCatalogSeedBootResult =
  | { readonly kind: "skipped"; readonly reason: "no-internal-db" }
  | {
      readonly kind: "seeded";
      readonly insertedSlugs: ReadonlyArray<BuiltinDatasourceCatalogSlug>;
      readonly preservedSlugs: ReadonlyArray<BuiltinDatasourceCatalogSlug>;
    }
  | { readonly kind: "error"; readonly message: string };

/**
 * Boot-pass wrapper. Mirrors `runCatalogSeedBoot` from
 * `integrations/catalog-seeder.ts` — log-and-continue posture so a seed
 * failure leaves pre-existing rows authoritative for the boot rather
 * than crashing the API. Returns a discriminated result so the Effect
 * Layer can surface skip vs error to health consumers without
 * conflating them. Failures still surface in logs.
 */
export async function runBuiltinDatasourceCatalogSeedBoot(): Promise<BuiltinDatasourceCatalogSeedBootResult> {
  const { hasInternalDB, getInternalDB } = await import(
    "@atlas/api/lib/db/internal"
  );

  if (!hasInternalDB()) {
    log.info(
      "Built-in Datasource catalog seed: no internal DB configured, skipping",
    );
    return { kind: "skipped", reason: "no-internal-db" };
  }

  const pool = getInternalDB();
  const db: BuiltinDatasourceCatalogSeedDb = {
    async query<T = unknown>(sql: string, params?: unknown[]) {
      const result = await pool.query(sql, params);
      return { rows: result.rows as T[] };
    },
  };

  try {
    const result = await seedBuiltinDatasourceCatalog(db);
    return {
      kind: "seeded",
      insertedSlugs: result.insertedSlugs,
      preservedSlugs: result.preservedSlugs,
    };
  } catch (err) {
    const normalized = err instanceof Error ? err : new Error(String(err));
    log.error(
      { err: normalized, rowCount: BUILTIN_DATASOURCE_CATALOG_ROWS.length },
      "Built-in Datasource catalog seed failed — plugin_catalog rows from prior boot remain authoritative",
    );
    return { kind: "error", message: normalized.message };
  }
}
