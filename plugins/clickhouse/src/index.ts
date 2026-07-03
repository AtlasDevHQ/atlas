/**
 * ClickHouse DataSource Plugin — reference implementation for @useatlas/plugin-sdk.
 *
 * Assembled via `createDatasourcePlugin` (#4192): the factory owns the
 * static-vs-adapter-only mode branch, the `createFromConfig` wrapper, the
 * initialize logging, and the measured SELECT-1 health check. This module
 * supplies only the ClickHouse substance: the schema pair, the connection
 * builder, and the introspection bindings.
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
import { createDatasourcePlugin } from "@useatlas/plugin-sdk";
import {
  createClickHouseConnection,
  extractHost,
} from "./connection";
import { listClickHouseObjects, profileClickHouse } from "./profiler";
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
export const clickhousePlugin = createDatasourcePlugin<
  ClickHouseConfig,
  z.infer<typeof ClickHouseConnectionConfigSchema>
>({
  id: "clickhouse-datasource",
  name: "ClickHouse DataSource",
  dbType: "clickhouse",
  parserDialect: "PostgresQL", // closest match in node-sql-parser
  forbiddenPatterns: CLICKHOUSE_FORBIDDEN_PATTERNS,
  configSchema: ClickHouseConfigSchema,
  connectionConfigSchema: ClickHouseConnectionConfigSchema,

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

  // Static mode logs the host only — never credentials embedded in the url.
  // `url!` is provably present: describeStaticTarget only runs in static mode,
  // which the factory's default predicate gates on a non-empty `url`.
  describeStaticTarget: (config) => extractHost(config.url!),

  // ClickHouse HTTP transport is stateless — safe to build per call (the
  // factory default), so `connection.create()` and the health probe each get a
  // fresh connection. Pool-based databases would set `cacheStaticConnection`.
  buildConnection: (parsed, rt) =>
    createClickHouseConnection({
      url: parsed.url,
      database: parsed.database,
      logger: rt.logger,
    }),

  // #3667 — introspection is a capability OF the built connection, bound to
  // the creds that built it (the host's unified resolver consumes these; no
  // url/config re-resolution). Read-only via the connection's query path.
  attachIntrospection: (built, { parsed }) => ({
    ...built,
    listObjects: (o) => listClickHouseObjects({ url: parsed.url, schema: o?.schema ?? parsed.database }),
    profile: (o) =>
      profileClickHouse({
        url: parsed.url,
        schema: o?.schema ?? parsed.database,
        selectedTables: o?.selectedTables,
        prefetchedObjects: o?.prefetchedObjects,
        progress: o?.progress,
        logger: o?.logger,
      }),
  }),
});

/**
 * Build the plugin object from an already-validated config — bypasses the Zod
 * config schema. For direct use when validation has been performed externally
 * (e.g. in tests or custom wiring).
 */
export const buildClickHousePlugin = clickhousePlugin.build;

export { createClickHouseConnection, rewriteClickHouseUrl, extractHost } from "./connection";
export { listClickHouseObjects, profileClickHouse } from "./profiler";
export { CLICKHOUSE_FORBIDDEN_PATTERNS } from "./validation";
