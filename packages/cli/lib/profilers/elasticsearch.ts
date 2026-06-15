/**
 * Elasticsearch / OpenSearch profiler — thin re-export from the plugin package.
 *
 * The profiling logic now lives in the `@useatlas/elasticsearch` plugin
 * (`plugins/elasticsearch/src/profiler.ts`) — the single home the host resolves
 * off the registry (API) and the CLI consumes directly (ADR-0017, #3625). This
 * module re-exports the entity-doc path (`profileElasticsearch` /
 * `elasticsearchCatalog` / `elasticsearchConfigFromEnv`) the CLI's `atlas init` /
 * `atlas diff` consume, plus the filename-slug helpers, so existing CLI imports
 * stay stable while the implementation lives in one place.
 *
 * Unlike the SQL profilers (which build `TableProfile`s for the shared
 * `generateEntityYAML` pipeline), Elasticsearch has no rows / PKs / FKs and its
 * query surface is Elasticsearch SQL — so it profiles index `_mapping`s straight
 * into entity docs. Index PATTERNS (`logs-*`), ALIASES, and DATA STREAMS each
 * collapse their backing indices into ONE logical entity (#3269); everything else
 * is a standalone index entity. `atlas init` serializes the docs to
 * `semantic/entities/*.yml`; `atlas diff` compares them against the on-disk layer.
 *
 * The same collapse + field shape now also backs the seam-contract
 * `connection.listObjects` / `connection.profile`, so a wizard-profiled ES layer
 * matches a CLI-profiled one.
 */

export {
  entityFileSlug,
  buildUniqueFileSlugs,
  elasticsearchConfigFromEnv,
  ELASTICSEARCH_ENV_VARS_HINT,
  profileElasticsearch,
  elasticsearchCatalog,
} from "../../../../plugins/elasticsearch/src/profiler";
export type {
  ElasticsearchProfilingResult,
  ProfileElasticsearchOptions,
} from "../../../../plugins/elasticsearch/src/profiler";
