import { describe, test, expect, mock } from "bun:test";
import * as yaml from "js-yaml";

import {
  profileElasticsearch,
  elasticsearchCatalog,
  elasticsearchConfigFromEnv,
} from "../../lib/profilers/elasticsearch";
import { detectDBType } from "../../lib/cli-utils";
import {
  esEntityToSnapshot,
  parseEntityYAML,
  computeDiff,
  type EntitySnapshot,
} from "../../lib/diff";

const URL = "elasticsearch://localhost:9200?ssl=false";
const API_KEY = "dGVzdC1lcy1rZXk=";
/** The plugin-shaped config most tests profile with (API-key auth). */
const CONFIG = { url: URL, apiKey: API_KEY };

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
    const { entities, errors } = await profileElasticsearch(CONFIG, undefined, {
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
      CONFIG,
      ["products", "does_not_exist"],
      { fetchImpl: mappingFetch(MAPPING) },
    );
    expect(entities.map((e) => e.table)).toEqual(["products"]);
    expect(errors).toHaveLength(1);
    expect(errors[0].table).toBe("does_not_exist");
  });

  test("threads the connection-group scope onto each entity", async () => {
    const { entities } = await profileElasticsearch(CONFIG, undefined, {
      group: "warehouse",
      fetchImpl: mappingFetch(MAPPING),
    });
    expect(entities.every((e) => e.group === "warehouse")).toBe(true);
  });

  test("includes system indices only when asked", async () => {
    const { entities } = await profileElasticsearch(CONFIG, undefined, {
      includeSystem: true,
      fetchImpl: mappingFetch(MAPPING),
    });
    expect(entities.map((e) => e.table)).toContain(".kibana");
  });

  test("returns empty (no entities, no errors) for a cluster with no user indices", async () => {
    // A fresh cluster (or one exposing only system/empty indices) — the empty
    // result is the contract the init/diff callers turn into a clear error.
    const onlySystem = await profileElasticsearch(CONFIG, undefined, {
      fetchImpl: mappingFetch({
        ".kibana": { mappings: { properties: { config: { type: "keyword" } } } },
        empty_index: { mappings: { properties: {} } },
      }),
    });
    expect(onlySystem.entities).toEqual([]);
    expect(onlySystem.errors).toEqual([]);

    const emptyMapping = await profileElasticsearch(CONFIG, undefined, {
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
      await profileElasticsearch(CONFIG, undefined, { fetchImpl: failing });
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
    const { entities } = await profileElasticsearch(CONFIG, undefined, {
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
    const { entities } = await profileElasticsearch(CONFIG, undefined, {
      fetchImpl: routingFetch({
        mapping: { orders_v3: { mappings: { properties: { id: { type: "keyword" } } } } },
        aliases: { orders_v3: { aliases: { orders: {} } } },
      }),
    });
    expect(entities.map((e) => e.table)).toEqual(["orders"]);
  });

  test("--tables resolves a collapsed concrete index to its owning pattern entity (#3269)", async () => {
    const fetchImpl = routingFetch({
      mapping: {
        "logs-2024.01.01": { mappings: { properties: { ts: { type: "date" } } } },
        "logs-2024.01.02": { mappings: { properties: { ts: { type: "date" } } } },
        products: { mappings: { properties: { sku: { type: "keyword" } } } },
      },
    });
    // A concrete index that collapsed into `logs-*` is still addressable by name:
    // it resolves to the pattern entity instead of a spurious "not found".
    const byMember = await profileElasticsearch(CONFIG, ["logs-2024.01.01"], {
      fetchImpl,
    });
    expect(byMember.entities.map((e) => e.table)).toEqual(["logs-*"]);
    expect(byMember.errors).toEqual([]);

    // The logical name itself still works too.
    const byName = await profileElasticsearch(CONFIG, ["logs-*"], { fetchImpl });
    expect(byName.entities.map((e) => e.table)).toEqual(["logs-*"]);
    expect(byName.errors).toEqual([]);

    // A genuinely-absent index still reports not-found.
    const missing = await profileElasticsearch(CONFIG, ["nope"], { fetchImpl });
    expect(missing.entities).toEqual([]);
    expect(missing.errors).toHaveLength(1);
    expect(missing.errors[0].table).toBe("nope");
  });

  test("emits a data-stream entity from its backing-index mapping", async () => {
    const { entities } = await profileElasticsearch(CONFIG, undefined, {
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
    const { entities } = await profileElasticsearch(CONFIG, ["products"], {
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
    const { entities } = await profileElasticsearch(CONFIG, undefined, {
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
    const { entities } = await profileElasticsearch(CONFIG, undefined, {
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

    const { entities } = await profileElasticsearch(CONFIG, undefined, {
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
// Auth modes + engines (#3309) — the profiler accepts the same config the
// plugin does: Basic, SigV4, Cloud ID, and opensearch://, via the shared
// resolveElasticsearchConfig (no duplicated precedence).
// ---------------------------------------------------------------------------

/** A mapping fetch that also records each request's URL + headers. */
function capturingFetch(body: unknown): {
  fetchImpl: typeof fetch;
  calls: { url: string; headers: Record<string, string> }[];
} {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetchImpl = mock(async (input: string | URL, init?: RequestInit) => {
    calls.push({
      url: typeof input === "string" ? input : input.toString(),
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    return fetchResponse(body);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe("profileElasticsearch — auth modes + engines (#3309)", () => {
  test("HTTP Basic: profiles and sends a Basic Authorization header", async () => {
    const { fetchImpl, calls } = capturingFetch(MAPPING);
    const { entities } = await profileElasticsearch(
      { url: URL, username: "atlas_reader", password: "s3cret-pw" },
      undefined,
      { fetchImpl },
    );
    expect(entities.map((e) => e.table).sort()).toEqual(["customers", "products"]);
    const auth = calls[0].headers.Authorization;
    expect(auth).toStartWith("Basic ");
    expect(Buffer.from(auth.slice("Basic ".length), "base64").toString("utf8")).toBe(
      "atlas_reader:s3cret-pw",
    );
  });

  test("AWS SigV4: profiles an Amazon OpenSearch domain with signed requests", async () => {
    const { fetchImpl, calls } = capturingFetch(MAPPING);
    const { entities } = await profileElasticsearch(
      {
        url: "opensearch://search-mydomain.us-east-1.es.amazonaws.com",
        awsRegion: "us-east-1",
        awsAccessKeyId: "AKIAEXAMPLE",
        awsSecretAccessKey: "aws-secret-example",
      },
      undefined,
      { fetchImpl },
    );
    expect(entities.length).toBeGreaterThan(0);
    const headers = calls[0].headers;
    expect(headers.Authorization).toStartWith("AWS4-HMAC-SHA256 ");
    expect(headers.Authorization).toContain("us-east-1/es/aws4_request");
    expect(headers["X-Amz-Date"]).toMatch(/^\d{8}T\d{6}Z$/);
    expect(headers["X-Amz-Content-Sha256"]).toBeTruthy();
  });

  test("Elastic Cloud ID: decodes the endpoint and profiles over HTTPS", async () => {
    // domain$es-uuid$kibana-uuid → https://<es-uuid>.<domain>
    const cloudId = `my-deployment:${Buffer.from(
      "es.example.com$abc123$kibana456",
      "utf8",
    ).toString("base64")}`;
    const { fetchImpl, calls } = capturingFetch(MAPPING);
    const { entities } = await profileElasticsearch(
      { cloudId, apiKey: API_KEY },
      undefined,
      { fetchImpl },
    );
    expect(entities.length).toBeGreaterThan(0);
    const target = new globalThis.URL(calls[0].url);
    expect(target.protocol).toBe("https:");
    expect(target.hostname).toBe("abc123.es.example.com");
  });

  test("opensearch:// scheme: profiles an OpenSearch cluster", async () => {
    const { entities } = await profileElasticsearch(
      { url: "opensearch://localhost:9200?ssl=false", apiKey: API_KEY },
      undefined,
      { fetchImpl: mappingFetch(MAPPING) },
    );
    expect(entities.map((e) => e.table).sort()).toEqual(["customers", "products"]);
  });

  test("scrubs every config secret from a failing profile (Basic password)", async () => {
    const password = "super-secret-pw";
    const failing = mock(async () =>
      fetchResponse(
        { error: `auth failed for password ${password}` },
        { ok: false, status: 401, statusText: "Unauthorized" },
      ),
    ) as unknown as typeof fetch;
    let message = "";
    try {
      await profileElasticsearch(
        { url: URL, username: "reader", password },
        undefined,
        { fetchImpl: failing },
      );
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).not.toContain(password);
  });
});

describe("detectDBType — opensearch:// routes to the Elasticsearch profiler", () => {
  test("both engine schemes resolve to the elasticsearch DB type", () => {
    expect(detectDBType("elasticsearch://host:9200")).toBe("elasticsearch");
    expect(detectDBType("opensearch://host:9200")).toBe("elasticsearch");
  });
});

// ---------------------------------------------------------------------------
// elasticsearchConfigFromEnv — the ATLAS_ES_* env contract (#3309)
// ---------------------------------------------------------------------------

describe("elasticsearchConfigFromEnv", () => {
  test("maps the full ATLAS_ES_* contract onto the plugin config shape", () => {
    const config = elasticsearchConfigFromEnv("opensearch://host:9200", {
      ATLAS_ES_API_KEY: " key ",
      ATLAS_ES_USERNAME: "user",
      ATLAS_ES_PASSWORD: "pass with spaces ",
      ATLAS_ES_AWS_REGION: "us-east-1",
      ATLAS_ES_AWS_SERVICE: "aoss",
      ATLAS_ES_ENGINE: "opensearch",
    });
    expect(config).toEqual({
      url: "opensearch://host:9200",
      apiKey: "key",
      username: "user",
      // The password is an opaque secret — never trimmed.
      password: "pass with spaces ",
      awsRegion: "us-east-1",
      awsService: "aoss",
      engine: "opensearch",
    });
  });

  test("uses ATLAS_ES_CLOUD_ID as the endpoint when there is no URL", () => {
    const config = elasticsearchConfigFromEnv(undefined, {
      ATLAS_ES_CLOUD_ID: "deploy:abc",
      ATLAS_ES_API_KEY: "key",
    });
    expect(config).toEqual({ cloudId: "deploy:abc", apiKey: "key" });
  });

  test("a SigV4 region alone is a valid auth signal (keys come from the AWS chain)", () => {
    const config = elasticsearchConfigFromEnv("elasticsearch://host:9200", {
      ATLAS_ES_AWS_REGION: "eu-west-1",
    });
    expect(config).toEqual({ url: "elasticsearch://host:9200", awsRegion: "eu-west-1" });
  });

  test("throws an actionable, secret-free error when no auth mode is configured", () => {
    expect(() => elasticsearchConfigFromEnv(URL, {})).toThrow(
      /No Elasticsearch authentication configured.*ATLAS_ES_API_KEY.*ATLAS_ES_USERNAME.*ATLAS_ES_AWS_REGION/s,
    );
  });

  test("throws when neither a URL nor a Cloud ID names the endpoint", () => {
    expect(() =>
      elasticsearchConfigFromEnv(undefined, { ATLAS_ES_API_KEY: "key" }),
    ).toThrow(/No Elasticsearch endpoint configured.*ATLAS_ES_CLOUD_ID/s);
  });

  test("empty / whitespace-only env values are treated as unset", () => {
    expect(() =>
      elasticsearchConfigFromEnv(URL, {
        ATLAS_ES_API_KEY: "  ",
        ATLAS_ES_USERNAME: "",
        ATLAS_ES_PASSWORD: "   ",
      }),
    ).toThrow(/No Elasticsearch authentication configured/);
  });

  test("a password with interior content keeps its leading/trailing whitespace", () => {
    // Whitespace-ONLY is unset (above), but real surrounding whitespace in an
    // opaque secret must survive verbatim.
    const config = elasticsearchConfigFromEnv(URL, {
      ATLAS_ES_USERNAME: "user",
      ATLAS_ES_PASSWORD: " pw ",
    });
    expect(config.password).toBe(" pw ");
  });

  test("a lone username passes through so the plugin resolver rejects the pair", () => {
    // Not the env layer's call — resolveAuth owns "Basic needs both" with its
    // specific message; the env layer only catches the no-signal-at-all case.
    const config = elasticsearchConfigFromEnv(URL, { ATLAS_ES_USERNAME: "user" });
    expect(config).toEqual({ url: URL, username: "user" });
  });

  test("passes url AND cloudId through so the resolver rejects the ambiguity loudly", async () => {
    const config = elasticsearchConfigFromEnv(URL, {
      ATLAS_ES_CLOUD_ID: "deploy:abc",
      ATLAS_ES_API_KEY: "key",
    });
    expect(config.url).toBe(URL);
    expect(config.cloudId).toBe("deploy:abc");
    await expect(
      profileElasticsearch(config, undefined, { fetchImpl: mappingFetch(MAPPING) }),
    ).rejects.toThrow(/either a url or a cloudId, not both/);
  });
});

// ---------------------------------------------------------------------------
// elasticsearchCatalog
// ---------------------------------------------------------------------------

describe("elasticsearchCatalog", () => {
  test("lists one catalog entry per entity", async () => {
    const { entities } = await profileElasticsearch(CONFIG, undefined, {
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
