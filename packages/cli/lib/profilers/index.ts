/**
 * Barrel export for all database profilers.
 */

export {
  type ClickHouseClient,
  listClickHouseObjects,
  profileClickHouse,
} from "./clickhouse";

// Snowflake profiling moved onto the plugin profiler contract (ADR-0017, #3622):
// it now lives in `plugins/snowflake/src/profiler.ts`, consumed directly by the
// CLI commands and re-exported from `bin/atlas.ts`. No barrel re-export here.

export { listSalesforceObjects, profileSalesforce } from "./salesforce";

export {
  ingestIntoDuckDB,
  listDuckDBObjects,
  profileDuckDB,
} from "./duckdb";

export {
  type ElasticsearchProfilingResult,
  type ProfileElasticsearchOptions,
  profileElasticsearch,
  elasticsearchConfigFromEnv,
  ELASTICSEARCH_ENV_VARS_HINT,
} from "./elasticsearch";
