-- 0109_data_candidate_catalog — v0.0.2 slice 6a (#3028)
--
-- Seed the built-in vendor `*-data` Datasource catalog rows: thin, pre-wired
-- wrappers over the same generic OpenAPI primitive `openapi-generic` exposes
-- (migration 0108). A candidate row pre-fills the spec URL + auth kind in code
-- (lib/openapi/data-candidates.ts), so the admin installs e.g. "Stripe" by
-- pasting only their secret key — no spec URL. Stripe is the first candidate;
-- Notion (#3029) and GitHub (#3030) add their own rows.
--
-- Per ADR-0007 these are code-seeded — the boot pass re-asserts each row
-- idempotently (lib/openapi/data-candidate-seed.ts, run from the openapi-generic
-- seed boot wrapper); this migration inserts them on fresh + already-migrated
-- DBs. The two share DATA_CANDIDATE_CONFIG_SCHEMA + the DATA_CANDIDATES registry
-- (lib/openapi/data-candidates.ts) as the single source of truth — keep this JSON
-- in lockstep (the `migration 0109 ↔ code alignment` test asserts they match).
--
-- These rows are INTENTIONALLY NOT in `BUILTIN_DATASOURCE_CATALOG_SLUGS`
-- (datasource-pool-resolver.ts): a REST datasource has no SQL pool, so the boot
-- loader skips its installs and they resolve through the parallel workspace REST
-- resolver instead — exactly like `openapi-generic`.
--
-- `auth_value` carries `secret: true` so encryptSecretFields encrypts the
-- credential in `workspace_plugins.config` at install time. The install form
-- omits `openapi_url` / `auth_kind` entirely (pre-filled from the registry), so a
-- candidate install can never re-point the locked spec URL.
--
-- Idempotent: `ON CONFLICT DO NOTHING` covers both the slug unique index and the
-- `id` primary key, so re-running on a populated catalog is a no-op.

INSERT INTO plugin_catalog
  (id, name, slug, description, type, install_model, pillar,
   implementation_status, auto_install, min_plan, enabled, saas_eligible,
   config_schema, created_at, updated_at)
VALUES
  (
    'catalog:stripe-data',
    'Stripe',
    'stripe-data',
    'Query your Stripe account (customers, charges, invoices, subscriptions, …) as a read-only REST datasource. Pre-wired to Stripe''s published OpenAPI spec — paste your secret key, no spec URL needed. The agent discovers operations from the spec and queries them directly.',
    'datasource',
    'form',
    'datasource',
    'available',
    false,
    'starter',
    true,
    true,
    '[
      {"key": "auth_value", "type": "string", "label": "API key / token", "required": true, "secret": true, "description": "The API credential for this datasource (e.g. your Stripe secret key). Encrypted at rest."},
      {"key": "base_url_override", "type": "string", "label": "Base URL override", "description": "When the spec''s servers[0].url is wrong (dev/staging/regional host)."},
      {"key": "display_name", "type": "string", "label": "Display name", "description": "Friendly name shown in /admin/connections."}
    ]'::jsonb,
    NOW(),
    NOW()
  )
ON CONFLICT DO NOTHING;
