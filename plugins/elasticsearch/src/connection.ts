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
 * Auth modes (#3263–#3265): {@link resolveAuth} picks among API-key, HTTP Basic,
 * and AWS SigV4 by config presence, with a documented precedence
 * (SigV4 → Basic → API key). The endpoint comes from a `url` or a decoded Elastic
 * `cloudId` ({@link decodeCloudId}). Engine (#3266): `elasticsearch` |
 * `opensearch`, resolved from explicit config or the URL scheme; the SQL surface
 * routes per engine (`/_sql` vs `/_plugins/_sql`).
 *
 * The Query DSL surface (#3267) lives here too — `client.dslQuery()` /
 * `connection.dslQuery()` POST a read-only DSL request and return the raw
 * response for the tool to validate + normalize (see `./dsl.ts` + `./tool.ts`).
 * It authenticates through the same per-request header builder as every other
 * request, so it inherits all auth modes + both engines.
 */

import type {
  PluginDBConnection,
  PluginQueryResult,
  PluginLogger,
  ParserDialect,
} from "@useatlas/plugin-sdk";
import type { EsMappingResponse, EsAliasResponse, EsDataStreamResponse } from "./mapping";
import { sigV4SignHeaders } from "./sigv4";
import { applyDslSafeguards, DEFAULT_DSL_MAX_SIZE, DEFAULT_DSL_TERMINATE_AFTER } from "./dsl";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Cluster engine. `elasticsearch://` → `elasticsearch`, `opensearch://` →
 * `opensearch`; an explicit `engine` config field overrides the scheme (#3266).
 */
export type ElasticsearchEngine = "elasticsearch" | "opensearch";

export interface ParsedElasticsearchUrl {
  /** Resolved engine from the URL scheme. */
  engine: ElasticsearchEngine;
  /** Resolved `http(s)://host[:port][/prefix]` base URL, no trailing slash. */
  endpoint: string;
}

/** API-key auth descriptor (`Authorization: ApiKey <key>`). */
export interface ElasticsearchApiKeyAuth {
  mode: "apiKey";
  apiKey: string;
}

/** HTTP Basic auth descriptor (`Authorization: Basic base64(user:pass)`). #3263. */
export interface ElasticsearchBasicAuth {
  mode: "basic";
  username: string;
  password: string;
}

/**
 * AWS SigV4 auth descriptor — Amazon OpenSearch Service / IAM-protected domains
 * (#3265). Credentials are resolved eagerly (explicit config first, else the
 * ambient AWS environment chain) so the signer just consumes them per request.
 */
export interface ElasticsearchSigV4Auth {
  mode: "sigv4";
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  region: string;
  /** AWS service code. `es` for managed Elasticsearch/OpenSearch domains. */
  service: string;
}

/** Resolved auth descriptor — picked from config presence by {@link resolveAuth}. */
export type ElasticsearchAuthDescriptor =
  | ElasticsearchApiKeyAuth
  | ElasticsearchBasicAuth
  | ElasticsearchSigV4Auth;

/**
 * Raw plugin config (the shape an operator writes / the admin form stores).
 *
 * Every field is optional: the connection target is `url` **or** `cloudId`, and
 * the auth mode is picked by {@link resolveAuth} from whichever credentials are
 * present (precedence: SigV4 → Basic → API key). The fields `apiKey`,
 * `password`, `awsSecretAccessKey`, `awsSessionToken` are `secret: true` in the
 * config schema — encrypted at rest.
 */
export interface ElasticsearchPluginConfig {
  /** `elasticsearch://` or `opensearch://` host[:port][/prefix]. HTTPS by default; `?ssl=false` → HTTP. */
  url?: string;
  /** Elastic Cloud ID (`name:base64`) — decoded to the cluster endpoint. Alternative to `url`. */
  cloudId?: string;
  /** Explicit engine override. Wins over the URL scheme. */
  engine?: ElasticsearchEngine;
  /** Base64-encoded API key (`Authorization: ApiKey`). Secret. */
  apiKey?: string;
  /** HTTP Basic username. */
  username?: string;
  /** HTTP Basic password. Secret. */
  password?: string;
  /** AWS region — the signal that selects SigV4 auth (e.g. `us-east-1`). */
  awsRegion?: string;
  /** AWS access key id (explicit). Falls back to `AWS_ACCESS_KEY_ID`. */
  awsAccessKeyId?: string;
  /** AWS secret access key (explicit). Falls back to `AWS_SECRET_ACCESS_KEY`. Secret. */
  awsSecretAccessKey?: string;
  /** AWS session token (explicit). Falls back to `AWS_SESSION_TOKEN`. Secret. */
  awsSessionToken?: string;
  /** AWS service code for signing. Defaults to {@link DEFAULT_AWS_SERVICE} (`es`). */
  awsService?: string;
  /** Optional. Surfaced to the agent in the system prompt. */
  description?: string;
}

/** Default AWS service code for SigV4 signing (managed ES/OpenSearch domains). */
export const DEFAULT_AWS_SERVICE = "es";

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
 * `reason` (e.g. "Unknown column [foo]") lets the agent self-correct. The `error`
 * field is either a string or an object (mutually exclusive). Matching the code:
 * a string `error` is used as-is; otherwise from the object form prefer
 * `type: reason`, then `reason`, then `type`; finally fall back to the HTTP status
 * line. The caller scrubs the result through {@link scrubElasticsearchError}
 * before it leaves the process.
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
 *   1. Replace any literal occurrence of a secret (API key, password, AWS secret
 *      key, session token) with `[REDACTED]`.
 *   2. If the message still trips a sensitive marker, collapse it to a generic
 *      message (the detail stays in server logs only).
 *
 * Accepts one secret or a list — the auth mode determines which secrets exist
 * ({@link collectAuthSecrets} / {@link collectConfigSecrets}).
 */
export function scrubElasticsearchError(
  err: unknown,
  secrets?: string | readonly string[],
): string {
  let message = err instanceof Error ? err.message : String(err);

  const list = typeof secrets === "string" ? [secrets] : secrets ?? [];
  for (const secret of list) {
    if (secret && secret.length > 0 && message.includes(secret)) {
      message = message.split(secret).join("[REDACTED]");
    }
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
 * Parse an `elasticsearch://` or `opensearch://` URL into its engine and HTTP(S)
 * endpoint.
 *
 * Format: `<elasticsearch|opensearch>://host[:port][/prefix][?ssl=false]`
 *
 * - Scheme decides the engine: `elasticsearch://` → `elasticsearch`,
 *   `opensearch://` → `opensearch` (#3266). An explicit `engine` config field
 *   overrides this downstream in {@link resolveElasticsearchConfig}.
 * - Transport is HTTPS by default (managed clusters are always HTTPS).
 *   `?ssl=false` (alias `?tls=false`) downgrades to HTTP for a plaintext local
 *   cluster.
 * - The endpoint is `proto://host[:port][/prefix]` with trailing slashes removed.
 *
 * Carries no credential — credentials are separate, secret config fields — so
 * parse errors are safe to surface verbatim.
 */
export function parseElasticsearchUrl(url: string): ParsedElasticsearchUrl {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid Elasticsearch URL: "${url}" could not be parsed.`);
  }

  const engine: ElasticsearchEngine | undefined =
    parsed.protocol === "elasticsearch:"
      ? "elasticsearch"
      : parsed.protocol === "opensearch:"
        ? "opensearch"
        : undefined;
  if (!engine) {
    throw new Error(
      `Invalid Elasticsearch URL: expected elasticsearch:// or opensearch:// scheme, got "${parsed.protocol}".`,
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

  return { engine, endpoint };
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
 * Decode an Elastic **Cloud ID** to the cluster's HTTPS endpoint (#3264).
 *
 * Format: `<deployment-name>:<base64>` where the base64 decodes to
 * `<domain>[:port]$<es-uuid>$<kibana-uuid>` (`$`-separated). The Elasticsearch
 * endpoint is `https://<es-uuid>.<domain>[:port]`; when the es-uuid is empty
 * (`domain$$kibana`) it falls back to `https://<domain>`. Always HTTPS — Elastic
 * Cloud terminates TLS.
 *
 * Carries no credential, so parse errors are safe to surface verbatim. Throws a
 * clear message on every malformed shape (no colon, empty/invalid base64,
 * missing the `$`-separated parts).
 */
export function decodeCloudId(cloudId: string): string {
  const trimmed = cloudId.trim();
  const sep = trimmed.indexOf(":");
  if (sep <= 0 || sep === trimmed.length - 1) {
    throw new Error(
      'Invalid Elastic Cloud ID: expected "<name>:<base64>" with a non-empty base64 segment.',
    );
  }

  const encoded = trimmed.slice(sep + 1);
  let decoded: string;
  try {
    decoded = Buffer.from(encoded, "base64").toString("utf8");
  } catch {
    throw new Error("Invalid Elastic Cloud ID: the base64 segment could not be decoded.");
  }
  // A valid Cloud ID decodes to the full `domain[:port]$es-uuid$kibana-uuid`
  // triple (kibana-uuid, and occasionally es-uuid, may be empty — but the `$`
  // separators are always present). Require all three parts so a truncated or
  // garbage payload (`""`, `domain`, `domain$es-uuid`) is rejected loudly rather
  // than silently deriving a half-formed endpoint.
  const parts = decoded.split("$");
  const domainPart = parts[0];
  const esUuid = parts[1];
  if (parts.length < 3 || !domainPart) {
    throw new Error(
      "Invalid Elastic Cloud ID: decoded value is malformed (expected `domain$es-uuid$kibana-uuid`).",
    );
  }

  // The domain segment may carry an explicit port (`cloud.example.com:9243`).
  const colonIdx = domainPart.indexOf(":");
  const domain = colonIdx === -1 ? domainPart : domainPart.slice(0, colonIdx);
  const port = colonIdx === -1 ? "" : domainPart.slice(colonIdx + 1);

  const host = esUuid && esUuid.length > 0 ? `${esUuid}.${domain}` : domain;
  return `https://${host}${port ? `:${port}` : ""}`;
}

/** Options governing how {@link resolveAuth} resolves credentials. */
export interface ResolveAuthOptions {
  /**
   * Whether SigV4 may fall back to the ambient AWS environment chain
   * (`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN`) when
   * explicit keys aren't in the config. Defaults to `false` (safe).
   *
   * Only the static `atlas.config.ts` (operator-baked, self-hosted) path opts
   * in. DB-stored **per-workspace** configs (`createFromConfig`) MUST carry their
   * own explicit, encrypted keys and never read the operator's environment —
   * otherwise a tenant on a multi-tenant deploy would sign requests with the
   * operator's ambient IAM credentials (CLAUDE.md: "per-tenant plugin creds never
   * fall back to operator env vars", #2850).
   */
  allowAmbientAwsCreds?: boolean;
}

/**
 * Resolve the auth descriptor from the credentials present, with a documented
 * precedence so a config carrying more than one signal is deterministic:
 *
 *   1. **SigV4** — selected when `awsRegion` is set (the unambiguous AWS signal).
 *      Credentials come from explicit `awsAccessKeyId` / `awsSecretAccessKey`
 *      (+ optional `awsSessionToken`). The ambient AWS environment chain is used
 *      ONLY when `options.allowAmbientAwsCreds` is set (the static-config path).
 *   2. **Basic** — `username` + `password` (both required together).
 *   3. **API key** — `apiKey`.
 *
 * Errors never echo a secret. A lone `username` (or lone `password`) is a config
 * mistake and is rejected explicitly rather than silently falling through.
 */
export function resolveAuth(
  config: ElasticsearchPluginConfig,
  options?: ResolveAuthOptions,
): ElasticsearchAuthDescriptor {
  const allowAmbient = options?.allowAmbientAwsCreds ?? false;
  const apiKey = typeof config.apiKey === "string" ? config.apiKey.trim() : "";
  const username = typeof config.username === "string" ? config.username.trim() : "";
  const password = typeof config.password === "string" ? config.password : "";
  const awsRegion = typeof config.awsRegion === "string" ? config.awsRegion.trim() : "";

  // 1. AWS SigV4 — `awsRegion` is the selecting signal. The ambient AWS env
  // chain is consulted only on the static-config path (`allowAmbient`); a
  // DB-stored per-workspace config must carry explicit keys (no operator-env
  // bleed-through on multi-tenant deploys).
  if (awsRegion) {
    const env = (name: string): string =>
      allowAmbient ? (process.env[name] ?? "").trim() : "";
    const accessKeyId =
      (typeof config.awsAccessKeyId === "string" ? config.awsAccessKeyId.trim() : "") ||
      env("AWS_ACCESS_KEY_ID");
    const secretAccessKey =
      (typeof config.awsSecretAccessKey === "string" ? config.awsSecretAccessKey.trim() : "") ||
      env("AWS_SECRET_ACCESS_KEY");
    const sessionToken =
      (typeof config.awsSessionToken === "string" ? config.awsSessionToken.trim() : "") ||
      env("AWS_SESSION_TOKEN");
    if (!accessKeyId || !secretAccessKey) {
      throw new Error(
        "Invalid Elasticsearch config: AWS SigV4 selected (awsRegion set) but no credentials — " +
          (allowAmbient
            ? "set awsAccessKeyId/awsSecretAccessKey or the AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY environment variables."
            : "set awsAccessKeyId/awsSecretAccessKey (a stored per-workspace datasource must carry its own keys)."),
      );
    }
    const service =
      (typeof config.awsService === "string" ? config.awsService.trim() : "") || DEFAULT_AWS_SERVICE;
    return {
      mode: "sigv4",
      accessKeyId,
      secretAccessKey,
      region: awsRegion,
      service,
      ...(sessionToken ? { sessionToken } : {}),
    };
  }

  // 2. HTTP Basic — both username and password required.
  if (username || password) {
    if (!username || !password) {
      throw new Error(
        "Invalid Elasticsearch config: HTTP Basic auth requires both a username and a password.",
      );
    }
    return { mode: "basic", username, password };
  }

  // 3. API key.
  if (apiKey) {
    return { mode: "apiKey", apiKey };
  }

  throw new Error(
    "Invalid Elasticsearch config: no authentication configured — provide an API key, " +
      "a username/password, or AWS SigV4 credentials (awsRegion).",
  );
}

/**
 * Resolve a raw plugin config into the typed connection config: engine, HTTP(S)
 * endpoint, and auth descriptor.
 *
 * - **Endpoint** comes from `cloudId` (decoded) or `url`; supplying both is a
 *   config error.
 * - **Engine** precedence: explicit `engine` config → URL scheme → default
 *   `elasticsearch` (a Cloud ID, with no scheme, defaults to `elasticsearch`).
 * - **Auth** is picked by {@link resolveAuth} (`options` forwarded — notably
 *   `allowAmbientAwsCreds`, which the static-config path sets and the
 *   per-workspace `createFromConfig` path does not).
 *
 * Error messages never echo a secret.
 */
export function resolveElasticsearchConfig(
  config: ElasticsearchPluginConfig,
  options?: ResolveAuthOptions,
): ResolvedElasticsearchConfig {
  const hasUrl = typeof config.url === "string" && config.url.trim().length > 0;
  const hasCloudId = typeof config.cloudId === "string" && config.cloudId.trim().length > 0;

  if (hasUrl && hasCloudId) {
    throw new Error(
      "Invalid Elasticsearch config: provide either a url or a cloudId, not both.",
    );
  }

  let endpoint: string;
  let schemeEngine: ElasticsearchEngine | undefined;
  if (hasCloudId) {
    endpoint = decodeCloudId(config.cloudId!);
  } else if (hasUrl) {
    const parsed = parseElasticsearchUrl(config.url!);
    endpoint = parsed.endpoint;
    schemeEngine = parsed.engine;
  } else {
    throw new Error(
      "Invalid Elasticsearch config: provide a connection url or an Elastic Cloud ID.",
    );
  }

  const engine: ElasticsearchEngine = config.engine ?? schemeEngine ?? "elasticsearch";
  const auth = resolveAuth(config, options);

  return {
    engine,
    endpoint,
    auth,
    ...(config.description ? { description: config.description } : {}),
  };
}

/**
 * Whether a config describes a complete, self-contained datasource (vs an
 * adapter-only registration). True when an endpoint source (`url`/`cloudId`) AND
 * an auth signal (`apiKey` / `username`+`password` / `awsRegion`) are present.
 * Used to decide static-connection vs SaaS per-workspace registration.
 */
export function isCompleteConnectionConfig(config: ElasticsearchPluginConfig): boolean {
  const hasEndpoint = Boolean(config.url || config.cloudId);
  const hasAuth = Boolean(
    config.apiKey || (config.username && config.password) || config.awsRegion,
  );
  return hasEndpoint && hasAuth;
}

/** Every secret string in a resolved auth descriptor — for error scrubbing. */
export function collectAuthSecrets(auth: ElasticsearchAuthDescriptor): string[] {
  switch (auth.mode) {
    case "apiKey":
      return [auth.apiKey];
    case "basic":
      return [auth.password];
    case "sigv4":
      return [auth.secretAccessKey, ...(auth.sessionToken ? [auth.sessionToken] : [])];
  }
}

/** Every secret string present in a raw config — for error scrubbing pre-resolve. */
export function collectConfigSecrets(config: ElasticsearchPluginConfig): string[] {
  return [
    config.apiKey,
    config.password,
    config.awsSecretAccessKey,
    config.awsSessionToken,
  ].filter((s): s is string => typeof s === "string" && s.length > 0);
}

// ---------------------------------------------------------------------------
// Per-engine SQL surface (#3266)
// ---------------------------------------------------------------------------

interface EngineSqlProfile {
  /** SQL endpoint path. */
  sqlPath: string;
  /** Cursor-close endpoint path. */
  sqlClosePath: string;
  /** `format` query param value. */
  format: string;
}

/**
 * Per-engine SQL routing. Elasticsearch SQL lives at `/_sql` and returns
 * `{ columns, rows, cursor }` (`format=json`); the OpenSearch SQL plugin lives at
 * `/_plugins/_sql` and returns `{ schema, datarows, cursor }` (`format=jdbc`).
 * Both follow `cursor` pagination and close at `<base>/close`.
 */
export function engineSqlProfile(engine: ElasticsearchEngine): EngineSqlProfile {
  return engine === "opensearch"
    ? { sqlPath: "/_plugins/_sql", sqlClosePath: "/_plugins/_sql/close", format: "jdbc" }
    : { sqlPath: "/_sql", sqlClosePath: "/_sql/close", format: "json" };
}

/**
 * Map a raw engine SQL response page into the canonical
 * {@link ElasticsearchSqlResponse} (`{ columns, rows, cursor }`) so
 * {@link normalizeSqlPages} folds both engines unchanged. Elasticsearch already
 * uses `columns`/`rows`; OpenSearch's jdbc format uses `schema`/`datarows`. Both
 * paginate with `cursor`.
 */
export function parseSqlPage(
  raw: unknown,
  engine: ElasticsearchEngine,
): ElasticsearchSqlResponse {
  const r = (raw ?? {}) as Record<string, unknown>;
  const cursor = typeof r.cursor === "string" ? r.cursor : undefined;
  const colsKey = engine === "opensearch" ? "schema" : "columns";
  const rowsKey = engine === "opensearch" ? "datarows" : "rows";
  return {
    columns: Array.isArray(r[colsKey]) ? (r[colsKey] as ElasticsearchSqlColumn[]) : undefined,
    rows: Array.isArray(r[rowsKey]) ? (r[rowsKey] as unknown[][]) : undefined,
    ...(cursor ? { cursor } : {}),
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
   * Fetch alias → backing-index mappings (`GET /_alias`). Powers the `atlas init`
   * profiler's alias entities (#3269). Carries no credential; errors are
   * status-only and key-scrubbed, exactly like `getMapping`.
   */
  getAliases(timeoutMs?: number): Promise<EsAliasResponse>;
  /**
   * Fetch data streams (`GET /_data_stream`). Powers the `atlas init` profiler's
   * data-stream entities (#3269). Carries no credential; errors are status-only
   * and key-scrubbed, exactly like `getMapping`.
   */
  getDataStreams(timeoutMs?: number): Promise<EsDataStreamResponse>;
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
  const { endpoint, auth, engine } = resolved;
  const secrets = collectAuthSecrets(auth);
  const sqlProfile = engineSqlProfile(engine);
  let closed = false;
  const inFlight = new Set<AbortController>();

  /**
   * Build the per-request headers for the configured auth mode. API-key and
   * Basic add a constant `Authorization`; SigV4 signs the exact (method, url,
   * body) tuple fresh each call (every page has a distinct body). `Content-Type`
   * is added only for a non-empty body so GETs stay unsigned-content clean.
   */
  function buildHeaders(method: string, url: string, body: string): Record<string, string> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (body.length > 0) headers["Content-Type"] = "application/json";
    switch (auth.mode) {
      case "apiKey":
        headers.Authorization = `ApiKey ${auth.apiKey}`;
        break;
      case "basic":
        headers.Authorization = `Basic ${Buffer.from(`${auth.username}:${auth.password}`, "utf8").toString("base64")}`;
        break;
      case "sigv4":
        Object.assign(
          headers,
          sigV4SignHeaders({
            method,
            url,
            body,
            region: auth.region,
            service: auth.service,
            accessKeyId: auth.accessKeyId,
            secretAccessKey: auth.secretAccessKey,
            ...(auth.sessionToken ? { sessionToken: auth.sessionToken } : {}),
          }),
        );
        break;
      default: {
        // Exhaustiveness: a new auth mode must add a case here. Without this a
        // forgotten mode would fall through and send an UNAUTHENTICATED request
        // (no Authorization) — a compile error is far safer than that.
        const _exhaustive: never = auth;
        throw new Error(
          `Unhandled Elasticsearch auth mode: ${(_exhaustive as { mode?: string }).mode ?? "unknown"}`,
        );
      }
    }
    return headers;
  }

  /**
   * Shared GET-and-parse for the credential-free metadata endpoints (`/_alias`,
   * `/_data_stream`). Mirrors `getMapping`: own abort/timeout, status-only error
   * (the body can echo the credential), secret-scrubbed catch. `label` only
   * shapes the timeout/error message. The body is unchecked JSON — the pure
   * parsers (`parseAliases` / `parseDataStreams`) narrow it defensively.
   */
  async function readJson<T>(path: string, label: string, timeoutMs: number): Promise<T> {
    if (closed) {
      throw new Error("Elasticsearch client is closed");
    }

    const fetchImpl = options?.fetchImpl ?? globalThis.fetch;
    const controller = new AbortController();
    inFlight.add(controller);
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const url = `${endpoint}${path}`;
    try {
      const res = await fetchImpl(url, {
        method: "GET",
        headers: buildHeaders("GET", url, ""),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(
          `Elasticsearch ${label} request failed: HTTP ${res.status} ${res.statusText}`,
        );
      }
      return (await res.json()) as T;
    } catch (err) {
      if (controller.signal.aborted && !closed) {
        throw new Error(`Elasticsearch ${label} request timed out after ${timeoutMs}ms`);
      }
      throw new Error(scrubElasticsearchError(err, secrets));
    } finally {
      clearTimeout(timer);
      inFlight.delete(controller);
    }
  }

  return {
    async ping(timeoutMs = 5000): Promise<ClusterInfo> {
      if (closed) {
        throw new Error("Elasticsearch client is closed");
      }

      const fetchImpl = options?.fetchImpl ?? globalThis.fetch;
      const controller = new AbortController();
      inFlight.add(controller);
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      const url = `${endpoint}/`;
      try {
        const res = await fetchImpl(url, {
          method: "GET",
          headers: buildHeaders("GET", url, ""),
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
        throw new Error(scrubElasticsearchError(err, secrets));
      } finally {
        clearTimeout(timer);
        inFlight.delete(controller);
      }
    },

    async getMapping(
      index?: string,
      timeoutMs = 10000,
    ): Promise<EsMappingResponse> {
      // `GET /_mapping` (all indices) or `GET /<index>/_mapping` (one). The
      // index segment is URL-encoded so reserved characters can't escape the path.
      const path = index ? `/${encodeURIComponent(index)}/_mapping` : "/_mapping";
      return readJson<EsMappingResponse>(path, "mapping", timeoutMs);
    },

    async getAliases(timeoutMs = 10000): Promise<EsAliasResponse> {
      return readJson<EsAliasResponse>("/_alias", "alias", timeoutMs);
    },

    async getDataStreams(timeoutMs = 10000): Promise<EsDataStreamResponse> {
      return readJson<EsDataStreamResponse>("/_data_stream", "data-stream", timeoutMs);
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

      // Engine-routed SQL endpoint (`/_sql` vs `/_plugins/_sql`, json vs jdbc).
      const sqlUrl = `${endpoint}${sqlProfile.sqlPath}?format=${sqlProfile.format}`;
      const closeUrl = `${endpoint}${sqlProfile.sqlClosePath}`;

      /** POST a payload to the engine SQL endpoint; return the canonical page. */
      const postSql = async (
        payload: Record<string, unknown>,
      ): Promise<ElasticsearchSqlResponse> => {
        const body = JSON.stringify(payload);
        const res = await fetchImpl(sqlUrl, {
          method: "POST",
          headers: buildHeaders("POST", sqlUrl, body),
          body,
          signal: controller.signal,
        });
        if (!res.ok) {
          // Read the body for the actionable ES error reason; fall back to the
          // status line if it isn't JSON. The message is scrubbed in the catch.
          let errBody: unknown;
          try {
            errBody = await res.json();
          } catch {
            // intentionally ignored: a non-JSON error body just falls back to
            // the HTTP status line via extractEsSqlErrorMessage.
            errBody = undefined;
          }
          throw new Error(extractEsSqlErrorMessage(errBody, res.status, res.statusText));
        }
        return parseSqlPage(await res.json(), engine);
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
            const closeBody = JSON.stringify({ cursor: page.cursor });
            await fetchImpl(closeUrl, {
              method: "POST",
              headers: buildHeaders("POST", closeUrl, closeBody),
              body: closeBody,
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
        throw new Error(scrubElasticsearchError(err, secrets));
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
      // wildcards / _all / non-whitelisted indices. The DSL endpoint
      // (`/<index>/_search` | `_count`) is identical on Elasticsearch + OpenSearch.
      const indexPath = index
        .split(",")
        .map((s) => encodeURIComponent(s.trim()))
        .filter((s) => s.length > 0)
        .join(",");

      const fetchImpl = options?.fetchImpl ?? globalThis.fetch;
      const controller = new AbortController();
      inFlight.add(controller);
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      const url = `${endpoint}/${indexPath}/${op}`;
      const requestBody = JSON.stringify(safeBody);
      try {
        const res = await fetchImpl(url, {
          method: "POST",
          headers: buildHeaders("POST", url, requestBody),
          body: requestBody,
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
        throw new Error(scrubElasticsearchError(err, secrets));
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
 * `allowAmbientAwsCreds` is forwarded to {@link resolveElasticsearchConfig}: the
 * static `atlas.config.ts` path sets it (operator-baked, self-hosted) so SigV4
 * may use the ambient AWS env chain; the per-workspace `createFromConfig` path
 * leaves it `false` so a stored config must carry its own explicit keys.
 *
 * @throws {Error} If the config is invalid (delegates to
 *   {@link resolveElasticsearchConfig}; secrets are never echoed).
 */
export function createElasticsearchConnection(
  config: ElasticsearchPluginConfig,
  options?: ElasticsearchClientOptions & ResolveAuthOptions,
): ElasticsearchConnection {
  const resolved = resolveElasticsearchConfig(config, {
    allowAmbientAwsCreds: options?.allowAmbientAwsCreds,
  });
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
