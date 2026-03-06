/**
 * Snowflake DataSource Plugin — reference implementation for @useatlas/plugin-sdk.
 *
 * Demonstrates how the AtlasDatasourcePlugin interface can wrap the callback-based
 * snowflake-sdk adapter extracted from packages/api/src/lib/db/connection.ts.
 *
 * Usage in atlas.config.ts:
 * ```typescript
 * import { defineConfig } from "@atlas/api/lib/config";
 * import { snowflakePlugin } from "@atlas/plugin-snowflake-datasource";
 *
 * export default defineConfig({
 *   plugins: [
 *     snowflakePlugin({ url: "snowflake://user:pass@account/db/schema?warehouse=WH&role=ROLE" }),
 *   ],
 * });
 * ```
 */

import { z } from "zod";
import { createPlugin } from "@useatlas/plugin-sdk";
import type { AtlasDatasourcePlugin, PluginDBConnection, PluginHealthResult } from "@useatlas/plugin-sdk";
import {
  createSnowflakeConnection,
  extractAccount,
  parseSnowflakeURL,
} from "./connection";
import { SNOWFLAKE_FORBIDDEN_PATTERNS } from "./validation";

const SnowflakeConfigSchema = z.object({
  /** Snowflake connection URL (snowflake://user:pass@account/db/schema?warehouse=WH&role=ROLE). */
  url: z
    .string()
    .min(1, "Snowflake URL must not be empty")
    .refine(
      (u) => u.startsWith("snowflake://"),
      "URL must start with snowflake://",
    )
    .superRefine((u, ctx) => {
      try {
        parseSnowflakeURL(u);
      } catch (err) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }),
  /** Maximum pool connections. Default 10. */
  maxConnections: z.number().int().positive().max(100).optional(),
});

export type SnowflakeConfig = z.infer<typeof SnowflakeConfigSchema>;

/**
 * Build the plugin object from validated config.
 * Exported for direct use with definePlugin() when Zod validation
 * has already been performed externally (e.g. in tests or custom wiring).
 */
export function buildSnowflakePlugin(
  config: SnowflakeConfig,
): AtlasDatasourcePlugin<SnowflakeConfig> {
  return {
    id: "snowflake-datasource",
    type: "datasource" as const,
    version: "0.1.0",
    name: "Snowflake DataSource",
    config,

    connection: {
      create: () =>
        createSnowflakeConnection({ url: config.url, maxConnections: config.maxConnections }),
      dbType: "snowflake",
      parserDialect: "Snowflake",
      forbiddenPatterns: SNOWFLAKE_FORBIDDEN_PATTERNS,
    },

    entities: [],

    dialect: [
      "This datasource uses Snowflake SQL dialect.",
      "- Use FLATTEN() for semi-structured data (VARIANT, ARRAY, OBJECT columns).",
      "- Use PARSE_JSON() to cast strings to semi-structured types.",
      "- Use DATE_TRUNC('month', col) for date truncation (not EXTRACT or dateadd patterns).",
      "- Use QUALIFY for window function filtering (e.g. QUALIFY ROW_NUMBER() OVER (...) = 1).",
      "- Use TRY_CAST() for safe type conversions that return NULL on failure.",
      "- Use $$ for dollar-quoted string literals.",
      "- Identifiers are case-insensitive and stored uppercase by default.",
      "- VARIANT type supports semi-structured data — use :key or ['key'] notation to access fields.",
    ].join("\n"),

    async initialize(ctx) {
      ctx.logger.info(`Snowflake datasource plugin initialized (${extractAccount(config.url)})`);
      ctx.logger.warn(
        "Snowflake has no session-level read-only mode — Atlas enforces SELECT-only " +
        "via SQL validation (regex + AST). For defense-in-depth, configure the " +
        "Snowflake connection with a role granted SELECT privileges only " +
        "(e.g. GRANT SELECT ON ALL TABLES IN SCHEMA <schema> TO ROLE atlas_readonly).",
      );
    },

    async healthCheck(): Promise<PluginHealthResult> {
      const start = performance.now();
      let conn: PluginDBConnection | undefined;
      try {
        conn = createSnowflakeConnection({ url: config.url, maxConnections: config.maxConnections });
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
          try {
            await conn.close();
          } catch (closeErr) {
            console.warn(
              "[snowflake-datasource] Failed to close health-check connection:",
              closeErr instanceof Error ? closeErr.message : String(closeErr),
            );
          }
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
 * plugins: [snowflakePlugin({ url: "snowflake://user:pass@xy12345/mydb/public?warehouse=COMPUTE_WH" })]
 * ```
 */
export const snowflakePlugin = createPlugin({
  configSchema: SnowflakeConfigSchema,
  create: buildSnowflakePlugin,
});

export { createSnowflakeConnection, parseSnowflakeURL, extractAccount } from "./connection";
export { SNOWFLAKE_FORBIDDEN_PATTERNS } from "./validation";
