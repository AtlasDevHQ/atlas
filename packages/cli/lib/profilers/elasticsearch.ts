/**
 * Elasticsearch / OpenSearch profiler.
 *
 * Unlike the SQL profilers (which build `TableProfile`s for the shared
 * `generateEntityYAML` pipeline), Elasticsearch has no rows / PKs / FKs and its
 * query surface is Elasticsearch SQL — so it profiles index `_mapping`s
 * straight into entity docs via the plugin's pure `mappingsToEntities`
 * transform. `atlas init` serializes the docs to `semantic/entities/*.yml`;
 * `atlas diff` compares them against the on-disk layer.
 *
 * The API key is NOT carried in the `elasticsearch://` URL (the URL parser
 * rejects credentials); the caller passes it separately (resolved from
 * `ATLAS_ES_API_KEY`).
 */

import type { ProfileError } from "@atlas/api/lib/profiler";
import type { EsEntityDoc } from "../../../../plugins/elasticsearch/src/mapping";

export interface ElasticsearchProfilingResult {
  entities: EsEntityDoc[];
  errors: ProfileError[];
}

export interface ProfileElasticsearchOptions {
  /** Connection-group scope written onto each entity (ADR-0012). */
  group?: string;
  /** Include dot-prefixed system indices (`.kibana`, `.security`…). Default false. */
  includeSystem?: boolean;
  /** Inject a fetch implementation (tests). Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

/**
 * Profile an Elasticsearch cluster into entity docs — one per index. Fetches
 * `_mapping` once (covers every index) via the thin client, then runs the pure
 * mapping→entity transform. Connection / mapping-fetch failures surface as a
 * secret-scrubbed error.
 *
 * @param connectionString `elasticsearch://host[:port][/prefix]` (no credentials).
 * @param apiKey Base64 API key (from `ATLAS_ES_API_KEY`).
 * @param filterIndices When set, only these indices are profiled; any requested
 *   index absent from the cluster mapping is reported in `errors`.
 */
export async function profileElasticsearch(
  connectionString: string,
  apiKey: string,
  filterIndices?: string[],
  options?: ProfileElasticsearchOptions,
): Promise<ElasticsearchProfilingResult> {
  // Independent modules — load concurrently (no async waterfall).
  const [connectionModule, mappingModule] = await Promise.all([
    import("../../../../plugins/elasticsearch/src/connection"),
    import("../../../../plugins/elasticsearch/src/mapping"),
  ]);
  const { resolveElasticsearchConfig, createElasticsearchClient, scrubElasticsearchError } =
    connectionModule;
  const { mappingsToEntities } = mappingModule;

  const resolved = resolveElasticsearchConfig({ url: connectionString, apiKey });
  const client = createElasticsearchClient(
    resolved,
    options?.fetchImpl ? { fetchImpl: options.fetchImpl } : undefined,
  );

  const errors: ProfileError[] = [];

  try {
    const mapping = await client.getMapping();

    let entities = mappingsToEntities(mapping, {
      includeSystem: options?.includeSystem ?? false,
      ...(options?.group ? { group: options.group } : {}),
    });

    if (filterIndices && filterIndices.length > 0) {
      const wanted = new Set(filterIndices);
      entities = entities.filter((e) => wanted.has(e.table));
      const found = new Set(entities.map((e) => e.table));
      for (const idx of filterIndices) {
        if (!found.has(idx)) {
          errors.push({
            table: idx,
            error: "Index not found in the cluster mapping (or has no fields).",
          });
        }
      }
    }

    // One `_mapping` round-trip covers every index, so there is no per-index
    // progress to report — the caller logs the index list from `entities`.
    return { entities, errors };
  } catch (err) {
    // `getMapping` already scrubs its errors, and `resolveElasticsearchConfig`
    // errors carry no credential — so the caught error is credential-free and
    // its cause chain is safe to preserve (unlike inside the client, which must
    // drop the cause because the raw fetch error can echo the API key).
    throw new Error(scrubElasticsearchError(err, apiKey), { cause: err });
  } finally {
    client.close();
  }
}

/**
 * Build a minimal `catalog.yml` object for the profiled indices — the discovery
 * index every `atlas init` writes alongside `entities/`. ES has no metrics /
 * glossary in this slice, so the catalog is an entity listing only.
 */
export function elasticsearchCatalog(
  entities: EsEntityDoc[],
): Record<string, unknown> {
  return {
    version: "1.0",
    entities: entities.map((e) => ({
      name: e.name,
      file: `entities/${e.table}.yml`,
      grain: e.grain,
      description: `${e.table} (Elasticsearch index, ${e.dimensions.length} field${e.dimensions.length === 1 ? "" : "s"})`,
      use_for: [`Search and aggregation over the ${e.table} index`],
      common_questions: [`What documents are in ${e.table}?`],
    })),
  };
}
