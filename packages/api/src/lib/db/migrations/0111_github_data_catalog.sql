-- 0111_github_data_catalog — v0.0.2 slice 6c (#3030; the OQ5 deliverable)
--
-- Two changes, in order (the CHECK must widen before the INSERT):
--
-- 1. Admit a new `install_model` value `'oauth-datasource'` — the OAuth2
--    dimension of the generic OpenAPI Datasource primitive. It acquires the
--    credential via the same operator-owned OAuth App dance as `'oauth'` but
--    persists DATASOURCE-style: multi-instance (`install_id` composite PK,
--    `pillar='datasource'`), credential inline in `workspace_plugins.config` via
--    selective-field encryption, probe-on-install caching the `openapi_snapshot`.
--    See `lib/integrations/install/oauth-datasource-handler.ts` +
--    `@useatlas/types` CATALOG_INSTALL_MODELS (the canonical enum) + the
--    `chk_plugin_catalog_install_model` mirror in `schema.ts`. Postgres requires
--    DROP + ADD to widen a CHECK enum.
--
-- 2. Seed the `github-data` catalog row — a thin data-candidate wrapper over the
--    generic primitive (OQ6: GitHub's only non-generic data dimension,
--    Link-header pagination, is ALREADY a generic strategy). Pre-wired to
--    GitHub's published OpenAPI spec in code (lib/openapi/data-candidates.ts), so
--    the admin installs by connecting their GitHub App — no spec URL, no token to
--    paste. The credential (installation_id) is acquired by the OAuth dance and
--    its bearer token minted on demand from the App JWT.
--
-- Per ADR-0007 this row is code-seeded — the boot pass re-asserts it idempotently
-- (lib/openapi/data-candidate-seed.ts); this migration inserts it on fresh +
-- already-migrated DBs. The two share the DATA_CANDIDATES registry as the single
-- source of truth — the `migration 0111 ↔ code alignment` test asserts they match.
--
-- `config_schema` is INTENTIONALLY EMPTY (`[]`): an oauth-datasource install has
-- no admin credential form — the credential comes from the OAuth dance. The
-- installation_id's encryption is driven by a code-resident schema
-- (GITHUB_APP_SECRET_FIELDS_SCHEMA, `installation_id` secret), not this form.
--
-- Idempotent: `ON CONFLICT DO NOTHING` covers both the slug unique index and the
-- `id` primary key, so re-running on a populated catalog is a no-op.

ALTER TABLE plugin_catalog
  DROP CONSTRAINT IF EXISTS chk_plugin_catalog_install_model;
ALTER TABLE plugin_catalog
  ADD CONSTRAINT chk_plugin_catalog_install_model
  CHECK (install_model IN ('oauth', 'form', 'static-bot', 'oauth-datasource'));

INSERT INTO plugin_catalog
  (id, name, slug, description, type, install_model, pillar,
   implementation_status, auto_install, min_plan, enabled, saas_eligible,
   config_schema, created_at, updated_at)
VALUES
  (
    'catalog:github-data',
    'GitHub',
    'github-data',
    'Query your GitHub organization (repositories, pull requests, issues, …) as a read-only REST datasource. Connects through your GitHub App installation — no token to paste. The agent discovers operations from GitHub''s published OpenAPI spec and queries them directly, following Link-header pagination.',
    'datasource',
    'oauth-datasource',
    'datasource',
    'available',
    false,
    'starter',
    true,
    true,
    '[]'::jsonb,
    NOW(),
    NOW()
  )
ON CONFLICT DO NOTHING;
