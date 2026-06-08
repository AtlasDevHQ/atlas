import { describe, test, expect } from "bun:test";

import {
  validateEsDslRequest,
  isReadEndpoint,
  validateIndexAccess,
  applyDslSafeguards,
  normalizeDslResponse,
  flattenSource,
  ES_READ_ENDPOINTS,
  DEFAULT_DSL_MAX_SIZE,
  DEFAULT_DSL_TERMINATE_AFTER,
} from "../src/dsl";

// ===========================================================================
// validateEsDslRequest — THE SECURITY BOUNDARY (default-deny)
// ===========================================================================

describe("validateEsDslRequest — read endpoints allowed", () => {
  test.each([
    ["_search", { query: { match_all: {} } }],
    ["_count", { query: { term: { status: "open" } } }],
    ["_msearch", undefined],
    ["_field_caps", { fields: ["price"] }],
    ["_mapping", undefined],
    ["_cat", undefined],
    ["_cat/indices", undefined],
    ["_cat/aliases", undefined],
  ])("allows read shape %s", (endpoint, body) => {
    expect(validateEsDslRequest({ endpoint, body }).valid).toBe(true);
  });

  test("the allow-list constant is exactly the documented read set", () => {
    expect([...ES_READ_ENDPOINTS].sort()).toEqual(
      ["_count", "_field_caps", "_mapping", "_msearch", "_search"].sort(),
    );
  });

  test("allows a relevance/full-text search body", () => {
    const result = validateEsDslRequest({
      endpoint: "_search",
      body: { query: { multi_match: { query: "wireless", fields: ["title", "desc"] } } },
    });
    expect(result.valid).toBe(true);
  });

  test("allows a deeply-nested aggregation body", () => {
    const result = validateEsDslRequest({
      endpoint: "_search",
      body: {
        size: 0,
        aggs: { by_cat: { terms: { field: "category" }, aggs: { avg_price: { avg: { field: "price" } } } } },
      },
    });
    expect(result.valid).toBe(true);
  });

  test("allows a NON-mutating script (script_score relevance tuning)", () => {
    const result = validateEsDslRequest({
      endpoint: "_search",
      body: {
        query: {
          script_score: {
            query: { match_all: {} },
            script: { source: "Math.log(2 + doc['likes'].value)" },
          },
        },
      },
    });
    expect(result.valid).toBe(true);
  });
});

describe("validateEsDslRequest — default-denies write/admin endpoints", () => {
  test.each([
    "_bulk",
    "_update",
    "_delete_by_query",
    "_update_by_query",
    "_doc",
    "_create",
    "_reindex",
    "_aliases",
    "_settings",
    "_close",
    "_open",
    "_forcemerge",
    "_search/scroll",
    "_unknown_future_endpoint",
  ])("denies %s", (endpoint) => {
    const result = validateEsDslRequest({ endpoint });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/read-only/);
  });

  test("denies an empty / whitespace endpoint", () => {
    expect(validateEsDslRequest({ endpoint: "" }).valid).toBe(false);
    expect(validateEsDslRequest({ endpoint: "   " }).valid).toBe(false);
  });

  test("denies a path-traversal endpoint that tries to escape to a write op", () => {
    expect(validateEsDslRequest({ endpoint: "_search/../_bulk" }).valid).toBe(false);
    expect(validateEsDslRequest({ endpoint: "../_bulk" }).valid).toBe(false);
  });

  test("denies an index-scoped write path (e.g. flights/_doc/1)", () => {
    expect(validateEsDslRequest({ endpoint: "flights/_doc/1" }).valid).toBe(false);
  });

  test("denies a query-string smuggled into the endpoint", () => {
    expect(validateEsDslRequest({ endpoint: "_search?scroll=1m" }).valid).toBe(false);
  });
});

describe("validateEsDslRequest — adversarial: writes smuggled into a read body", () => {
  test("denies a bulk-style write smuggled into a _search body (top-level delete)", () => {
    const result = validateEsDslRequest({
      endpoint: "_search",
      body: { query: { match_all: {} }, delete: { _id: "1" } },
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/write action/i);
  });

  test.each(["index", "create", "update", "delete", "delete_by_query", "update_by_query", "bulk"])(
    "denies top-level write key %s in a read body",
    (key) => {
      const result = validateEsDslRequest({ endpoint: "_search", body: { [key]: { doc: {} } } });
      expect(result.valid).toBe(false);
    },
  );

  test("denies a write smuggled into a _count body (the other executable endpoint)", () => {
    const result = validateEsDslRequest({
      endpoint: "_count",
      body: { query: { match_all: {} }, delete: { _id: "1" } },
    });
    expect(result.valid).toBe(false);
    expect(result.valid === false && result.reason).toMatch(/write action/i);
  });

  test("does NOT false-positive on a field literally named 'update' nested in a query", () => {
    const result = validateEsDslRequest({
      endpoint: "_search",
      body: { query: { term: { update: "2024-01-01" } } },
    });
    expect(result.valid).toBe(true);
  });

  test("does NOT false-positive on a field named 'delete' inside a nested filter", () => {
    const result = validateEsDslRequest({
      endpoint: "_search",
      body: { query: { bool: { filter: [{ term: { delete: true } }] } } },
    });
    expect(result.valid).toBe(true);
  });
});

describe("validateEsDslRequest — adversarial: mutating scripts", () => {
  test("denies a mutating script (ctx._source) in an aggregation", () => {
    const result = validateEsDslRequest({
      endpoint: "_search",
      body: {
        size: 0,
        aggs: {
          evil: { scripted_metric: { map_script: { source: "ctx._source.deleted = true" } } },
        },
      },
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/mutating script/i);
  });

  test("denies a ctx.op = 'delete' mutating script in script_fields", () => {
    const result = validateEsDslRequest({
      endpoint: "_search",
      body: { script_fields: { x: { script: { source: "ctx.op = 'delete'" } } } },
    });
    expect(result.valid).toBe(false);
  });

  test("denies a ctx[...] bracket-access mutating script in runtime_mappings", () => {
    const result = validateEsDslRequest({
      endpoint: "_search",
      body: { runtime_mappings: { f: { type: "long", script: { source: "ctx['_source']" } } } },
    });
    expect(result.valid).toBe(false);
  });

  test("denies a mutating script passed as a bare string", () => {
    const result = validateEsDslRequest({
      endpoint: "_search",
      body: { query: { function_score: { script_score: { script: "ctx._source.x++" } } } },
    });
    expect(result.valid).toBe(false);
  });

  test("does NOT false-positive on a document field named 'source' whose value contains 'ctx.'", () => {
    // Log/event indices commonly have a `source` field; matching it must not be
    // mistaken for a script body. Only `script`/`*_script` subtrees are scanned.
    const result = validateEsDslRequest({
      endpoint: "_search",
      body: { query: { term: { source: "ctx.payment-service" } } },
    });
    expect(result.valid).toBe(true);
  });

  test("does NOT false-positive on an 'inline' document field containing 'ctx['", () => {
    const result = validateEsDslRequest({
      endpoint: "_search",
      body: { query: { match: { inline: "ctx[0] reference" } } },
    });
    expect(result.valid).toBe(true);
  });

  test("denies a mutating script in a _count body too", () => {
    const result = validateEsDslRequest({
      endpoint: "_count",
      body: { query: { script: { script: { source: "ctx.op = 'delete'" } } } },
    });
    expect(result.valid).toBe(false);
    expect(result.valid === false && result.reason).toMatch(/mutating script/i);
  });
});

describe("validateEsDslRequest — adversarial: stored-script references", () => {
  test("denies a stored-script reference (script.id) — body is server-side, unverifiable", () => {
    const result = validateEsDslRequest({
      endpoint: "_search",
      body: { script_fields: { x: { script: { id: "my_stored_script" } } } },
    });
    expect(result.valid).toBe(false);
    expect(result.valid === false && result.reason).toMatch(/stored-script reference/i);
  });

  test("denies a stored-script reference nested under script_score", () => {
    const result = validateEsDslRequest({
      endpoint: "_search",
      body: { query: { function_score: { script_score: { script: { id: "x" } } } } },
    });
    expect(result.valid).toBe(false);
    expect(result.valid === false && result.reason).toMatch(/stored-script reference/i);
  });

  test("still allows an inline read-only script (script.source)", () => {
    const result = validateEsDslRequest({
      endpoint: "_search",
      body: {
        query: { function_score: { script_score: { script: { source: "doc['likes'].value" } } } },
      },
    });
    expect(result.valid).toBe(true);
  });

  test("does NOT false-positive on a terms LOOKUP against a field named like a script", () => {
    // `{ terms: { <field>: { index, id, path } } }` carries a string `id`, and the
    // looked-up field may legitimately be named `*_script`. The index/path markers
    // distinguish it from a real stored-script reference.
    const result = validateEsDslRequest({
      endpoint: "_search",
      body: {
        query: {
          terms: { deploy_script: { index: "deployments", id: "rel-42", path: "scripts" } },
        },
      },
    });
    expect(result.valid).toBe(true);
  });
});

describe("isReadEndpoint", () => {
  test("strips surrounding slashes before matching", () => {
    expect(isReadEndpoint("/_search/")).toBe(true);
    expect(isReadEndpoint("/_bulk/")).toBe(false);
  });
  test("rejects a non-string", () => {
    expect(isReadEndpoint(undefined as unknown as string)).toBe(false);
  });
  test("allows the _cat family but not arbitrary two-segment paths", () => {
    expect(isReadEndpoint("_cat/health")).toBe(true);
    expect(isReadEndpoint("_search/scroll")).toBe(false);
  });
});

// ===========================================================================
// validateIndexAccess — per-index whitelist + always-on rails
// ===========================================================================

describe("validateIndexAccess", () => {
  const allowed = new Set(["flights", "orders", "products"]);

  test("allows an index in the whitelist", () => {
    expect(validateIndexAccess("flights", allowed).valid).toBe(true);
  });

  test("is case-insensitive", () => {
    expect(validateIndexAccess("Flights", allowed).valid).toBe(true);
  });

  test("allows multiple comma-separated whitelisted indices", () => {
    expect(validateIndexAccess("flights,orders", allowed).valid).toBe(true);
  });

  test("rejects an index not in the whitelist", () => {
    const result = validateIndexAccess("secrets", allowed);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/not in the semantic layer/);
  });

  test("rejects if ANY of several indices is not whitelisted", () => {
    expect(validateIndexAccess("flights,secrets", allowed).valid).toBe(false);
  });

  test.each(["*", "flights*", "log-?", "fl?ghts"])("rejects wildcard %s", (idx) => {
    const result = validateIndexAccess(idx, allowed);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/wildcard/i);
  });

  test("rejects _all even when the whitelist is empty", () => {
    expect(validateIndexAccess("_all", new Set()).valid).toBe(false);
  });

  test("rejects system / internal indices (leading . or _)", () => {
    expect(validateIndexAccess(".kibana", allowed).valid).toBe(false);
    expect(validateIndexAccess("_nodes", allowed).valid).toBe(false);
  });

  test("rejects an empty index", () => {
    expect(validateIndexAccess("", allowed).valid).toBe(false);
    expect(validateIndexAccess("   ", allowed).valid).toBe(false);
  });

  test("structural-only fallback: empty whitelist still applies the rails but allows named indices", () => {
    expect(validateIndexAccess("flights", new Set()).valid).toBe(true);
    expect(validateIndexAccess("anything-not-in-layer", new Set()).valid).toBe(true);
    expect(validateIndexAccess("*", new Set()).valid).toBe(false);
  });

  test.each([
    "products/_doc/1/_update",
    "products/_doc/1",
    "orders%0a",
    "orders flights",
    'a"b',
    "a<b",
    "a|b",
  ])("rejects an out-of-charset index segment %p (path-injection guard)", (idx) => {
    // Self-contained safety: the validator must reject illegal index-name chars
    // (slashes, whitespace, control, quotes) on its own — not rely on a downstream
    // caller URL-encoding the segment. Checked even in structural-only mode.
    const result = validateIndexAccess(idx, new Set());
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/not allowed in an index name/);
  });

  test("allows ordinary date-suffixed concrete index names (dots and hyphens)", () => {
    expect(validateIndexAccess("logs-2024.01.01", new Set()).valid).toBe(true);
  });

  test("allows a whitelisted Unicode (non-ASCII) index name (deny-list, not ASCII allow-list)", () => {
    // Elasticsearch permits Unicode index names; the path-injection guard is a
    // deny-list of dangerous chars, so a CJK-named whitelisted index still passes.
    expect(validateIndexAccess("ログ", new Set(["ログ"])).valid).toBe(true);
    expect(validateIndexAccess("café-logs", new Set()).valid).toBe(true);
  });

  test("allows a wildcard index-pattern entity that is an explicit whitelist member (#3269)", () => {
    const withPattern = new Set(["logs-*", "flights"]);
    expect(validateIndexAccess("logs-*", withPattern).valid).toBe(true);
    // Case-insensitive, like concrete names.
    expect(validateIndexAccess("LOGS-*", withPattern).valid).toBe(true);
    // Combined with a concrete member.
    expect(validateIndexAccess("logs-*,flights", withPattern).valid).toBe(true);
  });

  test("still rejects a wildcard that is NOT a declared pattern entity (#3269)", () => {
    const withPattern = new Set(["logs-*"]);
    const result = validateIndexAccess("metrics-*", withPattern);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/wildcard/i);
  });

  test("a pattern entity does not authorize structural-only wildcards", () => {
    // The pattern is allowed only because it's a member; with an empty layer the
    // no-wildcard rail still fires.
    expect(validateIndexAccess("logs-*", new Set()).valid).toBe(false);
  });
});

// ===========================================================================
// applyDslSafeguards — size cap + timeout + terminate_after
// ===========================================================================

describe("applyDslSafeguards", () => {
  test("clamps an over-large size to maxSize", () => {
    const out = applyDslSafeguards("_search", { size: 10000 }, { maxSize: 1000 });
    expect(out.size).toBe(1000);
  });

  test("defaults an omitted size to maxSize", () => {
    const out = applyDslSafeguards("_search", { query: { match_all: {} } }, { maxSize: 500 });
    expect(out.size).toBe(500);
  });

  test("preserves an explicit size: 0 (aggregation request)", () => {
    const out = applyDslSafeguards("_search", { size: 0, aggs: {} }, { maxSize: 1000 });
    expect(out.size).toBe(0);
  });

  test("falls back to DEFAULT_DSL_MAX_SIZE when no maxSize is given", () => {
    const out = applyDslSafeguards("_search", {}, {});
    expect(out.size).toBe(DEFAULT_DSL_MAX_SIZE);
  });

  test("clamps a negative size up to 0", () => {
    const out = applyDslSafeguards("_search", { size: -5 }, { maxSize: 1000 });
    expect(out.size).toBe(0);
  });

  test("treats a non-finite size (NaN / Infinity) as omitted → maxSize", () => {
    expect(applyDslSafeguards("_search", { size: NaN }, { maxSize: 500 }).size).toBe(500);
    expect(applyDslSafeguards("_search", { size: Infinity }, { maxSize: 500 }).size).toBe(500);
  });

  test("floors a fractional size (ES rejects a non-integer size)", () => {
    const out = applyDslSafeguards("_search", { size: 5.9 }, { maxSize: 1000 });
    expect(out.size).toBe(5);
  });

  test("sets a search timeout from timeoutMs", () => {
    const out = applyDslSafeguards("_search", {}, { timeoutMs: 30000 });
    expect(out.timeout).toBe("30000ms");
  });

  test("adds terminate_after to a non-aggregation search", () => {
    const out = applyDslSafeguards("_search", { query: { match_all: {} } }, { terminateAfter: 50000 });
    expect(out.terminate_after).toBe(50000);
  });

  test("does NOT add terminate_after to an aggregation search (preserves accuracy)", () => {
    const out = applyDslSafeguards(
      "_search",
      { size: 0, aggs: { x: { terms: { field: "c" } } } },
      { terminateAfter: 50000 },
    );
    expect(out.terminate_after).toBeUndefined();
  });

  test("does NOT add terminate_after when set to 0 (disabled)", () => {
    const out = applyDslSafeguards("_search", { query: {} }, { terminateAfter: 0 });
    expect(out.terminate_after).toBeUndefined();
  });

  test("recognizes the `aggregations` long-form key too", () => {
    const out = applyDslSafeguards(
      "_search",
      { size: 0, aggregations: { x: { sum: { field: "n" } } } },
      { terminateAfter: 50000 },
    );
    expect(out.terminate_after).toBeUndefined();
  });

  test("uses DEFAULT_DSL_TERMINATE_AFTER when none is given", () => {
    const out = applyDslSafeguards("_search", { query: {} }, {});
    expect(out.terminate_after).toBe(DEFAULT_DSL_TERMINATE_AFTER);
  });

  test("does not mutate the input body", () => {
    const body = { size: 10000 };
    applyDslSafeguards("_search", body, { maxSize: 100 });
    expect(body.size).toBe(10000);
  });

  test("leaves a _count body untouched (no size/terminate_after injection)", () => {
    const out = applyDslSafeguards("_count", { query: { match_all: {} } }, { maxSize: 100 });
    expect(out.size).toBeUndefined();
    expect(out.terminate_after).toBeUndefined();
    expect(out.query).toEqual({ match_all: {} });
  });
});

// ===========================================================================
// normalizeDslResponse — hits + aggregations → { columns, rows }
// ===========================================================================

describe("normalizeDslResponse — full-text hits", () => {
  test("flattens hits.hits[]._source into one row per document with _id/_score", () => {
    const body = {
      hits: {
        total: { value: 2 },
        hits: [
          { _id: "p1", _score: 2.5, _source: { title: "Wireless Mouse", price: 19.99 } },
          { _id: "p2", _score: 1.1, _source: { title: "USB Cable", price: 5.0 } },
        ],
      },
    };
    const result = normalizeDslResponse(body);
    expect(result.columns).toEqual(["_id", "_score", "title", "price"]);
    expect(result.rows).toEqual([
      { _id: "p1", _score: 2.5, title: "Wireless Mouse", price: 19.99 },
      { _id: "p2", _score: 1.1, title: "USB Cable", price: 5.0 },
    ]);
  });

  test("flattens nested _source objects to dotted paths; arrays stay as values", () => {
    const body = {
      hits: {
        hits: [
          { _id: "1", _score: 1, _source: { vendor: { name: "Acme", tier: "gold" }, tags: ["a", "b"] } },
        ],
      },
    };
    const result = normalizeDslResponse(body);
    expect(result.columns).toEqual(["_id", "_score", "vendor.name", "vendor.tier", "tags"]);
    expect(result.rows[0]).toEqual({
      _id: "1",
      _score: 1,
      "vendor.name": "Acme",
      "vendor.tier": "gold",
      tags: ["a", "b"],
    });
  });

  test("unions columns across hits with differing source keys (first-seen order)", () => {
    const body = {
      hits: {
        hits: [
          { _id: "1", _score: 1, _source: { a: 1 } },
          { _id: "2", _score: 1, _source: { b: 2 } },
        ],
      },
    };
    const result = normalizeDslResponse(body);
    expect(result.columns).toEqual(["_id", "_score", "a", "b"]);
    expect(result.rows[1]).toEqual({ _id: "2", _score: 1, b: 2 });
  });

  test("handles a null _score (constant_score / unscored query)", () => {
    const body = { hits: { hits: [{ _id: "1", _score: null, _source: { x: 1 } }] } };
    const result = normalizeDslResponse(body);
    expect(result.rows[0]).toEqual({ _id: "1", _score: null, x: 1 });
  });

  test("empty hits → columns and rows are empty", () => {
    expect(normalizeDslResponse({ hits: { total: { value: 0 }, hits: [] } })).toEqual({
      columns: [],
      rows: [],
    });
  });
});

describe("normalizeDslResponse — aggregations", () => {
  test("flattens a single bucket terms agg (key + doc_count)", () => {
    const body = {
      aggregations: {
        by_status: {
          buckets: [
            { key: "open", doc_count: 42 },
            { key: "closed", doc_count: 17 },
          ],
        },
      },
    };
    const result = normalizeDslResponse(body);
    expect(result.columns).toEqual(["by_status", "by_status.doc_count"]);
    expect(result.rows).toEqual([
      { by_status: "open", "by_status.doc_count": 42 },
      { by_status: "closed", "by_status.doc_count": 17 },
    ]);
  });

  test("flattens a bucket agg with a nested metric agg (cross-tab to columns)", () => {
    const body = {
      aggregations: {
        by_cat: {
          buckets: [
            { key: "books", doc_count: 10, avg_price: { value: 12.5 } },
            { key: "toys", doc_count: 4, avg_price: { value: 8.0 } },
          ],
        },
      },
    };
    const result = normalizeDslResponse(body);
    expect(result.columns).toEqual(["by_cat", "by_cat.doc_count", "avg_price"]);
    expect(result.rows).toEqual([
      { by_cat: "books", "by_cat.doc_count": 10, avg_price: 12.5 },
      { by_cat: "toys", "by_cat.doc_count": 4, avg_price: 8.0 },
    ]);
  });

  test("flattens nested bucket aggs into one row per leaf bucket (group × subgroup)", () => {
    const body = {
      aggregations: {
        by_region: {
          buckets: [
            {
              key: "us",
              doc_count: 100,
              by_status: {
                buckets: [
                  { key: "open", doc_count: 60 },
                  { key: "closed", doc_count: 40 },
                ],
              },
            },
            {
              key: "eu",
              doc_count: 30,
              by_status: { buckets: [{ key: "open", doc_count: 30 }] },
            },
          ],
        },
      },
    };
    const result = normalizeDslResponse(body);
    expect(result.rows).toEqual([
      { by_region: "us", "by_region.doc_count": 100, by_status: "open", "by_status.doc_count": 60 },
      { by_region: "us", "by_region.doc_count": 100, by_status: "closed", "by_status.doc_count": 40 },
      { by_region: "eu", "by_region.doc_count": 30, by_status: "open", "by_status.doc_count": 30 },
    ]);
  });

  test("flattens a top-level metric agg into a single row", () => {
    const body = { aggregations: { total_revenue: { value: 98765.4 } } };
    const result = normalizeDslResponse(body);
    expect(result.columns).toEqual(["total_revenue"]);
    expect(result.rows).toEqual([{ total_revenue: 98765.4 }]);
  });

  test("expands a multi-value stats metric agg into per-stat columns", () => {
    const body = {
      aggregations: { price_stats: { count: 5, min: 1, max: 10, avg: 5.5, sum: 27.5 } },
    };
    const result = normalizeDslResponse(body);
    expect(result.rows[0]).toMatchObject({
      "price_stats.count": 5,
      "price_stats.min": 1,
      "price_stats.max": 10,
      "price_stats.avg": 5.5,
      "price_stats.sum": 27.5,
    });
  });

  test("expands keyed percentiles into per-percentile columns", () => {
    const body = {
      aggregations: { load_pct: { values: { "50.0": 120, "95.0": 480 } } },
    };
    const result = normalizeDslResponse(body);
    expect(result.rows[0]).toEqual({ "load_pct.50.0": 120, "load_pct.95.0": 480 });
  });

  test("handles keyed (object-form) buckets (e.g. filters agg)", () => {
    const body = {
      aggregations: {
        severities: {
          buckets: {
            errors: { doc_count: 9 },
            warnings: { doc_count: 21 },
          },
        },
      },
    };
    const result = normalizeDslResponse(body);
    expect(result.rows).toEqual([
      { severities: "errors", "severities.doc_count": 9 },
      { severities: "warnings", "severities.doc_count": 21 },
    ]);
  });

  test("prefers key_as_string for date_histogram buckets", () => {
    const body = {
      aggregations: {
        per_day: {
          buckets: [
            { key_as_string: "2024-01-01", key: 1704067200000, doc_count: 5 },
            { key_as_string: "2024-01-02", key: 1704153600000, doc_count: 8 },
          ],
        },
      },
    };
    const result = normalizeDslResponse(body);
    expect(result.rows.map((r) => r.per_day)).toEqual(["2024-01-01", "2024-01-02"]);
  });

  test("recurses into a single-bucket (filter) agg, surfacing its doc_count + sub-aggs", () => {
    const body = {
      aggregations: {
        in_stock: {
          doc_count: 12,
          avg_price: { value: 22.0 },
        },
      },
    };
    const result = normalizeDslResponse(body);
    expect(result.rows[0]).toEqual({ "in_stock.doc_count": 12, avg_price: 22.0 });
  });

  test("aggregations take precedence over hits when both are present", () => {
    const body = {
      hits: { hits: [{ _id: "1", _score: 1, _source: { a: 1 } }] },
      aggregations: { n: { value: 5 } },
    };
    const result = normalizeDslResponse(body);
    expect(result.columns).toEqual(["n"]);
    expect(result.rows).toEqual([{ n: 5 }]);
  });
});

describe("normalizeDslResponse — _count and degenerate bodies", () => {
  test("normalizes a _count response into a one-cell table", () => {
    expect(normalizeDslResponse({ count: 137, _shards: {} })).toEqual({
      columns: ["count"],
      rows: [{ count: 137 }],
    });
  });

  test("returns empty for a non-object / empty body", () => {
    expect(normalizeDslResponse(undefined)).toEqual({ columns: [], rows: [] });
    expect(normalizeDslResponse(null)).toEqual({ columns: [], rows: [] });
    expect(normalizeDslResponse("nope")).toEqual({ columns: [], rows: [] });
    expect(normalizeDslResponse({})).toEqual({ columns: [], rows: [] });
  });
});

describe("normalizeDslResponse — malformed shapes degrade gracefully (never throw)", () => {
  test("a bucket agg whose `buckets` is neither array nor object yields no rows", () => {
    expect(() => normalizeDslResponse({ aggregations: { x: { buckets: null } } })).not.toThrow();
    expect(normalizeDslResponse({ aggregations: { x: { buckets: 7 } } })).toEqual({ columns: [], rows: [] });
  });

  test("a hit missing _source produces an _id/_score-only row (no crash)", () => {
    const result = normalizeDslResponse({ hits: { hits: [{ _id: "1", _score: 1 }] } });
    expect(result.rows).toEqual([{ _id: "1", _score: 1 }]);
    expect(result.columns).toEqual(["_id", "_score"]);
  });

  test("a hit with a non-object _source is skipped, not spread", () => {
    const result = normalizeDslResponse({ hits: { hits: [{ _id: "1", _score: 1, _source: "oops" }] } });
    expect(result.rows).toEqual([{ _id: "1", _score: 1 }]);
  });

  test("an empty metric agg object adds no column and does not crash", () => {
    const result = normalizeDslResponse({ aggregations: { mystery: {} } });
    expect(result).toEqual({ columns: [], rows: [] });
  });
});

describe("flattenSource", () => {
  test("keeps falsy scalars (0, false, empty string) and null", () => {
    expect(flattenSource({ a: 0, b: false, c: "", d: null })).toEqual({
      a: 0,
      b: false,
      c: "",
      d: null,
    });
  });

  test("recurses nested objects but treats arrays as leaf values", () => {
    expect(flattenSource({ x: { y: { z: 1 } }, list: [1, 2] })).toEqual({
      "x.y.z": 1,
      list: [1, 2],
    });
  });
});
