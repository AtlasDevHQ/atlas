/**
 * DuckDB DataSource Plugin — reference implementation for @useatlas/plugin-sdk.
 *
 * Wraps the in-process DuckDB adapter extracted from
 * packages/api/src/lib/db/duckdb.ts.
 *
 * Two registration modes:
 *
 * 1. Static config-defined datasource (self-host / operator-baked) — pass a
 *    `url` or `path` and the plugin wires a single connection at boot:
 * ```typescript
 * import { defineConfig } from "@atlas/api/lib/config";
 * import { duckdbPlugin } from "@useatlas/duckdb";
 *
 * export default defineConfig({
 *   plugins: [duckdbPlugin({ url: "duckdb://path/to/analytics.duckdb" })],
 * });
 * ```
 *
 * 2. Adapter-only — pass no `url`/`path` and the plugin registers purely as an
 *    adapter (DB-stored per-workspace connections via `createFromConfig`). This
 *    mode exists for self-host parity with the other datasource plugins; DuckDB
 *    is deliberately NOT registered in the hosted SaaS deploy configs
 *    (deploy/api and deploy/api-staging) because it is file-path based and a
 *    local filesystem path is not a safe multi-tenant datasource. On self-host:
 * ```typescript
 * export default defineConfig({
 *   plugins: [duckdbPlugin({})],
 * });
 * ```
 */

import { z } from "zod";
import { createPlugin, measuredHealthCheck } from "@useatlas/plugin-sdk";
import type { AtlasDatasourcePlugin, PluginDBConnection, PluginHealthResult } from "@useatlas/plugin-sdk";
import { createDuckDBConnection, parseDuckDBUrl } from "./connection";
import type { PluginLogger } from "@useatlas/plugin-sdk";
import { listDuckDBObjects, profileDuckDB } from "./profiler";
import { DUCKDB_FORBIDDEN_PATTERNS } from "./validation";

/**
 * Base object schema for a DuckDB connection. `url` and `path` are both
 * optional here; the requirement that at least one be present is layered on by
 * the strict schema below.
 */
const DuckDBConfigBaseSchema = z.object({
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
  path: z.string().trim().min(1, "Path must not be empty").optional(),
  /** Open in read-only mode. Defaults to true for file databases. */
  readOnly: z.boolean().optional(),
});

/**
 * Strict schema for a fully-specified DuckDB connection. Either a `url` or a
 * `path` is required. Used by `connection.createFromConfig` to validate the
 * decrypted per-(workspace, install) config of a DB-stored datasource (which
 * always carries a url or path) before building the connection.
 */
const DuckDBConnectionConfigSchema = DuckDBConfigBaseSchema.refine(
  (cfg) => cfg.url || cfg.path,
  "Either url or path is required",
);

/**
 * Lenient config-time schema — neither url nor path required so the plugin can
 * be registered as an ADAPTER ONLY: `duckdbPlugin({})` parses, registering the
 * plugin so its `createFromConfig` is available to the datasource bridge for
 * DB-stored per-workspace installs, with no static datasource. This is for
 * self-host parity — DuckDB is not registered in the hosted SaaS configs (see
 * the file header). A `url`/`path`, when supplied, is still validated.
 */
const DuckDBConfigSchema = DuckDBConfigBaseSchema;

export type DuckDBPluginConfig = z.infer<typeof DuckDBConfigSchema>;

/**
 * Build the plugin object from validated config.
 * Exported for direct use with definePlugin() when Zod validation
 * has already been performed externally (e.g. in tests or custom wiring).
 */
export function buildDuckDBPlugin(
  config: DuckDBPluginConfig,
): AtlasDatasourcePlugin<DuckDBPluginConfig> {
  let log: PluginLogger | undefined;

  // When a static url/path is configured the plugin wires a config-defined
  // connection at boot; without one it is registered adapter-only.
  const hasStaticConfig = !!(config.url || config.path);
  const staticUrl = config.url;
  const staticPath = config.path;
  const staticReadOnly = config.readOnly;

  /** Resolve a DuckDBConnectionConfig from a url/path/readOnly triple, matching the build-time logic. */
  const resolveDbConfig = (input: {
    url?: string;
    path?: string;
    readOnly?: boolean;
  }) => {
    const parsed = input.url
      ? parseDuckDBUrl(input.url)
      : { path: input.path as string, readOnly: input.path !== ":memory:" };
    return { ...parsed, readOnly: input.readOnly ?? parsed.readOnly };
  };

  const connection: AtlasDatasourcePlugin<DuckDBPluginConfig>["connection"] = {
    // DB-driven (admin-UI-registered) datasources: build a connection from
    // the per-(workspace, install) config decrypted from `workspace_plugins`,
    // re-validated through the strict schema. Always available — this is the
    // SaaS per-workspace path and the only path in adapter-only mode.
    createFromConfig: (runtimeConfig) => {
      const parsed = DuckDBConnectionConfigSchema.parse(runtimeConfig);
      const dbConfig = resolveDbConfig(parsed);
      const built = createDuckDBConnection({ ...dbConfig, logger: log });
      // #3667 — introspection is a capability OF the built connection, bound to
      // the path/url that built it (the host's unified resolver consumes these;
      // no url/config re-resolution). `parseDuckDBUrl` round-trips a reconstructed
      // `duckdb://<path>` when the config carried a bare `path`. Read-only via the
      // connection's READ_ONLY access mode.
      const introspectUrl = parsed.url ?? `duckdb://${dbConfig.path}`;
      return {
        ...built,
        listObjects: (o) =>
          listDuckDBObjects({ url: introspectUrl, ...(o?.schema !== undefined ? { schema: o.schema } : {}) }),
        profile: (o) =>
          profileDuckDB({
            url: introspectUrl,
            ...(o?.schema !== undefined ? { schema: o.schema } : {}),
            selectedTables: o?.selectedTables,
            prefetchedObjects: o?.prefetchedObjects,
            progress: o?.progress,
            logger: o?.logger,
          }),
      };
    },
    dbType: "duckdb",
    parserDialect: "PostgresQL",
    forbiddenPatterns: DUCKDB_FORBIDDEN_PATTERNS,
    // Introspection (listObjects / profile) is a capability of the BUILT
    // connection (createFromConfig above), bound to the path/url that built it —
    // the one home MCP, the wizard, and the CLI all consume (ADR-0017 / #3670).
    // No connection-namespace profiler exports remain.
  };

  if (hasStaticConfig) {
    // Parse the static config once, inside the create closure so adapter-only
    // mode never calls parseDuckDBUrl on an undefined url/path.
    const dbConfig = resolveDbConfig({
      url: staticUrl,
      path: staticPath,
      readOnly: staticReadOnly,
    });
    connection.create = () => createDuckDBConnection({ ...dbConfig, logger: log });
  }

  return {
    id: "duckdb-datasource",
    types: ["datasource"] as const,
    version: "0.1.0",
    name: "DuckDB DataSource",
    config,

    connection,

    entities: [],

    dialect: [
      "This datasource uses DuckDB SQL dialect.",
      "- DuckDB syntax is similar to PostgreSQL with additional features.",
      "- Use UNNEST() to expand arrays into rows.",
      "- LIST and STRUCT types are natively supported.",
      "- File-reading functions (read_csv_auto, read_parquet, etc.) are blocked for security.",
      "- Use DATE_TRUNC() and DATE_PART() for date operations.",
      "- Use STRING_AGG() for string aggregation.",
      "- Supports window functions, CTEs, and lateral joins.",
      "- In-process engine — no connection pooling needed.",
    ].join("\n"),

    async initialize(ctx) {
      log = ctx.logger;
      if (hasStaticConfig) {
        const dbConfig = resolveDbConfig({
          url: staticUrl,
          path: staticPath,
          readOnly: staticReadOnly,
        });
        const label = dbConfig.path === ":memory:" ? "in-memory" : dbConfig.path;
        ctx.logger.info(`DuckDB datasource plugin initialized (${label})`);
      } else {
        ctx.logger.info(
          "DuckDB datasource plugin registered as adapter-only — per-workspace datasources via Admin → Connections",
        );
      }
    },

    async healthCheck(): Promise<PluginHealthResult> {
      // Adapter-only: no static datasource to probe. The plugin itself is a
      // healthy adapter; per-workspace connections are health-checked by the
      // ConnectionRegistry once installed.
      if (!hasStaticConfig) {
        return { healthy: true, message: "adapter-only: no static datasource configured" };
      }
      const dbConfig = resolveDbConfig({
        url: staticUrl,
        path: staticPath,
        readOnly: staticReadOnly,
      });
      return measuredHealthCheck(async () => {
        let conn: PluginDBConnection | undefined;
        try {
          conn = createDuckDBConnection(dbConfig);
          await conn.query("SELECT 1", 5000);
          return { healthy: true };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log?.warn(`Health check failed: ${message}`);
          return { healthy: false, message };
        } finally {
          if (conn) {
            await conn.close();
          }
        }
      });
    },
  };
}

/**
 * Factory function for use in atlas.config.ts plugins array.
 *
 * @example
 * ```typescript
 * // Static datasource (self-host):
 * plugins: [duckdbPlugin({ url: "duckdb://analytics.duckdb" })]
 * // Adapter-only (SaaS — customers bring their own per workspace):
 * plugins: [duckdbPlugin({})]
 * ```
 */
export const duckdbPlugin = createPlugin({
  configSchema: DuckDBConfigSchema,
  create: buildDuckDBPlugin,
});

export { createDuckDBConnection, parseDuckDBUrl } from "./connection";
export { listDuckDBObjects, profileDuckDB } from "./profiler";
export { DUCKDB_FORBIDDEN_PATTERNS } from "./validation";
