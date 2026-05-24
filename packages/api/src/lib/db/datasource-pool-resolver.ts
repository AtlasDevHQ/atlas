/**
 * `DatasourcePoolResolver` — pure function that translates a
 * `workspace_plugins` row (with `pillar = 'datasource'`) plus a decrypted
 * config blob into the typed `DatasourcePoolConfig` ConnectionRegistry
 * will consume in slice 6 (#2744) of the unified install pipeline.
 *
 * Inert in this slice (#2743): no production caller wires it up;
 * ConnectionRegistry still reads from the `connections` table. The shape
 * is here so slice 6 can pivot ConnectionRegistry without re-deriving the
 * per-`db_type` translation conventions.
 *
 * Per ADR-0007 §"For ConnectionRegistry":
 *   > Reads pool definitions from `workspace_plugins WHERE pillar = 'datasource'`.
 *   > The `default` connection (auto-initialized from `ATLAS_DATASOURCE_URL`)
 *   > continues to be config-managed and not stored in `workspace_plugins` —
 *   > that's a runtime artifact, not a per-workspace install.
 *
 * Pure function: no IO, no Effect, no logging. Inputs are typed row shapes;
 * the output is a discriminated union by `dbType`. Schema-level secret
 * decryption (`decryptSecretFields` from `lib/plugins/secrets`) happens
 * upstream — this module assumes `decryptedConfig.url` is plaintext.
 */

/**
 * Catalog slugs for the eight built-in datasource catalog rows seeded by
 * migration 0093 + the boot-time `seed-builtin-datasource-catalog` pass.
 * Two slugs map to the same `db_type` (`postgres` and `demo-postgres`); see
 * {@link catalogSlugToDbType}.
 */
export const BUILTIN_DATASOURCE_CATALOG_SLUGS = [
  "postgres",
  "mysql",
  "snowflake",
  "clickhouse",
  "bigquery",
  "duckdb",
  "salesforce",
  "demo-postgres",
] as const;
export type BuiltinDatasourceCatalogSlug =
  (typeof BUILTIN_DATASOURCE_CATALOG_SLUGS)[number];

/**
 * `db_type` values produced by {@link catalogSlugToDbType}. ConnectionRegistry's
 * `DBType` union admits arbitrary strings for plugin-managed types — this
 * type pins the closed set the resolver handles for the built-in catalog.
 */
export type BuiltinDatasourceDbType =
  | "postgres"
  | "mysql"
  | "snowflake"
  | "clickhouse"
  | "bigquery"
  | "duckdb"
  | "salesforce";

/**
 * Map a built-in datasource catalog slug to its `db_type`. The mapping is
 * 1:1 for native slugs (`mysql` → `mysql`); `demo-postgres` collapses to
 * `postgres` because the demo connection is just an operator-managed
 * Postgres install pointing at the shared demo pool.
 */
export function catalogSlugToDbType(
  slug: string,
): BuiltinDatasourceDbType {
  switch (slug) {
    case "postgres":
    case "demo-postgres":
      return "postgres";
    case "mysql":
      return "mysql";
    case "snowflake":
      return "snowflake";
    case "clickhouse":
      return "clickhouse";
    case "bigquery":
      return "bigquery";
    case "duckdb":
      return "duckdb";
    case "salesforce":
      return "salesforce";
    default:
      throw new Error(
        `Unknown built-in datasource catalog slug "${slug}". ` +
          `Expected one of: ${BUILTIN_DATASOURCE_CATALOG_SLUGS.join(", ")}.`,
      );
  }
}

/**
 * Narrow shape of the `workspace_plugins` row the resolver consumes. The
 * full Drizzle row carries many more columns (id, enabled, installed_at,
 * etc.); the resolver only needs the identifying tuple plus the catalog
 * slug so it can decide which translation to apply.
 */
export interface DatasourceWorkspacePluginRow {
  readonly workspaceId: string;
  readonly catalogId: string;
  readonly installId: string;
  readonly pillar: "datasource";
  /**
   * `plugin_catalog.slug` joined onto the install row. The slug determines
   * the `db_type` — see {@link catalogSlugToDbType}. Slice 6 (#2744) will
   * pull this via JOIN in the same SELECT it uses to read the install.
   */
  readonly catalogSlug: string;
}

// ---------------------------------------------------------------------------
// PoolConfig discriminated union
// ---------------------------------------------------------------------------

/** Shared pool-tuning fields applicable to native (pg/mysql) pools. */
interface PoolTuning {
  readonly maxConnections?: number;
  readonly idleTimeoutMs?: number;
}

export interface PostgresPoolConfig extends PoolTuning {
  readonly dbType: "postgres";
  readonly url: string;
  readonly schema?: string;
  readonly description?: string;
  /**
   * SQL statements to run once per physical connection at acquire time.
   * Empty when no init is needed. Postgres uses this for `SET search_path`
   * when `schema` is set to a non-`public` identifier.
   *
   * The translation lives in the resolver (rather than in ConnectionRegistry's
   * `createPostgresDB`) so the per-`db_type` convention is testable in
   * isolation and slice 6 can drive a unified `initSql` runner.
   */
  readonly initSql: readonly string[];
}

export interface MySQLPoolConfig extends PoolTuning {
  readonly dbType: "mysql";
  readonly url: string;
  readonly description?: string;
  /** Per-session read-only enforcement. */
  readonly initSql: readonly string[];
}

export interface SnowflakePoolConfig {
  readonly dbType: "snowflake";
  readonly url: string;
  readonly schema?: string;
  readonly description?: string;
}

export interface ClickHousePoolConfig {
  readonly dbType: "clickhouse";
  readonly url: string;
  readonly description?: string;
  /**
   * ClickHouse defense-in-depth read-only flag — applied per query in the
   * `@useatlas/clickhouse` plugin (`clickhouse_settings.readonly`). Pinned
   * to `1` here so slice 6 / the plugin caller can pass it through without
   * a magic-number re-derivation.
   */
  readonly readonly: 1;
}

export interface BigQueryPoolConfig {
  readonly dbType: "bigquery";
  readonly serviceAccountJson: string;
  readonly projectId: string;
  readonly description?: string;
}

export interface DuckDBPoolConfig {
  readonly dbType: "duckdb";
  readonly path: string;
  readonly description?: string;
}

export interface SalesforcePoolConfig {
  readonly dbType: "salesforce";
  readonly description?: string;
}

export type DatasourcePoolConfig =
  | PostgresPoolConfig
  | MySQLPoolConfig
  | SnowflakePoolConfig
  | ClickHousePoolConfig
  | BigQueryPoolConfig
  | DuckDBPoolConfig
  | SalesforcePoolConfig;

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

/** Regex for valid SQL identifiers — mirrors `connection.ts:VALID_SQL_IDENTIFIER`. */
const VALID_SQL_IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * Translate a `workspace_plugins` row + decrypted config into a typed
 * `DatasourcePoolConfig`. Pure: same `(row, decryptedConfig)` always
 * produces the same output.
 *
 * `decryptedConfig` is the `workspace_plugins.config` JSONB after
 * `decryptSecretFields` has unwrapped every `secret: true` field declared
 * in the catalog row's `config_schema`. The resolver does not call
 * `decryptSecretFields` itself — keeping the resolver pure means the
 * encryption key + keyset are caller concerns.
 *
 * Throws when:
 *   - `row.pillar !== "datasource"`
 *   - `row.catalogSlug` isn't in {@link BUILTIN_DATASOURCE_CATALOG_SLUGS}
 *   - the decrypted config is missing a required field for the resolved `db_type`
 *   - Postgres `schema` is not a valid SQL identifier
 */
export function resolveDatasourcePoolConfig(
  row: DatasourceWorkspacePluginRow,
  decryptedConfig: Readonly<Record<string, unknown>>,
): DatasourcePoolConfig {
  if (row.pillar !== "datasource") {
    throw new Error(
      `DatasourcePoolResolver: pillar must be 'datasource', got '${row.pillar}'`,
    );
  }
  const dbType = catalogSlugToDbType(row.catalogSlug);

  switch (dbType) {
    case "postgres":
      return resolvePostgres(decryptedConfig);
    case "mysql":
      return resolveMySQL(decryptedConfig);
    case "snowflake":
      return resolveSnowflake(decryptedConfig);
    case "clickhouse":
      return resolveClickHouse(decryptedConfig);
    case "bigquery":
      return resolveBigQuery(decryptedConfig);
    case "duckdb":
      return resolveDuckDB(decryptedConfig);
    case "salesforce":
      return resolveSalesforce(decryptedConfig);
  }
}

// ---------------------------------------------------------------------------
// Per-dbType resolvers
// ---------------------------------------------------------------------------

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asPositiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

function resolvePostgres(c: Readonly<Record<string, unknown>>): PostgresPoolConfig {
  const url = asString(c.url);
  if (!url) {
    throw new Error("DatasourcePoolResolver(postgres): missing required field `url`");
  }
  const schema = asString(c.schema);
  if (schema !== undefined && !VALID_SQL_IDENTIFIER.test(schema)) {
    throw new Error(
      `DatasourcePoolResolver(postgres): invalid schema "${schema}" — must be a valid SQL identifier`,
    );
  }
  // `public` is the Postgres default — no init SQL needed and a SET would
  // be a noisy no-op on every connection acquire.
  const initSql =
    schema && schema !== "public" ? [`SET search_path TO "${schema}", public`] : [];

  return {
    dbType: "postgres",
    url,
    ...(schema !== undefined ? { schema } : {}),
    ...(asString(c.description) !== undefined
      ? { description: asString(c.description)! }
      : {}),
    ...(asPositiveInt(c.maxConnections) !== undefined
      ? { maxConnections: asPositiveInt(c.maxConnections)! }
      : {}),
    ...(asPositiveInt(c.idleTimeoutMs) !== undefined
      ? { idleTimeoutMs: asPositiveInt(c.idleTimeoutMs)! }
      : {}),
    initSql,
  };
}

function resolveMySQL(c: Readonly<Record<string, unknown>>): MySQLPoolConfig {
  const url = asString(c.url);
  if (!url) {
    throw new Error("DatasourcePoolResolver(mysql): missing required field `url`");
  }
  return {
    dbType: "mysql",
    url,
    ...(asString(c.description) !== undefined
      ? { description: asString(c.description)! }
      : {}),
    ...(asPositiveInt(c.maxConnections) !== undefined
      ? { maxConnections: asPositiveInt(c.maxConnections)! }
      : {}),
    ...(asPositiveInt(c.idleTimeoutMs) !== undefined
      ? { idleTimeoutMs: asPositiveInt(c.idleTimeoutMs)! }
      : {}),
    // Defense-in-depth read-only session — mirrors `createMySQLDB` in
    // `connection.ts` which executes this per-query today. Hoisting it to
    // an init-SQL list lets slice 6 run it once per connection acquire.
    initSql: ["SET SESSION TRANSACTION READ ONLY"],
  };
}

function resolveSnowflake(c: Readonly<Record<string, unknown>>): SnowflakePoolConfig {
  const url = asString(c.url);
  if (!url) {
    throw new Error("DatasourcePoolResolver(snowflake): missing required field `url`");
  }
  return {
    dbType: "snowflake",
    url,
    ...(asString(c.schema) !== undefined ? { schema: asString(c.schema)! } : {}),
    ...(asString(c.description) !== undefined
      ? { description: asString(c.description)! }
      : {}),
  };
}

function resolveClickHouse(c: Readonly<Record<string, unknown>>): ClickHousePoolConfig {
  const url = asString(c.url);
  if (!url) {
    throw new Error("DatasourcePoolResolver(clickhouse): missing required field `url`");
  }
  return {
    dbType: "clickhouse",
    url,
    ...(asString(c.description) !== undefined
      ? { description: asString(c.description)! }
      : {}),
    readonly: 1,
  };
}

function resolveBigQuery(c: Readonly<Record<string, unknown>>): BigQueryPoolConfig {
  const serviceAccountJson = asString(c.service_account_json);
  if (!serviceAccountJson) {
    throw new Error(
      "DatasourcePoolResolver(bigquery): missing required field `service_account_json`",
    );
  }
  const projectId = asString(c.project_id);
  if (!projectId) {
    throw new Error(
      "DatasourcePoolResolver(bigquery): missing required field `project_id`",
    );
  }
  return {
    dbType: "bigquery",
    serviceAccountJson,
    projectId,
    ...(asString(c.description) !== undefined
      ? { description: asString(c.description)! }
      : {}),
  };
}

function resolveDuckDB(c: Readonly<Record<string, unknown>>): DuckDBPoolConfig {
  const path = asString(c.path);
  if (!path) {
    throw new Error("DatasourcePoolResolver(duckdb): missing required field `path`");
  }
  return {
    dbType: "duckdb",
    path,
    ...(asString(c.description) !== undefined
      ? { description: asString(c.description)! }
      : {}),
  };
}

function resolveSalesforce(c: Readonly<Record<string, unknown>>): SalesforcePoolConfig {
  return {
    dbType: "salesforce",
    ...(asString(c.description) !== undefined
      ? { description: asString(c.description)! }
      : {}),
  };
}
