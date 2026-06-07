/**
 * Elasticsearch / OpenSearch DataSource Plugin — connection foundation.
 *
 * A single unified plugin that connects an Elasticsearch OR OpenSearch cluster as
 * a read-only Atlas datasource over a thin `fetch`-based HTTP client (no official
 * SDK). It ships: the connection layer (authenticated cluster-info/ping health
 * check + ConnectionRegistry registration via the standard datasource-plugin
 * shape — the host's `wireDatasourcePlugins` calls `connection.create()` +
 * `registerDirect`, as for the Salesforce plugin); three auth modes — API key,
 * HTTP Basic, AWS SigV4 — plus an Elastic Cloud ID connection target
 * (#3263–#3265); both engines (#3266, `/_sql` vs `/_plugins/_sql`); the SQL query
 * surface via the standard `executeSQL` tool; and the `atlas init` `_mapping`
 * profiler. The dedicated Query DSL tool (#3267) is a later slice.
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
  decodeCloudId,
  resolveElasticsearchConfig,
  isCompleteConnectionConfig,
  collectConfigSecrets,
  extractHost,
  scrubElasticsearchError,
  ELASTICSEARCH_PARSER_DIALECT,
  ELASTICSEARCH_FORBIDDEN_PATTERNS,
} from "./connection";
import type { ElasticsearchConnection, ElasticsearchPluginConfig } from "./connection";
import { createQueryElasticsearchTool } from "./tool";

/**
 * ES SQL dialect guidance injected into the agent system prompt (under
 * "## Additional SQL Dialect Notes"). ES SQL is standard SQL over a single
 * index-as-table via the `executeSQL` tool — these notes steer the agent away
 * from the few places it diverges (no cross-index JOINs, double-quote index
 * names with special characters).
 */
const ELASTICSEARCH_SQL_GUIDE = [
  "This datasource is Elasticsearch SQL (the cluster `/_sql` API), queried with the `executeSQL` tool.",
  "- Each Elasticsearch index is a table — `SELECT ... FROM <index>`. One index per query: there are NO JOINs across indices.",
  "- Quote index names containing `-`, `.`, or `:` with double quotes, e.g. `SELECT * FROM \"logs-2024.01.01\"`.",
  "- Supported: WHERE, GROUP BY, HAVING, ORDER BY, LIMIT, and the aggregates COUNT, SUM, AVG, MIN, MAX (incl. COUNT(DISTINCT ...)).",
  "- Standard predicates work: =, <, >, IN (...), BETWEEN, LIKE, IS NULL.",
  "- A nested field is addressed by its dotted path (e.g. `geo.dest`).",
  "- Read-only: only SELECT is allowed. SHOW/DESCRIBE and any DML/DDL are rejected.",
].join("\n");

/**
 * Query DSL guidance — injected ONLY in static-datasource mode, where the
 * dedicated `queryElasticsearch` tool is registered (see `initialize`). Tells the
 * agent WHEN to reach for the DSL surface instead of SQL, and the read-only rails.
 */
const ELASTICSEARCH_DSL_GUIDE = [
  "",
  "Elasticsearch also has a Query DSL surface via the `queryElasticsearch` tool. Prefer SQL (`executeSQL`) for ordinary tabular/aggregate questions; reach for `queryElasticsearch` when SQL can't express the question:",
  "- Full-text / relevance ranking — `match`, `multi_match`, `match_phrase`, `query_string` ranked by `_score`.",
  "- Deeply-nested or multi-level aggregations — `terms` within `terms`, `date_histogram` with sub-aggregations, `percentiles`, `cardinality`.",
  "- Geo, span, and other DSL-only query types.",
  "- Pass `index` (one index/alias from the semantic layer — no wildcards) and a `body` (the DSL). For aggregation-only questions set `\"size\": 0`.",
  "- Read-only: only `_search` and `_count` are allowed; writes, `_bulk`, `_update*`, `_delete*`, and mutating scripts are rejected.",
].join("\n");

/** Compose the dialect guidance. The DSL section is added only when the dedicated
 *  `queryElasticsearch` tool is registered (static-datasource mode). */
function buildDialectGuide(hasStaticConfig: boolean): string {
  return hasStaticConfig
    ? `${ELASTICSEARCH_SQL_GUIDE}\n${ELASTICSEARCH_DSL_GUIDE}`
    : ELASTICSEARCH_SQL_GUIDE;
}

/**
 * Per-field shapes for the Elasticsearch config. Every field is optional: the
 * connection target is `url` **or** `cloudId`, and the auth mode is selected from
 * whichever credentials are present (API key / Basic / SigV4). Per-field rules
 * (non-empty, valid URL scheme, engine enum) are enforced here; the cross-field
 * "is this a complete, resolvable connection" rule is layered on by the strict
 * schema below via {@link resolveElasticsearchConfig}.
 */
const ElasticsearchFieldsSchema = z.object({
  /** Connection URL (`elasticsearch://` or `opensearch://`). Alternative to `cloudId`. */
  url: z
    .string()
    .min(1, "Elasticsearch URL must not be empty")
    .refine(
      (u) => u.startsWith("elasticsearch://") || u.startsWith("opensearch://"),
      "URL must start with elasticsearch:// or opensearch://",
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
    })
    .optional(),
  /** Elastic Cloud ID (`name:base64`) — decoded to the cluster endpoint. Validated
   *  at the field level (like `url`) so a malformed Cloud ID fails fast at config
   *  load, not lazily at first connection. */
  cloudId: z
    .string()
    .min(1, "cloudId must not be empty")
    .superRefine((c, ctx) => {
      try {
        decodeCloudId(c);
      } catch (err) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    })
    .optional(),
  /** Explicit engine override; wins over the URL scheme. */
  engine: z.enum(["elasticsearch", "opensearch"]).optional(),
  /** API-key auth. Base64-encoded key. Secret — encrypted at rest. */
  apiKey: z.string().min(1, "Elasticsearch apiKey must not be empty").optional(),
  /** HTTP Basic username. */
  username: z.string().min(1, "username must not be empty").optional(),
  /** HTTP Basic password. Secret — encrypted at rest. */
  password: z.string().min(1, "password must not be empty").optional(),
  /** AWS region — selects SigV4 auth (e.g. `us-east-1`). */
  awsRegion: z.string().min(1, "awsRegion must not be empty").optional(),
  /** AWS access key id (explicit; else the ambient AWS env chain). */
  awsAccessKeyId: z.string().min(1, "awsAccessKeyId must not be empty").optional(),
  /** AWS secret access key (explicit; else the ambient chain). Secret. */
  awsSecretAccessKey: z.string().min(1, "awsSecretAccessKey must not be empty").optional(),
  /** AWS session token (explicit; else the ambient chain). Secret. */
  awsSessionToken: z.string().min(1, "awsSessionToken must not be empty").optional(),
  /** AWS service code for SigV4 (defaults to `es`). */
  awsService: z.string().min(1, "awsService must not be empty").optional(),
  /** Optional. Surfaced to the agent in the system prompt. */
  description: z.string().optional(),
});

/**
 * Strict schema for a fully-specified connection — used by
 * `connection.createFromConfig` to validate the decrypted per-(workspace,
 * install) config of a DB-stored datasource before building the connection. On
 * top of the per-field rules it requires the config to resolve to a complete,
 * usable connection (an endpoint source AND a usable auth mode), delegating to
 * the single {@link resolveElasticsearchConfig} resolver so validation and
 * runtime never disagree. The error message never echoes a secret.
 */
const ElasticsearchConnectionConfigSchema = ElasticsearchFieldsSchema.superRefine(
  (cfg, ctx) => {
    try {
      resolveElasticsearchConfig(cfg as ElasticsearchPluginConfig);
    } catch (err) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  },
);

/**
 * Lenient config-time schema — every field optional and NO completeness check,
 * so the plugin can be registered as an ADAPTER ONLY: `elasticsearchPlugin({})`
 * parses, registering the plugin so its `createFromConfig` is available to the
 * datasource bridge for DB-stored per-workspace installs (the SaaS model), with
 * no static datasource. Any field supplied is still shape-validated.
 */
const ElasticsearchConfigSchema = ElasticsearchFieldsSchema;

export type ElasticsearchConfig = z.infer<typeof ElasticsearchConfigSchema>;

// Compile-time guard: the field schema's inferred config and the connection
// module's raw config shape must keep the same field names + value types, so
// adding a field to one without the other fails the build instead of drifting
// silently. (`exactOptionalPropertyTypes` is off, so the optional-vs-required
// modifier itself is not compared — only names and types.)
type StrictElasticsearchConfig = z.infer<typeof ElasticsearchFieldsSchema>;
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

  // This plugin's static connection registers in the ConnectionRegistry under
  // its plugin id (wiring.ts `registerDirect(plugin.id, …)`), which is also the
  // connectionId `getWhitelistedTables` / `executeSQL` key the index whitelist
  // on. The DSL tool MUST use the same id so its membership whitelist agrees
  // with the SQL path.
  const DATASOURCE_ID = "elasticsearch-datasource";

  // A static config-defined ES datasource (self-host / operator-baked) needs an
  // endpoint source (`url`/`cloudId`) AND an auth signal (apiKey / username+
  // password / awsRegion). Without a complete config the plugin is registered
  // ADAPTER ONLY (the SaaS per-workspace model): no static connection, customers
  // add their own per workspace via Admin → Connections, and the datasource
  // bridge builds each connection via `createFromConfig`.
  const staticConfig: ElasticsearchPluginConfig | undefined = isCompleteConnectionConfig(
    config,
  )
    ? config
    : undefined;

  /** Cached singleton so health checks and teardown share one client (static mode). */
  function getOrCreateConnection(): ElasticsearchConnection {
    if (!staticConfig) {
      throw new Error(
        "Elasticsearch plugin is adapter-only — no static datasource configured",
      );
    }
    if (!cachedConn) {
      // Static (operator-baked, self-hosted) datasource — SigV4 MAY use the
      // ambient AWS env chain, like any other process.env read in atlas.config.ts.
      cachedConn = createElasticsearchConnection(staticConfig, {
        logger: log,
        allowAmbientAwsCreds: true,
      });
    }
    return cachedConn;
  }

  const connection: AtlasDatasourcePlugin<ElasticsearchConfig>["connection"] = {
    // DB-driven (admin-UI-registered) datasources: build a connection from the
    // per-(workspace, install) config decrypted from `workspace_plugins`,
    // re-validated through the strict schema. Always available — this is the
    // SaaS per-workspace path and the only path in adapter-only mode.
    //
    // `allowAmbientAwsCreds` is intentionally NOT set: a stored per-workspace
    // SigV4 datasource must carry its own explicit, encrypted keys — it must
    // never sign with the operator's ambient AWS env on a multi-tenant deploy
    // (CLAUDE.md: per-tenant creds never fall back to operator env vars, #2850).
    // The strict schema's completeness check runs the same env-less resolver, so
    // a credential-less SigV4 config is rejected at validation, not silently.
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
    id: DATASOURCE_ID,
    types: ["datasource"] as const,
    version: "0.1.0",
    name: "Elasticsearch DataSource",
    config,

    connection,

    entities: [],

    dialect: buildDialectGuide(Boolean(staticConfig)),

    /**
     * Serializable config schema for the admin install form + the secret
     * encryption flow. The `secret: true` fields (`apiKey`, `password`,
     * `awsSecretAccessKey`, `awsSessionToken`) drive `encryptSecretFields` so
     * they land encrypted at rest and the admin mask/restore flow applies; `url`
     * and the AWS region/key-id/service carry no credential, so they are not
     * secret. The form offers all three auth modes (API key / HTTP Basic / AWS
     * SigV4) — supply exactly one mode's fields. Engine is auto-detected from the
     * URL scheme (`opensearch://`) and overridable here.
     *
     * Kept in lockstep with the built-in datasource catalog row
     * (`db/seed-builtin-datasource-catalog.ts` + migration `0125`) — the admin
     * form-install handler reads the catalog's `config_schema` to decide which
     * fields to encrypt. Cloud ID is an `atlas.config.ts`-only convenience and
     * intentionally not a form field.
     */
    getConfigSchema(): ConfigSchemaField[] {
      return [
        {
          key: "url",
          type: "string",
          label: "Connection URL",
          required: true,
          description:
            "elasticsearch://host:9200 or opensearch://host:9200 — HTTPS by default; append ?ssl=false for a plaintext local cluster.",
        },
        {
          key: "engine",
          type: "select",
          label: "Engine",
          options: ["elasticsearch", "opensearch"],
          description:
            "Optional. Overrides the engine inferred from the URL scheme (defaults to elasticsearch).",
        },
        {
          key: "apiKey",
          type: "string",
          label: "API Key",
          secret: true,
          description:
            "API-key auth: Base64-encoded API key, sent as `Authorization: ApiKey`. Encrypted at rest.",
        },
        {
          key: "username",
          type: "string",
          label: "Username",
          description: "HTTP Basic auth: username (pair with Password).",
        },
        {
          key: "password",
          type: "string",
          label: "Password",
          secret: true,
          description: "HTTP Basic auth: password. Encrypted at rest.",
        },
        {
          key: "awsRegion",
          type: "string",
          label: "AWS Region",
          description:
            "AWS SigV4 (Amazon OpenSearch Service): region, e.g. us-east-1. Setting this selects SigV4 signing.",
        },
        {
          key: "awsAccessKeyId",
          type: "string",
          label: "AWS Access Key ID",
          description:
            "AWS SigV4: access key id. Optional — falls back to the AWS_ACCESS_KEY_ID environment variable.",
        },
        {
          key: "awsSecretAccessKey",
          type: "string",
          label: "AWS Secret Access Key",
          secret: true,
          description:
            "AWS SigV4: secret access key. Optional — falls back to AWS_SECRET_ACCESS_KEY. Encrypted at rest.",
        },
        {
          key: "awsSessionToken",
          type: "string",
          label: "AWS Session Token",
          secret: true,
          description:
            "AWS SigV4: session token for temporary credentials. Optional — falls back to AWS_SESSION_TOKEN. Encrypted at rest.",
        },
        {
          key: "awsService",
          type: "string",
          label: "AWS Service",
          description: "AWS SigV4: service code to sign with. Defaults to `es`.",
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
        // Log a non-secret target identifier (host, or "Elastic Cloud" for a
        // Cloud ID) — never a credential.
        const target = staticConfig.url
          ? extractHost(staticConfig.url)
          : staticConfig.cloudId
            ? "Elastic Cloud (cloud id)"
            : "(unknown)";
        ctx.logger.info(`Elasticsearch datasource plugin initialized (${target})`);
      } else {
        ctx.logger.info(
          "Elasticsearch datasource plugin registered as adapter-only — per-workspace datasources via Admin → Connections",
        );
      }

      // Register the queryElasticsearch DSL tool ONLY in static-datasource mode.
      // The tool is hardwired to the static connection, so in adapter-only mode
      // it would throw on every call. SaaS per-workspace Elasticsearch
      // datasources are queried via the standard `executeSQL` (ES SQL) path,
      // routed through the bridge-built connection. (Per-workspace DSL routing is
      // a later slice — see #3269/#3271.)
      if (staticConfig) {
        const esTool = createQueryElasticsearchTool({
          getConnection: () => getOrCreateConnection(),
          // The index MEMBERSHIP whitelist is the semantic layer's index names
          // for this connection — `ctx.connections.tables(id)`, the same
          // filesystem whitelist `executeSQL` validates against in self-host /
          // static mode. So the DSL tool and the SQL surface enforce the
          // identical per-index boundary (#3307). (This tool is static-only;
          // SaaS per-workspace ES is queried over the SQL path.)
          //
          // `ctx.connections.list()` would be wrong here — it returns CONNECTION
          // IDs, not index names, so it can never match a real index like
          // "flights". A legitimately-empty semantic layer returns `[]` and
          // `validateIndexAccess` falls back to its always-on structural rails
          // (no wildcards / _all / system indices). A semantic-layer scan
          // FAILURE instead THROWS (#3243) — the tool catches it and fails
          // CLOSED rather than widening to structural-only (#3313).
          getWhitelist: () => new Set(ctx.connections.tables(DATASOURCE_ID)),
          logger: ctx.logger,
        });

        ctx.tools.register({
          name: "queryElasticsearch",
          description: "Execute a read-only Elasticsearch Query DSL request (full-text / aggregations)",
          tool: esTool,
        });

        // One-time operator warning (#3313): a query tool registered against an
        // empty whitelist runs in STRUCTURAL-ONLY mode — any explicitly-named,
        // non-system index the credential can read is queryable. Name the
        // consequence so operators know to add entity YAMLs. A scan FAILURE is a
        // different situation: `tables()` throws, and the tool fails closed at
        // query time (logged there), so the catch below only flags that case.
        try {
          if (ctx.connections.tables(DATASOURCE_ID).length === 0) {
            ctx.logger.warn(
              "queryElasticsearch registered with an empty semantic-layer whitelist — running in STRUCTURAL-ONLY mode: any explicitly-named, non-system index the credential can read is queryable. Add entity YAMLs to enforce a per-index allow-list.",
            );
          }
        } catch (err) {
          ctx.logger.warn(
            `queryElasticsearch: semantic-layer scan failed at registration — DSL queries will fail closed until it recovers (${err instanceof Error ? err.message : String(err)}).`,
          );
        }
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
        const message = scrubElasticsearchError(err, collectConfigSecrets(staticConfig));
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
  resolveAuth,
  decodeCloudId,
  isCompleteConnectionConfig,
  collectAuthSecrets,
  collectConfigSecrets,
  engineSqlProfile,
  parseSqlPage,
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
  DEFAULT_AWS_SERVICE,
} from "./connection";
export {
  deriveSigningKey,
  buildCanonicalRequest,
  sigV4SignHeaders,
  formatAmzDate,
  EMPTY_PAYLOAD_SHA256,
} from "./sigv4";
export type { SigV4SignInput, SignedHeaderInput } from "./sigv4";
export { createQueryElasticsearchTool } from "./tool";
export {
  validateEsDslRequest,
  validateIndexAccess,
  isReadEndpoint,
  normalizeDslResponse,
  applyDslSafeguards,
  flattenSource,
  isPlainObject,
  ES_READ_ENDPOINTS,
  DEFAULT_DSL_MAX_SIZE,
  DEFAULT_DSL_TERMINATE_AFTER,
} from "./dsl";
export type {
  EsDslRequest,
  EsDslValidationResult,
  DslSafeguardLimits,
} from "./dsl";
export {
  mapEsFieldType,
  flattenMapping,
  indexToEntityName,
  isSystemIndex,
  mappingToEntity,
  mappingsToEntities,
  parseAliases,
  parseDataStreams,
  indexPatternBase,
  detectIndexPatterns,
  buildLogicalEntity,
  mappingsToLogicalEntities,
  entityFileSlug,
} from "./mapping";
export type {
  EsProperty,
  EsIndexMapping,
  EsMappingResponse,
  EsAliasIndexEntry,
  EsAliasResponse,
  EsDataStreamEntry,
  EsDataStreamResponse,
  EsLogicalKind,
  LogicalProfilingInput,
  EsDimensionType,
  FlatEsField,
  EsDimension,
  EsEntityDoc,
} from "./mapping";
export type {
  ElasticsearchEngine,
  ParsedElasticsearchUrl,
  ElasticsearchApiKeyAuth,
  ElasticsearchBasicAuth,
  ElasticsearchSigV4Auth,
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
  ElasticsearchDslEndpoint,
  ElasticsearchDslQueryOptions,
  ResolveAuthOptions,
} from "./connection";
