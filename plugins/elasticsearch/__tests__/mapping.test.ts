import { describe, test, expect } from "bun:test";

import {
  mapEsFieldType,
  flattenMapping,
  indexToEntityName,
  isSystemIndex,
  mappingToEntity,
  mappingsToEntities,
  parseAliases,
  parseDataStreams,
  indexPatternBase,
  detectIndexPatterns,
  buildLogicalEntity,
  mappingsToLogicalEntities,
  entityFileSlug,
} from "../src/mapping";
import type {
  EsMappingResponse,
  EsIndexMapping,
  EsDimensionType,
  EsAliasResponse,
  EsDataStreamResponse,
} from "../src/mapping";

// ---------------------------------------------------------------------------
// mapEsFieldType — ES field type → semantic dimension type
// ---------------------------------------------------------------------------

describe("mapEsFieldType", () => {
  const cases: [string, EsDimensionType][] = [
    ["text", "string"],
    ["keyword", "string"],
    ["ip", "string"],
    ["constant_keyword", "string"],
    ["long", "number"],
    ["integer", "number"],
    ["short", "number"],
    ["byte", "number"],
    ["double", "number"],
    ["float", "number"],
    ["half_float", "number"],
    ["scaled_float", "number"],
    ["unsigned_long", "number"],
    ["boolean", "boolean"],
    ["date", "timestamp"],
    ["date_nanos", "timestamp"],
  ];
  test.each(cases)("maps ES %s → %s", (esType, expected) => {
    expect(mapEsFieldType(esType)).toBe(expected);
  });

  test("falls back to string for unknown / unsupported types", () => {
    expect(mapEsFieldType("geo_point")).toBe("string");
    expect(mapEsFieldType("dense_vector")).toBe("string");
    expect(mapEsFieldType("flattened")).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// flattenMapping — recursive flatten of the properties tree
// ---------------------------------------------------------------------------

describe("flattenMapping", () => {
  test("returns an empty list for absent / empty properties", () => {
    expect(flattenMapping(undefined)).toEqual([]);
    expect(flattenMapping({})).toEqual([]);
  });

  test("flattens scalar fields with mapped + original types", () => {
    const fields = flattenMapping({
      sku: { type: "keyword" },
      price: { type: "double" },
      in_stock: { type: "boolean" },
    });
    const sku = fields.find((f) => f.path === "sku");
    expect(sku).toEqual({
      path: "sku",
      esType: "keyword",
      type: "string",
      multiField: false,
      nested: false,
    });
    expect(fields.find((f) => f.path === "price")?.type).toBe("number");
    expect(fields.find((f) => f.path === "in_stock")?.type).toBe("boolean");
  });

  test("maps date fields to timestamp", () => {
    const fields = flattenMapping({ created_at: { type: "date" } });
    expect(fields).toHaveLength(1);
    expect(fields[0]).toMatchObject({
      path: "created_at",
      esType: "date",
      type: "timestamp",
    });
  });

  test("flattens object sub-fields with dotted paths (no leaf for the container)", () => {
    const fields = flattenMapping({
      user: {
        properties: {
          first_name: { type: "text" },
          age: { type: "integer" },
        },
      },
    });
    expect(fields.map((f) => f.path).sort()).toEqual(["user.age", "user.first_name"]);
    // The object container itself is not emitted as a queryable field.
    expect(fields.find((f) => f.path === "user")).toBeUndefined();
    expect(fields.find((f) => f.path === "user.age")?.type).toBe("number");
  });

  test("marks nested-object descendants with nested: true", () => {
    const fields = flattenMapping({
      comments: {
        type: "nested",
        properties: {
          body: { type: "text" },
          votes: { type: "integer" },
        },
      },
    });
    expect(fields).toHaveLength(2);
    expect(fields.every((f) => f.nested)).toBe(true);
    expect(fields.find((f) => f.path === "comments.votes")?.type).toBe("number");
  });

  test("expands multi-fields, flagging the sub-fields", () => {
    const fields = flattenMapping({
      title: {
        type: "text",
        fields: {
          keyword: { type: "keyword" },
          raw: { type: "keyword" },
        },
      },
    });
    const main = fields.find((f) => f.path === "title");
    expect(main).toMatchObject({ type: "string", multiField: false });
    const kw = fields.find((f) => f.path === "title.keyword");
    expect(kw).toMatchObject({ esType: "keyword", type: "string", multiField: true });
    expect(fields.find((f) => f.path === "title.raw")?.multiField).toBe(true);
  });

  test("handles deeply nested objects and multi-fields together", () => {
    const fields = flattenMapping({
      address: {
        properties: {
          city: {
            type: "text",
            fields: { keyword: { type: "keyword" } },
          },
        },
      },
    });
    expect(fields.map((f) => f.path).sort()).toEqual([
      "address.city",
      "address.city.keyword",
    ]);
    expect(fields.find((f) => f.path === "address.city.keyword")?.multiField).toBe(true);
  });

  test("skips malformed properties with neither a type nor sub-properties", () => {
    const fields = flattenMapping({
      ok: { type: "keyword" },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      broken: {} as any,
    });
    expect(fields.map((f) => f.path)).toEqual(["ok"]);
  });
});

// ---------------------------------------------------------------------------
// indexToEntityName / isSystemIndex
// ---------------------------------------------------------------------------

describe("indexToEntityName", () => {
  test("PascalCases simple and separated index names", () => {
    expect(indexToEntityName("products")).toBe("Products");
    expect(indexToEntityName("web_logs")).toBe("WebLogs");
    expect(indexToEntityName("web-logs")).toBe("WebLogs");
  });

  test("never produces an empty name", () => {
    expect(indexToEntityName("___")).toBe("Index");
  });
});

describe("isSystemIndex", () => {
  test("flags dot-prefixed system indices", () => {
    expect(isSystemIndex(".kibana")).toBe(true);
    expect(isSystemIndex(".security-7")).toBe(true);
  });
  test("does not flag ordinary indices", () => {
    expect(isSystemIndex("products")).toBe(false);
    expect(isSystemIndex("web-logs")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// mappingToEntity — single index mapping → entity doc
// ---------------------------------------------------------------------------

const PRODUCTS_MAPPING: EsIndexMapping = {
  mappings: {
    properties: {
      sku: { type: "keyword" },
      title: { type: "text", fields: { keyword: { type: "keyword" } } },
      price: { type: "scaled_float" },
      created_at: { type: "date" },
      vendor: { properties: { name: { type: "text" }, rating: { type: "float" } } },
    },
  },
};

describe("mappingToEntity", () => {
  test("builds an entity doc in the semantic/entities shape", () => {
    const entity = mappingToEntity("products", PRODUCTS_MAPPING);
    expect(entity).not.toBeNull();
    expect(entity!.name).toBe("Products");
    expect(entity!.type).toBe("fact_table");
    // table: must be the raw index name so the SQL whitelist + FROM resolve.
    expect(entity!.table).toBe("products");
    expect(entity!.grain).toContain("products");
    expect(entity!.description).toContain("products");
  });

  test("emits one dimension per flattened field (scalar, multi-field, object, date)", () => {
    const entity = mappingToEntity("products", PRODUCTS_MAPPING)!;
    const byName = new Map(entity.dimensions.map((d) => [d.name, d]));
    expect(byName.get("sku")).toMatchObject({ sql: "sku", type: "string", es_type: "keyword" });
    expect(byName.get("title")).toMatchObject({ type: "string" });
    expect(byName.get("title.keyword")).toMatchObject({ type: "string", multi_field: true });
    expect(byName.get("price")).toMatchObject({ type: "number", es_type: "scaled_float" });
    expect(byName.get("created_at")).toMatchObject({ type: "timestamp", es_type: "date" });
    expect(byName.get("vendor.name")).toMatchObject({ type: "string" });
    expect(byName.get("vendor.rating")).toMatchObject({ type: "number" });
    // No bare container dimension for the object.
    expect(byName.has("vendor")).toBe(false);
  });

  test("threads the optional group scope onto the entity", () => {
    const entity = mappingToEntity("products", PRODUCTS_MAPPING, { group: "warehouse" })!;
    expect(entity.group).toBe("warehouse");
  });

  test("omits group when none is provided", () => {
    const entity = mappingToEntity("products", PRODUCTS_MAPPING)!;
    expect("group" in entity).toBe(false);
  });

  test("returns null for an index whose mapping has no fields", () => {
    expect(mappingToEntity("empty", { mappings: { properties: {} } })).toBeNull();
    expect(mappingToEntity("empty", {})).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// mappingsToEntities — full _mapping response → entity docs
// ---------------------------------------------------------------------------

describe("mappingsToEntities", () => {
  const RESPONSE: EsMappingResponse = {
    products: PRODUCTS_MAPPING,
    customers: { mappings: { properties: { email: { type: "keyword" } } } },
    ".kibana": { mappings: { properties: { foo: { type: "keyword" } } } },
    empty_index: { mappings: { properties: {} } },
  };

  test("produces one entity per non-system, non-empty index", () => {
    const entities = mappingsToEntities(RESPONSE);
    expect(entities.map((e) => e.table).sort()).toEqual(["customers", "products"]);
  });

  test("includes system indices when includeSystem is set", () => {
    const entities = mappingsToEntities(RESPONSE, { includeSystem: true });
    expect(entities.map((e) => e.table)).toContain(".kibana");
  });

  test("applies the group scope to every emitted entity", () => {
    const entities = mappingsToEntities(RESPONSE, { group: "es" });
    expect(entities.every((e) => e.group === "es")).toBe(true);
  });

  test("tolerates an empty / undefined response", () => {
    expect(mappingsToEntities({})).toEqual([]);
    // @ts-expect-error — exercising the defensive guard
    expect(mappingsToEntities(undefined)).toEqual([]);
  });
});

// ===========================================================================
// Logical sources: aliases, data streams, index patterns (#3269)
// ===========================================================================

describe("parseAliases", () => {
  test("maps each alias to its backing indices", () => {
    const resp: EsAliasResponse = {
      "logs-2024.01.01": { aliases: { logs: {} } },
      "logs-2024.01.02": { aliases: { logs: {} } },
      orders_v3: { aliases: { orders: {}, current: {} } },
    };
    const aliases = parseAliases(resp);
    expect([...aliases.get("logs")!].sort()).toEqual([
      "logs-2024.01.01",
      "logs-2024.01.02",
    ]);
    expect([...aliases.get("orders")!]).toEqual(["orders_v3"]);
    expect(aliases.has("current")).toBe(true);
  });

  test("skips system aliases unless asked, and tolerates non-alias shapes", () => {
    const resp: EsAliasResponse = {
      app: { aliases: { ".kibana_alias": {}, app_alias: {} } },
    };
    expect(parseAliases(resp).has(".kibana_alias")).toBe(false);
    expect(parseAliases(resp, { includeSystem: true }).has(".kibana_alias")).toBe(true);
    // A `_mapping`-shaped body (no `aliases` key) yields nothing, never throws.
    expect(parseAliases({ products: { mappings: {} } } as unknown as EsAliasResponse).size).toBe(0);
    expect(parseAliases(undefined).size).toBe(0);
  });
});

describe("parseDataStreams", () => {
  test("maps each data stream to its backing indices", () => {
    const resp: EsDataStreamResponse = {
      data_streams: [
        {
          name: "logs-app",
          indices: [
            { index_name: ".ds-logs-app-2024.01.01-000001" },
            { index_name: ".ds-logs-app-2024.01.02-000002" },
          ],
        },
      ],
    };
    const streams = parseDataStreams(resp);
    expect([...streams.get("logs-app")!]).toEqual([
      ".ds-logs-app-2024.01.01-000001",
      ".ds-logs-app-2024.01.02-000002",
    ]);
  });

  test("tolerates a non-data-stream shape and skips system streams", () => {
    expect(parseDataStreams(undefined).size).toBe(0);
    expect(parseDataStreams({ products: {} } as unknown as EsDataStreamResponse).size).toBe(0);
    const sys: EsDataStreamResponse = { data_streams: [{ name: ".fleet-actions", indices: [] }] };
    expect(parseDataStreams(sys).has(".fleet-actions")).toBe(false);
    expect(parseDataStreams(sys, { includeSystem: true }).has(".fleet-actions")).toBe(true);
  });
});

describe("indexPatternBase", () => {
  test.each([
    ["logs-2024.01.01", "logs"],
    ["logs-2024-01-01", "logs"],
    ["events-2024", "events"],
    ["metrics-000001", "metrics"],
    ["filebeat-7.10.0-2024.01.01", "filebeat-7.10.0"],
  ])("%s → base %s", (index, base) => {
    expect(indexPatternBase(index)).toBe(base);
  });

  test.each(["orders", "products", "-leading", "trailing-", "logs-prod"])(
    "%s → null (no date/rollover suffix)",
    (index) => {
      expect(indexPatternBase(index)).toBeNull();
    },
  );
});

describe("detectIndexPatterns", () => {
  test("collapses ≥2 indices sharing a base into <base>-*", () => {
    const patterns = detectIndexPatterns([
      "logs-2024.01.01",
      "logs-2024.01.02",
      "metrics-000001",
      "metrics-000002",
      "orders",
    ]);
    expect(patterns.has("logs-*")).toBe(true);
    expect(patterns.has("metrics-*")).toBe(true);
    expect(patterns.has("orders")).toBe(false);
    expect(patterns.get("logs-*")!.sort()).toEqual([
      "logs-2024.01.01",
      "logs-2024.01.02",
    ]);
  });

  test("a lone dated index is NOT collapsed (no surprise wildcard)", () => {
    expect(detectIndexPatterns(["logs-2024.01.01", "orders"]).size).toBe(0);
  });
});

describe("buildLogicalEntity", () => {
  const mapping: EsMappingResponse = {
    "logs-2024.01.01": {
      mappings: { properties: { ts: { type: "date" }, level: { type: "keyword" } } },
    },
    "logs-2024.01.02": {
      mappings: { properties: { ts: { type: "date" }, msg: { type: "text" } } },
    },
  };

  test("unions fields across member indices and keys on the logical name", () => {
    const entity = buildLogicalEntity({
      name: "logs-*",
      kind: "pattern",
      memberIndices: ["logs-2024.01.01", "logs-2024.01.02"],
      response: mapping,
    })!;
    expect(entity.table).toBe("logs-*");
    expect(entity.dimensions.map((d) => d.name).sort()).toEqual(["level", "msg", "ts"]);
    expect(entity.description).toContain("index pattern");
    expect(entity.description).toContain("2 backing indices");
  });

  test("returns null when no member has fields", () => {
    const entity = buildLogicalEntity({
      name: "empty-*",
      kind: "pattern",
      memberIndices: ["missing-a", "missing-b"],
      response: mapping,
    });
    expect(entity).toBeNull();
  });
});

describe("mappingsToLogicalEntities", () => {
  const mapping: EsMappingResponse = {
    "logs-2024.01.01": { mappings: { properties: { ts: { type: "date" } } } },
    "logs-2024.01.02": { mappings: { properties: { ts: { type: "date" } } } },
    orders_v3: { mappings: { properties: { id: { type: "keyword" } } } },
    products: { mappings: { properties: { sku: { type: "keyword" } } } },
    ".kibana": { mappings: { properties: { config: { type: "keyword" } } } },
  };

  test("emits one entity per pattern / alias / data stream, plus standalone indices", () => {
    const aliases: EsAliasResponse = { orders_v3: { aliases: { orders: {} } } };
    const dataStreams: EsDataStreamResponse = {
      data_streams: [{ name: "events", indices: [{ index_name: ".ds-events-000001" }] }],
    };
    const dataStreamMapping: EsMappingResponse = {
      ".ds-events-000001": { mappings: { properties: { kind: { type: "keyword" } } } },
    };

    const entities = mappingsToLogicalEntities({
      mapping,
      aliases,
      dataStreams,
      dataStreamMapping,
    });
    const tables = entities.map((e) => e.table).sort();
    // pattern (logs-*) + alias (orders) + data stream (events) + standalone (products)
    expect(tables).toEqual(["events", "logs-*", "orders", "products"]);
    // The aliased index isn't ALSO emitted standalone, nor are the pattern members.
    expect(tables).not.toContain("orders_v3");
    expect(tables).not.toContain("logs-2024.01.01");
    // System indices stay excluded.
    expect(tables).not.toContain(".kibana");
  });

  test("threads the group scope and falls back to standalone indices", () => {
    const entities = mappingsToLogicalEntities({ mapping }, { group: "warehouse" });
    expect(entities.every((e) => e.group === "warehouse")).toBe(true);
    // No aliases/streams supplied → logs-* pattern + orders_v3 + products standalone.
    expect(entities.map((e) => e.table).sort()).toEqual([
      "logs-*",
      "orders_v3",
      "products",
    ]);
  });
});

describe("entityFileSlug", () => {
  test("passes concrete index names through unchanged", () => {
    expect(entityFileSlug("products")).toBe("products");
    expect(entityFileSlug("logs-2024.01.01")).toBe("logs-2024.01.01");
  });

  test("sanitizes wildcard pattern names into a safe filename", () => {
    expect(entityFileSlug("logs-*")).toBe("logs-star");
    expect(entityFileSlug("log-?")).toBe("log-q");
    expect(entityFileSlug("a b/c")).toBe("a_b_c");
  });
});
