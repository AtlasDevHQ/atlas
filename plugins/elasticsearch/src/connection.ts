/**
 * Elasticsearch connection foundation for the datasource plugin.
 *
 * Deep, independently testable modules live here:
 *   1. Config/URL + auth parser — `parseElasticsearchUrl` (URL → engine +
 *      endpoint) and `resolveElasticsearchConfig` ({ url, apiKey } → resolved
 *      config + auth descriptor). Mirrors `parseSalesforceURL`.
 *   2. Thin `fetch`-based HTTP client — `createElasticsearchClient`. No official
 *      SDK (`@elastic/elasticsearch` / `@opensearch-project/opensearch`); it
 *      talks to the cluster's read endpoints directly. Exposes `ping()`
 *      (cluster-info round-trip) and `sqlQuery()` (the SQL query surface, #3262).
 *   3. SQL surface — `sqlQuery()` POSTs to the cluster SQL API (`POST /_sql`),
 *      follows `cursor` pagination up to a row cap, and `normalizeSqlPages` (a
 *      PURE folder) maps ES SQL `{ columns:[{name,type}], rows:[[...]] }` pages
 *      into Atlas `{ columns, rows }`. ES SQL is real SQL, so it rides the host's
 *      standard 4-layer `executeSQL` pipeline — this module ships only the
 *      `parserDialect` + `forbiddenPatterns` it configures (no custom validate).
 *   4. Error scrubbing — `scrubElasticsearchError` strips the API key and other
 *      sensitive markers before a message reaches the agent, the user, or logs;
 *      `extractEsSqlErrorMessage` surfaces the actionable ES error reason first.
 *
 * The Query DSL surface (#3267) lives here too — `client.dslQuery()` /
 * `connection.dslQuery()` POST a read-only DSL request and return the raw
 * response for the tool to validate + normalize (see `./dsl.ts` + `./tool.ts`).
 *
 * This slice handles `elasticsearch://` URLs with API-key auth only. Basic /
 * Cloud ID / AWS SigV4 auth and the OpenSearch engine (#3266) are later slices.
 */

import type {
  PluginDBConnection,
  PluginQueryResult,
  PluginLogger,
  ParserDialect,
} from "@useatlas/plugin-sdk";
import type { EsMappingResponse } from "./mapping";
import { applyDslSafeguards, DEFAULT_DSL_MAX_SIZE, DEFAULT_DSL_TERMINATE_AFTER } from "./dsl";

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
// SQL query surface (#3262)
// ---------------------------------------------------------------------------

/** A column descriptor from an ES SQL response (`{ name, type }`). */
export interface ElasticsearchSqlColumn {
  name: string;
  /** ES type (`text`, `long`, `keyword`, …). Not consumed by Atlas yet. */
  type?: string;
}

/**
 * One page of the ES SQL API response. The first page carries `columns`; every
 * page carries `rows` (positional arrays aligned to the column order) and, when
 * more pages remain, a `cursor` to fetch the next one.
 */
export interface ElasticsearchSqlResponse {
  columns?: ElasticsearchSqlColumn[];
  rows?: unknown[][];
  cursor?: string;
}

/** Options for a single (possibly multi-page) SQL query. */
export interface ElasticsearchSqlQueryOptions {
  /**
   * The ES SQL statement. By the time it reaches here the host's `executeSQL`
   * pipeline has already validated it (SELECT-only, index whitelist) and
   * appended its auto-LIMIT — that LIMIT is the authoritative row cap.
   */
  query: string;
  /** Total deadline for the whole multi-page fetch, in ms. Defaults to 30000. */
  timeoutMs?: number;
  /** ES `fetch_size` (rows per page). Defaults to {@link DEFAULT_FETCH_SIZE}. */
  fetchSize?: number;
  /**
   * Defensive client-side ceiling on accumulated rows. The SQL's auto-LIMIT is
   * the real cap; this only backstops a pathological cursor. Defaults to
   * {@link DEFAULT_MAX_ROWS}. Truncation is logged, never silent.
   */
  maxRows?: number;
}

// ---------------------------------------------------------------------------
// Query DSL surface (#3267)
// ---------------------------------------------------------------------------

/** The body-bearing read operations the DSL client executes. */
export type ElasticsearchDslEndpoint = "_search" | "_count";

/** Options for a single Query DSL request (`POST /<index>/<endpoint>`). */
export interface ElasticsearchDslQueryOptions {
  /** Target index / alias / data stream (comma-separated allowed). The tool has
   *  already run `validateIndexAccess` (structural rails + membership) on it. */
  index: string;
  /** Read operation. Defaults to `_search`. */
  endpoint?: ElasticsearchDslEndpoint;
  /** The Query DSL request body. The tool has already validated it read-only. */
  body?: Record<string, unknown>;
  /** Hard wall-clock deadline for the request, in ms. Defaults to 30000. */
  timeoutMs?: number;
  /** `size` ceiling for `_search`. Defaults to {@link DEFAULT_DSL_MAX_SIZE}. */
  maxSize?: number;
  /** `terminate_after` for non-aggregation `_search`. `<=0` omits it. */
  terminateAfter?: number;
}

/** Default ES `fetch_size` (rows per page) when the caller doesn't set one. */
export const DEFAULT_FETCH_SIZE = 1000;

/**
 * Defensive ceiling on rows accumulated across cursor pages. The host appends a
 * `LIMIT` (default `ATLAS_ROW_LIMIT` = 1000) before the query reaches us, so in
 * normal operation the cursor terminates well below this — it exists only to
 * cap a runaway cursor. Comfortably above the typical limit so it never silently
 * truncates legitimately-LIMITed results; if it ever does fire, we log a warning.
 */
export const DEFAULT_MAX_ROWS = 10000;

/**
 * node-sql-parser dialect for the ES SQL surface. ES SQL is standard SQL and the
 * full documented subset (SELECT / WHERE / GROUP BY / HAVING / ORDER BY / LIMIT
 * over a single index-as-table, plus COUNT/SUM/AVG/MIN/MAX and COUNT(DISTINCT))
 * parses cleanly under PostgreSQL mode. PostgreSQL is chosen over MySQL because
 * ES SQL quotes identifiers (index names with `-`, `.`, etc.) with double quotes
 * — `SELECT * FROM "logs-2024.01.01"` — matching PostgreSQL, whereas MySQL mode
 * expects backticks. (Verified against node-sql-parser 5.4.0.)
 */
export const ELASTICSEARCH_PARSER_DIALECT: ParserDialect = "PostgresQL";

/**
 * ES-specific forbidden patterns layered on top of the host's base DML/DDL guard.
 *
 * The `/_sql` endpoint is query-only (no INSERT/UPDATE/DELETE exist in ES SQL),
 * so the base guard already covers mutations. What ES SQL adds are catalog- and
 * schema-disclosure verbs — `SHOW TABLES|COLUMNS|FUNCTIONS|CATALOGS`, `DESCRIBE`
 * — which enumerate every index/field and so bypass the index whitelist. They
 * are already rejected downstream (the AST layer parses `SHOW` as a non-`select`
 * node and `DESCRIBE <x>` fails to parse), but blocking them here gives a clear
 * "forbidden operation" error and a defense-in-depth net independent of parser
 * behavior.
 *
 * Anchored to the statement start (`^\s*`) on purpose: a SELECT never begins
 * with these verbs, so anchoring blocks the standalone commands without ever
 * false-positiving on a field literally named `show`/`description`. Bare `DESC`
 * is deliberately NOT blocked — it is the `ORDER BY … DESC` sort direction.
 */
export const ELASTICSEARCH_FORBIDDEN_PATTERNS: RegExp[] = [
  /^\s*SHOW\b/i,
  /^\s*DESCRIBE\b/i,
];

/**
 * PURE: fold a sequence of ES SQL response pages into Atlas `{ columns, rows }`.
 *
 * Column names are taken from the first page that declares them (cursor pages
 * omit `columns`). Each positional row array is zipped against those names into
 * a record. Falsy scalars (`0`, `false`, `""`) are preserved; a missing trailing
 * cell becomes `null`. Accumulation stops once `maxRows` records are collected.
 *
 * Side-effect free and HTTP-free so it can be unit-tested in isolation — the
 * cursor-following fetch loop lives in {@link createElasticsearchClient}.
 */
export function normalizeSqlPages(
  pages: ElasticsearchSqlResponse[],
  maxRows: number = Number.POSITIVE_INFINITY,
): PluginQueryResult {
  const columnDefs =
    pages.find((p) => Array.isArray(p.columns) && p.columns.length > 0)?.columns ?? [];
  const columns = columnDefs.map((c) => c.name);

  const rows: Record<string, unknown>[] = [];
  for (const page of pages) {
    for (const rowArr of page.rows ?? []) {
      if (rows.length >= maxRows) return { columns, rows };
      const record: Record<string, unknown> = {};
      for (let i = 0; i < columns.length; i++) {
        const value = rowArr[i];
        // `?? null` only replaces null/undefined — 0, false, "" survive.
        record[columns[i]] = value ?? null;
      }
      rows.push(record);
    }
  }
  return { columns, rows };
}

/**
 * PURE: extract an actionable message from an ES SQL error response body.
 *
 * ES returns structured errors — `{ error: { type, reason }, status }` — whose
 * `reason` (e.g. "Unknown column [foo]") lets the agent self-correct. Prefer
 * `type: reason`, then `reason`, then `type`, then a string `error`, and finally
 * fall back to the HTTP status line. The caller scrubs the result through
 * {@link scrubElasticsearchError} before it leaves the process.
 */
export function extractEsSqlErrorMessage(
  body: unknown,
  status: number,
  statusText: string,
  surface: "SQL" | "DSL" = "SQL",
): string {
  const fallback = `Elasticsearch ${surface} request failed: HTTP ${status} ${statusText}`;
  if (body && typeof body === "object" && "error" in body) {
    const error = (body as { error: unknown }).error;
    if (typeof error === "string" && error.trim()) return error;
    if (error && typeof error === "object") {
      const e = error as { type?: unknown; reason?: unknown };
      const reason = typeof e.reason === "string" && e.reason.trim() ? e.reason : undefined;
      const type = typeof e.type === "string" && e.type.trim() ? e.type : undefined;
      if (reason && type) return `${type}: ${reason}`;
      if (reason) return reason;
      if (type) return type;
    }
  }
  return fallback;
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

  // Credentials belong in the secret `apiKey` config field (encrypted at rest),
  // never in the URL. The endpoint is composed from host + path only, so URL
  // userinfo / auth query params would otherwise be silently dropped — reject
  // them loudly so a user can't believe they authenticated via the URL.
  if (parsed.username || parsed.password) {
    throw new Error(
      "Invalid Elasticsearch URL: credentials must be supplied via the apiKey config field, not the URL userinfo.",
    );
  }
  const AUTH_PARAM_KEYS = ["username", "password", "api_key", "apikey", "access_token", "token", "auth"];
  for (const key of AUTH_PARAM_KEYS) {
    if (parsed.searchParams.has(key)) {
      throw new Error(
        `Invalid Elasticsearch URL: auth parameter "${key}" is not allowed in the URL — use the apiKey config field.`,
      );
    }
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
    // intentionally ignored: a parse failure here is non-fatal — this is a
    // best-effort logging helper, and parseElasticsearchUrl owns real validation.
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
  /**
   * Fetch index mappings (`GET /_mapping`, or `GET /<index>/_mapping` when an
   * index is given). Powers the `atlas init` / `atlas diff` semantic-layer
   * profiler. The body is field definitions (no credential), so it is returned
   * verbatim; errors are status-only and key-scrubbed, exactly like `ping`.
   */
  getMapping(index?: string, timeoutMs?: number): Promise<EsMappingResponse>;
  /**
   * Run an ES SQL statement via `POST /_sql`, following `cursor` pagination up to
   * the row cap, and return the normalized `{ columns, rows }`. Errors are
   * secret-scrubbed before they reach the caller.
   */
  sqlQuery(opts: ElasticsearchSqlQueryOptions): Promise<PluginQueryResult>;
  /**
   * Run a read-only Query DSL request via `POST /<index>/<endpoint>` and return
   * the RAW parsed response body (normalization is the tool's job — it inspects
   * `hits.total`/`aggregations` for truncation). Resource safeguards (size cap,
   * `terminate_after`, search `timeout`) are applied to every request via
   * {@link applyDslSafeguards}. Errors are secret-scrubbed before they surface.
   */
  dslQuery(opts: ElasticsearchDslQueryOptions): Promise<unknown>;
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

    async getMapping(
      index?: string,
      timeoutMs = 10000,
    ): Promise<EsMappingResponse> {
      if (closed) {
        throw new Error("Elasticsearch client is closed");
      }

      const fetchImpl = options?.fetchImpl ?? globalThis.fetch;
      const controller = new AbortController();
      inFlight.add(controller);
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      // `GET /_mapping` (all indices) or `GET /<index>/_mapping` (one). The
      // index segment is URL-encoded so reserved characters can't escape the path.
      const target = index
        ? `${endpoint}/${encodeURIComponent(index)}/_mapping`
        : `${endpoint}/_mapping`;

      try {
        const res = await fetchImpl(target, {
          method: "GET",
          headers: {
            Authorization: `ApiKey ${auth.apiKey}`,
            Accept: "application/json",
          },
          signal: controller.signal,
        });

        // On failure the body can echo the supplied credential, so report only
        // the status line — never the body (mirrors `ping`).
        if (!res.ok) {
          throw new Error(
            `Elasticsearch mapping request failed: HTTP ${res.status} ${res.statusText}`,
          );
        }

        return (await res.json()) as EsMappingResponse;
      } catch (err) {
        if (controller.signal.aborted && !closed) {
          throw new Error(
            `Elasticsearch mapping request timed out after ${timeoutMs}ms`,
          );
        }
        throw new Error(scrubElasticsearchError(err, auth.apiKey));
      } finally {
        clearTimeout(timer);
        inFlight.delete(controller);
      }
    },

    async sqlQuery(opts: ElasticsearchSqlQueryOptions): Promise<PluginQueryResult> {
      if (closed) {
        throw new Error("Elasticsearch client is closed");
      }

      const {
        query,
        timeoutMs = 30000,
        fetchSize = DEFAULT_FETCH_SIZE,
        maxRows = DEFAULT_MAX_ROWS,
      } = opts;

      const fetchImpl = options?.fetchImpl ?? globalThis.fetch;
      const controller = new AbortController();
      inFlight.add(controller);
      // One deadline for the whole multi-page fetch — the statement timeout
      // bounds total wall-clock across every cursor page, not each page.
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      const headers = {
        Authorization: `ApiKey ${auth.apiKey}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      };

      /** POST a payload to `/_sql` and return the parsed page (throws on non-2xx). */
      const postSql = async (
        payload: Record<string, unknown>,
      ): Promise<ElasticsearchSqlResponse> => {
        const res = await fetchImpl(`${endpoint}/_sql?format=json`, {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        if (!res.ok) {
          // Read the body for the actionable ES error reason; fall back to the
          // status line if it isn't JSON. The message is scrubbed in the catch.
          let body: unknown;
          try {
            body = await res.json();
          } catch {
            // intentionally ignored: a non-JSON error body just falls back to
            // the HTTP status line via extractEsSqlErrorMessage.
            body = undefined;
          }
          throw new Error(extractEsSqlErrorMessage(body, res.status, res.statusText));
        }
        return (await res.json()) as ElasticsearchSqlResponse;
      };

      try {
        const pages: ElasticsearchSqlResponse[] = [];
        let rowCount = 0;

        let page = await postSql({ query, fetch_size: fetchSize });
        pages.push(page);
        rowCount += page.rows?.length ?? 0;

        while (page.cursor && rowCount < maxRows) {
          page = await postSql({ cursor: page.cursor });
          pages.push(page);
          rowCount += page.rows?.length ?? 0;
        }

        // Stopped early on the row cap with a live cursor: log (never silent) and
        // best-effort release the server-side cursor so it doesn't linger.
        if (page.cursor && rowCount >= maxRows) {
          options?.logger?.warn(
            { maxRows },
            `Elasticsearch SQL result truncated at the client row cap (${maxRows}); a LIMIT below ${maxRows} avoids truncation.`,
          );
          try {
            await fetchImpl(`${endpoint}/_sql/close`, {
              method: "POST",
              headers,
              body: JSON.stringify({ cursor: page.cursor }),
              signal: controller.signal,
            });
          } catch (closeErr) {
            options?.logger?.debug(
              { err: closeErr instanceof Error ? closeErr.message : String(closeErr) },
              "Failed to close Elasticsearch SQL cursor (non-fatal)",
            );
          }
        }

        return normalizeSqlPages(pages, maxRows);
      } catch (err) {
        if (controller.signal.aborted && !closed) {
          throw new Error(
            `Elasticsearch SQL query timed out after ${timeoutMs}ms`,
          );
        }
        // Scrub before surfacing — see the ping() rationale above (no cause chain).
        throw new Error(scrubElasticsearchError(err, auth.apiKey));
      } finally {
        clearTimeout(timer);
        inFlight.delete(controller);
      }
    },

    async dslQuery(opts: ElasticsearchDslQueryOptions): Promise<unknown> {
      if (closed) {
        throw new Error("Elasticsearch client is closed");
      }

      const {
        index,
        endpoint: op = "_search",
        body,
        timeoutMs = 30000,
        maxSize = DEFAULT_DSL_MAX_SIZE,
        terminateAfter = DEFAULT_DSL_TERMINATE_AFTER,
      } = opts;

      // Resource safeguards applied to EVERY DSL request (size cap, search
      // timeout, terminate_after-when-no-aggs). Pure + tested in dsl.ts.
      const safeBody = applyDslSafeguards(op, body, { maxSize, terminateAfter, timeoutMs });

      // Per-index URL-encoding preserves the comma multi-index separator while
      // escaping reserved characters in each name. The tool has already rejected
      // wildcards / _all / non-whitelisted indices.
      const indexPath = index
        .split(",")
        .map((s) => encodeURIComponent(s.trim()))
        .filter((s) => s.length > 0)
        .join(",");

      const fetchImpl = options?.fetchImpl ?? globalThis.fetch;
      const controller = new AbortController();
      inFlight.add(controller);
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const res = await fetchImpl(`${endpoint}/${indexPath}/${op}`, {
          method: "POST",
          headers: {
            Authorization: `ApiKey ${auth.apiKey}`,
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify(safeBody),
          signal: controller.signal,
        });

        if (!res.ok) {
          // Read the body for the actionable ES error reason; fall back to the
          // status line if it isn't JSON. The message is scrubbed in the catch.
          let errBody: unknown;
          try {
            errBody = await res.json();
          } catch {
            // intentionally ignored: a non-JSON error body falls back to the
            // HTTP status line via extractEsSqlErrorMessage.
            errBody = undefined;
          }
          throw new Error(extractEsSqlErrorMessage(errBody, res.status, res.statusText, "DSL"));
        }

        return await res.json();
      } catch (err) {
        if (controller.signal.aborted && !closed) {
          throw new Error(`Elasticsearch DSL query timed out after ${timeoutMs}ms`);
        }
        // Scrub before surfacing — see the ping() rationale (no cause chain).
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
 * health check and `dslQuery()` for the Query DSL surface (#3267). `query()` runs
 * ES SQL via the cluster SQL API (#3262); `dslQuery()` runs a read-only Query DSL
 * request and returns the RAW response for the tool to normalize.
 */
export interface ElasticsearchConnection extends PluginDBConnection {
  ping(timeoutMs?: number): Promise<ClusterInfo>;
  dslQuery(opts: ElasticsearchDslQueryOptions): Promise<unknown>;
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
    async query(sql: string, timeoutMs?: number): Promise<PluginQueryResult> {
      // ES SQL is real SQL: the host's `executeSQL` pipeline has already run the
      // 4-layer validation (SELECT-only, index whitelist) and appended its
      // auto-LIMIT before calling here. We just execute + normalize the result.
      return client.sqlQuery({ query: sql, timeoutMs });
    },

    async ping(timeoutMs?: number): Promise<ClusterInfo> {
      return client.ping(timeoutMs);
    },

    async dslQuery(opts: ElasticsearchDslQueryOptions): Promise<unknown> {
      // The tool has already validated the request read-only + index-whitelisted;
      // the client applies the resource safeguards and returns the raw response.
      return client.dslQuery(opts);
    },

    async close(): Promise<void> {
      client.close();
    },
  };
}
