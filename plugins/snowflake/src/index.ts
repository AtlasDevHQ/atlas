/**
 * Snowflake DataSource Plugin — reference implementation for @useatlas/plugin-sdk.
 *
 * Demonstrates how the AtlasDatasourcePlugin interface can wrap the callback-based
 * snowflake-sdk adapter extracted from packages/api/src/lib/db/connection.ts.
 *
 * Two registration modes:
 *
 * 1. Static config-defined datasource (self-host / operator-baked) — pass a
 *    `url` and the plugin wires a single connection at boot:
 * ```typescript
 * import { defineConfig } from "@atlas/api/lib/config";
 * import { snowflakePlugin } from "@useatlas/snowflake";
 *
 * export default defineConfig({
 *   plugins: [
 *     snowflakePlugin({ url: "snowflake://user:pass@account/db/schema?warehouse=WH&role=ROLE" }),
 *   ],
 * });
 * ```
 *
 * 2. Adapter-only (SaaS per-workspace) — pass no `url` and the plugin registers
 *    purely as an adapter, so customers add their own Snowflake per workspace
 *    via Admin → Connections (DB-stored, encrypted). No operator env var, no
 *    static datasource:
 * ```typescript
 * export default defineConfig({
 *   plugins: [snowflakePlugin({})],
 * });
 * ```
 */

import { z } from "zod";
import { createPlugin, measuredHealthCheck } from "@useatlas/plugin-sdk";
import type { AtlasDatasourcePlugin, PluginDBConnection, PluginHealthResult, PluginLogger } from "@useatlas/plugin-sdk";
import {
  createSnowflakeConnection,
  extractAccount,
  parseSnowflakeURL,
} from "./connection";
import { listSnowflakeObjects, profileSnowflake } from "./profiler";
import { SNOWFLAKE_FORBIDDEN_PATTERNS } from "./validation";

/**
 * Strict schema for a fully-specified Snowflake connection. A `url` is
 * required. Used by `connection.createFromConfig` to validate the decrypted
 * per-(workspace, install) config of a DB-stored datasource (which always
 * carries a url) before building the connection.
 */
const SnowflakeConnectionConfigSchema = z.object({
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

/**
 * Lenient config-time schema — every field optional so the plugin can be
 * registered as an ADAPTER ONLY: `snowflakePlugin({})` parses, registering the
 * plugin so its `createFromConfig` is available to the datasource bridge for
 * DB-stored per-workspace installs (the SaaS model), with no static datasource.
 * A `url`, when supplied, is still validated for scheme + parseability.
 */
const SnowflakeConfigSchema = SnowflakeConnectionConfigSchema.partial();

export type SnowflakeConfig = z.infer<typeof SnowflakeConfigSchema>;

/**
 * Build the plugin object from validated config.
 * Exported for direct use with definePlugin() when Zod validation
 * has already been performed externally (e.g. in tests or custom wiring).
 */
export function buildSnowflakePlugin(
  config: SnowflakeConfig,
): AtlasDatasourcePlugin<SnowflakeConfig> {
  let log: PluginLogger | undefined;

  // When a static url is configured the plugin wires a config-defined
  // connection at boot; without one it is registered adapter-only.
  const staticUrl = config.url;

  const connection: AtlasDatasourcePlugin<SnowflakeConfig>["connection"] = {
    // DB-driven (admin-UI-registered) datasources: build a connection from
    // the per-(workspace, install) config decrypted from `workspace_plugins`,
    // re-validated through the strict schema. Always available — this is the
    // SaaS per-workspace path and the only path in adapter-only mode.
    createFromConfig: (runtimeConfig) => {
      const parsed = SnowflakeConnectionConfigSchema.parse(runtimeConfig);
      const built = createSnowflakeConnection({
        url: parsed.url,
        maxConnections: parsed.maxConnections,
        logger: log,
      });
      // #3667 — introspection as a capability of the built connection, bound to
      // the creds that built it (no url/config re-resolution by the host).
      return {
        ...built,
        listObjects: (o) => listSnowflakeObjects({ url: parsed.url, schema: o?.schema }),
        profile: (o) =>
          profileSnowflake({
            url: parsed.url,
            schema: o?.schema,
            selectedTables: o?.selectedTables,
            prefetchedObjects: o?.prefetchedObjects,
            progress: o?.progress,
            logger: o?.logger,
          }),
      };
    },
    dbType: "snowflake",
    parserDialect: "Snowflake",
    forbiddenPatterns: SNOWFLAKE_FORBIDDEN_PATTERNS,
    // Introspection (listObjects / profile) is a capability of the BUILT
    // connection (createFromConfig above), bound to the creds that built it — the
    // one home MCP, the wizard, and the CLI all consume (ADR-0017 / #3670). No
    // connection-namespace profiler exports remain.
  };

  if (staticUrl) {
    connection.create = () =>
      createSnowflakeConnection({ url: staticUrl, maxConnections: config.maxConnections, logger: log });
  }

  return {
    id: "snowflake-datasource",
    types: ["datasource"] as const,
    version: "0.1.0",
    name: "Snowflake DataSource",
    config,

    connection,

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
      log = ctx.logger;
      if (staticUrl) {
        ctx.logger.info(`Snowflake datasource plugin initialized (${extractAccount(staticUrl)})`);
      } else {
        ctx.logger.info(
          "Snowflake datasource plugin registered as adapter-only — per-workspace datasources via Admin → Connections",
        );
      }
      ctx.logger.warn(
        "Snowflake has no session-level read-only mode — Atlas enforces SELECT-only " +
        "via SQL validation (regex + AST). For defense-in-depth, configure the " +
        "Snowflake connection with a role granted SELECT privileges only " +
        "(e.g. GRANT SELECT ON ALL TABLES IN SCHEMA <schema> TO ROLE atlas_readonly).",
      );
    },

    async healthCheck(): Promise<PluginHealthResult> {
      // Adapter-only: no static datasource to probe. The plugin itself is a
      // healthy adapter; per-workspace connections are health-checked by the
      // ConnectionRegistry once installed.
      if (!staticUrl) {
        return { healthy: true, message: "adapter-only: no static datasource configured" };
      }
      return measuredHealthCheck(async () => {
        let conn: PluginDBConnection | undefined;
        try {
          conn = createSnowflakeConnection({ url: staticUrl, maxConnections: config.maxConnections });
          await conn.query("SELECT 1", 5000);
          return { healthy: true };
        } finally {
          if (conn) {
            try {
              await conn.close();
            } catch (closeErr) {
              (log ?? console).warn(`[snowflake-datasource] Failed to close health-check connection: ${closeErr instanceof Error ? closeErr.message : String(closeErr)}`);
            }
          }
        }
      });
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
 * plugins: [snowflakePlugin({ url: "snowflake://user:pass@xy12345/mydb/public?warehouse=COMPUTE_WH" })]
 * // Adapter-only (SaaS — customers bring their own per workspace):
 * plugins: [snowflakePlugin({})]
 * ```
 */
export const snowflakePlugin = createPlugin({
  configSchema: SnowflakeConfigSchema,
  create: buildSnowflakePlugin,
});

export { createSnowflakeConnection, parseSnowflakeURL, extractAccount } from "./connection";
export { listSnowflakeObjects, profileSnowflake } from "./profiler";
export { SNOWFLAKE_FORBIDDEN_PATTERNS } from "./validation";
