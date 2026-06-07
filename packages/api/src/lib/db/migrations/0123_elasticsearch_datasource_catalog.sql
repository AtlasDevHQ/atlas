-- 0123_elasticsearch_datasource_catalog.sql
--
-- v0.0.13 (#3270 / milestone #63) — seed the built-in Elasticsearch /
-- OpenSearch Datasource catalog row so a workspace admin can install it from
-- Admin → Integrations instead of editing `atlas.config.ts`.
--
-- This is the ninth built-in datasource catalog row. The original eight ship in
-- 0093; this row lands separately because 0093 already ran on every existing
-- deploy (migrations are immutable). The companion boot-time seed pass
-- (`packages/api/src/lib/db/seed-builtin-datasource-catalog.ts`) re-asserts ALL
-- nine rows on every boot, so a self-host operator who deleted this row gets it
-- back without a redeploy. Keeping this VALUES block structurally identical to
-- `BUILTIN_DATASOURCE_CATALOG_ROWS`'s `elasticsearch` entry is enforced by the
-- `migration-and-seed-stay-aligned` test in
-- `__tests__/seed-builtin-datasource-catalog.test.ts`.
--
-- `pillar = 'datasource'`, `install_model = 'form'` (config_schema-driven admin
-- install, NOT OAuth), `auto_install = false`. `config_schema` mirrors the
-- plugin's `getConfigSchema()` (plugins/elasticsearch/src/index.ts): `apiKey` is
-- the only `secret: true` field — the `url` carries no credential. The
-- `secret: true` flag drives `plugins/secrets.ts::encryptSecretFields` so the
-- API key lands encrypted in `workspace_plugins.config` JSONB, and the admin
-- mask-on-read / restore-on-save flow (ElasticsearchFormInstallHandler) keys off
-- it. Future auth modes (Basic / CloudID / SigV4, #3263–#3265) extend this list
-- + getConfigSchema in lockstep.
--
-- Idempotent via unqualified ON CONFLICT DO NOTHING — re-runs and re-deploys are
-- no-ops at the DB layer. The unqualified form covers both the slug unique index
-- AND the id primary key (matches 0093).

INSERT INTO plugin_catalog
  (id, name, slug, description, type, install_model, pillar,
   implementation_status, auto_install, min_plan, enabled, saas_eligible,
   config_schema, created_at, updated_at)
VALUES
  (
    'catalog:elasticsearch',
    'Elasticsearch',
    'elasticsearch',
    'Connect an Elasticsearch or OpenSearch cluster as a read-only analytics datasource.',
    'datasource',
    'form',
    'datasource',
    'available',
    false,
    'starter',
    true,
    true,
    '[
      {"key": "url", "type": "string", "label": "Connection URL", "required": true, "description": "elasticsearch://host:9200 — HTTPS by default; append ?ssl=false for a plaintext local cluster."},
      {"key": "apiKey", "type": "string", "label": "API Key", "required": true, "secret": true, "description": "Base64-encoded Elasticsearch API key, sent as `Authorization: ApiKey`. Encrypted at rest."},
      {"key": "description", "type": "string", "label": "Description", "description": "Optional. Shown in the agent system prompt."}
    ]'::jsonb,
    NOW(),
    NOW()
  )
ON CONFLICT DO NOTHING;
