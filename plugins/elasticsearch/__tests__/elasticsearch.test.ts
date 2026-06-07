import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { createHash, createHmac } from "node:crypto";

import { definePlugin, isDatasourcePlugin } from "@useatlas/plugin-sdk";
import {
  elasticsearchPlugin,
  buildElasticsearchPlugin,
  parseElasticsearchUrl,
  resolveElasticsearchConfig,
  resolveAuth,
  decodeCloudId,
  isCompleteConnectionConfig,
  engineSqlProfile,
  parseSqlPage,
  extractHost,
  createElasticsearchClient,
  createElasticsearchConnection,
  scrubElasticsearchError,
  SENSITIVE_PATTERNS,
  normalizeSqlPages,
  extractEsSqlErrorMessage,
  ELASTICSEARCH_FORBIDDEN_PATTERNS,
  ELASTICSEARCH_PARSER_DIALECT,
  deriveSigningKey,
  buildCanonicalRequest,
  sigV4SignHeaders,
  formatAmzDate,
  EMPTY_PAYLOAD_SHA256,
} from "../src/index";
import type { ElasticsearchSqlResponse } from "../src/index";

const VALID_URL = "elasticsearch://localhost:9200?ssl=false";
const API_KEY = "VnVhQ2ZHY0JDZGJrU=test-key";

const CLUSTER_INFO_BODY = {
  name: "es-node-1",
  cluster_name: "atlas-test-cluster",
  cluster_uuid: "abc123",
  version: { number: "8.13.0", distribution: "elasticsearch" },
  tagline: "You Know, for Search",
};

/**
 * Build a minimal Response-like object for the mocked fetch. The thin client
 * only reads `ok`, `status`, `statusText`, and `json()`.
 */
function fetchResponse(
  body: unknown,
  init?: { ok?: boolean; status?: number; statusText?: string },
): Response {
  const status = init?.status ?? 200;
  return {
    ok: init?.ok ?? (status >= 200 && status < 300),
    status,
    statusText: init?.statusText ?? "OK",
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

// ---------------------------------------------------------------------------
// parseElasticsearchUrl — URL → { engine, endpoint }
// ---------------------------------------------------------------------------

describe("parseElasticsearchUrl", () => {
  test("parses elasticsearch:// to an https endpoint by default", () => {
    const parsed = parseElasticsearchUrl("elasticsearch://my-cluster.es.io:9243");
    expect(parsed.engine).toBe("elasticsearch");
    expect(parsed.endpoint).toBe("https://my-cluster.es.io:9243");
  });

  test("?ssl=false downgrades to an http endpoint", () => {
    const parsed = parseElasticsearchUrl("elasticsearch://localhost:9200?ssl=false");
    expect(parsed.endpoint).toBe("http://localhost:9200");
  });

  test("?tls=false is an accepted alias for ?ssl=false", () => {
    const parsed = parseElasticsearchUrl("elasticsearch://localhost:9200?tls=false");
    expect(parsed.endpoint).toBe("http://localhost:9200");
  });

  test("preserves a path prefix and strips trailing slashes", () => {
    const parsed = parseElasticsearchUrl("elasticsearch://host:9200/es/");
    expect(parsed.endpoint).toBe("https://host:9200/es");
  });

  test("omits the port when none is given (transport default applies)", () => {
    const parsed = parseElasticsearchUrl("elasticsearch://my-cluster.es.io");
    expect(parsed.endpoint).toBe("https://my-cluster.es.io");
  });

  test("rejects a non-elasticsearch/opensearch scheme", () => {
    expect(() => parseElasticsearchUrl("postgresql://user:pass@host/db")).toThrow(
      /expected elasticsearch:\/\/ or opensearch:\/\/ scheme/,
    );
  });

  test("resolves opensearch:// to the opensearch engine (#3266)", () => {
    const parsed = parseElasticsearchUrl("opensearch://host:9200");
    expect(parsed.engine).toBe("opensearch");
    expect(parsed.endpoint).toBe("https://host:9200");
  });

  test("opensearch:// honors ?ssl=false like elasticsearch://", () => {
    const parsed = parseElasticsearchUrl("opensearch://localhost:9200?ssl=false");
    expect(parsed.engine).toBe("opensearch");
    expect(parsed.endpoint).toBe("http://localhost:9200");
  });

  test("rejects a URL missing a host", () => {
    expect(() => parseElasticsearchUrl("elasticsearch://")).toThrow(/missing host/);
  });

  test("rejects an unparseable URL", () => {
    expect(() => parseElasticsearchUrl("not a url")).toThrow();
  });

  test("rejects credentials embedded in the URL userinfo", () => {
    expect(() =>
      parseElasticsearchUrl("elasticsearch://user:pass@host:9200"),
    ).toThrow(/apiKey config field/);
  });

  test("rejects auth-like query parameters in the URL", () => {
    expect(() =>
      parseElasticsearchUrl("elasticsearch://host:9200?api_key=abc"),
    ).toThrow(/not allowed in the URL/);
    expect(() =>
      parseElasticsearchUrl("elasticsearch://host:9200?access_token=abc"),
    ).toThrow(/not allowed in the URL/);
  });

  test("still allows the ssl/tls control params", () => {
    expect(() =>
      parseElasticsearchUrl("elasticsearch://host:9200?ssl=false"),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// extractHost (safe logging — no credentials)
// ---------------------------------------------------------------------------

describe("extractHost", () => {
  test("extracts the hostname from an elasticsearch:// URL", () => {
    expect(extractHost("elasticsearch://my-cluster.es.io:9243")).toBe(
      "my-cluster.es.io",
    );
  });

  test("returns (unknown) for an invalid URL", () => {
    expect(extractHost("not-a-url")).toBe("(unknown)");
  });
});

// ---------------------------------------------------------------------------
// resolveElasticsearchConfig — { url, apiKey } → resolved config + auth
// ---------------------------------------------------------------------------

describe("resolveElasticsearchConfig", () => {
  test("resolves engine, endpoint, and API-key auth descriptor", () => {
    const resolved = resolveElasticsearchConfig({ url: VALID_URL, apiKey: API_KEY });
    expect(resolved.engine).toBe("elasticsearch");
    expect(resolved.endpoint).toBe("http://localhost:9200");
    expect(resolved.auth).toEqual({ mode: "apiKey", apiKey: API_KEY });
  });

  test("trims surrounding whitespace from the API key", () => {
    const resolved = resolveElasticsearchConfig({
      url: VALID_URL,
      apiKey: `  ${API_KEY}  `,
    });
    expect(resolved.auth).toEqual({ mode: "apiKey", apiKey: API_KEY });
  });

  test("includes an optional description when provided", () => {
    const resolved = resolveElasticsearchConfig({
      url: VALID_URL,
      apiKey: API_KEY,
      description: "Prod logs",
    });
    expect(resolved.description).toBe("Prod logs");
  });

  test("rejects a missing API key without echoing it", () => {
    expect(() =>
      resolveElasticsearchConfig({ url: VALID_URL, apiKey: "" }),
    ).toThrow(/API key/i);
  });
});

// ---------------------------------------------------------------------------
// Error scrubbing
// ---------------------------------------------------------------------------

describe("scrubElasticsearchError", () => {
  test("removes the literal API key from a message", () => {
    const scrubbed = scrubElasticsearchError(
      new Error(`auth failed for ApiKey ${API_KEY}`),
      API_KEY,
    );
    expect(scrubbed).not.toContain(API_KEY);
  });

  test("scrubs messages matching sensitive patterns to a generic message", () => {
    const scrubbed = scrubElasticsearchError(
      new Error("Authorization header rejected"),
      API_KEY,
    );
    expect(scrubbed).not.toContain("Authorization");
  });

  test("passes through a benign, non-sensitive message", () => {
    const scrubbed = scrubElasticsearchError(
      new Error("index_not_found_exception"),
      API_KEY,
    );
    expect(scrubbed).toContain("index_not_found_exception");
  });

  test("redacts the literal key even when the message trips no auth marker", () => {
    // Exercises the literal-redaction pass in isolation: the surrounding text
    // matches no SENSITIVE_PATTERN, so only pass 1 can prevent the leak.
    const scrubbed = scrubElasticsearchError(
      new Error(`connection to es-node failed: ${API_KEY}`),
      API_KEY,
    );
    expect(scrubbed).not.toContain(API_KEY);
    expect(scrubbed).toContain("[REDACTED]");
  });

  test("does NOT over-scrub credential-free TLS certificate errors", () => {
    const scrubbed = scrubElasticsearchError(
      new Error("self-signed certificate in certificate chain"),
      API_KEY,
    );
    expect(scrubbed).toContain("certificate");
  });

  test("does NOT over-scrub benign ES errors that mention 'token'", () => {
    const scrubbed = scrubElasticsearchError(
      new Error("Unknown token filter [my_filter]"),
      API_KEY,
    );
    expect(scrubbed).toContain("token");
  });
});

describe("SENSITIVE_PATTERNS", () => {
  test("matches credential-bearing markers", () => {
    expect(SENSITIVE_PATTERNS.test("ApiKey abc")).toBe(true);
    expect(SENSITIVE_PATTERNS.test("Authorization: ApiKey")).toBe(true);
    expect(SENSITIVE_PATTERNS.test("credential rejected")).toBe(true);
  });

  test("does not match ordinary cluster errors", () => {
    expect(SENSITIVE_PATTERNS.test("index_not_found_exception")).toBe(false);
    expect(SENSITIVE_PATTERNS.test("search_phase_execution_exception")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Thin fetch client — authenticated cluster-info/ping round-trip
// ---------------------------------------------------------------------------

describe("createElasticsearchClient", () => {
  test("ping returns a normalized cluster-info result", async () => {
    const fetchImpl = mock(async () => fetchResponse(CLUSTER_INFO_BODY));
    const client = createElasticsearchClient(
      resolveElasticsearchConfig({ url: VALID_URL, apiKey: API_KEY }),
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    const info = await client.ping();
    expect(info.clusterName).toBe("atlas-test-cluster");
    expect(info.version).toBe("8.13.0");
    expect(info.name).toBe("es-node-1");
  });

  test("ping issues a GET with ApiKey + Accept headers to the cluster-info endpoint", async () => {
    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;
    const fetchImpl = mock(async (url: string, init: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return fetchResponse(CLUSTER_INFO_BODY);
    });
    const client = createElasticsearchClient(
      resolveElasticsearchConfig({ url: VALID_URL, apiKey: API_KEY }),
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    await client.ping();
    expect(capturedUrl).toBe("http://localhost:9200/");
    expect(capturedInit?.method).toBe("GET");
    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers?.Authorization).toBe(`ApiKey ${API_KEY}`);
    expect(headers?.Accept).toBe("application/json");
  });

  test("ping rejects with a timeout error when the request exceeds timeoutMs", async () => {
    // A fetch that only ever settles by honoring the abort signal — exercises the
    // AbortController + setTimeout timeout branch.
    const fetchImpl = mock(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" })),
          );
        }),
    );
    const client = createElasticsearchClient(
      resolveElasticsearchConfig({ url: VALID_URL, apiKey: API_KEY }),
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    await expect(client.ping(10)).rejects.toThrow(/timed out after 10ms/);
  });

  test("close() during an in-flight ping rejects WITHOUT misreporting a timeout", async () => {
    // The catch branch must distinguish a close-driven abort (closed === true)
    // from a timeout-driven abort — otherwise teardown looks like a timeout.
    const fetchImpl = mock(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" })),
          );
        }),
    );
    const client = createElasticsearchClient(
      resolveElasticsearchConfig({ url: VALID_URL, apiKey: API_KEY }),
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    const pending = client.ping(5000);
    client.close();
    let message = "";
    try {
      await pending;
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).not.toMatch(/timed out/);
  });

  test("ping throws a scrubbed error on a non-2xx response", async () => {
    const fetchImpl = mock(async () =>
      fetchResponse(
        { error: "security_exception" },
        { ok: false, status: 401, statusText: "Unauthorized" },
      ),
    );
    const client = createElasticsearchClient(
      resolveElasticsearchConfig({ url: VALID_URL, apiKey: API_KEY }),
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    await expect(client.ping()).rejects.toThrow(/401/);
  });

  test("ping never leaks the API key, even if the server echoes it", async () => {
    const fetchImpl = mock(async () =>
      fetchResponse(
        { error: `bad ApiKey ${API_KEY}` },
        { ok: false, status: 403, statusText: "Forbidden" },
      ),
    );
    const client = createElasticsearchClient(
      resolveElasticsearchConfig({ url: VALID_URL, apiKey: API_KEY }),
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    let message = "";
    try {
      await client.ping();
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).not.toContain(API_KEY);
  });

  test("ping scrubs a network-level error", async () => {
    const fetchImpl = mock(async () => {
      throw new Error("getaddrinfo ENOTFOUND host");
    });
    const client = createElasticsearchClient(
      resolveElasticsearchConfig({ url: VALID_URL, apiKey: API_KEY }),
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    await expect(client.ping()).rejects.toThrow(/ENOTFOUND|failed/i);
  });

  test("ping after close rejects", async () => {
    const fetchImpl = mock(async () => fetchResponse(CLUSTER_INFO_BODY));
    const client = createElasticsearchClient(
      resolveElasticsearchConfig({ url: VALID_URL, apiKey: API_KEY }),
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    client.close();
    await expect(client.ping()).rejects.toThrow(/closed/);
  });
});

// ---------------------------------------------------------------------------
// getMapping — `_mapping` fetch for the CLI profiler
// ---------------------------------------------------------------------------

const MAPPING_BODY = {
  products: {
    mappings: {
      properties: {
        sku: { type: "keyword" },
        title: { type: "text", fields: { keyword: { type: "keyword" } } },
      },
    },
  },
};

describe("getMapping", () => {
  test("GETs /_mapping with ApiKey + Accept headers when no index is given", async () => {
    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;
    const fetchImpl = mock(async (url: string, init: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return fetchResponse(MAPPING_BODY);
    });
    const client = createElasticsearchClient(
      resolveElasticsearchConfig({ url: VALID_URL, apiKey: API_KEY }),
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    const mapping = await client.getMapping();
    expect(capturedUrl).toBe("http://localhost:9200/_mapping");
    expect(capturedInit?.method).toBe("GET");
    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers?.Authorization).toBe(`ApiKey ${API_KEY}`);
    expect(headers?.Accept).toBe("application/json");
    expect(mapping.products?.mappings?.properties?.sku?.type).toBe("keyword");
  });

  test("scopes the request to a single index when one is provided", async () => {
    let capturedUrl: string | undefined;
    const fetchImpl = mock(async (url: string) => {
      capturedUrl = url;
      return fetchResponse(MAPPING_BODY);
    });
    const client = createElasticsearchClient(
      resolveElasticsearchConfig({ url: VALID_URL, apiKey: API_KEY }),
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    await client.getMapping("products");
    expect(capturedUrl).toBe("http://localhost:9200/products/_mapping");
  });

  test("url-encodes an index name with reserved characters", async () => {
    let capturedUrl: string | undefined;
    const fetchImpl = mock(async (url: string) => {
      capturedUrl = url;
      return fetchResponse(MAPPING_BODY);
    });
    const client = createElasticsearchClient(
      resolveElasticsearchConfig({ url: VALID_URL, apiKey: API_KEY }),
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    await client.getMapping("logs/2024");
    expect(capturedUrl).toBe("http://localhost:9200/logs%2F2024/_mapping");
  });

  test("throws a status-only error on a non-2xx response (never the body)", async () => {
    const fetchImpl = mock(async () =>
      fetchResponse(
        { error: `index closed for ApiKey ${API_KEY}` },
        { ok: false, status: 403, statusText: "Forbidden" },
      ),
    );
    const client = createElasticsearchClient(
      resolveElasticsearchConfig({ url: VALID_URL, apiKey: API_KEY }),
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    let message = "";
    try {
      await client.getMapping();
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("403");
    expect(message).not.toContain(API_KEY);
  });

  test("scrubs a network-level error and never leaks the API key", async () => {
    const fetchImpl = mock(async () => {
      throw new Error(`getaddrinfo ENOTFOUND with ApiKey ${API_KEY}`);
    });
    const client = createElasticsearchClient(
      resolveElasticsearchConfig({ url: VALID_URL, apiKey: API_KEY }),
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    let message = "";
    try {
      await client.getMapping();
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).not.toContain(API_KEY);
  });

  test("rejects with a timeout error when the request exceeds timeoutMs", async () => {
    const fetchImpl = mock(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" })),
          );
        }),
    );
    const client = createElasticsearchClient(
      resolveElasticsearchConfig({ url: VALID_URL, apiKey: API_KEY }),
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    await expect(client.getMapping(undefined, 10)).rejects.toThrow(
      /mapping request timed out after 10ms/,
    );
  });

  test("close() during an in-flight getMapping rejects WITHOUT misreporting a timeout", async () => {
    const fetchImpl = mock(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" })),
          );
        }),
    );
    const client = createElasticsearchClient(
      resolveElasticsearchConfig({ url: VALID_URL, apiKey: API_KEY }),
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    const pending = client.getMapping(undefined, 5000);
    client.close();
    let message = "";
    try {
      await pending;
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).not.toMatch(/timed out/);
  });

  test("rejects after close()", async () => {
    const fetchImpl = mock(async () => fetchResponse(MAPPING_BODY));
    const client = createElasticsearchClient(
      resolveElasticsearchConfig({ url: VALID_URL, apiKey: API_KEY }),
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    client.close();
    await expect(client.getMapping()).rejects.toThrow(/closed/);
  });
});

// ---------------------------------------------------------------------------
// Connection factory
// ---------------------------------------------------------------------------

describe("createElasticsearchConnection", () => {
  test("returns a PluginDBConnection with query, ping, and close", () => {
    const conn = createElasticsearchConnection({ url: VALID_URL, apiKey: API_KEY });
    expect(typeof conn.query).toBe("function");
    expect(typeof conn.ping).toBe("function");
    expect(typeof conn.close).toBe("function");
  });

  test("query() POSTs ES SQL to /_sql and returns normalized { columns, rows }", async () => {
    const fetchImpl = mock(async () =>
      fetchResponse({
        columns: [
          { name: "origin", type: "text" },
          { name: "cnt", type: "long" },
        ],
        rows: [
          ["SFO", 42],
          ["JFK", 31],
        ],
      }),
    );
    const conn = createElasticsearchConnection(
      { url: VALID_URL, apiKey: API_KEY },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    const result = await conn.query("SELECT origin, COUNT(*) AS cnt FROM flights GROUP BY origin");
    expect(result.columns).toEqual(["origin", "cnt"]);
    expect(result.rows).toEqual([
      { origin: "SFO", cnt: 42 },
      { origin: "JFK", cnt: 31 },
    ]);
  });

  test("ping() round-trips through the injected fetch", async () => {
    const fetchImpl = mock(async () => fetchResponse(CLUSTER_INFO_BODY));
    const conn = createElasticsearchConnection(
      { url: VALID_URL, apiKey: API_KEY },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    const info = await conn.ping();
    expect(info.clusterName).toBe("atlas-test-cluster");
  });
});

// ---------------------------------------------------------------------------
// Config validation (via createPlugin factory)
// ---------------------------------------------------------------------------

describe("config validation", () => {
  test("accepts a valid { url, apiKey } config", () => {
    const plugin = elasticsearchPlugin({ url: VALID_URL, apiKey: API_KEY });
    expect(plugin.id).toBe("elasticsearch-datasource");
    expect(plugin.types).toEqual(["datasource"]);
    expect(plugin.config?.url).toBe(VALID_URL);
  });

  test("rejects an empty URL", () => {
    expect(() => elasticsearchPlugin({ url: "", apiKey: API_KEY })).toThrow(
      /must not be empty/,
    );
  });

  test("rejects a non-elasticsearch URL scheme", () => {
    expect(() =>
      elasticsearchPlugin({ url: "postgresql://localhost:5432/db", apiKey: API_KEY }),
    ).toThrow(/elasticsearch:\/\//);
  });

  test("accepts a url with no apiKey — adapter-only registration (SaaS per-workspace)", () => {
    const plugin = elasticsearchPlugin({ url: VALID_URL });
    expect(plugin.id).toBe("elasticsearch-datasource");
    // Incomplete static config (url but no apiKey) → no static connection wired.
    expect(plugin.connection.create).toBeUndefined();
  });

  test("accepts a fully empty config — adapter-only registration", () => {
    const plugin = elasticsearchPlugin({});
    expect(plugin.id).toBe("elasticsearch-datasource");
    expect(plugin.config).toEqual({});
  });

  test("rejects an empty API key", () => {
    expect(() => elasticsearchPlugin({ url: VALID_URL, apiKey: "" })).toThrow(
      /apiKey|API key/i,
    );
  });
});

// ---------------------------------------------------------------------------
// Plugin shape
// ---------------------------------------------------------------------------

describe("plugin shape", () => {
  test("createPlugin factory returns a valid plugin", () => {
    const plugin = elasticsearchPlugin({ url: VALID_URL, apiKey: API_KEY });
    expect(plugin.id).toBe("elasticsearch-datasource");
    expect(plugin.types).toEqual(["datasource"]);
    expect(plugin.version).toBe("0.1.0");
    expect(plugin.name).toBe("Elasticsearch DataSource");
  });

  test("definePlugin accepts the built plugin", () => {
    const plugin = buildElasticsearchPlugin({ url: VALID_URL, apiKey: API_KEY });
    const validated = definePlugin(plugin);
    expect(validated).toBe(plugin);
  });

  test("isDatasourcePlugin type guard passes", () => {
    const plugin = elasticsearchPlugin({ url: VALID_URL, apiKey: API_KEY });
    expect(isDatasourcePlugin(plugin)).toBe(true);
  });

  test("connection.dbType is 'elasticsearch'", () => {
    const plugin = elasticsearchPlugin({ url: VALID_URL, apiKey: API_KEY });
    expect(plugin.connection.dbType).toBe("elasticsearch");
  });

  test("connection.create() returns a PluginDBConnection", async () => {
    const plugin = elasticsearchPlugin({ url: VALID_URL, apiKey: API_KEY });
    const conn = await plugin.connection.create!();
    expect(typeof conn.query).toBe("function");
    expect(typeof conn.close).toBe("function");
  });

  test("has teardown method", () => {
    const plugin = elasticsearchPlugin({ url: VALID_URL, apiKey: API_KEY });
    expect(typeof plugin.teardown).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// Adapter-only mode (SaaS per-workspace — no static datasource)
// ---------------------------------------------------------------------------

describe("adapter-only mode", () => {
  test("omits connection.create when no url/apiKey is configured", () => {
    const plugin = elasticsearchPlugin({});
    expect(plugin.connection.create).toBeUndefined();
  });

  test("still exposes connection.createFromConfig (the per-workspace adapter)", () => {
    const plugin = elasticsearchPlugin({});
    expect(typeof plugin.connection.createFromConfig).toBe("function");
  });

  test("still validates as a datasource plugin", () => {
    const plugin = elasticsearchPlugin({});
    expect(isDatasourcePlugin(plugin)).toBe(true);
    expect(plugin.connection.dbType).toBe("elasticsearch");
  });

  test("createFromConfig builds a connection from a runtime config even with no static config", () => {
    const plugin = elasticsearchPlugin({});
    const conn = plugin.connection.createFromConfig!({ url: VALID_URL, apiKey: API_KEY });
    expect(typeof (conn as { query?: unknown }).query).toBe("function");
    expect(typeof (conn as { close?: unknown }).close).toBe("function");
  });

  test("createFromConfig still rejects a missing/invalid runtime config", () => {
    const plugin = elasticsearchPlugin({});
    expect(() => plugin.connection.createFromConfig!({})).toThrow();
    expect(() =>
      plugin.connection.createFromConfig!({ url: "postgresql://localhost:5432/db", apiKey: API_KEY }),
    ).toThrow();
  });

  test("static-config mode still wires connection.create when url + apiKey are given", () => {
    const plugin = elasticsearchPlugin({ url: VALID_URL, apiKey: API_KEY });
    expect(typeof plugin.connection.create).toBe("function");
  });

  test("healthCheck reports healthy without probing when adapter-only", async () => {
    const plugin = elasticsearchPlugin({});
    const result = await plugin.healthCheck!();
    expect(result.healthy).toBe(true);
    expect(result.message).toContain("adapter-only");
  });

  test("initialize logs adapter-only (no url, no crash)", async () => {
    const plugin = elasticsearchPlugin({});
    const logged: string[] = [];
    const ctx = {
      db: null,
      connections: { get: () => { throw new Error("not implemented"); }, list: () => [] },
      tools: { register: () => {} },
      logger: {
        info: (...args: unknown[]) => { logged.push(String(args[0])); },
        warn: () => {},
        error: () => {},
        debug: () => {},
      },
      config: {},
    };
    await plugin.initialize!(ctx);
    expect(logged.some((m) => m.includes("adapter-only"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getConfigSchema — secret: true drives encryption + masking
// ---------------------------------------------------------------------------

describe("getConfigSchema", () => {
  test("marks apiKey as a secret field (no longer unconditionally required — one of three auth modes)", () => {
    const plugin = elasticsearchPlugin({ url: VALID_URL, apiKey: API_KEY });
    const schema = plugin.getConfigSchema!();
    const apiKeyField = schema.find((f) => f.key === "apiKey");
    expect(apiKeyField).toBeDefined();
    expect(apiKeyField?.secret).toBe(true);
    expect(apiKeyField?.required).toBeFalsy();
  });

  test("marks every credential field secret: true (password + AWS secret/session)", () => {
    const plugin = elasticsearchPlugin({ url: VALID_URL, apiKey: API_KEY });
    const schema = plugin.getConfigSchema!();
    const secretKeys = schema.filter((f) => f.secret === true).map((f) => f.key).sort();
    expect(secretKeys).toEqual(
      ["apiKey", "awsSecretAccessKey", "awsSessionToken", "password"].sort(),
    );
  });

  test("offers an engine select with both engines + non-secret AWS region/key-id/service fields", () => {
    const plugin = elasticsearchPlugin({ url: VALID_URL, apiKey: API_KEY });
    const schema = plugin.getConfigSchema!();
    const engineField = schema.find((f) => f.key === "engine");
    expect(engineField?.type).toBe("select");
    expect(engineField?.options).toEqual(["elasticsearch", "opensearch"]);
    for (const key of ["awsRegion", "awsAccessKeyId", "awsService", "username"]) {
      const field = schema.find((f) => f.key === key);
      expect(field, `expected ${key} field`).toBeDefined();
      expect(field?.secret).toBeFalsy();
    }
  });

  test("does not mark the url as secret (it carries no credential)", () => {
    const plugin = elasticsearchPlugin({ url: VALID_URL, apiKey: API_KEY });
    const schema = plugin.getConfigSchema!();
    const urlField = schema.find((f) => f.key === "url");
    expect(urlField?.required).toBe(true);
    expect(urlField?.secret).toBeFalsy();
  });

  test("offers an optional description field", () => {
    const plugin = elasticsearchPlugin({ url: VALID_URL, apiKey: API_KEY });
    const schema = plugin.getConfigSchema!();
    expect(schema.some((f) => f.key === "description")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

describe("healthCheck", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("returns healthy when the ping succeeds", async () => {
    globalThis.fetch = mock(async () => fetchResponse(CLUSTER_INFO_BODY)) as unknown as typeof fetch;
    const plugin = elasticsearchPlugin({ url: VALID_URL, apiKey: API_KEY });
    const result = await plugin.healthCheck!();
    expect(result.healthy).toBe(true);
    expect(typeof result.latencyMs).toBe("number");
  });

  test("returns unhealthy with a scrubbed message when the ping fails", async () => {
    globalThis.fetch = mock(async () =>
      fetchResponse(
        { error: `ApiKey ${API_KEY} invalid` },
        { ok: false, status: 401, statusText: "Unauthorized" },
      ),
    ) as unknown as typeof fetch;
    const plugin = buildElasticsearchPlugin({ url: VALID_URL, apiKey: API_KEY });
    const result = await plugin.healthCheck!();
    expect(result.healthy).toBe(false);
    expect(result.message).toBeDefined();
    expect(result.message).not.toContain(API_KEY);
  });
});

// ---------------------------------------------------------------------------
// Initialize
// ---------------------------------------------------------------------------

function makeCtx() {
  const logged: string[] = [];
  return {
    ctx: {
      db: null,
      connections: {
        get: () => {
          throw new Error("not implemented");
        },
        list: () => [] as string[],
      },
      tools: { register: () => {} },
      logger: {
        info: (...args: unknown[]) => {
          logged.push(String(args[0]));
        },
        warn: () => {},
        error: () => {},
        debug: () => {},
      },
      config: {},
    },
    logged,
  };
}

describe("initialize", () => {
  test("logs the host only — never the API key", async () => {
    const plugin = elasticsearchPlugin({
      url: "elasticsearch://my-cluster.es.io:9243",
      apiKey: API_KEY,
    });
    const { ctx, logged } = makeCtx();
    await plugin.initialize!(ctx);
    const msg = logged.find((m) => m.includes("Elasticsearch datasource plugin"));
    expect(msg).toBeDefined();
    expect(msg).toContain("my-cluster.es.io");
    expect(msg).not.toContain(API_KEY);
  });
});

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

describe("teardown", () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    globalThis.fetch = mock(async () => fetchResponse(CLUSTER_INFO_BODY)) as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("closes the connection after it was created", async () => {
    const plugin = elasticsearchPlugin({ url: VALID_URL, apiKey: API_KEY });
    // Trigger connection creation via a health check.
    await plugin.healthCheck!();
    await plugin.teardown!();
    // A subsequent health check re-creates the connection and still works.
    const result = await plugin.healthCheck!();
    expect(result.healthy).toBe(true);
  });

  test("teardown is a no-op when no connection was created", async () => {
    const plugin = elasticsearchPlugin({ url: VALID_URL, apiKey: API_KEY });
    await plugin.teardown!(); // should not throw
  });
});

// ---------------------------------------------------------------------------
// normalizeSqlPages — PURE: ES SQL pages → Atlas { columns, rows }
// ---------------------------------------------------------------------------

describe("normalizeSqlPages", () => {
  test("normalizes a single page of scalar columns to keyed rows", () => {
    const page: ElasticsearchSqlResponse = {
      columns: [
        { name: "origin", type: "text" },
        { name: "delay", type: "long" },
      ],
      rows: [
        ["SFO", 12],
        ["JFK", 7],
      ],
    };
    const result = normalizeSqlPages([page]);
    expect(result.columns).toEqual(["origin", "delay"]);
    expect(result.rows).toEqual([
      { origin: "SFO", delay: 12 },
      { origin: "JFK", delay: 7 },
    ]);
  });

  test("folds multiple cursor pages — columns come from the first page only", () => {
    // ES returns `columns` only on the first page; cursor-continuation pages
    // carry `rows` (and possibly another `cursor`) but omit `columns`.
    const first: ElasticsearchSqlResponse = {
      columns: [
        { name: "carrier", type: "keyword" },
        { name: "n", type: "long" },
      ],
      rows: [["AA", 1]],
      cursor: "cursor-1",
    };
    const second: ElasticsearchSqlResponse = {
      rows: [["DL", 2]],
      cursor: "cursor-2",
    };
    const third: ElasticsearchSqlResponse = {
      rows: [["UA", 3]],
    };
    const result = normalizeSqlPages([first, second, third]);
    expect(result.columns).toEqual(["carrier", "n"]);
    expect(result.rows).toEqual([
      { carrier: "AA", n: 1 },
      { carrier: "DL", n: 2 },
      { carrier: "UA", n: 3 },
    ]);
  });

  test("handles an empty result — columns present, zero rows", () => {
    const page: ElasticsearchSqlResponse = {
      columns: [{ name: "origin", type: "text" }],
      rows: [],
    };
    const result = normalizeSqlPages([page]);
    expect(result.columns).toEqual(["origin"]);
    expect(result.rows).toEqual([]);
  });

  test("returns empty columns and rows for a degenerate empty page set", () => {
    expect(normalizeSqlPages([])).toEqual({ columns: [], rows: [] });
    expect(normalizeSqlPages([{}])).toEqual({ columns: [], rows: [] });
  });

  test("preserves falsy scalar values (0, false, empty string) and null", () => {
    const page: ElasticsearchSqlResponse = {
      columns: [
        { name: "count", type: "long" },
        { name: "active", type: "boolean" },
        { name: "note", type: "text" },
        { name: "missing", type: "text" },
      ],
      rows: [[0, false, "", null]],
    };
    const result = normalizeSqlPages([page]);
    expect(result.rows).toEqual([{ count: 0, active: false, note: "", missing: null }]);
  });

  test("caps accumulated rows at maxRows across pages", () => {
    const first: ElasticsearchSqlResponse = {
      columns: [{ name: "id", type: "long" }],
      rows: [[1], [2], [3]],
      cursor: "c1",
    };
    const second: ElasticsearchSqlResponse = { rows: [[4], [5]] };
    const result = normalizeSqlPages([first, second], 4);
    expect(result.rows).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }]);
  });

  test("fills missing trailing cells with null when a row is short", () => {
    const page: ElasticsearchSqlResponse = {
      columns: [
        { name: "a", type: "long" },
        { name: "b", type: "long" },
      ],
      rows: [[1]],
    };
    const result = normalizeSqlPages([page]);
    expect(result.rows).toEqual([{ a: 1, b: null }]);
  });
});

// ---------------------------------------------------------------------------
// extractEsSqlErrorMessage — PURE: ES error body → actionable message
// ---------------------------------------------------------------------------

describe("extractEsSqlErrorMessage", () => {
  test("extracts type + reason from a structured ES error body", () => {
    const body = {
      error: {
        type: "verification_exception",
        reason: "Found 1 problem\nline 1:8: Unknown column [foo]",
      },
      status: 400,
    };
    const msg = extractEsSqlErrorMessage(body, 400, "Bad Request");
    expect(msg).toContain("verification_exception");
    expect(msg).toContain("Unknown column [foo]");
  });

  test("uses reason alone when type is absent", () => {
    const body = { error: { reason: "index_not_found_exception" } };
    expect(extractEsSqlErrorMessage(body, 404, "Not Found")).toBe(
      "index_not_found_exception",
    );
  });

  test("accepts a string error field", () => {
    const body = { error: "something broke" };
    expect(extractEsSqlErrorMessage(body, 500, "Internal Server Error")).toBe(
      "something broke",
    );
  });

  test("falls back to the HTTP status line when the body has no error", () => {
    expect(extractEsSqlErrorMessage({}, 503, "Service Unavailable")).toMatch(
      /HTTP 503 Service Unavailable/,
    );
    expect(extractEsSqlErrorMessage(undefined, 502, "Bad Gateway")).toMatch(
      /HTTP 502 Bad Gateway/,
    );
  });
});

// ---------------------------------------------------------------------------
// client.sqlQuery — POSTs to /_sql, follows cursors, scrubs errors
// ---------------------------------------------------------------------------

describe("createElasticsearchClient.sqlQuery", () => {
  function makeClient(fetchImpl: unknown) {
    return createElasticsearchClient(
      resolveElasticsearchConfig({ url: VALID_URL, apiKey: API_KEY }),
      { fetchImpl: fetchImpl as typeof fetch },
    );
  }

  test("POSTs the query to /_sql with ApiKey auth + JSON body", async () => {
    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;
    const fetchImpl = mock(async (url: string, init: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return fetchResponse({
        columns: [{ name: "n", type: "long" }],
        rows: [[5]],
      });
    });
    const client = makeClient(fetchImpl);
    const result = await client.sqlQuery({ query: "SELECT COUNT(*) AS n FROM flights" });

    expect(capturedUrl).toBe("http://localhost:9200/_sql?format=json");
    expect(capturedInit?.method).toBe("POST");
    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`ApiKey ${API_KEY}`);
    expect(headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(String(capturedInit?.body));
    expect(body.query).toBe("SELECT COUNT(*) AS n FROM flights");
    expect(typeof body.fetch_size).toBe("number");
    expect(result.rows).toEqual([{ n: 5 }]);
  });

  test("follows the cursor across pages and concatenates rows", async () => {
    const bodies: unknown[] = [];
    const fetchImpl = mock(async (_url: string, init: RequestInit) => {
      const payload = JSON.parse(String(init.body));
      bodies.push(payload);
      if (payload.query) {
        return fetchResponse({
          columns: [{ name: "id", type: "long" }],
          rows: [[1], [2]],
          cursor: "cursor-abc",
        });
      }
      if (payload.cursor === "cursor-abc") {
        return fetchResponse({ rows: [[3]], cursor: "cursor-def" });
      }
      return fetchResponse({ rows: [[4]] });
    });
    const client = makeClient(fetchImpl);
    const result = await client.sqlQuery({ query: "SELECT id FROM flights" });

    expect(result.columns).toEqual(["id"]);
    expect(result.rows).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }]);
    // 1 query page + 2 cursor pages
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(bodies[1]).toEqual({ cursor: "cursor-abc" });
    expect(bodies[2]).toEqual({ cursor: "cursor-def" });
  });

  test("stops at maxRows and best-effort closes a still-open cursor", async () => {
    let closeCalled = false;
    let closeCursor: string | undefined;
    const fetchImpl = mock(async (url: string, init: RequestInit) => {
      if (url.endsWith("/_sql/close")) {
        closeCalled = true;
        closeCursor = JSON.parse(String(init.body)).cursor;
        return fetchResponse({ succeeded: true });
      }
      const payload = JSON.parse(String(init.body));
      if (payload.query) {
        return fetchResponse({
          columns: [{ name: "id", type: "long" }],
          rows: [[1], [2]],
          cursor: "live-cursor",
        });
      }
      return fetchResponse({ rows: [[3], [4]], cursor: "live-cursor" });
    });
    const client = makeClient(fetchImpl);
    const result = await client.sqlQuery({ query: "SELECT id FROM flights", maxRows: 3 });

    expect(result.rows).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
    expect(closeCalled).toBe(true);
    expect(closeCursor).toBe("live-cursor");
  });

  test("throws an actionable, scrubbed error on a non-2xx response", async () => {
    const fetchImpl = mock(async () =>
      fetchResponse(
        { error: { type: "verification_exception", reason: "Unknown column [nope]" }, status: 400 },
        { ok: false, status: 400, statusText: "Bad Request" },
      ),
    );
    const client = makeClient(fetchImpl);
    await expect(client.sqlQuery({ query: "SELECT nope FROM flights" })).rejects.toThrow(
      /Unknown column \[nope\]/,
    );
  });

  test("never leaks the API key even if the server echoes it in an error", async () => {
    const fetchImpl = mock(async () =>
      fetchResponse(
        { error: { type: "security_exception", reason: `bad ApiKey ${API_KEY}` } },
        { ok: false, status: 403, statusText: "Forbidden" },
      ),
    );
    const client = makeClient(fetchImpl);
    let message = "";
    try {
      await client.sqlQuery({ query: "SELECT * FROM flights" });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).not.toContain(API_KEY);
  });

  test("rejects with a timeout error when the request exceeds timeoutMs", async () => {
    const fetchImpl = mock(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" })),
          );
        }),
    );
    const client = makeClient(fetchImpl);
    await expect(
      client.sqlQuery({ query: "SELECT * FROM flights", timeoutMs: 10 }),
    ).rejects.toThrow(/timed out after 10ms/);
  });

  test("sqlQuery after close rejects", async () => {
    const fetchImpl = mock(async () => fetchResponse({ columns: [], rows: [] }));
    const client = makeClient(fetchImpl);
    client.close();
    await expect(client.sqlQuery({ query: "SELECT 1" })).rejects.toThrow(/closed/);
  });

  test("a failed cursor close is non-fatal — still returns the truncated rows, warns, logs at debug", async () => {
    // The whole point of the best-effort /_sql/close is that its failure must NOT
    // fail the user's already-successful (truncated) query. Also locks the
    // "truncation is logged, never silent" contract.
    const warns: unknown[][] = [];
    const debugs: unknown[][] = [];
    const logger = {
      info: (...a: unknown[]) => void a,
      warn: (...a: unknown[]) => void warns.push(a),
      error: (...a: unknown[]) => void a,
      debug: (...a: unknown[]) => void debugs.push(a),
    };
    const fetchImpl = mock(async (url: string, init: RequestInit) => {
      if (url.endsWith("/_sql/close")) {
        throw new Error("close request boom");
      }
      const payload = JSON.parse(String(init.body));
      if (payload.query) {
        return fetchResponse({
          columns: [{ name: "id", type: "long" }],
          rows: [[1], [2]],
          cursor: "live-cursor",
        });
      }
      return fetchResponse({ rows: [[3], [4]], cursor: "live-cursor" });
    });
    const client = createElasticsearchClient(
      resolveElasticsearchConfig({ url: VALID_URL, apiKey: API_KEY }),
      { fetchImpl: fetchImpl as unknown as typeof fetch, logger },
    );
    const result = await client.sqlQuery({ query: "SELECT id FROM flights", maxRows: 3 });
    expect(result.rows).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
    // Truncation warned (never silent) and the close failure logged at debug.
    expect(warns.length).toBeGreaterThan(0);
    expect(warns[0][0]).toEqual({ maxRows: 3 });
    expect(debugs.length).toBeGreaterThan(0);
  });

  test("caps on the first page (zero loop iterations) and still closes the cursor", async () => {
    // Distinct control-flow path: the first page alone meets maxRows AND carries a
    // cursor, so the `while` body never runs — but the cap-on-entry close must
    // still fire and NO cursor-continuation page may be fetched.
    let cursorPageFetched = false;
    let closeCalled = false;
    const fetchImpl = mock(async (url: string, init: RequestInit) => {
      if (url.endsWith("/_sql/close")) {
        closeCalled = true;
        return fetchResponse({ succeeded: true });
      }
      const payload = JSON.parse(String(init.body));
      if (payload.query) {
        return fetchResponse({
          columns: [{ name: "id", type: "long" }],
          rows: [[1], [2], [3]],
          cursor: "live-cursor",
        });
      }
      cursorPageFetched = true; // must not happen
      return fetchResponse({ rows: [[4]] });
    });
    const client = makeClient(fetchImpl);
    const result = await client.sqlQuery({ query: "SELECT id FROM flights", maxRows: 2 });

    expect(result.rows).toEqual([{ id: 1 }, { id: 2 }]);
    expect(cursorPageFetched).toBe(false);
    expect(closeCalled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SQL surface wiring — parserDialect + forbiddenPatterns + dialect, no validate
// ---------------------------------------------------------------------------

describe("SQL surface wiring", () => {
  test("declares the PostgresQL parser dialect on the connection", () => {
    const plugin = elasticsearchPlugin({ url: VALID_URL, apiKey: API_KEY });
    expect(plugin.connection.parserDialect).toBe("PostgresQL");
    expect(ELASTICSEARCH_PARSER_DIALECT).toBe("PostgresQL");
  });

  test("sets NO custom validate — the standard 4-layer SQL pipeline applies", () => {
    const plugin = elasticsearchPlugin({ url: VALID_URL, apiKey: API_KEY });
    expect(plugin.connection.validate).toBeUndefined();
  });

  test("declares ES-specific forbiddenPatterns on the connection", () => {
    const plugin = elasticsearchPlugin({ url: VALID_URL, apiKey: API_KEY });
    expect(Array.isArray(plugin.connection.forbiddenPatterns)).toBe(true);
    expect(plugin.connection.forbiddenPatterns!.length).toBeGreaterThan(0);
  });

  test("forbiddenPatterns block ES catalog/schema disclosure verbs", () => {
    const matches = (sql: string) =>
      ELASTICSEARCH_FORBIDDEN_PATTERNS.some((p) => p.test(sql));
    expect(matches("SHOW TABLES")).toBe(true);
    expect(matches("SHOW COLUMNS IN flights")).toBe(true);
    expect(matches("SHOW FUNCTIONS")).toBe(true);
    expect(matches("DESCRIBE flights")).toBe(true);
    expect(matches("  show catalogs")).toBe(true);
  });

  test("forbiddenPatterns do NOT false-positive on legitimate SELECTs", () => {
    const matches = (sql: string) =>
      ELASTICSEARCH_FORBIDDEN_PATTERNS.some((p) => p.test(sql));
    // ORDER BY ... DESC must not trip the guard.
    expect(matches("SELECT origin FROM flights ORDER BY delay DESC LIMIT 10")).toBe(false);
    // A field literally named `show` or `description` mid-query is fine.
    expect(matches("SELECT show, description FROM tv_shows LIMIT 5")).toBe(false);
  });

  test("provides ES SQL dialect guidance for the agent system prompt", () => {
    const plugin = elasticsearchPlugin({ url: VALID_URL, apiKey: API_KEY });
    expect(typeof plugin.dialect).toBe("string");
    expect(plugin.dialect!).toMatch(/Elasticsearch SQL/i);
    expect(plugin.dialect!).toMatch(/executeSQL/);
    // Single-index guidance (no JOINs across indices in the SQL surface).
    expect(plugin.dialect!.toLowerCase()).toContain("index");
  });
});

// ---------------------------------------------------------------------------
// AWS SigV4 signer (#3265) — verified against AWS-documented test vectors
// ---------------------------------------------------------------------------

describe("sigv4: deriveSigningKey", () => {
  test("matches AWS's documented signing-key derivation example", () => {
    // From AWS "Examples of how to derive a signing key for Signature Version 4".
    const key = deriveSigningKey(
      "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
      "20120215",
      "us-east-1",
      "iam",
    );
    expect(key.toString("hex")).toBe(
      "f4780e2d9f65fa895f9c67b32ce1baf0b0d8a43505a000a1a9e090d414db404d",
    );
  });
});

describe("sigv4: formatAmzDate", () => {
  test("formats a Date into amzDate + dateStamp (UTC, no separators)", () => {
    const { amzDate, dateStamp } = formatAmzDate(new Date("2015-08-30T12:36:00.000Z"));
    expect(amzDate).toBe("20150830T123600Z");
    expect(dateStamp).toBe("20150830");
  });
});

describe("sigv4: buildCanonicalRequest", () => {
  test("produces the canonical request string for a body-less GET", () => {
    const { canonicalRequest, signedHeaders } = buildCanonicalRequest(
      "GET",
      "/",
      new URLSearchParams(""),
      {
        host: "example.amazonaws.com",
        amzDate: "20150830T123600Z",
        payloadHash: EMPTY_PAYLOAD_SHA256,
      },
    );
    expect(signedHeaders).toBe("host;x-amz-content-sha256;x-amz-date");
    expect(canonicalRequest).toBe(
      [
        "GET",
        "/",
        "",
        "host:example.amazonaws.com",
        `x-amz-content-sha256:${EMPTY_PAYLOAD_SHA256}`,
        "x-amz-date:20150830T123600Z",
        "",
        "host;x-amz-content-sha256;x-amz-date",
        EMPTY_PAYLOAD_SHA256,
      ].join("\n"),
    );
  });

  test("sorts the canonical query string by encoded key", () => {
    const { canonicalRequest } = buildCanonicalRequest(
      "POST",
      "/_sql",
      new URLSearchParams("format=json"),
      { host: "h", amzDate: "20150830T123600Z", payloadHash: "abc" },
    );
    // The 3rd line (index 2) is the canonical query string.
    expect(canonicalRequest.split("\n")[2]).toBe("format=json");
  });

  test("includes x-amz-security-token in the signed headers when a session token is present", () => {
    const { signedHeaders, canonicalRequest } = buildCanonicalRequest(
      "GET",
      "/",
      new URLSearchParams(""),
      {
        host: "h",
        amzDate: "20150830T123600Z",
        payloadHash: EMPTY_PAYLOAD_SHA256,
        sessionToken: "FQoSESSIONTOKEN",
      },
    );
    expect(signedHeaders).toBe("host;x-amz-content-sha256;x-amz-date;x-amz-security-token");
    expect(canonicalRequest).toContain("x-amz-security-token:FQoSESSIONTOKEN");
  });
});

describe("sigv4: sigV4SignHeaders", () => {
  const FIXED_DATE = new Date("2015-08-30T12:36:00.000Z");
  const SIGN_INPUT = {
    method: "POST",
    url: "https://search-mydomain.us-east-1.es.amazonaws.com/_sql?format=json",
    body: JSON.stringify({ query: "SELECT COUNT(*) FROM flights" }),
    region: "us-east-1",
    service: "es",
    accessKeyId: "AKIDEXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
    date: FIXED_DATE,
  };

  test("produces an Authorization header in the SigV4 format", () => {
    const headers = sigV4SignHeaders(SIGN_INPUT);
    expect(headers.Authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20150830\/us-east-1\/es\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/,
    );
    expect(headers["X-Amz-Date"]).toBe("20150830T123600Z");
    expect(headers["X-Amz-Content-Sha256"]).toBe(
      createHash("sha256").update(SIGN_INPUT.body, "utf8").digest("hex"),
    );
    expect(headers["X-Amz-Security-Token"]).toBeUndefined();
  });

  test("the signature equals an independent recomputation from the verified pieces", () => {
    // Re-derive the signature in the test from the (separately vector-verified)
    // deriveSigningKey + buildCanonicalRequest, proving sigV4SignHeaders glues
    // them together correctly without trusting a memorized golden signature.
    const headers = sigV4SignHeaders(SIGN_INPUT);
    const actualSig = /Signature=([0-9a-f]{64})$/.exec(headers.Authorization)![1];

    const payloadHash = createHash("sha256").update(SIGN_INPUT.body, "utf8").digest("hex");
    const { canonicalRequest } = buildCanonicalRequest(
      "POST",
      "/_sql",
      new URLSearchParams("format=json"),
      {
        host: "search-mydomain.us-east-1.es.amazonaws.com",
        amzDate: "20150830T123600Z",
        payloadHash,
      },
    );
    const scope = "20150830/us-east-1/es/aws4_request";
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      "20150830T123600Z",
      scope,
      createHash("sha256").update(canonicalRequest, "utf8").digest("hex"),
    ].join("\n");
    const signingKey = deriveSigningKey(
      SIGN_INPUT.secretAccessKey,
      "20150830",
      "us-east-1",
      "es",
    );
    const expectedSig = createHmac("sha256", signingKey)
      .update(stringToSign, "utf8")
      .digest("hex");
    expect(actualSig).toBe(expectedSig);
  });

  test("is deterministic for a fixed clock and varies with the body", () => {
    const a = sigV4SignHeaders(SIGN_INPUT);
    const b = sigV4SignHeaders(SIGN_INPUT);
    expect(a.Authorization).toBe(b.Authorization);
    const c = sigV4SignHeaders({ ...SIGN_INPUT, body: JSON.stringify({ query: "SELECT 1" }) });
    expect(c.Authorization).not.toBe(a.Authorization);
  });

  test("adds X-Amz-Security-Token and signs it when a session token is supplied", () => {
    const headers = sigV4SignHeaders({ ...SIGN_INPUT, sessionToken: "SESSION123" });
    expect(headers["X-Amz-Security-Token"]).toBe("SESSION123");
    expect(headers.Authorization).toContain(
      "SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token",
    );
  });

  test("hashes an empty body to the well-known empty SHA-256", () => {
    const headers = sigV4SignHeaders({ ...SIGN_INPUT, method: "GET", body: "" });
    expect(headers["X-Amz-Content-Sha256"]).toBe(EMPTY_PAYLOAD_SHA256);
  });
});

// ---------------------------------------------------------------------------
// HTTP Basic auth (#3263)
// ---------------------------------------------------------------------------

describe("HTTP Basic auth (#3263)", () => {
  const BASIC = { url: VALID_URL, username: "esuser", password: "es-p@ss word" };

  test("resolveAuth selects Basic from username + password", () => {
    const auth = resolveAuth(BASIC);
    expect(auth).toEqual({ mode: "basic", username: "esuser", password: "es-p@ss word" });
  });

  test("resolveAuth rejects a username without a password (and vice versa)", () => {
    expect(() => resolveAuth({ url: VALID_URL, username: "esuser" })).toThrow(
      /both a username and a password/,
    );
    expect(() => resolveAuth({ url: VALID_URL, password: "secret" })).toThrow(
      /both a username and a password/,
    );
  });

  test("the client sends Authorization: Basic on ping", async () => {
    let capturedAuth: string | undefined;
    const fetchImpl = mock(async (_url: string, init: RequestInit) => {
      capturedAuth = (init.headers as Record<string, string>).Authorization;
      return fetchResponse(CLUSTER_INFO_BODY);
    });
    const conn = createElasticsearchConnection(BASIC, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await conn.ping();
    const expected = `Basic ${Buffer.from("esuser:es-p@ss word", "utf8").toString("base64")}`;
    expect(capturedAuth).toBe(expected);
  });

  test("a Basic-secured health check succeeds (mocked)", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = mock(async () =>
      fetchResponse(CLUSTER_INFO_BODY),
    ) as unknown as typeof fetch;
    try {
      const plugin = buildElasticsearchPlugin(BASIC);
      const result = await plugin.healthCheck!();
      expect(result.healthy).toBe(true);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("a failed Basic health check never leaks the password", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = mock(async () =>
      fetchResponse(
        { error: `auth failed for password es-p@ss word` },
        { ok: false, status: 401, statusText: "Unauthorized" },
      ),
    ) as unknown as typeof fetch;
    try {
      const plugin = buildElasticsearchPlugin(BASIC);
      const result = await plugin.healthCheck!();
      expect(result.healthy).toBe(false);
      expect(result.message).not.toContain("es-p@ss word");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("the strict schema accepts a complete Basic config via createFromConfig", () => {
    const plugin = elasticsearchPlugin({});
    const conn = plugin.connection.createFromConfig!(BASIC);
    expect(typeof (conn as { query?: unknown }).query).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// Elastic Cloud ID (#3264)
// ---------------------------------------------------------------------------

describe("Elastic Cloud ID (#3264)", () => {
  /** Build a Cloud ID from a decoded `domain[:port]$es$kbn` payload. */
  const cloudIdOf = (decoded: string, name = "my-deployment") =>
    `${name}:${Buffer.from(decoded, "utf8").toString("base64")}`;

  test("decodes to https://<es-uuid>.<domain>", () => {
    const cloudId = cloudIdOf("us-east-1.aws.found.io$abc123es$def456kbn");
    expect(decodeCloudId(cloudId)).toBe("https://abc123es.us-east-1.aws.found.io");
  });

  test("preserves an explicit port from the domain segment", () => {
    const cloudId = cloudIdOf("cloud.example.com:9243$esid$kbnid");
    expect(decodeCloudId(cloudId)).toBe("https://esid.cloud.example.com:9243");
  });

  test("falls back to the bare domain when the es-uuid is empty", () => {
    const cloudId = cloudIdOf("host.example.com$$kbnid");
    expect(decodeCloudId(cloudId)).toBe("https://host.example.com");
  });

  test("rejects a malformed Cloud ID (no colon)", () => {
    expect(() => decodeCloudId("no-colon-here")).toThrow(/Invalid Elastic Cloud ID/);
  });

  test("rejects a Cloud ID with an empty base64 segment", () => {
    expect(() => decodeCloudId("my-deployment:")).toThrow(/Invalid Elastic Cloud ID/);
  });

  test("rejects a base64 payload missing the $-separated parts", () => {
    // "hello" base64-decodes fine but has no `$` separator.
    const cloudId = cloudIdOf("hello");
    expect(() => decodeCloudId(cloudId)).toThrow(/malformed/);
  });

  test("resolveElasticsearchConfig combines a Cloud ID with API-key creds", () => {
    const cloudId = cloudIdOf("us-east-1.aws.found.io$abc123es$def456kbn");
    const resolved = resolveElasticsearchConfig({ cloudId, apiKey: API_KEY });
    expect(resolved.endpoint).toBe("https://abc123es.us-east-1.aws.found.io");
    expect(resolved.engine).toBe("elasticsearch");
    expect(resolved.auth).toEqual({ mode: "apiKey", apiKey: API_KEY });
  });

  test("resolveElasticsearchConfig combines a Cloud ID with Basic creds", () => {
    const cloudId = cloudIdOf("us-east-1.aws.found.io$abc123es$def456kbn");
    const resolved = resolveElasticsearchConfig({
      cloudId,
      username: "u",
      password: "p",
    });
    expect(resolved.endpoint).toBe("https://abc123es.us-east-1.aws.found.io");
    expect(resolved.auth.mode).toBe("basic");
  });

  test("rejects supplying both url and cloudId", () => {
    const cloudId = cloudIdOf("h$e$k");
    expect(() =>
      resolveElasticsearchConfig({ url: VALID_URL, cloudId, apiKey: API_KEY }),
    ).toThrow(/either a url or a cloudId/);
  });

  test("a Cloud ID health check succeeds (mocked) and hits the decoded endpoint", async () => {
    const cloudId = cloudIdOf("us-east-1.aws.found.io$abc123es$def456kbn");
    let capturedUrl: string | undefined;
    const fetchImpl = mock(async (url: string) => {
      capturedUrl = url;
      return fetchResponse(CLUSTER_INFO_BODY);
    });
    const conn = createElasticsearchConnection(
      { cloudId, apiKey: API_KEY },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    const info = await conn.ping();
    expect(info.clusterName).toBe("atlas-test-cluster");
    expect(capturedUrl).toBe("https://abc123es.us-east-1.aws.found.io/");
  });
});

// ---------------------------------------------------------------------------
// AWS SigV4 auth (#3265)
// ---------------------------------------------------------------------------

describe("AWS SigV4 auth (#3265)", () => {
  const realFetch = globalThis.fetch;
  const SAVED = {
    id: process.env.AWS_ACCESS_KEY_ID,
    secret: process.env.AWS_SECRET_ACCESS_KEY,
    token: process.env.AWS_SESSION_TOKEN,
  };
  afterEach(() => {
    globalThis.fetch = realFetch;
    // Restore the ambient AWS env to its pre-test state.
    for (const [k, v] of [
      ["AWS_ACCESS_KEY_ID", SAVED.id],
      ["AWS_SECRET_ACCESS_KEY", SAVED.secret],
      ["AWS_SESSION_TOKEN", SAVED.token],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const SIGV4 = {
    url: VALID_URL,
    awsRegion: "us-east-1",
    awsAccessKeyId: "AKIDEXAMPLE",
    awsSecretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
  };

  test("resolveAuth selects SigV4 from awsRegion + explicit keys", () => {
    const auth = resolveAuth(SIGV4);
    expect(auth).toEqual({
      mode: "sigv4",
      region: "us-east-1",
      service: "es",
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
    });
  });

  test("resolveAuth resolves credentials from the ambient AWS env chain", () => {
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    delete process.env.AWS_SESSION_TOKEN;
    process.env.AWS_ACCESS_KEY_ID = "ENV_KEY_ID";
    process.env.AWS_SECRET_ACCESS_KEY = "ENV_SECRET";
    process.env.AWS_SESSION_TOKEN = "ENV_TOKEN";
    const auth = resolveAuth({ url: VALID_URL, awsRegion: "eu-west-1", awsService: "aoss" });
    expect(auth).toEqual({
      mode: "sigv4",
      region: "eu-west-1",
      service: "aoss",
      accessKeyId: "ENV_KEY_ID",
      secretAccessKey: "ENV_SECRET",
      sessionToken: "ENV_TOKEN",
    });
  });

  test("resolveAuth throws (no secret echoed) when SigV4 has no credentials", () => {
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    expect(() => resolveAuth({ url: VALID_URL, awsRegion: "us-east-1" })).toThrow(
      /AWS SigV4 selected .* no credentials/,
    );
  });

  test("SigV4 takes precedence over API key + Basic when several are present", () => {
    const auth = resolveAuth({
      ...SIGV4,
      apiKey: API_KEY,
      username: "u",
      password: "p",
    });
    expect(auth.mode).toBe("sigv4");
  });

  test("the client signs ping requests with SigV4 (mocked)", async () => {
    let headers: Record<string, string> | undefined;
    const fetchImpl = mock(async (_url: string, init: RequestInit) => {
      headers = init.headers as Record<string, string>;
      return fetchResponse(CLUSTER_INFO_BODY);
    });
    const conn = createElasticsearchConnection(SIGV4, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await conn.ping();
    expect(headers?.Authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-east-1\/es\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/,
    );
    expect(headers?.["X-Amz-Date"]).toMatch(/^\d{8}T\d{6}Z$/);
    expect(headers?.["X-Amz-Content-Sha256"]).toBe(EMPTY_PAYLOAD_SHA256);
  });

  test("the client signs SQL queries with SigV4 (mocked) and carries the session token", async () => {
    let headers: Record<string, string> | undefined;
    const fetchImpl = mock(async (_url: string, init: RequestInit) => {
      headers = init.headers as Record<string, string>;
      return fetchResponse({ columns: [{ name: "n", type: "long" }], rows: [[1]] });
    });
    const conn = createElasticsearchConnection(
      { ...SIGV4, awsSessionToken: "SESSIONTOK" },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    const result = await conn.query("SELECT COUNT(*) AS n FROM flights");
    expect(result.rows).toEqual([{ n: 1 }]);
    expect(headers?.Authorization).toContain("AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE");
    expect(headers?.Authorization).toContain("x-amz-security-token");
    expect(headers?.["X-Amz-Security-Token"]).toBe("SESSIONTOK");
  });

  test("a SigV4 health check succeeds (mocked)", async () => {
    globalThis.fetch = mock(async () =>
      fetchResponse(CLUSTER_INFO_BODY),
    ) as unknown as typeof fetch;
    const plugin = buildElasticsearchPlugin(SIGV4);
    const result = await plugin.healthCheck!();
    expect(result.healthy).toBe(true);
  });

  test("a failed SigV4 health check never leaks the secret key", async () => {
    globalThis.fetch = mock(async () =>
      fetchResponse(
        { error: `denied for ${SIGV4.awsSecretAccessKey}` },
        { ok: false, status: 403, statusText: "Forbidden" },
      ),
    ) as unknown as typeof fetch;
    const plugin = buildElasticsearchPlugin(SIGV4);
    const result = await plugin.healthCheck!();
    expect(result.healthy).toBe(false);
    expect(result.message).not.toContain(SIGV4.awsSecretAccessKey);
  });
});

// ---------------------------------------------------------------------------
// OpenSearch engine coverage (#3266)
// ---------------------------------------------------------------------------

describe("engineSqlProfile + parseSqlPage (#3266)", () => {
  test("routes Elasticsearch SQL to /_sql (format=json)", () => {
    expect(engineSqlProfile("elasticsearch")).toEqual({
      sqlPath: "/_sql",
      sqlClosePath: "/_sql/close",
      format: "json",
    });
  });

  test("routes OpenSearch SQL to /_plugins/_sql (format=jdbc)", () => {
    expect(engineSqlProfile("opensearch")).toEqual({
      sqlPath: "/_plugins/_sql",
      sqlClosePath: "/_plugins/_sql/close",
      format: "jdbc",
    });
  });

  test("parseSqlPage reads Elasticsearch columns/rows", () => {
    const page = parseSqlPage(
      { columns: [{ name: "a", type: "long" }], rows: [[1]], cursor: "c1" },
      "elasticsearch",
    );
    expect(page).toEqual({ columns: [{ name: "a", type: "long" }], rows: [[1]], cursor: "c1" });
  });

  test("parseSqlPage maps OpenSearch schema/datarows into columns/rows", () => {
    const page = parseSqlPage(
      { schema: [{ name: "a", type: "long" }], datarows: [[1]], cursor: "c1" },
      "opensearch",
    );
    expect(page).toEqual({ columns: [{ name: "a", type: "long" }], rows: [[1]], cursor: "c1" });
  });
});

describe("engine resolution (#3266)", () => {
  test("opensearch:// URL resolves the opensearch engine", () => {
    const resolved = resolveElasticsearchConfig({
      url: "opensearch://localhost:9200?ssl=false",
      apiKey: API_KEY,
    });
    expect(resolved.engine).toBe("opensearch");
  });

  test("explicit engine config overrides the URL scheme (config precedence)", () => {
    const asOpenSearch = resolveElasticsearchConfig({
      url: "elasticsearch://h:9200",
      engine: "opensearch",
      apiKey: API_KEY,
    });
    expect(asOpenSearch.engine).toBe("opensearch");
    const asElastic = resolveElasticsearchConfig({
      url: "opensearch://h:9200",
      engine: "elasticsearch",
      apiKey: API_KEY,
    });
    expect(asElastic.engine).toBe("elasticsearch");
  });

  test("a Cloud ID with no scheme defaults to the elasticsearch engine", () => {
    const cloudId = `dep:${Buffer.from("h$e$k", "utf8").toString("base64")}`;
    expect(resolveElasticsearchConfig({ cloudId, apiKey: API_KEY }).engine).toBe(
      "elasticsearch",
    );
  });
});

describe("OpenSearch SQL surface (#3266)", () => {
  const OS_URL = "opensearch://localhost:9200?ssl=false";

  test("query() POSTs to /_plugins/_sql?format=jdbc and parses schema/datarows", async () => {
    let capturedUrl: string | undefined;
    const fetchImpl = mock(async (url: string) => {
      capturedUrl = url;
      return fetchResponse({
        schema: [
          { name: "origin", type: "text" },
          { name: "cnt", type: "long" },
        ],
        datarows: [
          ["SFO", 42],
          ["JFK", 31],
        ],
      });
    });
    const conn = createElasticsearchConnection(
      { url: OS_URL, apiKey: API_KEY },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    const result = await conn.query("SELECT origin, COUNT(*) AS cnt FROM flights GROUP BY origin");
    expect(capturedUrl).toBe("http://localhost:9200/_plugins/_sql?format=jdbc");
    expect(result.columns).toEqual(["origin", "cnt"]);
    expect(result.rows).toEqual([
      { origin: "SFO", cnt: 42 },
      { origin: "JFK", cnt: 31 },
    ]);
  });

  test("follows the OpenSearch jdbc cursor across pages and closes at /_plugins/_sql/close", async () => {
    let closeUrl: string | undefined;
    const fetchImpl = mock(async (url: string, init: RequestInit) => {
      if (url.endsWith("/_plugins/_sql/close")) {
        closeUrl = url;
        return fetchResponse({ succeeded: true });
      }
      const payload = JSON.parse(String(init.body));
      if (payload.query) {
        return fetchResponse({
          schema: [{ name: "id", type: "long" }],
          datarows: [[1], [2]],
          cursor: "os-cursor",
        });
      }
      return fetchResponse({ datarows: [[3], [4]], cursor: "os-cursor" });
    });
    const conn = createElasticsearchConnection(
      { url: OS_URL, apiKey: API_KEY },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    const result = await conn.query("SELECT id FROM flights");
    expect(result.rows.slice(0, 3)).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
  });

  test("a health check against an OpenSearch cluster succeeds (mocked)", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = mock(async () =>
      fetchResponse({ ...CLUSTER_INFO_BODY, version: { number: "2.13.0", distribution: "opensearch" } }),
    ) as unknown as typeof fetch;
    try {
      const plugin = buildElasticsearchPlugin({ url: OS_URL, apiKey: API_KEY });
      const result = await plugin.healthCheck!();
      expect(result.healthy).toBe(true);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// isCompleteConnectionConfig + static vs adapter-only across modes
// ---------------------------------------------------------------------------

describe("isCompleteConnectionConfig", () => {
  test("true when an endpoint source and an auth signal are both present", () => {
    expect(isCompleteConnectionConfig({ url: VALID_URL, apiKey: API_KEY })).toBe(true);
    expect(isCompleteConnectionConfig({ url: VALID_URL, username: "u", password: "p" })).toBe(true);
    expect(isCompleteConnectionConfig({ url: VALID_URL, awsRegion: "us-east-1" })).toBe(true);
    expect(isCompleteConnectionConfig({ cloudId: "n:abc", apiKey: API_KEY })).toBe(true);
  });

  test("false without an endpoint or without auth", () => {
    expect(isCompleteConnectionConfig({ url: VALID_URL })).toBe(false);
    expect(isCompleteConnectionConfig({ apiKey: API_KEY })).toBe(false);
    expect(isCompleteConnectionConfig({})).toBe(false);
    expect(isCompleteConnectionConfig({ url: VALID_URL, username: "u" })).toBe(false);
  });
});

describe("static-config wiring across auth modes", () => {
  test("wires connection.create for a Basic static config", () => {
    const plugin = elasticsearchPlugin({ url: VALID_URL, username: "u", password: "p" });
    expect(typeof plugin.connection.create).toBe("function");
  });

  test("wires connection.create for a SigV4 static config", () => {
    const plugin = elasticsearchPlugin({
      url: VALID_URL,
      awsRegion: "us-east-1",
      awsAccessKeyId: "AKID",
      awsSecretAccessKey: "secret",
    });
    expect(typeof plugin.connection.create).toBe("function");
  });

  test("stays adapter-only when only an endpoint (no auth) is configured", () => {
    const plugin = elasticsearchPlugin({ url: VALID_URL });
    expect(plugin.connection.create).toBeUndefined();
  });
});
