/**
 * ClickHouse DataSource Plugin — reference implementation for @useatlas/plugin-sdk.
 *
 * Demonstrates how the AtlasDatasourcePlugin interface can wrap real adapter
 * code extracted from the core ClickHouse adapter in packages/api/src/lib/db/connection.ts.
 *
 * Two registration modes:
 *
 * 1. Static config-defined datasource (self-host / operator-baked) — pass a
 *    `url` and the plugin wires a single connection at boot:
 * ```typescript
 * import { defineConfig } from "@atlas/api/lib/config";
 * import { clickhousePlugin } from "@useatlas/clickhouse";
 *
 * export default defineConfig({
 *   plugins: [clickhousePlugin({ url: "clickhouse://localhost:8123/default" })],
 * });
 * ```
 *
 * 2. Adapter-only (SaaS per-workspace) — pass no `url` and the plugin registers
 *    purely as an adapter, so customers add their own ClickHouse per workspace
 *    via Admin → Connections (DB-stored, encrypted). No operator env var, no
 *    static datasource:
 * ```typescript
 * export default defineConfig({
 *   plugins: [clickhousePlugin({})],
 * });
 * ```
 */

import { z } from "zod";
import { createPlugin } from "@useatlas/plugin-sdk";
import type { AtlasDatasourcePlugin, PluginDBConnection, PluginHealthResult, PluginLogger } from "@useatlas/plugin-sdk";
import {
  createClickHouseConnection,
  extractHost,
} from "./connection";
import { CLICKHOUSE_FORBIDDEN_PATTERNS } from "./validation";

/**
 * Strict schema for a fully-specified ClickHouse connection. A `url` is
 * required. Used by `connection.createFromConfig` to validate the decrypted
 * per-(workspace, install) config of a DB-stored datasource (which always
 * carries a url) before building the connection.
 */
const ClickHouseConnectionConfigSchema = z.object({
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

/**
 * Lenient config-time schema — every field optional so the plugin can be
 * registered as an ADAPTER ONLY: `clickhousePlugin({})` parses, registering the
 * plugin so its `createFromConfig` is available to the datasource bridge for
 * DB-stored per-workspace installs (the SaaS model), with no static datasource.
 * A `url`, when supplied, is still validated for scheme.
 */
const ClickHouseConfigSchema = ClickHouseConnectionConfigSchema.partial();

export type ClickHouseConfig = z.infer<typeof ClickHouseConfigSchema>;

/**
 * Build the plugin object from validated config.
 * Exported for direct use with definePlugin() when Zod validation
 * has already been performed externally (e.g. in tests or custom wiring).
 */
export function buildClickHousePlugin(
  config: ClickHouseConfig,
): AtlasDatasourcePlugin<ClickHouseConfig> {
  let log: PluginLogger | undefined;

  // When a static url is configured the plugin wires a config-defined
  // connection at boot; without one it is registered adapter-only.
  const staticUrl = config.url;

  const connection: AtlasDatasourcePlugin<ClickHouseConfig>["connection"] = {
    // DB-driven (admin-UI-registered) datasources: build a connection from
    // the per-(workspace, install) config decrypted from `workspace_plugins`,
    // re-validated through the strict schema. Always available — this is the
    // SaaS per-workspace path and the only path in adapter-only mode.
    createFromConfig: (runtimeConfig) => {
      const parsed = ClickHouseConnectionConfigSchema.parse(runtimeConfig);
      return createClickHouseConnection({
        url: parsed.url,
        database: parsed.database,
        logger: log,
      });
    },
    dbType: "clickhouse",
    parserDialect: "PostgresQL", // closest match in node-sql-parser
    forbiddenPatterns: CLICKHOUSE_FORBIDDEN_PATTERNS,
  };

  if (staticUrl) {
    connection.create = () =>
      // ClickHouse HTTP transport is stateless — safe to create per call.
      // Pool-based databases (Postgres, MySQL) should cache the connection.
      createClickHouseConnection({ url: staticUrl, database: config.database, logger: log });
  }

  return {
    id: "clickhouse-datasource",
    types: ["datasource"] as const,
    version: "0.1.0",
    name: "ClickHouse DataSource",
    config,

    connection,

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
      log = ctx.logger;
      if (staticUrl) {
        ctx.logger.info(`ClickHouse datasource plugin initialized (${extractHost(staticUrl)})`);
      } else {
        ctx.logger.info(
          "ClickHouse datasource plugin registered as adapter-only — per-workspace datasources via Admin → Connections",
        );
      }
    },

    async healthCheck(): Promise<PluginHealthResult> {
      // Adapter-only: no static datasource to probe. The plugin itself is a
      // healthy adapter; per-workspace connections are health-checked by the
      // ConnectionRegistry once installed.
      if (!staticUrl) {
        return { healthy: true, message: "adapter-only: no static datasource configured" };
      }
      const start = performance.now();
      let conn: PluginDBConnection | undefined;
      try {
        conn = createClickHouseConnection({ url: staticUrl, database: config.database });
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
 * // Static datasource (self-host):
 * plugins: [clickhousePlugin({ url: "clickhouse://localhost:8123/default" })]
 * // Adapter-only (SaaS — customers bring their own per workspace):
 * plugins: [clickhousePlugin({})]
 * ```
 */
export const clickhousePlugin = createPlugin({
  configSchema: ClickHouseConfigSchema,
  create: buildClickHousePlugin,
});

export { createClickHouseConnection, rewriteClickHouseUrl, extractHost } from "./connection";
export { CLICKHOUSE_FORBIDDEN_PATTERNS } from "./validation";
