/**
 * DuckDB DataSource Plugin — reference implementation for @useatlas/plugin-sdk.
 *
 * Wraps the in-process DuckDB adapter extracted from
 * packages/api/src/lib/db/duckdb.ts. Assembled via `createDatasourcePlugin`
 * (#4192): the factory owns the static-vs-adapter-only mode branch, the
 * `createFromConfig` wrapper, the initialize logging, and the measured
 * SELECT-1 health check. This module supplies only the DuckDB substance: the
 * schema pair, the url/path resolution, and the introspection bindings.
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
 *    is deliberately NOT registered in the hosted SaaS deploy config
 *    (deploy/api — staging runs the same shared config) because it is file-path
 *    based and a
 *    local filesystem path is not a safe multi-tenant datasource. On self-host:
 * ```typescript
 * export default defineConfig({
 *   plugins: [duckdbPlugin({})],
 * });
 * ```
 */

import { z } from "zod";
import { createDatasourcePlugin } from "@useatlas/plugin-sdk";
import { createDuckDBConnection, parseDuckDBUrl } from "./connection";
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

/** Resolve a DuckDBConnectionConfig from a url/path/readOnly triple. Pure — safe to call per use. */
function resolveDbConfig(input: {
  url?: string;
  path?: string;
  readOnly?: boolean;
}) {
  const parsed = input.url
    ? parseDuckDBUrl(input.url)
    : { path: input.path as string, readOnly: input.path !== ":memory:" };
  return { ...parsed, readOnly: input.readOnly ?? parsed.readOnly };
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
export const duckdbPlugin = createDatasourcePlugin<
  DuckDBPluginConfig,
  z.infer<typeof DuckDBConnectionConfigSchema>
>({
  id: "duckdb-datasource",
  name: "DuckDB DataSource",
  dbType: "duckdb",
  parserDialect: "PostgresQL",
  forbiddenPatterns: DUCKDB_FORBIDDEN_PATTERNS,
  configSchema: DuckDBConfigSchema,
  connectionConfigSchema: DuckDBConnectionConfigSchema,

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

  // A static datasource is defined by a url OR a bare path — the default
  // url-only predicate would demote path-configured deploys to adapter-only.
  hasStaticConfig: (config) => !!(config.url || config.path),

  // Resolution happens here (never on the adapter-only build path), so an
  // adapter-only registration never calls parseDuckDBUrl on undefined input.
  describeStaticTarget: (config) => {
    const dbConfig = resolveDbConfig(config);
    return dbConfig.path === ":memory:" ? "in-memory" : dbConfig.path;
  },

  buildConnection: (parsed, rt) =>
    createDuckDBConnection({ ...resolveDbConfig(parsed), logger: rt.logger }),

  // #3667 — introspection is a capability OF the built connection, bound to
  // the path/url that built it (the host's unified resolver consumes these;
  // no url/config re-resolution). `parseDuckDBUrl` round-trips a reconstructed
  // `duckdb://<path>` when the config carried a bare `path`. Read-only via the
  // connection's READ_ONLY access mode.
  attachIntrospection: (built, { parsed }) => {
    const introspectUrl = parsed.url ?? `duckdb://${resolveDbConfig(parsed).path}`;
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
});

/**
 * Build the plugin object from an already-validated config — bypasses the Zod
 * config schema. For direct use when validation has been performed externally
 * (e.g. in tests or custom wiring).
 */
export const buildDuckDBPlugin = duckdbPlugin.build;

export { createDuckDBConnection, parseDuckDBUrl } from "./connection";
export { listDuckDBObjects, profileDuckDB } from "./profiler";
export { DUCKDB_FORBIDDEN_PATTERNS } from "./validation";
