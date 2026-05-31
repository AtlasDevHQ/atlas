-- 0110_notion_data_catalog — v0.0.2 slice 6b (#3029)
--
-- Seed the `notion-data` built-in vendor `*-data` Datasource catalog row: a thin,
-- pre-wired wrapper over the same generic OpenAPI primitive `openapi-generic`
-- exposes (migration 0108), identical posture to the Stripe row (migration 0109).
-- The candidate pre-fills the spec URL + auth kind in code
-- (lib/openapi/data-candidates.ts: NOTION_DATA_CANDIDATE), so the admin installs
-- "Notion" by pasting only their integration token — no spec URL.
--
-- Notion is the REQUIRED-STATIC-HEADER proof: it declares a per-vendor
-- `Notion-Version` header via the declarative vendor-quirk hook (slice 6a). That
-- header is DATA on the code-resident candidate, not a column here — this row only
-- carries the install-form schema (the credential), exactly like the Stripe row.
--
-- Per ADR-0007 these are code-seeded — the boot pass re-asserts each row
-- idempotently (lib/openapi/data-candidate-seed.ts, which loops DATA_CANDIDATES);
-- this migration inserts the row on fresh + already-migrated DBs. The migration
-- and the seed share DATA_CANDIDATE_CONFIG_SCHEMA + the DATA_CANDIDATES registry
-- (lib/openapi/data-candidates.ts) as the single source of truth — keep this JSON
-- in lockstep (the `migration 0110 ↔ code alignment` test asserts they match).
--
-- INTENTIONALLY NOT in `BUILTIN_DATASOURCE_CATALOG_SLUGS` (datasource-pool-
-- resolver.ts): a REST datasource has no SQL pool, so the boot loader skips its
-- installs and it resolves through the parallel workspace REST resolver instead —
-- exactly like `openapi-generic` and the Stripe row.
--
-- `auth_value` carries `secret: true` so encryptSecretFields encrypts the
-- integration token in `workspace_plugins.config` at install time. The install
-- form omits `openapi_url` / `auth_kind` entirely (pre-filled from the registry),
-- so a candidate install can never re-point the locked spec URL.
--
-- Idempotent: `ON CONFLICT DO NOTHING` covers both the slug unique index and the
-- `id` primary key, so re-running on a populated catalog is a no-op.

INSERT INTO plugin_catalog
  (id, name, slug, description, type, install_model, pillar,
   implementation_status, auto_install, min_plan, enabled, saas_eligible,
   config_schema, created_at, updated_at)
VALUES
  (
    'catalog:notion-data',
    'Notion',
    'notion-data',
    'Query your Notion workspace (pages, databases, users, comments, …) as a read-only REST datasource. Pre-wired to Notion''s published OpenAPI spec — paste your integration token, no spec URL needed. The agent discovers operations from the spec and queries them directly.',
    'datasource',
    'form',
    'datasource',
    'available',
    false,
    'starter',
    true,
    true,
    '[
      {"key": "auth_value", "type": "string", "label": "API key / token", "required": true, "secret": true, "description": "The API credential for this datasource (e.g. a secret API key or access token). Encrypted at rest."},
      {"key": "base_url_override", "type": "string", "label": "Base URL override", "description": "When the spec''s servers[0].url is wrong (dev/staging/regional host)."},
      {"key": "display_name", "type": "string", "label": "Display name", "description": "Friendly name shown in /admin/connections."}
    ]'::jsonb,
    NOW(),
    NOW()
  )
ON CONFLICT DO NOTHING;
