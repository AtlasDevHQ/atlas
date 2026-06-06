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
} from "./connection";
import type { ElasticsearchConnection } from "./connection";

const ElasticsearchConfigSchema = z.object({
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

export type ElasticsearchConfig = z.infer<typeof ElasticsearchConfigSchema>;

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

  /** Cached singleton so health checks and teardown share one client. */
  function getOrCreateConnection(): ElasticsearchConnection {
    if (!cachedConn) {
      cachedConn = createElasticsearchConnection(config, { logger: log });
    }
    return cachedConn;
  }

  return {
    id: "elasticsearch-datasource",
    types: ["datasource"] as const,
    version: "0.1.0",
    name: "Elasticsearch DataSource",
    config,

    connection: {
      create: () => getOrCreateConnection(),
      dbType: "elasticsearch",
      // No custom `validate` and no `parserDialect`/`forbiddenPatterns` yet —
      // the query surfaces (and their validation) arrive in #3262.
    },

    entities: [],

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
      ctx.logger.info(
        `Elasticsearch datasource plugin initialized (${extractHost(config.url)})`,
      );
    },

    async healthCheck(): Promise<PluginHealthResult> {
      const start = performance.now();
      try {
        const conn = getOrCreateConnection();
        let timer: ReturnType<typeof setTimeout>;
        const result = await Promise.race([
          conn.ping().then(() => "ok" as const),
          new Promise<"timeout">((resolve) => {
            timer = setTimeout(() => resolve("timeout"), 5000);
          }),
        ]).finally(() => clearTimeout(timer!));
        const latencyMs = Math.round(performance.now() - start);
        if (result === "timeout") {
          return { healthy: false, message: "Health check timed out after 5000ms", latencyMs };
        }
        return { healthy: true, latencyMs };
      } catch (err) {
        const message = scrubElasticsearchError(err, config.apiKey);
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
} from "./connection";
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
} from "./connection";
