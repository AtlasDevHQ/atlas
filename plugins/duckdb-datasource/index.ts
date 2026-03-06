/**
 * DuckDB DataSource Plugin — reference implementation for @useatlas/plugin-sdk.
 *
 * Wraps the in-process DuckDB adapter extracted from
 * packages/api/src/lib/db/duckdb.ts.
 *
 * Usage in atlas.config.ts:
 * ```typescript
 * import { defineConfig } from "@atlas/api/lib/config";
 * import { duckdbPlugin } from "@atlas/plugin-duckdb-datasource";
 *
 * export default defineConfig({
 *   plugins: [
 *     duckdbPlugin({ url: "duckdb://path/to/analytics.duckdb" }),
 *   ],
 * });
 * ```
 */

import { z } from "zod";
import { createPlugin } from "@useatlas/plugin-sdk";
import type { AtlasDatasourcePlugin, PluginDBConnection, PluginHealthResult } from "@useatlas/plugin-sdk";
import { createDuckDBConnection, parseDuckDBUrl } from "./connection";
import { DUCKDB_FORBIDDEN_PATTERNS } from "./validation";

const DuckDBConfigSchema = z.object({
  /** DuckDB connection URL (duckdb://). */
  url: z
    .string()
    .trim()
    .min(1, "DuckDB URL must not be empty")
    .refine(
      (u) => u.startsWith("duckdb://"),
      "URL must start with duckdb://",
    )
    .optional(),
  /** Direct path to a .duckdb file, or ":memory:" for in-memory. */
  path: z.string().optional(),
  /** Open in read-only mode. Defaults to true for file databases. */
  readOnly: z.boolean().optional(),
}).refine(
  (cfg) => cfg.url || cfg.path,
  "Either url or path is required",
);

export type DuckDBPluginConfig = z.infer<typeof DuckDBConfigSchema>;

/**
 * Build the plugin object from validated config.
 * Exported for direct use with definePlugin() when Zod validation
 * has already been performed externally (e.g. in tests or custom wiring).
 */
export function buildDuckDBPlugin(
  config: DuckDBPluginConfig,
): AtlasDatasourcePlugin<DuckDBPluginConfig> {
  const dbConfig = config.url
    ? { ...parseDuckDBUrl(config.url), readOnly: config.readOnly }
    : { path: config.path!, readOnly: config.readOnly };

  return {
    id: "duckdb-datasource",
    type: "datasource" as const,
    version: "0.1.0",
    name: "DuckDB DataSource",
    config,

    connection: {
      create: () => createDuckDBConnection(dbConfig),
      dbType: "duckdb",
      parserDialect: "PostgresQL",
      forbiddenPatterns: DUCKDB_FORBIDDEN_PATTERNS,
    },

    entities: [],

    dialect: [
      "This datasource uses DuckDB SQL dialect.",
      "- DuckDB syntax is similar to PostgreSQL with additional features.",
      "- Use UNNEST() to expand arrays into rows.",
      "- LIST and STRUCT types are natively supported.",
      "- Use read_csv_auto() and read_parquet() to query files directly.",
      "- Use DATE_TRUNC() and DATE_PART() for date operations.",
      "- Use STRING_AGG() for string aggregation.",
      "- Supports window functions, CTEs, and lateral joins.",
      "- In-process engine — no connection pooling needed.",
    ].join("\n"),

    async initialize(ctx) {
      const label = dbConfig.path === ":memory:" ? "in-memory" : dbConfig.path;
      ctx.logger.info(`DuckDB datasource plugin initialized (${label})`);
    },

    async healthCheck(): Promise<PluginHealthResult> {
      const start = performance.now();
      let conn: PluginDBConnection | undefined;
      try {
        conn = createDuckDBConnection(dbConfig);
        await conn.query("SELECT 1", 5000);
        return {
          healthy: true,
          latencyMs: Math.round(performance.now() - start),
        };
      } catch (err) {
        return {
          healthy: false,
          message: err instanceof Error ? err.message : String(err),
          latencyMs: Math.round(performance.now() - start),
        };
      } finally {
        if (conn) {
          await conn.close();
        }
      }
    },
  };
}

/**
 * Factory function for use in atlas.config.ts plugins array.
 *
 * @example
 * ```typescript
 * plugins: [duckdbPlugin({ url: "duckdb://analytics.duckdb" })]
 * ```
 */
export const duckdbPlugin = createPlugin({
  configSchema: DuckDBConfigSchema,
  create: buildDuckDBPlugin,
});

export { createDuckDBConnection, parseDuckDBUrl } from "./connection";
export { DUCKDB_FORBIDDEN_PATTERNS } from "./validation";
