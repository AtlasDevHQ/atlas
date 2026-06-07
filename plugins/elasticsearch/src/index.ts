/**
 * Elasticsearch / OpenSearch DataSource Plugin — connection foundation.
 *
 * A single unified plugin that connects an Elasticsearch cluster as a read-only
 * Atlas datasource over a thin `fetch`-based HTTP client (no official SDK). This
 * slice (#3261) ships the connection layer only: `elasticsearch://` URL +
 * API-key auth, an authenticated cluster-info/ping health check, and
 * ConnectionRegistry registration via the standard datasource-plugin shape (the
 * host's `wireDatasourcePlugins` calls `connection.create()` + `registerDirect`,
 * exactly as it does for the Salesforce plugin). Query surfaces, the remaining
 * auth modes, the OpenSearch engine, and `atlas init` profiling are later slices.
 *
 * Usage in atlas.config.ts:
 * ```typescript
 * import { defineConfig } from "@atlas/api/lib/config";
 * import { elasticsearchPlugin } from "@useatlas/elasticsearch";
 *
 * export default defineConfig({
 *   plugins: [
 *     elasticsearchPlugin({
 *       url: "elasticsearch://my-deployment.es.io:9243",
 *       apiKey: process.env.ES_API_KEY!,
 *     }),
 *   ],
 * });
 * ```
 */

import { z } from "zod";
import { createPlugin } from "@useatlas/plugin-sdk";
import type {
  AtlasDatasourcePlugin,
  ConfigSchemaField,
  PluginHealthResult,
  PluginLogger,
} from "@useatlas/plugin-sdk";
import {
  createElasticsearchConnection,
  parseElasticsearchUrl,
  extractHost,
  scrubElasticsearchError,
  ELASTICSEARCH_PARSER_DIALECT,
  ELASTICSEARCH_FORBIDDEN_PATTERNS,
} from "./connection";
import type { ElasticsearchConnection, ElasticsearchPluginConfig } from "./connection";

/**
 * ES SQL dialect guidance injected into the agent system prompt (under
 * "## Additional SQL Dialect Notes"). ES SQL is standard SQL over a single
 * index-as-table via the `executeSQL` tool — these notes steer the agent away
 * from the few places it diverges (no cross-index JOINs, double-quote index
 * names with special characters).
 */
const ELASTICSEARCH_DIALECT_GUIDE = [
  "This datasource is Elasticsearch SQL (the cluster `/_sql` API), queried with the `executeSQL` tool.",
  "- Each Elasticsearch index is a table — `SELECT ... FROM <index>`. One index per query: there are NO JOINs across indices.",
  "- Quote index names containing `-`, `.`, or `:` with double quotes, e.g. `SELECT * FROM \"logs-2024.01.01\"`.",
  "- Supported: WHERE, GROUP BY, HAVING, ORDER BY, LIMIT, and the aggregates COUNT, SUM, AVG, MIN, MAX (incl. COUNT(DISTINCT ...)).",
  "- Standard predicates work: =, <, >, IN (...), BETWEEN, LIKE, IS NULL.",
  "- A nested field is addressed by its dotted path (e.g. `geo.dest`).",
  "- Read-only: only SELECT is allowed. SHOW/DESCRIBE and any DML/DDL are rejected.",
].join("\n");

/**
 * Strict schema for a fully-specified Elasticsearch connection — both `url` and
 * `apiKey` are required. Used by `connection.createFromConfig` to validate the
 * decrypted per-(workspace, install) config of a DB-stored datasource (which
 * always carries both) before building the connection.
 */
const ElasticsearchConnectionConfigSchema = z.object({
  /** Elasticsearch connection URL (elasticsearch://host:9200). */
  url: z
    .string()
    .min(1, "Elasticsearch URL must not be empty")
    .refine(
      (u) => u.startsWith("elasticsearch://"),
      "URL must start with elasticsearch://",
    )
    .superRefine((u, ctx) => {
      try {
        parseElasticsearchUrl(u);
      } catch (err) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }),
  /** Base64-encoded API key. Secret — encrypted at rest, masked in admin UI. */
  apiKey: z.string().min(1, "Elasticsearch apiKey must not be empty"),
  /** Optional. Surfaced to the agent in the system prompt. */
  description: z.string().optional(),
});

/**
 * Lenient config-time schema — every field optional so the plugin can be
 * registered as an ADAPTER ONLY: `elasticsearchPlugin({})` parses, registering
 * the plugin so its `createFromConfig` is available to the datasource bridge for
 * DB-stored per-workspace installs (the SaaS model), with no static datasource.
 * A `url` / `apiKey`, when supplied, is still validated.
 */
const ElasticsearchConfigSchema = ElasticsearchConnectionConfigSchema.partial();

export type ElasticsearchConfig = z.infer<typeof ElasticsearchConfigSchema>;

// Compile-time guard: the STRICT schema's inferred config and the connection
// module's raw config shape must stay structurally identical, so adding a field
// to one without the other fails the build instead of drifting silently.
type StrictElasticsearchConfig = z.infer<typeof ElasticsearchConnectionConfigSchema>;
type _ConfigsAligned = [StrictElasticsearchConfig] extends [ElasticsearchPluginConfig]
  ? [ElasticsearchPluginConfig] extends [StrictElasticsearchConfig]
    ? true
    : never
  : never;
const _configsAligned: _ConfigsAligned = true;
void _configsAligned;

/**
 * Build the plugin object from validated config.
 * Exported for direct use with definePlugin() when Zod validation
 * has already been performed externally (e.g. in tests or custom wiring).
 */
export function buildElasticsearchPlugin(
  config: ElasticsearchConfig,
): AtlasDatasourcePlugin<ElasticsearchConfig> {
  let cachedConn: ElasticsearchConnection | undefined;
  let log: PluginLogger | undefined;

  // A static config-defined ES datasource (self-host / operator-baked) needs
  // both a url and an apiKey. Without them the plugin is registered ADAPTER ONLY
  // (the SaaS per-workspace model): no static connection, customers add their
  // own per workspace via Admin → Connections, and the datasource bridge builds
  // each connection via `createFromConfig`.
  const staticConfig: ElasticsearchPluginConfig | undefined =
    config.url && config.apiKey
      ? {
          url: config.url,
          apiKey: config.apiKey,
          ...(config.description ? { description: config.description } : {}),
        }
      : undefined;

  /** Cached singleton so health checks and teardown share one client (static mode). */
  function getOrCreateConnection(): ElasticsearchConnection {
    if (!staticConfig) {
      throw new Error(
        "Elasticsearch plugin is adapter-only — no static datasource configured",
      );
    }
    if (!cachedConn) {
      cachedConn = createElasticsearchConnection(staticConfig, { logger: log });
    }
    return cachedConn;
  }

  const connection: AtlasDatasourcePlugin<ElasticsearchConfig>["connection"] = {
    // DB-driven (admin-UI-registered) datasources: build a connection from the
    // per-(workspace, install) config decrypted from `workspace_plugins`,
    // re-validated through the strict schema. Always available — this is the
    // SaaS per-workspace path and the only path in adapter-only mode.
    createFromConfig: (runtimeConfig) => {
      const parsed = ElasticsearchConnectionConfigSchema.parse(runtimeConfig);
      return createElasticsearchConnection(parsed, { logger: log });
    },
    dbType: "elasticsearch",
    // ES SQL is real SQL, so there is intentionally NO custom `validate`: the
    // host's standard 4-layer pipeline (regex guard → AST parse → index/table
    // whitelist → auto-LIMIT + timeout) applies unchanged. We only tell it
    // which grammar to parse with and add ES-specific guards on top of the
    // base DML/DDL regex.
    parserDialect: ELASTICSEARCH_PARSER_DIALECT,
    forbiddenPatterns: ELASTICSEARCH_FORBIDDEN_PATTERNS,
  };

  if (staticConfig) {
    connection.create = () => getOrCreateConnection();
  }

  return {
    id: "elasticsearch-datasource",
    types: ["datasource"] as const,
    version: "0.1.0",
    name: "Elasticsearch DataSource",
    config,

    connection,

    entities: [],

    dialect: ELASTICSEARCH_DIALECT_GUIDE,

    /**
     * Serializable config schema for the admin install form + the secret
     * encryption flow. `apiKey` is `secret: true` so `encryptSecretFields`
     * encrypts it at rest and the admin mask/restore flow applies. `url` carries
     * no credential, so it is not secret.
     */
    getConfigSchema(): ConfigSchemaField[] {
      return [
        {
          key: "url",
          type: "string",
          label: "Connection URL",
          required: true,
          description:
            "elasticsearch://host:9200 — HTTPS by default; append ?ssl=false for a plaintext local cluster.",
        },
        {
          key: "apiKey",
          type: "string",
          label: "API Key",
          required: true,
          secret: true,
          description:
            "Base64-encoded Elasticsearch API key, sent as `Authorization: ApiKey`. Encrypted at rest.",
        },
        {
          key: "description",
          type: "string",
          label: "Description",
          description: "Optional. Shown in the agent system prompt.",
        },
      ];
    },

    async initialize(ctx) {
      log = ctx.logger;
      if (staticConfig) {
        ctx.logger.info(
          `Elasticsearch datasource plugin initialized (${extractHost(staticConfig.url)})`,
        );
      } else {
        ctx.logger.info(
          "Elasticsearch datasource plugin registered as adapter-only — per-workspace datasources via Admin → Connections",
        );
      }
    },

    async healthCheck(): Promise<PluginHealthResult> {
      // Adapter-only: no static datasource to probe. The plugin itself is a
      // healthy adapter; per-workspace connections are health-checked by the
      // ConnectionRegistry once installed.
      if (!staticConfig) {
        return { healthy: true, message: "adapter-only: no static datasource configured" };
      }
      const start = performance.now();
      try {
        // The client owns the timeout/abort (it rejects with a clear "timed out"
        // message at 5000ms), so awaiting it directly avoids the orphaned-promise
        // / unhandled-rejection hazard of racing it against an outer setTimeout.
        await getOrCreateConnection().ping(5000);
        return { healthy: true, latencyMs: Math.round(performance.now() - start) };
      } catch (err) {
        const message = scrubElasticsearchError(err, staticConfig.apiKey);
        log?.warn(`Elasticsearch health check failed: ${message}`);
        return {
          healthy: false,
          message,
          latencyMs: Math.round(performance.now() - start),
        };
      }
    },

    async teardown(): Promise<void> {
      if (cachedConn) {
        try {
          await cachedConn.close();
        } catch (err) {
          log?.warn(
            { err: err instanceof Error ? err.message : String(err) },
            "Failed to close Elasticsearch connection during teardown",
          );
        }
        cachedConn = undefined;
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
 * plugins: [elasticsearchPlugin({ url: "elasticsearch://host:9200", apiKey: "..." })]
 * ```
 */
export const elasticsearchPlugin = createPlugin({
  configSchema: ElasticsearchConfigSchema,
  create: buildElasticsearchPlugin,
});

export {
  parseElasticsearchUrl,
  resolveElasticsearchConfig,
  extractHost,
  createElasticsearchClient,
  createElasticsearchConnection,
  scrubElasticsearchError,
  SENSITIVE_PATTERNS,
  normalizeSqlPages,
  extractEsSqlErrorMessage,
  ELASTICSEARCH_PARSER_DIALECT,
  ELASTICSEARCH_FORBIDDEN_PATTERNS,
  DEFAULT_FETCH_SIZE,
  DEFAULT_MAX_ROWS,
} from "./connection";
export {
  mapEsFieldType,
  flattenMapping,
  indexToEntityName,
  isSystemIndex,
  mappingToEntity,
  mappingsToEntities,
} from "./mapping";
export type {
  EsProperty,
  EsIndexMapping,
  EsMappingResponse,
  EsDimensionType,
  FlatEsField,
  EsDimension,
  EsEntityDoc,
} from "./mapping";
export type {
  ElasticsearchEngine,
  ParsedElasticsearchUrl,
  ElasticsearchApiKeyAuth,
  ElasticsearchAuthDescriptor,
  ElasticsearchPluginConfig,
  ResolvedElasticsearchConfig,
  ElasticsearchConnection,
  ElasticsearchClient,
  ElasticsearchClientOptions,
  ClusterInfo,
  ElasticsearchSqlColumn,
  ElasticsearchSqlResponse,
  ElasticsearchSqlQueryOptions,
} from "./connection";
