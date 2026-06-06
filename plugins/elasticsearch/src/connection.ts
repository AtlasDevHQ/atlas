/**
 * Elasticsearch connection foundation for the datasource plugin.
 *
 * Three deep, independently testable modules live here:
 *   1. Config/URL + auth parser — `parseElasticsearchUrl` (URL → engine +
 *      endpoint) and `resolveElasticsearchConfig` ({ url, apiKey } → resolved
 *      config + auth descriptor). Mirrors `parseSalesforceURL`.
 *   2. Thin `fetch`-based HTTP client — `createElasticsearchClient`. No official
 *      SDK (`@elastic/elasticsearch` / `@opensearch-project/opensearch`); it
 *      talks to the cluster's read endpoints directly. This slice exposes only an
 *      authenticated cluster-info/ping round-trip; query surfaces arrive later.
 *   3. Error scrubbing — `scrubElasticsearchError` strips the API key and other
 *      sensitive markers before a message reaches the agent, the user, or logs.
 *
 * This slice (#3261) handles `elasticsearch://` URLs with API-key auth only.
 * Basic / Cloud ID / AWS SigV4 auth and the OpenSearch engine are later slices.
 */

import type {
  PluginDBConnection,
  PluginQueryResult,
  PluginLogger,
} from "@useatlas/plugin-sdk";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Cluster engine. Forward-declared with both members so later slices widen
 * without a breaking change, but `parseElasticsearchUrl` only ever produces
 * `elasticsearch` until OpenSearch engine support lands (#3266).
 */
export type ElasticsearchEngine = "elasticsearch" | "opensearch";

export interface ParsedElasticsearchUrl {
  /** Resolved engine. Always `elasticsearch` in this slice. */
  engine: ElasticsearchEngine;
  /** Resolved `http(s)://host[:port][/prefix]` base URL, no trailing slash. */
  endpoint: string;
}

/** API-key auth descriptor (`Authorization: ApiKey <key>`). */
export interface ElasticsearchApiKeyAuth {
  mode: "apiKey";
  apiKey: string;
}

/** Resolved auth descriptor. A union once later slices add Basic/CloudID/SigV4. */
export type ElasticsearchAuthDescriptor = ElasticsearchApiKeyAuth;

/** Raw plugin config (the shape an operator writes / the admin form stores). */
export interface ElasticsearchPluginConfig {
  /** `elasticsearch://host[:port][/prefix]`. HTTPS by default; `?ssl=false` → HTTP. */
  url: string;
  /** Base64-encoded API key. Marked `secret: true` — encrypted at rest. */
  apiKey: string;
  /** Optional. Surfaced to the agent in the system prompt. */
  description?: string;
}

/** Fully resolved connection config consumed by the client. */
export interface ResolvedElasticsearchConfig {
  engine: ElasticsearchEngine;
  endpoint: string;
  auth: ElasticsearchAuthDescriptor;
  description?: string;
}

/** Normalized cluster-info result (engine-agnostic subset). All fields optional
 *  because the `GET /` body varies by engine/version. */
export interface ClusterInfo {
  /** Node name (`name` in the cluster-info body) — identifies the responding node. */
  name?: string;
  /** Cluster name (`cluster_name` in the body) — identifies the whole cluster. */
  clusterName?: string;
  /** Server version string (`version.number`). */
  version?: string;
  /** Distribution flavor (`version.distribution`), e.g. `elasticsearch`/`opensearch`. */
  distribution?: string;
}

// ---------------------------------------------------------------------------
// Error scrubbing
// ---------------------------------------------------------------------------

/**
 * Auth-context markers scrubbed from error messages before they reach the
 * agent/user/logs. Mirrors the Salesforce plugin's `SENSITIVE_PATTERNS`, tuned
 * for Elasticsearch auth.
 *
 * Deliberately credential-context-only (`api key`, `authorization`, `bearer`,
 * `credential`, `password`, `connection string`) — the literal-key redaction in
 * {@link scrubElasticsearchError} already removes an echoed key, so this second
 * pass need not (and must not) collapse benign diagnostics. In particular it
 * omits `certificate`/`token`/`secret`: TLS-trust failures ("self-signed
 * certificate") are the most common HTTPS first-connect error and carry no
 * credential, and `token`/`secret` collide with ordinary ES content (token
 * filters, fields named `secret`).
 */
export const SENSITIVE_PATTERNS =
  /api[ _-]?key|authorization|bearer|credential|password|connection.?string/i;

/**
 * Scrub an error for safe display. Two passes:
 *   1. Replace any literal occurrence of the API key with `[REDACTED]`.
 *   2. If the message still trips a sensitive marker, collapse it to a generic
 *      message (the detail stays in server logs only).
 */
export function scrubElasticsearchError(err: unknown, apiKey?: string): string {
  let message = err instanceof Error ? err.message : String(err);

  if (apiKey && apiKey.length > 0 && message.includes(apiKey)) {
    message = message.split(apiKey).join("[REDACTED]");
  }

  if (SENSITIVE_PATTERNS.test(message)) {
    return "Elasticsearch request failed — check server logs for details.";
  }

  return message;
}

// ---------------------------------------------------------------------------
// Config / URL parser
// ---------------------------------------------------------------------------

/** Resolve TLS from `?ssl=`/`?tls=` query params. HTTPS unless explicitly `false`. */
function resolveSsl(params: URLSearchParams): boolean {
  for (const key of ["ssl", "tls"]) {
    const value = params.get(key);
    if (value !== null && value.toLowerCase() === "false") {
      return false;
    }
  }
  return true;
}

/**
 * Parse an `elasticsearch://` URL into its engine and HTTP(S) endpoint.
 *
 * Format: `elasticsearch://host[:port][/prefix][?ssl=false]`
 *
 * - Scheme `elasticsearch://` resolves engine `elasticsearch`.
 * - Transport is HTTPS by default (Elastic Cloud, the API-key target, is always
 *   HTTPS). `?ssl=false` (alias `?tls=false`) downgrades to HTTP for a plaintext
 *   local cluster.
 * - The endpoint is `proto://host[:port][/prefix]` with trailing slashes removed.
 *
 * Carries no credential — the API key is a separate, secret config field — so
 * parse errors are safe to surface verbatim.
 */
export function parseElasticsearchUrl(url: string): ParsedElasticsearchUrl {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid Elasticsearch URL: "${url}" could not be parsed.`);
  }

  if (parsed.protocol === "opensearch:") {
    throw new Error(
      "OpenSearch engine support arrives in a later slice (#3266) — use the elasticsearch:// scheme for now.",
    );
  }
  if (parsed.protocol !== "elasticsearch:") {
    throw new Error(
      `Invalid Elasticsearch URL: expected elasticsearch:// scheme, got "${parsed.protocol}".`,
    );
  }

  const host = parsed.host; // includes the port when present
  if (!host) {
    throw new Error("Invalid Elasticsearch URL: missing host.");
  }

  const proto = resolveSsl(parsed.searchParams) ? "https" : "http";
  const prefix = parsed.pathname.replace(/\/+$/, "");
  const endpoint = `${proto}://${host}${prefix}`;

  return { engine: "elasticsearch", endpoint };
}

/**
 * Extract the hostname from an Elasticsearch URL for safe logging (no port,
 * no credentials). Returns "(unknown)" on parse failure — intentionally
 * defensive for logging contexts.
 */
export function extractHost(url: string): string {
  try {
    return new URL(url).hostname || "(unknown)";
  } catch {
    return "(unknown)";
  }
}

/**
 * Resolve a raw plugin config into the typed connection config + auth
 * descriptor. The auth mode is inferred from the credentials present — in this
 * slice, an `apiKey` resolves API-key auth. The error message never echoes the
 * key.
 */
export function resolveElasticsearchConfig(
  config: ElasticsearchPluginConfig,
): ResolvedElasticsearchConfig {
  const { engine, endpoint } = parseElasticsearchUrl(config.url);

  const apiKey = typeof config.apiKey === "string" ? config.apiKey.trim() : "";
  if (!apiKey) {
    throw new Error("Invalid Elasticsearch config: missing API key.");
  }

  return {
    engine,
    endpoint,
    auth: { mode: "apiKey", apiKey },
    ...(config.description ? { description: config.description } : {}),
  };
}

// ---------------------------------------------------------------------------
// Thin fetch client
// ---------------------------------------------------------------------------

export interface ElasticsearchClient {
  /** Authenticated cluster-info round-trip (`GET /`). Resolves cluster metadata. */
  ping(timeoutMs?: number): Promise<ClusterInfo>;
  /** Release the client — aborts any in-flight request and rejects future calls. */
  close(): void;
}

export interface ElasticsearchClientOptions {
  /** Inject a fetch implementation (tests). Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  logger?: PluginLogger;
}

/** Normalize the cluster-info response into the engine-agnostic {@link ClusterInfo}. */
function normalizeClusterInfo(body: unknown): ClusterInfo {
  const b = (body ?? {}) as Record<string, unknown>;
  const version = (b.version ?? {}) as Record<string, unknown>;
  const info: ClusterInfo = {};
  if (typeof b.name === "string") info.name = b.name;
  if (typeof b.cluster_name === "string") info.clusterName = b.cluster_name;
  if (typeof version.number === "string") info.version = version.number;
  if (typeof version.distribution === "string") info.distribution = version.distribution;
  return info;
}

/**
 * Create a thin `fetch`-based Elasticsearch client. Stateless beyond a closed
 * flag and the set of in-flight aborts — no pooling, no official SDK.
 */
export function createElasticsearchClient(
  resolved: ResolvedElasticsearchConfig,
  options?: ElasticsearchClientOptions,
): ElasticsearchClient {
  const { endpoint, auth } = resolved;
  let closed = false;
  const inFlight = new Set<AbortController>();

  return {
    async ping(timeoutMs = 5000): Promise<ClusterInfo> {
      if (closed) {
        throw new Error("Elasticsearch client is closed");
      }

      const fetchImpl = options?.fetchImpl ?? globalThis.fetch;
      const controller = new AbortController();
      inFlight.add(controller);
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const res = await fetchImpl(`${endpoint}/`, {
          method: "GET",
          headers: {
            Authorization: `ApiKey ${auth.apiKey}`,
            Accept: "application/json",
          },
          signal: controller.signal,
        });

        // The response body can echo the supplied credential, so failures
        // report only the status line — never the body.
        if (!res.ok) {
          throw new Error(
            `Elasticsearch cluster-info request failed: HTTP ${res.status} ${res.statusText}`,
          );
        }

        return normalizeClusterInfo(await res.json());
      } catch (err) {
        if (controller.signal.aborted && !closed) {
          throw new Error(
            `Elasticsearch cluster-info request timed out after ${timeoutMs}ms`,
          );
        }
        // No `{ cause: err }` — the raw error can carry the credential (e.g. an
        // echoed Authorization header), and a `cause` chain survives the message
        // scrub when a downstream serializer walks it. The scrubbed message
        // retains the actionable detail.
        throw new Error(scrubElasticsearchError(err, auth.apiKey));
      } finally {
        clearTimeout(timer);
        inFlight.delete(controller);
      }
    },

    close(): void {
      closed = true;
      for (const controller of inFlight) {
        controller.abort();
      }
      inFlight.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// Connection factory
// ---------------------------------------------------------------------------

/**
 * A {@link PluginDBConnection} for Elasticsearch, extended with `ping()` for the
 * health check. `query()` is intentionally unimplemented in this slice — the SQL
 * surface (`executeSQL`) arrives in #3262 and the Query DSL tool in #3267.
 */
export interface ElasticsearchConnection extends PluginDBConnection {
  ping(timeoutMs?: number): Promise<ClusterInfo>;
}

/**
 * Create an {@link ElasticsearchConnection} backed by the thin fetch client.
 *
 * @throws {Error} If the config is invalid (delegates to
 *   {@link resolveElasticsearchConfig}; the API key is never echoed).
 */
export function createElasticsearchConnection(
  config: ElasticsearchPluginConfig,
  options?: ElasticsearchClientOptions,
): ElasticsearchConnection {
  const resolved = resolveElasticsearchConfig(config);
  const client = createElasticsearchClient(resolved, options);

  return {
    async query(_sql: string, _timeoutMs?: number): Promise<PluginQueryResult> {
      throw new Error(
        "Elasticsearch query surface is not available yet — it arrives in a later slice (#3262).",
      );
    },

    async ping(timeoutMs?: number): Promise<ClusterInfo> {
      return client.ping(timeoutMs);
    },

    async close(): Promise<void> {
      client.close();
    },
  };
}
