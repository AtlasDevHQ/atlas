/**
 * Elasticsearch / OpenSearch profiler.
 *
 * Unlike the SQL profilers (which build `TableProfile`s for the shared
 * `generateEntityYAML` pipeline), Elasticsearch has no rows / PKs / FKs and its
 * query surface is Elasticsearch SQL — so it profiles index `_mapping`s
 * straight into entity docs via the plugin's pure `mappingsToLogicalEntities`
 * transform. Index PATTERNS (`logs-*`), ALIASES, and DATA STREAMS each collapse
 * their backing indices into ONE logical entity (#3269); everything else is a
 * standalone index entity. `atlas init` serializes the docs to
 * `semantic/entities/*.yml`; `atlas diff` compares them against the on-disk layer.
 *
 * Credentials are NOT carried in the `elasticsearch://` URL (the URL parser
 * rejects credentials); the caller passes a full plugin-shaped config — auth
 * mode and engine are resolved by the plugin's `resolveElasticsearchConfig`
 * (#3309), typically built from the `ATLAS_ES_*` environment contract via
 * {@link elasticsearchConfigFromEnv}.
 */

import type { ProfileError } from "@atlas/api/lib/profiler";
// Type-only — erased at compile time, so this does NOT pull the plugin's
// connection runtime (sigv4 signer, dsl safeguards) into module load.
import type { ElasticsearchPluginConfig } from "../../../../plugins/elasticsearch/src/connection";
import type {
  EsEntityDoc,
  EsMappingResponse,
} from "../../../../plugins/elasticsearch/src/mapping";
// `mapping.ts` is a pure, dependency-free module, so these value imports are
// cheap (no SDK / fetch / plugin runtime) and safe at module load.
import {
  entityFileSlug,
  buildUniqueFileSlugs,
} from "../../../../plugins/elasticsearch/src/mapping";

// Re-exported so callers (e.g. `atlas init`) slug entity filenames identically.
export { entityFileSlug, buildUniqueFileSlugs };

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
 * Profile an Elasticsearch cluster into entity docs (#3269). Fetches `_mapping`,
 * `_alias`, and `_data_stream` (concurrently) via the thin client, then runs the
 * pure mapping→entity transform so index patterns (`logs-*`), aliases, and data
 * streams each become ONE logical entity and everything else a standalone index.
 * The mapping fetch is required; alias / data-stream fetches are best-effort (a
 * cluster may not expose either) — their failure logs a warning and the profile
 * continues with the entities it can build. Connection / mapping-fetch failures
 * surface as a secret-scrubbed error.
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
  // Independent modules — load concurrently (no async waterfall).
  const [connectionModule, mappingModule] = await Promise.all([
    import("../../../../plugins/elasticsearch/src/connection"),
    import("../../../../plugins/elasticsearch/src/mapping"),
  ]);
  const {
    resolveElasticsearchConfig,
    createElasticsearchClient,
    scrubElasticsearchError,
    collectConfigSecrets,
  } = connectionModule;
  const { collapseMappings, parseDataStreams } = mappingModule;

  // Every secret in the raw config (API key, password, AWS secret/session) —
  // the scrub list for any error this function surfaces.
  const secrets = collectConfigSecrets(config);
  // Ambient AWS creds are allowed: the CLI runs in the operator's own shell
  // (same trust model as the static atlas.config.ts path) — see
  // elasticsearchConfigFromEnv.
  const resolved = resolveElasticsearchConfig(config, { allowAmbientAwsCreds: true });
  const client = createElasticsearchClient(
    resolved,
    options?.fetchImpl ? { fetchImpl: options.fetchImpl } : undefined,
  );

  const includeSystem = options?.includeSystem ?? false;
  const errors: ProfileError[] = [];

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
    // default `_mapping`, so fetch each stream's mapping explicitly. This wave
    // depends only on the data-stream list — chain it off `dataStreamsP` so the
    // per-stream fetches overlap the (often large) full `_mapping` fetch instead
    // of waiting for the first wave to finish.
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

    const { entities: allEntities, coverage } = collapseMappings(
      { mapping, aliases, dataStreams: dataStreamsResp, dataStreamMapping },
      {
        includeSystem,
        ...(options?.group ? { group: options.group } : {}),
      },
    );

    let entities = allEntities;
    if (filterIndices && filterIndices.length > 0) {
      // Match by logical entity name OR by a backing/member concrete index that
      // collapsed into one (`logs-2024.01.01` resolves to the `logs-*` entity via
      // `coverage`), so requesting a now-absorbed concrete index keeps its owning
      // entity instead of reporting it "not found" (#3269).
      const tableSet = new Set(allEntities.map((e) => e.table));
      const keepTables = new Set<string>();
      for (const idx of filterIndices) {
        if (tableSet.has(idx)) {
          keepTables.add(idx);
        } else {
          const owner = coverage.get(idx);
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
      entities = allEntities.filter((e) => keepTables.has(e.table));
    }

    // One `_mapping` round-trip covers every index, so there is no per-index
    // progress to report — the caller logs the index list from `entities`.
    return { entities, errors };
  } catch (err) {
    // `getMapping` already scrubs its errors, and `resolveElasticsearchConfig`
    // errors carry no credential — so the caught error is credential-free and
    // its cause chain is safe to preserve (unlike inside the client, which must
    // drop the cause because the raw fetch error can echo the API key).
    throw new Error(scrubElasticsearchError(err, secrets), { cause: err });
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
