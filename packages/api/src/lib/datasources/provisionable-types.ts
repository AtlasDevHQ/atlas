/**
 * Light, dependency-free constants describing which datasource types are
 * provisionable/profilable via MCP. Kept in its OWN module (no Effect /
 * installer / DB imports) so the MCP `datasource-tools` module can read the
 * `db_type` enum at tool-REGISTRATION time without dragging the heavy
 * `mcp-lifecycle` graph (workspace-installer, semantic-generator, the Effect
 * startup layers) into server boot. `mcp-lifecycle.ts` re-exports these.
 *
 * Scoped to the native dbTypes the `ConnectionRegistry` builds a pool for
 * directly from a `url` — the only ones whose ephemeral health-check probe
 * genuinely tests connectivity AND whose tables the in-core profiler can
 * introspect. See #3547 for extending beyond these.
 */

export type McpNativeDbType = "postgres" | "mysql";

const MCP_NATIVE_DB_TYPES: ReadonlySet<McpNativeDbType> = new Set(["postgres", "mysql"]);

export function isMcpNativeDbType(dbType: string): dbType is McpNativeDbType {
  return (MCP_NATIVE_DB_TYPES as ReadonlySet<string>).has(dbType);
}

/** Catalog slugs provisionable via MCP — derived from {@link McpNativeDbType}. */
export const MCP_PROVISIONABLE_CATALOG_SLUGS: readonly string[] = [...MCP_NATIVE_DB_TYPES];
