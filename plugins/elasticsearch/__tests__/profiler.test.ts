/**
 * Elasticsearch / OpenSearch introspection (ADR-0017) — `listObjects` / `profile`
 * against a mocked thin fetch client. Asserts external behavior through the seam
 * contract: the right logical objects enumerate, index/alias/data-stream collapse
 * matches #3269, field mappings map to column profiles with sample values + enum-
 * like detection, an empty/edge-case index set yields no objects, and a per-object
 * sample failure is recorded (not thrown). Mirrors the ClickHouse profiler test.
 */

import { describe, test, expect, mock } from "bun:test";

import {
  listElasticsearchObjects,
  profileElasticsearchObjects,
} from "../src/profiler";

const URL = "elasticsearch://localhost:9200?ssl=false";
const API_KEY = "dGVzdC1lcy1rZXk=";

// The seam profiler resolves auth from the ATLAS_ES_* env contract (it runs in
// the operator's shell). Pass a minimal API-key env into every call's options
// via the module-level env — listObjects/profile take only `{ url }`, so the
// fetch is injected through the connection's `fetchImpl`… but the seam functions
// build the client internally. We therefore drive auth through process.env using
// a hoisted default that every test relies on.
process.env.ATLAS_ES_API_KEY ??= API_KEY;

/** Minimal Response-like object the thin client reads (ok/status/json). */
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

const MAPPING = {
  products: {
    mappings: {
      properties: {
        sku: { type: "keyword" },
        title: { type: "text", fields: { keyword: { type: "keyword" } } },
        price: { type: "double" },
        created_at: { type: "date" },
        status: { type: "keyword" },
        vendor: { properties: { name: { type: "text" }, rating: { type: "float" } } },
      },
    },
  },
  customers: {
    mappings: { properties: { email: { type: "keyword" } } },
  },
  ".kibana": {
    mappings: { properties: { config: { type: "keyword" } } },
  },
};

/**
 * Build a `globalThis.fetch` mock routing by URL path:
 *   - `/_alias`, `/_data_stream` → the (optional) bodies, else `{}`
 *   - `/<name>/_mapping` → that name's data-stream mapping (else `{}`)
 *   - `/<index>/_search` → a hits body for sampling
 *   - `/<index>/_count` → a count body
 *   - `/_mapping` → the full mapping
 *
 * Installed as the global fetch for the duration of one test (the seam functions
 * construct their own client, so there is no `fetchImpl` injection point — we
 * stub `globalThis.fetch` instead).
 */
function installFetch(bodies: {
  mapping: Record<string, unknown>;
  aliases?: Record<string, unknown>;
  dataStreams?: Record<string, unknown>;
  dataStreamMappings?: Record<string, Record<string, unknown>>;
  search?: (index: string) => unknown;
  count?: (index: string) => number;
  failSearchFor?: string;
}): { restore: () => void; calls: { method: string; path: string }[] } {
  const original = globalThis.fetch;
  const calls: { method: string; path: string }[] = [];
  const impl = mock(async (input: string | URL, init?: RequestInit) => {
    const path = new globalThis.URL(
      typeof input === "string" ? input : input.toString(),
    ).pathname;
    calls.push({ method: init?.method ?? "GET", path });

    if (path === "/_alias") return fetchResponse(bodies.aliases ?? {});
    if (path === "/_data_stream") return fetchResponse(bodies.dataStreams ?? {});

    const search = path.match(/^\/(.+)\/_search$/);
    if (search) {
      const index = decodeURIComponent(search[1]);
      if (bodies.failSearchFor && index === bodies.failSearchFor) {
        return fetchResponse(
          { error: { type: "search_phase_execution_exception", reason: "all shards failed" } },
          { ok: false, status: 503, statusText: "Service Unavailable" },
        );
      }
      const body = bodies.search ? bodies.search(index) : { hits: { hits: [] } };
      return fetchResponse(body);
    }

    const count = path.match(/^\/(.+)\/_count$/);
    if (count) {
      const index = decodeURIComponent(count[1]);
      return fetchResponse({ count: bodies.count ? bodies.count(index) : 0 });
    }

    const m = path.match(/^\/([^/]+)\/_mapping$/);
    if (m) {
      const name = decodeURIComponent(m[1]);
      return fetchResponse(bodies.dataStreamMappings?.[name] ?? {});
    }

    return fetchResponse(bodies.mapping);
  }) as unknown as typeof fetch;

  globalThis.fetch = impl;
  return { restore: () => void (globalThis.fetch = original), calls };
}

/** Build a `_search` hits body from an array of `_source` docs. */
function hitsBody(docs: Record<string, unknown>[]): unknown {
  return { hits: { hits: docs.map((source) => ({ _source: source })) } };
}

// ---------------------------------------------------------------------------
// listObjects
// ---------------------------------------------------------------------------

describe("listElasticsearchObjects", () => {
  test("enumerates non-system indices as logical objects (type table)", async () => {
    const { restore } = installFetch({ mapping: MAPPING });
    try {
      const objects = await listElasticsearchObjects({ url: URL });
      expect(objects).toEqual([
        { name: "products", type: "table" },
        { name: "customers", type: "table" },
      ]);
    } finally {
      restore();
    }
  });

  test("collapses an index pattern and an alias into one object each (#3269)", async () => {
    const { restore } = installFetch({
      mapping: {
        "logs-2024.01.01": { mappings: { properties: { ts: { type: "date" } } } },
        "logs-2024.01.02": { mappings: { properties: { level: { type: "keyword" } } } },
        orders_v3: { mappings: { properties: { id: { type: "keyword" } } } },
      },
      aliases: { orders_v3: { aliases: { orders: {} } } },
    });
    try {
      const objects = await listElasticsearchObjects({ url: URL });
      const names = objects.map((o) => o.name).sort();
      // `logs-*` collapses the daily indices; `orders` is the alias (its backing
      // index is not also emitted).
      expect(names).toEqual(["logs-*", "orders"]);
      expect(objects.every((o) => o.type === "table")).toBe(true);
    } finally {
      restore();
    }
  });

  test("enumerates a data stream from its backing-index mapping", async () => {
    const { restore } = installFetch({
      mapping: {},
      dataStreams: {
        data_streams: [{ name: "events", indices: [{ index_name: ".ds-events-000001" }] }],
      },
      dataStreamMappings: {
        events: {
          ".ds-events-000001": { mappings: { properties: { kind: { type: "keyword" } } } },
        },
      },
    });
    try {
      const objects = await listElasticsearchObjects({ url: URL });
      expect(objects).toEqual([{ name: "events", type: "table" }]);
    } finally {
      restore();
    }
  });

  test("returns no objects for a cluster with only system / empty indices", async () => {
    const { restore } = installFetch({
      mapping: {
        ".kibana": { mappings: { properties: { config: { type: "keyword" } } } },
        empty_index: { mappings: { properties: {} } },
      },
    });
    try {
      const objects = await listElasticsearchObjects({ url: URL });
      expect(objects).toEqual([]);
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// profile
// ---------------------------------------------------------------------------

describe("profileElasticsearchObjects", () => {
  test("maps field mappings to column profiles with sample values + enum-like", async () => {
    const { restore } = installFetch({
      mapping: MAPPING,
      count: () => 100,
      search: (index) =>
        index === "products"
          ? hitsBody([
              { sku: "A1", price: 9.99, status: "active", created_at: "2024-01-01" },
              { sku: "A2", price: 19.99, status: "active", created_at: "2024-01-02" },
              { sku: "A3", price: 5.0, status: "churned" },
            ])
          : hitsBody([{ email: "a@x.com" }]),
    });
    try {
      const result = await profileElasticsearchObjects({ url: URL, selectedTables: ["products"] });
      expect(result.errors).toEqual([]);
      expect(result.profiles).toHaveLength(1);

      const products = result.profiles[0];
      expect(products.table_name).toBe("products");
      expect(products.object_type).toBe("table");
      expect(products.row_count).toBe(100);
      // ES has no PKs / FKs.
      expect(products.primary_key_columns).toEqual([]);
      expect(products.columns.every((c) => c.is_foreign_key === false)).toBe(true);
      expect(products.columns.every((c) => c.is_primary_key === false)).toBe(true);

      // Object container is not a column; flattened leaves + multi-field are.
      const names = products.columns.map((c) => c.name);
      expect(names).toContain("sku");
      expect(names).toContain("title.keyword");
      expect(names).toContain("vendor.rating");
      expect(names).not.toContain("vendor");

      // `status` is a low-cardinality keyword → enum-like, with its distinct values.
      const status = products.columns.find((c) => c.name === "status")!;
      expect(status.is_enum_like).toBe(true);
      expect(status.sample_values.sort()).toEqual(["active", "churned"]);

      // `created_at` keeps its ES type; `price` is numeric (not enum-like).
      const createdAt = products.columns.find((c) => c.name === "created_at")!;
      expect(createdAt.type).toBe("date");
      const price = products.columns.find((c) => c.name === "price")!;
      expect(price.is_enum_like).toBe(false);
      expect(price.sample_values).toContain("9.99");
    } finally {
      restore();
    }
  });

  test("counts missing fields as nulls in the sampled docs", async () => {
    const { restore } = installFetch({
      mapping: MAPPING,
      count: () => 3,
      search: () =>
        hitsBody([
          { sku: "A1", status: "active" }, // created_at missing
          { sku: "A2", status: "active", created_at: "2024-01-02" },
          { sku: "A3", status: "churned" }, // created_at missing
        ]),
    });
    try {
      const result = await profileElasticsearchObjects({ url: URL, selectedTables: ["products"] });
      const createdAt = result.profiles[0].columns.find((c) => c.name === "created_at")!;
      expect(createdAt.null_count).toBe(2);
      expect(createdAt.nullable).toBe(true);
    } finally {
      restore();
    }
  });

  test("collapses a pattern and unions member fields into one profile (#3269)", async () => {
    const { restore } = installFetch({
      mapping: {
        "logs-2024.01.01": { mappings: { properties: { ts: { type: "date" } } } },
        "logs-2024.01.02": { mappings: { properties: { level: { type: "keyword" } } } },
      },
      count: () => 42,
      search: () => hitsBody([{ ts: "2024-01-01", level: "info" }]),
    });
    try {
      const result = await profileElasticsearchObjects({ url: URL });
      expect(result.profiles).toHaveLength(1);
      const pattern = result.profiles[0];
      expect(pattern.table_name).toBe("logs-*");
      expect(pattern.columns.map((c) => c.name).sort()).toEqual(["level", "ts"]);
    } finally {
      restore();
    }
  });

  test("honors prefetchedObjects (no re-discovery filter mismatch)", async () => {
    const { restore } = installFetch({
      mapping: MAPPING,
      count: () => 1,
      search: () => hitsBody([{ email: "a@x.com" }]),
    });
    try {
      const result = await profileElasticsearchObjects({
        url: URL,
        prefetchedObjects: [{ name: "customers", type: "table" }],
      });
      expect(result.profiles.map((p) => p.table_name)).toEqual(["customers"]);
    } finally {
      restore();
    }
  });

  test("returns empty profiles + errors for an empty cluster", async () => {
    const { restore } = installFetch({ mapping: {} });
    try {
      const result = await profileElasticsearchObjects({ url: URL });
      expect(result.profiles).toEqual([]);
      expect(result.errors).toEqual([]);
    } finally {
      restore();
    }
  });

  test("reports a requested index that is absent from the mapping", async () => {
    const { restore } = installFetch({ mapping: MAPPING, count: () => 1, search: () => hitsBody([]) });
    try {
      const result = await profileElasticsearchObjects({
        url: URL,
        selectedTables: ["does_not_exist"],
      });
      expect(result.profiles).toEqual([]);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].table).toBe("does_not_exist");
    } finally {
      restore();
    }
  });

  test("records a per-object sample failure without throwing, emitting mapping-only columns", async () => {
    // The `_search` for `products` fails (503); `_count` and the mapping still
    // succeed, so the object is emitted with type/flags but no sample values.
    const { restore } = installFetch({
      mapping: MAPPING,
      count: () => 7,
      failSearchFor: "products",
    });
    try {
      const result = await profileElasticsearchObjects({ url: URL, selectedTables: ["products"] });
      // sampleFields swallows the failure (best-effort), so the object profiles
      // successfully with mapping-only metadata and no recorded error.
      expect(result.profiles).toHaveLength(1);
      const products = result.profiles[0];
      expect(products.row_count).toBe(7);
      const sku = products.columns.find((c) => c.name === "sku")!;
      expect(sku.sample_values).toEqual([]);
      expect(sku.unique_count).toBeNull();
    } finally {
      restore();
    }
  });

  test("surfaces a secret-scrubbed error when the required mapping fetch fails", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = mock(async () =>
      fetchResponse(
        { error: `denied for ApiKey ${API_KEY}` },
        { ok: false, status: 403, statusText: "Forbidden" },
      ),
    ) as unknown as typeof fetch;
    try {
      let message = "";
      try {
        await profileElasticsearchObjects({ url: URL });
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      expect(message).toContain("403");
      expect(message).not.toContain(API_KEY);
    } finally {
      globalThis.fetch = original;
    }
  });
});

// ---------------------------------------------------------------------------
// OpenSearch engine coverage
// ---------------------------------------------------------------------------

describe("profileElasticsearchObjects — OpenSearch engine", () => {
  test("profiles an opensearch:// cluster identically", async () => {
    const { restore } = installFetch({
      mapping: MAPPING,
      count: () => 5,
      search: () => hitsBody([{ email: "a@x.com" }]),
    });
    try {
      const result = await profileElasticsearchObjects({
        url: "opensearch://localhost:9200?ssl=false",
        selectedTables: ["customers"],
      });
      expect(result.profiles.map((p) => p.table_name)).toEqual(["customers"]);
      expect(result.errors).toEqual([]);
    } finally {
      restore();
    }
  });
});
