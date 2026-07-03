/**
 * Snowflake DataSource Plugin — reference implementation for @useatlas/plugin-sdk.
 *
 * Assembled via `createDatasourcePlugin` (#4192): the factory owns the
 * static-vs-adapter-only mode branch, the `createFromConfig` wrapper, the
 * initialize logging, and the measured SELECT-1 health check. This module
 * supplies only the Snowflake substance: the schema pair, the connection
 * builder, the introspection bindings, and the read-only advisory warning.
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
import { createDatasourcePlugin } from "@useatlas/plugin-sdk";
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
export const snowflakePlugin = createDatasourcePlugin<
  SnowflakeConfig,
  z.infer<typeof SnowflakeConnectionConfigSchema>
>({
  id: "snowflake-datasource",
  name: "Snowflake DataSource",
  dbType: "snowflake",
  parserDialect: "Snowflake",
  forbiddenPatterns: SNOWFLAKE_FORBIDDEN_PATTERNS,
  configSchema: SnowflakeConfigSchema,
  connectionConfigSchema: SnowflakeConnectionConfigSchema,

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

  // Static mode logs the account only — never credentials embedded in the url.
  // `url!` is provably present: describeStaticTarget only runs in static mode,
  // which the factory's default predicate gates on a non-empty `url`.
  describeStaticTarget: (config) => extractAccount(config.url!),

  buildConnection: (parsed, rt) =>
    createSnowflakeConnection({
      url: parsed.url,
      maxConnections: parsed.maxConnections,
      logger: rt.logger,
    }),

  // #3667 — introspection as a capability of the built connection, bound to
  // the creds that built it (no url/config re-resolution by the host).
  attachIntrospection: (built, { parsed }) => ({
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
  }),

  // Advisory in BOTH modes: Snowflake has no session-level read-only knob, so
  // operators should grant a SELECT-only role for defense-in-depth.
  onInitialize: (ctx) => {
    ctx.logger.warn(
      "Snowflake has no session-level read-only mode — Atlas enforces SELECT-only " +
      "via SQL validation (regex + AST). For defense-in-depth, configure the " +
      "Snowflake connection with a role granted SELECT privileges only " +
      "(e.g. GRANT SELECT ON ALL TABLES IN SCHEMA <schema> TO ROLE atlas_readonly).",
    );
  },
});

/**
 * Build the plugin object from an already-validated config — bypasses the Zod
 * config schema. For direct use when validation has been performed externally
 * (e.g. in tests or custom wiring).
 */
export const buildSnowflakePlugin = snowflakePlugin.build;

export { createSnowflakeConnection, parseSnowflakeURL, extractAccount } from "./connection";
export { listSnowflakeObjects, profileSnowflake } from "./profiler";
export { SNOWFLAKE_FORBIDDEN_PATTERNS } from "./validation";
