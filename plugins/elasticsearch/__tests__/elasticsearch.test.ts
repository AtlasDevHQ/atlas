import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";

import { definePlugin, isDatasourcePlugin } from "@useatlas/plugin-sdk";
import {
  elasticsearchPlugin,
  buildElasticsearchPlugin,
  parseElasticsearchUrl,
  resolveElasticsearchConfig,
  extractHost,
  createElasticsearchClient,
  createElasticsearchConnection,
  scrubElasticsearchError,
  SENSITIVE_PATTERNS,
  normalizeSqlPages,
  extractEsSqlErrorMessage,
  ELASTICSEARCH_FORBIDDEN_PATTERNS,
  ELASTICSEARCH_PARSER_DIALECT,
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

  test("rejects a non-elasticsearch scheme", () => {
    expect(() => parseElasticsearchUrl("postgresql://user:pass@host/db")).toThrow(
      /expected elasticsearch:\/\/ scheme/,
    );
  });

  test("rejects opensearch:// — OpenSearch engine arrives in a later slice", () => {
    expect(() => parseElasticsearchUrl("opensearch://host:9200")).toThrow(/#3266/);
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
    expect(resolved.auth.apiKey).toBe(API_KEY);
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

  test("rejects a missing API key", () => {
    // @ts-expect-error — intentionally omitting apiKey
    expect(() => elasticsearchPlugin({ url: VALID_URL })).toThrow();
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
    const conn = await plugin.connection.create();
    expect(typeof conn.query).toBe("function");
    expect(typeof conn.close).toBe("function");
  });

  test("has teardown method", () => {
    const plugin = elasticsearchPlugin({ url: VALID_URL, apiKey: API_KEY });
    expect(typeof plugin.teardown).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// getConfigSchema — secret: true drives encryption + masking
// ---------------------------------------------------------------------------

describe("getConfigSchema", () => {
  test("marks apiKey as a secret field", () => {
    const plugin = elasticsearchPlugin({ url: VALID_URL, apiKey: API_KEY });
    const schema = plugin.getConfigSchema!();
    const apiKeyField = schema.find((f) => f.key === "apiKey");
    expect(apiKeyField).toBeDefined();
    expect(apiKeyField?.secret).toBe(true);
    expect(apiKeyField?.required).toBe(true);
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
