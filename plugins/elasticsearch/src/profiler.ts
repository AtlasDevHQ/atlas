/**
 * Elasticsearch / OpenSearch profiler — the introspection half of the datasource
 * contract (ADR-0017). Enumerates logical objects ({@link listElasticsearchObjects})
 * and profiles their fields + sample document values ({@link profileElasticsearchObjects})
 * into the SDK's structural {@link PluginProfilingResult} mirror, which the host's
 * registry-resolved profiler seam feeds into `SemanticGenerator` without importing
 * this package.
 *
 * Why a dedicated transform (vs. the SQL `TableProfile` pipeline): Elasticsearch
 * has no rows / PKs / FKs and its query surface is Elasticsearch SQL. A cluster's
 * shape is a typed field tree (`_mapping`), and index PATTERNS (`logs-*`), ALIASES,
 * and DATA STREAMS each collapse their backing indices into ONE logical object
 * (#3269) — the same collapse the CLI's entity-doc path uses, so a wizard-profiled
 * ES layer matches a CLI-profiled one. Each flattened leaf field becomes one
 * {@link PluginColumnProfile}; sample values and a coarse null count are derived
 * from a small read-only `_search` over the logical object.
 *
 * This module also hosts the ES-specific entity-doc path the CLI consumes
 * directly ({@link profileElasticsearch} / {@link elasticsearchConfigFromEnv} /
 * {@link elasticsearchCatalog}) — relocated here from the CLI's `lib/profilers/`
 * so the plugin package is the single home for ES profiling logic, resolved by the
 * registry (API) and imported directly (CLI).
 *
 * Read-only only: every round-trip is `GET /_mapping`, `GET /_alias`,
 * `GET /_data_stream`, `POST /<obj>/_search`, or `POST /<obj>/_count` — no writes.
 * Errors are secret-scrubbed and never echo credentials.
 */

import type {
  PluginColumnProfile,
  PluginDatabaseObject,
  PluginProfileError,
  PluginProfilingResult,
  PluginTableProfile,
  PluginListObjectsOptions,
  PluginProfileOptions,
} from "@useatlas/plugin-sdk";
import {
  createElasticsearchClient,
  resolveElasticsearchConfig,
  scrubElasticsearchError,
  collectConfigSecrets,
} from "./connection";
import type { ElasticsearchClient, ElasticsearchPluginConfig } from "./connection";
import { flattenSource, isPlainObject } from "./dsl";
import {
  collapseMappings,
  parseDataStreams,
  flattenMapping,
  buildUniqueFileSlugs,
  entityFileSlug,
} from "./mapping";
import type {
  EsDimension,
  EsEntityDoc,
  EsMappingResponse,
  FlatEsField,
} from "./mapping";

// Re-exported so callers (e.g. `atlas init`) slug entity filenames identically.
export { entityFileSlug, buildUniqueFileSlugs };

// ---------------------------------------------------------------------------
// ATLAS_ES_* environment contract (CLI)
// ---------------------------------------------------------------------------

/**
 * One-line summary of the `ATLAS_ES_*` environment contract, appended to the
 * actionable errors {@link elasticsearchConfigFromEnv} throws and reused by the
 * init/diff missing-URL hints so the contract is documented in one place.
 */
export const ELASTICSEARCH_ENV_VARS_HINT =
  "Auth (one mode): ATLAS_ES_API_KEY (Base64 API key), " +
  "ATLAS_ES_USERNAME + ATLAS_ES_PASSWORD (HTTP Basic), or " +
  "ATLAS_ES_AWS_REGION (AWS SigV4 — credentials from AWS_ACCESS_KEY_ID / " +
  "AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN; optional ATLAS_ES_AWS_SERVICE, default \"es\"). " +
  "Endpoint: ATLAS_DATASOURCE_URL=elasticsearch://host:9200 (or opensearch://), " +
  "or ATLAS_ES_CLOUD_ID=<name>:<base64>. Optional ATLAS_ES_ENGINE overrides the engine.";

/**
 * Build the plugin-shaped {@link ElasticsearchPluginConfig} for `atlas init` /
 * `atlas diff` from the `ATLAS_ES_*` environment contract (#3309). The CLI
 * mirrors every auth mode + engine the plugin supports — the actual precedence
 * (SigV4 → Basic → API key) and validation live in the plugin's
 * `resolveElasticsearchConfig`, never duplicated here.
 *
 *   - `ATLAS_ES_API_KEY` — Base64 API key
 *   - `ATLAS_ES_USERNAME` / `ATLAS_ES_PASSWORD` — HTTP Basic
 *   - `ATLAS_ES_AWS_REGION` — selects AWS SigV4; access keys come from the
 *     ambient AWS env chain (the CLI runs in the operator's shell, so
 *     `allowAmbientAwsCreds` is set at resolve time — the multi-tenant
 *     "per-tenant creds never read operator env" rule guards DB-stored
 *     configs, not an operator-invoked CLI)
 *   - `ATLAS_ES_AWS_SERVICE` — SigV4 service code (default `es`)
 *   - `ATLAS_ES_CLOUD_ID` — Elastic Cloud ID, the endpoint when there is no URL
 *   - `ATLAS_ES_ENGINE` — explicit engine override (`elasticsearch`|`opensearch`)
 *
 * Throws an actionable, secret-free error when no auth mode (or no endpoint) is
 * configured, so `atlas init` fails with the env contract instead of a generic
 * resolver message. A *partial* signal (lone username, url+cloudId both set) is
 * passed through so the plugin resolver rejects it with its specific message.
 */
export function elasticsearchConfigFromEnv(
  url?: string,
  env: NodeJS.ProcessEnv = process.env,
): ElasticsearchPluginConfig {
  const read = (name: string): string | undefined => {
    const value = env[name];
    const trimmed = typeof value === "string" ? value.trim() : "";
    return trimmed.length > 0 ? trimmed : undefined;
  };
  // The password VALUE is deliberately not trimmed — it is an opaque secret
  // the plugin's resolveAuth treats verbatim (leading/trailing spaces may be
  // real). But a whitespace-ONLY value is misconfiguration, not a secret, so
  // the set/unset check trims like every other env var — otherwise it would
  // count as an auth signal and skip the actionable no-auth error below.
  const password =
    typeof env.ATLAS_ES_PASSWORD === "string" && env.ATLAS_ES_PASSWORD.trim().length > 0
      ? env.ATLAS_ES_PASSWORD
      : undefined;

  const cloudId = read("ATLAS_ES_CLOUD_ID");
  const apiKey = read("ATLAS_ES_API_KEY");
  const username = read("ATLAS_ES_USERNAME");
  const awsRegion = read("ATLAS_ES_AWS_REGION");
  const awsService = read("ATLAS_ES_AWS_SERVICE");
  // Validated downstream by resolveElasticsearchConfig (runtime union check).
  const engine = read("ATLAS_ES_ENGINE") as ElasticsearchPluginConfig["engine"];
  const trimmedUrl = typeof url === "string" && url.trim().length > 0 ? url.trim() : undefined;

  if (!trimmedUrl && !cloudId) {
    throw new Error(
      "No Elasticsearch endpoint configured. Set ATLAS_DATASOURCE_URL to an " +
        "elasticsearch:// or opensearch:// URL, or ATLAS_ES_CLOUD_ID to an Elastic Cloud ID. " +
        ELASTICSEARCH_ENV_VARS_HINT,
    );
  }
  // No auth *signal* at all — a partial pair (lone username/password) falls
  // through so the resolver rejects it with its specific "both required" error.
  if (!apiKey && !username && !password && !awsRegion) {
    throw new Error(
      "No Elasticsearch authentication configured. " + ELASTICSEARCH_ENV_VARS_HINT,
    );
  }

  return {
    ...(trimmedUrl ? { url: trimmedUrl } : {}),
    ...(cloudId ? { cloudId } : {}),
    ...(apiKey ? { apiKey } : {}),
    ...(username ? { username } : {}),
    ...(password ? { password } : {}),
    ...(awsRegion ? { awsRegion } : {}),
    ...(awsService ? { awsService } : {}),
    ...(engine ? { engine } : {}),
  };
}

// ---------------------------------------------------------------------------
// Cluster discovery (shared by the entity-doc + seam-contract paths)
// ---------------------------------------------------------------------------

/** Options governing how a cluster's logical objects are discovered. */
export interface ProfileElasticsearchOptions {
  /** Connection-group scope written onto each entity (ADR-0012). */
  group?: string;
  /** Include dot-prefixed system indices (`.kibana`, `.security`…). Default false. */
  includeSystem?: boolean;
  /** Inject a fetch implementation (tests). Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

/** The collapsed cluster shape both profiling paths consume. */
interface DiscoveredCluster {
  /** Logical entity docs (one per index / pattern / alias / data stream). */
  entities: EsEntityDoc[];
  /** Maps every concrete/backing index name to the `table` of its owning entity. */
  coverage: Map<string, string>;
}

/**
 * Resolve config → client, fetch `_mapping` (required) + `_alias` +
 * `_data_stream` (best-effort) concurrently, and collapse them into logical
 * entity docs (#3269). The caller owns closing the returned client. Shared by the
 * entity-doc {@link profileElasticsearch} and the seam-contract
 * {@link profileElasticsearchObjects} so both collapse identically.
 *
 * @throws {Error} secret-scrubbed connection / mapping-fetch failure.
 */
async function discoverCluster(
  config: ElasticsearchPluginConfig,
  options: ProfileElasticsearchOptions,
  secrets: readonly string[],
): Promise<{ client: ElasticsearchClient; cluster: DiscoveredCluster }> {
  // Ambient AWS creds are allowed: the CLI / static-config path runs in the
  // operator's own shell (same trust model as atlas.config.ts).
  const resolved = resolveElasticsearchConfig(config, { allowAmbientAwsCreds: true });
  const client = createElasticsearchClient(
    resolved,
    options.fetchImpl ? { fetchImpl: options.fetchImpl } : undefined,
  );

  const includeSystem = options.includeSystem ?? false;

  try {
    // Mapping is required; aliases + data streams are best-effort enrichment —
    // a swallowed fetch failure (logged) just yields fewer logical entities, it
    // must not abort the whole profile. The mapping rejection still propagates.
    const mappingP = client.getMapping();
    const aliasesP = client.getAliases().catch((err) => {
      console.warn(
        `  Warning: could not fetch aliases (${err instanceof Error ? err.message : String(err)}) — continuing without alias entities.`,
      );
      return {};
    });
    const dataStreamsP = client.getDataStreams().catch((err) => {
      console.warn(
        `  Warning: could not fetch data streams (${err instanceof Error ? err.message : String(err)}) — continuing without data-stream entities.`,
      );
      return {};
    });

    // Data-stream backing indices are hidden (`.ds-…`) and omitted from the
    // default `_mapping`, so fetch each stream's mapping explicitly. Chain off
    // `dataStreamsP` so the per-stream fetches overlap the (often large) full
    // `_mapping` fetch instead of waiting for the first wave to finish.
    const dataStreamMappingP: Promise<EsMappingResponse> = dataStreamsP.then(async (resp) => {
      const names = [...parseDataStreams(resp, { includeSystem }).keys()];
      if (names.length === 0) return {};
      const dsMaps = await Promise.all(
        names.map((name) =>
          client.getMapping(name).catch((err) => {
            console.warn(
              `  Warning: could not fetch mapping for data stream "${name}" (${err instanceof Error ? err.message : String(err)}).`,
            );
            return {} as EsMappingResponse;
          }),
        ),
      );
      return Object.assign({}, ...dsMaps);
    });

    const [mapping, aliases, dataStreamsResp, dataStreamMapping] = await Promise.all([
      mappingP,
      aliasesP,
      dataStreamsP,
      dataStreamMappingP,
    ]);

    const { entities, coverage } = collapseMappings(
      { mapping, aliases, dataStreams: dataStreamsResp, dataStreamMapping },
      {
        includeSystem,
        ...(options.group ? { group: options.group } : {}),
      },
    );

    return { client, cluster: { entities, coverage } };
  } catch (err) {
    client.close();
    // `getMapping` already scrubs its errors, and `resolveElasticsearchConfig`
    // errors carry no credential — so the caught error is credential-free.
    throw new Error(scrubElasticsearchError(err, secrets), { cause: err });
  }
}

/**
 * Resolve a `--tables` / `selectedTables` filter against discovered entities,
 * matching a requested name by logical entity name OR by a backing/member
 * concrete index that collapsed into one (`logs-2024.01.01` resolves to the
 * `logs-*` entity via `coverage`). Any requested name absent from both is
 * reported in `errors`. Returns the kept entities (order preserved).
 */
function applyEntityFilter(
  cluster: DiscoveredCluster,
  filter: string[] | undefined,
  errors: PluginProfileError[],
): EsEntityDoc[] {
  if (!filter || filter.length === 0) return cluster.entities;

  const tableSet = new Set(cluster.entities.map((e) => e.table));
  const keepTables = new Set<string>();
  for (const idx of filter) {
    if (tableSet.has(idx)) {
      keepTables.add(idx);
    } else {
      const owner = cluster.coverage.get(idx);
      if (owner) {
        keepTables.add(owner);
      } else {
        errors.push({
          table: idx,
          error: "Index not found in the cluster mapping (or has no fields).",
        });
      }
    }
  }
  return cluster.entities.filter((e) => keepTables.has(e.table));
}

// ---------------------------------------------------------------------------
// Entity-doc path (CLI: atlas init / atlas diff)
// ---------------------------------------------------------------------------

export interface ElasticsearchProfilingResult {
  entities: EsEntityDoc[];
  errors: PluginProfileError[];
}

/**
 * Profile an Elasticsearch cluster into entity docs (#3269). Fetches `_mapping`,
 * `_alias`, and `_data_stream` (concurrently) via the thin client, then runs the
 * pure mapping→entity transform so index patterns (`logs-*`), aliases, and data
 * streams each become ONE logical entity and everything else a standalone index.
 * Connection / mapping-fetch failures surface as a secret-scrubbed error.
 *
 * @param config Plugin-shaped connection config — endpoint (`url` or `cloudId`),
 *   auth mode (API key / Basic / SigV4), and engine, resolved by the plugin's
 *   `resolveElasticsearchConfig` (#3309). Usually built by
 *   {@link elasticsearchConfigFromEnv}.
 * @param filterIndices When set, only these entities (by logical name) are
 *   profiled; any requested name absent from the result is reported in `errors`.
 */
export async function profileElasticsearch(
  config: ElasticsearchPluginConfig,
  filterIndices?: string[],
  options?: ProfileElasticsearchOptions,
): Promise<ElasticsearchProfilingResult> {
  const secrets = collectConfigSecrets(config);
  const { client, cluster } = await discoverCluster(config, options ?? {}, secrets);
  try {
    const errors: PluginProfileError[] = [];
    const entities = applyEntityFilter(cluster, filterIndices, errors);
    // One `_mapping` round-trip covers every index, so there is no per-index
    // progress to report — the caller logs the index list from `entities`.
    return { entities, errors };
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
  // Collision-free slugs, computed over the same ordered `entities` array the
  // `atlas init` write loop uses — so the catalog `file:` refs stay in lockstep
  // with what's written (a pattern `logs-*` → `logs-star.yml`; a collision is
  // disambiguated identically on both sides).
  const fileSlugs = buildUniqueFileSlugs(entities.map((e) => e.table));
  return {
    version: "1.0",
    entities: entities.map((e, i) => ({
      name: e.name,
      file: `entities/${fileSlugs[i]}.yml`,
      grain: e.grain,
      description: `${e.table} (Elasticsearch source, ${e.dimensions.length} field${e.dimensions.length === 1 ? "" : "s"})`,
      use_for: [`Search and aggregation over the ${e.table} source`],
      common_questions: [`What documents are in ${e.table}?`],
    })),
  };
}

// ---------------------------------------------------------------------------
// Seam-contract path (ADR-0017): listObjects + profile on `connection`
// ---------------------------------------------------------------------------

/** How many documents to sample per object for value/enum/null inference. */
const SAMPLE_DOC_LIMIT = 100;
/** Distinct-value ceiling below which a string field is treated as enum-like. */
const ENUM_LIKE_MAX_DISTINCT = 20;
/**
 * Sample size above which the cardinality RATIO gate kicks in. Below it, a low
 * absolute distinct count alone signals enum-like — the ratio (`distinct/sampled`)
 * is unreliable on a tiny sample (3 docs with 2 statuses is `0.67`, yet `status`
 * is clearly an enum). Above it the ratio guards against a high-cardinality field
 * that merely happened to show few values in a small window.
 */
const ENUM_LIKE_RATIO_MIN_SAMPLE = 50;
/** Cardinality ratio (distinct / sampled) below which a large-sample field is enum-like. */
const ENUM_LIKE_MAX_RATIO = 0.05;
/** Sample values surfaced per non-enum column. */
const SAMPLE_VALUES_LIMIT = 10;

/**
 * Map an ES semantic dimension back to a column "type" string for the profile.
 * The flattened field carries the original ES type (`es_type`), the most faithful
 * "type" for the agent; fall back to the dimension's semantic type.
 */
function columnTypeForField(dim: EsDimension): string {
  return dim.es_type || dim.type;
}

/** Collected per-field sample evidence from a small `_search`. */
interface FieldSamples {
  /** Distinct stringified non-null values seen, insertion order, capped. */
  values: string[];
  /** Count of sampled docs missing (null/undefined) this field. */
  nullCount: number;
  /** Distinct-value count seen (uncapped) — drives enum-like detection. */
  distinct: number;
  /** Total docs the field was inspected across (the sampled doc count). */
  sampled: number;
}

/** Pull the `_source` objects out of a raw `_search` response (defensive). */
function extractHits(response: unknown): Record<string, unknown>[] {
  if (!isPlainObject(response)) return [];
  const hits = isPlainObject(response.hits) ? response.hits.hits : undefined;
  if (!Array.isArray(hits)) return [];
  const out: Record<string, unknown>[] = [];
  for (const hit of hits) {
    if (isPlainObject(hit) && isPlainObject(hit._source)) {
      out.push(hit._source);
    }
  }
  return out;
}

/**
 * Fetch up to {@link SAMPLE_DOC_LIMIT} documents from a logical object via a
 * read-only `_search` and fold each flattened `_source` into per-field samples.
 * Best-effort: a `_search` failure (object refuses search, mapping-only object)
 * yields no samples rather than failing the object — the column profile still
 * carries type + flags from the mapping. Never throws.
 */
async function sampleFields(
  client: ElasticsearchClient,
  objectName: string,
  fieldPaths: string[],
): Promise<Map<string, FieldSamples>> {
  const out = new Map<string, FieldSamples>();
  for (const path of fieldPaths) {
    out.set(path, { values: [], nullCount: 0, distinct: 0, sampled: 0 });
  }

  let response: unknown;
  try {
    response = await client.dslQuery({
      index: objectName,
      endpoint: "_search",
      // `size` is the doc count; `terminate_after` (via safeguards) bounds work.
      body: { size: SAMPLE_DOC_LIMIT },
      maxSize: SAMPLE_DOC_LIMIT,
    });
  } catch (err) {
    // Non-fatal: a sample-fetch failure leaves the columns with mapping-only
    // metadata. Logged, never silent (CLAUDE.md: no swallowed errors).
    console.warn(
      `  Warning: could not sample documents for "${objectName}" (${err instanceof Error ? err.message : String(err)}) — emitting fields without sample values.`,
    );
    return out;
  }

  const hits = extractHits(response);
  // Track distinct sets separately so `values` can cap while `distinct` counts all.
  const seen = new Map<string, Set<string>>();
  for (const path of fieldPaths) seen.set(path, new Set<string>());

  for (const source of hits) {
    const flat: Record<string, unknown> = {};
    flattenSource(source, "", flat);
    for (const path of fieldPaths) {
      const samples = out.get(path)!;
      samples.sampled += 1;
      const value = flat[path];
      if (value === null || value === undefined) {
        samples.nullCount += 1;
        continue;
      }
      const str = String(value);
      const set = seen.get(path)!;
      if (!set.has(str)) {
        set.add(str);
        samples.distinct += 1;
        if (samples.values.length < SAMPLE_DOC_LIMIT) samples.values.push(str);
      }
    }
  }

  return out;
}

/** Best-effort document count for a logical object via `_count`. Never throws. */
async function countDocs(client: ElasticsearchClient, objectName: string): Promise<number> {
  try {
    const response = await client.dslQuery({ index: objectName, endpoint: "_count", body: {} });
    if (isPlainObject(response) && typeof response.count === "number") {
      return response.count;
    }
  } catch (err) {
    console.warn(
      `  Warning: could not count documents for "${objectName}" (${err instanceof Error ? err.message : String(err)}).`,
    );
  }
  return 0;
}

/**
 * Build the {@link PluginColumnProfile} list for one logical object, folding the
 * sampled evidence into each flattened field. ES has no PKs / FKs (no referential
 * integrity), so those flags are always empty/false.
 */
function columnsForEntity(
  entity: EsEntityDoc,
  samples: Map<string, FieldSamples>,
): PluginColumnProfile[] {
  return entity.dimensions.map((dim): PluginColumnProfile => {
    const s = samples.get(dim.name);
    const distinct = s ? s.distinct : 0;
    const sampled = s ? s.sampled : 0;
    const isString = dim.type === "string";
    // Enum-like: a string field with a small absolute distinct count. On a LARGE
    // sample additionally require a low cardinality ratio; on a small sample the
    // ratio is noisy, so a low distinct count alone suffices (see the constants).
    const isEnumLike =
      isString &&
      sampled > 0 &&
      distinct > 0 &&
      distinct < ENUM_LIKE_MAX_DISTINCT &&
      (sampled < ENUM_LIKE_RATIO_MIN_SAMPLE || distinct / sampled <= ENUM_LIKE_MAX_RATIO);
    // Enum-like keeps every distinct sample (already capped to the doc limit);
    // otherwise surface a short preview.
    const sampleValues = s
      ? isEnumLike
        ? s.values
        : s.values.slice(0, SAMPLE_VALUES_LIMIT)
      : [];
    const notes: string[] = [];
    if (dim.multi_field) notes.push("Multi-field sub-field — exact-match / aggregation variant.");
    if (dim.nested) notes.push("Field within a nested object — has array semantics.");

    return {
      name: dim.name,
      type: columnTypeForField(dim),
      // ES fields are absent-or-present, not NULL/NOT NULL — treat every field
      // as nullable (a document may simply omit it).
      nullable: true,
      unique_count: s && s.sampled > 0 ? distinct : null,
      null_count: s && s.sampled > 0 ? s.nullCount : null,
      sample_values: sampleValues,
      is_primary_key: false,
      is_foreign_key: false,
      fk_target_table: null,
      fk_target_column: null,
      is_enum_like: isEnumLike,
      profiler_notes: notes,
    };
  });
}

/**
 * Enumerate the cluster's queryable LOGICAL objects (#3269): one entry per
 * concrete index, index pattern (`logs-*`), alias, and data stream. The discovery
 * half of the profiler seam (ADR-0017) — the host calls this to populate a
 * "which objects to onboard" picker and to feed {@link profileElasticsearchObjects}.
 *
 * Every object is reported as `type: "table"` — Elasticsearch has no SQL views;
 * the index/alias/data-stream distinction is a query-target detail, not a view.
 * Read-only (`GET /_mapping`, `_alias`, `_data_stream`).
 */
export async function listElasticsearchObjects(
  options: PluginListObjectsOptions,
): Promise<PluginDatabaseObject[]> {
  const config = configFromUrl(options.url);
  const secrets = collectConfigSecrets(config);
  const { client, cluster } = await discoverCluster(config, {}, secrets);
  try {
    return cluster.entities.map((e): PluginDatabaseObject => ({ name: e.table, type: "table" }));
  } finally {
    client.close();
  }
}

/**
 * Profile the cluster's logical objects into a {@link PluginProfilingResult}: one
 * {@link PluginTableProfile} per index / pattern / alias / data stream, its
 * columns derived from the (collapsed, unioned) field mapping and enriched with
 * sample values + a coarse null/distinct count from a small read-only `_search`.
 * The profiling half of the profiler seam (ADR-0017).
 *
 * Per-object discipline mirrors the SQL profilers: a sample/count failure for one
 * object is recorded in `errors` and the object is still emitted with mapping-only
 * column metadata — never thrown. A connection / mapping-fetch failure (the
 * required `_mapping` round-trip) aborts with a secret-scrubbed error.
 *
 * Read-only; never echoes credentials in errors.
 */
export async function profileElasticsearchObjects(
  options: PluginProfileOptions,
): Promise<PluginProfilingResult> {
  const config = configFromUrl(options.url);
  const secrets = collectConfigSecrets(config);
  const { selectedTables, prefetchedObjects, progress } = options;

  const { client, cluster } = await discoverCluster(config, {}, secrets);
  const profiles: PluginTableProfile[] = [];
  const errors: PluginProfileError[] = [];

  try {
    // Honor a prefetched object list (from a prior listObjects) by name; else use
    // the freshly-discovered entities. `selectedTables` further narrows by name.
    let entities = cluster.entities;
    if (prefetchedObjects && prefetchedObjects.length > 0) {
      const wanted = new Set(prefetchedObjects.map((o) => o.name));
      entities = entities.filter((e) => wanted.has(e.table));
    }
    entities = applyEntityFilter({ entities, coverage: cluster.coverage }, selectedTables, errors);

    progress?.onStart(entities.length);

    for (const [i, entity] of entities.entries()) {
      const objectName = entity.table;
      progress?.onTableStart(objectName, i, entities.length);
      try {
        const fieldPaths = entity.dimensions.map((d) => d.name);
        // Count + sample run independently — no waterfall.
        const [rowCount, samples] = await Promise.all([
          countDocs(client, objectName),
          sampleFields(client, objectName, fieldPaths),
        ]);

        profiles.push({
          table_name: objectName,
          object_type: "table",
          row_count: rowCount,
          columns: columnsForEntity(entity, samples),
          primary_key_columns: [],
          foreign_keys: [],
          inferred_foreign_keys: [],
          profiler_notes: [],
          table_flags: { possibly_abandoned: false, possibly_denormalized: false },
        });
        progress?.onTableDone(objectName, i, entities.length);
      } catch (err) {
        // sampleFields / countDocs are best-effort and never throw, so reaching
        // here is an unexpected per-object failure — record it, keep going.
        const msg = scrubElasticsearchError(err, secrets);
        progress?.onTableError(objectName, msg, i, entities.length);
        errors.push({ table: objectName, error: msg });
      }
    }
  } finally {
    client.close();
  }

  return { profiles, errors };
}

// ---------------------------------------------------------------------------
// Options → config adapter
// ---------------------------------------------------------------------------

/**
 * The seam options carry only a `url`. Build the plugin config from it the same
 * way the static-config path does — auth comes from the `ATLAS_ES_*` env contract
 * (the seam is consumed by the CLI / static-config host, which runs in the
 * operator's own shell). A `schema` field is not meaningful for ES (no
 * database/schema namespace) and is ignored.
 */
function configFromUrl(url: string): ElasticsearchPluginConfig {
  return elasticsearchConfigFromEnv(url || undefined);
}

// Re-export the pure flatten helper for callers that want the raw field list.
export { flattenMapping };
export type { FlatEsField };
