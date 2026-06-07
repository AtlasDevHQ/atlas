import { describe, test, expect, mock } from "bun:test";
import * as yaml from "js-yaml";

import {
  profileElasticsearch,
  elasticsearchCatalog,
} from "../../lib/profilers/elasticsearch";
import {
  esEntityToSnapshot,
  parseEntityYAML,
  computeDiff,
  type EntitySnapshot,
} from "../../lib/diff";

const URL = "elasticsearch://localhost:9200?ssl=false";
const API_KEY = "dGVzdC1lcy1rZXk=";

/** Minimal Response-like object for the mocked fetch (client reads ok/status/json). */
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

/** A fetch that returns a fixed `_mapping` body for any request. */
function mappingFetch(body: unknown): typeof fetch {
  return mock(async () => fetchResponse(body)) as unknown as typeof fetch;
}

const MAPPING = {
  products: {
    mappings: {
      properties: {
        sku: { type: "keyword" },
        title: { type: "text", fields: { keyword: { type: "keyword" } } },
        price: { type: "double" },
        created_at: { type: "date" },
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

// ---------------------------------------------------------------------------
// profileElasticsearch
// ---------------------------------------------------------------------------

describe("profileElasticsearch", () => {
  test("profiles every non-system index into an entity doc", async () => {
    const { entities, errors } = await profileElasticsearch(URL, API_KEY, undefined, {
      fetchImpl: mappingFetch(MAPPING),
    });
    expect(errors).toEqual([]);
    expect(entities.map((e) => e.table).sort()).toEqual(["customers", "products"]);
    const products = entities.find((e) => e.table === "products")!;
    const names = products.dimensions.map((d) => d.name);
    expect(names).toContain("sku");
    expect(names).toContain("title.keyword");
    expect(names).toContain("vendor.rating");
    expect(names).not.toContain("vendor"); // object container is not a field
  });

  test("filters to requested indices and reports missing ones", async () => {
    const { entities, errors } = await profileElasticsearch(
      URL,
      API_KEY,
      ["products", "does_not_exist"],
      { fetchImpl: mappingFetch(MAPPING) },
    );
    expect(entities.map((e) => e.table)).toEqual(["products"]);
    expect(errors).toHaveLength(1);
    expect(errors[0].table).toBe("does_not_exist");
  });

  test("threads the connection-group scope onto each entity", async () => {
    const { entities } = await profileElasticsearch(URL, API_KEY, undefined, {
      group: "warehouse",
      fetchImpl: mappingFetch(MAPPING),
    });
    expect(entities.every((e) => e.group === "warehouse")).toBe(true);
  });

  test("includes system indices only when asked", async () => {
    const { entities } = await profileElasticsearch(URL, API_KEY, undefined, {
      includeSystem: true,
      fetchImpl: mappingFetch(MAPPING),
    });
    expect(entities.map((e) => e.table)).toContain(".kibana");
  });

  test("returns empty (no entities, no errors) for a cluster with no user indices", async () => {
    // A fresh cluster (or one exposing only system/empty indices) — the empty
    // result is the contract the init/diff callers turn into a clear error.
    const onlySystem = await profileElasticsearch(URL, API_KEY, undefined, {
      fetchImpl: mappingFetch({
        ".kibana": { mappings: { properties: { config: { type: "keyword" } } } },
        empty_index: { mappings: { properties: {} } },
      }),
    });
    expect(onlySystem.entities).toEqual([]);
    expect(onlySystem.errors).toEqual([]);

    const emptyMapping = await profileElasticsearch(URL, API_KEY, undefined, {
      fetchImpl: mappingFetch({}),
    });
    expect(emptyMapping.entities).toEqual([]);
    expect(emptyMapping.errors).toEqual([]);
  });

  test("surfaces a secret-scrubbed error when the mapping fetch fails", async () => {
    const failing = mock(async () =>
      fetchResponse(
        { error: `denied for ApiKey ${API_KEY}` },
        { ok: false, status: 403, statusText: "Forbidden" },
      ),
    ) as unknown as typeof fetch;
    let message = "";
    try {
      await profileElasticsearch(URL, API_KEY, undefined, { fetchImpl: failing });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("403");
    expect(message).not.toContain(API_KEY);
  });
});

// ---------------------------------------------------------------------------
// Logical sources: aliases, data streams, index patterns (#3269)
// ---------------------------------------------------------------------------

/**
 * A fetch that routes by URL suffix: `_alias` → aliases body, `_data_stream` →
 * data-stream body, `/<name>/_mapping` → that name's mapping, `/_mapping` → the
 * full mapping. Lets the profiler exercise all three discovery round-trips.
 */
function routingFetch(bodies: {
  mapping: Record<string, unknown>;
  aliases?: Record<string, unknown>;
  dataStreams?: Record<string, unknown>;
  dataStreamMappings?: Record<string, Record<string, unknown>>;
}): typeof fetch {
  return mock(async (input: string | URL) => {
    // `URL` is shadowed by the connection-string constant above — use the global.
    const path = new globalThis.URL(
      typeof input === "string" ? input : input.toString(),
    ).pathname;
    if (path === "/_alias") return fetchResponse(bodies.aliases ?? {});
    if (path === "/_data_stream") return fetchResponse(bodies.dataStreams ?? {});
    // Per-name mapping (`/<name>/_mapping`) — two path segments, unlike the
    // all-indices `/_mapping`.
    const m = path.match(/^\/([^/]+)\/_mapping$/);
    if (m) {
      const name = decodeURIComponent(m[1]);
      return fetchResponse(bodies.dataStreamMappings?.[name] ?? {});
    }
    return fetchResponse(bodies.mapping);
  }) as unknown as typeof fetch;
}

describe("profileElasticsearch — logical sources", () => {
  test("collapses a time-partitioned index family into one pattern entity", async () => {
    const { entities } = await profileElasticsearch(URL, API_KEY, undefined, {
      fetchImpl: routingFetch({
        mapping: {
          "logs-2024.01.01": { mappings: { properties: { ts: { type: "date" } } } },
          "logs-2024.01.02": { mappings: { properties: { level: { type: "keyword" } } } },
          products: { mappings: { properties: { sku: { type: "keyword" } } } },
        },
      }),
    });
    const tables = entities.map((e) => e.table).sort();
    expect(tables).toEqual(["logs-*", "products"]);
    const pattern = entities.find((e) => e.table === "logs-*")!;
    // Fields unioned across both daily indices.
    expect(pattern.dimensions.map((d) => d.name).sort()).toEqual(["level", "ts"]);
  });

  test("emits an alias entity and does not also emit its backing index", async () => {
    const { entities } = await profileElasticsearch(URL, API_KEY, undefined, {
      fetchImpl: routingFetch({
        mapping: { orders_v3: { mappings: { properties: { id: { type: "keyword" } } } } },
        aliases: { orders_v3: { aliases: { orders: {} } } },
      }),
    });
    expect(entities.map((e) => e.table)).toEqual(["orders"]);
  });

  test("emits a data-stream entity from its backing-index mapping", async () => {
    const { entities } = await profileElasticsearch(URL, API_KEY, undefined, {
      fetchImpl: routingFetch({
        mapping: {},
        dataStreams: {
          data_streams: [
            { name: "events", indices: [{ index_name: ".ds-events-000001" }] },
          ],
        },
        dataStreamMappings: {
          events: {
            ".ds-events-000001": { mappings: { properties: { kind: { type: "keyword" } } } },
          },
        },
      }),
    });
    expect(entities.map((e) => e.table)).toEqual(["events"]);
    expect(entities[0].dimensions.map((d) => d.name)).toEqual(["kind"]);
  });
});

// ---------------------------------------------------------------------------
// esEntityToSnapshot + end-to-end diff round-trip
// ---------------------------------------------------------------------------

describe("esEntityToSnapshot", () => {
  test("maps each dimension to a column (name → type), no FKs", async () => {
    const { entities } = await profileElasticsearch(URL, API_KEY, ["products"], {
      fetchImpl: mappingFetch(MAPPING),
    });
    const snap = esEntityToSnapshot(entities[0]);
    expect(snap.table).toBe("products");
    expect(snap.columns.get("sku")).toBe("string");
    expect(snap.columns.get("price")).toBe("number");
    expect(snap.columns.get("created_at")).toBe("timestamp");
    expect(snap.foreignKeys.size).toBe(0);
  });
});

describe("Elasticsearch diff round-trip", () => {
  /** Profile a mapping, serialize each entity to YAML, parse it back — the
   *  on-disk semantic-layer side of `atlas diff`. */
  async function yamlSnapshotsFor(body: unknown): Promise<Map<string, EntitySnapshot>> {
    const { entities } = await profileElasticsearch(URL, API_KEY, undefined, {
      fetchImpl: mappingFetch(body),
    });
    const snapshots = new Map<string, EntitySnapshot>();
    for (const entity of entities) {
      const doc = yaml.load(yaml.dump(entity)) as Record<string, unknown>;
      snapshots.set(entity.table, parseEntityYAML(doc));
    }
    return snapshots;
  }

  test("a freshly-profiled index diffs clean against its own YAML", async () => {
    const yamlSnaps = await yamlSnapshotsFor(MAPPING);
    const { entities } = await profileElasticsearch(URL, API_KEY, undefined, {
      fetchImpl: mappingFetch(MAPPING),
    });
    const dbSnaps = new Map<string, EntitySnapshot>(
      entities.map((e) => [e.table, esEntityToSnapshot(e)]),
    );
    const diff = computeDiff(dbSnaps, yamlSnaps);
    expect(diff.newTables).toEqual([]);
    expect(diff.removedTables).toEqual([]);
    expect(diff.tableDiffs).toEqual([]);
  });

  test("reports added / removed / changed fields when the mapping drifts", async () => {
    // YAML side = original MAPPING; live side = a mutated products mapping.
    const yamlSnaps = await yamlSnapshotsFor(MAPPING);

    const MUTATED = {
      products: {
        mappings: {
          properties: {
            sku: { type: "keyword" },
            title: { type: "text", fields: { keyword: { type: "keyword" } } },
            price: { type: "keyword" }, // double(number) → keyword(string): type change
            brand: { type: "keyword" }, // added
            vendor: { properties: { name: { type: "text" }, rating: { type: "float" } } },
            // created_at removed
          },
        },
      },
      customers: MAPPING.customers,
    };

    const { entities } = await profileElasticsearch(URL, API_KEY, undefined, {
      fetchImpl: mappingFetch(MUTATED),
    });
    const dbSnaps = new Map<string, EntitySnapshot>(
      entities.map((e) => [e.table, esEntityToSnapshot(e)]),
    );

    const diff = computeDiff(dbSnaps, yamlSnaps);
    const products = diff.tableDiffs.find((t) => t.table === "products");
    expect(products).toBeDefined();
    expect(products!.addedColumns.map((c) => c.name)).toContain("brand");
    expect(products!.removedColumns.map((c) => c.name)).toContain("created_at");
    expect(products!.typeChanges.map((c) => c.name)).toContain("price");
  });
});

// ---------------------------------------------------------------------------
// elasticsearchCatalog
// ---------------------------------------------------------------------------

describe("elasticsearchCatalog", () => {
  test("lists one catalog entry per entity", async () => {
    const { entities } = await profileElasticsearch(URL, API_KEY, undefined, {
      fetchImpl: mappingFetch(MAPPING),
    });
    const catalog = elasticsearchCatalog(entities) as {
      version: string;
      entities: { name: string; file: string }[];
    };
    expect(catalog.version).toBe("1.0");
    expect(catalog.entities).toHaveLength(2);
    expect(catalog.entities.map((e) => e.file).sort()).toEqual([
      "entities/customers.yml",
      "entities/products.yml",
    ]);
  });
});
