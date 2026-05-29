-- 0108_openapi_generic_catalog — v0.0.2 slice 2 (#2926)
--
-- Seed the built-in `openapi-generic` Datasource catalog row: the generic
-- OpenAPI REST datasource that retires slice-1's `ATLAS_OPENAPI_TWENTY*` env
-- hardcoding. Per ADR-0007 built-in datasource rows are code-seeded — the
-- boot-time `OpenApiDatasourceCatalogSeedLive` re-asserts this row idempotently
-- (`lib/openapi/catalog-seed.ts`); this migration inserts it on fresh + already
-- migrated DBs. The two share `OPENAPI_GENERIC_CONFIG_SCHEMA` (lib/openapi/
-- catalog.ts) as the single source of truth — keep this JSON in lockstep with
-- that array (the `migration 0108 ↔ code alignment` test asserts they match).
--
-- This row is INTENTIONALLY NOT in `BUILTIN_DATASOURCE_CATALOG_SLUGS`
-- (datasource-pool-resolver.ts): a REST datasource has no SQL pool, so the
-- boot loader (`loadSavedConnections`) skips its installs and they resolve
-- through the parallel `OpenApiDatasourceRegistry` instead (PRD §"Option B").
--
-- `auth_value` carries `secret: true` so `plugins/secrets.ts::encryptSecretFields`
-- encrypts the credential in `workspace_plugins.config` at install time.
--
-- Idempotent: `ON CONFLICT DO NOTHING` covers both the slug unique index and
-- the `id` primary key, so re-running on a populated catalog is a no-op.

INSERT INTO plugin_catalog
  (id, name, slug, description, type, install_model, pillar,
   implementation_status, auto_install, min_plan, enabled, saas_eligible,
   config_schema, created_at, updated_at)
VALUES
  (
    'catalog:openapi-generic',
    'OpenAPI (Generic REST)',
    'openapi-generic',
    'Connect any REST API with an OpenAPI 3.x spec as a read-only datasource (e.g. Twenty, Stripe, an internal service). The agent discovers operations from the spec and queries them directly.',
    'datasource',
    'form',
    'datasource',
    'available',
    false,
    'starter',
    true,
    true,
    '[
      {"key": "openapi_url", "type": "string", "label": "OpenAPI spec URL", "required": true, "description": "URL of the OpenAPI 3.x document, e.g. https://crm.example.com/rest/open-api/core"},
      {"key": "auth_kind", "type": "select", "label": "Authentication", "required": true, "options": ["none", "bearer", "basic", "apikey-header", "apikey-query", "oauth2"], "default": "bearer", "description": "How Atlas authenticates to the API. oauth2 is coming soon."},
      {"key": "auth_value", "type": "string", "label": "Token / API key / credential", "secret": true, "description": "Bearer token, API key, or `username:password` for basic auth. Encrypted at rest."},
      {"key": "auth_header_name", "type": "string", "label": "API key header name", "description": "For apikey-header auth, e.g. X-API-Key."},
      {"key": "auth_param_name", "type": "string", "label": "API key query param", "description": "For apikey-query auth, e.g. api_key."},
      {"key": "base_url_override", "type": "string", "label": "Base URL override", "description": "When the spec''s servers[0].url is wrong (dev/staging)."},
      {"key": "write_allowlist", "type": "string", "label": "Write allowlist (JSON)", "description": "JSON array of operationIds permitted to write. Honored in a later release."},
      {"key": "display_name", "type": "string", "label": "Display name", "description": "Friendly name shown in /admin/connections."}
    ]'::jsonb,
    NOW(),
    NOW()
  )
ON CONFLICT DO NOTHING;
