/**
 * ClickHouse DataSource Plugin — reference implementation for @useatlas/plugin-sdk.
 *
 * Demonstrates how the AtlasDatasourcePlugin interface can wrap real adapter
 * code extracted from the core ClickHouse adapter in packages/api/src/lib/db/connection.ts.
 *
 * Usage in atlas.config.ts (monorepo workspace — for external projects,
 * copy this plugin into your project or adjust the import path):
 * ```typescript
 * import { defineConfig } from "@atlas/api/lib/config";
 * import { clickhousePlugin } from "@atlas/plugin-clickhouse-datasource";
 *
 * export default defineConfig({
 *   plugins: [
 *     clickhousePlugin({ url: "clickhouse://localhost:8123/default" }),
 *   ],
 * });
 * ```
 */

import { z } from "zod";
import { createPlugin } from "@useatlas/plugin-sdk";
import type { AtlasDatasourcePlugin, PluginDBConnection, PluginHealthResult } from "@useatlas/plugin-sdk";
import {
  createClickHouseConnection,
  extractHost,
} from "./connection";

const ClickHouseConfigSchema = z.object({
  /** ClickHouse connection URL (clickhouse:// or clickhouses://). */
  url: z
    .string()
    .min(1, "ClickHouse URL must not be empty")
    .refine(
      (u) => u.startsWith("clickhouse://") || u.startsWith("clickhouses://"),
      "URL must start with clickhouse:// or clickhouses://",
    ),
  /** ClickHouse database name override. When omitted, uses the database from the URL path. */
  database: z.string().optional(),
});

export type ClickHouseConfig = z.infer<typeof ClickHouseConfigSchema>;

/**
 * Build the plugin object from validated config.
 * Exported for direct use with definePlugin() when Zod validation
 * has already been performed externally (e.g. in tests or custom wiring).
 */
export function buildClickHousePlugin(
  config: ClickHouseConfig,
): AtlasDatasourcePlugin<ClickHouseConfig> {
  return {
    id: "clickhouse-datasource",
    type: "datasource" as const,
    version: "0.1.0",
    name: "ClickHouse DataSource",
    config,

    connection: {
      create: () =>
        // ClickHouse HTTP transport is stateless — safe to create per call.
        // Pool-based databases (Postgres, MySQL) should cache the connection.
        createClickHouseConnection({ url: config.url, database: config.database }),
      dbType: "clickhouse",
    },

    entities: [],

    dialect: [
      "This datasource uses ClickHouse SQL dialect.",
      "- Use toStartOfMonth(), toStartOfWeek() for date truncation (not DATE_TRUNC).",
      "- Use countIf(condition) instead of COUNT(CASE WHEN ... END).",
      "- Use sumIf(column, condition) instead of SUM(CASE WHEN ... END).",
      "- Use arrayJoin() to unnest arrays.",
      "- String functions: lower(), upper(), trim(), splitByChar().",
      "- Do not add FORMAT clauses — the adapter handles output format automatically.",
      "- ClickHouse is column-oriented — avoid SELECT * on wide tables.",
    ].join("\n"),

    async initialize(ctx) {
      ctx.logger.info(`ClickHouse datasource plugin initialized (${extractHost(config.url)})`);
    },

    async healthCheck(): Promise<PluginHealthResult> {
      const start = performance.now();
      let conn: PluginDBConnection | undefined;
      try {
        conn = createClickHouseConnection({ url: config.url, database: config.database });
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
 * Validates config via Zod at call time, then builds the plugin.
 *
 * @example
 * ```typescript
 * plugins: [clickhousePlugin({ url: "clickhouse://localhost:8123/default" })]
 * ```
 */
export const clickhousePlugin = createPlugin({
  configSchema: ClickHouseConfigSchema,
  create: buildClickHousePlugin,
});

export { createClickHouseConnection, rewriteClickHouseUrl, extractHost } from "./connection";
