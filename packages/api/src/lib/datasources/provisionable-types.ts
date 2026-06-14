/**
 * Light, dependency-free constants describing which datasource types are
 * provisionable/profilable via MCP. Kept in its OWN module (no Effect /
 * installer / DB imports) so the MCP `datasource-tools` module can read the
 * `db_type` enum at tool-REGISTRATION time without dragging the heavy
 * `mcp-lifecycle` graph (workspace-installer, semantic-generator, the Effect
 * startup layers) into server boot. `mcp-lifecycle.ts` re-exports these.
 *
 * `McpNativeDbType` is the set the `ConnectionRegistry` builds a pool for
 * directly from a `url` — the only ones whose ephemeral health-check probe runs
 * through `connections.register` → `healthCheck`. Plugin-managed SQL types
 * (ClickHouse, Snowflake) are also provisionable via MCP (#3547), but through a
 * different, plugin-aware pre-flight (`createFromConfig` → `SELECT 1` → close),
 * gated by a RUNTIME capability check (`mcp-lifecycle.resolveProvisionCapability`)
 * rather than this static set.
 */

export type McpNativeDbType = "postgres" | "mysql";

const MCP_NATIVE_DB_TYPES: ReadonlySet<McpNativeDbType> = new Set(["postgres", "mysql"]);

export function isMcpNativeDbType(dbType: string): dbType is McpNativeDbType {
  return (MCP_NATIVE_DB_TYPES as ReadonlySet<string>).has(dbType);
}

/**
 * Catalog slugs offered by the MCP `create_datasource` `db_type` enum — the
 * static "menu". Native pg/mysql are always provisionable. The plugin-managed
 * SQL types (clickhouse / snowflake) are provisionable ONLY when a datasource
 * plugin implementing `createFromConfig` is registered for that dbType — a
 * RUNTIME capability check in `mcp-lifecycle.resolveProvisionCapability` gates
 * that and returns an actionable `unsupported` envelope when the plugin is
 * absent. Kept dependency-free (no registry / installer import) so the enum
 * builds at tool-REGISTRATION time without dragging the heavy graph into MCP
 * server boot. `elasticsearch` covers both Elasticsearch and OpenSearch (one
 * catalog slug, engine selected via a config field). REST/OpenAPI provisioning
 * is a separate install path (not `createFromConfig`) handled by its own tool.
 */
export const MCP_PROVISIONABLE_CATALOG_SLUGS: readonly string[] = [
  ...MCP_NATIVE_DB_TYPES,
  "clickhouse",
  "snowflake",
  "bigquery",
  "elasticsearch",
];
