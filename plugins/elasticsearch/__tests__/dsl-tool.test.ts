import { describe, test, expect, mock } from "bun:test";

import {
  elasticsearchPlugin,
  createElasticsearchConnection,
  createElasticsearchClient,
  resolveElasticsearchConfig,
  createQueryElasticsearchTool,
} from "../src/index";

const VALID_URL = "elasticsearch://localhost:9200?ssl=false";
const API_KEY = "VnVhQ2ZHY0JDZGJrU=test-key";

/** Minimal Response-like object for the mocked fetch. */
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

/** AI SDK tool execute() options stub. */
const EXEC_OPTS = {
  toolCallId: "test",
  messages: [],
  abortSignal: undefined as unknown as AbortSignal,
};

// A realistic _search hits response (full-text relevance).
const HITS_RESPONSE = {
  took: 4,
  hits: {
    total: { value: 2, relation: "eq" },
    max_score: 2.5,
    hits: [
      { _index: "products", _id: "p1", _score: 2.5, _source: { title: "Wireless Mouse", price: 19.99, vendor: { name: "Acme" } } },
      { _index: "products", _id: "p2", _score: 1.1, _source: { title: "Wireless Keyboard", price: 49.0, vendor: { name: "Globex" } } },
    ],
  },
};

// A realistic nested aggregation response (terms → avg sub-agg).
const AGG_RESPONSE = {
  took: 7,
  hits: { total: { value: 1000, relation: "gte" }, hits: [] },
  aggregations: {
    by_category: {
      doc_count_error_upper_bound: 0,
      sum_other_doc_count: 0,
      buckets: [
        { key: "electronics", doc_count: 640, avg_price: { value: 82.5 } },
        { key: "books", doc_count: 360, avg_price: { value: 14.2 } },
      ],
    },
  },
};

// ---------------------------------------------------------------------------
// client.dslQuery — transport, safeguards, scrubbing
// ---------------------------------------------------------------------------

describe("createElasticsearchClient.dslQuery", () => {
  function makeClient(fetchImpl: unknown) {
    return createElasticsearchClient(
      resolveElasticsearchConfig({ url: VALID_URL, apiKey: API_KEY }),
      { fetchImpl: fetchImpl as typeof fetch },
    );
  }

  test("POSTs to /<index>/_search with ApiKey auth + JSON body", async () => {
    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;
    const fetchImpl = mock(async (url: string, init: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return fetchResponse(HITS_RESPONSE);
    });
    const client = makeClient(fetchImpl);
    await client.dslQuery({ index: "products", endpoint: "_search", body: { query: { match: { title: "wireless" } } } });

    expect(capturedUrl).toBe("http://localhost:9200/products/_search");
    expect(capturedInit?.method).toBe("POST");
    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`ApiKey ${API_KEY}`);
    expect(headers["Content-Type"]).toBe("application/json");
  });

  test("applies size cap, timeout, and terminate_after to a non-agg _search", async () => {
    let sentBody: Record<string, unknown> = {};
    const fetchImpl = mock(async (_url: string, init: RequestInit) => {
      sentBody = JSON.parse(String(init.body));
      return fetchResponse(HITS_RESPONSE);
    });
    const client = makeClient(fetchImpl);
    await client.dslQuery({
      index: "products",
      endpoint: "_search",
      body: { query: { match_all: {} }, size: 99999 },
      timeoutMs: 12345,
      maxSize: 500,
      terminateAfter: 7000,
    });
    expect(sentBody.size).toBe(500);
    expect(sentBody.timeout).toBe("12345ms");
    expect(sentBody.terminate_after).toBe(7000);
  });

  test("does NOT inject terminate_after for an aggregation _search", async () => {
    let sentBody: Record<string, unknown> = {};
    const fetchImpl = mock(async (_url: string, init: RequestInit) => {
      sentBody = JSON.parse(String(init.body));
      return fetchResponse(AGG_RESPONSE);
    });
    const client = makeClient(fetchImpl);
    await client.dslQuery({
      index: "products",
      endpoint: "_search",
      body: { size: 0, aggs: { by_category: { terms: { field: "category" } } } },
      terminateAfter: 7000,
    });
    expect(sentBody.terminate_after).toBeUndefined();
    expect(sentBody.size).toBe(0);
  });

  test("URL-encodes a comma-separated multi-index path per segment", async () => {
    let capturedUrl: string | undefined;
    const fetchImpl = mock(async (url: string) => {
      capturedUrl = url;
      return fetchResponse(HITS_RESPONSE);
    });
    const client = makeClient(fetchImpl);
    await client.dslQuery({ index: "products, orders", endpoint: "_search", body: {} });
    expect(capturedUrl).toBe("http://localhost:9200/products,orders/_search");
  });

  test("POSTs a _count request to /<index>/_count and returns the raw body", async () => {
    let capturedUrl: string | undefined;
    const fetchImpl = mock(async (url: string) => {
      capturedUrl = url;
      return fetchResponse({ count: 42, _shards: {} });
    });
    const client = makeClient(fetchImpl);
    const raw = await client.dslQuery({ index: "products", endpoint: "_count", body: { query: { match_all: {} } } });
    expect(capturedUrl).toBe("http://localhost:9200/products/_count");
    expect(raw).toMatchObject({ count: 42 });
  });

  test("throws an actionable, scrubbed error on a non-2xx response", async () => {
    const fetchImpl = mock(async () =>
      fetchResponse(
        { error: { type: "search_phase_execution_exception", reason: "No mapping found for [missing]" } },
        { ok: false, status: 400, statusText: "Bad Request" },
      ),
    );
    const client = makeClient(fetchImpl);
    await expect(
      client.dslQuery({ index: "products", endpoint: "_search", body: {} }),
    ).rejects.toThrow(/No mapping found/);
  });

  test("never leaks the API key even if the server echoes it", async () => {
    const fetchImpl = mock(async () =>
      fetchResponse(
        { error: { type: "security_exception", reason: `bad ApiKey ${API_KEY}` } },
        { ok: false, status: 403, statusText: "Forbidden" },
      ),
    );
    const client = makeClient(fetchImpl);
    const message = await client
      .dslQuery({ index: "products", endpoint: "_search", body: {} })
      .then(
        () => "",
        (err) => (err instanceof Error ? err.message : String(err)),
      );
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
      client.dslQuery({ index: "products", endpoint: "_search", body: {}, timeoutMs: 10 }),
    ).rejects.toThrow(/DSL query timed out after 10ms/);
  });

  test("dslQuery after close rejects", async () => {
    const fetchImpl = mock(async () => fetchResponse(HITS_RESPONSE));
    const client = makeClient(fetchImpl);
    client.close();
    await expect(client.dslQuery({ index: "products", endpoint: "_search", body: {} })).rejects.toThrow(/closed/);
  });
});

// ---------------------------------------------------------------------------
// connection.dslQuery delegates to the client
// ---------------------------------------------------------------------------

describe("createElasticsearchConnection.dslQuery", () => {
  test("exposes dslQuery and returns the raw response", async () => {
    const fetchImpl = mock(async () => fetchResponse(HITS_RESPONSE));
    const conn = createElasticsearchConnection(
      { url: VALID_URL, apiKey: API_KEY },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(typeof conn.dslQuery).toBe("function");
    const raw = await conn.dslQuery({ index: "products", endpoint: "_search", body: { query: { match_all: {} } } });
    expect(raw).toMatchObject({ hits: { total: { value: 2 } } });
  });
});

// ---------------------------------------------------------------------------
// createQueryElasticsearchTool — validation + execution
// ---------------------------------------------------------------------------

describe("createQueryElasticsearchTool — validation guards", () => {
  function makeTool(fetchImpl: unknown, whitelist = new Set(["products"])) {
    const conn = createElasticsearchConnection(
      { url: VALID_URL, apiKey: API_KEY },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    return createQueryElasticsearchTool({
      getConnection: () => conn,
      getWhitelist: () => whitelist,
    });
  }

  test("rejects an index not in the whitelist (no request issued)", async () => {
    const fetchImpl = mock(async () => fetchResponse(HITS_RESPONSE));
    const esTool = makeTool(fetchImpl);
    const result = await esTool.execute!(
      { index: "secrets", endpoint: "_search", body: {}, explanation: "x" },
      EXEC_OPTS,
    );
    expect(result).toMatchObject({ success: false });
    expect((result as { error: string }).error).toMatch(/not in the semantic layer/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("rejects a wildcard index", async () => {
    const fetchImpl = mock(async () => fetchResponse(HITS_RESPONSE));
    const esTool = makeTool(fetchImpl);
    const result = await esTool.execute!(
      { index: "*", endpoint: "_search", body: {}, explanation: "x" },
      EXEC_OPTS,
    );
    expect(result).toMatchObject({ success: false });
    expect((result as { error: string }).error).toMatch(/wildcard/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("rejects a write smuggled into the search body (no request issued)", async () => {
    const fetchImpl = mock(async () => fetchResponse(HITS_RESPONSE));
    const esTool = makeTool(fetchImpl);
    const result = await esTool.execute!(
      { index: "products", endpoint: "_search", body: { query: {}, delete: { _id: "1" } }, explanation: "x" },
      EXEC_OPTS,
    );
    expect(result).toMatchObject({ success: false });
    expect((result as { error: string }).error).toMatch(/write action/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("rejects a mutating script (no request issued)", async () => {
    const fetchImpl = mock(async () => fetchResponse(HITS_RESPONSE));
    const esTool = makeTool(fetchImpl);
    const result = await esTool.execute!(
      {
        index: "products",
        endpoint: "_search",
        body: { script_fields: { x: { script: { source: "ctx._source.deleted = true" } } } },
        explanation: "x",
      },
      EXEC_OPTS,
    );
    expect(result).toMatchObject({ success: false });
    expect((result as { error: string }).error).toMatch(/mutating script/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("surfaces a scrubbed error on a failed query", async () => {
    const fetchImpl = mock(async () =>
      fetchResponse(
        { error: { type: "index_not_found_exception", reason: "no such index [products]" } },
        { ok: false, status: 404, statusText: "Not Found" },
      ),
    );
    const esTool = makeTool(fetchImpl);
    const result = await esTool.execute!(
      { index: "products", endpoint: "_search", body: {}, explanation: "x" },
      EXEC_OPTS,
    );
    expect(result).toMatchObject({ success: false });
    expect((result as { error: string }).error).toMatch(/no such index/);
  });
});

// ---------------------------------------------------------------------------
// END-TO-END — full-text + aggregation questions through a mocked cluster
// ---------------------------------------------------------------------------

describe("queryElasticsearch — end-to-end (mocked cluster)", () => {
  function makeTool(fetchImpl: unknown) {
    const conn = createElasticsearchConnection(
      { url: VALID_URL, apiKey: API_KEY },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    return createQueryElasticsearchTool({
      getConnection: () => conn,
      getWhitelist: () => new Set(["products"]),
    });
  }

  test("a FULL-TEXT question returns a correct relevance-ranked table", async () => {
    const fetchImpl = mock(async () => fetchResponse(HITS_RESPONSE));
    const esTool = makeTool(fetchImpl);
    const result = (await esTool.execute!(
      {
        index: "products",
        endpoint: "_search",
        body: { query: { match: { title: "wireless" } } },
        explanation: "Find wireless products by relevance",
      },
      EXEC_OPTS,
    )) as {
      success: boolean;
      columns: string[];
      rows: Record<string, unknown>[];
      row_count: number;
    };

    expect(result.success).toBe(true);
    expect(result.columns).toEqual(["_id", "_score", "title", "price", "vendor.name"]);
    expect(result.row_count).toBe(2);
    expect(result.rows[0]).toEqual({
      _id: "p1",
      _score: 2.5,
      title: "Wireless Mouse",
      price: 19.99,
      "vendor.name": "Acme",
    });
  });

  test("an AGGREGATION question returns a correct bucketed table", async () => {
    const fetchImpl = mock(async () => fetchResponse(AGG_RESPONSE));
    const esTool = makeTool(fetchImpl);
    const result = (await esTool.execute!(
      {
        index: "products",
        endpoint: "_search",
        body: {
          size: 0,
          aggs: { by_category: { terms: { field: "category" }, aggs: { avg_price: { avg: { field: "price" } } } } },
        },
        explanation: "Average price by category",
      },
      EXEC_OPTS,
    )) as {
      success: boolean;
      columns: string[];
      rows: Record<string, unknown>[];
      row_count: number;
    };

    expect(result.success).toBe(true);
    expect(result.columns).toEqual(["by_category", "by_category.doc_count", "avg_price"]);
    expect(result.rows).toEqual([
      { by_category: "electronics", "by_category.doc_count": 640, avg_price: 82.5 },
      { by_category: "books", "by_category.doc_count": 360, avg_price: 14.2 },
    ]);
  });

  test("a _count question returns a one-cell table", async () => {
    const fetchImpl = mock(async () => fetchResponse({ count: 1000, _shards: {} }));
    const esTool = makeTool(fetchImpl);
    const result = (await esTool.execute!(
      { index: "products", endpoint: "_count", body: { query: { match_all: {} } }, explanation: "Total products" },
      EXEC_OPTS,
    )) as { success: boolean; columns: string[]; rows: Record<string, unknown>[] };

    expect(result.success).toBe(true);
    expect(result.columns).toEqual(["count"]);
    expect(result.rows).toEqual([{ count: 1000 }]);
  });
});

// ---------------------------------------------------------------------------
// Plugin wiring — tool registration + dialect (static vs adapter-only)
// ---------------------------------------------------------------------------

function makeCtx() {
  const registered: { name: string }[] = [];
  const logged: string[] = [];
  return {
    ctx: {
      db: null,
      connections: {
        get: () => {
          throw new Error("not implemented");
        },
        list: () => ["products"] as string[],
        tables: () => [],
      },
      tools: { register: (t: { name: string; description: string; tool: unknown }) => registered.push(t) },
      logger: {
        info: (...args: unknown[]) => logged.push(String(args[0])),
        warn: () => {},
        error: () => {},
        debug: () => {},
      },
      config: {},
    },
    registered,
    logged,
  };
}

describe("plugin wiring — queryElasticsearch registration", () => {
  test("registers queryElasticsearch in static-datasource mode", async () => {
    const plugin = elasticsearchPlugin({ url: VALID_URL, apiKey: API_KEY });
    const { ctx, registered } = makeCtx();
    await plugin.initialize!(ctx);
    expect(registered.some((t) => t.name === "queryElasticsearch")).toBe(true);
  });

  test("does NOT register queryElasticsearch in adapter-only mode", async () => {
    const plugin = elasticsearchPlugin({});
    const { ctx, registered } = makeCtx();
    await plugin.initialize!(ctx);
    expect(registered.some((t) => t.name === "queryElasticsearch")).toBe(false);
  });

  test("the tool input schema pins the executable surface to _search / _count", () => {
    // Second gate: the validator's read allow-list is intentionally broader
    // (defense-in-depth), but the tool only ever executes _search / _count.
    // Widening this enum later must be a deliberate change — this test guards it.
    const esTool = createQueryElasticsearchTool({
      getConnection: () => ({ dslQuery: async () => ({}) }),
      getWhitelist: () => new Set(["products"]),
    });
    const schema = esTool.inputSchema as unknown as {
      safeParse(v: unknown): { success: boolean };
    };
    expect(schema.safeParse({ index: "products", endpoint: "_search", explanation: "x" }).success).toBe(true);
    expect(schema.safeParse({ index: "products", endpoint: "_count", explanation: "x" }).success).toBe(true);
    expect(schema.safeParse({ index: "products", endpoint: "_msearch", explanation: "x" }).success).toBe(false);
    expect(schema.safeParse({ index: "products", endpoint: "_bulk", explanation: "x" }).success).toBe(false);
  });

  test("static-mode dialect includes Query DSL guidance + the queryElasticsearch tool", () => {
    const plugin = elasticsearchPlugin({ url: VALID_URL, apiKey: API_KEY });
    expect(plugin.dialect).toMatch(/Query DSL/);
    expect(plugin.dialect).toMatch(/queryElasticsearch/);
    expect(plugin.dialect).toMatch(/full-text|relevance/i);
    // The SQL guidance is still present.
    expect(plugin.dialect).toMatch(/executeSQL/);
  });

  test("adapter-only dialect omits the queryElasticsearch tool (not registered there)", () => {
    const plugin = elasticsearchPlugin({});
    expect(plugin.dialect).not.toMatch(/queryElasticsearch/);
    // SQL guidance still applies in per-workspace mode.
    expect(plugin.dialect).toMatch(/executeSQL/);
  });
});

// ---------------------------------------------------------------------------
// Index whitelist is sourced from the semantic layer via ctx.connections.tables
// — NOT ctx.connections.list() (connection IDs). Regression guard for #3307.
// ---------------------------------------------------------------------------

describe("plugin wiring — index whitelist comes from ctx.connections.tables (#3307)", () => {
  type ExecTool = { execute: (args: unknown, opts: unknown) => Promise<unknown> };

  // `list()` returns CONNECTION IDs (the pre-#3307 — wrong — whitelist source);
  // `tables()` returns SEMANTIC-LAYER index names (the correct source). They are
  // deliberately disjoint here so a test can tell which one the tool consulted.
  function makeCapturingCtx(tables: string[]) {
    const registered: { name: string; description: string; tool: unknown }[] = [];
    const tablesCalls: string[] = [];
    return {
      registered,
      tablesCalls,
      ctx: {
        db: null,
        connections: {
          get: () => {
            throw new Error("not implemented");
          },
          list: () => ["elasticsearch-datasource"] as string[],
          tables: (id: string) => {
            tablesCalls.push(id);
            return tables;
          },
        },
        tools: {
          register: (t: { name: string; description: string; tool: unknown }) => registered.push(t),
        },
        logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
        config: {},
      },
    };
  }

  async function registerEsTool(tables: string[]): Promise<{ esTool: ExecTool; tablesCalls: string[] }> {
    const plugin = elasticsearchPlugin({ url: VALID_URL, apiKey: API_KEY });
    const { ctx, registered, tablesCalls } = makeCapturingCtx(tables);
    await plugin.initialize!(ctx as unknown as Parameters<NonNullable<typeof plugin.initialize>>[0]);
    const entry = registered.find((t) => t.name === "queryElasticsearch");
    if (!entry) throw new Error("queryElasticsearch tool was not registered");
    return { esTool: entry.tool as ExecTool, tablesCalls };
  }

  test("rejects an index absent from the semantic layer, keyed on the plugin's connection id", async () => {
    const { esTool, tablesCalls } = await registerEsTool(["flights"]);
    const result = await esTool.execute(
      { index: "secret_logs", endpoint: "_search", body: {}, explanation: "x" },
      EXEC_OPTS,
    );
    expect(result).toMatchObject({ success: false });
    expect((result as { error: string }).error).toMatch(/not in the semantic layer/);
    // Pin the whitelist key: the tool must look up tables() under the same id
    // the static connection registers in the ConnectionRegistry under
    // (`registerDirect(plugin.id, …)`), else getWhitelistedTables silently
    // returns [] and the tool drops to structural-only.
    expect(tablesCalls).toContain("elasticsearch-datasource");
  });

  test("rejects the connection id itself — proves tables(), not list(), is the source", async () => {
    // Pre-#3307 the whitelist was `ctx.connections.list()` = ["elasticsearch-datasource"],
    // which would have made the connection id the ONLY 'allowed index'. The fix
    // sources index names from the semantic layer, so the connection id is now
    // (correctly) not a queryable index.
    const { esTool } = await registerEsTool(["flights"]);
    const result = await esTool.execute(
      { index: "elasticsearch-datasource", endpoint: "_search", body: {}, explanation: "x" },
      EXEC_OPTS,
    );
    expect(result).toMatchObject({ success: false });
    expect((result as { error: string }).error).toMatch(/not in the semantic layer/);
  });

  test("a semantic-layer index passes the membership gate (reaches the cluster)", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => fetchResponse(HITS_RESPONSE)) as unknown as typeof fetch;
    try {
      const { esTool } = await registerEsTool(["flights"]);
      const result = await esTool.execute(
        { index: "flights", endpoint: "_search", body: {}, explanation: "x" },
        EXEC_OPTS,
      );
      // The whitelist gate passed — the query reached the mocked cluster and
      // returned a normal, successful result.
      expect(result).toMatchObject({ success: true });
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// #3313 — fail CLOSED when the whitelist accessor throws (semantic-layer scan
// failure), but keep structural-only for a legitimately-empty layer.
// ---------------------------------------------------------------------------

describe("queryElasticsearch — fail closed on semantic-layer scan failure (#3313)", () => {
  function makeTool(opts: { getWhitelist: () => Set<string>; fetchImpl?: unknown }) {
    const conn = createElasticsearchConnection(
      { url: VALID_URL, apiKey: API_KEY },
      { fetchImpl: (opts.fetchImpl ?? mock(async () => fetchResponse(HITS_RESPONSE))) as unknown as typeof fetch },
    );
    return createQueryElasticsearchTool({ getConnection: () => conn, getWhitelist: opts.getWhitelist });
  }

  test("refuses the query when getWhitelist throws — does NOT drop to structural-only, no request issued", async () => {
    const fetchImpl = mock(async () => fetchResponse(HITS_RESPONSE));
    const esTool = makeTool({
      fetchImpl,
      // Mirrors `new Set(ctx.connections.tables(id))` throwing because the
      // strict accessor saw a scan failure.
      getWhitelist: () => {
        throw new Error("Semantic-layer scan failed — whitelist load incomplete");
      },
    });
    const result = await esTool.execute!(
      // `products` would PASS structural-only (named, non-system) — proving the
      // refusal is the scan-failure fail-closed, not an ordinary membership reject.
      { index: "products", endpoint: "_search", body: {}, explanation: "x" },
      EXEC_OPTS,
    );
    expect(result).toMatchObject({ success: false });
    expect((result as { error: string }).error).toMatch(/unavailable|refus/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("structural-only still applies for a legitimately-empty whitelist (named index reaches the cluster)", async () => {
    const fetchImpl = mock(async () => fetchResponse(HITS_RESPONSE));
    const esTool = makeTool({ fetchImpl, getWhitelist: () => new Set() });
    const result = await esTool.execute!(
      { index: "products", endpoint: "_search", body: {}, explanation: "x" },
      EXEC_OPTS,
    );
    expect(result).toMatchObject({ success: true });
    expect(fetchImpl).toHaveBeenCalled();
  });
});
