/**
 * Boot-time idempotent seed pass for the nine built-in Datasource
 * catalog rows. Re-asserts the same rows migrations 0093 (the original
 * eight) + 0123 (`elasticsearch`, #3270) insert on fresh DBs — keeps the
 * catalog consistent if an operator deleted a row out-of-band.
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
 *   - Uses unqualified `ON CONFLICT DO NOTHING` (covers both the `slug`
 *     unique index AND the `id` primary key) so re-running on a populated
 *     catalog is a no-op. The atlas.config.ts catalog seeder
 *     (`integrations/catalog-seeder.ts`) updates mutable fields on
 *     existing rows; this seed deliberately leaves them alone — once
 *     a built-in row exists, an operator who edited its `name` or
 *     `description` via SQL keeps that edit.
 *   - A seed-time failure logs at error and the API keeps booting —
 *     pre-existing rows answer admin-UI reads.
 *
 * These rows are live: they surface as catalog entries in admin-UI listings
 * (integrations marketplace `pillar = 'datasource'` cards), and form-install
 * handlers read them at install time to drive config_schema-based encryption
 * (e.g. `ElasticsearchFormInstallHandler`, #3270, reads the `elasticsearch`
 * row's `config_schema`). The `DatasourcePoolResolver` registry path remains
 * native-only (postgres/mysql) — query wiring for admin-installed plugin
 * datasources is tracked in #3295.
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
 * `min_plan` and `enabled` are pinned to canonical values in the SQL;
 * `saas_eligible` is per row (#3301 — DuckDB is `false`); `created_at` /
 * `updated_at` are written as `NOW()` in the SQL — no field here.
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
  /**
   * Whether this datasource may be installed on a SaaS deploy (#3301).
   * `false` rows are filtered out of the SaaS marketplace
   * (`/marketplace/available`) — DuckDB is file-path based and not
   * multi-tenant safe, so it is the lone `false` row. Existing DBs are
   * converged by migration 0124; fresh DBs get the right value from
   * 0093/0123 + this seed. Self-hosted ignores the flag entirely.
   */
  readonly saasEligible: boolean;
  readonly configSchema: ReadonlyArray<ConfigSchemaField>;
}

/**
 * The nine built-in Datasource catalog rows seeded by this module +
 * migrations 0093 (original eight) and 0123 (`elasticsearch`, #3270).
 * The single source of truth for `name` / `description` / `config_schema`
 * across both surfaces — keeping the SQL migrations structurally identical
 * to this table is enforced by the `migration-and-seed-stay-aligned` test in
 * `__tests__/seed-builtin-datasource-catalog.test.ts`.
 *
 * `saas_eligible` is per row (#3301): DuckDB is `false` (file-path based,
 * not multi-tenant safe), the rest `true`. Migrations 0093/0123 seeded
 * every row `true`; migration 0124 converges the DuckDB row on existing
 * DBs, and this seed asserts the same value on fresh / re-seeded DBs.
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
    saasEligible: true,
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
    saasEligible: true,
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
    saasEligible: true,
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
    saasEligible: true,
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
    saasEligible: true,
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
    // #3301 — file-path based, not multi-tenant safe; the only built-in
    // datasource hidden from the SaaS marketplace.
    saasEligible: false,
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
    saasEligible: true,
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
    saasEligible: true,
    configSchema: [],
  },
  {
    // #3270 — added after the original eight (migration 0123, not 0093). The
    // boot seed re-asserts all nine; only this row also ships in 0123 for
    // existing DBs that already ran 0093. `config_schema` mirrors the plugin's
    // `getConfigSchema()` (plugins/elasticsearch/src/index.ts) — the CURRENT
    // desired state (the auth + engine slices #3263–#3266). The four `secret:
    // true` fields (apiKey / password / awsSecretAccessKey / awsSessionToken)
    // drive `encryptSecretFields`; `url` and the AWS region/key-id/service carry
    // no credential. The full set is brought to existing rows by migration 0125
    // (0123 inserted only url/apiKey/description and is immutable); this literal
    // is used only when the seed re-inserts a row deleted out-of-band. Cloud ID
    // is an `atlas.config.ts`-only convenience, not a form field.
    id: "catalog:elasticsearch",
    slug: "elasticsearch",
    name: "Elasticsearch",
    description:
      "Connect an Elasticsearch or OpenSearch cluster as a read-only analytics datasource.",
    installModel: "form",
    autoInstall: false,
    saasEligible: true,
    configSchema: [
      {
        key: "url",
        type: "string",
        label: "Connection URL",
        required: true,
        description:
          "elasticsearch://host:9200 or opensearch://host:9200 — HTTPS by default; append ?ssl=false for a plaintext local cluster.",
      },
      {
        key: "engine",
        type: "select",
        label: "Engine",
        options: ["elasticsearch", "opensearch"],
        description:
          "Optional. Overrides the engine inferred from the URL scheme (defaults to elasticsearch).",
      },
      {
        key: "apiKey",
        type: "string",
        label: "API Key",
        secret: true,
        description:
          "API-key auth: Base64-encoded API key, sent as `Authorization: ApiKey`. Encrypted at rest.",
      },
      {
        key: "username",
        type: "string",
        label: "Username",
        description: "HTTP Basic auth: username (pair with Password).",
      },
      {
        key: "password",
        type: "string",
        label: "Password",
        secret: true,
        description: "HTTP Basic auth: password. Encrypted at rest.",
      },
      {
        key: "awsRegion",
        type: "string",
        label: "AWS Region",
        description:
          "AWS SigV4 (Amazon OpenSearch Service): region, e.g. us-east-1. Setting this selects SigV4 signing.",
      },
      {
        key: "awsAccessKeyId",
        type: "string",
        label: "AWS Access Key ID",
        description:
          "AWS SigV4: access key id. Optional — falls back to the AWS_ACCESS_KEY_ID environment variable.",
      },
      {
        key: "awsSecretAccessKey",
        type: "string",
        label: "AWS Secret Access Key",
        secret: true,
        description:
          "AWS SigV4: secret access key. Optional — falls back to AWS_SECRET_ACCESS_KEY. Encrypted at rest.",
      },
      {
        key: "awsSessionToken",
        type: "string",
        label: "AWS Session Token",
        secret: true,
        description:
          "AWS SigV4: session token for temporary credentials. Optional — falls back to AWS_SESSION_TOKEN. Encrypted at rest.",
      },
      {
        key: "awsService",
        type: "string",
        label: "AWS Service",
        description: "AWS SigV4: service code to sign with. Defaults to `es`.",
      },
      {
        key: "description",
        type: "string",
        label: "Description",
        description: "Optional. Shown in the agent system prompt.",
      },
    ],
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
 * Idempotently seed the nine built-in Datasource catalog rows.
 *
 * Bulk INSERT keeps the seed cheap (single statement vs nine) and lets
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

  // Parameterised bulk INSERT — each row contributes 8 placeholders
  // (id, name, slug, description, install_model, auto_install,
  // saas_eligible, config_schema). The remaining 7 columns are SQL
  // literals (`'datasource'` for type and pillar, `'available'` for
  // status, `'starter'` for min_plan, one `true` for enabled, and two
  // `NOW()` timestamps). `saas_eligible` is bound per row (#3301) so
  // DuckDB lands `false` on a fresh DB; existing DBs are converged by
  // migration 0124. Column order matches migration 0093's VALUES block —
  // drift is checked by `__tests__/seed-builtin-datasource-catalog.test.ts`'s
  // `migration-and-seed-stay-aligned` suite.
  const placeholders: string[] = [];
  const params: unknown[] = [];
  let p = 0;
  for (const row of BUILTIN_DATASOURCE_CATALOG_ROWS) {
    const placeholder = `($${++p}, $${++p}, $${++p}, $${++p}, 'datasource', $${++p}, 'datasource', 'available', $${++p}, 'starter', true, $${++p}, $${++p}::jsonb, NOW(), NOW())`;
    placeholders.push(placeholder);
    params.push(
      row.id,
      row.name,
      row.slug,
      row.description,
      row.installModel,
      row.autoInstall,
      row.saasEligible,
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
