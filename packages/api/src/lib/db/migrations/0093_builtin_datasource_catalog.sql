-- 0093_builtin_datasource_catalog.sql
--
-- 1.5.3 slice 5 (#2743 / PRD #2738 / ADR-0007) — seed the eight built-in
-- Datasource catalog rows that slice 6 (#2744) needs as install targets.
--
-- These rows are NOT declared in `atlas.config.ts` — per ADR-0007 they
-- ship with Atlas and are seeded as code:
--
--   > The current code-hard-wired `DB_TYPES` array promotes to built-in
--   > `plugin_catalog` rows seeded by a boot-time migration: `postgres`,
--   > `mysql`, `snowflake`, `clickhouse`, `bigquery`, `duckdb`,
--   > `salesforce`, `demo-postgres`. Operators do *not* declare these in
--   > `atlas.config.ts` — they ship with Atlas.
--
-- All eight rows carry `pillar = 'datasource'`,
-- `implementation_status = 'available'`, and the appropriate `install_model`.
-- `demo-postgres` is the only row with `auto_install = true` (auto-seeded
-- into every workspace at creation in slice 6's cutover migration).
--
-- Idempotent via unqualified ON CONFLICT DO NOTHING — re-runs and
-- re-deploys are no-ops at the DB layer. The unqualified form covers
-- both the slug unique index AND the id primary key, so a stray
-- operator-edited row whose id matches one of our canonical seed ids
-- under a different slug doesn't crash startup with a PK violation.
--
-- The companion boot-time seed pass
-- (`packages/api/src/lib/db/seed-builtin-datasource-catalog.ts`,
-- wired via `BuiltinDatasourceCatalogSeedLive` in `effect/layers.ts`)
-- re-asserts the same rows on every boot so a self-host operator who
-- deleted a row gets it back without a redeploy.
--
-- NOT consumed by ConnectionRegistry yet — slice 6 (#2744) pivots
-- ConnectionRegistry to read from `workspace_plugins WHERE
-- pillar = 'datasource'`. The `DatasourcePoolResolver` pure function in
-- `packages/api/src/lib/db/datasource-pool-resolver.ts` translates these
-- rows into the typed PoolConfig shape.
--
-- `config_schema` columns:
--   * postgres / mysql / snowflake — { url (secret), schema?, description? }
--   * clickhouse                   — { url (secret), description? }
--   * bigquery                     — { service_account_json (secret), project_id, description? }
--   * duckdb                       — { path, description? }
--   * salesforce                   — handler-managed (empty JSONB array)
--   * demo-postgres                — operator-managed (empty JSONB array)
--
-- The `secret: true` flag on URL / credential fields drives
-- `plugins/secrets.ts::encryptSecretFields` so per-workspace credentials
-- land encrypted in `workspace_plugins.config` JSONB once slice 6 wires
-- the install handler.

INSERT INTO plugin_catalog
  (id, name, slug, description, type, install_model, pillar,
   implementation_status, auto_install, min_plan, enabled, saas_eligible,
   config_schema, created_at, updated_at)
VALUES
  (
    'catalog:postgres',
    'PostgreSQL',
    'postgres',
    'Connect a PostgreSQL database as an analytics datasource.',
    'datasource',
    'form',
    'datasource',
    'available',
    false,
    'starter',
    true,
    true,
    '[
      {"key": "url", "type": "string", "label": "Connection URL", "required": true, "secret": true, "description": "postgresql://user:pass@host:5432/database"},
      {"key": "schema", "type": "string", "label": "Schema", "description": "Optional. Sets search_path on connection."},
      {"key": "description", "type": "string", "label": "Description", "description": "Optional. Shown in the agent system prompt."}
    ]'::jsonb,
    NOW(),
    NOW()
  ),
  (
    'catalog:mysql',
    'MySQL',
    'mysql',
    'Connect a MySQL database as an analytics datasource.',
    'datasource',
    'form',
    'datasource',
    'available',
    false,
    'starter',
    true,
    true,
    '[
      {"key": "url", "type": "string", "label": "Connection URL", "required": true, "secret": true, "description": "mysql://user:pass@host:3306/database"},
      {"key": "schema", "type": "string", "label": "Schema", "description": "Optional."},
      {"key": "description", "type": "string", "label": "Description", "description": "Optional. Shown in the agent system prompt."}
    ]'::jsonb,
    NOW(),
    NOW()
  ),
  (
    'catalog:snowflake',
    'Snowflake',
    'snowflake',
    'Connect a Snowflake account as an analytics datasource.',
    'datasource',
    'form',
    'datasource',
    'available',
    false,
    'starter',
    true,
    true,
    '[
      {"key": "url", "type": "string", "label": "Connection URL", "required": true, "secret": true, "description": "snowflake://user:pass@account/db/schema?warehouse=WH&role=ROLE"},
      {"key": "schema", "type": "string", "label": "Schema", "description": "Optional."},
      {"key": "description", "type": "string", "label": "Description", "description": "Optional. Shown in the agent system prompt."}
    ]'::jsonb,
    NOW(),
    NOW()
  ),
  (
    'catalog:clickhouse',
    'ClickHouse',
    'clickhouse',
    'Connect a ClickHouse instance as an analytics datasource.',
    'datasource',
    'form',
    'datasource',
    'available',
    false,
    'starter',
    true,
    true,
    '[
      {"key": "url", "type": "string", "label": "Connection URL", "required": true, "secret": true, "description": "clickhouse://user:pass@host:8443/database"},
      {"key": "description", "type": "string", "label": "Description", "description": "Optional. Shown in the agent system prompt."}
    ]'::jsonb,
    NOW(),
    NOW()
  ),
  (
    'catalog:bigquery',
    'BigQuery',
    'bigquery',
    'Connect a Google BigQuery project as an analytics datasource.',
    'datasource',
    'form',
    'datasource',
    'available',
    false,
    'starter',
    true,
    true,
    '[
      {"key": "service_account_json", "type": "string", "label": "Service Account JSON", "required": true, "secret": true, "description": "Paste the full service account key JSON."},
      {"key": "project_id", "type": "string", "label": "GCP Project ID", "required": true},
      {"key": "description", "type": "string", "label": "Description", "description": "Optional. Shown in the agent system prompt."}
    ]'::jsonb,
    NOW(),
    NOW()
  ),
  (
    'catalog:duckdb',
    'DuckDB',
    'duckdb',
    'Connect a DuckDB file as an analytics datasource.',
    'datasource',
    'form',
    'datasource',
    'available',
    false,
    'starter',
    true,
    true,
    '[
      {"key": "path", "type": "string", "label": "Database File Path", "required": true, "description": "Absolute path to the .duckdb file."},
      {"key": "description", "type": "string", "label": "Description", "description": "Optional. Shown in the agent system prompt."}
    ]'::jsonb,
    NOW(),
    NOW()
  ),
  (
    'catalog:salesforce',
    'Salesforce',
    'salesforce',
    'Connect a Salesforce org as an analytics datasource via OAuth.',
    'datasource',
    'oauth',
    'datasource',
    'available',
    false,
    'starter',
    true,
    true,
    '[]'::jsonb,
    NOW(),
    NOW()
  ),
  (
    'catalog:demo-postgres',
    'Demo Dataset',
    'demo-postgres',
    'Atlas-managed demo Postgres dataset, shared across all workspaces.',
    'datasource',
    'form',
    'datasource',
    'available',
    true,
    'starter',
    true,
    true,
    '[]'::jsonb,
    NOW(),
    NOW()
  )
ON CONFLICT DO NOTHING;
