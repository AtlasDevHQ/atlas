/**
 * MySQL DataSource Plugin — reference implementation for @useatlas/plugin-sdk.
 *
 * Wraps the mysql2/promise pool adapter extracted from the core MySQL adapter
 * in packages/api/src/lib/db/connection.ts.
 *
 * Usage in atlas.config.ts:
 * ```typescript
 * import { defineConfig } from "@atlas/api/lib/config";
 * import { mysqlPlugin } from "@atlas/plugin-mysql-datasource";
 *
 * export default defineConfig({
 *   plugins: [
 *     mysqlPlugin({ url: "mysql://user:pass@localhost:3306/mydb" }),
 *   ],
 * });
 * ```
 */

import { z } from "zod";
import { createPlugin } from "@useatlas/plugin-sdk";
import type { AtlasDatasourcePlugin, PluginDBConnection, PluginHealthResult } from "@useatlas/plugin-sdk";
import { createMySQLConnection, extractHost } from "./connection";

const MySQLConfigSchema = z.object({
  /** MySQL connection URL (mysql:// or mysql2://). */
  url: z
    .string()
    .trim()
    .min(1, "MySQL URL must not be empty")
    .refine(
      (u) => u.startsWith("mysql://") || u.startsWith("mysql2://"),
      "URL must start with mysql:// or mysql2://",
    ),
  /** Maximum pool size. Defaults to 10, max 500. */
  poolSize: z.number().int().positive().max(500, "Pool size must not exceed 500").optional(),
  /** Idle connection timeout in milliseconds. Defaults to 30000. */
  idleTimeoutMs: z.number().int().positive().optional(),
});

export type MySQLConfig = z.infer<typeof MySQLConfigSchema>;

/**
 * Build the plugin object from validated config.
 * Exported for direct use with definePlugin() when Zod validation
 * has already been performed externally (e.g. in tests or custom wiring).
 */
export function buildMySQLPlugin(
  config: MySQLConfig,
): AtlasDatasourcePlugin<MySQLConfig> {
  // Cache the pool-backed connection — MySQL pools are heavyweight resources.
  // Unlike stateless HTTP transports (ClickHouse), pool-based databases should
  // reuse a single connection/pool per plugin instance.
  let cachedConnection: PluginDBConnection | undefined;

  return {
    id: "mysql-datasource",
    type: "datasource" as const,
    version: "0.1.0",
    name: "MySQL DataSource",
    config,

    connection: {
      create: () => {
        if (!cachedConnection) {
          cachedConnection = createMySQLConnection({
            url: config.url,
            poolSize: config.poolSize,
            idleTimeoutMs: config.idleTimeoutMs,
          });
        }
        return cachedConnection;
      },
      dbType: "mysql",
    },

    entities: [],

    dialect: [
      "This datasource uses MySQL SQL dialect.",
      "- Use LIMIT before OFFSET (e.g. LIMIT 10 OFFSET 20).",
      "- Use backtick quoting for identifiers (e.g. `table_name`).",
      "- Use DATE_FORMAT() instead of TO_CHAR() for date formatting.",
      "- Use IFNULL() instead of COALESCE() for two-argument null handling.",
      "- Use STR_TO_DATE() for string-to-date conversion.",
      "- GROUP_CONCAT() for string aggregation (not STRING_AGG).",
      "- Use NOW() for current timestamp, CURDATE() for current date.",
    ].join("\n"),

    async initialize(ctx) {
      ctx.logger.info(`MySQL datasource plugin initialized (${extractHost(config.url)})`);
    },

    async healthCheck(): Promise<PluginHealthResult> {
      const start = performance.now();
      let conn: PluginDBConnection | undefined;
      try {
        conn = createMySQLConnection({
          url: config.url,
          poolSize: config.poolSize,
          idleTimeoutMs: config.idleTimeoutMs,
        });
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
 * plugins: [mysqlPlugin({ url: "mysql://user:pass@localhost:3306/mydb" })]
 * ```
 */
export const mysqlPlugin = createPlugin({
  configSchema: MySQLConfigSchema,
  create: buildMySQLPlugin,
});

export { createMySQLConnection, extractHost } from "./connection";
