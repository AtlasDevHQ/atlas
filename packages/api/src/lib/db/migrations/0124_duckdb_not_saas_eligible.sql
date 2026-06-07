-- 0124_duckdb_not_saas_eligible.sql
--
-- v0.0.13 (#3301 / milestone #63) — flip the built-in DuckDB datasource
-- catalog row to `saas_eligible = false`.
--
-- Migrations 0093 (the original eight built-in datasource rows) and 0123
-- (`elasticsearch`) both seeded every row with `saas_eligible = true`. DuckDB
-- is file-path based and not multi-tenant safe, so it must never appear in the
-- SaaS marketplace (`/api/v1/admin/plugins/marketplace/available`, which gates
-- on `saas_eligible` when `ATLAS_DEPLOY_MODE = saas`). 0093/0123 are immutable,
-- so existing DBs need this data UPDATE; fresh DBs get the right value from the
-- companion boot seed (`seed-builtin-datasource-catalog.ts`,
-- `BUILTIN_DATASOURCE_CATALOG_ROWS`), whose `saasEligible: false` for DuckDB is
-- kept in lockstep by the seed unit tests.
--
-- Self-hosted is unaffected: the marketplace filter ignores `saas_eligible`
-- entirely off SaaS, so DuckDB stays installable there.
--
-- Idempotent: the `IS DISTINCT FROM false` guard makes a re-run a no-op (zero
-- rows matched once DuckDB is already `false`), so `updated_at` isn't churned on
-- redeploys. Touches only the canonical `catalog:duckdb` row by slug, so an
-- operator-renamed row is left alone. Better-Auth-independent — runs on every
-- deploy mode.

UPDATE plugin_catalog
   SET saas_eligible = false,
       updated_at = NOW()
 WHERE slug = 'duckdb'
   AND saas_eligible IS DISTINCT FROM false;
